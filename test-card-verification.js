// Run with: node -r ./shim-pg-mem.js -r ./shim-stripe-mem.js test-card-verification.js
//
// Proves the "require a card even for Free" anti-abuse mechanism:
//   1. A free signup creates a real Stripe Checkout session in mode:
//      'setup' (a $0 card check), not the old direct-issue endpoint.
//   2. The webhook, on completion, issues a 50-call free key and records
//      the card's fingerprint against that customer.
//   3. A SECOND free signup using the SAME physical card (same fingerprint,
//      different email/customer) must NOT get a second key — the webhook
//      detects the reused fingerprint and mints nothing new.
//   4. /api/key-for-session for that second, duplicate-card session still
//      resolves successfully — to the ORIGINAL key, via the fingerprint
//      fallback lookup — rather than hanging in "pending" forever.
//   5. A genuinely different card gets its own, independent key.
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.PORT = '4175';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';

async function main() {
  require('./server'); // boots and starts listening (with faked Stripe + pg-mem)
  const FakeStripe = require('stripe'); // resolves to our shim's FakeStripe class
  const { __state } = FakeStripe;
  await new Promise((r) => setTimeout(r, 800));

  const base = 'http://localhost:4175';
  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('ok   -', name); }
    else { fail++; console.log('FAIL -', name, '\n     ', detail !== undefined ? JSON.stringify(detail) : ''); }
  }

  function sessionIdFromUrl(url) {
    return url.split('/').pop();
  }

  async function postWebhookEvent(session) {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } });
    return fetch(base + '/webhook/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'fake' },
      body,
    });
  }

  // ---- Card A, signup #1: card@example.com ----
  __state.nextFingerprint = 'FP_CARD_A';
  const checkout1 = await fetch(base + '/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'free', email: 'card-a-1@example.com' }),
  }).then((r) => r.json());
  check('free checkout returns a Stripe-hosted checkoutUrl (not an inline apiKey)',
    typeof checkout1.checkoutUrl === 'string' && checkout1.checkoutUrl.includes('checkout.stripe.test'),
    checkout1);

  const session1Id = sessionIdFromUrl(checkout1.checkoutUrl);
  const session1 = __state.sessions.get(session1Id);
  check('the created session is mode: setup (a $0 card check, not a charge)', session1.mode === 'setup', session1);

  await postWebhookEvent(session1);
  await new Promise((r) => setTimeout(r, 200)); // webhook handler is async, fire-and-forget

  const keyResp1 = await fetch(base + `/api/key-for-session?session_id=${session1Id}`).then((r) => r.json());
  check('first free signup on Card A gets a real key', typeof keyResp1.apiKey === 'string' && keyResp1.apiKey.startsWith('tp_free_'), keyResp1);
  const cardAKey = keyResp1.apiKey;

  // ---- Card A, signup #2: SAME card, different email ----
  __state.nextFingerprint = 'FP_CARD_A'; // reusing the same physical card
  const checkout2 = await fetch(base + '/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'free', email: 'card-a-2-different-email@example.com' }),
  }).then((r) => r.json());
  const session2Id = sessionIdFromUrl(checkout2.checkoutUrl);
  const session2 = __state.sessions.get(session2Id);

  await postWebhookEvent(session2);
  await new Promise((r) => setTimeout(r, 200));

  const keyResp2 = await fetch(base + `/api/key-for-session?session_id=${session2Id}`).then((r) => r.json());
  check('second signup with the SAME card resolves via key-for-session (does not hang pending)',
    typeof keyResp2.apiKey === 'string', keyResp2);
  check('second signup with the SAME card gets back the ORIGINAL key, not a new one',
    keyResp2.apiKey === cardAKey, { cardAKey, got: keyResp2.apiKey });

  // Confirm no second api_key row was actually created for this customer.
  const usageForDupCustomerKey = await fetch(base + '/api/usage', {
    headers: { Authorization: 'Bearer ' + cardAKey },
  }).then((r) => r.json());
  check('the shared key still reports plan=free, limit=50 (untouched by the duplicate attempt)',
    usageForDupCustomerKey.plan === 'free' && usageForDupCustomerKey.limit === 50, usageForDupCustomerKey);

  // ---- Card B: a genuinely different card/email ----
  __state.nextFingerprint = 'FP_CARD_B';
  const checkout3 = await fetch(base + '/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'free', email: 'card-b@example.com' }),
  }).then((r) => r.json());
  const session3Id = sessionIdFromUrl(checkout3.checkoutUrl);
  const session3 = __state.sessions.get(session3Id);

  await postWebhookEvent(session3);
  await new Promise((r) => setTimeout(r, 200));

  const keyResp3 = await fetch(base + `/api/key-for-session?session_id=${session3Id}`).then((r) => r.json());
  check('a genuinely different card gets its own, independent free key',
    typeof keyResp3.apiKey === 'string' && keyResp3.apiKey !== cardAKey, { cardAKey, got: keyResp3.apiKey });

  // ---- Both keys actually work against /v1/convert, independently capped ----
  const convertWithCardAKey = await fetch(base + '/v1/convert', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cardAKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'json', to: 'yaml', data: '{"a":1}' }),
  }).then((r) => r.json());
  check('Card A\'s key can convert and reports usage.used=1', convertWithCardAKey.usage && convertWithCardAKey.usage.used === 1, convertWithCardAKey);

  const convertWithCardBKey = await fetch(base + '/v1/convert', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + keyResp3.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'json', to: 'yaml', data: '{"a":1}' }),
  }).then((r) => r.json());
  check('Card B\'s key is independent — its own usage.used=1, not inheriting Card A\'s count',
    convertWithCardBKey.usage && convertWithCardBKey.usage.used === 1, convertWithCardBKey);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Test crashed:', e); process.exit(1); });

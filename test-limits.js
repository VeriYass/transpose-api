// Run with: node -r ./shim-pg-mem.js -r ./shim-stripe-mem.js test-limits.js
//
// Full server boot + real HTTP calls (not unit tests) proving:
//   1. Free tier is a flat 50-call lifetime cap, not 50/month.
//   2. Re-verifying the SAME card returns the SAME key, not a fresh one —
//      otherwise the lifetime cap is trivially bypassable (this used to be
//      email-based dedup; it's now card-fingerprint-based — see
//      test-card-verification.js for the dedicated dedup test, and
//      test-limits.js here for the cap/usage-accounting behavior on top
//      of a signup that's already gone through checkout+webhook).
//   3. The usage number returned after each conversion is the real running
//      total (the bug this session found: it used to show today's per-day
//      count instead).
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.PORT = '4174';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';

async function main() {
  require('./server'); // boots and starts listening
  const FakeStripe = require('stripe');
  const { __state } = FakeStripe;
  await new Promise((r) => setTimeout(r, 800));

  const base = 'http://localhost:4174';
  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('ok   -', name); }
    else { fail++; console.log('FAIL -', name, '\n     ', detail !== undefined ? JSON.stringify(detail) : ''); }
  }

  function sessionIdFromUrl(url) { return url.split('/').pop(); }

  async function signupFree(email, fingerprint) {
    __state.nextFingerprint = fingerprint;
    const checkout = await fetch(base + '/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'free', email }),
    }).then((r) => r.json());
    const sessionId = sessionIdFromUrl(checkout.checkoutUrl);
    const session = __state.sessions.get(sessionId);
    await fetch(base + '/webhook/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'fake' },
      body: JSON.stringify({ type: 'checkout.session.completed', data: { object: session } }),
    });
    await new Promise((r) => setTimeout(r, 150));
    return fetch(base + `/api/key-for-session?session_id=${sessionId}`).then((r) => r.json());
  }

  // ---- First card-verified free signup ----
  const signup1 = await signupFree('dup-test@example.com', 'FP_LIMITS_TEST');
  check('first signup issues a key', typeof signup1.apiKey === 'string' && signup1.apiKey.startsWith('tp_free_'), signup1);

  // ---- Re-verifying the SAME card (different email) returns the SAME key ----
  const signup2 = await signupFree('different-email-same-card@example.com', 'FP_LIMITS_TEST');
  check('re-verifying the SAME card returns the SAME key (no fresh allowance)',
    signup2.apiKey === signup1.apiKey, signup2);

  // ---- A genuinely different card gets a different key ----
  const signup3 = await signupFree('different-card@example.com', 'FP_LIMITS_TEST_OTHER');
  check('a genuinely different card gets a different key', signup3.apiKey && signup3.apiKey !== signup1.apiKey, signup3);

  // ---- 50-call lifetime cap, enforced correctly, with correct running totals ----
  const key = signup1.apiKey;
  let lastUsed = 0;
  let allCorrect = true;
  for (let i = 1; i <= 50; i++) {
    const res = await fetch(base + '/v1/convert', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'json', to: 'yaml', data: '{"a":1}' }),
    });
    const data = await res.json();
    if (!res.ok || data.usage.used !== i) {
      allCorrect = false;
      console.log(`     call #${i} expected usage.used=${i}, got`, res.status, data);
      break;
    }
    lastUsed = data.usage.used;
  }
  check('all 50 free calls succeed, with usage.used incrementing correctly each time (1,2,...,50)',
    allCorrect && lastUsed === 50, { lastUsed });

  // ---- 51st call must be rejected ----
  const res51 = await fetch(base + '/v1/convert', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'json', to: 'yaml', data: '{"a":1}' }),
  });
  const data51 = await res51.json();
  check('51st call is rejected with 429 and mentions the free cap (not "this month")',
    res51.status === 429 && data51.error === 'limit_reached' && /50 free calls/.test(data51.message),
    { status: res51.status, body: data51 });

  // ---- /api/usage confirms the cap is hit ----
  const usage = await fetch(base + '/api/usage', { headers: { Authorization: 'Bearer ' + key } }).then((r) => r.json());
  check('/api/usage shows used=50, limit=50, plan=free', usage.used === 50 && usage.limit === 50 && usage.plan === 'free', usage);

  // ---- re-verifying the same (now-capped) card still returns the same, still-capped key ----
  const signup4 = await signupFree('dup-test@example.com', 'FP_LIMITS_TEST');
  check('re-verifying after hitting the cap still returns the same (still-capped) key, not a fresh one',
    signup4.apiKey === key, signup4);
  const usageAfterResignup = await fetch(base + '/api/usage', { headers: { Authorization: 'Bearer ' + key } }).then((r) => r.json());
  check('re-verifying does NOT reset usage back to 0', usageAfterResignup.used === 50, usageAfterResignup);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Test crashed:', e); process.exit(1); });

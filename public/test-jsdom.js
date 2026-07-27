const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const errors = [];

function waitFor(cond, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

// In-memory fake backend standing in for the real /api/* and /v1/convert
// endpoints, so the page's fetch() calls can be exercised without a real
// server. Mirrors the actual server.js contract (see test-limits.js for the
// real server-level version of these same rules: 50-call lifetime cap,
// duplicate-signup returns the same key, etc).
function makeFakeBackend() {
  const keys = new Map(); // apiKey -> { plan, used, limit }
  const emailToKey = new Map();
  const checkoutCalls = []; // records every /api/checkout body, for assertions
  let nextId = 1;

  const fakeFetch = async function fakeFetch(url, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const authHeader = (opts.headers && (opts.headers['Authorization'] || opts.headers['authorization'])) || '';
    const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Signup now goes through Stripe Checkout (mode: 'setup', a $0 card
    // check) instead of the old direct-issue /api/signup-free endpoint —
    // this fake mirrors that contract: /api/checkout hands back a
    // checkoutUrl, and the real key only exists after the (webhook-driven)
    // /api/key-for-session lookup succeeds. Since these tests don't exercise
    // the actual Stripe redirect, they assert on the /api/checkout call
    // itself rather than an inline unlock.
    if (url.endsWith('/api/checkout') && method === 'POST') {
      checkoutCalls.push(body);
      const email = body.email;
      let apiKey;
      if (emailToKey.has(email)) {
        apiKey = emailToKey.get(email);
      } else {
        apiKey = 'tp_free_test_' + nextId++;
        keys.set(apiKey, { plan: 'free', used: 0, limit: 50 });
        emailToKey.set(email, apiKey);
      }
      const sessionId = 'cs_test_' + nextId++;
      fakeFetch.__sessions = fakeFetch.__sessions || new Map();
      fakeFetch.__sessions.set(sessionId, apiKey);
      return jsonResponse(200, { checkoutUrl: 'https://checkout.stripe.test/' + sessionId });
    }

    if (url.includes('/api/key-for-session') && method === 'GET') {
      const sessionId = new URL(url, 'https://x').searchParams.get('session_id');
      const apiKey = fakeFetch.__sessions && fakeFetch.__sessions.get(sessionId);
      if (!apiKey) return jsonResponse(202, { status: 'pending' });
      return jsonResponse(200, { apiKey });
    }

    if (url.endsWith('/api/usage') && method === 'GET') {
      const rec = keys.get(key);
      if (!rec) return jsonResponse(401, { error: 'invalid_api_key', message: 'This key is invalid or has been revoked.' });
      return jsonResponse(200, { plan: rec.plan, used: rec.used, limit: rec.limit });
    }

    if (url.endsWith('/v1/convert') && method === 'POST') {
      const rec = keys.get(key);
      if (!rec) return jsonResponse(401, { error: 'invalid_api_key', message: 'This key is invalid or has been revoked.' });
      if (rec.used >= rec.limit) {
        return jsonResponse(429, { error: 'limit_reached', message: `You've used all ${rec.limit} free calls on the Free plan. Upgrade to keep converting.` });
      }
      rec.used += 1;
      // Real conversion result content doesn't matter for these tests —
      // convert.js correctness is already covered by test-convert.js.
      return jsonResponse(200, { result: 'FAKE_RESULT_' + rec.used, usage: { used: rec.used, limit: rec.limit, plan: rec.plan } });
    }

    return jsonResponse(404, { error: 'not_found' });
  };

  fakeFetch.__checkoutCalls = checkoutCalls;
  return fakeFetch;

  function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }
}

async function main() {
  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('ok   -', name); }
    else { fail++; console.log('FAIL -', name, '\n     ', detail || ''); }
  }

  function newDom() {
    return new JSDOM(html, {
      url: 'https://transpose-api-production.up.railway.app/',
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: (() => {
        const vc = new VirtualConsole();
        vc.on('jsdomError', (e) => {
          // Navigation isn't implemented in jsdom — expected here since the
          // signup flow now does a real window.location.href redirect to
          // Stripe Checkout, which these tests deliberately don't follow.
          if (!/Could not load (script|link)/.test(e.message) && !/Not implemented: navigation/.test(e.message)) {
            errors.push('jsdomError: ' + e.message);
          }
        });
        return vc;
      })(),
    });
  }

  // ============================================================
  // Scenario 1: fresh visitor, no stored key — gate must block.
  // ============================================================
  {
    const dom = newDom();
    const { window } = dom;
    window.fetch = makeFakeBackend();
    await new Promise((r) => setTimeout(r, 300)); // let initGate() run

    const doc = window.document;
    check('Gate: shown by default for a fresh visitor (no stored key)',
      doc.getElementById('gateOverlay').style.display === 'flex',
      doc.getElementById('gateOverlay').style.display);

    check('Gate: close button hidden while not yet unlocked',
      doc.getElementById('gateCloseBtn').style.display === 'none');

    check('Pricing: Build/Scale call-count numbers hidden before signup',
      Array.from(doc.querySelectorAll('.tier-limit')).every((el) => el.style.display !== 'inline'));
  }

  // ============================================================
  // Scenario 2: clicking signup on the gate now redirects to Stripe
  // (mode: 'setup', a $0 card check) instead of unlocking inline — a free
  // key doesn't exist until Stripe verifies a card and the webhook fires.
  // ============================================================
  {
    const dom = newDom();
    const { window } = dom;
    const fake = makeFakeBackend();
    window.fetch = fake;
    await new Promise((r) => setTimeout(r, 300));
    const doc = window.document;

    doc.getElementById('gateEmailInput').value = 'test@example.com';
    doc.getElementById('gateSignupBtn').dispatchEvent(new window.Event('click'));
    await waitFor(() => fake.__checkoutCalls.length > 0);

    check('Signup: calls /api/checkout with plan=free and the entered email (not the old inline /api/signup-free)',
      fake.__checkoutCalls[0].plan === 'free' && fake.__checkoutCalls[0].email === 'test@example.com',
      fake.__checkoutCalls[0]);
    check('Gate: does NOT unlock inline — a real key only exists once Stripe verifies the card',
      doc.getElementById('gateOverlay').style.display === 'flex');
  }

  // ============================================================
  // Scenario 2b: after the Stripe redirect + card verification completes
  // (simulated here the way success.html actually does it: checkout,
  // then key-for-session, storing the key before returning to /), a fresh
  // load with that key in localStorage unlocks fully — tier limits
  // revealed, meter shows real usage, and conversion actually hits the API.
  // ============================================================
  {
    const dom = newDom();
    const { window } = dom;
    const fake = makeFakeBackend();
    window.fetch = fake;

    const checkoutResp = await fake('https://x/api/checkout', {
      method: 'POST', body: JSON.stringify({ plan: 'free', email: 'verified@example.com' }),
    }).then((r) => r.json());
    const sessionId = checkoutResp.checkoutUrl.split('/').pop();
    const keyResp = await fake('https://x/api/key-for-session?session_id=' + sessionId, { method: 'GET' })
      .then((r) => r.json());
    window.localStorage.setItem('transposeApiKey', keyResp.apiKey);

    window.eval('initGate()');
    await new Promise((r) => setTimeout(r, 300));
    const doc = window.document;

    check('Gate: hides once a verified key is already in localStorage', doc.getElementById('gateOverlay').style.display === 'none');
    check('Pricing: Build/Scale numbers revealed once unlocked',
      Array.from(doc.querySelectorAll('.tier-limit')).every((el) => el.style.display === 'inline'));
    check('Meter: shows real usage (0 used, limit 50, free tier wording)',
      doc.getElementById('meter').innerHTML.includes('0') &&
      doc.getElementById('meter').innerHTML.includes('50') &&
      doc.getElementById('meter').innerHTML.includes('no reset'),
      doc.getElementById('meter').innerHTML);

    // Now actually convert — must hit the fake /v1/convert, not do anything client-side.
    doc.getElementById('fromFormat').value = 'json';
    doc.getElementById('toFormat').value = 'yaml';
    doc.getElementById('inputArea').value = '{"a":1}';
    doc.getElementById('outStatus').textContent = '';
    doc.getElementById('convertBtn').dispatchEvent(new window.Event('click'));
    await waitFor(() => doc.getElementById('outStatus').textContent === 'valid' || doc.getElementById('outStatus').textContent === 'error');
    check('Convert: result comes from the (fake) API response, not client-side parsing',
      doc.getElementById('outputArea').textContent === 'FAKE_RESULT_1',
      doc.getElementById('outputArea').textContent);
    check('Meter: updates from the real usage returned by the convert response',
      doc.getElementById('meter').innerHTML.includes('>1<'),
      doc.getElementById('meter').innerHTML);
  }

  // ============================================================
  // Scenario 3: returning visitor with a valid stored key — should
  // unlock silently, no gate shown at all.
  // ============================================================
  {
    const dom = newDom();
    const { window } = dom;
    const fake = makeFakeBackend();
    window.fetch = fake;
    // Pre-seed a valid key as if a previous signup + card verification had
    // already happened and localStorage already had it before this page load.
    const checkoutResp = await fake('https://x/api/checkout', {
      method: 'POST', body: JSON.stringify({ plan: 'free', email: 'returning@example.com' }),
    }).then((r) => r.json());
    const sessionId = checkoutResp.checkoutUrl.split('/').pop();
    const keyResp = await fake('https://x/api/key-for-session?session_id=' + sessionId, { method: 'GET' })
      .then((r) => r.json());
    window.localStorage.setItem('transposeApiKey', keyResp.apiKey);

    // Re-fire init since localStorage was populated after the script's
    // initGate() already ran once on construction — simulate a fresh load.
    window.eval('initGate()');
    await new Promise((r) => setTimeout(r, 300));
    const doc = window.document;
    check('Gate: skipped entirely for a returning visitor with a valid stored key',
      doc.getElementById('gateOverlay').style.display === 'none');
  }

  // ============================================================
  // Scenario 4: stored key is invalid/revoked — gate must re-show,
  // not silently unlock or crash.
  // ============================================================
  {
    const dom = newDom();
    const { window } = dom;
    window.fetch = makeFakeBackend(); // fresh backend — this key doesn't exist in it
    window.localStorage.setItem('transposeApiKey', 'tp_free_revoked_or_fake');
    window.eval('initGate()');
    await new Promise((r) => setTimeout(r, 300));
    const doc = window.document;
    check('Gate: re-shown when the stored key is invalid/unrecognized',
      doc.getElementById('gateOverlay').style.display === 'flex');
    check('localStorage: invalid key is cleared, not left behind',
      window.localStorage.getItem('transposeApiKey') === null);
  }

  // ============================================================
  // Scenario 5: hit the real 50-call cap -> 429 shown, then a 401
  // (simulating revocation) re-gates the user mid-session.
  // ============================================================
  {
    const dom = newDom();
    const { window } = dom;
    let callCount = 0;
    // Seed a valid (already-verified) key directly in localStorage — signup
    // no longer unlocks inline, so this simulates a returning visitor whose
    // card was verified in an earlier session.
    window.localStorage.setItem('transposeApiKey', 'tp_capped');
    window.fetch = async (url, opts) => {
      if (url.endsWith('/api/usage')) {
        return { ok: true, status: 200, json: async () => ({ plan: 'free', used: 0, limit: 50 }) };
      }
      if (url.endsWith('/v1/convert')) {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 429, json: async () => ({ error: 'limit_reached', message: "You've used all 50 free calls on the Free plan. Upgrade to keep converting." }) };
        }
        return { ok: false, status: 401, json: async () => ({ error: 'invalid_api_key', message: 'This key is invalid or has been revoked.' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    window.eval('initGate()');
    await new Promise((r) => setTimeout(r, 300));
    const doc = window.document;
    check('Gate: unlocks immediately from the seeded stored key (no signup click needed)',
      doc.getElementById('gateOverlay').style.display === 'none');

    doc.getElementById('inputArea').value = '{"a":1}';
    doc.getElementById('outStatus').textContent = '';
    doc.getElementById('convertBtn').dispatchEvent(new window.Event('click'));
    await waitFor(() => doc.getElementById('outStatus').textContent === 'limit reached');
    check('429: shows the limit-reached message without re-gating (key stays valid)',
      doc.getElementById('gateOverlay').style.display === 'none' &&
      /50 free calls/.test(doc.getElementById('outputArea').textContent),
      doc.getElementById('outputArea').textContent);

    doc.getElementById('convertBtn').dispatchEvent(new window.Event('click'));
    await waitFor(() => doc.getElementById('gateOverlay').style.display === 'flex');
    check('401: re-shows the gate mid-session (e.g. key was revoked) and clears storage',
      doc.getElementById('gateOverlay').style.display === 'flex' &&
      window.localStorage.getItem('transposeApiKey') === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  const unexpected = errors.filter((e) => !/Could not load (script|link)/.test(e));
  if (unexpected.length) {
    console.log('\nUnexpected JS/jsdom errors:\n' + unexpected.join('\n'));
    fail++;
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Test crashed:', e); process.exit(1); });

// middleware.js

const db = require('./db');
const { PLANS } = require('./plans');

// Shared resolution: validates the key and computes current usage against
// the right cap (lifetime for Free, monthly for Build/Scale), without
// deciding whether to block the request. Returns false (and has already
// sent a 401 response) if the key is missing/invalid — callers must return
// immediately in that case. Split out so /api/usage can authenticate a key
// and report its usage WITHOUT enforcing the cap (see authenticateApiKey
// below) — otherwise a user who's hit their limit could never check their
// own usage numbers.
async function resolveApiKey(req, res) {
  // ---------------------------------------------------------------
  // Path 1: Requests from the RapidAPI marketplace.
  // RapidAPI bills the customer and enforces their quota on their
  // side; they authenticate to us with a shared proxy secret header.
  // Set RAPIDAPI_PROXY_SECRET in Railway once you get it from the
  // RapidAPI provider dashboard (API > Settings > Proxy Secret).
  // ---------------------------------------------------------------
  const rapidSecret = req.headers['x-rapidapi-proxy-secret'];
  if (
    rapidSecret &&
    process.env.RAPIDAPI_PROXY_SECRET &&
    rapidSecret === process.env.RAPIDAPI_PROXY_SECRET
  ) {
    const rapidUser = req.headers['x-rapidapi-user'] || 'unknown';
    req.apiKey = `rapidapi:${rapidUser}`;
    req.plan = 'rapidapi';
    req.planLimit = null; // RapidAPI enforces limits on their side
    req.used = await db.getUsageThisMonth(req.apiKey);
    req._planConfig = null;
    return true;
  }

  // ---------------------------------------------------------------
  // Path 2: Our own API keys (issued via Stripe checkout, or the free
  // signup flow).
  // ---------------------------------------------------------------
  const header = req.headers['authorization'] || '';
  const apiKey = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!apiKey) {
    res.status(401).json({
      error: 'missing_api_key',
      message: 'Include your key as: Authorization: Bearer YOUR_KEY',
    });
    return false;
  }

  const record = await db.getApiKey(apiKey);
  if (!record || !record.active) {
    res.status(401).json({
      error: 'invalid_api_key',
      message: 'This key is invalid or has been revoked.',
    });
    return false;
  }

  const plan = PLANS[record.plan] || PLANS.free;
  // Free is a flat lifetime cap that never renews; Build/Scale reset every
  // calendar month. Using the wrong query here would either let free users
  // reset their quota every month, or wrongly never reset paid users' quota.
  const used = plan.resetPeriod === 'lifetime'
    ? await db.getUsageTotal(apiKey)
    : await db.getUsageThisMonth(apiKey);

  req.apiKey = apiKey;
  req.plan = record.plan;
  req.used = used;
  req.planLimit = plan.limit;
  req._planConfig = plan;
  return true;
}

// Enforces the cap — used by /v1/convert. Blocks with 429 once used >= limit.
async function requireApiKey(req, res, next) {
  try {
    const ok = await resolveApiKey(req, res);
    if (!ok) return; // resolveApiKey already sent the 401

    const plan = req._planConfig;
    if (plan && req.used >= plan.limit) {
      return res.status(429).json({
        error: 'limit_reached',
        message: plan.resetPeriod === 'lifetime'
          ? `You've used all ${plan.limit} free calls on the ${plan.name} plan. Upgrade to keep converting.`
          : `You've used ${req.used}/${plan.limit} calls on the ${plan.name} plan this month. Upgrade at /api/checkout.`,
      });
    }
    next();
  } catch (err) {
    console.error('requireApiKey failed:', err.message);
    res.status(500).json({ error: 'internal_error', message: 'Auth check failed.' });
  }
}

// Read-only variant — used by /api/usage. Authenticates and reports real
// usage numbers, but never blocks with 429, even past the cap: this is the
// one place a capped-out user needs to be able to reach to see where they
// stand.
async function authenticateApiKey(req, res, next) {
  try {
    const ok = await resolveApiKey(req, res);
    if (!ok) return;
    next();
  } catch (err) {
    console.error('authenticateApiKey failed:', err.message);
    res.status(500).json({ error: 'internal_error', message: 'Auth check failed.' });
  }
}

module.exports = { requireApiKey, authenticateApiKey };

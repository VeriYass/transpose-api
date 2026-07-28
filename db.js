// db.js
// Postgres-backed store. Replaces the JSON-file version, which lived on
// Railway's ephemeral filesystem and was wiped on every deploy — meaning
// every paying customer's API key vanished each time we shipped anything.
//
// Deliberately refuses to boot without DATABASE_URL (see the throw below)
// so the app can never silently fall back to ephemeral storage again.

const { Pool } = require('pg');
const { nanoid } = require('nanoid');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'FATAL: DATABASE_URL is not set. This app requires Postgres and will not ' +
    'start without it — add a Postgres instance in Railway (+ New > Database ' +
    '> Add PostgreSQL), which auto-injects DATABASE_URL.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's managed Postgres sits behind a proxy that presents a
  // certificate not signed by a CA Node trusts by default; this is the
  // standard setting for that, not a general "skip TLS" shortcut.
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

// ---------------------------------------------------------------------------
// Schema. Called once at boot (server.js), before the app starts accepting
// requests. IF NOT EXISTS makes this safe to run on every deploy.
// ---------------------------------------------------------------------------
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      stripe_customer_id TEXT PRIMARY KEY,
      email TEXT,
      plan TEXT,
      subscription_id TEXT,
      status TEXT,
      card_fingerprint TEXT,
      updated_at TIMESTAMPTZ
    )
  `);
  // Existing deployments won't have this column yet — add it if missing.
  // (IF NOT EXISTS on the CREATE TABLE above only helps for brand-new DBs.)
  await pool.query(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS card_fingerprint TEXT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_customers_card_fingerprint ON customers (card_fingerprint)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      api_key TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_customer ON api_keys (stripe_customer_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      api_key TEXT NOT NULL,
      day DATE NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (api_key, day)
    )
  `);
  // Controlled gate (Yasser): no card-verification Stripe session gets
  // created for the free tier until the email itself has been confirmed via
  // a one-time link. Card entry is structurally unreachable without a valid,
  // unconsumed token — see the /verify-email route in server.js, which is
  // the ONLY place that calls stripe.checkout.sessions.create for plan=free.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      plan TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications (email)
  `);
}

// ---- Customers ---- keyed by Stripe customer ID.
// Merges only the fields passed in, same as the old JSON version's spread —
// COALESCE falls back to the existing column value when a field is omitted.
async function upsertCustomer(stripeCustomerId, fields = {}) {
  const { email = null, plan = null, subscriptionId = null, status = null, cardFingerprint = null } = fields;
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO customers (stripe_customer_id, email, plan, subscription_id, status, card_fingerprint, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (stripe_customer_id) DO UPDATE SET
       email = COALESCE($2, customers.email),
       plan = COALESCE($3, customers.plan),
       subscription_id = COALESCE($4, customers.subscription_id),
       status = COALESCE($5, customers.status),
       card_fingerprint = COALESCE($6, customers.card_fingerprint),
       updated_at = $7
     RETURNING *`,
    [stripeCustomerId, email, plan, subscriptionId, status, cardFingerprint, now]
  );
  return rowToCustomer(rows[0]);
}

async function getCustomer(stripeCustomerId) {
  const { rows } = await pool.query(
    'SELECT * FROM customers WHERE stripe_customer_id = $1',
    [stripeCustomerId]
  );
  return rows[0] ? rowToCustomer(rows[0]) : null;
}

// Looks up the internal customer id for a given email + plan, so signup-free
// can detect "this email already has a free account" and hand back the
// existing key instead of minting a new one (which would otherwise let
// anyone reset their lifetime free quota just by resubmitting the form).
async function getCustomerIdByEmail(email, plan) {
  // Bug found while validating the dedup fix: ORDER BY updated_at DESC picks
  // the MOST RECENT customer row for this email — but once the webhook
  // started recording a "duplicate_signup" row (no key attached) for every
  // repeat attempt, that duplicate row is what's most recent, and it would
  // shadow the original customer that actually holds the key. Preferring
  // rows with an active key first fixes that regardless of how many
  // duplicate-tracking rows pile up under the same email.
  const { rows } = await pool.query(
    `SELECT c.stripe_customer_id
     FROM customers c
     LEFT JOIN api_keys ak ON ak.stripe_customer_id = c.stripe_customer_id AND ak.active = true
     WHERE c.email = $1 AND c.plan = $2
     ORDER BY (ak.api_key IS NOT NULL) DESC, c.updated_at ASC
     LIMIT 1`,
    [email, plan]
  );
  return rows[0] ? rows[0].stripe_customer_id : null;
}

// Looks up the internal customer id that already has a FREE key tied to a
// given card fingerprint, so the same physical card can't be used across
// several different emails to mint several separate 50-call allowances.
// Scoped to plan='free' — a card that's already paying on Build/Scale isn't
// what this check is for.
async function getCustomerIdByCardFingerprint(fingerprint) {
  if (!fingerprint) return null;
  const { rows } = await pool.query(
    `SELECT stripe_customer_id FROM customers WHERE card_fingerprint = $1 AND plan = 'free'
     ORDER BY updated_at ASC LIMIT 1`,
    [fingerprint]
  );
  return rows[0] ? rows[0].stripe_customer_id : null;
}

function rowToCustomer(row) {
  if (!row) return null;
  return {
    email: row.email,
    plan: row.plan,
    subscriptionId: row.subscription_id,
    status: row.status,
    cardFingerprint: row.card_fingerprint,
  };
}

// ---- API keys ---- keyed by the key string itself.
async function createApiKey(apiKey, stripeCustomerId, plan) {
  await pool.query(
    `INSERT INTO api_keys (api_key, stripe_customer_id, plan, created_at, active)
     VALUES ($1, $2, $3, $4, true)`,
    [apiKey, stripeCustomerId, plan, new Date().toISOString()]
  );
}

async function getApiKey(apiKey) {
  const { rows } = await pool.query('SELECT * FROM api_keys WHERE api_key = $1', [apiKey]);
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    stripeCustomerId: row.stripe_customer_id,
    plan: row.plan,
    createdAt: row.created_at,
    active: row.active,
  };
}

async function getApiKeyByCustomer(stripeCustomerId) {
  const { rows } = await pool.query(
    `SELECT api_key FROM api_keys WHERE stripe_customer_id = $1 AND active = true
     ORDER BY created_at DESC LIMIT 1`,
    [stripeCustomerId]
  );
  return rows[0] ? rows[0].api_key : null;
}

async function revokeApiKeysForCustomer(stripeCustomerId) {
  await pool.query(
    'UPDATE api_keys SET active = false WHERE stripe_customer_id = $1',
    [stripeCustomerId]
  );
}

async function updatePlanForCustomer(stripeCustomerId, plan) {
  await pool.query(
    'UPDATE api_keys SET plan = $2 WHERE stripe_customer_id = $1',
    [stripeCustomerId, plan]
  );
}

// ---- Usage (per API key, per UTC day) ----
async function recordUsage(apiKey) {
  const day = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `INSERT INTO usage_daily (api_key, day, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (api_key, day) DO UPDATE SET count = usage_daily.count + 1
     RETURNING count`,
    [apiKey, day]
  );
  return rows[0].count;
}

async function getUsageThisMonth(apiKey) {
  // Computed in JS rather than with date_trunc/to_char so this query stays
  // portable across Postgres versions (and testable against pg-mem).
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().slice(0, 10);
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(count), 0) AS total FROM usage_daily
     WHERE api_key = $1 AND day >= $2 AND day < $3`,
    [apiKey, monthStart, nextMonthStart]
  );
  return Number(rows[0].total);
}

// Lifetime total across every day this key has ever been used — for plans
// with resetPeriod: 'lifetime' (Free), where the cap never renews. Distinct
// from getUsageThisMonth, which resets every calendar month (Build/Scale).
async function getUsageTotal(apiKey) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(count), 0) AS total FROM usage_daily WHERE api_key = $1`,
    [apiKey]
  );
  return Number(rows[0].total);
}

// ---- Email verification (controlled gate ahead of card entry) ----
const VERIFICATION_TTL_MINUTES = 30;

// One-time, expiring token tying an email to the plan it's trying to sign
// up for. Nothing downstream (i.e. stripe.checkout.sessions.create) may run
// for that email until this token is presented and consumed.
async function createEmailVerification(email, plan) {
  const token = nanoid(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MINUTES * 60 * 1000);
  await pool.query(
    `INSERT INTO email_verifications (token, email, plan, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [token, email, plan, now.toISOString(), expiresAt.toISOString()]
  );
  return token;
}

// Single-use: a token can only ever succeed once. Returns { email, plan } on
// a valid, unexpired, not-yet-consumed token; null otherwise (expired,
// already used, or never existed — all treated identically to the caller,
// since none of those should ever let a Stripe session get created).
async function consumeEmailVerification(token) {
  const { rows } = await pool.query(
    `UPDATE email_verifications
     SET consumed_at = now()
     WHERE token = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING email, plan`,
    [token]
  );
  return rows[0] || null;
}

module.exports = {
  pool,
  initSchema,
  upsertCustomer,
  getCustomer,
  getCustomerIdByEmail,
  getCustomerIdByCardFingerprint,
  createApiKey,
  getApiKey,
  getApiKeyByCustomer,
  revokeApiKeysForCustomer,
  updatePlanForCustomer,
  recordUsage,
  getUsageThisMonth,
  getUsageTotal,
  createEmailVerification,
  consumeEmailVerification,
};

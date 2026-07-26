// db.js
// Postgres-backed store. Replaces the JSON-file version, which lived on
// Railway's ephemeral filesystem and was wiped on every deploy — meaning
// every paying customer's API key vanished each time we shipped anything.
//
// Deliberately refuses to boot without DATABASE_URL (see the throw below)
// so the app can never silently fall back to ephemeral storage again.

const { Pool } = require('pg');

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
      updated_at TIMESTAMPTZ
    )
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
}

// ---- Customers ---- keyed by Stripe customer ID.
// Merges only the fields passed in, same as the old JSON version's spread —
// COALESCE falls back to the existing column value when a field is omitted.
async function upsertCustomer(stripeCustomerId, fields = {}) {
  const { email = null, plan = null, subscriptionId = null, status = null } = fields;
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO customers (stripe_customer_id, email, plan, subscription_id, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_customer_id) DO UPDATE SET
       email = COALESCE($2, customers.email),
       plan = COALESCE($3, customers.plan),
       subscription_id = COALESCE($4, customers.subscription_id),
       status = COALESCE($5, customers.status),
       updated_at = $6
     RETURNING *`,
    [stripeCustomerId, email, plan, subscriptionId, status, now]
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

function rowToCustomer(row) {
  if (!row) return null;
  return {
    email: row.email,
    plan: row.plan,
    subscriptionId: row.subscription_id,
    status: row.status,
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

module.exports = {
  pool,
  initSchema,
  upsertCustomer,
  getCustomer,
  createApiKey,
  getApiKey,
  getApiKeyByCustomer,
  revokeApiKeysForCustomer,
  updatePlanForCustomer,
  recordUsage,
  getUsageThisMonth,
};

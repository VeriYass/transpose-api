// db.js
// File-backed JSON store. Fine for launch/low volume; swap for Postgres
// (see README "Going to production") once you have real concurrent traffic.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(DB_PATH)) {
    return { customers: {}, apiKeys: {}, usage: {} };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---- Customers ----
// keyed by Stripe customer ID
function upsertCustomer(stripeCustomerId, fields) {
  const data = load();
  data.customers[stripeCustomerId] = {
    ...(data.customers[stripeCustomerId] || {}),
    ...fields,
  };
  save(data);
  return data.customers[stripeCustomerId];
}

function getCustomer(stripeCustomerId) {
  const data = load();
  return data.customers[stripeCustomerId] || null;
}

// ---- API Keys ----
// keyed by the API key string itself
function createApiKey(apiKey, stripeCustomerId, plan) {
  const data = load();
  data.apiKeys[apiKey] = {
    stripeCustomerId,
    plan,
    createdAt: new Date().toISOString(),
    active: true,
  };
  save(data);
}

function getApiKey(apiKey) {
  const data = load();
  return data.apiKeys[apiKey] || null;
}

function getApiKeyByCustomer(stripeCustomerId) {
  const data = load();
  for (const [key, rec] of Object.entries(data.apiKeys)) {
    if (rec.stripeCustomerId === stripeCustomerId && rec.active) {
      return key;
    }
  }
  return null;
}

function revokeApiKeysForCustomer(stripeCustomerId) {
  const data = load();
  for (const key of Object.keys(data.apiKeys)) {
    if (data.apiKeys[key].stripeCustomerId === stripeCustomerId) {
      data.apiKeys[key].active = false;
    }
  }
  save(data);
}

function updatePlanForCustomer(stripeCustomerId, plan) {
  const data = load();
  for (const key of Object.keys(data.apiKeys)) {
    if (data.apiKeys[key].stripeCustomerId === stripeCustomerId) {
      data.apiKeys[key].plan = plan;
    }
  }
  save(data);
}

// ---- Usage (per API key, per UTC day) ----
function recordUsage(apiKey) {
  const data = load();
  const day = new Date().toISOString().slice(0, 10);
  data.usage[apiKey] = data.usage[apiKey] || {};
  data.usage[apiKey][day] = (data.usage[apiKey][day] || 0) + 1;
  save(data);
  return data.usage[apiKey][day];
}

function getUsageThisMonth(apiKey) {
  const data = load();
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const days = data.usage[apiKey] || {};
  return Object.entries(days)
    .filter(([day]) => day.startsWith(month))
    .reduce((sum, [, count]) => sum + count, 0);
}

module.exports = {
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

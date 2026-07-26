// Run with: node -r ./shim-pg-mem.js test-db.js
// Exercises db.js against pg-mem (a real, if in-memory, SQL engine) rather
// than mocking the pg module's methods directly — so the actual SQL
// (ON CONFLICT, RETURNING, aggregates) gets executed, not just called.
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';

const assert = require('assert');
const db = require('./db');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('ok   -', name); }
  catch (e) { fail++; console.log('FAIL -', name, '\n     ', e.message); }
}

async function main() {
  await t('initSchema creates all tables without error', async () => {
    await db.initSchema();
  });

  await t('createApiKey + getApiKey round trip', async () => {
    await db.createApiKey('tp_test_1', 'cust_1', 'build');
    const rec = await db.getApiKey('tp_test_1');
    assert.strictEqual(rec.stripeCustomerId, 'cust_1');
    assert.strictEqual(rec.plan, 'build');
    assert.strictEqual(rec.active, true);
  });

  await t('getApiKey returns null for unknown key', async () => {
    const rec = await db.getApiKey('does_not_exist');
    assert.strictEqual(rec, null);
  });

  await t('upsertCustomer creates a new row', async () => {
    const c = await db.upsertCustomer('cust_1', { email: 'a@example.com', plan: 'build', status: 'active' });
    assert.strictEqual(c.email, 'a@example.com');
    assert.strictEqual(c.status, 'active');
  });

  await t('upsertCustomer merges partial fields, keeps existing values (COALESCE)', async () => {
    await db.upsertCustomer('cust_1', { status: 'past_due' });
    const c = await db.getCustomer('cust_1');
    assert.strictEqual(c.email, 'a@example.com'); // unchanged
    assert.strictEqual(c.status, 'past_due'); // updated
  });

  await t('getCustomer returns null for unknown customer', async () => {
    const c = await db.getCustomer('nope');
    assert.strictEqual(c, null);
  });

  await t('getApiKeyByCustomer finds the active key for a customer', async () => {
    const key = await db.getApiKeyByCustomer('cust_1');
    assert.strictEqual(key, 'tp_test_1');
  });

  await t('getApiKeyByCustomer returns null when no active key', async () => {
    const key = await db.getApiKeyByCustomer('nobody');
    assert.strictEqual(key, null);
  });

  await t('updatePlanForCustomer changes the plan on the api_keys row', async () => {
    await db.updatePlanForCustomer('cust_1', 'scale');
    const rec = await db.getApiKey('tp_test_1');
    assert.strictEqual(rec.plan, 'scale');
  });

  await t('revokeApiKeysForCustomer deactivates keys, getApiKeyByCustomer then returns null', async () => {
    await db.revokeApiKeysForCustomer('cust_1');
    const rec = await db.getApiKey('tp_test_1');
    assert.strictEqual(rec.active, false);
    const key = await db.getApiKeyByCustomer('cust_1');
    assert.strictEqual(key, null);
  });

  await t('recordUsage increments per-day count and returns running total for the day', async () => {
    await db.createApiKey('tp_test_2', 'cust_2', 'free');
    const first = await db.recordUsage('tp_test_2');
    const second = await db.recordUsage('tp_test_2');
    const third = await db.recordUsage('tp_test_2');
    assert.strictEqual(first, 1);
    assert.strictEqual(second, 2);
    assert.strictEqual(third, 3);
  });

  await t('getUsageThisMonth sums this month\'s usage for a key', async () => {
    const total = await db.getUsageThisMonth('tp_test_2');
    assert.strictEqual(total, 3);
  });

  await t('getUsageThisMonth is 0 for a key with no usage rows', async () => {
    await db.createApiKey('tp_test_3', 'cust_3', 'free');
    const total = await db.getUsageThisMonth('tp_test_3');
    assert.strictEqual(total, 0);
  });

  await t('usage is isolated per API key', async () => {
    await db.createApiKey('tp_test_4', 'cust_4', 'free');
    await db.recordUsage('tp_test_4');
    const key2Total = await db.getUsageThisMonth('tp_test_2'); // unaffected
    const key4Total = await db.getUsageThisMonth('tp_test_4');
    assert.strictEqual(key2Total, 3);
    assert.strictEqual(key4Total, 1);
  });

  await t('two customers can each have their own active key simultaneously', async () => {
    await db.upsertCustomer('cust_5', { email: 'b@example.com', plan: 'free', status: 'active' });
    await db.createApiKey('tp_test_5', 'cust_5', 'free');
    const k1 = await db.getApiKeyByCustomer('cust_2');
    const k2 = await db.getApiKeyByCustomer('cust_5');
    assert.strictEqual(k1, 'tp_test_2');
    assert.strictEqual(k2, 'tp_test_5');
  });

  await t('re-subscribing after cancellation issues a new active key while old stays revoked', async () => {
    await db.revokeApiKeysForCustomer('cust_5');
    await db.createApiKey('tp_test_5b', 'cust_5', 'build');
    const active = await db.getApiKeyByCustomer('cust_5');
    const oldRec = await db.getApiKey('tp_test_5');
    assert.strictEqual(active, 'tp_test_5b');
    assert.strictEqual(oldRec.active, false);
  });

  await t('DATABASE_URL guard: db.js throws synchronously when unset', () => {
    delete require.cache[require.resolve('./db')];
    const originalUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.throws(() => require('./db'), /DATABASE_URL/);
    } finally {
      process.env.DATABASE_URL = originalUrl;
      delete require.cache[require.resolve('./db')];
      require('./db'); // restore normal state for anything running after
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end?.().catch(() => {});
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});

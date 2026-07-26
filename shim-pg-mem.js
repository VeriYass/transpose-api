// Preload hook (node -r ./shim-pg-mem.js ...) that swaps the real 'pg'
// module for an in-memory Postgres engine (pg-mem), so db.js and server.js
// can be tested/boot-checked end to end without a live Postgres instance.
// Not used in production — only in the test/boot-check scripts.
const { newDb } = require('pg-mem');
const mem = newDb();
const pgAdapter = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: pgAdapter,
};

const assert = require('assert');
const { convert, SUPPORTED_FORMATS, ALL_OUTPUT_FORMATS } = require('./convert');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok   -', name); }
  catch (e) { fail++; console.log('FAIL -', name, '\n     ', e.message); }
}

// ---- existing behavior must still work (regression) ----
t('CSV RFC4180: quoted commas + embedded newline survive', () => {
  const csv = 'name,note\n"Doe, Jane","line1\nline2"';
  const json = JSON.parse(convert(csv, 'csv', 'json'));
  assert.strictEqual(json[0].name, 'Doe, Jane');
  assert.strictEqual(json[0].note, 'line1\nline2');
});

t('CSV: leading zeros preserved as string', () => {
  const json = JSON.parse(convert('zip\n02139', 'csv', 'json'));
  assert.strictEqual(json[0].zip, '02139');
});

t('K8s ConfigMap: values stringified', () => {
  const out = convert('server.port=8080', 'properties', 'k8s-configmap');
  assert.ok(out.includes('server.port: "8080"'));
  assert.ok(out.includes('kind: ConfigMap'));
});

// ---- new: .properties write support ----
t('properties: write from nested JSON (flattened, dot notation)', () => {
  const json = JSON.stringify({ server: { port: 8080, host: 'local' }, debug: true });
  const out = convert(json, 'json', 'properties');
  assert.ok(out.includes('server.port=8080'));
  assert.ok(out.includes('server.host=local'));
  assert.ok(out.includes('debug=true'));
});

t('properties: round trip json -> properties -> json preserves values incl. escapes', () => {
  const original = { path: 'C:\\app', note: 'line1\nline2\ttabbed' };
  const props = convert(JSON.stringify(original), 'json', 'properties');
  const back = JSON.parse(convert(props, 'properties', 'json'));
  assert.strictEqual(back.path, original.path);
  assert.strictEqual(back.note, original.note);
});

t('properties: key with special chars (colon/equals/space) escaped and read back', () => {
  const original = { 'weird key': 'a=b:c' };
  const props = convert(JSON.stringify(original), 'json', 'properties');
  const back = JSON.parse(convert(props, 'properties', 'json'));
  assert.deepStrictEqual(back, original);
});

// ---- new: full TOML spec via smol-toml ----
t('TOML: nested tables, arrays of tables, inline tables all round-trip', () => {
  const src = `
title = "demo"
[server]
port = 8080
tags = ["a", "b"]
[server.tls]
enabled = true
[[servers]]
name = "one"
[[servers]]
name = "two"
`;
  const obj = JSON.parse(convert(src, 'toml', 'json'));
  assert.strictEqual(obj.title, 'demo');
  assert.strictEqual(obj.server.port, 8080);
  assert.deepStrictEqual(obj.server.tags, ['a', 'b']);
  assert.strictEqual(obj.server.tls.enabled, true);
  assert.strictEqual(obj.servers.length, 2);
  assert.strictEqual(obj.servers[1].name, 'two');

  // and back out to toml, then re-parse, should preserve structure
  const tomlOut = convert(JSON.stringify(obj), 'json', 'toml');
  const reparsed = JSON.parse(convert(tomlOut, 'toml', 'json'));
  assert.deepStrictEqual(reparsed, obj);
});

// ---- new: INI format ----
t('INI: sections + values round trip', () => {
  const ini = '[db]\nhost=localhost\nport=5432\n\n[app]\ndebug=true';
  const obj = JSON.parse(convert(ini, 'ini', 'json'));
  assert.strictEqual(obj.db.host, 'localhost');
  assert.strictEqual(obj.db.port, 5432); // coerced to number
  assert.strictEqual(obj.app.debug, true); // coerced to boolean

  const back = convert(JSON.stringify(obj), 'json', 'ini');
  assert.ok(back.includes('[db]'));
  assert.ok(back.includes('host=localhost'));
});

// ---- new: K8s Secret generator ----
t('K8s Secret: values are base64 encoded, type Opaque', () => {
  const out = convert('DB_PASSWORD=hunter2\nAPI_KEY=abc123', 'env', 'k8s-secret');
  assert.ok(out.includes('kind: Secret'));
  assert.ok(out.includes('type: Opaque'));
  const b64 = Buffer.from('hunter2', 'utf8').toString('base64');
  assert.ok(out.includes(`DB_PASSWORD: ${b64}`));
});

t('K8s Secret: nested JSON flattened like ConfigMap', () => {
  const out = convert(JSON.stringify({ db: { password: 'p@ss' } }), 'json', 'k8s-secret');
  const b64 = Buffer.from('p@ss', 'utf8').toString('base64');
  assert.ok(out.includes(`db.password: ${b64}`));
});

// ---- format registry sanity ----
t('registry: ini and properties are valid inputs; k8s-secret is output-only', () => {
  assert.ok(SUPPORTED_FORMATS.includes('ini'));
  assert.ok(SUPPORTED_FORMATS.includes('properties'));
  assert.ok(!SUPPORTED_FORMATS.includes('k8s-secret'));
  assert.ok(ALL_OUTPUT_FORMATS.includes('k8s-secret'));
  assert.ok(ALL_OUTPUT_FORMATS.includes('properties'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

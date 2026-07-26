// convert.js
// Core conversion logic: CSV / JSON / YAML / XML / TOML / ENV / INI / properties,
// plus Kubernetes ConfigMap and Secret generation, in any direction.

const yaml = require('js-yaml');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const TOML = require('smol-toml');
const ini = require('ini');

const xmlParser = new XMLParser({ ignoreAttributes: false });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, format: true });

// CSV handling per RFC 4180. A naive split(',') silently corrupts any field
// containing a comma, quote, or newline — the worst kind of failure, since it
// produces plausible-looking wrong output rather than an error.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let fieldWasQuoted = false;
  let inQuotes = false;
  let i = 0;

  function endField() {
    // Whitespace inside quotes is significant; outside it usually isn't.
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; fieldWasQuoted = true; i++; continue; }
    if (ch === ',') { endField(); i++; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); i++; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || fieldWasQuoted || row.length > 0) endRow();
  return rows;
}

function coerceValue(v) {
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Preserve as string: leading zeros (zip codes, IDs like 007), leading +,
  // and integers long enough to lose precision as JS numbers.
  if (/^\+/.test(v)) return v;
  if (/^-?0\d/.test(v)) return v;
  if (/^-?\d{16,}$/.test(v)) return v;
  if (!isNaN(v) && !isNaN(parseFloat(v))) return Number(v);
  return v;
}

function csvToObj(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) throw new Error('Empty CSV input');
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = coerceValue(cells[idx] === undefined ? '' : cells[idx]);
    });
    return obj;
  });
}

function escapeCsvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function objToCsv(data) {
  const arr = Array.isArray(data) ? data : [data];
  if (!arr.length) return '';
  // Union of all keys, not just the first row's — later rows may add fields.
  const headers = [];
  arr.forEach((row) => {
    Object.keys(row || {}).forEach((k) => { if (!headers.includes(k)) headers.push(k); });
  });
  const lines = [headers.map(escapeCsvField).join(',')];
  arr.forEach((row) => {
    lines.push(headers.map((h) => escapeCsvField(row ? row[h] : '')).join(','));
  });
  return lines.join('\n');
}

// ---- ENV format ----
function envToObj(text) {
  const obj = {};
  text.split('\n').forEach((line) => {
    const l = line.trim();
    if (!l || l.startsWith('#')) return;
    const eq = l.indexOf('=');
    if (eq === -1) return;
    const key = l.slice(0, eq).trim();
    let val = l.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    obj[key] = val;
  });
  return obj;
}

function objToEnv(data) {
  const flat = Array.isArray(data) ? data[0] || {} : data;
  return Object.entries(flat)
    .map(([k, v]) => {
      const val = String(v);
      const needsQuotes = /\s|#/.test(val);
      return `${k}=${needsQuotes ? '"' + val + '"' : val}`;
    })
    .join('\n');
}

// ---- TOML format ----
// Backed by smol-toml (full TOML 1.0 spec: nested/inline tables, arrays of
// tables, dates, multiline strings) instead of a hand-rolled "common subset"
// parser, which previously silently mishandled anything beyond flat
// key=value + single-level [section] blocks.
function tomlToObj(text) {
  return TOML.parse(text);
}

function objToToml(data) {
  const flat = Array.isArray(data) ? data[0] || {} : data;
  return TOML.stringify(flat);
}

// ---- INI format ----
// Sections map to one level of nested objects, same convention TOML uses.
// INI has no native types, so values round-trip as strings unless coerced.
function iniToObj(text) {
  const parsed = ini.parse(text);
  const coerceDeep = (obj) => {
    const out = {};
    Object.entries(obj).forEach(([k, v]) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = coerceDeep(v);
      } else if (typeof v === 'string') {
        out[k] = coerceValue(v);
      } else {
        out[k] = v;
      }
    });
    return out;
  };
  return coerceDeep(parsed);
}

function objToIni(data) {
  const flat = Array.isArray(data) ? data[0] || {} : data;
  return ini.stringify(flat);
}

// ---- .properties format (Java-style: key=value or key:value, # or ! comments) ----
// Supports the backslash escapes the Java spec defines for values (\n \t \\)
// so round trips through JSON/YAML don't corrupt multi-line or tabbed values.
function unescapePropertiesValue(v) {
  return v.replace(/\\(.)/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch; // \\  \:  \=  \#  \!  \space -> literal char
  });
}

function propertiesToObj(text) {
  const obj = {};
  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) return;
    const match = line.match(/^([^=:]+)[=:](.*)$/);
    if (!match) return;
    const key = unescapePropertiesValue(match[1].trim());
    const val = unescapePropertiesValue(match[2].trim());
    obj[key] = val;
  });
  return obj;
}

function escapePropertiesKey(k) {
  return String(k).replace(/\\/g, '\\\\').replace(/[:=#! ]/g, '\\$&');
}

function escapePropertiesValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Nested objects are flattened to dot-notation keys, same convention used
// for K8s ConfigMap generation, so JSON/YAML sources with nested structure
// produce sensible .properties output instead of "[object Object]".
function objToProperties(data) {
  const flat = flattenObj(Array.isArray(data) ? data[0] || {} : data);
  return Object.entries(flat)
    .map(([k, v]) => `${escapePropertiesKey(k)}=${escapePropertiesValue(v)}`)
    .join('\n');
}

// ---- Flatten nested objects into dot-notation - K8s ConfigMap.data must be
// a flat map[string]string, so this lets any source format (nested JSON/YAML
// included) convert sensibly, not just already-flat ones. Reused by the
// .properties writer for the same reason. ----
function flattenObj(obj, prefix = '') {
  const out = {};
  Object.entries(obj).forEach(([key, val]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(out, flattenObj(val, fullKey));
    } else if (Array.isArray(val)) {
      out[fullKey] = JSON.stringify(val);
    } else {
      out[fullKey] = val;
    }
  });
  return out;
}

// ---- Kubernetes ConfigMap YAML generator ----
// Verified against the official K8s API spec: apiVersion/kind/metadata.name/data
// are required, and every value in `data` MUST be a string (map[string]string) -
// this is why every value is explicitly quoted rather than left as a native
// YAML type, which would be invalid against the real ConfigMap schema.
function objToConfigMap(data, configMapName) {
  const name = configMapName || 'app-config';
  const flat = flattenObj(Array.isArray(data) ? (data[0] || {}) : data);
  const lines = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', `  name: ${name}`, 'data:'];
  Object.entries(flat).forEach(([key, val]) => {
    const strVal = String(val).replace(/"/g, '\\"');
    lines.push(`  ${key}: "${strVal}"`);
  });
  return lines.join('\n');
}

// ---- Kubernetes Secret YAML generator ----
// Same shape as ConfigMap, but the K8s API requires Secret.data values to be
// base64-encoded strings (kind: Secret, type: Opaque). This is the natural
// companion to ConfigMap generation — anything that looks like a credential
// (.env files, API keys) should go here instead of a plaintext ConfigMap.
function objToSecret(data, secretName) {
  const name = secretName || 'app-secret';
  const flat = flattenObj(Array.isArray(data) ? (data[0] || {}) : data);
  const lines = ['apiVersion: v1', 'kind: Secret', 'metadata:', `  name: ${name}`, 'type: Opaque', 'data:'];
  Object.entries(flat).forEach(([key, val]) => {
    const b64 = Buffer.from(String(val), 'utf8').toString('base64');
    lines.push(`  ${key}: ${b64}`);
  });
  return lines.join('\n');
}

function parseInput(text, fmt) {
  switch (fmt) {
    case 'json':
      return JSON.parse(text);
    case 'yaml':
      return yaml.load(text);
    case 'csv':
      return csvToObj(text);
    case 'xml':
      return xmlParser.parse(text);
    case 'toml':
      return tomlToObj(text);
    case 'env':
      return envToObj(text);
    case 'ini':
      return iniToObj(text);
    case 'properties':
      return propertiesToObj(text);
    default:
      throw new Error(`Unsupported source format: ${fmt}`);
  }
}

function serializeOutput(data, fmt, fmtOptions = {}) {
  switch (fmt) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'yaml':
      return yaml.dump(data);
    case 'csv':
      return objToCsv(data);
    case 'xml':
      return xmlBuilder.build(Array.isArray(data) ? { root: { item: data } } : data);
    case 'toml':
      return objToToml(data);
    case 'env':
      return objToEnv(data);
    case 'ini':
      return objToIni(data);
    case 'properties':
      return objToProperties(data);
    case 'k8s-configmap':
      return objToConfigMap(data, fmtOptions.name);
    case 'k8s-secret':
      return objToSecret(data, fmtOptions.name);
    default:
      throw new Error(`Unsupported target format: ${fmt}`);
  }
}

// Formats that can be parsed as INPUT.
const SUPPORTED_FORMATS = ['json', 'yaml', 'csv', 'xml', 'toml', 'env', 'ini', 'properties'];
// k8s-configmap / k8s-secret are generation-only: valid as a target, never as a source.
const OUTPUT_ONLY_FORMATS = ['k8s-configmap', 'k8s-secret'];
const ALL_OUTPUT_FORMATS = [...SUPPORTED_FORMATS, ...OUTPUT_ONLY_FORMATS];

function convert(text, from, to, options = {}) {
  if (!SUPPORTED_FORMATS.includes(from)) throw new Error(`Unsupported "from" format: ${from}`);
  if (!ALL_OUTPUT_FORMATS.includes(to)) throw new Error(`Unsupported "to" format: ${to}`);
  const parsed = parseInput(text, from);
  return serializeOutput(parsed, to, options);
}

module.exports = { convert, SUPPORTED_FORMATS, ALL_OUTPUT_FORMATS };

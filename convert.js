// convert.js
// Core conversion logic: CSV / JSON / YAML / XML / TOML / ENV, in any direction.

const yaml = require('js-yaml');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

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

// ---- TOML format (common subset: top-level keys, [sections], strings/numbers/bools/arrays) ----
function parseTomlValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseTomlValue(item.trim()));
  }
  return v;
}

function tomlToObj(text) {
  const result = {};
  let current = result;
  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const sectionMatch = line.match(/^\[([\w.]+)\]$/);
    if (sectionMatch) {
      current = {};
      result[sectionMatch[1]] = current;
      return;
    }
    const eq = line.indexOf('=');
    if (eq === -1) return;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    current[key] = parseTomlValue(val);
  });
  return result;
}

function serializeTomlValue(v) {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(serializeTomlValue).join(', ')}]`;
  return `"${String(v)}"`;
}

function objToToml(data) {
  const flat = Array.isArray(data) ? data[0] || {} : data;
  const topLevel = [];
  const sections = [];
  Object.entries(flat).forEach(([key, val]) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const lines = Object.entries(val).map(([k, v]) => `${k} = ${serializeTomlValue(v)}`);
      sections.push(`[${key}]\n${lines.join('\n')}`);
    } else {
      topLevel.push(`${key} = ${serializeTomlValue(val)}`);
    }
  });
  const blocks = [];
  if (topLevel.length) blocks.push(topLevel.join('\n'));
  if (sections.length) blocks.push(sections.join('\n\n'));
  return blocks.join('\n\n');
}

// ---- .properties format (Java-style: key=value or key:value, # or ! comments) ----
function propertiesToObj(text) {
  const obj = {};
  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) return;
    const match = line.match(/^([^=:]+)[=:](.*)$/);
    if (!match) return;
    const key = match[1].trim();
    const val = match[2].trim();
    obj[key] = val;
  });
  return obj;
}

// ---- Flatten nested objects into dot-notation - K8s ConfigMap.data must be
// a flat map[string]string, so this lets any source format (nested JSON/YAML
// included) convert sensibly, not just already-flat ones. ----
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
    case 'k8s-configmap':
      return objToConfigMap(data, fmtOptions.name);
    default:
      throw new Error(`Unsupported target format: ${fmt}`);
  }
}

// Formats that can be parsed as INPUT.
const SUPPORTED_FORMATS = ['json', 'yaml', 'csv', 'xml', 'toml', 'env', 'properties'];
// k8s-configmap is generation-only: valid as a target, never as a source.
const OUTPUT_ONLY_FORMATS = ['k8s-configmap'];
const ALL_OUTPUT_FORMATS = [...SUPPORTED_FORMATS, ...OUTPUT_ONLY_FORMATS];

function convert(text, from, to, options = {}) {
  if (!SUPPORTED_FORMATS.includes(from)) throw new Error(`Unsupported "from" format: ${from}`);
  if (!ALL_OUTPUT_FORMATS.includes(to)) throw new Error(`Unsupported "to" format: ${to}`);
  const parsed = parseInput(text, from);
  return serializeOutput(parsed, to, options);
}

module.exports = { convert, SUPPORTED_FORMATS, ALL_OUTPUT_FORMATS };

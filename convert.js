// convert.js
// Core conversion logic: CSV / JSON / YAML / XML, in any direction.

const yaml = require('js-yaml');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

const xmlParser = new XMLParser({ ignoreAttributes: false });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, format: true });

function csvToObj(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) throw new Error('Empty CSV input');
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => {
      let v = cells[i];
      if (v === undefined) v = '';
      if (v !== '' && !isNaN(v)) v = Number(v);
      else if (v === 'true') v = true;
      else if (v === 'false') v = false;
      row[h] = v;
    });
    return row;
  });
}

function objToCsv(data) {
  const arr = Array.isArray(data) ? data : [data];
  if (!arr.length) return '';
  const headers = Object.keys(arr[0]);
  const lines = [headers.join(',')];
  arr.forEach((row) => {
    lines.push(headers.map((h) => (row[h] === undefined ? '' : String(row[h]))).join(','));
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
    default:
      throw new Error(`Unsupported source format: ${fmt}`);
  }
}

function serializeOutput(data, fmt) {
  switch (fmt) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'yaml':
      return yaml.dump(data);
    case 'csv':
      return objToCsv(data);
    case 'xml':
      return xmlBuilder.build(Array.isArray(data) ? { root: { item: data } } : data);
    default:
      throw new Error(`Unsupported target format: ${fmt}`);
  }
}

const SUPPORTED_FORMATS = ['json', 'yaml', 'csv', 'xml'];

function convert(text, from, to) {
  if (!SUPPORTED_FORMATS.includes(from)) throw new Error(`Unsupported "from" format: ${from}`);
  if (!SUPPORTED_FORMATS.includes(to)) throw new Error(`Unsupported "to" format: ${to}`);
  const parsed = parseInput(text, from);
  return serializeOutput(parsed, to);
}

module.exports = { convert, SUPPORTED_FORMATS };

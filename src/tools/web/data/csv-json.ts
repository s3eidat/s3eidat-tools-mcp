import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { deliver, outputField, pathField, READ_ONLY, readText, resultShape, textField } from './_io.js';
import { parseJsonOrThrow } from './json-studio.js';

// Ported from https://github.com/s3eidat/csv-json (app.js): same parser, delimiter detection, typing and writer.

// RFC 4180 + real-world leniency: CR, LF or CRLF line ends, "" escapes, quotes only special at field start.
export function parseCSV(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', i = 0, quoted = false, line = 1, quoteLine = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // strip BOM
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (c === '\n') line++;
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; quoteLine = line; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; line++; continue;
    }
    field += c; i++;
  }
  if (quoted) throw new ToolError('Unclosed quote that starts on line ' + quoteLine);
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 20000);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    let rows: string[][];
    try { rows = parseCSV(sample, d).slice(0, 30); } catch { rows = parseCSV(sample + '"', d).slice(0, 30); }
    if (rows.length > 1 && sample.length >= 20000) rows.pop(); // last sampled row may be cut
    const counts: Record<number, number> = {};
    let top = 0, width = 0;
    for (const r of rows) if (r.length > 1) counts[r.length] = (counts[r.length] || 0) + 1;
    for (const k of Object.keys(counts)) {
      if (counts[+k] > top || (counts[+k] === top && +k > width)) { top = counts[+k]; width = +k; }
    }
    const score = top * 1000 + width; // most rows with the same field count, then the widest
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
export function typed(v: string): unknown {
  if (v === '') return null;
  if (NUM.test(v) && v.length < 16) return Number(v); // long digit strings (IDs, cards) stay strings
  if (v === 'true' || v === 'TRUE') return true;
  if (v === 'false' || v === 'FALSE') return false;
  if (v === 'null') return null;
  return v;
}

export function headers(row: string[]): string[] {
  const seen: Record<string, boolean> = {};
  return row.map((h, i) => {
    let k = h.trim() || 'column_' + (i + 1);
    const base = k;
    let n = 2;
    while (seen[k]) k = base + '_' + n++;
    seen[k] = true;
    return k;
  });
}

export interface CsvOpts { delim: string; header: boolean; types: boolean; shape: 'objects' | 'arrays' }

export function csvToJson(text: string, o: CsvOpts) {
  const delim = o.delim === 'auto' ? detectDelimiter(text) : o.delim;
  const rows = parseCSV(text, delim), conv = o.types ? typed : (v: string) => v;
  const head = o.header && rows.length ? headers(rows.shift()!) : null;
  const width = Math.max(head ? head.length : 0, rows.reduce((m, r) => Math.max(m, r.length), 0));
  const cols = head || Array.from({ length: width }, (_, i) => 'column_' + (i + 1));
  for (let c = cols.length; c < width; c++) cols.push('column_' + (c + 1));
  const data = o.shape === 'arrays'
    ? ([] as unknown[]).concat(head ? [head] : [], rows.map((r) => r.map(conv)))
    : rows.map((r) => {
      const obj: Record<string, unknown> = {};
      cols.forEach((k, i) => { if (i < r.length || head) obj[k] = i < r.length ? conv(r[i]) : null; });
      return obj;
    });
  return { data, rows, cols, delim, ragged: rows.some((r) => r.length !== cols.length) };
}

// ---------- JSON → CSV ----------
function flatten(v: unknown, prefix: string, out: Record<string, unknown>): Record<string, unknown> {
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) { if (prefix) out[prefix] = Array.isArray(v) ? '[]' : '{}'; return out; }
    for (const k of keys) flatten((v as Record<string, unknown>)[k], prefix ? prefix + '.' + k : k, out);
    return out;
  }
  out[prefix || 'value'] = v;
  return out;
}

function cell(v: unknown, delim: string, safe: boolean) {
  let s = v == null ? '' : typeof v === 'string' ? v : String(v);
  if (safe && /^[=+\-@\t\r]/.test(s) && !NUM.test(s)) s = "'" + s; // stop Excel/Sheets running it as a formula
  return /["\r\n]|^\s|\s$/.test(s) || s.indexOf(delim) >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function jsonToCsv(data: unknown, o: { delim: string; header: boolean; safe: boolean }) {
  const delim = o.delim === 'auto' ? ',' : o.delim;
  const list = Array.isArray(data) ? data : [data], lines: string[] = [];
  let cols: string[] | null = [], table: unknown[][];
  if (list.length && list.every(Array.isArray)) {
    table = (list as unknown[][]).map((r) => r.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : x)));
    cols = null;
  } else {
    const seen: Record<string, number> = {}, flat = list.map((item) => flatten(item, '', {}));
    for (const f of flat) for (const k of Object.keys(f)) if (!seen[k]) { seen[k] = 1; cols.push(k); }
    table = flat.map((f) => cols!.map((k) => f[k]));
  }
  if (cols && o.header) lines.push(cols.map((c) => cell(c, delim, o.safe)).join(delim));
  for (const r of table) lines.push(r.map((x) => cell(x, delim, o.safe)).join(delim));
  return { csv: lines.join('\r\n') + (lines.length ? '\r\n' : ''), cols, table };
}

// ---------- tools ----------
const DELIMS = { auto: 'auto', ',': ',', ';': ';', tab: '\t', '\t': '\t', '|': '|' } as const;
const DNAME: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };
const delimField = (auto: string) =>
  z.enum(['auto', ',', ';', 'tab', '\t', '|']).optional().default('auto').describe(`Delimiter: "auto" (${auto}), ",", ";", "tab" or "|".`);

const csvToJsonTool = defineTool({
  name: 'csv_to_json',
  title: 'CSV to JSON',
  webSlug: 'csv-json',
  description:
    'Convert CSV/TSV to JSON with an RFC 4180 parser (quoted fields, "" escapes, line breaks inside quotes, CR/LF/CRLF, BOM). ' +
    'Detects the delimiter (comma, semicolon, tab, pipe), uses the first row as headers (blank → column_N, duplicates → name_2), ' +
    'and can type values (numbers, true/false, null; long digit strings like IDs stay strings). Output: array of objects or ' +
    `array of arrays, pretty-printed. Give "text" or a file "path". Web version: ${webUrl('csv-json')}`,
  inputSchema: z.object({
    text: textField('CSV'),
    path: pathField('CSV/TSV'),
    delimiter: delimField('detect'),
    header: z.boolean().optional().default(true).describe('First row is a header (default true).'),
    types: z.boolean().optional().default(true).describe('Turn numbers, true/false and empty/null into JSON types (default true).'),
    shape: z.enum(['objects', 'arrays']).optional().default('objects').describe('"objects" (one object per row) or "arrays" (rows as arrays).'),
    output: outputField(),
  }),
  outputSchema: z.object({
    rows: z.number(), columns: z.array(z.string()), delimiter: z.string(), ragged: z.boolean().describe('Some rows have a different number of fields.'),
    ...resultShape,
  }),
  annotations: READ_ONLY,
  examples: [{ input: { text: 'id,zip,ok\n1,007,true' }, output: { rows: 1, columns: ['id', 'zip', 'ok'], delimiter: 'comma', ragged: false, result: '[\n  {\n    "id": 1,\n    "zip": "007",\n    "ok": true\n  }\n]' } }],
  async run(input, ctx) {
    const text = await readText(input, ctx);
    if (!text.trim()) throw new ToolError('The CSV is empty.');
    const r = csvToJson(text, { delim: DELIMS[input.delimiter], header: input.header, types: input.types, shape: input.shape });
    const out = JSON.stringify(r.data, null, 2);
    return {
      rows: r.rows.length, columns: r.cols, delimiter: DNAME[r.delim] ?? r.delim, ragged: r.ragged,
      ...(await deliver(out, { output: input.output, defaultName: 'data.json', mimeType: 'application/json' }, ctx)),
    };
  },
});

const jsonToCsvTool = defineTool({
  name: 'json_to_csv',
  title: 'JSON to CSV',
  webSlug: 'csv-json',
  description:
    'Convert JSON to CSV. An array of objects becomes one row per object with nested objects/arrays flattened to dotted columns ' +
    '(address.city, tags.0); an array of arrays is written as-is. Fields are quoted only when needed (delimiter, quotes, line ' +
    'breaks, leading/trailing spaces); CRLF line ends. A formula guard (on by default) prefixes cells starting with = + - @ ' +
    `so spreadsheets don't run them. Give "text" or a file "path". Web version: ${webUrl('csv-json')}`,
  inputSchema: z.object({
    text: textField('JSON (array or object)'),
    path: pathField('JSON'),
    delimiter: delimField('comma'),
    header: z.boolean().optional().default(true).describe('Include a header row (default true).'),
    safe: z.boolean().optional().default(true).describe("Formula guard: prefix cells like =SUM(A1) with ' (default true)."),
    bom: z.boolean().optional().default(false).describe('Start with a UTF-8 BOM so Excel reads non-English text correctly.'),
    output: outputField(),
  }),
  outputSchema: z.object({ rows: z.number(), columns: z.array(z.string()).nullable(), ...resultShape }),
  annotations: READ_ONLY,
  examples: [{ input: { text: '[{"a":{"b":1},"s":"say \\"hi\\""}]' }, output: { rows: 1, columns: ['a.b', 's'], result: 'a.b,s\r\n1,"say ""hi"""\r\n' } }],
  async run(input, ctx) {
    const text = await readText(input, ctx);
    const data = parseJsonOrThrow(text);
    if (data === null || typeof data !== 'object') throw new ToolError('Expected a JSON array or object');
    const c = jsonToCsv(data, { delim: DELIMS[input.delimiter], header: input.header, safe: input.safe });
    return {
      rows: c.table.length, columns: c.cols,
      ...(await deliver((input.bom ? '﻿' : '') + c.csv, { output: input.output, defaultName: 'data.csv', mimeType: 'text/csv' }, ctx)),
    };
  },
});

export default [csvToJsonTool, jsonToCsvTool];

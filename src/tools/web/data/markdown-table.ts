import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { jsonToCsv } from './csv-json.js';
import { deliver, outputField, pathField, READ_ONLY, readText, resultShape, textField } from './_io.js';
import { parseJson } from './json-studio.js';

// Ported from https://github.com/s3eidat/markdown-table (app.js): Markdown writer, Markdown/CSV/TSV import.

export type Align = 'none' | 'left' | 'center' | 'right';

// width counts code points, as on the website (CJK/emoji may look off by a little in monospace; renderers don't care).
function width(s: string) { return Array.from(s).length; }
export function escCell(s: unknown) { return String(s == null ? '' : s).replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim(); }
function pad(s: string, w: number, align: Align | undefined) {
  const gap = w - width(s);
  if (gap <= 0) return s;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') { const l = Math.floor(gap / 2); return ' '.repeat(l) + s + ' '.repeat(gap - l); }
  return s + ' '.repeat(gap);
}
function sepCell(w: number, align: Align | undefined) {
  if (align === 'left') return ':' + '-'.repeat(w - 1);
  if (align === 'right') return '-'.repeat(w - 1) + ':';
  if (align === 'center') return ':' + '-'.repeat(w - 2) + ':';
  return '-'.repeat(w);
}
export function toMarkdown(rows: unknown[][], aligns: (Align | undefined)[], pretty: boolean): string {
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) => { const o: string[] = []; for (let c = 0; c < cols; c++) o.push(escCell(r[c])); return o; });
  const w: number[] = [];
  for (let c = 0; c < cols; c++) w[c] = pretty ? Math.max(3, Math.max(...cells.map((r) => width(r[c])))) : 3;
  const line = (r: string[]) => '| ' + r.map((s, c) => (pretty ? pad(s, w[c], aligns[c]) : s)).join(' | ') + ' |';
  const out = [line(cells[0]), '| ' + w.map((x, c) => sepCell(x, aligns[c])).join(' | ') + ' |'];
  for (let i = 1; i < cells.length; i++) out.push(line(cells[i]));
  return out.join('\n');
}

function splitMdRow(line: string) {
  let s = line.trim();
  if (s[0] === '|') s = s.slice(1);
  if (s.slice(-1) === '|' && s.slice(-2) !== '\\|') s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { out.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  out.push(cur.trim());
  return out.map((c) => c.replace(/<br\s*\/?>/gi, '\n'));
}
const SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
export function parseMarkdown(text: string): { rows: string[][]; aligns: Align[] } | null {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  let si = -1;
  for (let i = 1; i < lines.length; i++) if (SEP_RE.test(lines[i]) && lines[i].indexOf('-') >= 0) { si = i; break; }
  if (si !== 1) return null;
  const aligns = splitMdRow(lines[1]).map((c): Align => {
    const l = c[0] === ':', r = c.slice(-1) === ':';
    return l && r ? 'center' : r ? 'right' : l ? 'left' : 'none';
  });
  const rows = [splitMdRow(lines[0])].concat(lines.slice(2).map(splitMdRow));
  return { rows, aligns };
}
export function detectDelim(text: string) {
  const first = String(text).split(/\r?\n/)[0] || '';
  if (first.indexOf('\t') >= 0) return '\t';
  const bare = first.replace(/"[^"]*"/g, '');
  return bare.split(';').length > bare.split(',').length ? ';' : ',';
}
export function parseCSV(text: string, delim?: string): string[][] {
  const rows: string[][] = [], s = String(text);
  let row: string[] = [], cur = '', q = false;
  delim = delim || detectDelim(s);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"' && cur === '') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
export function parseAny(text: string): { rows: string[][]; aligns: Align[] } {
  const md = parseMarkdown(text);
  if (md) return md;
  return { rows: parseCSV(text), aligns: [] };
}
export function normalize(rows: string[][], aligns: Align[]) {
  const cols = Math.max(1, Math.max(...rows.map((r) => r.length).concat([0])));
  rows = rows.map((r) => { const o = r.slice(); while (o.length < cols) o.push(''); return o; });
  if (!rows.length) rows = [new Array(cols).fill('')];
  const a: Align[] = [];
  for (let c = 0; c < cols; c++) a.push(aligns[c] || 'none');
  return { rows, aligns: a };
}

/** JSON rows: array of arrays, or array of objects (keys in first-seen order become the header). */
function jsonRows(data: unknown): string[][] | null {
  if (!Array.isArray(data) || !data.length) return null;
  const str = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (data.every(Array.isArray)) return (data as unknown[][]).map((r) => r.map(str));
  if (data.every((x) => x && typeof x === 'object')) {
    const cols: string[] = [], seen = new Set<string>();
    for (const o of data as Record<string, unknown>[]) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    return [cols, ...(data as Record<string, unknown>[]).map((o) => cols.map((k) => str(o[k])))];
  }
  return null;
}

const alignEnum = z.enum(['none', 'left', 'center', 'right']);

const markdownTable = defineTool({
  name: 'markdown_table',
  title: 'Markdown table',
  webSlug: 'markdown-table',
  description:
    'Make a GitHub-flavoured Markdown table from CSV, TSV, a JSON array (of objects or of arrays), an existing Markdown table ' +
    '(to re-align / re-pad it) or a "rows" array. Per-column alignment (left, center, right), columns padded to line up ' +
    '(optional), pipes escaped as \\| and line breaks as <br>. CSV delimiter (comma, semicolon, tab) is detected from the ' +
    `first line. Give "text", a file "path" or "rows". Web version: ${webUrl('markdown-table')}`,
  inputSchema: z.object({
    text: textField('CSV / TSV / JSON / Markdown table'),
    path: pathField('CSV/TSV/JSON/Markdown'),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional().describe('Or: the table as an array of rows (first row = header unless header is false).'),
    format: z.enum(['auto', 'csv', 'tsv', 'json', 'markdown']).optional().default('auto').describe('Input format; "auto" detects Markdown, then JSON, then CSV/TSV.'),
    header: z.boolean().optional().default(true).describe('First row is the header. When false, "Column 1", "Column 2"… headers are added.'),
    align: z.union([alignEnum, z.array(alignEnum)]).optional().describe('Column alignment: one value for all columns or one per column. Default: keep a Markdown input\'s alignment, else none.'),
    pretty: z.boolean().optional().default(true).describe('Pad cells so the columns line up (default true).'),
    output: outputField(),
  }),
  outputSchema: z.object({ columns: z.number(), rows: z.number().describe('Body rows (without the header).'), ...resultShape }),
  annotations: READ_ONLY,
  examples: [{ input: { text: 'Name,Qty\nApple,3', align: ['left', 'right'] }, output: { columns: 2, rows: 1, result: '| Name  | Qty |\n| :---- | --: |\n| Apple |   3 |' } }],
  async run(input, ctx) {
    let t: { rows: string[][]; aligns: Align[] };
    let isMd = false;
    if (input.rows) {
      t = { rows: input.rows.map((r) => r.map((v) => (v == null ? '' : String(v)))), aligns: [] };
    } else {
      const text = (await readText(input, ctx)).replace(/\r?\n$/, '');
      if (!text.trim()) throw new ToolError('The input is empty.');
      const f = input.format;
      const md = f === 'auto' || f === 'markdown' ? parseMarkdown(text) : null;
      if (md) { t = md; isMd = true; }
      else if (f === 'markdown') throw new ToolError('No Markdown table found: the second line must be a separator like | --- | :-: |.');
      else {
        let json: string[][] | null = null;
        if (f === 'json' || (f === 'auto' && /^\s*\[/.test(text))) {
          const r = parseJson(text);
          if (r.ok) json = jsonRows(r.data);
          if (f === 'json' && !json) throw new ToolError(r.ok ? 'Expected a JSON array of objects or of arrays.' : 'Invalid JSON: ' + r.error);
        }
        t = json ? { rows: json, aligns: [] } : { rows: parseCSV(text, f === 'tsv' ? '\t' : undefined), aligns: [] };
      }
    }
    let rows = t.rows;
    if (!rows.length) throw new ToolError('No rows found.');
    if (!input.header && !isMd) rows = [rows[0].map((_, i) => 'Column ' + (i + 1))].concat(rows);
    let aligns = t.aligns;
    if (input.align) aligns = typeof input.align === 'string' ? rows[0].map(() => input.align as Align) : input.align;
    const n = normalize(rows, aligns);
    const md = toMarkdown(n.rows, n.aligns, input.pretty);
    return { columns: n.rows[0].length, rows: n.rows.length - 1, ...(await deliver(md, { output: input.output, defaultName: 'table.md', mimeType: 'text/markdown' }, ctx)) };
  },
});

const markdownTableParse = defineTool({
  name: 'markdown_table_parse',
  title: 'Markdown table to JSON / CSV',
  webSlug: 'markdown-table',
  description:
    'Read a Markdown table (pipes optional at the ends, \\| escapes, <br> as line breaks) back into data: JSON objects keyed by ' +
    'the header, JSON arrays, or CSV; also returns each column\'s alignment. Uses the website\'s Markdown import. ' +
    `Give "text" or a file "path". Web version: ${webUrl('markdown-table')}`,
  inputSchema: z.object({
    text: textField('Markdown table'),
    path: pathField('Markdown'),
    as: z.enum(['objects', 'arrays', 'csv']).optional().default('objects').describe('"objects" (header → keys), "arrays" (header row first) or "csv".'),
    output: outputField(),
  }),
  outputSchema: z.object({
    columns: z.array(z.string()), aligns: z.array(alignEnum), rows: z.number(),
    data: z.array(z.unknown()).optional().describe('The rows (JSON formats, when not written to a file).'),
    ...resultShape,
  }),
  annotations: READ_ONLY,
  examples: [{ input: { text: '| Name | Qty |\n| :-- | --: |\n| Apple | 3 |' }, output: { columns: ['Name', 'Qty'], aligns: ['left', 'right'], rows: 1, data: [{ Name: 'Apple', Qty: '3' }] } }],
  async run(input, ctx) {
    const text = await readText(input, ctx);
    const md = parseMarkdown(text);
    if (!md) throw new ToolError('No Markdown table found: the first line must be the header and the second a separator like | --- | :-: |.');
    const n = normalize(md.rows, md.aligns);
    const [head, ...body] = n.rows;
    const base = { columns: head, aligns: n.aligns, rows: body.length };
    if (input.as === 'csv') {
      const csv = jsonToCsv(n.rows, { delim: ',', header: false, safe: false }).csv;
      return { ...base, ...(await deliver(csv, { output: input.output, defaultName: 'table.csv', mimeType: 'text/csv' }, ctx)) };
    }
    const data = input.as === 'arrays' ? n.rows : body.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
    if (input.output) return { ...base, ...(await deliver(JSON.stringify(data, null, 2), { output: input.output, defaultName: 'table.json', mimeType: 'application/json' }, ctx)) };
    return { ...base, data };
  },
});

export default [markdownTable, markdownTableParse];

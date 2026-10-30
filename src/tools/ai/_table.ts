/**
 * Shared table helpers for the ai_* data tools: load a table from inline CSV/JSON or a file (CSV, TSV, JSON array,
 * JSONL, .xlsx), infer cell types, and write a result table back out as CSV, JSON, JSONL or XLSX.
 */
import { extname } from 'node:path';
import { z } from 'zod';
import { ToolError, type ToolContext } from '../../registry.js';
import { readInput, writeOutput } from '../../util/files.js';
import { detectDelimiter, headers, jsonToCsv, parseCSV } from '../web/data/csv-json.js';

export type Row = Record<string, unknown>;
export interface Table {
  columns: string[];
  rows: Row[];
  /** What the source was parsed as: csv, tsv, json, jsonl or xlsx. */
  format: string;
  /** Sheet name, for xlsx input. */
  sheet?: string;
}

export const FORMATS = ['auto', 'csv', 'tsv', 'json', 'jsonl', 'xlsx'] as const;
export type Format = (typeof FORMATS)[number];

/** Zod fields describing one table source; spread into a tool's schema. */
export const tableSourceFields = {
  file: z.string().optional().describe('A table file: local path (absolute, or relative to --root) or base64. CSV, TSV, JSON array, JSONL or .xlsx.'),
  csv: z.string().optional().describe('Or: CSV/TSV text inline (delimiter detected; first row is the header).'),
  json: z.union([z.string(), z.array(z.unknown())]).optional()
    .describe('Or: JSON inline: an array of objects (or of arrays, first one the header), as a value or as JSON/JSONL text.'),
  sheet: z.string().optional().describe('For .xlsx: the sheet name to read (default: the first sheet).'),
  format: z.enum(FORMATS).optional().default('auto').describe('Force the file format (default "auto": by extension, then by content).'),
};

export interface TableSource {
  file?: string;
  csv?: string;
  json?: string | unknown[];
  sheet?: string;
  format?: Format;
}

// ---------- value typing ----------
const NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATETIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$/;

export type CellType = 'null' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'string' | 'object' | 'array';

/** Type a raw text cell: numbers, true/false, ISO dates kept as ISO text; empty → null. Long digit strings stay text. */
export function inferValue(v: string): unknown {
  if (v === '' || v === 'null' || v === 'NULL') return null;
  if (NUM.test(v) && v.length < 16) return Number(v);
  if (v === 'true' || v === 'TRUE' || v === 'True') return true;
  if (v === 'false' || v === 'FALSE' || v === 'False') return false;
  return v;
}

export function isDateText(s: string): 'date' | 'datetime' | null {
  if (DATE.test(s)) return 'date';
  if (DATETIME.test(s)) return 'datetime';
  return null;
}

/** Type of a cell as it would look once inferred (strings that look like numbers count as numbers). */
export function cellType(v: unknown): CellType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v instanceof Date) return 'datetime';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  const s = String(v).trim();
  if (s === '') return 'null';
  const t = inferValue(s);
  if (typeof t === 'number') return Number.isInteger(t) ? 'integer' : 'number';
  if (typeof t === 'boolean') return 'boolean';
  if (t === null) return 'null';
  return isDateText(s) ?? 'string';
}

// ---------- loading ----------
function fromObjects(list: unknown[], format: string): Table {
  if (!list.length) return { columns: [], rows: [], format };
  if (list.every(Array.isArray)) {
    const [head, ...body] = list as unknown[][];
    const columns = headers(head.map((h) => (h == null ? '' : String(h))));
    const width = Math.max(columns.length, ...body.map((r) => r.length));
    for (let c = columns.length; c < width; c++) columns.push('column_' + (c + 1));
    return { columns, rows: body.map((r) => Object.fromEntries(columns.map((k, i) => [k, r[i] ?? null]))), format };
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: Row[] = list.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      if (item === null || typeof item !== 'object') return { value: item };
      throw new ToolError(`Row ${i + 1} is an array but other rows are objects.`);
    }
    return item as Row;
  });
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((k) => [k, r[k] ?? null]))), format };
}

function parseJsonTable(text: string): Table {
  const t = text.trim();
  if (!t) throw new ToolError('The JSON input is empty.');
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return fromObjects(v, 'json');
    if (v && typeof v === 'object') {
      // { "rows": [...] } style wrappers: take the only array property.
      const arrays = Object.values(v).filter(Array.isArray);
      if (arrays.length === 1) return fromObjects(arrays[0] as unknown[], 'json');
      return fromObjects([v], 'json');
    }
    throw new ToolError('Expected a JSON array of rows.');
  } catch (e) {
    if (e instanceof ToolError) throw e;
    // JSON Lines: one value per line.
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    const out: unknown[] = [];
    lines.forEach((l, i) => {
      try { out.push(JSON.parse(l)); } catch (err) {
        throw new ToolError(lines.length > 1 ? `JSONL line ${i + 1}: ${(err as Error).message}` : `Invalid JSON: ${(err as Error).message}`);
      }
    });
    return fromObjects(out, 'jsonl');
  }
}

function parseCsvTable(text: string, types: boolean, delim?: string): Table {
  const d = delim ?? detectDelimiter(text);
  const raw = parseCSV(text, d).filter((r) => !(r.length === 1 && r[0] === ''));
  if (!raw.length) return { columns: [], rows: [], format: d === '\t' ? 'tsv' : 'csv' };
  const columns = headers(raw.shift()!);
  const width = Math.max(columns.length, ...raw.map((r) => r.length));
  for (let c = columns.length; c < width; c++) columns.push('column_' + (c + 1));
  const conv = types ? inferValue : (v: string) => v;
  const rows = raw.map((r) => Object.fromEntries(columns.map((k, i) => [k, i < r.length ? conv(r[i]) : null])));
  return { columns, rows, format: d === '\t' ? 'tsv' : 'csv' };
}

function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o || 'formula' in o || 'sharedFormula' in o) return cellValue(o.result ?? null);
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((p) => p.text).join('');
    if ('text' in o && 'hyperlink' in o) return cellValue(o.text);
    if ('error' in o) return String(o.error);
    return JSON.stringify(o);
  }
  return v;
}

/** Read one sheet of an .xlsx workbook as a table (first row = header). */
export async function readXlsx(bytes: Buffer, sheetName: string | undefined, types: boolean): Promise<Table> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch (e) {
    throw new ToolError(`Could not read the .xlsx file: ${(e as Error).message}`);
  }
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) {
    throw new ToolError(sheetName ? `No sheet named "${sheetName}". Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}` : 'The workbook has no sheets.');
  }
  const matrix: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = row.values as unknown[]; // 1-based
    matrix[n - 1] = vals.slice(1).map(cellValue);
  });
  for (let i = 0; i < matrix.length; i++) if (!matrix[i]) matrix[i] = [];
  while (matrix.length && matrix[matrix.length - 1].every((v) => v == null || v === '')) matrix.pop();
  if (!matrix.length) return { columns: [], rows: [], format: 'xlsx', sheet: ws.name };
  const head = matrix.shift()!;
  const columns = headers(head.map((h) => (h == null ? '' : String(h))));
  const width = Math.max(columns.length, ...matrix.map((r) => r.length));
  for (let c = columns.length; c < width; c++) columns.push('column_' + (c + 1));
  const rows = matrix.map((r) => Object.fromEntries(columns.map((k, i) => {
    const v = r[i] ?? null;
    return [k, types || v === null ? v : String(v)];
  })));
  return { columns, rows, format: 'xlsx', sheet: ws.name };
}

function guessFormat(name: string, bytes: Buffer): Exclude<Format, 'auto'> {
  const ext = extname(name).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.tsv' || ext === '.tab') return 'tsv';
  if (ext === '.json') return 'json';
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.csv') return 'csv';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  const head = bytes.subarray(0, 200).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  return 'csv';
}

/**
 * Load a table from a source. With `types` (default true) CSV cells are typed (numbers, booleans, null; ISO dates stay
 * ISO text); with `types: false` CSV cells stay raw strings (JSON/XLSX values keep their own types).
 */
export async function loadTable(src: TableSource, ctx: ToolContext, opts: { types?: boolean; label?: string } = {}): Promise<Table> {
  const types = opts.types ?? true;
  const label = opts.label ?? 'table';
  const given = [src.file, src.csv, src.json].filter((v) => v !== undefined).length;
  if (given === 0) throw new ToolError(`${label}: give one of "file", "csv" or "json".`);
  if (given > 1) throw new ToolError(`${label}: give only one of "file", "csv" or "json".`);
  const fmt = src.format ?? 'auto';
  if (src.csv !== undefined) return parseCsvTable(src.csv.replace(/^﻿/, ''), types, fmt === 'tsv' ? '\t' : undefined);
  if (src.json !== undefined) return typeof src.json === 'string' ? parseJsonTable(src.json) : fromObjects(src.json, 'json');
  const f = await readInput(src.file!, ctx, label);
  const kind = fmt === 'auto' ? guessFormat(f.name, f.bytes) : fmt;
  if (kind === 'xlsx') return readXlsx(f.bytes, src.sheet, types);
  const text = f.bytes.toString('utf8').replace(/^﻿/, '');
  if (kind === 'json' || kind === 'jsonl') return parseJsonTable(text);
  return parseCsvTable(text, types, kind === 'tsv' ? '\t' : undefined);
}

// ---------- writing ----------
/** Turn a cell into something a spreadsheet cell can hold. */
export function flatCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export async function xlsxBuffer(columns: string[], rows: Row[], sheetName = 'Sheet1'): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Sheet1', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.min(60, Math.max(8, c.length + 2, ...rows.slice(0, 200).map((r) => String(flatCell(r[c]) ?? '').length + 2))) }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c) => [c, flatCell(r[c])])));
  if (columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Write a table to `output`, choosing CSV, TSV, JSON, JSONL or XLSX from its extension (default CSV). */
export async function writeTable(columns: string[], rows: Row[], output: string, ctx: ToolContext, defaultName = 'result.csv') {
  const ext = extname(output.replace(/[\\/]$/, '')).toLowerCase();
  const isDir = /[\\/]$/.test(output);
  const kind = isDir ? extname(defaultName).toLowerCase() : ext || '.csv';
  const name = defaultName;
  const plain = rows.map((r) => Object.fromEntries(columns.map((c) => [c, flatCell(r[c])])));
  switch (kind) {
    case '.json':
      return writeOutput(JSON.stringify(rows, null, 2), { output, defaultName: name, mimeType: 'application/json' }, ctx);
    case '.jsonl':
    case '.ndjson':
      return writeOutput(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { output, defaultName: name, mimeType: 'application/x-ndjson' }, ctx);
    case '.xlsx':
      return writeOutput(await xlsxBuffer(columns, rows), { output, defaultName: name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, ctx);
    case '.csv':
    case '.tsv':
    case '.txt': {
      const delim = kind === '.tsv' ? '\t' : ',';
      const head = columns.map((c) => (/["\r\n]/.test(c) || c.includes(delim) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(delim);
      const body = jsonToCsv(plain.map((r) => columns.map((c) => (r[c] instanceof Date ? (r[c] as Date).toISOString() : r[c]))), { delim, header: false, safe: true }).csv;
      return writeOutput(head + '\r\n' + body, { output, defaultName: name, mimeType: 'text/csv' }, ctx);
    }
    default:
      throw new ToolError(`Unsupported output type "${kind}": use .csv, .tsv, .json, .jsonl or .xlsx.`);
  }
}

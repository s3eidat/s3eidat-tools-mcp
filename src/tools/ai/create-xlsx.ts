import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import { fileOutputShape, outputPath, returnBase64, writeOutput } from '../../util/files.js';

// Friendly names for common Excel number formats.
const NUMFMT_ALIASES: Record<string, string> = {
  integer: '#,##0',
  number: '#,##0.00',
  decimal: '#,##0.00',
  percent: '0.00%',
  currency: '"$"#,##0.00',
  usd: '"$"#,##0.00',
  eur: '[$€-x-euro2] #,##0.00',
  gbp: '"£"#,##0.00',
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm',
  time: 'hh:mm:ss',
  text: '@',
};
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_DATETIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/;
const TOTALS = ['sum', 'average', 'count', 'min', 'max', 'none'] as const;
const TOTAL_FN: Record<string, string> = { sum: 'SUM', average: 'AVERAGE', count: 'COUNTA', min: 'MIN', max: 'MAX' };

export function colLetter(n: number) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const columnSchema = z.object({
  header: z.string().describe('Header text.'),
  key: z.string().optional().describe('Property name in object rows (default: the header).'),
  width: z.number().min(1).max(255).optional().describe('Column width in characters (default: fitted to the content).'),
  numFmt: z.string().optional().describe('Excel number format, e.g. "#,##0.00", "0%", "yyyy-mm-dd", or an alias: integer, number, percent, currency, usd, eur, gbp, date, datetime, time, text.'),
});

const sheetSchema = z.object({
  name: z.string().min(1).describe('Sheet name (max 31 characters; []:*?/\\ are replaced).'),
  columns: z.array(columnSchema).optional().describe('Column definitions. Default: keys of the object rows, or the first array row as headers.'),
  rows: z.array(z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())])).describe(
    'Rows as objects (matched to columns by key) or arrays (by position). Strings starting with "=" are written as formulas ' +
    '(e.g. "=B2*C2"); start with "\'=" to store literal text. ISO dates ("2026-10-30", "2026-10-30T09:00") become real dates.',
  ),
  freezeHeader: z.boolean().optional().default(true).describe('Freeze the header row (default true).'),
  autoFilter: z.boolean().optional().default(true).describe('Add filter buttons to the header (default true).'),
  totalsRow: z.union([z.boolean(), z.record(z.string(), z.enum(TOTALS))]).optional().describe(
    'Add a totals row under the data: true = SUM of every numeric column, or { "<header or key>": "sum"|"average"|"count"|"min"|"max"|"none" }.',
  ),
});

type SheetIn = z.infer<typeof sheetSchema>;

function sheetName(raw: string, used: Set<string>) {
  let n = raw.replace(/[[\]:*?/\\]/g, '-').replace(/^'+|'+$/g, '').slice(0, 31).trim() || 'Sheet';
  const base = n;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 31 - String(i).length - 1)}-${i}`;
  used.add(n.toLowerCase());
  return n;
}

/** Turn a JSON value into what exceljs should write in the cell. */
function cellValue(v: unknown, parseDates: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (v.startsWith("'=")) return v.slice(1);
    if (v.startsWith('=') && v.length > 1) return { formula: v.slice(1) };
    if (parseDates && ISO_DATE.test(v)) return new Date(v + 'T00:00:00Z');
    if (parseDates && ISO_DATETIME.test(v)) {
      const hasZone = /(Z|[+-]\d\d:?\d\d)$/.test(v);
      const d = new Date(hasZone ? v : v.replace(' ', 'T') + 'Z');
      return isNaN(+d) ? v : d;
    }
    return v;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function textWidth(v: unknown, numFmt?: string): number {
  if (v === null || v === undefined) return 0;
  if (v instanceof Date) return numFmt && /h/.test(numFmt) ? 16 : 10;
  if (typeof v === 'object') return 10; // formula
  if (typeof v === 'number') return Math.min(20, v.toLocaleString('en-US', { maximumFractionDigits: 2 }).length + 1);
  return Math.max(...String(v).split('\n').map((l) => l.length));
}

export default defineTool({
  name: 'ai_create_xlsx',
  title: 'Create an Excel workbook (.xlsx)',
  description:
    'Build a real Excel .xlsx file from data: one or more sheets, each with optional column definitions (header, key, width, ' +
    'numFmt) and rows given as objects or arrays. Bold shaded header, frozen header row and filter buttons (both on by default), ' +
    'column widths fitted to the content, Excel number formats (raw codes like "#,##0.00" or aliases: integer, number, percent, ' +
    'currency, usd, eur, gbp, date, datetime, time, text), strings starting with "=" written as live formulas (=SUM(B2:B9), ' +
    '=B2*C2, cross-sheet refs), ISO date strings written as real dates, and an optional totals row (SUM/AVERAGE/COUNT/MIN/MAX ' +
    'formulas). Up to 50 sheets and 1,000,000 rows per sheet. Formulas are calculated by Excel when the file is opened. Writes ' +
    'to "output" (default "workbook.xlsx" in the output folder) and returns the path and a summary of each sheet.',
  inputSchema: z.object({
    sheets: z.array(sheetSchema).min(1).max(50),
    parseDates: z.boolean().optional().default(true).describe('Write ISO date strings as Excel dates (default true).'),
    title: z.string().optional().describe('Workbook title (file properties, and the default file name).'),
    author: z.string().optional().describe('Author in the file properties.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...fileOutputShape,
    sheets: z.array(z.object({ name: z.string(), rows: z.number(), columns: z.array(z.string()), range: z.string(), formulas: z.number() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: {
      sheets: [{
        name: 'Orders',
        columns: [{ header: 'Item' }, { header: 'Qty', numFmt: 'integer' }, { header: 'Price', numFmt: 'usd' }, { header: 'Total', numFmt: 'usd' }],
        rows: [['Pen', 3, 1.5, '=B2*C2'], ['Book', 1, 12, '=B3*C3']],
        totalsRow: { Qty: 'sum', Total: 'sum' },
      }],
    },
    output: { sheets: [{ name: 'Orders', rows: 2, columns: ['Item', 'Qty', 'Price', 'Total'], range: 'A1:D4', formulas: 4 }] },
  }],
  async run(input, ctx) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = input.author ?? 'S3eidat Tools';
    if (input.title) wb.title = input.title;
    wb.calcProperties.fullCalcOnLoad = true;
    const used = new Set<string>();
    const summary = [];

    for (const s of input.sheets as SheetIn[]) {
      if (s.rows.length > 1_000_000) throw new ToolError(`Sheet "${s.name}" has ${s.rows.length} rows; the limit is 1,000,000.`);
      const name = sheetName(s.name, used);
      let rows = s.rows;
      let cols = s.columns?.map((c) => ({ ...c, key: c.key ?? c.header }));
      if (!cols) {
        if (rows.length && rows.every(Array.isArray)) {
          const head = rows[0] as unknown[];
          cols = head.map((h, i) => ({ header: h == null || h === '' ? `Column ${i + 1}` : String(h), key: String(i) }));
          rows = rows.slice(1);
        } else {
          const keys: string[] = [];
          for (const r of rows) if (!Array.isArray(r)) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
          cols = keys.map((k) => ({ header: k, key: k }));
        }
      }
      const width = Math.max(cols.length, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
      for (let i = cols.length; i < width; i++) cols.push({ header: `Column ${i + 1}`, key: String(i) });
      const fmts = cols.map((c) => (c.numFmt ? NUMFMT_ALIASES[c.numFmt.toLowerCase()] ?? c.numFmt : undefined));

      const ws = wb.addWorksheet(name, s.freezeHeader ? { views: [{ state: 'frozen', ySplit: 1 }] } : {});
      const header = ws.getRow(1);
      cols.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
      header.font = { bold: true };
      header.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
      });

      const widths = cols.map((c) => c.header.length);
      const numeric = cols.map(() => 0);
      let formulas = 0;
      rows.forEach((r, ri) => {
        const row = ws.getRow(ri + 2);
        cols!.forEach((c, ci) => {
          const raw = Array.isArray(r) ? r[ci] : (r as Record<string, unknown>)[c.key];
          const v = cellValue(raw, input.parseDates);
          if (v === null) return;
          const cell = row.getCell(ci + 1);
          cell.value = v as never;
          if (v && typeof v === 'object' && 'formula' in v) formulas++;
          if (typeof v === 'number') numeric[ci]++;
          if (fmts[ci]) cell.numFmt = fmts[ci]!;
          else if (v instanceof Date) cell.numFmt = (raw as string).length > 10 ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd';
          widths[ci] = Math.max(widths[ci], textWidth(v, fmts[ci]));
        });
      });

      // Totals row.
      let last = rows.length + 1;
      if (s.totalsRow && rows.length) {
        const plan: Record<number, string> = {};
        if (s.totalsRow === true) cols.forEach((_, ci) => { if (numeric[ci]) plan[ci] = 'sum'; });
        else {
          for (const [k, fn] of Object.entries(s.totalsRow)) {
            const ci = cols.findIndex((c) => c.key === k || c.header === k);
            if (ci < 0) throw new ToolError(`totalsRow: no column "${k}" in sheet "${name}".`);
            if (fn !== 'none') plan[ci] = fn;
          }
        }
        const tr = ws.getRow(rows.length + 2);
        for (const [ci, fn] of Object.entries(plan)) {
          const L = colLetter(+ci + 1);
          const cell = tr.getCell(+ci + 1);
          cell.value = { formula: `${TOTAL_FN[fn]}(${L}2:${L}${rows.length + 1})` };
          formulas++;
          if (fmts[+ci]) cell.numFmt = fmts[+ci]!;
        }
        if (plan[0] === undefined) tr.getCell(1).value = 'Total';
        tr.font = { bold: true };
        tr.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FF999999' } } }; });
        last = rows.length + 2;
      }

      cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? Math.min(60, Math.max(8, widths[i] + 2)); });
      const lastCol = colLetter(Math.max(1, cols.length));
      if (s.autoFilter && cols.length) ws.autoFilter = `A1:${lastCol}1`;
      summary.push({ name, rows: rows.length, columns: cols.map((c) => c.header), range: `A1:${lastCol}${last}`, formulas });
    }

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const w = await writeOutput(buf, {
      output: input.output,
      defaultName: (input.title ? input.title.slice(0, 80) : 'workbook') + '.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: input.returnBase64,
    }, ctx);
    return { ...w, sheets: summary };
  },
});

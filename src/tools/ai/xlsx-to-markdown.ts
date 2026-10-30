import { Readable } from 'node:stream';
import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { fileInput, readInput } from '../../util/files.js';
import { ToolError } from '../../util/errors.js';
import { cell, emitMarkdown, maxCharsInput, mdOutputInput, mdOutputShape, mdTable, stemOf } from './_md.js';

type ExcelJS = typeof import('exceljs');
type Worksheet = import('exceljs').Worksheet;

/** Excel dates carry no time zone: show the stored wall-clock value, date only when there's no time part. */
export function isoDate(d: Date) {
  if (Number.isNaN(d.getTime())) return '';
  const s = d.toISOString();
  if (s.endsWith('T00:00:00.000Z')) return s.slice(0, 10);
  return s.replace(/\.000Z$/, '').replace(/Z$/, '');
}

/** A cell value as text: formulas show their cached result, rich text is joined, hyperlinks become Markdown links. */
export function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return isoDate(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      if (o.result !== undefined && o.result !== null) return cellText(o.result);
      return '=' + String(o.formula ?? o.sharedFormula ?? '');
    }
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('hyperlink' in o) {
      const text = cellText(o.text) || String(o.hyperlink);
      return /^(https?|mailto):/i.test(String(o.hyperlink)) ? `[${text}](${String(o.hyperlink).replace(/[()\s]/g, encodeURIComponent)})` : text;
    }
    if ('error' in o) return String(o.error);
    if ('text' in o) return cellText(o.text);
  }
  return String(v);
}

interface SheetInfo { name: string; rows: number; columns: number; shownRows: number; omittedRows: number; hidden?: boolean }

function sheetTable(ws: Worksheet, maxRows: number): { info: SheetInfo; md: string } {
  const grid = new Map<number, Map<number, string>>();
  let minC = Infinity, maxC = 0;
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    row.eachCell({ includeEmpty: false }, (c, col) => {
      // Merged areas: show the value once, in the top-left cell.
      if (c.isMerged && c.master && c.master.address !== c.address) return;
      const t = cellText(c.value);
      if (!t.trim()) return;
      if (!grid.has(r)) grid.set(r, new Map());
      grid.get(r)!.set(col, t);
      minC = Math.min(minC, col);
      maxC = Math.max(maxC, col);
    });
  });
  const rowNums = [...grid.keys()].sort((a, b) => a - b);
  const info: SheetInfo = { name: ws.name, rows: rowNums.length, columns: rowNums.length ? maxC - minC + 1 : 0, shownRows: 0, omittedRows: 0 };
  if (ws.state && ws.state !== 'visible') info.hidden = true;
  if (!rowNums.length) return { info, md: '_(empty sheet)_' };
  const dataRows = rowNums.length - 1;
  const shown = rowNums.slice(0, 1 + Math.min(maxRows, dataRows));
  info.shownRows = shown.length;
  info.omittedRows = rowNums.length - shown.length;
  const rows = shown.map((r) => Array.from({ length: maxC - minC + 1 }, (_, i) => cell(grid.get(r)!.get(minC + i) ?? '')));
  let md = mdTable(rows);
  if (info.omittedRows) md += `\n\n_${info.omittedRows} more row${info.omittedRows === 1 ? '' : 's'} not shown (maxRows ${maxRows})._`;
  return { info, md };
}

function sniffDelimiter(text: string) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length - 1] as const).sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export default defineTool({
  name: 'ai_xlsx_to_markdown',
  title: 'Excel (.xlsx/.csv) to Markdown tables',
  description:
    'Turn an Excel .xlsx workbook (or a .csv/.tsv file) into Markdown tables, one "## sheet" section per sheet, or only the ' +
    'sheet you name. The first used row is the table header; empty rows and columns around the data are dropped. Formulas ' +
    'show their cached result (as last saved by Excel), dates are ISO (2026-10-30, or 2026-10-30T14:05:00), merged cells ' +
    'show their value once, hyperlinks become Markdown links. Each sheet shows at most maxRows data rows (default 200) and ' +
    'says how many were left out. Old binary .xls is not supported. Accepts a local path or base64. Runs locally.',
  inputSchema: z.object({
    file: fileInput('.xlsx or .csv file'),
    sheet: z.string().optional().describe('Only this sheet: its name, or its 1-based position (e.g. "2"). Default: every sheet.'),
    maxRows: z.number().int().min(1).max(100000).optional().default(200).describe('Data rows to show per sheet (after the header). Default 200.'),
    format: z.enum(['auto', 'xlsx', 'csv']).optional().default('auto').describe('Input format. "auto" tells .xlsx (a ZIP) from CSV by its bytes.'),
    maxChars: maxCharsInput(),
    output: mdOutputInput(),
  }),
  outputSchema: z.object({
    sheets: z.array(z.object({
      name: z.string(), rows: z.number().describe('Non-empty rows, header included.'), columns: z.number(),
      shownRows: z.number(), omittedRows: z.number(), hidden: z.boolean().optional(),
    })),
    sheetNames: z.array(z.string()).describe('Every sheet in the workbook, in order.'),
    ...mdOutputShape,
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'budget.xlsx' } }, { input: { file: 'sales.xlsx', sheet: 'Q3', maxRows: 50 } }, { input: { file: 'contacts.csv' } }],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, 'spreadsheet');
    const isZip = f.bytes[0] === 0x50 && f.bytes[1] === 0x4b;
    if (f.bytes[0] === 0xd0 && f.bytes[1] === 0xcf) throw new ToolError('This is an old binary .xls file; only .xlsx and .csv are supported. Save it as .xlsx first.');
    const fmt = input.format === 'auto' ? (isZip ? 'xlsx' : 'csv') : input.format;
    const mod = (await import('exceljs')) as ExcelJS & { default?: ExcelJS };
    const Excel = mod.default ?? mod;
    const wb = new Excel.Workbook();
    try {
      if (fmt === 'xlsx') {
        if (!isZip) throw new Error('not a ZIP package');
        await wb.xlsx.load(f.bytes as unknown as ArrayBuffer);
      } else {
        const text = f.bytes.toString('utf8').replace(/^\uFEFF/, '');
        await wb.csv.read(Readable.from([text]), {
          sheetName: stemOf(f, 'Sheet1'),
          map: (v: unknown) => v, // keep CSV values as written (no number/date guessing)
          parserOptions: { delimiter: sniffDelimiter(text) },
        });
      }
    } catch (e) {
      throw new ToolError(`The ${fmt === 'xlsx' ? '.xlsx' : 'CSV'} file could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const all = wb.worksheets;
    const sheetNames = all.map((w) => w.name);
    let picked = all;
    if (input.sheet) {
      const n = /^\d+$/.test(input.sheet.trim()) ? Number(input.sheet) : NaN;
      const ws = all.find((w) => w.name === input.sheet) ?? all.find((w) => w.name.toLowerCase() === input.sheet!.toLowerCase().trim()) ?? (n >= 1 ? all[n - 1] : undefined);
      if (!ws) throw new ToolError(`No sheet "${input.sheet}". Sheets: ${sheetNames.map((s) => `"${s}"`).join(', ')}.`);
      picked = [ws];
    }
    const parts: string[] = [];
    const sheets: SheetInfo[] = [];
    for (const ws of picked) {
      const { info, md } = sheetTable(ws, input.maxRows);
      sheets.push(info);
      parts.push(`## ${ws.name.replace(/[#*_[\]]/g, '\\$&')}${info.hidden ? ' (hidden)' : ''}\n\n${md}`);
    }
    const markdown = parts.join('\n\n') + '\n';
    const out = await emitMarkdown(markdown, { output: input.output, maxChars: input.maxChars, defaultName: stemOf(f, 'workbook') + '.md' }, ctx);
    return { sheets, sheetNames, ...out };
  },
});

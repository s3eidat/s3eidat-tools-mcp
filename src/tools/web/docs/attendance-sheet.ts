import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, returnBase64 } from '../../../util/files.js';
import { Draw, MM, newDoc, pdfOutputShape, savePdf, userText } from './_pdf.js';

// Port of https://github.com/s3eidat/attendance-sheet (app.js): date columns as whole UTC days (month, sessions or
// blank), skipped weekdays, the page geometry in mm (columns that don't fit continue on the next page, same names),
// header, footer with signature line and page numbers, tick boxes or signature cells. English labels.
const PAPER: Record<string, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4] };
const MARGIN = 10, HEAD = 17, THEAD = 10, FOOT = 9; // mm
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const T = { title: 'Attendance', name: 'Name', num: '#', total: 'Total', page: 'Page', of: 'of', sign: 'Signature', teacher: 'Teacher', date: 'Date', session: 'Session' };

// ---------- pure logic (same as the website) ----------
export function utcDay(iso: string) { const p = String(iso || '').split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2] || 1) / 864e5; }
export function isoOf(day: number) { return new Date(day * 864e5).toISOString().slice(0, 10); }
export function dow(day: number) { return new Date(day * 864e5).getUTCDay(); }
export interface Col { key: string; day: number | null; n: number }
export function columns(s: { mode: string; count?: number; skip?: number[]; month?: string; start?: string }): Col[] {
  const out: Col[] = [], skip = s.skip || [];
  if (s.mode === 'blank') {
    for (let i = 1; i <= Math.min(100, Math.max(1, (s.count ?? 1) | 0)); i++) out.push({ key: 'c' + i, day: null, n: i });
    return out;
  }
  if (skip.length >= 7) return out;
  if (s.mode === 'month') {
    const p = String(s.month || '').split('-'), y = +p[0], m = +p[1] - 1;
    if (!y || isNaN(m)) return out;
    const first = Date.UTC(y, m, 1) / 864e5, last = Date.UTC(y, m + 1, 1) / 864e5;
    for (let d = first; d < last; d++) if (skip.indexOf(dow(d)) < 0) out.push({ key: isoOf(d), day: d, n: out.length + 1 });
    return out;
  }
  let d = utcDay(s.start ?? '');
  if (!isFinite(d)) return out;
  const want = Math.min(100, Math.max(1, (s.count ?? 1) | 0));
  while (out.length < want) { if (skip.indexOf(dow(d)) < 0) out.push({ key: isoOf(d), day: d, n: out.length + 1 }); d++; }
  return out;
}
export function parseNames(text: string) {
  return String(text || '').split(/\r?\n/).map((l) => l.split('\t')[0].replace(/^\s*\d+\s*[.)\-]\s+/, '').trim()).filter(Boolean);
}
export function layout(s: { paper: string; orient: string; rowH: number; num: boolean; total: boolean; cell: string }, nCols: number, nRows: number) {
  const P = PAPER[s.paper] || PAPER.A4, W = s.orient === 'portrait' ? P[0] : P[1], H = s.orient === 'portrait' ? P[1] : P[0];
  const innerW = W - 2 * MARGIN, innerH = H - 2 * MARGIN, rowH = +s.rowH || 8;
  const numW = s.num ? 8 : 0, totW = s.total && nCols ? 13 : 0;
  let nameW = Math.max(42, Math.min(70, innerW * 0.22));
  const minC = s.cell === 'sign' ? 24 : 6.5, maxC = s.cell === 'sign' ? 60 : 16;
  const room = innerW - numW - nameW - totW;
  const perPage = Math.max(1, Math.floor(room / minC));
  const chunks = nCols ? Math.ceil(nCols / perPage) : 1;
  const per = nCols ? Math.ceil(nCols / chunks) : 0;
  const colW = per ? Math.min(maxC, room / per) : 0;
  nameW = innerW - numW - totW - per * colW; // the name column takes what is left
  const rowsPer = Math.max(1, Math.floor((innerH - HEAD - THEAD - FOOT - 1) / rowH));
  const rowPages = Math.max(1, Math.ceil(nRows / rowsPer));
  return { W, H, innerW, rowH, numW, nameW, totW, colW, per, chunks, rowsPer, rowPages, pages: rowPages * chunks };
}
function csvCell(v: unknown) { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
export function toCSV(names: string[], cols: Col[], marks: Record<string, string>, withMarks: boolean) {
  const head = ['Name', ...cols.map((c) => (c.day == null ? 'Session ' + c.n : c.key))];
  if (withMarks) head.push('Present', 'Absent', 'Late');
  const rows: unknown[][] = [head];
  names.forEach((n) => {
    const r: unknown[] = [n], cnt: Record<string, number> = { P: 0, A: 0, L: 0 };
    cols.forEach((c) => { const m = withMarks ? marks[n + '\u0001' + c.key] || '' : ''; if (m) cnt[m]++; r.push(m); });
    if (withMarks) r.push(cnt.P, cnt.A, cnt.L);
    rows.push(r);
  });
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function periodText(mode: string, month: string, cols: Col[]) {
  if (mode === 'month') { const p = month.split('-'); return p[0] ? MONTHS[+p[1] - 1] + ' ' + p[0] : ''; }
  if (mode === 'blank' || !cols.length) return '';
  const f = (d: number) => { const x = new Date(d * 864e5); return x.getUTCDate() + ' ' + MONTHS[x.getUTCMonth()].slice(0, 3) + ' ' + x.getUTCFullYear(); };
  return f(cols[0].day!) + ' – ' + f(cols[cols.length - 1].day!);
}
function colHead(c: Col, cell: string, multiMonth: boolean): [string, string] {
  if (c.day == null) return [cell === 'sign' ? T.session : '', String(c.n)];
  const x = new Date(c.day * 864e5);
  return [WD[x.getUTCDay()], multiMonth ? x.getUTCDate() + '/' + (x.getUTCMonth() + 1) : String(x.getUTCDate())];
}

export default defineTool({
  name: 'doc_attendance_sheet',
  title: 'Attendance sheet PDF',
  webSlug: 'attendance-sheet',
  description:
    'Make a printable attendance / sign-in sheet PDF: names down the side, one column per date for a month (skipping chosen ' +
    'weekdays, e.g. Fri+Sat or Sat+Sun), a run of N sessions from a start date, or N blank columns; tick boxes or wide ' +
    'signature cells; row numbers, a total column, extra empty rows, title, group and teacher. Same page maths as the ' +
    'website: rows that don\'t fit continue on more pages, and too many date columns are split across pages with the same ' +
    `names. Also returns a blank register CSV. English labels, Latin text only for now. Web version: ${webUrl('attendance-sheet')}`,
  inputSchema: z.object({
    names: z.union([z.string(), z.array(z.string())]).describe('Names, one per line (leading "1." numbering and anything after a tab are removed), or a list.'),
    title: z.string().max(80).optional().default('').describe('Title (default "Attendance").'),
    group: z.string().max(80).optional().default('').describe('Class / group, shown under the title.'),
    teacher: z.string().max(80).optional().default('').describe('Teacher, shown under the title.'),
    mode: z.enum(['month', 'sessions', 'blank']).optional().default('month').describe('month = every day of a month; sessions = N dates from a start date; blank = N unnamed columns.'),
    month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('month mode: YYYY-MM (default this month).'),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('sessions mode: first date YYYY-MM-DD (default today).'),
    count: z.number().int().min(1).max(100).optional().default(12).describe('sessions/blank: number of columns.'),
    skip: z.array(z.number().int().min(0).max(6)).optional().default([0, 6]).describe('Weekdays to skip, 0 = Sunday … 6 = Saturday (default [0, 6] = weekends Sat+Sun; use [5, 6] for Fri+Sat).'),
    cell: z.enum(['box', 'sign']).optional().default('box').describe('box = tick boxes, sign = wide cells for signatures.'),
    paper: z.enum(['A4', 'Letter']).optional().default('A4'),
    orientation: z.enum(['landscape', 'portrait']).optional().default('landscape'),
    rowHeight: z.number().min(5).max(30).optional().describe('Row height in mm (default 8, or 13 for signature cells).'),
    extraRows: z.number().int().min(0).max(60).optional().default(2).describe('Empty rows after the names.'),
    numbers: z.boolean().optional().default(true).describe('Row number column.'),
    total: z.boolean().optional().default(true).describe('Total column.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfOutputShape,
    names: z.number(), columns: z.number(), rowsPerPage: z.number(), columnChunks: z.number().describe('Pages the date columns are split over.'),
    dates: z.array(z.string()).describe('Column keys (YYYY-MM-DD, or c1… in blank mode).'),
    csv: z.string().describe('A blank register as CSV (Name + one column per date).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { names: 'Ahmad Khalil\nLina Haddad\nOmar Saleh', group: 'Grade 7 B · Science', teacher: 'Ms. Rana', month: '2026-11', skip: [5, 6] }, note: '22 date columns, 1 page.' }],
  async run(input, ctx) {
    const today = new Date(), pad2 = (n: number) => String(n).padStart(2, '0');
    const month = input.month ?? today.getFullYear() + '-' + pad2(today.getMonth() + 1);
    const start = input.start ?? month + '-' + pad2(today.getDate());
    const names = parseNames(Array.isArray(input.names) ? input.names.join('\n') : input.names).map((n, i) => userText(n, `names[${i}]`));
    const title = userText(input.title, 'title'), group = userText(input.group, 'group'), teacher = userText(input.teacher, 'teacher');
    const cols = columns({ mode: input.mode, count: input.count, skip: input.skip, month, start });
    if (!cols.length) throw new ToolError('There are no date columns. Check the month or the skipped days.');
    const rows: string[] = [...names];
    for (let e = 0; e < input.extraRows; e++) rows.push('');
    const st = { paper: input.paper, orient: input.orientation, rowH: input.rowHeight ?? (input.cell === 'sign' ? 13 : 8), num: input.numbers, total: input.total, cell: input.cell };
    const L = layout(st, cols.length, rows.length);
    const multiMonth = cols[0].day != null && new Date(cols[0].day * 864e5).getUTCMonth() !== new Date(cols[cols.length - 1].day! * 864e5).getUTCMonth();
    const sub = [group, periodText(input.mode, month, cols), teacher ? T.teacher + ': ' + teacher : ''].filter(Boolean).join('   ·   ');
    const { doc, fonts } = await newDoc(title || T.title, ctx);
    const PT = 25.4 / 72, border = { color: '#6b7280', width: 0.2 };
    let pageNo = 0;
    for (let rp = 0; rp < L.rowPages; rp++) {
      for (let ch = 0; ch < L.chunks; ch++) {
        pageNo++;
        const part = cols.slice(ch * L.per, (ch + 1) * L.per), last = ch === L.chunks - 1;
        const g = new Draw(doc.addPage([L.W * MM, L.H * MM]), fonts, MM).sub(MARGIN, MARGIN);
        const iw = L.innerW;
        // header
        const dateLine = input.mode === 'blank' ? T.date + ': ____________' : '';
        const dlw = dateLine ? g.width(dateLine, 10 * PT) + 6 : 0;
        g.text(title || T.title, 0, 15 * PT * 0.95, { size: 15 * PT, font: fonts.bold, color: '#0b0d10', maxW: iw - dlw });
        g.text(sub, 0, 15 * PT * 1.2 + 1 + 9.5 * PT * 0.95, { size: 9.5 * PT, color: '#4b525c', maxW: iw - dlw });
        if (dateLine) g.text(dateLine, iw, 2 + 10 * PT * 0.95, { size: 10 * PT, color: '#333333', align: 'right' });
        // table
        const xs: number[] = [];
        let x = 0;
        const widths = [...(L.numW ? [L.numW] : []), L.nameW, ...part.map(() => L.colW), ...(last && L.totW ? [L.totW] : [])];
        for (const w of widths) { xs.push(x); x += w; }
        const tw = x, ty = HEAD, nameIdx = L.numW ? 1 : 0;
        g.rect(0, ty, tw, THEAD, { fill: '#eceff3' });
        const head = [...(L.numW ? [T.num] : []), T.name];
        head.forEach((h, i) => g.text(h, i === nameIdx ? xs[i] + 1.2 : xs[i] + widths[i] / 2, ty + THEAD / 2 + 8 * PT * 0.35, { size: 8 * PT, font: fonts.bold, color: '#20242a', align: i === nameIdx ? 'left' : 'center', maxW: widths[i] - 2.4 }));
        part.forEach((c, k) => {
          const i = nameIdx + 1 + k, [a, b] = colHead(c, input.cell, multiMonth), cx = xs[i] + widths[i] / 2;
          if (a) g.text(a, cx, ty + THEAD / 2 - 0.4, { size: 6 * PT, font: fonts.bold, color: '#5b626c', align: 'center', maxW: widths[i] - 0.4 });
          g.text(b, cx, ty + THEAD / 2 + (a ? 3.2 : 8.5 * PT * 0.35), { size: 8.5 * PT, font: fonts.bold, color: '#20242a', align: 'center', maxW: widths[i] - 0.4 });
        });
        if (last && L.totW) g.text(T.total, xs[xs.length - 1] + L.totW / 2, ty + THEAD / 2 + 8 * PT * 0.35, { size: 8 * PT, font: fonts.bold, color: '#20242a', align: 'center', maxW: L.totW - 1 });
        const body = rows.slice(rp * L.rowsPer, (rp + 1) * L.rowsPer);
        body.forEach((n, i) => {
          const y = ty + THEAD + i * L.rowH;
          if (i % 2 === 1) g.rect(0, y, tw, L.rowH, { fill: '#f7f8fa' });
          const mid = y + L.rowH / 2;
          if (L.numW && n) g.text(String(rp * L.rowsPer + i + 1), xs[0] + L.numW / 2, mid + 8 * PT * 0.35, { size: 8 * PT, color: '#6b7280', align: 'center' });
          g.text(n, xs[nameIdx] + 1.2, mid + 9.5 * PT * 0.35, { size: 9.5 * PT, color: '#111111', maxW: L.nameW - 2.4 });
          if (input.cell === 'box') part.forEach((_c, k) => {
            const i2 = nameIdx + 1 + k, bx = xs[i2] + widths[i2] / 2 - 1.7;
            g.roundRect(bx, mid - 1.7, 3.4, 3.4, 0.6, { stroke: '#4b5563', lineWidth: 0.25 });
          });
        });
        // grid lines
        const bottom = ty + THEAD + body.length * L.rowH;
        for (const xx of [...xs, tw]) g.line(xx, ty, xx, bottom, border);
        g.line(0, ty, tw, ty, border);
        for (let r = 0; r <= body.length; r++) g.line(0, ty + THEAD + r * L.rowH, tw, ty + THEAD + r * L.rowH, border);
        // footer
        const fy = L.H - 2 * MARGIN - 1, fs = 8 * PT, grey = '#4b525c';
        if (input.cell === 'box') {
          let lx = 0;
          const ck = (x0: number) => g.path(`M${x0} ${fy - 1.3}l0.9 1l1.8 -2.2`, { stroke: grey, lineWidth: 0.35 });
          const cross = (x0: number) => g.path(`M${x0} ${fy - 2.3}l2 2M${x0 + 2} ${fy - 2.3}l-2 2`, { stroke: grey, lineWidth: 0.35 });
          ck(lx); lx += 3.2; lx += g.text('present', lx, fy, { size: fs, color: grey }) + 4;
          cross(lx); lx += 3.2; lx += g.text('absent', lx, fy, { size: fs, color: grey }) + 4;
          g.text('L late', lx, fy, { size: fs, color: grey });
        }
        g.text(T.sign + ': ______________________', iw / 2, fy, { size: fs, color: grey, align: 'center' });
        g.text(`${T.page} ${pageNo} ${T.of} ${L.pages}`, iw, fy, { size: fs, color: grey, align: 'right' });
      }
    }
    const fname = ((title || 'attendance').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'attendance') + '.pdf';
    const out = await savePdf(doc, { output: input.output, defaultName: fname, base64: input.returnBase64 }, ctx);
    return {
      ...out, mimeType: 'application/pdf', names: names.length, columns: cols.length, rowsPerPage: L.rowsPer, columnChunks: L.chunks,
      dates: cols.map((c) => c.key), csv: toCSV(names, cols, {}, false),
    };
  },
});

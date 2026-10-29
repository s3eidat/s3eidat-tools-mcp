import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, readTextInput, returnBase64 } from '../../../util/files.js';
import { Draw, MM, newDoc, pdfOutputShape, savePdf, userText, wrap } from './_pdf.js';

// Port of https://github.com/s3eidat/label-maker (app.js): same sheet presets (Avery-compatible sizes), label positions,
// list/CSV/same-text modes with {column} templates, copies, start position, alignment and shrink-to-fit.
const PAPER: Record<string, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4] };
export const PRESETS = [
  { id: 'a4-21', name: 'A4 · 21 labels, 3 × 7 · 63.5 × 38.1 mm (L7160 size)', paper: 'A4', cols: 3, rows: 7, w: 63.5, h: 38.1, top: 15.15, left: 7.21, gx: 2.54, gy: 0 },
  { id: 'a4-24', name: 'A4 · 24 labels, 3 × 8 · 63.5 × 33.9 mm (L7159 size)', paper: 'A4', cols: 3, rows: 8, w: 63.5, h: 33.9, top: 12.9, left: 7.21, gx: 2.54, gy: 0 },
  { id: 'a4-14', name: 'A4 · 14 labels, 2 × 7 · 99.1 × 38.1 mm (L7163 size)', paper: 'A4', cols: 2, rows: 7, w: 99.1, h: 38.1, top: 15.15, left: 4.65, gx: 2.5, gy: 0 },
  { id: 'a4-40', name: 'A4 · 40 labels, 4 × 10 · 45.7 × 25.4 mm (L7654 size)', paper: 'A4', cols: 4, rows: 10, w: 45.7, h: 25.4, top: 21.5, left: 9.7, gx: 2.6, gy: 0 },
  { id: 'a4-65', name: 'A4 · 65 labels, 5 × 13 · 38.1 × 21.2 mm (L7651 size)', paper: 'A4', cols: 5, rows: 13, w: 38.1, h: 21.2, top: 10.7, left: 4.75, gx: 2.5, gy: 0 },
  { id: 'lt-30', name: 'Letter · 30 labels, 3 × 10 · 2⅝ × 1 in (5160 size)', paper: 'Letter', cols: 3, rows: 10, w: 66.675, h: 25.4, top: 12.7, left: 4.7625, gx: 3.175, gy: 0 },
  { id: 'lt-10', name: 'Letter · 10 labels, 2 × 5 · 4 × 2 in (5163 size)', paper: 'Letter', cols: 2, rows: 5, w: 101.6, h: 50.8, top: 12.7, left: 3.96875, gx: 4.7625, gy: 0 },
  { id: 'lt-80', name: 'Letter · 80 labels, 4 × 20 · 1¾ × ½ in (5167 size)', paper: 'Letter', cols: 4, rows: 20, w: 44.45, h: 12.7, top: 12.7, left: 7.62, gx: 7.62, gy: 0 },
] as const;
const MAX_LABELS = 3000;
export interface Sheet { id: string; paper: string; cols: number; rows: number; w: number; h: number; top: number; left: number; gx: number; gy: number }

// ---------- pure logic (same as the website) ----------
export function pos(S: Sheet, i: number, nx = 0, ny = 0) {
  const per = S.cols * S.rows, k = i % per, r = Math.floor(k / S.cols), c = k % S.cols;
  return { page: Math.floor(i / per), x: S.left + c * (S.w + S.gx) + nx, y: S.top + r * (S.h + S.gy) + ny };
}
export function fits(S: Sheet) {
  const P = PAPER[S.paper] || PAPER.A4;
  return { right: S.left + S.cols * S.w + (S.cols - 1) * S.gx, bottom: S.top + S.rows * S.h + (S.rows - 1) * S.gy, W: P[0], H: P[1] };
}
export function blocks(text: string) {
  return String(text || '').replace(/\r/g, '').split(/\n[ \t]*\n/).map((b) => b.replace(/^\n+|\s+$/g, '')).filter((b) => b.trim());
}
export function parseCSV(text: string) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split('\n')[0];
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"' && f === '') q = true;
    else if (ch === delim) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
export function fill(tpl: string, head: string[], row: string[]) {
  if (!tpl.trim()) return row.map((c) => c.trim()).filter(Boolean).join('\n');
  return tpl.replace(/\{([^{}]+)\}/g, (_m, k: string) => {
    const n = /^\d+$/.test(k) ? +k - 1 : head.map((h) => h.trim().toLowerCase()).indexOf(k.trim().toLowerCase());
    return n >= 0 && n < row.length ? row[n].trim() : '';
  }).split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}
export function labelsOf(s: { mode: string; text: string; tpl?: string; header?: boolean; count?: number; copies?: number }) {
  let out: string[] = [];
  if (s.mode === 'same') {
    const t = String(s.text || '').trim();
    if (t) for (let i = 0; i < Math.min(MAX_LABELS, Math.max(1, (s.count ?? 1) | 0)); i++) out.push(t);
    return out;
  }
  if (s.mode === 'csv') {
    const rows = parseCSV(s.text), head = s.header && rows.length ? rows.shift()! : [];
    rows.forEach((r) => { const v = fill(s.tpl || '', head, r); if (v) out.push(v); });
  } else out = blocks(s.text);
  const cp = Math.max(1, Math.min(100, (s.copies ?? 1) | 0)), res: string[] = [];
  out.forEach((l) => { for (let j = 0; j < cp && res.length < MAX_LABELS; j++) res.push(l); });
  return res;
}

const mm = (v: number) => z.number().optional().describe(v + ' mm');

export default defineTool({
  name: 'doc_labels',
  title: 'Label sheets PDF',
  webSlug: 'label-maker',
  description:
    'Print address or product labels on standard sticker sheets as PDF: A4 21/24/14/40/65-up (L7160, L7159, L7163, L7654, ' +
    'L7651 sizes) or Letter 30/10/80-up (5160, 5163, 5167 sizes), or custom geometry in mm. Text modes: "list" (one label ' +
    'per block, blank line between labels), "csv" (rows filled into a template like "{Name}\\n{Street}\\n{City} {Postcode}", ' +
    'header row or {1},{2}…), or "same" (one text × count). Copies per label, start at a later position to reuse a part-used ' +
    'sheet, alignment, font, size, bold first line, border, shrink-to-fit and printer offset nudges. Print at 100% / actual size. ' +
    `Up to 3000 labels. Latin text only for now. Web version: ${webUrl('label-maker')}`,
  inputSchema: z.object({
    mode: z.enum(['list', 'csv', 'same']).optional().default('list').describe('list = blocks separated by a blank line; csv = rows + template; same = one text repeated.'),
    text: z.string().optional().describe('The labels text (list blocks, CSV/TSV, or the single text).'),
    path: z.string().optional().describe('Or: a text/CSV file path to read it from.'),
    template: z.string().optional().default('').describe('csv: template with {Column name} or {1}-style placeholders (empty = all columns, one per line).'),
    header: z.boolean().optional().default(true).describe('csv: the first row holds column names.'),
    count: z.number().int().min(1).max(MAX_LABELS).optional().default(21).describe('same: how many labels.'),
    copies: z.number().int().min(1).max(100).optional().default(1).describe('list/csv: copies of each label.'),
    preset: z.enum(['a4-21', 'a4-24', 'a4-14', 'a4-40', 'a4-65', 'lt-30', 'lt-10', 'lt-80', 'custom']).optional().default('a4-21')
      .describe('Sheet: a4-21 (63.5×38.1), a4-24 (63.5×33.9), a4-14 (99.1×38.1), a4-40 (45.7×25.4), a4-65 (38.1×21.2), lt-30 (2⅝×1 in), lt-10 (4×2 in), lt-80 (1¾×½ in), or custom.'),
    custom: z.object({
      paper: z.enum(['A4', 'Letter']).optional().default('A4'), cols: z.number().int().min(1).max(20), rows: z.number().int().min(1).max(40),
      w: z.number().positive().describe('Label width mm'), h: z.number().positive().describe('Label height mm'),
      top: mm(0).default(0).describe('Top margin mm'), left: mm(0).default(0).describe('Left margin mm'),
      gx: mm(0).default(0).describe('Horizontal gap mm'), gy: mm(0).default(0).describe('Vertical gap mm'),
    }).optional().describe('preset "custom": paper, cols, rows, w, h, top, left, gx, gy (mm).'),
    startAt: z.number().int().min(1).optional().default(1).describe('Start at this label position on the first sheet (skips used labels).'),
    fontSize: z.number().min(5).max(72).optional().default(11).describe('Font size in pt (default 11).'),
    font: z.enum(['sans', 'serif', 'mono']).optional().default('sans'),
    align: z.enum(['left', 'center', 'right']).optional().default('center'),
    valign: z.enum(['top', 'middle']).optional().default('middle'),
    bold: z.boolean().optional().default(true).describe('Bold first line (e.g. the name).'),
    fit: z.boolean().optional().default(true).describe('Shrink text (in 0.5 pt steps, min 5 pt) until it fits the label.'),
    border: z.boolean().optional().default(false).describe('Draw a thin rounded border around each label.'),
    padding: z.number().min(0).max(15).optional().default(3).describe('Inner padding in mm.'),
    offsetX: z.number().min(-15).max(15).optional().default(0).describe('Printer nudge right (mm, negative = left).'),
    offsetY: z.number().min(-15).max(15).optional().default(0).describe('Printer nudge down (mm, negative = up).'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfOutputShape,
    labels: z.number().describe('Labels printed.'), perSheet: z.number(), shrunk: z.number().describe('Labels whose text was shrunk to fit.'),
    truncated: z.number().describe('Labels whose text still did not fit (cut at the bottom).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'Lina Haddad\n12 Rainbow Street\nAmman 11181\n\nOmar Saleh\n4 Garden Lane\nIrbid 21110', border: true }, note: '2 address labels on an A4 21-up sheet.' },
    { input: { mode: 'csv', text: 'Name,City\nLina,Amman\nOmar,Irbid', template: '{Name}\n{City}', preset: 'lt-30' } },
    { input: { mode: 'same', text: 'Homemade Fig Jam\n250 g', count: 24, preset: 'a4-24' } },
  ],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    let S: Sheet;
    if (input.preset === 'custom') {
      if (!input.custom) throw new ToolError('preset "custom" needs "custom": { cols, rows, w, h, top, left, gx, gy }.');
      S = { id: 'custom', ...input.custom };
    } else S = { ...PRESETS.find((p) => p.id === input.preset)! };
    const F = fits(S);
    if (S.w <= 0 || S.h <= 0 || F.right > F.W + 0.01 || F.bottom > F.H + 0.01) {
      throw new ToolError(`Labels run off the page (${F.right.toFixed(1)} × ${F.bottom.toFixed(1)} mm on ${F.W} × ${F.H} mm).`);
    }
    const labels = labelsOf({ mode: input.mode, text, tpl: input.template, header: input.header, count: input.count, copies: input.copies })
      .map((l, i) => userText(l, `label ${i + 1}`));
    if (!labels.length) throw new ToolError('Add some label text.');
    const per = S.cols * S.rows, start = Math.min(input.startAt - 1, per - 1), total = labels.length + start, pages = Math.max(1, Math.ceil(total / per));
    const [PW, PH] = PAPER[S.paper] || PAPER.A4;
    const { doc, fonts } = await newDoc('Labels', ctx);
    const fam = input.font === 'serif' ? [fonts.serif, fonts.serifBold] : input.font === 'mono' ? [fonts.mono, fonts.monoBold] : [fonts.sans, fonts.bold];
    const PT = 25.4 / 72; // mm per pt
    let shrunk = 0, truncated = 0;
    for (let p = 0; p < pages; p++) {
      const g = new Draw(doc.addPage([PW * MM, PH * MM]), fonts, MM);
      for (let k = 0; k < per; k++) {
        const i = p * per + k, lab = labels[i - start];
        if (i < start || lab == null) continue;
        const at = pos(S, i, input.offsetX, input.offsetY);
        if (input.border) g.roundRect(at.x + 0.125, at.y + 0.125, S.w - 0.25, S.h - 0.25, 1.5, { stroke: '#9aa1ab', lineWidth: 0.25 });
        const iw = S.w - 2 * input.padding, ih = S.h - 2 * input.padding;
        const layout = (sizePt: number) => {
          const size = sizePt * PT, out: { t: string; bold: boolean }[] = [];
          lab.split('\n').forEach((src, li) => {
            const f = input.bold && li === 0 ? fam[1] : fam[0];
            for (const t of wrap((s) => g.width(s, size, f), src, iw)) out.push({ t, bold: input.bold && li === 0 });
          });
          return { size, lines: out, h: out.length * size * 1.22 };
        };
        let sz = input.fontSize, L = layout(sz);
        if (input.fit) while (L.h > ih + 0.01 && sz > 5) { sz -= 0.5; L = layout(sz); }
        if (sz < input.fontSize) shrunk++;
        const lh = L.size * 1.22;
        let lines = L.lines;
        const maxLines = Math.max(1, Math.floor((ih + 0.01) / lh));
        if (lines.length > maxLines) { lines = lines.slice(0, maxLines); truncated++; }
        let y = at.y + input.padding + (input.valign === 'middle' ? Math.max(0, (ih - lines.length * lh) / 2) : 0);
        const x = input.align === 'left' ? at.x + input.padding : input.align === 'right' ? at.x + S.w - input.padding : at.x + S.w / 2;
        for (const l of lines) {
          g.text(l.t, x, y + lh / 2 + L.size * 0.35, { size: L.size, font: l.bold ? fam[1] : fam[0], color: '#111111', align: input.align });
          y += lh;
        }
      }
    }
    const out = await savePdf(doc, { output: input.output, defaultName: 'labels.pdf', base64: input.returnBase64 }, ctx);
    return { ...out, mimeType: 'application/pdf', labels: labels.length, perSheet: per, shrunk, truncated };
  },
});

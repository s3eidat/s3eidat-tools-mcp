import { z } from 'zod';
import { StandardFonts, degrees, type PDFDocument } from 'pdf-lib';
import { defineTool, webUrl } from '../../../registry.js';
import {
  baseName, colorSchema, cssHex, encodable, fileInput, hexRgb, openPdf, outputPath, pageGeom, pagesSpec, parseRangeSet,
  pdfFileOutput, returnBase64, savePdf, textPng, toUser, widthWith,
} from './_common.js';

// Ported from https://github.com/s3eidat/pdf-page-numbers (app.js): same numbering plan, tokens, layout and defaults.
const FONTS = { Helvetica: StandardFonts.Helvetica, HelveticaBold: StandardFonts.HelveticaBold, TimesRoman: StandardFonts.TimesRoman, Courier: StandardFonts.Courier };
type FontKey = keyof typeof FONTS;
export const PRESETS = ['{n}', 'Page {n}', 'Page {n} of {total}', '{n} / {total}', '- {n} -', 'p. {n}'];
export const DEF = { format: 'Page {n} of {total}', pos: 'bc', start: 1, skip: 0, range: '', font: 'Helvetica' as FontKey, size: 10, color: '#333333', margin: 28, header: '', hAlign: 'c', footer: '', fAlign: 'c' };
export type PnCfg = typeof DEF;

/** Which pages get a number, and what it is: [{n, total} | null] per page. */
export function plan(nPages: number, cfg: Pick<PnCfg, 'range' | 'skip' | 'start'>) {
  const sel = parseRangeSet(cfg.range, nPages), ok = (i: number) => sel.has(i) && i >= (cfg.skip || 0);
  let count = 0;
  for (let i = 0; i < nPages; i++) if (ok(i)) count++;
  let k = 0;
  const start = Number.isFinite(+cfg.start) ? +cfg.start : 1;
  return Array.from({ length: nPages }, (_, i) => (ok(i) ? { n: start + k++, total: start - 1 + count } : null));
}

export const fillTokens = (tpl: string, v: Record<string, unknown>) =>
  String(tpl || '').replace(/\{(n|total|date|filename)\}/g, (m, k: string) => (v[k] != null ? String(v[k]) : m));

/** Stamps for one page of shown size W x H: [{text, x, y (baseline, y up), size, w}]. */
export function layout(W: number, H: number, cfg: PnCfg, v: Record<string, unknown>, widthOf: (t: string, s: number) => number) {
  const slots: Record<string, string[]> = {}, add = (slot: string, text: string) => { if (text.trim()) (slots[slot] = slots[slot] || []).push(text); };
  add(cfg.pos, fillTokens(cfg.format, v));
  add('t' + cfg.hAlign, fillTokens(cfg.header, v));
  add('b' + cfg.fAlign, fillTokens(cfg.footer, v));
  const size = +cfg.size || 10, m = +cfg.margin || 0, out: { text: string; x: number; y: number; size: number; w: number }[] = [];
  Object.keys(slots).forEach((slot) => slots[slot].forEach((text, i) => {
    const w = widthOf(text, size), col = slot[1];
    const x = col === 'l' ? m : col === 'r' ? W - m - w : (W - w) / 2;
    const y = slot[0] === 't' ? H - m - size * 0.72 - i * size * 1.4 : m + i * size * 1.4;
    out.push({ text, x, y, size, w });
  }));
  return out;
}

export async function stampPdf(doc: PDFDocument, cfg: PnCfg, ctxVals: { date: string; filename: string }) {
  const pages = doc.getPages(), font = await doc.embedFont(FONTS[cfg.font] ?? StandardFonts.Helvetica);
  const P = plan(pages.length, cfg), color = hexRgb(cfg.color), widthOf = await widthWith(font, cfg.font);
  for (let i = 0; i < pages.length; i++) {
    if (!P[i]) continue;
    const pg = pages[i], { box, rot, W, H } = pageGeom(pg);
    for (const s of layout(W, H, cfg, { ...ctxVals, ...P[i] }, widthOf)) {
      if (encodable(font, s.text)) { const [x, y] = toUser(box, rot, s.x, s.y); pg.drawText(s.text, { x, y, size: s.size, font, color, rotate: degrees(rot) }); }
      else {
        const t = await textPng(s.text, s.size, cssHex(cfg.color), cfg.font), img = await doc.embedPng(t.png), [x, y] = toUser(box, rot, s.x - 2 / 4, s.y - s.size * 0.3);
        pg.drawImage(img, { x, y, width: t.w, height: t.h, rotate: degrees(rot) });
      }
    }
  }
  return P;
}

const align = z.enum(['l', 'c', 'r']);

export default defineTool({
  name: 'pdf_page_numbers',
  title: 'Add page numbers',
  webSlug: 'pdf-page-numbers',
  description:
    'Add page numbers to a PDF, plus an optional header and footer line. Format tokens: {n}, {total}, {date}, {filename} ' +
    '(e.g. "Page {n} of {total}", "{n} / {total}", "- {n} -"). Choose the corner/edge, start number, how many leading pages ' +
    'to skip (e.g. a cover), a page range, font, size, colour and margin. Numbers stay upright on rotated pages. Web ' +
    `version: ${webUrl('pdf-page-numbers')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    format: z.string().optional().default(DEF.format).describe('Number format with {n}, {total}, {date}, {filename}. Default "Page {n} of {total}". Empty = no number (header/footer only).'),
    position: z.enum(['tl', 'tc', 'tr', 'bl', 'bc', 'br']).optional().default('bc').describe('Where the number goes: t/b = top/bottom, l/c/r = left/centre/right. Default "bc".'),
    start: z.number().int().optional().default(1).describe('Number of the first numbered page. Default 1.'),
    skip: z.number().int().min(0).optional().default(0).describe('Leave this many first pages without a number (e.g. 1 for a cover). Default 0.'),
    pages: pagesSpec('Pages to number'),
    font: z.enum(['Helvetica', 'HelveticaBold', 'TimesRoman', 'Courier']).optional().default('Helvetica'),
    size: z.number().min(4).max(72).optional().default(10).describe('Text size in points. Default 10.'),
    color: colorSchema('#333333'),
    margin: z.number().min(0).max(300).optional().default(28).describe('Distance from the page edge in points. Default 28.'),
    header: z.string().optional().default('').describe('Optional header text on numbered pages (tokens allowed).'),
    headerAlign: align.optional().default('c').describe('Header alignment: l, c or r.'),
    footer: z.string().optional().default('').describe('Optional footer text on numbered pages (tokens allowed).'),
    footerAlign: align.optional().default('c').describe('Footer alignment: l, c or r.'),
    date: z.string().optional().describe('Text for {date}. Default: today in the server locale.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...pdfFileOutput, numbered: z.number().describe('How many pages got a number.'), first: z.number().nullable(), last: z.number().nullable() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'report.pdf', format: 'Page {n} of {total}', position: 'br', skip: 1 }, note: 'no number on the cover' },
    { input: { file: 'thesis.pdf', format: '{n}', footer: 'Draft, {date}', footerAlign: 'l' } },
  ],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    const cfg: PnCfg = {
      format: input.format, pos: input.position, start: input.start, skip: input.skip, range: input.pages ?? '', font: input.font,
      size: input.size, color: input.color, margin: input.margin, header: input.header, hAlign: input.headerAlign, footer: input.footer, fAlign: input.footerAlign,
    };
    const P = await stampPdf(doc, cfg, { date: input.date ?? new Date().toLocaleDateString(), filename: f.path ? f.name : 'document.pdf' });
    const nums = P.filter((x): x is { n: number; total: number } => !!x);
    const w = await savePdf(doc, { output: input.output, defaultName: baseName(f) + '-numbered.pdf', returnBase64: input.returnBase64 }, ctx);
    return { ...w, numbered: nums.length, first: nums[0]?.n ?? null, last: nums.length ? nums[nums.length - 1].n : null };
  },
});

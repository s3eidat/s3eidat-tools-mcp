import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { readInput, writeOutput } from '../../../util/files.js';
import { loadPdfJs, pdfjs } from '../../../util/pdf.js';
import { closeJs, fileInput, pagesSpec, parseRangeSet } from './_common.js';

// Ported from https://github.com/s3eidat/pdf-to-text (app.js): pdf.js reads the text items, and lines, spacing,
// right-to-left order and paragraphs are rebuilt with the website's rules.
const RTL_CH = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/g, LTR_CH = /[A-Za-zÀ-ɏЀ-ӿ]/g;

export interface TItem { str: string; x: number; y: number; w: number; h: number; dir?: string }

/** Items on one line (x = left edge as shown): joined in reading order, with spaces at gaps. */
export function joinLine(items: TItem[]) {
  const rtlN = items.reduce((s, it) => s + (it.str.match(RTL_CH) || []).length, 0), ltrN = items.reduce((s, it) => s + (it.str.match(LTR_CH) || []).length, 0);
  const rtl = rtlN > ltrN, seq = items.slice().sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
  let out = '', prev: TItem | null = null;
  for (const it of seq) {
    if (prev) {
      const gap = rtl ? prev.x - (it.x + it.w) : it.x - (prev.x + prev.w), hh = Math.max(1, Math.min(prev.h, it.h) || prev.h || it.h);
      if ((gap > hh * 0.17 || gap < -hh * 1.5) && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
    }
    out += it.str;
    prev = it;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Raw text items in shown coordinates -> paragraphs of lines. */
export function buildParagraphs(items: TItem[]) {
  const xs = items.filter((it) => it.str.trim());
  xs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; h: number; items: TItem[] }[] = [];
  for (const it of xs) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(it.y - L.y) <= Math.max(2, Math.min(L.h, it.h) * 0.45)) { L.items.push(it); L.h = Math.max(L.h, it.h); }
    else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  const done = lines.map((l) => ({ y: l.y, h: l.h, text: joinLine(l.items) })).filter((l) => l.text);
  const gaps: number[] = [];
  for (let i = 1; i < done.length; i++) { const d = done[i].y - done[i - 1].y; if (d > 0) gaps.push(d); }
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0, paras: string[][] = [];
  done.forEach((l, i) => {
    const p = done[i - 1], d = p ? l.y - p.y : 0;
    const brk = !p || d > Math.max(med * 1.45, l.h * 1.9) || Math.abs(l.h - p.h) > Math.max(l.h, p.h) * 0.25 || d < 0;
    if (brk) paras.push([l.text]); else paras[paras.length - 1].push(l.text);
  });
  return paras;
}

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfJs>>['getPage']>>;
export async function pageParagraphs(page: PdfPage) {
  const vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent(), U = (await pdfjs()).Util;
  const items = (tc.items as { str?: string; transform: number[]; width: number; height: number; dir: string }[])
    .filter((it) => typeof it.str === 'string')
    .map((it) => {
      const m = U.transform(vp.transform, it.transform), hh = Math.hypot(m[2], m[3]) || it.height || 10, horiz = Math.abs(m[1]) < Math.abs(m[0]) * 0.2 || !m[0];
      return { str: it.str as string, x: m[4], y: m[5], w: horiz ? it.width : 0, h: hh, dir: it.dir };
    });
  return buildParagraphs(items);
}

/** Join lines, mending words split with a hyphen at the line end. */
export function reflowPara(lines: string[]) {
  return lines.reduce((s, l) => (!s ? l : /[A-Za-zÀ-ɏ]-$/.test(s) && /^[a-zß-ɏ]/.test(l) ? s.slice(0, -1) + l : s + ' ' + l), '');
}
const countWords = (s: string) => (s.match(/[^\s\-–—•·|]+/g) || []).length;
export function pageStats(paras: string[][]) {
  const t = paras.map(reflowPara).join('\n');
  return { words: countWords(t), chars: t.replace(/\s/g, '').length, hasText: t.trim().length > 0 };
}

/** pages: [{n (1-based), paras}]. */
export function formatAll(pages: { n: number; paras: string[][] }[], opts: { seps?: boolean; reflow?: boolean; md?: boolean }) {
  const out: string[] = [];
  pages.forEach(({ n, paras }) => {
    const body = paras.map((p) => (opts.reflow || opts.md ? reflowPara(p) : p.join('\n'))).join('\n\n');
    if (opts.md) out.push((opts.seps || pages.length > 1 ? '## Page ' + n + '\n\n' : '') + (body || '_(no text on this page)_'));
    else out.push((opts.seps ? '——— Page ' + n + ' ———\n\n' : '') + body);
  });
  return out.filter((s) => s.trim()).join(opts.md || opts.seps ? '\n\n' : '\n\n\n').trim() + '\n';
}

export default defineTool({
  name: 'pdf_to_text',
  title: 'PDF to text',
  webSlug: 'pdf-to-text',
  description:
    'Extract the text of a PDF with lines and paragraphs rebuilt (right-to-left Arabic/Hebrew lines in reading order), as ' +
    'plain text or Markdown, with optional page separators and reflow (join lines, mend hyphenated words). Returns per-page ' +
    'word counts and flags pages with no text layer (scans: this tool does no OCR). Supports page ranges and passwords. ' +
    `Give "output" to write a .txt/.md file instead of returning the text inline. Web version: ${webUrl('pdf-to-text')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    pages: pagesSpec('Pages to read'),
    password: z.string().optional().describe('Password, if the PDF is protected.'),
    format: z.enum(['text', 'markdown']).optional().default('text').describe('"text" or "markdown" (## Page N headings, reflowed paragraphs).'),
    separators: z.boolean().optional().default(true).describe('Put a "——— Page N ———" line before each page. Default true.'),
    reflow: z.boolean().optional().default(false).describe('Join the lines of each paragraph and mend words split by a hyphen.'),
    perPage: z.boolean().optional().default(false).describe('Also return each page\'s text separately.'),
    maxChars: z.number().int().min(1000).optional().default(200000).describe('Cut the inline text after this many characters (the file output is never cut).'),
    output: z.string().optional().describe('Write the text to this file (or folder ending in "/") instead of returning it inline.'),
  }),
  outputSchema: z.object({
    pageCount: z.number().describe('Pages in the PDF.'),
    words: z.number(), characters: z.number(),
    pagesWithText: z.number(),
    pagesWithoutText: z.array(z.number()).describe('1-based pages with no text layer (probably scanned images).'),
    pages: z.array(z.object({ page: z.number(), words: z.number(), hasText: z.boolean(), text: z.string().optional() })),
    text: z.string().optional(),
    truncated: z.boolean().optional(),
    path: z.string().optional(), bytes: z.number().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'article.pdf', reflow: true } },
    { input: { file: 'book.pdf', pages: '1-20', format: 'markdown', output: 'book.md' } },
  ],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, 'PDF');
    const js = await loadPdfJs(f.bytes, input.password);
    try {
      const sel = [...parseRangeSet(input.pages, js.numPages)];
      const pages: { n: number; paras: string[][] }[] = [];
      for (const i of sel) {
        const page = await js.getPage(i + 1);
        pages.push({ n: i + 1, paras: await pageParagraphs(page) });
        page.cleanup();
      }
      const md = input.format === 'markdown', stats = pages.map((p) => pageStats(p.paras));
      const text = formatAll(pages, { seps: input.separators, reflow: input.reflow, md });
      const result: Record<string, unknown> = {
        pageCount: js.numPages,
        words: stats.reduce((a, s) => a + s.words, 0), characters: stats.reduce((a, s) => a + s.chars, 0),
        pagesWithText: stats.filter((s) => s.hasText).length,
        pagesWithoutText: pages.filter((_, k) => !stats[k].hasText).map((p) => p.n),
        pages: pages.map((p, k) => ({
          page: p.n, words: stats[k].words, hasText: stats[k].hasText,
          ...(input.perPage ? { text: formatAll([p], { reflow: input.reflow, md: false }).trim() } : {}),
        })),
      };
      if (input.output) {
        const base = f.path ? f.name.replace(/\.pdf$/i, '') || 'document' : 'document';
        const w = await writeOutput(text, { output: input.output, defaultName: base + (md ? '.md' : '.txt'), mimeType: md ? 'text/markdown' : 'text/plain' }, ctx);
        result.path = w.path; result.bytes = w.bytes;
      } else {
        result.text = text.length > input.maxChars ? text.slice(0, input.maxChars) : text;
        result.truncated = text.length > input.maxChars;
      }
      return result;
    } finally {
      await closeJs(js);
    }
  },
});

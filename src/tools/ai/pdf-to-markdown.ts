import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { fileInput, readInput } from '../../util/files.js';
import { loadPdfJs, parsePageRanges, pdfjs, type PdfJsDoc } from '../../util/pdf.js';
import { joinLine, reflowPara, type TItem } from '../web/pdf/pdf-to-text.js';
import { emitMarkdown, maxCharsInput, mdOutputInput, mdOutputShape, stemOf, tidyMd } from './_md.js';

/** One text line as shown: top y, font size, left x and joined text. */
export interface PLine { y: number; size: number; x: number; text: string }

const round = (n: number) => Math.round(n * 2) / 2;

/** Text items (shown coordinates) -> lines, top to bottom. Size = the size most of the line's characters use. */
export function itemsToLines(items: TItem[]): PLine[] {
  const xs = items.filter((it) => it.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: { y: number; h: number; items: TItem[] }[] = [];
  for (const it of xs) {
    const L = groups[groups.length - 1];
    if (L && Math.abs(it.y - L.y) <= Math.max(2, Math.min(L.h, it.h) * 0.45)) { L.items.push(it); L.h = Math.max(L.h, it.h); }
    else groups.push({ y: it.y, h: it.h, items: [it] });
  }
  return groups
    .map((g) => {
      const weight = new Map<number, number>();
      for (const it of g.items) weight.set(round(it.h), (weight.get(round(it.h)) ?? 0) + it.str.trim().length);
      const size = [...weight.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      return { y: g.y, size, x: Math.min(...g.items.map((i) => i.x)), text: joinLine(g.items) };
    })
    .filter((l) => l.text);
}

/** The body text size: the size used by the most characters. */
export function bodySize(pages: PLine[][]) {
  const weight = new Map<number, number>();
  for (const l of pages.flat()) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length);
  return [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
}

// Bullet glyphs (incl. Symbol/Wingdings private-use ones); ASCII dashes and stars only when a space follows.
const BULLET = /^(?:[•◦▪▫●○■□‣⁃∙·]\s*|[-*–—]\s+)(?=\S)/;
const NUMBERED = /^(\d{1,3})[.)]\s+(?=\S)/;

/**
 * Lines of every page -> Markdown. Headings: lines clearly bigger than the body text (the biggest size is #, then ##, ...,
 * at most ####). Paragraphs break at gaps wider than normal line spacing or a size change; bullets become "- " items.
 */
export function linesToMarkdown(pages: { n: number; lines: PLine[] }[], opts: { pageMarkers?: boolean } = {}) {
  const body = bodySize(pages.map((p) => p.lines));
  const headSizes = [...new Set(pages.flatMap((p) => p.lines).filter((l) => l.size >= body * 1.15 && l.text.length <= 200).map((l) => l.size))].sort((a, b) => b - a);
  const level = (size: number) => Math.min(4, headSizes.indexOf(size) + 1);
  let headings = 0;
  const out: string[] = [];
  pages.forEach(({ n, lines }, pi) => {
    if (opts.pageMarkers) out.push((pi ? '---\n\n' : '') + `<!-- Page ${n} -->`);
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      const d = lines[i].y - lines[i - 1].y;
      if (d > 0 && lines[i].size === body && lines[i - 1].size === body) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    const med = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : body * 1.2;

    type Block = { kind: 'h' | 'p' | 'li'; level: number; lines: string[]; size: number; x: number; marker: string };
    const blocks: Block[] = [];
    lines.forEach((l, i) => {
      const prev = lines[i - 1], cur = blocks[blocks.length - 1];
      const d = prev ? l.y - prev.y : Infinity;
      const near = !!prev && d > 0 && d <= Math.max(med * 1.45, l.size * 1.6);
      const isHead = headSizes.includes(l.size) && l.size >= body * 1.15;
      if (isHead) {
        if (cur && cur.kind === 'h' && cur.size === l.size && near) cur.lines.push(l.text);
        else blocks.push({ kind: 'h', level: level(l.size), lines: [l.text], size: l.size, x: l.x, marker: '' });
        return;
      }
      const b = BULLET.exec(l.text), num = NUMBERED.exec(l.text);
      if (b || num) {
        blocks.push({ kind: 'li', level: 0, lines: [l.text.slice((b ?? num)![0].length)], size: l.size, x: l.x, marker: num ? num[1] + '. ' : '- ' });
        return;
      }
      // Continuation: same size, normal spacing; list items continue only on lines indented past the bullet.
      if (cur && cur.kind !== 'h' && near && Math.abs(cur.size - l.size) <= Math.max(0.5, l.size * 0.1) && (cur.kind === 'p' || l.x > cur.x + 1)) {
        cur.lines.push(l.text);
        return;
      }
      blocks.push({ kind: 'p', level: 0, lines: [l.text], size: l.size, x: l.x, marker: '' });
    });

    const parts: string[] = [];
    blocks.forEach((b, i) => {
      const text = reflowPara(b.lines);
      if (b.kind === 'h') { headings++; parts.push('#'.repeat(b.level) + ' ' + text); }
      else if (b.kind === 'li') {
        const glue = blocks[i - 1]?.kind === 'li' ? '\n' : '';
        parts.push(glue + b.marker + text);
      } else parts.push(text.replace(/^(#{1,6}\s|\d+[.)]\s|[-+*]\s|>)/, '\\$1'));
    });
    // List items of one list sit on consecutive lines; everything else is separated by a blank line.
    out.push(parts.reduce((s, p) => (!s ? p : p.startsWith('\n') ? s + p : s + '\n\n' + p), '') || '_(no text on this page)_');
  });
  return { markdown: tidyMd(out.join('\n\n')), headings, bodySize: body };
}

async function pageLines(doc: PdfJsDoc, n: number) {
  const page = await doc.getPage(n);
  try {
    const vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent(), U = (await pdfjs()).Util;
    const items = (tc.items as { str?: string; transform: number[]; width: number; height: number; dir: string }[])
      .filter((it) => typeof it.str === 'string')
      .map((it) => {
        const m = U.transform(vp.transform, it.transform), hh = Math.hypot(m[2], m[3]) || it.height || 10, horiz = Math.abs(m[1]) < Math.abs(m[0]) * 0.2 || !m[0];
        return { str: it.str as string, x: m[4], y: m[5], w: horiz ? it.width : 0, h: hh, dir: it.dir };
      });
    return itemsToLines(items);
  } finally {
    page.cleanup();
  }
}

export default defineTool({
  name: 'ai_pdf_to_markdown',
  title: 'PDF to Markdown',
  description:
    'Convert a text PDF to structured Markdown: headings guessed from font size (text clearly larger than the body ' +
    'becomes #, ##, ###), paragraphs rebuilt from line spacing with hyphenated words mended, bullet and numbered lists ' +
    'kept, right-to-left lines in reading order. Optional page range ("1-5, 8") and page markers. Scanned PDFs without a ' +
    'text layer give empty pages (listed in pagesWithoutText; run OCR first). Tables and columns are read line by line. ' +
    'Accepts a local path or base64. Inline Markdown is cut at maxChars (default 200k); "output" saves it to a file.',
  inputSchema: z.object({
    file: fileInput('PDF'),
    pages: z.string().optional().describe('Pages to convert, e.g. "1-3, 7" or "5-" (1-based). Default: all.'),
    password: z.string().optional().describe('Password, if the PDF is protected.'),
    pageMarkers: z.boolean().optional().default(false).describe('Put "<!-- Page N -->" before each page and "---" between pages. Default false.'),
    maxChars: maxCharsInput(),
    output: mdOutputInput(),
  }),
  outputSchema: z.object({
    pageCount: z.number().describe('Pages in the PDF.'),
    pagesConverted: z.number(),
    pagesWithoutText: z.array(z.number()).describe('1-based pages with no text layer (probably scanned).'),
    headings: z.number().describe('Headings detected.'),
    bodyFontSize: z.number().describe('Font size (pt) taken as body text.'),
    ...mdOutputShape,
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'paper.pdf' } }, { input: { file: 'book.pdf', pages: '1-20', pageMarkers: true, output: 'book.md' } }],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, 'PDF');
    const doc = await loadPdfJs(f.bytes, input.password);
    try {
      const sel = parsePageRanges(input.pages, doc.numPages);
      const pages: { n: number; lines: PLine[] }[] = [];
      for (const i of sel) pages.push({ n: i + 1, lines: await pageLines(doc, i + 1) });
      const r = linesToMarkdown(pages, { pageMarkers: input.pageMarkers });
      const out = await emitMarkdown(r.markdown, { output: input.output, maxChars: input.maxChars, defaultName: stemOf(f, 'document') + '.md' }, ctx);
      return {
        pageCount: doc.numPages,
        pagesConverted: pages.length,
        pagesWithoutText: pages.filter((p) => !p.lines.length).map((p) => p.n),
        headings: r.headings,
        bodyFontSize: r.bodySize,
        ...out,
      };
    } finally {
      try { await doc.loadingTask.destroy(); } catch { /* already closed */ }
    }
  },
});

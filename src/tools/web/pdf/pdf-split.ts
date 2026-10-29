import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PDFDocument } from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputDir, safeName } from '../../../util/files.js';
import { baseName, fileInput, openPdf, outputPath, parseRangeGroups, pdfFileOutput, returnBase64, savePdf, toRangeText } from './_common.js';

// Ported from https://github.com/s3eidat/pdf-split (app.js): same plans and file names as the website.
export type SplitMode = 'extract' | 'ranges' | 'every' | 'single';

export function plan(mode: SplitMode, n: number, opt: { sel?: string; ranges?: string; every?: number }) {
  if (mode === 'extract') {
    const pages: number[] = [];
    parseRangeGroups(opt.sel, n).forEach((g) => g.pages.forEach((p) => { if (!pages.includes(p)) pages.push(p); }));
    return [{ name: 'pages-' + toRangeText(pages).replace(/\s+/g, '').replace(/,/g, '_'), pages }];
  }
  if (mode === 'ranges') return parseRangeGroups(opt.ranges, n).map((g) => ({ name: 'pages-' + g.label, pages: g.pages }));
  if (mode === 'every') {
    const k = Math.max(1, Math.floor(+(opt.every ?? 1)) || 1), out: { name: string; pages: number[] }[] = [], w = String(Math.ceil(n / k)).length;
    for (let i = 0; i < n; i += k) {
      out.push({ name: 'part-' + String(out.length + 1).padStart(Math.max(2, w), '0'), pages: Array.from({ length: Math.min(k, n - i) }, (_, x) => i + x) });
    }
    return out;
  }
  const w = Math.max(3, String(n).length);
  return Array.from({ length: n }, (_, i) => ({ name: 'page-' + String(i + 1).padStart(w, '0'), pages: [i] }));
}

export async function build(src: PDFDocument, pages: number[]) {
  const out = await PDFDocument.create();
  (await out.copyPages(src, pages)).forEach((p) => out.addPage(p));
  out.setProducer('S3eidat Tools PDF Split');
  return out.save();
}

const split = defineTool({
  name: 'pdf_split',
  title: 'Split PDF',
  webSlug: 'pdf-split',
  description:
    'Split one PDF into several PDFs written to a folder: by page ranges (one file per range, e.g. "1-3, 4-6, 7-"), every ' +
    'N pages, or one file per page. Files are named like the website: <name>-pages-1-3.pdf, <name>-part-01.pdf, ' +
    `<name>-page-001.pdf. Use pdf_extract_pages to get a single PDF with chosen pages. Web version: ${webUrl('pdf-split')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    mode: z.enum(['ranges', 'every', 'single']).describe('"ranges": one PDF per range in `ranges`; "every": a new PDF every `every` pages; "single": one PDF per page.'),
    ranges: z.string().optional().describe('For mode "ranges": comma-separated ranges, each becomes one PDF, e.g. "1-3, 4-6, 7-".'),
    every: z.number().int().min(1).optional().describe('For mode "every": pages per file (e.g. 2 makes 1-2, 3-4…).'),
    output: z.string().optional().describe('Folder to write the PDFs into (created if missing). Default: a new folder in the server output folder.'),
  }),
  outputSchema: z.object({
    folder: z.string().describe('Folder the PDFs were written to.'),
    files: z.array(z.object({ path: z.string(), bytes: z.number(), pages: z.array(z.number()).describe('1-based source pages in this file.') })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'book.pdf', mode: 'ranges', ranges: '1-10, 11-20, 21-' }, note: 'three PDFs' },
    { input: { file: 'scans.pdf', mode: 'every', every: 2 } },
  ],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    if (input.mode === 'ranges' && !input.ranges?.trim()) throw new ToolError('Give "ranges" for mode "ranges", e.g. "1-3, 4-6".');
    if (input.mode === 'every' && !input.every) throw new ToolError('Give "every" (pages per file) for mode "every".');
    const parts = plan(input.mode, doc.getPageCount(), { ranges: input.ranges, every: input.every });
    if (parts.length > 5000) throw new ToolError(`That would make ${parts.length} files; the limit is 5000.`);
    const base = baseName(f), dir = await outputDir(input.output, base + '-split', ctx), files = [];
    for (const p of parts) {
      const data = await build(doc, p.pages), path = join(dir, safeName(base + '-' + p.name.slice(0, 80) + '.pdf'));
      await writeFile(path, data);
      files.push({ path, bytes: data.length, pages: p.pages.map((i) => i + 1) });
    }
    return { folder: dir, files };
  },
});

const extract = defineTool({
  name: 'pdf_extract_pages',
  title: 'Extract PDF pages',
  webSlug: 'pdf-split',
  description:
    'Make one new PDF from selected pages of a PDF, e.g. "1-3, 7, 10-" (order as written, each page once). The rest of the ' +
    `file is left out. To reorder, duplicate or delete pages use pdf_organize. Web version: ${webUrl('pdf-split')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    pages: z.string().min(1).describe('Pages to keep: "1-3, 7, 10-" ("5-" = to the end; also "odd", "even", "last").'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...pdfFileOutput, pages: z.array(z.number()).describe('1-based source pages, in output order.') }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'report.pdf', pages: '1-3, 7' }, note: 'writes report-pages-1-3_7.pdf' }],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    const [part] = plan('extract', doc.getPageCount(), { sel: input.pages });
    const w = await savePdf(await build(doc, part.pages), { output: input.output, defaultName: baseName(f) + '-' + part.name.slice(0, 80), returnBase64: input.returnBase64 }, ctx);
    return { ...w, pages: part.pages.map((i) => i + 1) };
  },
});

export default [split, extract];

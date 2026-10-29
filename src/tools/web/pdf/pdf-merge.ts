import { z } from 'zod';
import { PDFDocument } from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, openPdf, outputPath, parseRangeList, pdfFileOutput, returnBase64, savePdf } from './_common.js';

// Ported from https://github.com/s3eidat/pdf-merge (app.js): pdf-lib copies pages between documents.
export async function mergeDocs(list: { doc: PDFDocument; pages: number[] }[]) {
  const out = await PDFDocument.create();
  for (const it of list) (await out.copyPages(it.doc, it.pages)).forEach((pg) => out.addPage(pg));
  out.setProducer('S3eidat Tools PDF Merge');
  out.setCreator('S3eidat Tools');
  return out;
}

const item = z.union([
  fileInput('PDF'),
  z.object({
    file: fileInput('PDF'),
    pages: z.string().optional().describe('Pages to take from this file, e.g. "1-3, 5, 8-" or "3-1" (reversed). Empty = all.'),
  }),
]);

export default defineTool({
  name: 'pdf_merge',
  title: 'Merge PDFs',
  webSlug: 'pdf-merge',
  description:
    'Combine several PDFs into one, in the order given. Each entry can be a file (path or base64) or {file, pages} to take ' +
    'only some pages ("1-3, 5, 8-"; "3-1" keeps reverse order; a page can repeat). Password-protected PDFs must be ' +
    `unlocked first. Web version: ${webUrl('pdf-merge')}`,
  inputSchema: z.object({
    files: z.array(item).min(1).max(500).describe('PDFs to merge, in order: a path/base64 string, or {file, pages}.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfFileOutput,
    pages: z.number().describe('Pages in the merged PDF.'),
    sources: z.array(z.object({ name: z.string(), pages: z.number(), used: z.number() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { files: ['report.pdf', { file: 'appendix.pdf', pages: '2-4' }], output: 'merged.pdf' }, note: 'report + pages 2-4 of the appendix' },
  ],
  async run(input, ctx) {
    const list: { doc: PDFDocument; pages: number[] }[] = [];
    const sources: { name: string; pages: number; used: number }[] = [];
    for (let i = 0; i < input.files.length; i++) {
      const it = input.files[i], file = typeof it === 'string' ? it : it.file, range = typeof it === 'string' ? '' : it.pages;
      const label = `File ${i + 1}`;
      const { input: f, doc } = await openPdf(file, ctx, label);
      let pages: number[];
      try { pages = parseRangeList(range, doc.getPageCount()); }
      catch (e) { throw new ToolError(`${label} (${f.name}): ${(e as Error).message}`); }
      list.push({ doc, pages });
      sources.push({ name: f.name, pages: doc.getPageCount(), used: pages.length });
    }
    const out = await mergeDocs(list);
    const w = await savePdf(out, { output: input.output, defaultName: 'merged.pdf', returnBase64: input.returnBase64 }, ctx);
    return { ...w, pages: out.getPageCount(), sources };
  },
});

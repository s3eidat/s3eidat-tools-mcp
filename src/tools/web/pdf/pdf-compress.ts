import { z } from 'zod';
import { PDFDocument } from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { readInput } from '../../../util/files.js';
import { loadPdfJs, type PdfJsDoc } from '../../../util/pdf.js';
import { closeJs, fileInput, outputPath, pdfFileOutput, renderToCanvas, returnBase64, savePdf } from './_common.js';

// Ported from https://github.com/s3eidat/pdf-compress (app.js): every page is rendered by pdf.js and rebuilt as a
// JPEG page by pdf-lib, with the same presets, pixel budget and verdict as the website.
export const PRESETS = { email: { dpi: 96, q: 55 }, balanced: { dpi: 144, q: 72 }, high: { dpi: 220, q: 85 } } as const;
const MAX_PX = 25e6; // per page

export function scaleFor(vp1: { width: number; height: number }, dpi: number) {
  let s = dpi / 72;
  const px = vp1.width * vp1.height * s * s;
  if (px > MAX_PX) s *= Math.sqrt(MAX_PX / px);
  return s;
}

export function verdict(before: number, after: number) {
  return after >= before ? 'bigger' : 1 - after / before < 0.05 ? 'same' : 'smaller';
}

type Canvas = Awaited<ReturnType<typeof renderToCanvas>>;
function toGray(c: Canvas) {
  const x = c.getContext('2d'), im = x.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = d[i + 1] = d[i + 2] = g; }
  x.putImageData(im, 0, 0);
}

export async function compress(js: PdfJsDoc, opt: { dpi: number; q: number; gray?: boolean }) {
  const out = await PDFDocument.create();
  for (let i = 1; i <= js.numPages; i++) {
    const page = await js.getPage(i), vp1 = page.getViewport({ scale: 1 });
    const c = await renderToCanvas(page, scaleFor(vp1, opt.dpi));
    if (opt.gray) toGray(c);
    const img = await out.embedJpg(await c.encode('jpeg', opt.q));
    out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    page.cleanup();
  }
  try {
    const m = await js.getMetadata(), info = m.info as Record<string, unknown> | undefined;
    if (info?.Title) out.setTitle(String(info.Title));
    if (info?.Author) out.setAuthor(String(info.Author));
  } catch { /* no info */ }
  out.setProducer('S3eidat Tools PDF Compress');
  out.setCreator('S3eidat Tools');
  return out.save();
}

export default defineTool({
  name: 'pdf_compress',
  title: 'Compress PDF',
  webSlug: 'pdf-compress',
  description:
    'Shrink a PDF by re-rendering every page as a JPEG image (best for scans and photo-heavy files). Presets like the ' +
    'website: email (96 DPI, quality 55), balanced (144 DPI, 72), high (220 DPI, 85); or set dpi/quality yourself; ' +
    'optional grayscale. The result loses selectable text, links and form fields. Reports before/after size and a verdict ' +
    '("bigger" means keep the original: the PDF was already efficient). Web version: ' + webUrl('pdf-compress'),
  inputSchema: z.object({
    file: fileInput('PDF'),
    preset: z.enum(['email', 'balanced', 'high']).optional().default('balanced').describe('Quality preset. Default "balanced".'),
    dpi: z.number().int().min(36).max(300).optional().describe('Override the preset resolution (36-300 DPI).'),
    quality: z.number().int().min(30).max(95).optional().describe('Override the preset JPEG quality (30-95).'),
    grayscale: z.boolean().optional().default(false).describe('Convert pages to grayscale.'),
    password: z.string().optional().describe('Password, if the PDF is protected.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfFileOutput,
    pages: z.number(),
    before: z.number().describe('Original size in bytes.'),
    after: z.number().describe('Compressed size in bytes.'),
    percentSmaller: z.number().describe('How much smaller, in % (negative when bigger).'),
    verdict: z.enum(['smaller', 'same', 'bigger']).describe('"same" = under 5% saved; "bigger" = keep the original.'),
    dpi: z.number(),
    quality: z.number(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'scan.pdf', preset: 'email' }, note: 'small enough to attach to an email' }],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, 'PDF');
    const js = await loadPdfJs(f.bytes, input.password);
    try {
      if (js.numPages > 2000) throw new ToolError(`This PDF has ${js.numPages} pages; the limit is 2000.`);
      const p = PRESETS[input.preset], dpi = input.dpi ?? p.dpi, q = input.quality ?? p.q;
      const out = await compress(js, { dpi, q, gray: input.grayscale });
      const base = f.path ? f.name.replace(/\.pdf$/i, '') || 'document' : 'document';
      const w = await savePdf(out, { output: input.output, defaultName: base + '-compressed.pdf', returnBase64: input.returnBase64 }, ctx);
      const before = f.bytes.length, after = out.length;
      return { ...w, pages: js.numPages, before, after, percentSmaller: Math.round((1 - after / before) * 100), verdict: verdict(before, after), dpi, quality: q };
    } finally {
      await closeJs(js);
    }
  },
});

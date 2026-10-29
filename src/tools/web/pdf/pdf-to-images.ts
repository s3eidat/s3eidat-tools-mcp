import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputDir, readInput } from '../../../util/files.js';
import { loadPdfJs, type PdfJsDoc } from '../../../util/pdf.js';
import { closeJs, fileInput, pagesSpec, parseRangeSet, renderToCanvas } from './_common.js';

// Ported from https://github.com/s3eidat/pdf-to-images (app.js): same scale cap, sizes (floored) and file names.
const MAX_PIXELS = 16777216, MAX_SIDE = 16384;
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;

/** Shrink only when the image would be too big (same caps as the website). */
export function fitScale(w: number, hh: number, scale: number) {
  const k = Math.min(1, MAX_SIDE / (w * scale), MAX_SIDE / (hh * scale), Math.sqrt(MAX_PIXELS / (w * scale * hh * scale)));
  return { scale: scale * k, capped: k < 1 };
}

export async function renderPage(js: PdfJsDoc, i: number, opt: { dpi: number; fmt: 'png' | 'jpeg' | 'webp'; quality: number; transparent?: boolean }) {
  const page = await js.getPage(i + 1), v1 = page.getViewport({ scale: 1 });
  const f = fitScale(v1.width, v1.height, opt.dpi / 72);
  const c = await renderToCanvas(page, f.scale, { transparent: !!opt.transparent && opt.fmt !== 'jpeg', round: 'floor' });
  const data = opt.fmt === 'png' ? await c.encode('png') : await c.encode(opt.fmt, opt.quality);
  page.cleanup();
  return { i, w: c.width, h: c.height, data: Buffer.from(data), capped: f.capped };
}

export default defineTool({
  name: 'pdf_to_images',
  title: 'PDF to images',
  webSlug: 'pdf-to-images',
  description:
    'Render PDF pages to PNG, JPEG or WebP images in a folder (one file per page, named <name>-p001.png…). Choose the DPI ' +
    '(72 = screen size, 150 = default, 300 = print), JPEG/WebP quality, a page range, and a transparent background for ' +
    'PNG/WebP. Very large pages are capped at 16384 px a side / 16.7 megapixels, like the website. Web version: ' +
    webUrl('pdf-to-images'),
  inputSchema: z.object({
    file: fileInput('PDF'),
    format: z.enum(['png', 'jpeg', 'webp']).optional().default('png').describe('Image format. Default "png".'),
    dpi: z.number().min(18).max(1200).optional().default(150).describe('Resolution in dots per inch. Default 150.'),
    quality: z.number().int().min(1).max(100).optional().default(90).describe('JPEG/WebP quality 1-100. Default 90.'),
    transparent: z.boolean().optional().default(false).describe('Keep the page background transparent (PNG/WebP only).'),
    pages: pagesSpec('Pages to render'),
    password: z.string().optional().describe('Password, if the PDF is protected.'),
    output: z.string().optional().describe('Folder to write the images into (created if missing). Default: a new folder in the server output folder.'),
  }),
  outputSchema: z.object({
    folder: z.string(),
    files: z.array(z.object({ page: z.number(), path: z.string(), bytes: z.number(), width: z.number(), height: z.number(), capped: z.boolean() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'slides.pdf', format: 'jpeg', dpi: 96, pages: '1-5' } },
    { input: { file: 'logo.pdf', format: 'png', dpi: 300, transparent: true } },
  ],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, 'PDF');
    const js = await loadPdfJs(f.bytes, input.password);
    try {
      const pages = [...parseRangeSet(input.pages, js.numPages)];
      if (pages.length > 5000) throw new ToolError(`That is ${pages.length} pages; render at most 5000 at a time.`);
      const base = f.path ? f.name.replace(/\.pdf$/i, '') || 'document' : 'document';
      const dir = await outputDir(input.output, base + '-images', ctx), pad = Math.max(3, String(js.numPages).length), files = [];
      for (const i of pages) {
        const r = await renderPage(js, i, { dpi: input.dpi, fmt: input.format, quality: input.quality, transparent: input.transparent });
        const path = join(dir, `${base}-p${String(i + 1).padStart(pad, '0')}.${EXT[input.format]}`);
        await writeFile(path, r.data);
        files.push({ page: i + 1, path, bytes: r.data.length, width: r.w, height: r.h, capped: r.capped });
      }
      return { folder: dir, files };
    } finally {
      await closeJs(js);
    }
  },
});

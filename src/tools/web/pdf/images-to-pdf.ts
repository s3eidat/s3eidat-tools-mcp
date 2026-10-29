import { z } from 'zod';
import { PDFDocument } from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { readInput } from '../../../util/files.js';
import { fileInput, outputPath, pdfFileOutput, returnBase64, savePdf } from './_common.js';

// Ported from https://github.com/s3eidat/images-to-pdf (app.js): same page sizes, margins, fit and quality presets.
// The browser canvas is replaced by sharp (EXIF auto-orientation, resizing, JPEG/PNG encoding).
export const MM = 72 / 25.4;
const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const QUALITY = { original: null, high: { q: 0.9, max: 3000 }, medium: { q: 0.75, max: 2000 }, small: { q: 0.6, max: 1400 } } as const;
export type Quality = keyof typeof QUALITY;
export interface PageOpt { size: 'a4' | 'letter' | 'fit'; orient: 'auto' | 'portrait' | 'landscape'; margin: number }

/** EXIF orientation (1-8) of a JPEG, 1 when absent. */
export function exifOrientation(b: Uint8Array) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) return 1;
    const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10, le = b[t] === 0x49;
      const u16 = (p: number) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
      const u32 = (p: number) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 16777216 : b[p] * 16777216 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]));
      const ifd = t + u32(t + 4), n = u16(ifd);
      for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (e + 10 > b.length) break; if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; } }
      return 1;
    }
    if (marker === 0xda) return 1; // image data starts: no EXIF before it
    i += 2 + len;
  }
  return 1;
}

export function sniff(b: Uint8Array) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  return 'other';
}

export interface Prepared { kind: 'png' | 'jpg'; bytes: Uint8Array; w: number; h: number }

/** Turn one image into embeddable bytes (website `prepare`). */
export async function prepare(bytes: Buffer, rot: number, quality: Quality, name = 'image'): Promise<Prepared> {
  const sharp = (await import('sharp')).default;
  const kind = sniff(bytes), q = QUALITY[quality];
  let meta;
  try { meta = await sharp(bytes, { failOn: 'none' }).metadata(); } catch { throw new ToolError(`Can't read ${name} as an image.`); }
  if (!q && !rot && kind === 'png') return { kind: 'png', bytes, w: meta.width!, h: meta.height! };
  if (!q && !rot && kind === 'jpg' && exifOrientation(bytes) === 1) return { kind: 'jpg', bytes, w: meta.width!, h: meta.height! };
  // decode (EXIF-oriented, like createImageBitmap), scale for the quality preset
  const oriented = await sharp(bytes, { failOn: 'none', limitInputPixels: 4e8 }).autoOrient().png().toBuffer({ resolveWithObject: true });
  const sw = oriented.info.width, sh = oriented.info.height, k = q ? Math.min(1, q.max / Math.max(sw, sh)) : 1;
  const w = Math.max(1, Math.round(sw * k)), hh = Math.max(1, Math.round(sh * k));
  let img = sharp(oriented.data);
  if (w !== sw || hh !== sh) img = sharp(await img.resize(w, hh, { fit: 'fill' }).png().toBuffer());
  if (rot) img = sharp(await img.rotate(rot).png().toBuffer());
  const alpha = !q && kind !== 'jpg' && (await hasAlpha(oriented.data));
  if (alpha) {
    const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
    return { kind: 'png', bytes: data, w: info.width, h: info.height };
  }
  const { data, info } = await img.flatten({ background: '#ffffff' }).jpeg({ quality: Math.round((q ? q.q : 0.92) * 100) }).toBuffer({ resolveWithObject: true });
  return { kind: 'jpg', bytes: data, w: info.width, h: info.height };
}

/** Any pixel (sampled at 64x64, like the website) less than ~98% opaque. */
async function hasAlpha(png: Buffer) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(png).resize(64, 64, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = info.channels - 1; i < data.length; i += info.channels) if (data[i] < 250) return true;
  return false;
}

/** Page geometry in points. */
export function pageFor(w: number, hh: number, opt: PageOpt) {
  const m = opt.margin * MM;
  let pw: number, ph: number;
  if (opt.size === 'fit') {
    const k = Math.min(0.75, 14000 / Math.max(w, hh)); // 96 dpi, capped below the PDF page limit
    pw = w * k + 2 * m; ph = hh * k + 2 * m;
  } else {
    const s = SIZES[opt.size], land = opt.orient === 'landscape' || (opt.orient === 'auto' && w > hh);
    pw = land ? s[1] : s[0]; ph = land ? s[0] : s[1];
  }
  const aw = Math.max(1, pw - 2 * m), ah = Math.max(1, ph - 2 * m), sc = Math.min(aw / w, ah / hh);
  const dw = w * sc, dh = hh * sc;
  return { pw, ph, x: (pw - dw) / 2, y: (ph - dh) / 2, w: dw, h: dh };
}

export async function build(prepared: Prepared[], opt: PageOpt) {
  const doc = await PDFDocument.create();
  for (const im of prepared) {
    const img = im.kind === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    const g = pageFor(im.w, im.h, opt);
    doc.addPage([g.pw, g.ph]).drawImage(img, { x: g.x, y: g.y, width: g.w, height: g.h });
  }
  doc.setProducer('S3eidat Tools Images to PDF');
  doc.setCreator('S3eidat Tools');
  return doc;
}

const imageItem = z.union([
  fileInput('image'),
  z.object({ file: fileInput('image'), rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe('Turn this image clockwise first.') }),
]);

export default defineTool({
  name: 'pdf_from_images',
  title: 'Images to PDF',
  webSlug: 'images-to-pdf',
  description:
    'Make a PDF from images (JPEG, PNG, WebP, GIF, TIFF, AVIF, SVG…), one image per page, in the order given. Page size ' +
    'A4, Letter, or "fit" (page = image size at 96 dpi); orientation auto/portrait/landscape; margin in mm; quality ' +
    '"original" (JPEG/PNG kept as-is), high (≤3000 px, JPEG 90), medium (≤2000 px, 75) or small (≤1400 px, 60). Photos are ' +
    `turned upright from their EXIF orientation. Web version: ${webUrl('images-to-pdf')}`,
  inputSchema: z.object({
    images: z.array(imageItem).min(1).max(1000).describe('Images in page order: path/base64 strings, or {file, rotate}.'),
    pageSize: z.enum(['a4', 'letter', 'fit']).optional().default('a4').describe('Page size. Default "a4".'),
    orientation: z.enum(['auto', 'portrait', 'landscape']).optional().default('auto').describe('"auto" turns the page to match each image. Ignored for "fit".'),
    margin: z.number().min(0).max(50).optional().default(10).describe('Margin around each image in mm. Default 10.'),
    quality: z.enum(['original', 'high', 'medium', 'small']).optional().default('high').describe('Image quality / size trade-off. Default "high".'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...pdfFileOutput, pages: z.number() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { images: ['receipt1.jpg', 'receipt2.jpg'], output: 'receipts.pdf' } },
    { input: { images: ['scan.png', { file: 'photo.jpg', rotate: 90 }], pageSize: 'fit', margin: 0, quality: 'original' } },
  ],
  async run(input, ctx) {
    const prepared: Prepared[] = [];
    for (let i = 0; i < input.images.length; i++) {
      const it = input.images[i], file = typeof it === 'string' ? it : it.file, rot = typeof it === 'string' ? 0 : it.rotate ?? 0;
      const f = await readInput(file, ctx, `Image ${i + 1}`);
      prepared.push(await prepare(f.bytes, rot, input.quality, f.name));
    }
    const doc = await build(prepared, { size: input.pageSize, orient: input.orientation, margin: input.margin });
    const w = await savePdf(doc, { output: input.output, defaultName: 'images.pdf', returnBase64: input.returnBase64 }, ctx);
    return { ...w, pages: doc.getPageCount() };
  },
});

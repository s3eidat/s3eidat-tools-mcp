import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { fileInput, outputPath, returnBase64, writeOutput } from '../../../util/files.js';
import { encode, fit, fmtBytes, imageOutputShape, keepFormat, loadImg, MIME, outName, pipe, type Img, type OutFormat } from './_img.js';

// Port of https://github.com/s3eidat/image-squeeze (app.js): optional downscale, re-encode, keep the original if smaller.

/** Percent saved, rounded (the website's pct()). */
export const pct = (a: number, b: number) => Math.round((1 - b / a) * 100);

async function squeezeAt(img: Img, size: { w: number; h: number }, fmt: OutFormat, quality: number) {
  let s = pipe(img);
  if (size.w !== img.width || size.h !== img.height) s = s.resize(size.w, size.h, { fit: 'fill', kernel: 'lanczos3' });
  return encode(s, fmt, quality, { best: true }).toBuffer();
}

export default defineTool({
  name: 'image_compress',
  title: 'Compress image',
  webSlug: 'image-squeeze',
  description:
    'Make an image file smaller: re-encode at a quality (default 80) and optionally cap the longest side (maxSide), as JPEG, WebP, AVIF ' +
    'or PNG ("keep" = same format; GIF/BMP/TIFF become PNG). Or give targetBytes to find the highest quality that fits that size. ' +
    'With keepSmaller (default on) the original is kept when re-encoding would not make it smaller. Reports before/after sizes and % saved. ' +
    'Transparent areas become white in JPEG. Metadata (EXIF, GPS) is not copied. PNG is lossless (quality ignored). ' +
    `Web version: ${webUrl('image-squeeze')}`,
  inputSchema: z.object({
    image: fileInput('image'),
    format: z.enum(['keep', 'jpeg', 'webp', 'avif', 'png']).optional().default('keep').describe('Output format. Default keep (same as the input).'),
    quality: z.number().int().min(1).max(100).optional().default(80).describe('Quality 1-100 for JPEG / WebP / AVIF. Default 80 (website default).'),
    maxSide: z.number().int().min(1).max(16384).optional().describe('Scale down so the longest side is at most this many pixels (e.g. 1920).'),
    targetBytes: z
      .number()
      .int()
      .min(100)
      .optional()
      .describe('Aim for a file of at most this many bytes: searches the highest quality that fits (lossy formats only; overrides quality).'),
    keepSmaller: z.boolean().optional().default(true).describe('Keep the original bytes when the result would be larger (same format and size only). Default true.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...imageOutputShape,
    inputBytes: z.number().describe('Size of the input file.'),
    savedBytes: z.number().describe('Bytes saved (negative when the file grew).'),
    savedPercent: z.number().describe('Percent saved, rounded.'),
    quality: z.number().optional().describe('Quality used (lossy formats).'),
    kept: z.boolean().describe('True when the original was kept because it was already smaller.'),
    targetReached: z.boolean().optional().describe('With targetBytes: whether the target was met.'),
    summary: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/photos/IMG_0042.jpg', quality: 75, maxSide: 1920 } },
    { input: { image: '/site/hero.png', format: 'webp', targetBytes: 150000 }, note: 'Highest WebP quality that fits 150 KB.' },
  ],
  async run(input, ctx) {
    const img = await loadImg(input.image, ctx);
    const fmt: OutFormat = input.format === 'keep' ? keepFormat(img, ['jpeg', 'png', 'webp', 'avif']) : input.format;
    const size = fit(img.width, img.height, input.maxSide ?? 0);
    const lossy = fmt !== 'png';
    let quality = input.quality;
    let buf: Buffer;
    let targetReached: boolean | undefined;
    if (input.targetBytes && lossy) {
      // Binary search: the highest quality whose file fits the target.
      let lo = 1;
      let hi = 100;
      let best: { q: number; buf: Buffer } | undefined;
      let smallest: { q: number; buf: Buffer } | undefined;
      while (lo <= hi) {
        const q = (lo + hi) >> 1;
        const b = await squeezeAt(img, size, fmt, q);
        if (!smallest || b.length < smallest.buf.length) smallest = { q, buf: b };
        if (b.length <= input.targetBytes) {
          best = { q, buf: b };
          lo = q + 1;
        } else hi = q - 1;
      }
      const pick = best ?? smallest!;
      quality = pick.q;
      buf = pick.buf;
      targetReached = !!best;
    } else {
      buf = await squeezeAt(img, size, fmt, quality);
      if (input.targetBytes) targetReached = buf.length <= input.targetBytes;
    }
    const sameFormat = fmt === img.format && !img.svg && !img.raw;
    const kept = input.keepSmaller && sameFormat && !size.scaled && size.w === img.width && size.h === img.height && img.orientation <= 1 && buf.length >= img.bytes.length;
    if (kept) buf = img.bytes;
    const out = await writeOutput(buf, { output: input.output, defaultName: outName(img.name, fmt), mimeType: MIME[fmt], base64: input.returnBase64 }, ctx);
    const p = pct(img.bytes.length, out.bytes);
    const summary =
      `${fmtBytes(img.bytes.length)} → ${fmtBytes(out.bytes)} (${p > 0 ? '−' + p + '%' : p < 0 ? '+' + -p + '%' : '0%'})` +
      (img.width === size.w ? ` · ${size.w}×${size.h}` : ` · ${img.width}×${img.height} → ${size.w}×${size.h}`) +
      ` · ${fmt.toUpperCase()}` +
      (kept ? ' · original kept' : '') +
      (size.note ? ' · ' + size.note : '') +
      (targetReached === false ? ' · target size not reached' : '');
    return {
      ...out,
      width: size.w,
      height: size.h,
      format: fmt,
      inputBytes: img.bytes.length,
      savedBytes: img.bytes.length - out.bytes,
      savedPercent: p,
      ...(lossy && !kept ? { quality } : {}),
      kept,
      ...(targetReached != null ? { targetReached } : {}),
      summary,
    };
  },
});

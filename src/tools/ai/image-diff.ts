import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import { fileInput, outputPath, readInput, returnBase64, writeOutput } from '../../util/files.js';

const MAX_PIXELS = 50e6;

export default defineTool({
  name: 'ai_image_diff',
  title: 'Compare two images',
  description:
    'Compare two images pixel by pixel (pixelmatch, anti-aliasing aware) and write a diff PNG with changed pixels in red over a faded copy of the first image. ' +
    'Returns the number and percentage of different pixels. Images must be the same size unless resize is true (the second is stretched to the first\'s size). ' +
    `Reads PNG, JPEG, WebP, AVIF, GIF (first frame), TIFF and SVG; file path or base64; up to ${MAX_PIXELS / 1e6} MP. Good for visual regression checks.`,
  inputSchema: z.object({
    a: fileInput('first (reference) image'),
    b: fileInput('second image'),
    threshold: z.number().min(0).max(1).optional().default(0.1).describe('Colour difference tolerance 0..1; smaller is stricter. Default 0.1.'),
    includeAA: z.boolean().optional().default(false).describe('Count anti-aliased edge pixels as differences too. Default false.'),
    resize: z.boolean().optional().default(false).describe('Resize the second image to the first one\'s size when they differ (otherwise that is an error).'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    path: z.string().describe('The diff PNG.'), bytes: z.number(), mimeType: z.string().optional(), base64: z.string().optional(),
    width: z.number(), height: z.number(),
    diffPixels: z.number(), totalPixels: z.number(), percent: z.number().describe('Share of different pixels, 0..100 (4 decimals).'),
    identical: z.boolean(), resized: z.boolean(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { a: 'before.png', b: 'after.png', threshold: 0.1 }, note: 'Writes before-diff.png and returns the changed pixel count.' }],
  async run(input, ctx) {
    const { default: sharp } = await import('sharp');
    const { default: pixelmatch } = await import('pixelmatch');
    const fa = await readInput(input.a, ctx, 'a');
    const fb = await readInput(input.b, ctx, 'b');
    const meta = async (buf: Buffer, label: string) => {
      try {
        const m = await sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate().metadata();
        const o = m.orientation ?? 1, swap = o >= 5;
        return { w: (swap ? m.height : m.width) ?? 0, h: (swap ? m.width : m.height) ?? 0 };
      } catch (e) {
        throw new ToolError(`${label}: can't read this image (${e instanceof Error ? e.message : String(e)}).`);
      }
    };
    const ma = await meta(fa.bytes, 'a'), mb = await meta(fb.bytes, 'b');
    if (ma.w * ma.h > MAX_PIXELS) throw new ToolError(`Image a is ${ma.w}×${ma.h}; the limit is ${MAX_PIXELS / 1e6} MP.`);
    let resized = false;
    if (ma.w !== mb.w || ma.h !== mb.h) {
      if (!input.resize) throw new ToolError(`The images differ in size (${ma.w}×${ma.h} vs ${mb.w}×${mb.h}). Pass resize: true to scale the second to the first.`);
      resized = true;
    }
    const raw = async (buf: Buffer) => {
      let s = sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate();
      if (resized) s = s.resize(ma.w, ma.h, { fit: 'fill' });
      const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== ma.w || info.height !== ma.h) throw new ToolError('Unexpected decoded size.');
      return data;
    };
    const [pa, pb] = [await raw(fa.bytes), await raw(fb.bytes)];
    const diff = Buffer.alloc(ma.w * ma.h * 4);
    const diffPixels = pixelmatch(pa, pb, diff, ma.w, ma.h, { threshold: input.threshold, includeAA: input.includeAA });
    const png = await sharp(diff, { raw: { width: ma.w, height: ma.h, channels: 4 } }).png().toBuffer();
    const base = fa.path ? fa.name : 'image';
    const out = await writeOutput(png, { output: input.output, defaultName: base.replace(/\.[^.]*$/, '') + '-diff.png', mimeType: 'image/png', base64: input.returnBase64 }, ctx);
    const totalPixels = ma.w * ma.h;
    return {
      ...out, width: ma.w, height: ma.h, diffPixels, totalPixels,
      percent: Math.round((diffPixels / totalPixels) * 1e6) / 1e4, identical: diffPixels === 0, resized,
    };
  },
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl, type ToolContext } from '../../../registry.js';
import { fileInput, outputPath, returnBase64, writeOutput } from '../../../util/files.js';
import { encode, EXT, imageOutputShape, keepFormat, loadImg, MAX_AREA, MAX_SIDE, MIME, pipe, qualitySchema, stem, type Img, type OutFormat } from './_img.js';

// Port of https://github.com/s3eidat/image-resize (app.js): centre crop to a ratio, then a high-quality resize.

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ResizeOpts {
  mode: 'px' | 'pct';
  w: number | '';
  h: number | '';
  lock: boolean;
  anchor: 'w' | 'h';
  pct: number;
  ratio: 'free' | 'orig' | number | string;
}

// ---------- geometry (pure, same as the website) ----------
const r1 = (n: number) => Math.max(1, Math.round(n));
export function exact(o: ResizeOpts) {
  return o.mode === 'px' && !o.lock && +o.w > 0 && +o.h > 0;
}
/** Crop ratio in force: an exact W×H output forces W:H so nothing is ever stretched. */
export function ratioFor(o: ResizeOpts, iw: number, ih: number): number | null {
  if (exact(o)) return +o.w / +o.h;
  if (o.ratio === 'free') return null;
  if (o.ratio === 'orig') return iw / ih;
  return +o.ratio;
}
export function defaultCrop(iw: number, ih: number, ratio: number | null): Crop {
  if (!ratio) return { x: 0, y: 0, w: iw, h: ih };
  let w = iw;
  let h = iw / ratio;
  if (h > ih) {
    h = ih;
    w = ih * ratio;
  }
  w = Math.round(w);
  h = Math.round(h);
  return { x: Math.round((iw - w) / 2), y: Math.round((ih - h) / 2), w, h };
}
export function outSize(cw: number, ch: number, o: ResizeOpts) {
  if (o.mode === 'pct') return { w: r1((cw * o.pct) / 100), h: r1((ch * o.pct) / 100) };
  const W = +o.w || 0;
  const H = +o.h || 0;
  if (exact(o)) return { w: W, h: H };
  if (H && (o.anchor === 'h' || !W)) return { w: r1((H * cw) / ch), h: H };
  if (W) return { w: W, h: r1((W * ch) / cw) };
  return { w: cw, h: ch };
}
export function moveCrop(c: Crop, x: number, y: number, iw: number, ih: number): Crop {
  return { x: Math.round(Math.min(Math.max(0, x), iw - c.w)), y: Math.round(Math.min(Math.max(0, y), ih - c.h)), w: c.w, h: c.h };
}

/** The website's crop-ratio buttons and size presets. */
export const RATIOS: Record<string, number> = { '1:1': 1, '4:5': 0.8, '3:2': 1.5, '16:9': 1.7778, '9:16': 0.5625 };
export const PRESETS: Record<string, [number, number, string]> = {
  'instagram-post': [1080, 1080, 'Instagram post'],
  'instagram-portrait': [1080, 1350, 'Instagram portrait'],
  story: [1080, 1920, 'Story / Reels / TikTok'],
  'youtube-thumbnail': [1280, 720, 'YouTube thumbnail'],
  'x-header': [1500, 500, 'X (Twitter) header'],
  'facebook-cover': [851, 315, 'Facebook cover'],
  'linkedin-banner': [1584, 396, 'LinkedIn banner'],
  'full-hd': [1920, 1080, 'Full HD'],
  'passport-35x45': [413, 531, 'Passport 35×45 mm · 300 dpi'],
  'us-passport-2x2': [600, 600, 'US passport 2×2 in · 300 dpi'],
};

/** "16:9", "4:5", "1.5", "orig", "free" → the website's ratio value. */
export function parseRatio(v: string | number | undefined): 'free' | 'orig' | number {
  if (v == null || v === '' || v === 'free') return 'free';
  if (v === 'orig' || v === 'original') return 'orig';
  if (typeof v === 'number') return v;
  if (RATIOS[v]) return RATIOS[v];
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/×]\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
  const n = m ? +m[1] / +m[2] : +v;
  if (!(n > 0) || !isFinite(n)) throw new ToolError(`ratio: "${v}" is not a ratio (use e.g. 16:9, 4:5, 1.5, orig or free).`);
  return n;
}

const formatSchema = z
  .enum(['keep', 'jpeg', 'png', 'webp', 'avif'])
  .optional()
  .default('keep')
  .describe('Output format. "keep" = same as the input when it is JPEG/PNG/WebP (else PNG). Default keep.');
const ratioSchema = z
  .union([z.string(), z.number()])
  .optional()
  .describe('Aspect ratio as "W:H" (e.g. "1:1", "4:5", "3:2", "16:9", "9:16"), a number (width/height), "orig" or "free".');

async function render(img: Img, crop: Crop, size: { w: number; h: number }, fmt: OutFormat, quality: number) {
  if (size.w > MAX_SIDE || size.h > MAX_SIDE || size.w * size.h > MAX_AREA) {
    throw new ToolError(`Output ${size.w}×${size.h} is too large (limit ${MAX_SIDE} px a side, ${MAX_AREA / 1e6} MP).`);
  }
  let s = pipe(img);
  if (crop.x || crop.y || crop.w !== img.width || crop.h !== img.height) s = s.extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h });
  if (size.w !== crop.w || size.h !== crop.h) s = s.resize(size.w, size.h, { fit: 'fill', kernel: 'lanczos3' });
  return encode(s, fmt, quality, { best: true }).toBuffer();
}

async function save(img: Img, buf: Buffer, size: { w: number; h: number }, fmt: OutFormat, output: string | undefined, b64: boolean, ctx: ToolContext) {
  const name = `${stem(img.name)}-${size.w}x${size.h}.${EXT[fmt]}`;
  return writeOutput(buf, { output, defaultName: name, mimeType: MIME[fmt], base64: b64 }, ctx);
}

function cropSchema() {
  return z
    .object({
      x: z.number().int().min(0).describe('Left edge in pixels.'),
      y: z.number().int().min(0).describe('Top edge in pixels.'),
      width: z.number().int().min(1).describe('Width in pixels.'),
      height: z.number().int().min(1).describe('Height in pixels.'),
    })
    .describe('Crop box in pixels of the (auto-rotated) input.');
}

/** Clamp a user crop box inside the image (the website's moveCrop, with the size clamped first). */
function clampBox(b: { x: number; y: number; width: number; height: number }, iw: number, ih: number): Crop {
  const w = Math.min(Math.round(b.width), iw);
  const h = Math.min(Math.round(b.height), ih);
  return moveCrop({ x: 0, y: 0, w, h }, b.x, b.y, iw, ih);
}

const resize = defineTool({
  name: 'image_resize',
  title: 'Resize image',
  webSlug: 'image-resize',
  description:
    'Resize an image by pixels or percent, keeping the aspect ratio. Give width or height (the other side follows), or both: ' +
    'fit "cover" (default, as on the website) centre-crops to that ratio first so nothing is stretched, "contain" fits inside the box, ' +
    '"fill" stretches. Optional crop ratio (1:1, 4:5, 3:2, 16:9, 9:16, orig) or crop box before resizing, social-media presets, ' +
    `output JPEG/PNG/WebP/AVIF. Up to ${MAX_SIDE} px a side. Output name: <name>-<W>x<H>.<ext>. Web version: ${webUrl('image-resize')}`,
  inputSchema: z.object({
    image: fileInput('image'),
    width: z.number().int().min(1).max(MAX_SIDE).optional().describe('Target width in pixels.'),
    height: z.number().int().min(1).max(MAX_SIDE).optional().describe('Target height in pixels.'),
    percent: z.number().min(1).max(1000).optional().describe('Scale by percent instead (e.g. 50 halves both sides, 200 doubles).'),
    preset: z
      .enum(Object.keys(PRESETS) as [string, ...string[]])
      .optional()
      .describe('Exact output size preset: ' + Object.entries(PRESETS).map(([k, v]) => `${k} ${v[0]}×${v[1]}`).join(', ') + '.'),
    fit: z.enum(['cover', 'contain', 'fill']).optional().default('cover').describe('When both width and height are set: cover (crop to fill, default), contain (fit inside), fill (stretch).'),
    ratio: ratioSchema,
    crop: cropSchema().optional(),
    format: formatSchema,
    quality: qualitySchema(90),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...imageOutputShape, crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).describe('Region of the input that was used.') }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/photos/beach.jpg', width: 1080 }, note: 'Keeps the aspect ratio: 1600×900 → 1080×608.' },
    { input: { image: '/photos/beach.jpg', preset: 'instagram-post' }, note: 'Centre-crops to 1:1 and writes beach-1080x1080.jpg.' },
    { input: { image: '/photos/beach.jpg', percent: 50, format: 'webp' } },
  ],
  async run(input, ctx) {
    const img = await loadImg(input.image, ctx);
    let W = input.width;
    let H = input.height;
    if (input.preset) [W, H] = PRESETS[input.preset];
    const both = !!(W && H);
    const o: ResizeOpts = {
      mode: input.percent ? 'pct' : 'px',
      w: W ?? '',
      h: H ?? '',
      lock: !(both && input.fit === 'cover'),
      anchor: W ? 'w' : 'h',
      pct: input.percent ?? 100,
      ratio: parseRatio(input.ratio),
    };
    if (both && input.fit !== 'cover' && input.ratio == null) o.ratio = 'free';
    const crop = input.crop ? clampBox(input.crop, img.width, img.height) : defaultCrop(img.width, img.height, ratioFor(o, img.width, img.height));
    let size = outSize(crop.w, crop.h, o);
    if (both && !input.percent) {
      if (input.fit === 'fill') size = { w: W!, h: H! };
      else if (input.fit === 'contain') {
        const k = Math.min(W! / crop.w, H! / crop.h);
        size = { w: r1(crop.w * k), h: r1(crop.h * k) };
      }
    }
    const fmt: OutFormat = input.format === 'keep' ? keepFormat(img) : input.format;
    const buf = await render(img, crop, size, fmt, input.quality);
    const out = await save(img, buf, size, fmt, input.output, input.returnBase64, ctx);
    return { ...out, width: size.w, height: size.h, format: fmt, crop };
  },
});

const crop = defineTool({
  name: 'image_crop',
  title: 'Crop image',
  webSlug: 'image-resize',
  description:
    'Crop an image to a pixel box (x, y, width, height) or to an aspect ratio (1:1, 4:5, 3:2, 16:9, 9:16, "W:H" or a number), ' +
    'taking the largest centred region (or aligned to an edge with `position`). Boxes are kept inside the image. ' +
    `Output JPEG/PNG/WebP/AVIF, name <name>-<W>x<H>.<ext>. Web version: ${webUrl('image-resize')}`,
  inputSchema: z.object({
    image: fileInput('image'),
    x: z.number().int().min(0).optional().describe('Left edge of the crop box (pixels). Use with y, width, height.'),
    y: z.number().int().min(0).optional().describe('Top edge of the crop box (pixels).'),
    width: z.number().int().min(1).optional().describe('Width of the crop box (pixels).'),
    height: z.number().int().min(1).optional().describe('Height of the crop box (pixels).'),
    ratio: ratioSchema,
    position: z
      .enum(['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'])
      .optional()
      .default('center')
      .describe('Where the ratio crop sits. Default center (the website default).'),
    format: formatSchema,
    quality: qualitySchema(90),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...imageOutputShape, crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/photos/group.jpg', ratio: '1:1' }, note: 'Largest centred square.' },
    { input: { image: '/photos/group.jpg', x: 100, y: 50, width: 800, height: 600 } },
  ],
  async run(input, ctx) {
    const img = await loadImg(input.image, ctx);
    let c: Crop;
    if (input.width != null || input.height != null || input.x != null || input.y != null) {
      if (input.ratio != null) throw new ToolError('Give either a crop box (x, y, width, height) or a ratio, not both.');
      c = clampBox({ x: input.x ?? 0, y: input.y ?? 0, width: input.width ?? img.width, height: input.height ?? img.height }, img.width, img.height);
    } else if (input.ratio != null) {
      const r = parseRatio(input.ratio);
      c = defaultCrop(img.width, img.height, r === 'free' ? null : r === 'orig' ? img.width / img.height : r);
      const p = input.position;
      const x = /left/.test(p) ? 0 : /right/.test(p) ? img.width : c.x;
      const y = /top/.test(p) ? 0 : /bottom/.test(p) ? img.height : c.y;
      c = moveCrop(c, x, y, img.width, img.height);
    } else throw new ToolError('Give a crop box (x, y, width, height) or a ratio such as "16:9".');
    const fmt: OutFormat = input.format === 'keep' ? keepFormat(img) : input.format;
    const size = { w: c.w, h: c.h };
    const buf = await render(img, c, size, fmt, input.quality);
    const out = await save(img, buf, size, fmt, input.output, input.returnBase64, ctx);
    return { ...out, width: c.w, height: c.h, format: fmt, crop: c };
  },
});

export default [resize, crop];

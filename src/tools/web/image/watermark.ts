import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, outputPath, returnBase64, writeOutput } from '../../../util/files.js';
import { color, encode, esc, EXT, fit, fromRaw, imageOutputShape, keepFormat, loadImg, measureText, MIME, pipe, qualitySchema, stem, toRaw, type OutFormat } from './_img.js';

// Port of https://github.com/s3eidat/watermark (app.js, mark()): every setting is relative to the photo size.
// The website draws on a canvas; here the same geometry is written as an SVG overlay that sharp composites.

export const FONT = 'Inter, system-ui, sans-serif';
export const POSITIONS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;

export interface MarkOpts {
  kind: 'text' | 'logo';
  text: string;
  color: string;
  weight: string;
  shadow: boolean;
  /** 0..8, row-major (POSITIONS). */
  pos: number;
  tiled: boolean;
  opacity: number;
  size: number;
  rotation: number;
  margin: number;
}

const n = (v: number) => +v.toFixed(3);

/** The watermark layer for a W×H photo as SVG (null when there is nothing to draw). */
export function markSvg(W: number, H: number, o: MarkOpts, logo?: { href: string; w: number; h: number }): string | null {
  const tw = (o.size / 100) * W;
  let ew: number;
  let eh: number;
  let px = 0;
  let one: string;
  const defs: string[] = [];
  if (o.kind === 'logo') {
    if (!logo) return null;
    const lw = logo.w || 100;
    const lh = logo.h || 100;
    ew = tw;
    eh = (tw * lh) / lw;
    if (eh > H * 0.9) {
      eh = H * 0.9;
      ew = (eh * lw) / lh;
    }
    one = `<image href="${logo.href}" x="${n(-ew / 2)}" y="${n(-eh / 2)}" width="${n(ew)}" height="${n(eh)}" preserveAspectRatio="none"/>`;
  } else {
    if (!o.text.trim()) return null;
    const font = (s: number) => `${o.weight} ${s}px ${FONT}`;
    px = (100 * tw) / Math.max(1, measureText(font(100), o.text).width);
    px = Math.min(px, H * 0.6);
    ew = measureText(font(px), o.text).width;
    eh = px * 1.2;
    if (o.shadow) {
      defs.push(
        `<filter id="sh" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="${n(px * 0.04)}" stdDeviation="${n((px * 0.12) / 2)}" flood-color="#000" flood-opacity="0.45"/></filter>`,
      );
    }
    one =
      `<text x="0" y="0" text-anchor="middle" dominant-baseline="central" fill="${esc(o.color)}" font-family="${esc(FONT)}" ` +
      `font-weight="${esc(o.weight)}" font-size="${n(px)}"${o.shadow ? ' filter="url(#sh)"' : ''} xml:space="preserve">${esc(o.text)}</text>`;
  }
  defs.push(`<g id="m">${one}</g>`);
  const a = (o.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const uses: string[] = [];
  let transform: string;
  if (o.tiled) {
    // Brick pattern rotated about the centre, big enough to cover the corners.
    const gap = 0.35 + o.margin / 10;
    const sx = ew * (1 + gap);
    const sy = eh * (1 + gap * 2.2);
    const R = Math.hypot(W, H) / 2 + Math.max(sx, sy);
    const J = Math.ceil(R / sy);
    const I = Math.ceil(R / sx) + 1;
    if ((2 * J + 1) * (2 * I + 1) > 20000) throw new ToolError('The watermark is too small to tile on this image; use a larger size.');
    for (let j = -J; j <= J; j++) for (let i = -I; i <= I; i++) uses.push(`<use href="#m" x="${n(i * sx + (Math.abs(j) % 2 ? sx / 2 : 0))}" y="${n(j * sy)}"/>`);
    transform = `translate(${n(W / 2)} ${n(H / 2)}) rotate(${o.rotation})`;
  } else {
    const bw = ew * cos + eh * sin;
    const bh = ew * sin + eh * cos;
    const m = (o.margin / 100) * Math.min(W, H);
    const col = o.pos % 3;
    const rw = Math.floor(o.pos / 3);
    const cx = col === 0 ? m + bw / 2 : col === 1 ? W / 2 : W - m - bw / 2;
    const cy = rw === 0 ? m + bh / 2 : rw === 1 ? H / 2 : H - m - bh / 2;
    uses.push('<use href="#m"/>');
    transform = `translate(${n(cx)} ${n(cy)}) rotate(${o.rotation})`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${defs.join('')}</defs><g opacity="${o.opacity / 100}" transform="${transform}">${uses.join('')}</g></svg>`
  );
}

export default defineTool({
  name: 'image_watermark',
  title: 'Watermark image',
  webSlug: 'watermark',
  description:
    'Add a text or logo watermark to a photo. Size is a % of the photo width, margin a % of the shorter side, so the result looks the same ' +
    'on any resolution. One of 9 positions or tiled across the whole image (brick pattern), with opacity, rotation, colour, weight and ' +
    'a soft shadow for text. Logo: any image (PNG with transparency works best). Output keeps the input format (JPEG/PNG/WebP) or as chosen; ' +
    `name <name>-watermarked.<ext>. Text uses the Inter font when installed, else a system sans-serif. Web version: ${webUrl('watermark')}`,
  inputSchema: z.object({
    image: fileInput('photo'),
    text: z.string().max(500).optional().default('© Your Name').describe('Watermark text (ignored when a logo is given). Default "© Your Name".'),
    logo: fileInput('logo image').optional().describe('Use this image as the watermark instead of text: a local path or base64.'),
    color: z.string().optional().default('#ffffff').describe('Text colour. Default #ffffff.'),
    weight: z.enum(['400', '500', '600', '700', '800', '900']).optional().default('700').describe('Font weight. Default 700.'),
    shadow: z.boolean().optional().default(true).describe('Soft drop shadow behind text. Default true.'),
    position: z.enum(POSITIONS).optional().default('bottom-right').describe('Where the watermark sits (ignored when tiled). Default bottom-right.'),
    tiled: z.boolean().optional().default(false).describe('Repeat the watermark across the whole photo.'),
    opacity: z.number().min(0).max(100).optional().default(60).describe('Opacity in %. Default 60.'),
    size: z.number().min(1).max(100).optional().default(28).describe('Watermark width as % of the photo width. Default 28.'),
    rotation: z.number().min(-180).max(180).optional().default(0).describe('Rotation in degrees (e.g. -30 for a diagonal tile). Default 0.'),
    margin: z.number().min(0).max(50).optional().default(4).describe('Margin from the edge in % of the shorter side; spacing between tiles when tiled. Default 4.'),
    format: z.enum(['keep', 'jpeg', 'png', 'webp']).optional().default('keep').describe('Output format. Default keep.'),
    quality: qualitySchema(92),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object(imageOutputShape),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/photos/shoot-01.jpg', text: '© Studio Lina', position: 'bottom-right', opacity: 60 } },
    { input: { image: '/photos/proof.jpg', text: 'PROOF', tiled: true, rotation: -25, opacity: 35, size: 26, margin: 3 } },
    { input: { image: '/photos/product.png', logo: '/brand/logo.png', position: 'top-left', size: 20 } },
  ],
  async run(input, ctx) {
    const img = await loadImg(input.image, ctx, 'photo');
    const s0 = fit(img.width, img.height);
    const W = s0.w;
    const H = s0.h;
    const o: MarkOpts = {
      kind: input.logo ? 'logo' : 'text',
      text: input.text,
      color: color(input.color),
      weight: input.weight,
      shadow: input.shadow,
      pos: POSITIONS.indexOf(input.position),
      tiled: input.tiled,
      opacity: input.opacity,
      size: input.size,
      rotation: input.rotation,
      margin: input.margin,
    };
    let logo: { href: string; w: number; h: number } | undefined;
    if (input.logo) {
      const lg = await loadImg(input.logo, ctx, 'logo');
      // Pre-scale big logos to about the size they will be drawn at.
      const target = Math.ceil(Math.max((input.size / 100) * W, 1) * 2);
      let ls = pipe(lg);
      if (lg.width > target) ls = ls.resize({ width: target });
      const png = await ls.png().toBuffer();
      logo = { href: 'data:image/png;base64,' + png.toString('base64'), w: lg.width, h: lg.height };
    }
    let s = pipe(img);
    if (s0.scaled) s = s.resize(W, H, { fit: 'fill' });
    if (img.orientation > 1 || s0.scaled) s = fromRaw(await toRaw(s));
    const svg = markSvg(W, H, o, logo);
    if (svg) s = s.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
    const fmt: OutFormat = input.format === 'keep' ? keepFormat(img) : input.format;
    const buf = await encode(s, fmt, input.quality).toBuffer();
    const out = await writeOutput(buf, { output: input.output, defaultName: `${stem(img.name)}-watermarked.${EXT[fmt]}`, mimeType: MIME[fmt], base64: input.returnBase64 }, ctx);
    return { ...out, width: W, height: H, format: fmt };
  },
});

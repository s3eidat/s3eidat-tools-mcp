import { createCanvas } from '@napi-rs/canvas';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, returnBase64, writeOutput } from '../../../util/files.js';
import { esc, measureText, sharp } from './_img.js';

// Port of https://github.com/s3eidat/placeholder-image (app.js): drawn on a canvas (PNG/JPEG/WebP) or written as an SVG string.

const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", sans-serif';
const MAX = 8000;
export const PRESETS: [string, [string, number, number][]][] = [
  ['Web', [['Open Graph / link preview', 1200, 630], ['Hero 16:9 (Full HD)', 1920, 1080], ['HD 16:9', 1280, 720], ['Blog image 4:3', 800, 600], ['Thumbnail 3:2', 600, 400], ['Avatar', 256, 256]]],
  ['Social', [['Instagram square', 1080, 1080], ['Instagram portrait 4:5', 1080, 1350], ['Story / Reel 9:16', 1080, 1920], ['X / Twitter header', 1500, 500], ['LinkedIn banner', 1584, 396], ['YouTube thumbnail', 1280, 720]]],
  ['Ads (IAB)', [['Medium rectangle', 300, 250], ['Leaderboard', 728, 90], ['Wide skyscraper', 160, 600], ['Mobile banner', 320, 50], ['Half page', 300, 600], ['Billboard', 970, 250]]],
  ['Devices', [['iPhone 15 (screen)', 1179, 2556], ['Desktop 1440', 1440, 900], ['4K UHD', 3840, 2160]]],
];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Preset ids ("open-graph-link-preview", "instagram-square", …) → [w, h]. */
export const PRESET_SIZES: Record<string, [number, number]> = Object.fromEntries(PRESETS.flatMap((g) => g[1].map((p) => [slug(p[0]), [p[1], p[2]] as [number, number]])));

export interface PhSettings {
  w: number;
  h: number;
  bg: string;
  fg: string;
  text: string;
  fs: number;
  fw: string;
}

export function normHex(v: string) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v).trim());
  if (!m) return null;
  let x = m[1].toLowerCase();
  if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
  return '#' + x;
}
export function clampDim(v: unknown) {
  const n = Math.round(+(v as number));
  return isFinite(n) && n >= 1 ? Math.min(MAX, n) : null;
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
export function ratio(w: number, h: number) {
  const g = gcd(w, h);
  return w / g + ':' + h / g;
}
const label = (s: PhSettings) => (s.text.trim() ? s.text.replace(/\\n/g, '\n') : s.w + ' × ' + s.h);
const lines = (s: PhSettings) => label(s).split('\n');

export function fontSize(s: PhSettings) {
  if (+s.fs > 0) return +s.fs;
  const ls = lines(s);
  const wmax = Math.max(...ls.map((l) => measureText(s.fw + ' 100px ' + FONT, l).width)) || 1;
  return Math.max(6, Math.floor(Math.min((100 * s.w * 0.62) / wmax, (s.h * 0.42) / (ls.length * 1.2))));
}

/** Raster version, drawn exactly like the website's canvas. Returns RGBA pixels. */
export function draw(s: PhSettings, scale = 1) {
  const W = Math.max(1, Math.round(s.w * scale));
  const H = Math.max(1, Math.round(s.h * scale));
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  c.fillStyle = s.bg;
  c.fillRect(0, 0, W, H);
  const fs = fontSize(s) * scale;
  const ls = lines(s);
  const lh = fs * 1.2;
  c.fillStyle = s.fg;
  c.font = s.fw + ' ' + fs + 'px ' + FONT;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  ls.forEach((l, i) => c.fillText(l, W / 2, H / 2 + (i - (ls.length - 1) / 2) * lh));
  return { data: Buffer.from(c.getImageData(0, 0, W, H).data.buffer), width: W, height: H };
}

export function svg(s: PhSettings) {
  const fs = fontSize(s);
  const ls = lines(s);
  const lh = fs * 1.2;
  const y0 = s.h / 2 - ((ls.length - 1) * lh) / 2;
  const spans = ls.map((l, i) => '<tspan x="50%" y="' + +(y0 + i * lh).toFixed(2) + '">' + esc(l) + '</tspan>').join('');
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + s.w + '" height="' + s.h + '" viewBox="0 0 ' + s.w + ' ' + s.h + '">' +
    '<rect width="100%" height="100%" fill="' + s.bg + '"/>' +
    '<text fill="' + s.fg + '" font-family="' + esc(FONT) + '" font-size="' + fs + '" font-weight="' + s.fw +
    '" text-anchor="middle" dominant-baseline="central">' + spans + '</text></svg>'
  );
}

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' } as const;
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', svg: 'svg' } as const;

export default defineTool({
  name: 'image_placeholder',
  title: 'Placeholder image',
  webSlug: 'placeholder-image',
  description:
    'Make a placeholder image of any size (up to 8000 px a side): solid background with centred text (default "W × H", "\\n" for line ' +
    'breaks), auto-fitted font size or a fixed one, PNG / JPEG / WebP / SVG. Size presets for web, social media, IAB ads and devices. ' +
    'Optionally returns a data URI / <img> tag for inlining. Text uses Inter when installed, else a system sans-serif. ' +
    `Web version: ${webUrl('placeholder-image')}`,
  inputSchema: z.object({
    width: z.number().int().min(1).max(MAX).optional().default(1200).describe('Width in pixels. Default 1200.'),
    height: z.number().int().min(1).max(MAX).optional().default(630).describe('Height in pixels. Default 630.'),
    preset: z
      .enum(Object.keys(PRESET_SIZES) as [string, ...string[]])
      .optional()
      .describe('Size preset (overrides width/height): ' + Object.entries(PRESET_SIZES).map(([k, v]) => `${k} ${v[0]}×${v[1]}`).join(', ') + '.'),
    background: z.string().optional().default('#1f2937').describe('Background colour (#rgb or #rrggbb). Default #1f2937.'),
    color: z.string().optional().default('#9ca3af').describe('Text colour (#rgb or #rrggbb). Default #9ca3af.'),
    text: z.string().max(500).optional().default('').describe('Text to show. Empty = "W × H". Use "\\n" (backslash n) or a real newline for a line break.'),
    fontSize: z.number().min(0).max(2000).optional().default(0).describe('Font size in px; 0 = auto-fit (default).'),
    fontWeight: z.enum(['400', '500', '600', '700', '800', '900']).optional().default('600').describe('Font weight. Default 600.'),
    format: z.enum(['png', 'jpeg', 'webp', 'svg']).optional().default('png').describe('Output format. Default png.'),
    dataUri: z.boolean().optional().default(false).describe('Also return the image as a data URI and an <img> tag (for small images).'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    path: z.string(),
    bytes: z.number(),
    mimeType: z.string().optional(),
    base64: z.string().optional(),
    width: z.number(),
    height: z.number(),
    format: z.string(),
    aspectRatio: z.string().describe('Reduced ratio, e.g. "40:21".'),
    megapixels: z.string(),
    fontSize: z.number().describe('Font size used, in px.'),
    dataUri: z.string().optional(),
    imgTag: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { width: 1200, height: 630 }, note: 'placeholder-1200x630.png with "1200 × 630".' },
    { input: { preset: 'leaderboard', background: '#0e9f9a', color: '#e6fffd', text: 'Ad space', format: 'svg' } },
  ],
  async run(input, ctx) {
    let [w, h] = [input.width, input.height];
    if (input.preset) [w, h] = PRESET_SIZES[input.preset];
    const bg = normHex(input.background);
    const fg = normHex(input.color);
    if (!bg) throw new ToolError(`background: "${input.background}" is not a hex colour (#rgb or #rrggbb).`);
    if (!fg) throw new ToolError(`color: "${input.color}" is not a hex colour (#rgb or #rrggbb).`);
    const fsIn = +input.fontSize;
    const s: PhSettings = { w, h, bg, fg, text: input.text, fs: fsIn > 0 && fsIn < 6 ? 6 : fsIn, fw: input.fontWeight };
    const fmt = input.format;
    let buf: Buffer;
    if (fmt === 'svg') buf = Buffer.from(svg(s), 'utf8');
    else {
      const r = draw(s, 1);
      const p = sharp(r.data, { raw: { width: r.width, height: r.height, channels: 4 } });
      buf = await (fmt === 'png' ? p.png() : fmt === 'jpeg' ? p.jpeg({ quality: 92 }) : p.webp({ quality: 92 })).toBuffer();
    }
    const out = await writeOutput(buf, { output: input.output, defaultName: `placeholder-${w}x${h}.${EXT[fmt]}`, mimeType: MIME[fmt], base64: input.returnBase64 }, ctx);
    const res: Record<string, unknown> = { ...out, width: w, height: h, format: fmt, aspectRatio: ratio(w, h), megapixels: ((w * h) / 1e6).toFixed(2), fontSize: fontSize(s) };
    if (input.dataUri) {
      const uri = fmt === 'svg' ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buf.toString('utf8')) : `data:${MIME[fmt]};base64,` + buf.toString('base64');
      res.dataUri = uri;
      res.imgTag = '<img src="' + uri + '" width="' + w + '" height="' + h + '" alt="">';
    }
    return res;
  },
});

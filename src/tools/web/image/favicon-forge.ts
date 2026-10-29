import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, outputDir, writeOutput } from '../../../util/files.js';
import { color, loadImg, pipe, sharp } from './_img.js';

// Port of https://github.com/s3eidat/favicon-forge (app.js): a 512 px master drawn on a canvas (rounded square, text or
// image), scaled down to every size, plus favicon.ico (PNG-in-ICO, 16/32/48), site.webmanifest and the <head> snippet.

const M = 512;
const FONT = 'Inter, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
export const OUT = [
  { size: 16, file: 'favicon-16x16.png', note: 'favicon.ico + PNG' },
  { size: 32, file: 'favicon-32x32.png', note: 'favicon.ico + PNG' },
  { size: 48, file: null, note: 'favicon.ico only' },
  { size: 180, file: 'apple-touch-icon.png', note: 'Apple touch icon', solid: true },
  { size: 192, file: 'android-chrome-192x192.png', note: 'Android / PWA' },
  { size: 512, file: 'android-chrome-512x512.png', note: 'Android / PWA splash' },
] as const;

export interface FavOpts {
  src: 'text' | 'image';
  text: string;
  weight: string;
  fg: string;
  bg: string;
  transparent: boolean;
  radius: number;
  pad: number;
  fit: 'contain' | 'cover';
  name: string;
  short: string;
  img?: Image;
}

type Ctx2D = ReturnType<ReturnType<typeof createCanvas>['getContext']>;
function roundRect(x: Ctx2D, s: number, r: number) {
  x.beginPath();
  x.moveTo(r, 0);
  x.arcTo(s, 0, s, s, r);
  x.arcTo(s, s, 0, s, r);
  x.arcTo(0, s, 0, 0, r);
  x.arcTo(0, 0, s, 0, r);
  x.closePath();
}
/** The 512×512 master. `solid` (Apple touch icon): square corners, never transparent. */
export function drawMaster(opt: FavOpts, solid: boolean) {
  const c = createCanvas(M, M);
  const x = c.getContext('2d');
  const r = solid ? 0 : (opt.radius / 100) * M;
  x.save();
  if (r > 0) {
    roundRect(x, M, r);
    x.clip();
  }
  if (!opt.transparent || solid) {
    x.fillStyle = opt.transparent ? '#ffffff' : opt.bg;
    x.fillRect(0, 0, M, M);
  }
  const p = (opt.pad / 100) * M;
  const a = M - 2 * p;
  if (opt.src === 'image' && opt.img) {
    const iw = opt.img.width || M;
    const ih = opt.img.height || M;
    const s = opt.fit === 'cover' ? Math.max(a / iw, a / ih) : Math.min(a / iw, a / ih);
    const w = iw * s;
    const h = ih * s;
    x.beginPath();
    x.rect(p, p, a, a);
    x.clip();
    x.imageSmoothingQuality = 'high';
    x.drawImage(opt.img, p + (a - w) / 2, p + (a - h) / 2, w, h);
  } else if (opt.text.trim()) {
    x.font = opt.weight + ' 300px ' + FONT;
    const m = x.measureText(opt.text);
    const tw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const th = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const k = Math.min(a / Math.max(tw, 1), a / Math.max(th, 1));
    x.font = opt.weight + ' ' + 300 * k + 'px ' + FONT;
    const n = x.measureText(opt.text);
    const w2 = n.actualBoundingBoxLeft + n.actualBoundingBoxRight;
    const h2 = n.actualBoundingBoxAscent + n.actualBoundingBoxDescent;
    x.fillStyle = opt.fg;
    x.textBaseline = 'alphabetic';
    x.textAlign = 'left';
    x.fillText(opt.text, M / 2 - w2 / 2 + n.actualBoundingBoxLeft, M / 2 - h2 / 2 + n.actualBoundingBoxAscent);
  }
  x.restore();
  return c.encode('png');
}

/** All sizes as PNG bytes (masters scaled down with a high-quality filter). */
export async function renderAll(opt: FavOpts) {
  const m = await drawMaster(opt, false);
  const ms = await drawMaster(opt, true);
  const res: Record<number, Buffer> = {};
  for (const t of OUT) {
    const src = 'solid' in t && t.solid ? ms : m;
    res[t.size] = t.size === M ? Buffer.from(src) : await sharp(src).resize(t.size, t.size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
  }
  return res;
}

/** ICO = 6-byte header + 16-byte directory entry per image + PNG payloads (PNG-in-ICO, supported everywhere since Vista). */
export function ico(images: { size: number; bytes: Uint8Array }[]) {
  const head = 6 + 16 * images.length;
  const total = images.reduce((s, i) => s + i.bytes.length, head);
  const b = new Uint8Array(total);
  const v = new DataView(b.buffer);
  v.setUint16(0, 0, true);
  v.setUint16(2, 1, true);
  v.setUint16(4, images.length, true);
  let off = head;
  images.forEach((im, i) => {
    const e = 6 + 16 * i;
    b[e] = im.size >= 256 ? 0 : im.size;
    b[e + 1] = im.size >= 256 ? 0 : im.size;
    b[e + 2] = 0;
    b[e + 3] = 0;
    v.setUint16(e + 4, 1, true);
    v.setUint16(e + 6, 32, true);
    v.setUint32(e + 8, im.bytes.length, true);
    v.setUint32(e + 12, off, true);
    b.set(im.bytes, off);
    off += im.bytes.length;
  });
  return b;
}
export function manifest(opt: Pick<FavOpts, 'name' | 'short' | 'transparent' | 'bg'>) {
  const c = opt.transparent ? '#ffffff' : opt.bg;
  return (
    JSON.stringify(
      {
        name: opt.name || 'My Website',
        short_name: opt.short || opt.name || 'Site',
        icons: [
          { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
        theme_color: c,
        background_color: c,
        display: 'standalone',
      },
      null,
      2,
    ) + '\n'
  );
}
export function snippet(opt: Pick<FavOpts, 'transparent' | 'bg'>) {
  return (
    '<link rel="icon" href="/favicon.ico" sizes="48x48">\n' +
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">\n' +
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">\n' +
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">\n' +
    '<link rel="manifest" href="/site.webmanifest">\n' +
    '<meta name="theme-color" content="' + (opt.transparent ? '#ffffff' : opt.bg) + '">'
  );
}
export async function buildFiles(opt: FavOpts) {
  const png = await renderAll(opt);
  const files: { name: string; data: Uint8Array | string }[] = [{ name: 'favicon.ico', data: ico([16, 32, 48].map((s) => ({ size: s, bytes: png[s] }))) }];
  OUT.forEach((t) => {
    if (t.file) files.push({ name: t.file, data: png[t.size] });
  });
  files.push({ name: 'site.webmanifest', data: manifest(opt) });
  files.push({ name: 'head-snippet.html', data: snippet(opt) + '\n' });
  return files;
}

export default defineTool({
  name: 'image_favicon_set',
  title: 'Favicon set generator',
  webSlug: 'favicon-forge',
  description:
    'Make a complete favicon set from a letter/emoji/short text or from an image: favicon.ico (16, 32, 48 px), favicon-16x16.png, ' +
    'favicon-32x32.png, apple-touch-icon.png (180, square, solid), android-chrome-192x192.png and -512x512.png, site.webmanifest and ' +
    'head-snippet.html with the <link> tags. Rounded square with background colour (or transparent), corner radius and padding in %. ' +
    `Writes everything into one folder. Web version: ${webUrl('favicon-forge')}`,
  inputSchema: z.object({
    text: z.string().max(12).optional().default('S').describe('Letter(s) or emoji drawn on the icon (when no image is given). Default "S".'),
    image: fileInput('source image').optional().describe('Use this image (logo) instead of text: a local path or base64. Square, 512 px+ works best.'),
    weight: z.enum(['400', '500', '600', '700', '800', '900']).optional().default('900').describe('Font weight for text. Default 900.'),
    color: z.string().optional().default('#ffffff').describe('Text colour. Default #ffffff.'),
    background: z.string().optional().default('#0e7c86').describe('Background colour. Default #0e7c86.'),
    transparent: z.boolean().optional().default(false).describe('Transparent background (the Apple icon still gets white). Default false.'),
    radius: z.number().min(0).max(50).optional().default(22).describe('Corner radius in % of the size (50 = circle). Default 22.'),
    padding: z.number().min(0).max(45).optional().default(14).describe('Padding around the text/image in %. Default 14.'),
    fit: z.enum(['contain', 'cover']).optional().default('contain').describe('How an image fills the padded square. Default contain.'),
    name: z.string().optional().default('My Website').describe('App name for site.webmanifest. Default "My Website".'),
    shortName: z.string().optional().default('Site').describe('Short name for site.webmanifest. Default "Site".'),
    output: z.string().optional().describe('Folder to write the files into. Default: a new "favicons" folder in the output folder.'),
  }),
  outputSchema: z.object({
    folder: z.string(),
    files: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number() })),
    snippet: z.string().describe('The <head> tags to paste.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'S3', background: '#0e7c86', radius: 24, padding: 16, name: 'S3eidat Tools', shortName: 'S3eidat' } },
    { input: { image: '/brand/logo.png', transparent: true, radius: 0, output: '/site/public/' } },
  ],
  async run(input, ctx) {
    const opt: FavOpts = {
      src: input.image ? 'image' : 'text',
      text: input.text,
      weight: input.weight,
      fg: color(input.color),
      bg: color(input.background, 'background'),
      transparent: input.transparent,
      radius: input.radius,
      pad: input.padding,
      fit: input.fit,
      name: input.name,
      short: input.shortName,
    };
    if (input.image) {
      const src = await loadImg(input.image, ctx, 'image');
      let s = pipe(src);
      if (Math.max(src.width, src.height) > 2048) s = s.resize(2048, 2048, { fit: 'inside' });
      opt.img = await loadImage(await s.png().toBuffer());
    } else if (!input.text.trim()) throw new ToolError('Give some text (e.g. a letter) or an image.');
    const files = await buildFiles(opt);
    const dir = await outputDir(input.output, 'favicons', ctx);
    const written = [];
    for (const f of files) {
      const r = await writeOutput(f.data, { output: join(dir, f.name), defaultName: f.name }, ctx);
      written.push({ name: f.name, path: r.path, bytes: r.bytes });
    }
    return { folder: dir, files: written, snippet: snippet(opt) };
  },
});

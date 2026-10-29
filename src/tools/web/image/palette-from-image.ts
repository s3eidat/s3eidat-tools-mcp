import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { fileInput, writeOutput } from '../../../util/files.js';
import { loadImg, pipe, sharp, type Sharp } from './_img.js';

// Port of https://github.com/s3eidat/palette-from-image (app.js): k-means (deterministic k-means++ seeding) or median cut
// on a ~200×200 downsampled copy, so the colours and shares match the website.

const SAMPLE = 40000;
export type RGB = number[];
export interface Swatch {
  rgb: RGB;
  share: number;
}

export const hex = (c: RGB) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const d2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
export const lum = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Opaque pixels of an RGBA buffer as [r,g,b] triples, evenly subsampled to at most `max`. */
export function pixels(data: ArrayLike<number>, max: number): RGB[] {
  const n = data.length / 4;
  const step = Math.max(1, n / max);
  const out: RGB[] = [];
  for (let f = 0; f < n; f += step) {
    const i = Math.floor(f) * 4;
    if (data[i + 3] >= 128) out.push([data[i], data[i + 1], data[i + 2]]);
  }
  return out;
}
function finish(groups: { n: number; c: number[] }[], total: number): Swatch[] {
  return groups
    .filter((g) => g.n > 0)
    .map((g) => ({ rgb: g.c.map(Math.round), share: g.n / total }))
    .sort((a, b) => b.share - a.share);
}
export function medianCut(px: RGB[], k: number): Swatch[] {
  if (!px.length) return [];
  const boxes = [px];
  const range = (b: RGB[]) => {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    b.forEach((p) => {
      for (let c = 0; c < 3; c++) {
        if (p[c] < lo[c]) lo[c] = p[c];
        if (p[c] > hi[c]) hi[c] = p[c];
      }
    });
    return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  };
  while (boxes.length < k) {
    let best = -1;
    let bi = -1;
    let bc = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      const r = range(b);
      const c = r.indexOf(Math.max.apply(null, r));
      const score = r[c] * Math.sqrt(b.length);
      if (score > best) {
        best = score;
        bi = i;
        bc = c;
      }
    });
    if (bi < 0 || best <= 0) break;
    const b = boxes[bi].slice().sort((p, q) => p[bc] - q[bc]);
    // Cut at the median, nudged to the nearest change in value so identical colours never straddle two boxes.
    let lo = b.length >> 1;
    let hi = lo;
    while (lo > 0 && b[lo - 1][bc] === b[lo][bc]) lo--;
    while (hi < b.length && b[hi - 1][bc] === b[hi][bc]) hi++;
    const mid = lo > 0 && (hi >= b.length || (b.length >> 1) - lo <= hi - (b.length >> 1)) ? lo : hi;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return finish(
    boxes.map((b) => ({ n: b.length, c: [0, 1, 2].map((c) => b.reduce((s, p) => s + p[c], 0) / b.length) })),
    px.length,
  );
}
export function kmeans(px: RGB[], k: number): Swatch[] {
  if (!px.length) return [];
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  // k-means++ seeding (deterministic), then Lloyd iterations.
  const cents: RGB[] = [px[Math.floor(rnd() * px.length)].slice()];
  const dist = new Float64Array(px.length).fill(Infinity);
  while (cents.length < k) {
    let sum = 0;
    const last = cents[cents.length - 1];
    for (let i = 0; i < px.length; i++) {
      const d = d2(px[i], last);
      if (d < dist[i]) dist[i] = d;
      sum += dist[i];
    }
    if (sum === 0) break;
    let t = rnd() * sum;
    let i = 0;
    while (i < px.length - 1 && (t -= dist[i]) > 0) i++;
    cents.push(px[i].slice());
  }
  const lab = new Int32Array(px.length);
  let counts: number[] = [];
  for (let it = 0; it < 16; it++) {
    const sums = cents.map(() => [0, 0, 0]);
    counts = cents.map(() => 0);
    let moved = 0;
    for (let i = 0; i < px.length; i++) {
      let b = 0;
      let bd = Infinity;
      for (let c = 0; c < cents.length; c++) {
        const d = d2(px[i], cents[c]);
        if (d < bd) {
          bd = d;
          b = c;
        }
      }
      if (lab[i] !== b) moved++;
      lab[i] = b;
      counts[b]++;
      sums[b][0] += px[i][0];
      sums[b][1] += px[i][1];
      sums[b][2] += px[i][2];
    }
    cents.forEach((c, j) => {
      if (counts[j]) {
        c[0] = sums[j][0] / counts[j];
        c[1] = sums[j][1] / counts[j];
        c[2] = sums[j][2] / counts[j];
      }
    });
    if (it > 0 && moved === 0) break;
  }
  return finish(cents.map((c, j) => ({ n: counts[j], c })), px.length);
}
export function exportText(pal: Swatch[], fmt: 'css' | 'json') {
  if (fmt === 'json') return JSON.stringify(pal.map((p) => ({ hex: hex(p.rgb), rgb: p.rgb, share: Math.round(p.share * 1000) / 1000 })), null, 2);
  return ':root {\n' + pal.map((p, i) => '  --color-' + (i + 1) + ': ' + hex(p.rgb) + ';').join('\n') + '\n}';
}
/** The website's palette.png strip: 160×200 per colour with the hex code near the bottom. */
export function stripSvg(pal: Swatch[]) {
  const W = 160;
  const H = 200;
  const cells = pal
    .map((p, i) => {
      const fill = lum(p.rgb) > 0.55 ? 'rgba(0,0,0,.78)' : 'rgba(255,255,255,.92)';
      return (
        `<rect x="${i * W}" width="${W}" height="${H}" fill="${hex(p.rgb)}"/>` +
        `<text x="${i * W + W / 2}" y="${H - 22}" fill="${fill}" font-family="Inter, sans-serif" font-weight="600" font-size="20" text-anchor="middle">${hex(p.rgb).toUpperCase()}</text>`
      );
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * pal.length}" height="${H}">${cells}</svg>`;
}

/** The website's analysis copy: at most ~SAMPLE pixels, high-quality downscale. */
export async function samplePixels(s: Sharp, w: number, h: number) {
  const k = Math.min(1, Math.sqrt(SAMPLE / (w * h)));
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  if (sw !== w || sh !== h) s = s.resize(sw, sh, { fit: 'fill' });
  const { data } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return pixels(data, SAMPLE);
}

export default defineTool({
  name: 'image_palette',
  title: 'Colour palette from image',
  webSlug: 'palette-from-image',
  description:
    'Extract the main colours of an image with their share of the picture: k-means (default, deterministic) or median cut, 1-16 colours, ' +
    'sorted by share. Transparent pixels are ignored. Returns hex + rgb + % per colour, CSS custom properties (:root { --color-1 … }) or ' +
    'JSON, and optionally writes the website\'s swatch strip as palette.png. Same algorithm and sampling as the website, so the colours match. ' +
    `Web version: ${webUrl('palette-from-image')}`,
  inputSchema: z.object({
    image: fileInput('image'),
    count: z.number().int().min(1).max(16).optional().default(6).describe('Number of colours. Default 6.'),
    method: z.enum(['kmeans', 'median']).optional().default('kmeans').describe('kmeans (default) or median (median cut).'),
    format: z.enum(['css', 'json']).optional().default('css').describe('Export text format. Default css.'),
    swatchPng: z.boolean().optional().default(false).describe('Also write palette.png (160×200 swatch per colour with its hex code).'),
    output: z.string().optional().describe('Where to write palette.png (file path or folder ending in "/"). Implies swatchPng.'),
  }),
  outputSchema: z.object({
    colors: z.array(z.object({ hex: z.string(), rgb: z.array(z.number()), share: z.number().describe('0-1'), percent: z.string().describe('e.g. "42.5%"') })),
    text: z.string().describe('CSS custom properties or JSON, as exported by the website.'),
    pixelsSampled: z.number(),
    path: z.string().optional().describe('palette.png, when written.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { image: '/photos/sunset.jpg', count: 5 }, note: 'colors: [{ hex: "#1f2f6e", percent: "31.2%" }, …]' }],
  async run(input, ctx) {
    const img = await loadImg(input.image, ctx);
    const px = await samplePixels(pipe(img), img.width, img.height);
    const pal = (input.method === 'median' ? medianCut : kmeans)(px, input.count);
    const res: Record<string, unknown> = {
      colors: pal.map((p) => ({ hex: hex(p.rgb), rgb: p.rgb, share: p.share, percent: (p.share * 100).toFixed(1) + '%' })),
      text: exportText(pal, input.format),
      pixelsSampled: px.length,
    };
    if ((input.swatchPng || input.output) && pal.length) {
      const png = await sharp(Buffer.from(stripSvg(pal))).png().toBuffer();
      res.path = (await writeOutput(png, { output: input.output, defaultName: 'palette.png', mimeType: 'image/png' }, ctx)).path;
    }
    return res;
  },
});

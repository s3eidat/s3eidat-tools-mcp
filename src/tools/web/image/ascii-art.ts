import { createCanvas } from '@napi-rs/canvas';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, outputPath, writeOutput } from '../../../util/files.js';
import { F35, F57, RAMPS } from './_ascii-fonts.js';
import { loadImg, pipe, stem } from './_img.js';

// Port of https://github.com/s3eidat/ascii-art (app.js): image → characters by sampling a downscaled copy, and
// text → banner letters from the website's own 5×7 and 3×5 bitmap fonts.

export { RAMPS, F57, F35 };
export const CHAR_ASPECT = 0.5; // a monospace cell is about twice as tall as it is wide

export function adjust(v: number, contrast: number, brightness: number) {
  const k = contrast >= 0 ? 1 + (contrast / 100) * 3 : 1 + contrast / 100;
  v = (v - 0.5) * k + 0.5 + brightness / 100;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** lum: 0..1 brightness per cell; returns lines of text. */
export function cellsToAscii(lum: ArrayLike<number>, cols: number, rows: number, ramp: string, o: { contrast?: number; brightness?: number; invert?: boolean } = {}) {
  const chars = Array.from(ramp);
  const n = chars.length - 1;
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let s = '';
    for (let x = 0; x < cols; x++) {
      const v = adjust(lum[y * cols + x], o.contrast || 0, o.brightness || 0);
      const ink = o.invert ? v : 1 - v;
      s += chars[Math.round(ink * n)];
    }
    lines.push(s);
  }
  return lines;
}
export function gridSize(w: number, h: number, cols: number) {
  return { cols, rows: Math.max(1, Math.round(((cols * h) / w) * CHAR_ASPECT)) };
}

// ---------- banners ----------
export function glyph(font: Record<string, string>, ch: string) {
  const rows = (font[ch] || font['?']).split('|');
  const w = rows[0].length;
  let lo = 0;
  let hi = w - 1;
  const empty = (c: number) => rows.every((r) => r[c] !== '#');
  while (lo < hi && empty(lo)) lo++;
  while (hi > lo && empty(hi)) hi--;
  return rows.map((r) => r.slice(lo, hi + 1));
}
/** One line of text → pixel grid (array of strings of "#"/"."). */
export function textGrid(text: string, font: Record<string, string>) {
  const hgt = font === F57 ? 7 : 5;
  const rows: string[] = [];
  for (let i = 0; i < hgt; i++) rows.push('');
  Array.from(String(text).toUpperCase()).forEach((ch, k) => {
    const g = ch === ' ' ? rows.map(() => (font === F57 ? '...' : '..')) : glyph(font, ch);
    for (let r = 0; r < hgt; r++) rows[r] += (k ? '.' : '') + g[r];
  });
  return rows;
}
interface Style {
  font: Record<string, string>;
  on?: string;
  off?: string;
  shadow?: boolean;
  half?: boolean;
}
export const STYLES: Record<string, Style> = {
  block: { font: F57, on: '██', off: '  ' },
  char: { font: F57 },
  shadow: { font: F57, shadow: true },
  compact: { font: F57, half: true },
  small: { font: F35, on: '██', off: '  ' },
  tiny: { font: F35, half: true },
};
const rtrim = (s: string) => s.replace(/\s+$/, '');
export function renderGrid(rows: string[], style: string, fill?: string) {
  const st = STYLES[style];
  if (st.half) {
    // two pixel rows per text line with half blocks: square-ish pixels, half the height
    const out: string[] = [];
    const w = rows[0].length;
    for (let y = 0; y < rows.length; y += 2) {
      let s = '';
      for (let x = 0; x < w; x++) {
        const a = rows[y][x] === '#';
        const b = y + 1 < rows.length && rows[y + 1][x] === '#';
        s += a && b ? '█' : a ? '▀' : b ? '▄' : ' ';
      }
      out.push(rtrim(s));
    }
    return out;
  }
  if (st.shadow) {
    // solid letters with a light shade one pixel down-right
    const H = rows.length + 1;
    const W = rows[0].length + 1;
    const res: string[] = [];
    for (let yy = 0; yy < H; yy++) {
      let t = '';
      for (let xx = 0; xx < W; xx++) {
        const on = rows[yy] && rows[yy][xx] === '#';
        const sh = yy > 0 && xx > 0 && rows[yy - 1][xx - 1] === '#';
        t += on ? '██' : sh ? '░░' : '  ';
      }
      res.push(rtrim(t));
    }
    return res;
  }
  let onS = st.on || ((fill || '#') + (fill || '#')).slice(0, 2);
  const offS = st.off || '  ';
  if (!st.on && Array.from(fill || '#').length === 2) onS = fill!;
  return rows.map((r) => rtrim(r.replace(/#/g, '\u0001').replace(/\./g, offS).split('\u0001').join(onS)));
}
export function banner(text: string, style: string, fill?: string) {
  const font = STYLES[style].font;
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => renderGrid(textGrid(l, font), style, fill).join('\n'))
    .join('\n\n');
}

// ---------- PNG export of any text (optionally coloured per character) ----------
type Ctx2D = ReturnType<ReturnType<typeof createCanvas>['getContext']>;
function blockChar(g: Ctx2D, ch: string, x: number, y: number, w: number, hh: number) {
  // draw block elements as rectangles so they tile without gaps in any font
  const a = g.globalAlpha;
  if (ch === '█') g.fillRect(x, y, w + 0.5, hh + 0.5);
  else if (ch === '▀') g.fillRect(x, y, w + 0.5, hh / 2 + 0.5);
  else if (ch === '▄') g.fillRect(x, y + hh / 2, w + 0.5, hh / 2 + 0.5);
  else {
    g.globalAlpha = a * ({ '░': 0.25, '▒': 0.5, '▓': 0.75 } as Record<string, number>)[ch];
    g.fillRect(x, y, w + 0.5, hh + 0.5);
  }
  g.globalAlpha = a;
}
export function textToPng(lines: string[], opt: { size?: number; bg: string; fg: string; lineHeight?: number; colorAt?: (x: number, y: number) => string }) {
  const size = opt.size || 14;
  const font = size + "px Consolas, 'DejaVu Sans Mono', Menlo, monospace";
  const pad = size;
  const probe = createCanvas(4, 4).getContext('2d');
  probe.font = font;
  const cw = probe.measureText('M').width;
  const lh = opt.lineHeight ? opt.lineHeight * size : cw / CHAR_ASPECT;
  const cols = Math.max(1, Math.max(...lines.map((l) => Array.from(l).length)));
  const c = createCanvas(Math.ceil(cols * cw + pad * 2), Math.ceil(lines.length * lh + pad * 2));
  const g = c.getContext('2d');
  g.fillStyle = opt.bg;
  g.fillRect(0, 0, c.width, c.height);
  g.font = font;
  g.textBaseline = 'middle';
  g.fillStyle = opt.fg;
  lines.forEach((l, y) => {
    Array.from(l).forEach((ch, x) => {
      if (ch === ' ') return;
      if (opt.colorAt) g.fillStyle = opt.colorAt(x, y);
      if (/[█▀▄░▒▓]/.test(ch)) blockChar(g, ch, pad + x * cw, pad + y * lh, cw, lh);
      else g.fillText(ch, pad + x * cw, pad + y * lh + lh / 2);
    });
  });
  return c.encode('png');
}

const RAMP_NAMES = ['standard', 'detailed', 'blocks', 'simple', 'binary', 'custom'] as const;

const asciiArt = defineTool({
  name: 'image_ascii_art',
  title: 'Image to ASCII art',
  webSlug: 'ascii-art',
  description:
    'Turn an image into ASCII art: each character cell takes the average brightness of its area (cells are twice as tall as wide) and maps ' +
    'it onto a character ramp: standard " .:-=+*#%@", detailed (70 characters), blocks " ░▒▓█", simple, binary, or your own. ' +
    'Contrast, brightness and invert (for light text on dark backgrounds). Returns the text; format "png" also renders it to an image ' +
    `(optionally in the image's colours). Transparent areas count as white paper. Web version: ${webUrl('ascii-art')}`,
  inputSchema: z.object({
    image: fileInput('image'),
    columns: z.number().int().min(4).max(400).optional().default(100).describe('Characters per line. Default 100.'),
    ramp: z.enum(RAMP_NAMES).optional().default('standard').describe('Character set, light → dark. Default standard.'),
    customRamp: z.string().optional().default(' .oO0@').describe('Characters for ramp "custom", from no ink to most ink (at least 2).'),
    contrast: z.number().min(-100).max(100).optional().default(0).describe('-100 … 100. Default 0.'),
    brightness: z.number().min(-100).max(100).optional().default(0).describe('-100 … 100. Default 0.'),
    invert: z.boolean().optional().default(false).describe('For light text on a dark background. Default false.'),
    format: z.enum(['text', 'png']).optional().default('text').describe('text (default) or png (also writes <name>-ascii.png).'),
    color: z.boolean().optional().default(false).describe('PNG only: colour each character with the image colour.'),
    output: outputPath(),
  }),
  outputSchema: z.object({
    text: z.string(),
    columns: z.number(),
    rows: z.number(),
    path: z.string().optional().describe('Written .txt or .png file, if any.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/photos/cat.jpg', columns: 80, contrast: 20 } },
    { input: { image: '/photos/logo.png', ramp: 'blocks', format: 'png', color: true } },
  ],
  async run(input, ctx) {
    const img = await loadImg(input.image, ctx);
    const ramp = input.ramp === 'custom' ? input.customRamp : RAMPS[input.ramp];
    if (Array.from(ramp || '').length < 2) throw new ToolError('customRamp needs at least 2 characters.');
    const g = gridSize(img.width, img.height, input.columns);
    const { data } = await pipe(img)
      .resize(g.cols, g.rows, { fit: 'fill' })
      .flatten({ background: '#ffffff' }) // transparent areas count as paper
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lum = new Float32Array(g.cols * g.rows);
    for (let i = 0; i < lum.length; i++) lum[i] = (0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2]) / 255;
    const lines = cellsToAscii(lum, g.cols, g.rows, ramp, { contrast: input.contrast, brightness: input.brightness, invert: input.invert });
    const text = lines.map(rtrim).join('\n');
    const res: { text: string; columns: number; rows: number; path?: string } = { text, columns: g.cols, rows: g.rows };
    const base = stem(img.name) === 'image' ? 'ascii' : stem(img.name);
    if (input.format === 'png') {
      const colorAt = input.color ? (x: number, y: number) => { const i = (y * g.cols + x) * 3; return `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`; } : undefined;
      const png = await textToPng(lines, { size: 14, bg: input.invert ? '#0b0d10' : '#ffffff', fg: input.invert ? '#e8eaed' : '#111', colorAt });
      res.path = (await writeOutput(png, { output: input.output, defaultName: base + '-ascii.png', mimeType: 'image/png' }, ctx)).path;
    } else if (input.output) {
      res.path = (await writeOutput(text + '\n', { output: input.output, defaultName: base + '-ascii.txt', mimeType: 'text/plain' }, ctx)).path;
    }
    return res;
  },
});

const asciiBanner = defineTool({
  name: 'image_ascii_banner',
  title: 'Text to ASCII banner',
  webSlug: 'ascii-art',
  description:
    'Big banner letters from text, using the website\'s own bitmap fonts: block (█ 5×7), char (any fill character, e.g. #), shadow ' +
    '(█ with ░ shade), compact (half-block 5×7), small (█ 3×5), tiny (half-block 3×5). Letters A-Z, digits and common punctuation ' +
    '(unknown characters show as "?"); one banner per input line. Returns the text; format "png" also renders it to banner.png. ' +
    `Web version: ${webUrl('ascii-art')}`,
  inputSchema: z.object({
    text: z.string().min(1).max(200).describe('Text to render (case-insensitive). New lines make separate banners.'),
    style: z.enum(['block', 'char', 'shadow', 'compact', 'small', 'tiny']).optional().default('block').describe('Letter style. Default block.'),
    fill: z.string().max(2).optional().default('#').describe('Fill character(s) for style "char". Default "#".'),
    format: z.enum(['text', 'png']).optional().default('text').describe('text (default) or png (also writes banner.png).'),
    theme: z.enum(['dark', 'light']).optional().default('dark').describe('PNG colours: dark (teal on near-black, default) or light.'),
    output: outputPath(),
  }),
  outputSchema: z.object({ text: z.string(), lines: z.number(), path: z.string().optional() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { text: 'HI', style: 'char', fill: '#' }, output: { text: '##      ##  ######\n##      ##    ##\n…', lines: 7 } }],
  async run(input, ctx) {
    const t = banner(input.text, input.style, input.fill || '#');
    if (!t) throw new ToolError('Type some text first.');
    const res: { text: string; lines: number; path?: string } = { text: t, lines: t.split('\n').length };
    if (input.format === 'png') {
      const dark = input.theme === 'dark';
      const png = await textToPng(t.split('\n'), { size: 16, bg: dark ? '#0b0d10' : '#ffffff', fg: dark ? '#5eead4' : '#0f172a', lineHeight: 1.2 });
      res.path = (await writeOutput(png, { output: input.output, defaultName: 'banner.png', mimeType: 'image/png' }, ctx)).path;
    } else if (input.output) {
      res.path = (await writeOutput(t + '\n', { output: input.output, defaultName: 'banner.txt', mimeType: 'text/plain' }, ctx)).path;
    }
    return res;
  },
});

export default [asciiArt, asciiBanner];

/**
 * Shared helpers for the image tools (not a tool: leading underscore).
 *
 * The website decodes with the browser and re-encodes with <canvas>. Here sharp (libvips) does the decoding,
 * resizing and encoding; @napi-rs/canvas is only used to measure/draw text the way the website does and to
 * decode the few formats sharp can't read (BMP, ICO). Like a browser drawing an <img>, inputs are always
 * auto-oriented from their EXIF Orientation tag.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import sharp, { type Sharp } from 'sharp';
import { z } from 'zod';
import { ToolError, type ToolContext } from '../../../registry.js';
import { readInput } from '../../../util/files.js';

export { sharp };
export type { Sharp };

/** Browser canvas limits used by the website. Larger outputs are scaled down (or refused, as on the site). */
export const MAX_SIDE = 16384;
/** The website uses 40 MP (a browser limit); a local server can afford more. */
export const MAX_AREA = 100e6;

export const OUT_FORMATS = ['png', 'jpeg', 'webp', 'avif', 'gif', 'tiff'] as const;
export type OutFormat = (typeof OUT_FORMATS)[number];
export const MIME: Record<OutFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  tiff: 'image/tiff',
};
export const EXT: Record<OutFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif', gif: 'gif', tiff: 'tif' };

export const qualitySchema = (def: number) =>
  z.number().int().min(1).max(100).optional().default(def).describe(`Quality 1-100 for JPEG / WebP / AVIF (ignored for PNG). Default ${def}, same as the website.`);

export interface Img {
  /** File name of the input ("image" for base64 input). */
  name: string;
  bytes: Buffer;
  /** Source format: sharp's name (jpeg, png, webp, gif, tiff, heif, svg…), "avif" for AV1 HEIF, or bmp / ico. */
  format: string;
  /** Size after EXIF auto-orientation (what a browser shows). */
  width: number;
  height: number;
  hasAlpha: boolean;
  /** EXIF orientation of the input (1 = none). */
  orientation: number;
  /** Decoded pixels for formats sharp can't read. */
  raw?: { data: Buffer; width: number; height: number };
  /** SVG text with an explicit width/height, ready for sharp. */
  svg?: string;
}

const isSvgBytes = (b: Buffer) => {
  const head = b.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trim();
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head);
};

/** Read and decode an image input (path or base64). */
export async function loadImg(value: string, ctx: ToolContext, label = 'image'): Promise<Img> {
  const f = await readInput(value, ctx, label);
  const name = f.path ? f.name : label;
  return decodeImg(f.bytes, name);
}

export async function decodeImg(bytes: Buffer, name = 'image'): Promise<Img> {
  if (!bytes.length) throw new ToolError(`${name}: the file is empty.`);
  if (isSvgBytes(bytes) || /\.svgz?$/i.test(name)) {
    const text = bytes.toString('utf8');
    const size = svgSize(text);
    const svg = setSvgAttrs(text, { width: String(size.w), height: String(size.h) });
    let meta;
    try {
      meta = await sharp(Buffer.from(svg)).metadata();
    } catch {
      throw new ToolError(`${name}: can't read this SVG (invalid or damaged).`);
    }
    return { name, bytes, format: 'svg', width: meta.width ?? size.w, height: meta.height ?? size.h, hasAlpha: true, orientation: 1, svg };
  }
  try {
    const m = await sharp(bytes).metadata();
    const format = m.format === 'heif' && m.compression === 'av1' ? 'avif' : m.format;
    return {
      name,
      bytes,
      format,
      width: m.autoOrient?.width ?? m.width,
      height: m.autoOrient?.height ?? m.height,
      hasAlpha: !!m.hasAlpha,
      orientation: m.orientation ?? 1,
    };
  } catch {
    // BMP, ICO and friends: let Skia decode them.
    try {
      const im = await loadImage(bytes);
      if (!im.width || !im.height) throw new Error('no size');
      const c = createCanvas(im.width, im.height);
      c.getContext('2d').drawImage(im, 0, 0);
      const data = Buffer.from(c.getContext('2d').getImageData(0, 0, im.width, im.height).data.buffer);
      const format = bytes[0] === 0x42 && bytes[1] === 0x4d ? 'bmp' : bytes[0] === 0 && bytes[2] === 1 ? 'ico' : 'image';
      return { name, bytes, format, width: im.width, height: im.height, hasAlpha: true, orientation: 1, raw: { data, width: im.width, height: im.height } };
    } catch {
      throw new ToolError(`${name}: can't read this image (unsupported or damaged).`);
    }
  }
}

/** A fresh sharp pipeline on the decoded, auto-oriented image (first frame of animations). */
export function pipe(img: Img): Sharp {
  if (img.raw) return sharp(img.raw.data, { raw: { width: img.raw.width, height: img.raw.height, channels: 4 } });
  if (img.svg) return sharp(Buffer.from(img.svg));
  return sharp(img.bytes, { autoOrient: true });
}

/** Materialise a pipeline as RGBA pixels (to chain operations sharp would otherwise reorder). */
export async function toRaw(s: Sharp) {
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
export function fromRaw(r: { data: Buffer; width: number; height: number }): Sharp {
  return sharp(r.data, { raw: { width: r.width, height: r.height, channels: 4 } });
}

/** Encode a pipeline. `bg` flattens transparency first (always done for JPEG, as a canvas would be filled). */
export function encode(s: Sharp, fmt: OutFormat, quality = 92, opt: { bg?: string; flatten?: boolean; best?: boolean } = {}): Sharp {
  if (fmt === 'jpeg' || opt.flatten) s = s.flatten({ background: opt.bg ?? '#ffffff' });
  switch (fmt) {
    case 'png':
      return s.png(opt.best ? { compressionLevel: 9, adaptiveFiltering: true } : {});
    case 'jpeg':
      return s.jpeg({ quality, mozjpeg: !!opt.best });
    case 'webp':
      return s.webp({ quality, effort: opt.best ? 6 : 4 });
    case 'avif':
      return s.avif({ quality });
    case 'gif':
      return s.gif();
    case 'tiff':
      return s.tiff({ compression: 'lzw' });
  }
}

/** The format a "keep" setting maps to: same as the input when it is one of `allowed`, else PNG. */
export function keepFormat(img: Pick<Img, 'format'>, allowed: readonly OutFormat[] = ['jpeg', 'png', 'webp']): OutFormat {
  return (allowed as readonly string[]).includes(img.format) ? (img.format as OutFormat) : 'png';
}

/** File name without its extension ("a.b.png" → "a.b"). */
export const stem = (name: string) => name.replace(/\.[^.]+$/, '') || 'image';
/** Same as the website: replace the extension. */
export const outName = (name: string, fmt: OutFormat) => stem(name) + '.' + EXT[fmt];

/** Scale factor so w×h fits the limits (and an optional max side), like the website's fit(). */
export function fit(w: number, h: number, max = 0) {
  let s = 1;
  let note = '';
  if (max && Math.max(w, h) > max) s = max / Math.max(w, h);
  if (w * h * s * s > MAX_AREA) {
    s = Math.sqrt(MAX_AREA / (w * h));
    note = 'scaled to fit the size limit';
  }
  if (Math.max(w, h) * s > MAX_SIDE) {
    s = MAX_SIDE / Math.max(w, h);
    note = 'scaled to fit the size limit';
  }
  return { w: Math.max(1, Math.floor(w * s + 1e-6)), h: Math.max(1, Math.floor(h * s + 1e-6)), scaled: s < 1, note };
}

/** Same as the website's S3.fmtBytes. */
export function fmtBytes(n: number) {
  if (!isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i];
}

/** Validate a colour for sharp / SVG: hex (#rgb, #rrggbb, #rrggbbaa), rgb()/rgba()/hsl() or a CSS name. */
export function color(v: string, field = 'color'): string {
  const s = String(v).trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) return '#' + hex[1].toLowerCase();
  if (/^(rgba?|hsla?)\([\d\s.,%/+-]+\)$/i.test(s) || /^[a-z]{3,30}$/i.test(s)) return s.toLowerCase();
  throw new ToolError(`${field}: "${v}" is not a colour (use #rrggbb, rgb(), or a CSS colour name).`);
}

// ---------- SVG root element (string level, never executed) ----------

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Locate the root <svg …> start tag, skipping the XML declaration, comments and DOCTYPE. */
export function svgRoot(text: string) {
  let i = 0;
  const s = text;
  for (;;) {
    while (i < s.length && /[\s﻿]/.test(s[i])) i++;
    if (s.startsWith('<?', i)) i = s.indexOf('?>', i) + 2;
    else if (s.startsWith('<!--', i)) i = s.indexOf('-->', i) + 3;
    else if (/^<!DOCTYPE/i.test(s.slice(i, i + 9))) {
      const br = s.indexOf('[', i);
      const gt = s.indexOf('>', i);
      i = br >= 0 && br < gt ? s.indexOf(']', br) + 1 : gt;
      i = s.indexOf('>', i) + 1;
    } else break;
    if (i <= 0) throw new ToolError('Not valid SVG');
  }
  const m = /^<(?:[\w.-]+:)?svg(?=[\s/>])/i.exec(s.slice(i));
  if (!m) throw new ToolError('Not valid SVG: the root element is not <svg>.');
  // Find the end of the start tag, respecting quotes.
  let j = i + m[0].length;
  let q = '';
  for (; j < s.length; j++) {
    const ch = s[j];
    if (q) {
      if (ch === q) q = '';
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '>') break;
  }
  if (j >= s.length) throw new ToolError('Not valid SVG: the <svg> tag is not closed.');
  const inner = s.slice(i + m[0].length, j);
  const selfClose = inner.trimEnd().endsWith('/');
  const attrs = new Map<string, string>();
  for (const a of inner.matchAll(ATTR_RE)) attrs.set(a[1], a[3] ?? a[4] ?? '');
  return { start: i, end: j + 1, tag: m[0].slice(1), attrs, selfClose };
}

const escAttr = (v: string) => v.replace(/&(?!(#\d+|#x[0-9a-f]+|\w+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Set (or with `null`, remove) attributes on the root <svg> element. */
export function setSvgAttrs(text: string, set: Record<string, string | null>) {
  const r = svgRoot(text);
  const attrs = new Map(r.attrs);
  for (const [k, v] of Object.entries(set)) {
    if (v == null) attrs.delete(k);
    else attrs.set(k, v);
  }
  if (!attrs.has('xmlns') && !r.tag.includes(':')) attrs.set('xmlns', 'http://www.w3.org/2000/svg');
  const tag = '<' + r.tag + [...attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('') + (r.selfClose ? '/>' : '>');
  return text.slice(0, r.start) + tag + text.slice(r.end);
}

/** Size of an SVG from its width/height or viewBox (image-convert's rule; 1024×1024 when it has neither). */
export function svgSize(text: string) {
  const { attrs } = svgRoot(text);
  const num = (v?: string) => {
    const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v || '');
    return m ? parseFloat(m[1]) : 0;
  };
  const vb = (attrs.get('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  let w = num(attrs.get('width'));
  let h = num(attrs.get('height'));
  const vw = vb.length === 4 ? vb[2] : 0;
  const vh = vb.length === 4 ? vb[3] : 0;
  if (!w && !h && vw && vh) {
    w = vw;
    h = vh;
  } else if (w && !h && vw && vh) h = (w * vh) / vw;
  else if (h && !w && vw && vh) w = (h * vw) / vh;
  if (!w || !h) {
    w = 1024;
    h = 1024;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

// ---------- text (measured like the website's canvas) ----------

let mctx: ReturnType<ReturnType<typeof createCanvas>['getContext']> | undefined;
/** canvas measureText with a CSS font string. */
export function measureText(font: string, text: string) {
  mctx ??= createCanvas(4, 4).getContext('2d');
  mctx.font = font;
  return mctx.measureText(text);
}

/** XML-escape text for SVG (same as the website's S3.esc). */
export const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Standard result of a tool that wrote one image. */
export const imageOutputShape = {
  path: z.string().describe('Absolute path of the written file.'),
  bytes: z.number().describe('Size of the written file in bytes.'),
  mimeType: z.string().optional(),
  base64: z.string().optional(),
  width: z.number().describe('Output width in pixels.'),
  height: z.number().describe('Output height in pixels.'),
  format: z.string().describe('Output format.'),
};

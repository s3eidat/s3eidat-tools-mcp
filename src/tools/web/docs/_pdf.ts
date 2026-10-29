/**
 * Drawing helpers shared by the document makers (invoice, receipt, cards, labels, calendar, resume, attendance).
 * The website lays these out in HTML/canvas and prints; here the same layouts are drawn with pdf-lib.
 * Coordinates are top-down (like canvas/CSS) in a chosen unit (pt or mm), converted to PDF space here.
 *
 * Text uses pdf-lib's standard fonts (WinAnsi encoding): Latin text only for now. User text that WinAnsi can't
 * encode (Arabic, CJK, emoji…) fails with a clear ToolError instead of silently losing characters.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { z } from 'zod';
import { ToolError } from '../../../registry.js';
import type { ToolContext } from '../../../util/context.js';
import { readInput, writeOutput } from '../../../util/files.js';

export const MM = 72 / 25.4;
export const PAPER: Record<string, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4], A5: [148, 210], A6: [105, 148] };

// ---------- WinAnsi (the encoding of the 14 standard PDF fonts) ----------
const WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function isWinAnsi(ch: string) {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_EXTRA.includes(ch);
}

/** Normalise text the tool itself generates (formatter output, month names…) to WinAnsi-safe characters. */
export function pdfSafe(s: string) {
  return String(s)
    .replace(/[⁦-⁩​‎‏﻿]/g, '')
    .replace(/[−‐‑]/g, '-')
    .replace(/[     ]/g, ' ')
    .replace(/[ʻʼʾʿ]/g, "'");
}

/**
 * Check (and lightly normalise) user text for the PDF fonts. Line breaks are kept; tabs become spaces.
 * Throws a ToolError naming the field and the first character that can't be shown.
 */
export function userText(value: string | undefined | null, field: string): string {
  const s = pdfSafe(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  for (const ch of s) {
    if (ch === '\n') continue;
    if (!isWinAnsi(ch)) {
      const code = 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      throw new ToolError(
        `"${field}" contains "${ch}" (${code}), which the built-in PDF fonts can't show. Only Latin text (English and Western ` +
          'European letters) is supported in PDF output for now; Arabic and other scripts are not supported yet. ' +
          'Use the web version for those, or remove the character.',
      );
    }
  }
  return s;
}

/** Run `userText` over every string field of an object (one level deep, plus arrays of objects). */
export function checkAll(obj: unknown, prefix = ''): void {
  if (typeof obj === 'string') { userText(obj, prefix || 'text'); return; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => checkAll(v, `${prefix}[${i}]`)); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) checkAll(v, prefix ? `${prefix}.${k}` : k);
  }
}

// ---------- colours ----------
export const HEX = /^#?[0-9a-f]{6}$/i;
export const colorSchema = (def: string, what: string) =>
  z.string().regex(HEX, 'Use a hex colour like #0e9f9a').optional().default(def).describe(`${what} as a hex colour, e.g. ${def}.`);
export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function color(hex: string): RGB {
  const [r, g, b] = hexRgb(hex);
  return rgb(r / 255, g / 255, b / 255);
}
/** a→b by t (0..1), like the website's mix(). */
export function mixHex(a: string, b: string, t: number) {
  const x = hexRgb(a), y = hexRgb(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
export function luminance(hex: string) {
  const c = hexRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// ---------- fonts ----------
export interface Fonts { sans: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont; monoBold: PDFFont; serif: PDFFont; serifBold: PDFFont }
export async function loadFonts(doc: PDFDocument): Promise<Fonts> {
  const [sans, bold, italic, mono, monoBold, serif, serifBold] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold), doc.embedFont(StandardFonts.HelveticaOblique),
    doc.embedFont(StandardFonts.Courier), doc.embedFont(StandardFonts.CourierBold),
    doc.embedFont(StandardFonts.TimesRoman), doc.embedFont(StandardFonts.TimesRomanBold),
  ]);
  return { sans, bold, italic, mono, monoBold, serif, serifBold };
}

export interface TextOpts {
  size: number;
  font?: PDFFont;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** Max width (units): the text shrinks (down to `minScale` of its size), then gets an ellipsis. */
  maxW?: number;
  minScale?: number;
  opacity?: number;
}
export interface ShapeOpts { fill?: string; stroke?: string; lineWidth?: number; opacity?: number; dash?: number[] }

/** A page (or a box on a page) addressed top-down in custom units: x right, y down, `k` points per unit. */
export class Draw {
  constructor(public page: PDFPage, public fonts: Fonts, public k = 1, public ox = 0, public oy = page.getHeight()) {}
  /** A sub-box: origin at (x, y) units, scaled by `scale` (new unit = scale old units). */
  sub(x: number, y: number, scale = 1) {
    return new Draw(this.page, this.fonts, this.k * scale, this.ox + x * this.k, this.oy - y * this.k);
  }
  X(x: number) { return this.ox + x * this.k; }
  Y(y: number) { return this.oy - y * this.k; }
  rect(x: number, y: number, w: number, h: number, o: ShapeOpts) {
    this.page.drawRectangle({
      x: this.X(x), y: this.Y(y + h), width: w * this.k, height: h * this.k,
      color: o.fill ? color(o.fill) : undefined, borderColor: o.stroke ? color(o.stroke) : undefined,
      borderWidth: o.stroke ? (o.lineWidth ?? 1) * this.k : 0, opacity: o.opacity, borderOpacity: o.opacity,
      borderDashArray: o.dash?.map((d) => d * this.k),
    });
  }
  /** SVG path data in this box's units (y down). */
  path(d: string, o: ShapeOpts) {
    if (!d) return;
    this.page.drawSvgPath(d, {
      x: this.ox, y: this.oy, scale: this.k,
      color: o.fill ? color(o.fill) : undefined, borderColor: o.stroke ? color(o.stroke) : undefined,
      borderWidth: o.stroke ? o.lineWidth ?? 1 : undefined, opacity: o.opacity, borderOpacity: o.opacity,
      borderDashArray: o.dash, borderLineCap: o.stroke ? 1 : undefined,
    });
  }
  roundRect(x: number, y: number, w: number, h: number, r: number, o: ShapeOpts) { this.path(roundRectPath(x, y, w, h, r), o); }
  line(x1: number, y1: number, x2: number, y2: number, o: { color?: string; width?: number; dash?: number[]; opacity?: number }) {
    this.page.drawLine({
      start: { x: this.X(x1), y: this.Y(y1) }, end: { x: this.X(x2), y: this.Y(y2) },
      thickness: (o.width ?? 1) * this.k, color: color(o.color ?? '#000000'), dashArray: o.dash?.map((d) => d * this.k), opacity: o.opacity,
    });
  }
  width(s: string, size: number, font: PDFFont = this.fonts.sans) { return font.widthOfTextAtSize(pdfSafe(s), size * this.k) / this.k; }
  /** Fit text into maxW: shrink in 6% steps down to minScale, then trim with "…". */
  fit(s: string, o: TextOpts) {
    s = pdfSafe(s);
    const font = o.font ?? this.fonts.sans;
    let size = o.size, w = this.width(s, size, font);
    if (!o.maxW || w <= o.maxW) return { text: s, size, width: w };
    const min = o.size * (o.minScale ?? 1);
    while (w > o.maxW && size * 0.94 >= min - 1e-9) { size *= 0.94; w = this.width(s, size, font); }
    if (w > o.maxW) {
      const chars = Array.from(s);
      while (chars.length > 1 && this.width(chars.join('') + '…', size, font) > o.maxW) chars.pop();
      s = chars.join('') + '…';
      w = this.width(s, size, font);
    }
    return { text: s, size, width: w };
  }
  /** Draw one line of text with its baseline at y. Returns the drawn width. */
  text(s: string, x: number, y: number, o: TextOpts) {
    if (!s) return 0;
    const font = o.font ?? this.fonts.sans;
    const f = this.fit(s, o);
    const dx = o.align === 'center' ? -f.width / 2 : o.align === 'right' ? -f.width : 0;
    this.page.drawText(f.text, { x: this.X(x + dx), y: this.Y(y), size: f.size * this.k, font, color: color(o.color ?? '#111111'), opacity: o.opacity });
    return f.width;
  }
  image(img: PDFImage, x: number, y: number, w: number, h: number) {
    this.page.drawImage(img, { x: this.X(x), y: this.Y(y + h), width: w * this.k, height: h * this.k });
  }
  /** Draw an image contained in a box; returns the drawn size or null. */
  imageIn(img: PDFImage | undefined, x: number, y: number, bw: number, bh: number, align: 'left' | 'center' | 'right' = 'left', valign: 'top' | 'middle' = 'middle') {
    if (!img) return null;
    const k = Math.min(bw / img.width, bh / img.height), w = img.width * k, h = img.height * k;
    const dx = align === 'center' ? (bw - w) / 2 : align === 'right' ? bw - w : 0;
    this.image(img, x + dx, valign === 'top' ? y : y + (bh - h) / 2, w, h);
    return { w, h };
  }
}

export function roundRectPath(x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return `M${x} ${y}h${w}v${h}h${-w}z`;
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - h}a${r} ${r} 0 0 1 ${r} ${-r}z`;
}

/**
 * Greedy word wrap (same algorithm as the receipt maker): words longer than a line are split by character.
 * Explicit line breaks are kept.
 */
export function wrap(measure: (t: string) => number, text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    const start = out.length;
    for (let w of para.split(/\s+/).filter(Boolean)) {
      while (measure(w) > max && Array.from(w).length > 1) {
        const ch = Array.from(w);
        let k = ch.length;
        while (k > 1 && measure(ch.slice(0, k).join('')) > max) k--;
        if (line) { out.push(line); line = ''; }
        out.push(ch.slice(0, k).join(''));
        w = ch.slice(k).join('');
      }
      const t = line ? line + ' ' + w : w;
      if (measure(t) > max && line) { out.push(line); line = w; } else line = t;
    }
    if (line || out.length === start) out.push(line);
  }
  return out.length ? out : [''];
}

// ---------- images ----------
export const imageInput = (what = 'logo image') =>
  z.string().min(1).optional().describe(`Optional ${what}: a PNG/JPEG/WebP/GIF/SVG file path or base64. Drawn as-is (keep it small).`);

/** Embed an image file (any format sharp reads). JPEG/PNG go in as-is; others are converted to PNG. */
export async function embedImage(doc: PDFDocument, value: string | undefined, ctx: ToolContext, label = 'logo', maxPx = 1200): Promise<PDFImage | undefined> {
  if (!value) return undefined;
  const file = await readInput(value, ctx, label);
  const b = file.bytes;
  const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const isJpg = b[0] === 0xff && b[1] === 0xd8;
  try {
    if (isJpg || isPng) {
      const { default: sharp } = await import('sharp');
      const meta = await sharp(b).metadata();
      if (Math.max(meta.width ?? 0, meta.height ?? 0) <= maxPx && !(isPng && meta.bitsPerSample === 16)) {
        return isJpg ? await doc.embedJpg(b) : await doc.embedPng(b);
      }
    }
    const { default: sharp } = await import('sharp');
    const png = await sharp(b, { density: 300 }).rotate().resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return await doc.embedPng(png);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`${label}: couldn't read that image (${e instanceof Error ? e.message : String(e)}).`);
  }
}

// ---------- output ----------
export const pdfOutputShape = {
  path: z.string().describe('Absolute path of the written PDF.'),
  bytes: z.number().describe('Size in bytes.'),
  pages: z.number().describe('Number of pages.'),
  mimeType: z.string().optional(),
  base64: z.string().optional(),
};

export async function newDoc(title: string, ctx: ToolContext) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('S3eidat Tools (s3eidat-tools-mcp)');
  doc.setProducer(`s3eidat-tools-mcp ${ctx.version} / pdf-lib`);
  doc.setCreationDate(new Date());
  return { doc, fonts: await loadFonts(doc) };
}

export async function savePdf(doc: PDFDocument, opts: { output?: string; defaultName: string; base64?: boolean }, ctx: ToolContext) {
  const bytes = await doc.save();
  const out = await writeOutput(bytes, { output: opts.output, defaultName: opts.defaultName, mimeType: 'application/pdf', base64: opts.base64 }, ctx);
  return { ...out, pages: doc.getPageCount() };
}

/** Half-up rounding to d decimals without float drift (1.005 -> 1.01), shared by invoice and receipt. */
export function round(n: number, d: number) {
  if (!isFinite(n)) return 0;
  const s = n < 0 ? -1 : 1, a = +Math.abs(n).toPrecision(12), str = String(a);
  if (/e/i.test(str)) return (s * Math.round(a * Math.pow(10, d))) / Math.pow(10, d);
  return s * Number(Math.round(Number(str + 'e' + d)) + 'e-' + d);
}
export function num(v: unknown) {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isFinite(n) ? n : 0;
}

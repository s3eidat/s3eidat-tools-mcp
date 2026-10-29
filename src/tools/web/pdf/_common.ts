/**
 * Shared helpers for the PDF tools (not a tool: the leading underscore keeps it out of discovery).
 * Ported from the s3eidat.github.io PDF tools so page ranges, placement maths and messages match the website.
 */
import { z } from 'zod';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { ToolError, type ToolContext } from '../../../registry.js';
import { fileInput, outputPath, readInput, returnBase64, writeOutput, type InputFile } from '../../../util/files.js';
import { loadPdfLib } from '../../../util/pdf.js';

export { fileInput, outputPath, returnBase64 };

/** Read a PDF input and open it with pdf-lib (website error messages for encrypted/bad files). */
export async function openPdf(value: string, ctx: ToolContext, label = 'PDF') {
  const input = await readInput(value, ctx, label);
  const doc = await loadPdfLib(input.bytes, label === 'PDF' ? 'This PDF' : label);
  return { input, doc };
}

/** "report.pdf" -> "report"; base64 input -> "document". */
export function baseName(input: InputFile) {
  return input.path ? input.name.replace(/\.pdf$/i, '') || 'document' : 'document';
}

/** Save a pdf-lib document to the output and return the standard result. */
export async function savePdf(
  doc: PDFDocument | Uint8Array,
  opts: { output?: string; defaultName: string; returnBase64?: boolean },
  ctx: ToolContext,
) {
  const bytes = doc instanceof Uint8Array ? doc : await doc.save();
  const name = /\.pdf$/i.test(opts.defaultName) ? opts.defaultName : opts.defaultName + '.pdf';
  return writeOutput(bytes, { output: opts.output, defaultName: name, mimeType: 'application/pdf', base64: opts.returnBase64 }, ctx);
}

export const pdfFileOutput = {
  path: z.string().describe('Absolute path of the written PDF.'),
  bytes: z.number().describe('Size of the written PDF in bytes.'),
  mimeType: z.string().optional(),
  base64: z.string().optional(),
};

export const pagesSpec = (what = 'Pages') =>
  z
    .string()
    .optional()
    .describe(`${what}: 1-based list like "1-3, 5, 8-" ("5-" = to the end, "-3" = first three, "3-1" = reversed). Also "all", "odd", "even", "last". Empty = all pages.`);

// ---------- page ranges (the website's parser, plus all/odd/even/last for agents) ----------

export interface RangeGroup { label: string; pages: number[] }

/**
 * "1-3, 5, 8-" -> groups of 0-based pages, in the order written (descending ranges stay descending).
 * Same rules and messages as the website (pdf-merge / pdf-split): separators "," or ";", "a-b", "a-", "-b".
 */
export function parseRangeGroups(str: string | undefined, n: number, keepEmpty = false): RangeGroup[] {
  const groups: RangeGroup[] = [];
  for (let part of String(str ?? '').split(/[,;]+/)) {
    part = part.trim();
    if (!part) continue;
    const low = part.toLowerCase().replace(/\s+/g, '');
    if (low === 'all' || low === '*') { groups.push({ label: 'all', pages: Array.from({ length: n }, (_, i) => i) }); continue; }
    if (low === 'odd') { groups.push({ label: 'odd', pages: Array.from({ length: n }, (_, i) => i).filter((i) => i % 2 === 0) }); continue; }
    if (low === 'even') { groups.push({ label: 'even', pages: Array.from({ length: n }, (_, i) => i).filter((i) => i % 2 === 1) }); continue; }
    const p = low.replace(/last|end/g, String(n));
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(p);
    let a: number, b: number;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
    else if (/^\d+$/.test(p)) a = b = +p;
    else throw new ToolError(`“${part}” isn't a page or range`);
    if (a < 1 || b < 1 || a > n || b > n) throw new ToolError(`Page ${a > n || a < 1 ? a : b} doesn't exist (the file has ${n})`);
    const g: number[] = [];
    for (let q = a; a <= b ? q <= b : q >= b; q += a <= b ? 1 : -1) g.push(q - 1);
    groups.push({ label: part.replace(/\s+/g, ''), pages: g });
  }
  if (!groups.length && !keepEmpty) throw new ToolError('No pages selected');
  return groups;
}

/** Pages in the order written, duplicates kept (pdf-merge). Empty -> all pages. */
export function parseRangeList(str: string | undefined, n: number): number[] {
  if (!String(str ?? '').trim()) return Array.from({ length: n }, (_, i) => i);
  return parseRangeGroups(str, n).flatMap((g) => g.pages);
}

/** Sorted unique pages (pdf-watermark / pdf-page-numbers / pdf-to-images). Empty -> all pages. */
export function parseRangeSet(str: string | undefined, n: number): Set<number> {
  if (!String(str ?? '').trim()) return new Set(Array.from({ length: n }, (_, i) => i));
  const all = parseRangeGroups(str, n).flatMap((g) => g.pages);
  return new Set(all.sort((a, b) => a - b));
}

/** Sorted unique 0-based pages -> "1-3, 5" (pdf-split). */
export function toRangeText(pages: number[]) {
  const s = [...new Set(pages)].sort((a, b) => a - b), out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i] + 1}-${s[j] + 1}` : String(s[i] + 1));
    i = j;
  }
  return out.join(', ');
}

// ---------- page geometry ----------

export const norm = (r: number) => ((r % 360) + 360) % 360;
export interface Box { x: number; y: number; w: number; h: number }

/** A point on the page as shown (X right, Y up, origin bottom-left) -> PDF user space, for any /Rotate. */
export function toUser(box: Box, rot: number, X: number, Y: number): [number, number] {
  switch (norm(rot)) {
    case 90: return [box.x + box.w - Y, box.y + X];
    case 180: return [box.x + box.w - X, box.y + box.h - Y];
    case 270: return [box.x + Y, box.y + box.h - X];
    default: return [box.x + X, box.y + Y];
  }
}

export const shownSize = (box: { w: number; h: number }, rot: number): [number, number] => (rot % 180 ? [box.h, box.w] : [box.w, box.h]);

/** Crop box, rotation and shown size of a pdf-lib page. */
export function pageGeom(pg: PDFPage) {
  const cb = pg.getCropBox(), box: Box = { x: cb.x, y: cb.y, w: cb.width, h: cb.height }, rot = norm(pg.getRotation().angle);
  const [W, H] = shownSize(box, rot);
  return { box, rot, W, H };
}

export const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;
export const colorSchema = (def: string) =>
  z.string().regex(HEX_COLOR, 'Use a hex colour like "#d64545".').optional().default(def).describe(`Colour as hex "#rrggbb". Default ${def}.`);

export function hexRgb(hex: string) {
  const n = parseInt(String(hex).replace(/^#/, ''), 16) || 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
export const cssHex = (hex: string) => (hex.startsWith('#') ? hex : '#' + hex);

export function encodable(font: PDFFont, s: string) {
  try { font.encodeText(s); return true; } catch { return false; }
}

export const isRtlChar = (s: string) => /[֐-ࣿ]/.test(s);

// ---------- canvas helpers (text the standard fonts can't encode is drawn as an image, like the website) ----------

type Canvas = import('@napi-rs/canvas').Canvas;
let canvasMod: Promise<typeof import('@napi-rs/canvas')> | undefined;
export const canvasLib = () => (canvasMod ??= import('@napi-rs/canvas'));

export const SANS = "Helvetica, Arial, 'Liberation Sans', 'DejaVu Sans', 'Noto Sans Arabic', sans-serif";
export const CSS_FONTS: Record<string, [string, string]> = {
  Helvetica: ['', SANS],
  HelveticaBold: ['bold ', SANS],
  TimesRoman: ['', "'Times New Roman', Times, 'Liberation Serif', 'DejaVu Serif', serif"],
  TimesRomanBold: ['bold ', "'Times New Roman', Times, 'Liberation Serif', 'DejaVu Serif', serif"],
  Courier: ['', "'Courier New', Courier, 'Liberation Mono', 'DejaVu Sans Mono', monospace"],
  CourierBold: ['bold ', "'Courier New', Courier, 'Liberation Mono', 'DejaVu Sans Mono', monospace"],
};
export function cssFont(key: string, px: number) {
  const f = CSS_FONTS[key] ?? CSS_FONTS.Helvetica;
  return `${f[0]}${px}px ${f[1]}`;
}

/** Width of text in the PDF font, or measured by canvas when the font can't encode it (website `widthWith`). */
export async function widthWith(font: PDFFont, key: string) {
  const { createCanvas } = await canvasLib();
  const m = createCanvas(4, 4).getContext('2d');
  return (t: string, s: number) => {
    try { return font.widthOfTextAtSize(t, s); } catch { m.font = cssFont(key, s); return m.measureText(t).width; }
  };
}

/** One line of text as a PNG at 4x (website `textPng`): baseline 0.95*size from the top, height 1.25*size. */
export async function textPng(text: string, size: number, color: string, key: string) {
  const { createCanvas } = await canvasLib();
  const k = 4, probe = createCanvas(4, 4).getContext('2d');
  probe.font = cssFont(key, size * k);
  const c = createCanvas(Math.max(1, Math.ceil(probe.measureText(text).width) + 4), Math.ceil(size * 1.25 * k));
  const x = c.getContext('2d');
  x.font = cssFont(key, size * k);
  x.fillStyle = cssHex(color);
  x.direction = isRtlChar(text) ? 'rtl' : 'ltr';
  x.textAlign = 'left';
  x.fillText(text, 2, size * 0.95 * k);
  return { png: Buffer.from(await c.encode('png')), w: c.width / k, h: c.height / k };
}

/** Render a pdf.js page to a canvas at `scale` (white background unless `transparent`). */
export async function renderToCanvas(
  page: { getViewport(o: { scale: number }): { width: number; height: number }; render(o: object): { promise: Promise<unknown> } },
  scale: number,
  opts: { transparent?: boolean; round?: 'round' | 'floor' } = {},
): Promise<Canvas> {
  const { createCanvas } = await canvasLib();
  const vp = page.getViewport({ scale }), r = opts.round === 'floor' ? Math.floor : Math.round;
  const c = createCanvas(Math.max(1, r(vp.width)), Math.max(1, r(vp.height)));
  const x = c.getContext('2d');
  if (!opts.transparent) { x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({ canvas: c as any, canvasContext: x as any, viewport: vp, background: opts.transparent ? 'rgba(0,0,0,0)' : '#ffffff' }).promise;
  return c;
}

/** Normalise any image sharp can read to PNG (or keep JPEG/PNG bytes when already fine). */
export async function toPng(bytes: Buffer) {
  const sharp = (await import('sharp')).default;
  try {
    const { data, info } = await sharp(bytes, { failOn: 'none' }).rotate().png().toBuffer({ resolveWithObject: true });
    return { png: data, w: info.width, h: info.height };
  } catch (e) {
    throw new ToolError(`The image couldn't be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

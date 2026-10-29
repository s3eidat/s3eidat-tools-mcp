import { z } from 'zod';
import { StandardFonts, degrees, type PDFImage } from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { readInput } from '../../../util/files.js';
import {
  baseName, colorSchema, cssHex, encodable, fileInput, hexRgb, openPdf, outputPath, pageGeom, pagesSpec, parseRangeSet,
  pdfFileOutput, returnBase64, savePdf, textPng, toUser, widthWith,
} from './_common.js';

// Ported from https://github.com/s3eidat/pdf-watermark (app.js): same placement maths, tiling and defaults.
const FONTS = { HelveticaBold: StandardFonts.HelveticaBold, Helvetica: StandardFonts.Helvetica, TimesRomanBold: StandardFonts.TimesRomanBold, CourierBold: StandardFonts.CourierBold };
type FontKey = keyof typeof FONTS;
export const DEF = { kind: 'text', text: 'CONFIDENTIAL', font: 'HelveticaBold', color: '#d64545', size: 72, scale: 40, opacity: 25, rot: 45, mode: 'center', gap: 80, range: '' } as const;

export interface WmCfg { kind: 'text' | 'image'; text: string; font: FontKey; color: string; size: number; scale: number; opacity: number; rot: number; mode: 'center' | 'tile'; gap: number; range: string }
interface Mark { w: number; h: number; ox: number; oy: number }

const rotV = (deg: number, dx: number, dy: number): [number, number] => {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [c * dx - s * dy, s * dx + c * dy];
};

/** The stamp's local size and the local point that should sit on its visual centre. */
export function markFor(cfg: Pick<WmCfg, 'kind' | 'scale' | 'text' | 'size'>, W: number, widthOf: (t: string, s: number) => number, img?: { w: number; h: number } | null): Mark {
  if (cfg.kind === 'image') { const w = (W * cfg.scale) / 100, hh = img ? (w * img.h) / img.w : w; return { w, h: hh, ox: w / 2, oy: hh / 2 }; }
  const w = widthOf(cfg.text, cfg.size);
  return { w, h: cfg.size * 0.75, ox: w / 2, oy: cfg.size * 0.36 };
}

/** Anchors (local origin: text baseline-left / image bottom-left) on a page shown W x H, y up. */
export function placements(W: number, H: number, mark: Mark, cfg: Pick<WmCfg, 'rot' | 'mode' | 'gap'>) {
  const anchor = (cx: number, cy: number): [number, number] => { const [dx, dy] = rotV(cfg.rot, mark.ox, mark.oy); return [cx - dx, cy - dy]; };
  if (cfg.mode !== 'tile') return [anchor(W / 2, H / 2)];
  const t = (cfg.rot * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const bw = mark.w * c + mark.h * s, bh = mark.w * s + mark.h * c, sx = Math.max(8, bw + cfg.gap), sy = Math.max(8, bh + cfg.gap), out: [number, number][] = [];
  for (let r = 0, cy = H / 2; cy > -bh; r++, cy -= sy) {
    for (const yy of r ? [H / 2 + r * sy, cy] : [cy]) {
      const off = r % 2 ? sx / 2 : 0;
      for (let cx = W / 2 + off; cx < W + bw; cx += sx) out.push(anchor(cx, yy));
      for (let cx = W / 2 + off - sx; cx > -bw; cx -= sx) out.push(anchor(cx, yy));
      if (out.length > 800) return out;
    }
  }
  return out;
}

export async function stampPdf(doc: Awaited<ReturnType<typeof openPdf>>['doc'], cfg: WmCfg, img?: { png: Uint8Array; w: number; h: number } | null) {
  const pages = doc.getPages(), sel = parseRangeSet(cfg.range, pages.length), opacity = cfg.opacity / 100;
  const font = await doc.embedFont(FONTS[cfg.font] ?? StandardFonts.HelveticaBold), widthOf = await widthWith(font, cfg.font), color = hexRgb(cfg.color);
  let image: PDFImage | null = null, tImg: { emb: PDFImage; w: number; h: number } | null = null;
  if (cfg.kind === 'image') { if (!img) throw new ToolError('Give "image" for an image watermark.'); image = await doc.embedPng(img.png); }
  else if (!encodable(font, cfg.text)) { const t = await textPng(cfg.text, cfg.size, cssHex(cfg.color), cfg.font); tImg = { emb: await doc.embedPng(t.png), w: t.w, h: t.h }; }
  let stamped = 0;
  for (let i = 0; i < pages.length; i++) {
    if (!sel.has(i)) continue;
    const pg = pages[i], { box, rot, W, H } = pageGeom(pg);
    const mark = markFor(cfg, W, widthOf, img), angle = degrees(cfg.rot + rot);
    for (const [ax, ay] of placements(W, H, mark, cfg)) {
      if (image) { const [x, y] = toUser(box, rot, ax, ay); pg.drawImage(image, { x, y, width: mark.w, height: mark.h, rotate: angle, opacity }); }
      else if (tImg) { const [dx, dy] = rotV(cfg.rot, -0.5, -cfg.size * 0.3), [x, y] = toUser(box, rot, ax + dx, ay + dy); pg.drawImage(tImg.emb, { x, y, width: tImg.w, height: tImg.h, rotate: angle, opacity }); }
      else { const [x, y] = toUser(box, rot, ax, ay); pg.drawText(cfg.text, { x, y, size: cfg.size, font, color, rotate: angle, opacity }); }
    }
    stamped++;
  }
  return stamped;
}

/** Image watermark: any format sharp reads, scaled to at most 1600 px (like the website) and stored as PNG. */
async function prepareImage(bytes: Buffer) {
  const sharp = (await import('sharp')).default;
  try {
    const { data, info } = await sharp(bytes, { failOn: 'none' }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    return { png: data, w: info.width, h: info.height };
  } catch (e) {
    throw new ToolError(`The watermark image couldn't be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export default defineTool({
  name: 'pdf_watermark',
  title: 'Watermark PDF',
  webSlug: 'pdf-watermark',
  description:
    'Stamp a text or image watermark on PDF pages: centred or tiled across the page, with opacity, angle, size, colour and ' +
    'a page range. It reads upright on rotated pages. Text the standard PDF fonts cannot draw (Arabic, CJK…) is stamped as an ' +
    `image. Defaults match the website: "CONFIDENTIAL", Helvetica Bold 72 pt, #d64545, 25% opacity, 45°. Web version: ${webUrl('pdf-watermark')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    text: z.string().optional().describe('Watermark text (default "CONFIDENTIAL"). Ignored when "image" is given.'),
    image: z.string().optional().describe('Image watermark instead of text: a local path or base64 (PNG, JPEG, WebP, SVG…).'),
    font: z.enum(['HelveticaBold', 'Helvetica', 'TimesRomanBold', 'CourierBold']).optional().default('HelveticaBold').describe('Font for text.'),
    size: z.number().min(4).max(400).optional().default(72).describe('Text size in points. Default 72.'),
    color: colorSchema('#d64545'),
    scale: z.number().min(1).max(100).optional().default(40).describe('Image width as % of the page width. Default 40.'),
    opacity: z.number().min(1).max(100).optional().default(25).describe('Opacity in % (1-100). Default 25.'),
    angle: z.number().min(-360).max(360).optional().default(45).describe('Rotation in degrees, counter-clockwise as shown. Default 45.'),
    mode: z.enum(['center', 'tile']).optional().default('center').describe('"center": one stamp in the middle; "tile": repeated across the page.'),
    gap: z.number().min(0).max(1000).optional().default(80).describe('Space between tiles in points (tile mode). Default 80.'),
    pages: pagesSpec('Pages to stamp'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...pdfFileOutput, pagesStamped: z.number() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'roadmap.pdf', text: 'DRAFT', opacity: 20 } },
    { input: { file: 'brochure.pdf', image: 'logo.png', mode: 'tile', scale: 15, angle: 0, opacity: 10 } },
  ],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    const img = input.image ? await prepareImage((await readInput(input.image, ctx, 'image')).bytes) : null;
    const text = input.text ?? DEF.text;
    if (!img && !text.trim()) throw new ToolError('Give the watermark "text" or an "image".');
    const cfg: WmCfg = {
      kind: img ? 'image' : 'text', text, font: input.font, color: input.color, size: input.size, scale: input.scale,
      opacity: input.opacity, rot: input.angle, mode: input.mode, gap: input.gap, range: input.pages ?? '',
    };
    const n = await stampPdf(doc, cfg, img);
    const w = await savePdf(doc, { output: input.output, defaultName: baseName(f) + '-watermarked.pdf', returnBase64: input.returnBase64 }, ctx);
    return { ...w, pagesStamped: n };
  },
});

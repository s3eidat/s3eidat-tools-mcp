/**
 * Small SVG helpers shared by ai_chart and ai_diagram (not a tool: leading underscore).
 * Text is measured with Helvetica/Arial metrics so layouts are stable without a canvas or a browser.
 */
import { z } from 'zod';
import { ToolError } from '../../registry.js';

export const FONT_STACK = 'Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif';

/** Helvetica advance widths (1/1000 em) for printable ASCII 0x20..0x7e. */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD_K = 1.08;

/** Approximate rendered width of one line of text in px. */
export function textWidth(s: string, size: number, bold = false) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c <= 0x7e) w += HELV[c - 0x20];
    else if (c >= 0x2e80) w += 1000; // CJK and wide symbols
    else w += 600;
  }
  return (w / 1000) * size * (bold ? BOLD_K : 1);
}

export function escapeXml(s: string) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const imageFormat = () => z.enum(['svg', 'png']).optional().default('svg').describe('Output format: svg (default) or png.');
export const scaleSchema = () =>
  z.number().min(0.25).max(8).optional().default(2).describe('PNG only: pixel density multiplier (2 = twice the SVG size, sharp on high-DPI screens). Default 2.');

/** Width/height of an SVG root (px). */
export function svgSize(svg: string) {
  const m = /<svg\b[^>]*>/i.exec(svg);
  const tag = m?.[0] ?? '';
  const w = parseFloat(/\swidth="([\d.]+)/.exec(tag)?.[1] ?? '0');
  const h = parseFloat(/\sheight="([\d.]+)/.exec(tag)?.[1] ?? '0');
  return { width: Math.round(w), height: Math.round(h) };
}

/** Rasterise SVG text to PNG with sharp at `scale` × its own size. */
export async function svgToPng(svg: string, scale = 2, background?: string) {
  const { default: sharp } = await import('sharp');
  const { width, height } = svgSize(svg);
  if (width * scale * height * scale > 100e6) throw new ToolError(`The PNG would be ${Math.round(width * scale)}×${Math.round(height * scale)} px; lower "scale" or the size.`);
  try {
    let s = sharp(Buffer.from(svg), { density: 72 * scale });
    if (background) s = s.flatten({ background });
    const { data, info } = await s.png().toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  } catch (e) {
    throw new ToolError(`Couldn't render the SVG to PNG (${e instanceof Error ? e.message : String(e)}).`);
  }
}

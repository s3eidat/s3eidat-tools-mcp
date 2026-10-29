import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, outputPath, readInput, returnBase64, writeOutput } from '../../../util/files.js';
import { color, MAX_AREA, MAX_SIDE, sanitizeSvg, setSvgAttrs, sharp, svgRoot } from './_img.js';

// Port of https://github.com/s3eidat/svg-to-png (app.js): the SVG is asked to render at the output size itself, so it is
// rasterised sharp (never upscaled). Scripts, event handlers and external references are removed and never run or load.

const UNIT: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
export function len(v?: string) {
  const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v || '');
  return m ? parseFloat(m[1]) * UNIT[(m[2] || '').toLowerCase()] : 0;
}
/** Natural size of an SVG (CSS units honoured; 300×150 like a browser when it has no size at all). */
export function parse(text: string) {
  let r;
  try {
    r = svgRoot(text);
  } catch (e) {
    throw new ToolError((e as Error).message.replace(/^Not valid SVG.*/, 'Not valid SVG: the root element is not <svg>.'));
  }
  const vb = (r.attrs.get('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
  let w = len(r.attrs.get('width'));
  let h = len(r.attrs.get('height'));
  if (!w && !h && hasVb) {
    w = vb[2];
    h = vb[3];
  } else if (w && !h) h = hasVb ? (w * vb[3]) / vb[2] : w;
  else if (h && !w) w = hasVb ? (h * vb[2]) / vb[3] : h;
  if (!w || !h) {
    w = 300;
    h = 150;
  }
  return { w, h, hasVb };
}
export interface SvgOpts {
  mode: 'scale' | 'width' | 'height' | 'exact';
  scale?: number;
  w?: number;
  h?: number;
}
export function target(nw: number, nh: number, opt: SvgOpts) {
  let w: number;
  let h: number;
  if (opt.mode === 'scale') {
    w = nw * (opt.scale ?? 1);
    h = nh * (opt.scale ?? 1);
  } else if (opt.mode === 'width') {
    w = +(opt.w ?? 0) || nw;
    h = (w * nh) / nw;
  } else if (opt.mode === 'height') {
    h = +(opt.h ?? 0) || nh;
    w = (h * nw) / nh;
  } else {
    w = +(opt.w ?? 0) || nw;
    h = +(opt.h ?? 0) || nh;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_AREA) throw new ToolError(w + '×' + h + ' is too large (limit ' + MAX_SIDE + ' px a side, ' + MAX_AREA / 1e6 + ' MP).');
  return { w, h };
}
export function pngName(name: string, opt: SvgOpts) {
  const base = name.replace(/\.svgz?$/i, '');
  return opt.mode === 'scale' && (opt.scale ?? 1) > 1 ? base + '@' + opt.scale + 'x.png' : base + '.png';
}

export async function render(text: string, opt: SvgOpts & { transparent: boolean; bg?: string }) {
  const p = parse(text);
  const t = target(p.w, p.h, opt);
  const set: Record<string, string> = { width: String(t.w), height: String(t.h) };
  if (!p.hasVb) set.viewBox = '0 0 ' + p.w + ' ' + p.h; // lets us scale it to any size
  if (opt.mode === 'exact') set.preserveAspectRatio = 'none';
  const svg = sanitizeSvg(setSvgAttrs(text, set));
  let s = sharp(Buffer.from(svg), { density: 72 });
  // librsvg may round sizes; make sure the PNG is exactly the size asked for.
  s = s.resize(t.w, t.h, { fit: 'fill' });
  if (!opt.transparent) s = s.flatten({ background: opt.bg ?? '#ffffff' });
  let buf: Buffer;
  try {
    buf = await s.png().toBuffer();
  } catch (e) {
    throw new ToolError('Could not draw this SVG: ' + (e as Error).message);
  }
  return { buf, w: t.w, h: t.h, nw: Math.round(p.w), nh: Math.round(p.h) };
}

export default defineTool({
  name: 'image_svg_to_png',
  title: 'SVG to PNG',
  webSlug: 'svg-to-png',
  description:
    'Rasterise an SVG to a crisp PNG: scale (1×, 2×, 3×, 4×… default 2×), a target width or height (aspect kept), or an exact size ' +
    '(stretched). Units (px, pt, mm, cm, in) and viewBox-only SVGs are understood; transparent background or a solid colour. ' +
    `Scripts, event handlers and external references are removed first. Name <name>@2x.png. Web version: ${webUrl('svg-to-png')}`,
  inputSchema: z.object({
    svg: fileInput('SVG file').optional().describe('The SVG: a local path or base64 / data URI.'),
    svgText: z.string().optional().describe('Or: the SVG code itself.'),
    mode: z.enum(['scale', 'width', 'height', 'exact']).optional().default('scale').describe('How to size the PNG. Default scale.'),
    scale: z.number().min(0.01).max(64).optional().default(2).describe('Scale factor for mode "scale". Default 2.'),
    width: z.number().int().min(1).max(MAX_SIDE).optional().describe('Width in px for modes width / exact.'),
    height: z.number().int().min(1).max(MAX_SIDE).optional().describe('Height in px for modes height / exact.'),
    transparent: z.boolean().optional().default(true).describe('Keep the background transparent. Default true.'),
    background: z.string().optional().default('#ffffff').describe('Background colour when transparent is false. Default #ffffff.'),
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
    svgWidth: z.number().describe('Natural width of the SVG.'),
    svgHeight: z.number().describe('Natural height of the SVG.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { svg: '/icons/logo.svg', scale: 3 }, note: 'Writes logo@3x.png.' },
    { input: { svgText: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"/>', mode: 'width', width: 200 }, note: '200×100 PNG.' },
  ],
  async run(input, ctx) {
    let text: string;
    let name = 'image.svg';
    if (input.svgText != null) text = input.svgText;
    else if (input.svg) {
      const f = await readInput(input.svg, ctx, 'svg');
      text = f.bytes.toString('utf8');
      if (f.path) name = f.name;
    } else throw new ToolError('Give "svg" (a file) or "svgText" (the SVG code).');
    const opt: SvgOpts = { mode: input.mode, scale: input.scale, w: input.width, h: input.height };
    const r = await render(text, { ...opt, transparent: input.transparent, bg: color(input.background, 'background') });
    const out = await writeOutput(r.buf, { output: input.output, defaultName: pngName(name, opt), mimeType: 'image/png', base64: input.returnBase64 }, ctx);
    return { ...out, width: r.w, height: r.h, svgWidth: r.nw, svgHeight: r.nh };
  },
});

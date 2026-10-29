import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/css-units (app.js): 96 CSS px per inch as the CSS spec defines, the same
// rounding, and the same fluid clamp() builder.
export const UNITS: [string, string][] = [
  ['px', 'Pixels'], ['rem', 'Root em'], ['em', 'Parent em'], ['%', 'Percent of parent font'], ['pt', 'Points'],
  ['vw', 'Viewport width'], ['vh', 'Viewport height'], ['vmin', 'Viewport min'], ['vmax', 'Viewport max'],
  ['pc', 'Picas'], ['in', 'Inches'], ['cm', 'Centimetres'], ['mm', 'Millimetres'],
];
const UNIT_IDS = ['px', 'rem', 'em', '%', 'pt', 'vw', 'vh', 'vmin', 'vmax', 'pc', 'in', 'cm', 'mm'] as const;
export type CssUnit = (typeof UNIT_IDS)[number];
export interface Ctx {
  root: number;
  parent: number;
  vw: number;
  vh: number;
}

/** How many px one unit is, in a given context. */
export function perUnit(u: string, c: Ctx) {
  switch (u) {
    case 'px': return 1;
    case 'rem': return c.root;
    case 'em': return c.parent;
    case '%': return c.parent / 100;
    case 'pt': return 96 / 72;
    case 'pc': return 16;
    case 'in': return 96;
    case 'cm': return 96 / 2.54;
    case 'mm': return 96 / 25.4;
    case 'vw': return c.vw / 100;
    case 'vh': return c.vh / 100;
    case 'vmin': return Math.min(c.vw, c.vh) / 100;
    case 'vmax': return Math.max(c.vw, c.vh) / 100;
  }
  return NaN;
}
export function convert(v: number, from: string, to: string, c: Ctx) {
  return (v * perUnit(from, c)) / perUnit(to, c);
}
export function fmt(n: number, d?: number) {
  if (!isFinite(n)) return '—';
  const p = Math.pow(10, d == null ? 4 : d);
  const s = (Math.round(n * p) / p).toString();
  return s === '-0' ? '0' : s;
}

/** Fluid clamp(): linear from (minVp, minSize) to (maxVp, maxSize). Sizes and viewports in px. */
export function fluid(minSize: number, maxSize: number, minVp: number, maxVp: number, root: number, unit: 'px' | 'rem') {
  if (!(maxVp > minVp)) return { error: '“To viewport” must be larger than “From viewport”' };
  const slope = (maxSize - minSize) / (maxVp - minVp), intercept = minSize - slope * minVp;
  const lo = Math.min(minSize, maxSize), hi = Math.max(minSize, maxSize);
  const u = unit === 'px' ? 1 : root, sfx = unit === 'px' ? 'px' : 'rem';
  let mid = fmt(slope * 100) + 'vw';
  if (Math.abs(intercept) > 1e-9) mid = fmt(intercept / u) + sfx + (slope >= 0 ? ' + ' + mid : ' - ' + fmt(-slope * 100) + 'vw');
  if (Math.abs(intercept) > 1e-9 && intercept < 0) mid = fmt(slope * 100) + 'vw - ' + fmt(-intercept / u) + sfx;
  return {
    css: 'clamp(' + fmt(lo / u) + sfx + ', ' + mid + ', ' + fmt(hi / u) + sfx + ')',
    at: (vp: number) => Math.min(hi, Math.max(lo, intercept + slope * vp)),
    slope,
    intercept,
  };
}

const ctxShape = {
  rootFontSize: z.number().positive().optional().default(16).describe('Root (html) font size in px, for rem. Default 16.'),
  parentFontSize: z.number().positive().optional().default(16).describe('Parent element font size in px, for em and %. Default 16.'),
  viewportWidth: z.number().positive().optional().default(1440).describe('Viewport width in px, for vw/vmin/vmax. Default 1440.'),
  viewportHeight: z.number().positive().optional().default(900).describe('Viewport height in px, for vh/vmin/vmax. Default 900.'),
};

const cssUnits = defineTool({
  name: 'css_units',
  title: 'CSS unit converter',
  webSlug: 'css-units',
  description:
    'Convert a CSS length between px, rem, em, %, pt, pc, in, cm, mm, vw, vh, vmin and vmax, using a root font size, ' +
    'parent font size and viewport size (defaults 16px / 16px / 1440×900). Uses the CSS definition of 96px per inch. ' +
    `Returns every unit, rounded to 4 decimals by default. Web version: ${webUrl('css-units')}`,
  inputSchema: z.object({
    value: z.number().describe('The length to convert, e.g. 24.'),
    unit: z.enum(UNIT_IDS).optional().default('px').describe('Unit of "value". Default px.'),
    ...ctxShape,
    decimals: z.number().int().min(0).max(10).optional().default(4).describe('Decimal places to round to. Default 4.'),
  }),
  outputSchema: z.object({
    px: z.number(),
    results: z.array(z.object({ unit: z.string(), name: z.string(), value: z.number(), css: z.string() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { value: 24, unit: 'px' }, note: '1.5rem, 18pt, 1.6667vw…' }],
  run(input) {
    const c: Ctx = { root: input.rootFontSize, parent: input.parentFontSize, vw: input.viewportWidth, vh: input.viewportHeight };
    const results = UNITS.map(([u, name]) => {
      const s = fmt(convert(input.value, input.unit, u, c), input.decimals);
      return { unit: u, name, value: Number(s), css: s + u };
    });
    return { px: Number(fmt(convert(input.value, input.unit, 'px', c), input.decimals)), results };
  },
});

const cssClamp = defineTool({
  name: 'css_clamp',
  title: 'Fluid CSS clamp()',
  webSlug: 'css-units',
  description:
    'Build a fluid typography/spacing value: CSS clamp() that grows linearly from a size at a small viewport to a size at a ' +
    'large viewport (sizes and viewports in px), expressed in rem or px. Also returns the computed size at sample ' +
    `viewport widths. Web version: ${webUrl('css-units')}`,
  inputSchema: z.object({
    minSize: z.number().optional().default(16).describe('Size in px at the small viewport. Default 16.'),
    maxSize: z.number().optional().default(32).describe('Size in px at the large viewport. Default 32.'),
    minViewport: z.number().optional().default(320).describe('Small viewport width in px. Default 320.'),
    maxViewport: z.number().optional().default(1280).describe('Large viewport width in px. Default 1280.'),
    unit: z.enum(['rem', 'px']).optional().default('rem').describe('Output unit. Default rem.'),
    rootFontSize: ctxShape.rootFontSize,
    sampleViewports: z.array(z.number()).optional().default([320, 768, 1280, 1920]).describe('Viewport widths (px) to compute the resulting size at.'),
  }),
  outputSchema: z.object({
    css: z.string(),
    declaration: z.string(),
    slopeVw: z.number(),
    interceptPx: z.number(),
    samples: z.array(z.object({ viewport: z.number(), sizePx: z.number() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { minSize: 16, maxSize: 32, minViewport: 320, maxViewport: 1280 }, output: { css: 'clamp(1rem, 0.6667rem + 1.6667vw, 2rem)' } }],
  run(input) {
    const f = fluid(input.minSize, input.maxSize, input.minViewport, input.maxViewport, input.rootFontSize, input.unit);
    if ('error' in f) throw new ToolError(f.error!);
    return {
      css: f.css,
      declaration: 'font-size: ' + f.css + ';',
      slopeVw: Number(fmt(f.slope * 100)),
      interceptPx: Number(fmt(f.intercept)),
      samples: input.sampleViewports.map((vp) => ({ viewport: vp, sizePx: Number(fmt(f.at(vp), 2)) })),
    };
  },
});

export default [cssUnits, cssClamp];

import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import { outputPath, returnBase64, writeOutput } from '../../util/files.js';
import { FONT_STACK, imageFormat, scaleSchema, svgSize, svgToPng } from './_svg.js';

const TYPES = ['bar', 'line', 'area', 'pie', 'scatter'] as const;
const MAX_ROWS = 50_000;
const PALETTE = ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#64748b', '#f97316'];

type Row = Record<string, unknown>;
type FieldType = 'quantitative' | 'temporal' | 'nominal' | 'ordinal';

const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Guess a Vega-Lite field type from the values in the rows. */
export function inferType(rows: Row[], field: string): FieldType {
  const vals = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined && v !== '');
  if (!vals.length) return 'nominal';
  if (vals.every((v) => typeof v === 'number' && isFinite(v))) return 'quantitative';
  if (vals.every((v) => typeof v === 'string' && ISO_DATE.test(v))) return 'temporal';
  return 'nominal';
}

export interface SimpleChart {
  type: (typeof TYPES)[number];
  data: Row[];
  x: string;
  y: string | string[];
  color?: string;
  title?: string;
  width?: number;
  height?: number;
}

/** Turn the simple chart description into a Vega-Lite spec. */
export function simpleToVegaLite(c: SimpleChart): Record<string, unknown> {
  if (!c.data.length) throw new ToolError('"data" is empty: give at least one row.');
  const fields = new Set(c.data.flatMap((r) => Object.keys(r)));
  const ys = Array.isArray(c.y) ? c.y : [c.y];
  for (const f of [c.x, ...ys, ...(c.color ? [c.color] : [])]) {
    if (!fields.has(f)) throw new ToolError(`Field "${f}" is not in the data rows (fields: ${[...fields].slice(0, 20).join(', ')}).`);
  }
  const transform: unknown[] = [];
  let yField = ys[0];
  let colorField = c.color;
  if (ys.length > 1) {
    transform.push({ fold: ys, as: ['series', 'value'] });
    yField = 'value';
    colorField = 'series';
  }
  const yType = ys.length > 1 ? 'quantitative' : inferType(c.data, yField);
  let xType = inferType(c.data, c.x);
  const pie = c.type === 'pie';
  const spec: Record<string, unknown> = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: c.data },
    width: c.width ?? (pie ? 360 : 600),
    height: c.height ?? 360,
  };
  if (c.title) spec.title = c.title;
  if (transform.length) spec.transform = transform;
  const colorEnc = colorField ? { color: { field: colorField, type: inferType(c.data, colorField) === 'quantitative' && ys.length < 2 ? 'quantitative' : 'nominal' } } : {};
  if (pie) {
    spec.mark = { type: 'arc', innerRadius: 0, stroke: '#ffffff', strokeWidth: 1 };
    spec.encoding = { theta: { field: yField, type: 'quantitative', stack: true }, color: { field: c.x, type: 'nominal', sort: null } };
    spec.view = { stroke: null };
    return spec;
  }
  if (c.type === 'bar' && xType === 'quantitative') xType = 'ordinal'; // years / ids as categories
  const x = { field: c.x, type: xType, ...(xType === 'nominal' || xType === 'ordinal' ? { sort: null, axis: { labelAngle: 0, labelOverlap: true } } : {}) };
  const y = { field: yField, type: yType, ...(ys.length > 1 ? { title: ys.join(', ') } : {}) };
  if (c.type === 'bar') {
    spec.mark = { type: 'bar' };
    if (colorField && ys.length > 1) (spec as { encoding?: unknown }).encoding = { x, y, ...colorEnc, xOffset: { field: colorField } };
    else spec.encoding = { x, y, ...colorEnc };
  } else if (c.type === 'line') {
    spec.mark = { type: 'line', point: true, strokeWidth: 2 };
    spec.encoding = { x, y, ...colorEnc };
  } else if (c.type === 'area') {
    spec.mark = { type: 'area', line: true, opacity: 0.75 };
    spec.encoding = { x, y, ...colorEnc };
  } else {
    spec.mark = { type: 'point', filled: true, size: 60, opacity: 0.8 };
    spec.encoding = { x: { field: c.x, type: xType === 'nominal' ? 'nominal' : xType, scale: { zero: false } }, y: { ...y, scale: { zero: false } }, ...colorEnc };
  }
  return spec;
}

/** Any object with a string "url" (data, images, projections…) would make Vega fetch something: refuse up front. */
function findUrl(v: unknown, path = 'spec', depth = 0): string | undefined {
  if (depth > 60 || !v || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) {
    if (v.length > 200 && v.every((x) => x === null || typeof x !== 'object')) return undefined;
    for (let i = 0; i < v.length; i++) { const r = findUrl(v[i], `${path}[${i}]`, depth + 1); if (r) return r; }
    return undefined;
  }
  for (const [k, val] of Object.entries(v)) {
    if (k === 'values') continue; // inline rows are data, not instructions
    if (k === 'url' && typeof val === 'string') return path + '.url';
    const r = findUrl(val, `${path}.${k}`, depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** Render a Vega or Vega-Lite spec to SVG text, with every network/file load refused. */
export async function renderSpec(spec: Record<string, unknown>, background: string) {
  const bad = findUrl(spec);
  if (bad) throw new ToolError(`${bad}: loading data or images from a URL or file is not allowed. Put the rows inline in data.values.`);
  const vega = await import('vega');
  const isVega = typeof spec.$schema === 'string' && /\/schema\/vega\/v/.test(spec.$schema);
  let vg: Record<string, unknown>;
  const config = { font: FONT_STACK, background, padding: 12, mark: { color: PALETTE[0] }, range: { category: PALETTE }, view: { stroke: null }, axis: { labelFontSize: 11, titleFontSize: 12, gridColor: '#e5e7eb', domainColor: '#9ca3af', tickColor: '#9ca3af' }, title: { fontSize: 15, anchor: 'start', offset: 10 }, legend: { labelFontSize: 11, titleFontSize: 12 } };
  try {
    if (isVega) vg = { background, ...spec };
    else {
      const { compile } = await import('vega-lite');
      const userConfig = (spec.config ?? {}) as Record<string, unknown>;
      vg = compile({ ...spec, config: { ...config, ...userConfig } } as never).spec as unknown as Record<string, unknown>;
    }
  } catch (e) {
    throw new ToolError(`Invalid ${isVega ? 'Vega' : 'Vega-Lite'} spec: ${e instanceof Error ? e.message : String(e)}`);
  }
  const loader = vega.loader();
  const refuse = async () => { throw new Error('network and file loading are disabled'); };
  loader.load = refuse; loader.sanitize = refuse; loader.http = refuse; loader.file = refuse;
  const errors: string[] = [];
  const log = (...a: unknown[]) => { errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); };
  let lvl = 0;
  const logger = {
    level(l?: number) { if (l === undefined) return lvl; lvl = l; return logger; },
    error(...a: unknown[]) { log(...a); return logger; },
    warn() { return logger; }, info() { return logger; }, debug() { return logger; },
  };
  let svg: string;
  try {
    const view = new vega.View(vega.parse(vg as never), { renderer: 'none', loader, logger: logger as never });
    svg = await view.toSVG();
    view.finalize();
  } catch (e) {
    throw new ToolError(`Couldn't render the chart: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (errors.length) throw new ToolError(`Couldn't render the chart: ${errors[0]}`);
  return svg;
}

export default defineTool({
  name: 'ai_chart',
  title: 'Chart to SVG/PNG',
  description:
    'Render a chart to an SVG or PNG file, offline. Either give a simple description ({ type: bar|line|area|pie|scatter, data: rows, x, y, color?, title? }; ' +
    'y may be a list of fields for multi-series line/bar charts), or a full Vega-Lite (or Vega) spec in "spec" with the rows inline in data.values. ' +
    'Field types are inferred (numbers = quantitative, ISO dates = temporal, other = categories). Loading data or images from URLs or files is refused. ' +
    `Up to ${MAX_ROWS.toLocaleString('en')} rows. PNG is rasterised from the SVG at "scale" (default 2×).`,
  inputSchema: z.object({
    spec: z.record(z.string(), z.unknown()).optional().describe('A full Vega-Lite spec (or Vega, if its $schema says so). Data must be inline (data.values). Use this or "type".'),
    type: z.enum(TYPES).optional().describe('Simple chart type. Use with data, x and y.'),
    data: z.array(z.record(z.string(), z.unknown())).max(MAX_ROWS).optional().describe('Rows for the simple chart, e.g. [{"month":"Jan","sales":12}].'),
    x: z.string().optional().describe('Field for the x axis (the category / slice label for pie).'),
    y: z.union([z.string(), z.array(z.string()).min(1).max(12)]).optional().describe('Numeric field for the y axis (slice size for pie). A list of fields draws one series per field.'),
    color: z.string().optional().describe('Optional field that splits the data into coloured series.'),
    title: z.string().max(200).optional(),
    width: z.number().int().min(50).max(4000).optional().describe('Plot width in px (default 600; pie 360).'),
    height: z.number().int().min(50).max(4000).optional().describe('Plot height in px (default 360).'),
    format: imageFormat(),
    scale: scaleSchema(),
    background: z.string().optional().default('#ffffff').describe('Background colour. Default white; "transparent" for none.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    path: z.string(), bytes: z.number(), mimeType: z.string().optional(), base64: z.string().optional(),
    format: z.string(), width: z.number().describe('Image width in px.'), height: z.number().describe('Image height in px.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { type: 'bar', data: [{ month: 'Jan', sales: 12 }, { month: 'Feb', sales: 19 }, { month: 'Mar', sales: 7 }], x: 'month', y: 'sales', title: 'Sales' }, output: { format: 'svg' } },
    { input: { type: 'pie', data: [{ k: 'A', v: 3 }, { k: 'B', v: 1 }], x: 'k', y: 'v', format: 'png' }, output: { format: 'png', mimeType: 'image/png' } },
  ],
  async run(input, ctx) {
    let spec: Record<string, unknown>;
    if (input.spec) {
      if (input.type) throw new ToolError('Give either "spec" or "type", not both.');
      if (JSON.stringify(input.spec).length > 20e6) throw new ToolError('The spec is larger than 20 MB.');
      spec = input.spec;
    } else {
      if (!input.type || !input.data || !input.x || !input.y) throw new ToolError('Give a Vega-Lite "spec", or "type", "data", "x" and "y".');
      spec = simpleToVegaLite({ type: input.type, data: input.data, x: input.x, y: input.y, color: input.color, title: input.title, width: input.width, height: input.height });
    }
    const bg = input.background === 'transparent' ? 'transparent' : input.background;
    const svg = await renderSpec(spec, bg);
    const name = input.title || (typeof spec.title === 'string' && spec.title) || 'chart';
    if (input.format === 'png') {
      const r = await svgToPng(svg, input.scale);
      const out = await writeOutput(r.png, { output: input.output, defaultName: `${name}.png`, mimeType: 'image/png', base64: input.returnBase64 }, ctx);
      return { ...out, format: 'png', width: r.width, height: r.height };
    }
    const size = svgSize(svg);
    const out = await writeOutput(svg, { output: input.output, defaultName: `${name}.svg`, mimeType: 'image/svg+xml', base64: input.returnBase64 }, ctx);
    return { ...out, format: 'svg', width: size.width, height: size.height };
  },
});

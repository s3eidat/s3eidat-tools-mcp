import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';

// Ported from https://github.com/s3eidat/stats-calc (app.js): same parser, quartile methods, bins and formatting.
export type Commas = 'sep' | 'thou' | 'dec';
export type Method = 'inc' | 'exc' | 'tukey';

function normDigits(s: string) {
  return s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/\u066b/g, '.').replace(/\u066c/g, ',').replace(/[−–]/g, '-');
}
export function parse(text: string, commas: Commas) {
  let s = normDigits(String(text || ''));
  if (commas === 'thou') s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  else if (commas === 'dec') s = s.replace(/(\d),(\d)/g, '$1.$2');
  const toks = s.split(commas === 'sep' ? /[\s,;|]+/ : /[\s;|]+/).filter(Boolean), vals: number[] = [], skipped: string[] = [];
  toks.forEach((t) => {
    const c = t.replace(/^["'(]+|["')]+$/g, '');
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i.test(c)) { const v = parseFloat(c); if (isFinite(v)) vals.push(v); else skipped.push(t); }
    else skipped.push(t);
  });
  return { vals, skipped };
}

const sorted = (a: number[]) => a.slice().sort((x, y) => x - y);
/** Kahan summation. */
export function sum(a: number[]) { let s = 0, c = 0; a.forEach((v) => { const y = v - c, t = s + y; c = t - s - y; s = t; }); return s; }
function medianOf(s: number[]) { const n = s.length; if (!n) return NaN; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
export function quantile(s: number[], p: number, method: Method) {
  const n = s.length;
  if (!n) return NaN;
  if (method === 'tukey') { // median of the lower / upper half, excluding the median when n is odd
    const half = Math.floor(n / 2), lo = s.slice(0, half), hi = s.slice(n - half);
    if (n === 1) return s[0];
    return p === 0.25 ? medianOf(lo) : p === 0.75 ? medianOf(hi) : medianOf(s);
  }
  const h = method === 'exc' ? (n + 1) * p - 1 : (n - 1) * p;
  if (h <= 0) return s[0];
  if (h >= n - 1) return s[n - 1];
  const f = Math.floor(h);
  return s[f] + (h - f) * (s[f + 1] - s[f]);
}
export function analyze(vals: number[], method: Method) {
  const n = vals.length;
  if (!n) return null;
  const s = sorted(vals), total = sum(vals), mean = total / n;
  const ss = sum(vals.map((v) => (v - mean) * (v - mean)));
  const counts = new Map<number, number>(); vals.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  let maxc = 0; counts.forEach((c) => { if (c > maxc) maxc = c; });
  const modes = maxc > 1 ? Array.from(counts).filter((e) => e[1] === maxc).map((e) => e[0]).sort((a, b) => a - b) : [];
  const q1 = quantile(s, 0.25, method), q3 = quantile(s, 0.75, method), iqr = q3 - q1;
  const lf = q1 - 1.5 * iqr, uf = q3 + 1.5 * iqr;
  const sv = n > 1 ? ss / (n - 1) : NaN, pv = ss / n, sd = Math.sqrt(sv);
  const inside = s.filter((v) => v >= lf && v <= uf);
  return {
    n, sum: total, mean, median: medianOf(s), modes, modeCount: maxc, min: s[0], max: s[n - 1], range: s[n - 1] - s[0],
    sampleVar: sv, popVar: pv, sampleSD: sd, popSD: Math.sqrt(pv), se: n > 1 ? sd / Math.sqrt(n) : NaN, cv: mean !== 0 && n > 1 ? (sd / Math.abs(mean)) * 100 : NaN,
    q1, q3, iqr, lowerFence: lf, upperFence: uf,
    outliers: s.filter((v) => v < lf || v > uf), whiskerLo: inside.length ? inside[0] : s[0], whiskerHi: inside.length ? inside[inside.length - 1] : s[n - 1],
    sorted: s, counts,
  };
}
export type Analysis = NonNullable<ReturnType<typeof analyze>>;
export const zscores = (vals: number[], a: Analysis) => vals.map((v) => (a.sampleSD > 0 ? (v - a.mean) / a.sampleSD : NaN));

/** Bins: whole-number friendly widths, Sturges' count as the target. */
function niceNum(x: number) { const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
export function bins(a: Analysis) {
  if (a.range === 0) return [{ lo: a.min, hi: a.min, c: a.n }];
  const k = Math.ceil(Math.log2(a.n)) + 1, w = niceNum(a.range / k), start = Math.floor(a.min / w) * w, out: { lo: number; hi: number; c: number }[] = [];
  for (let lo = start; lo <= a.max + w * 1e-9; lo += w) out.push({ lo: +lo.toPrecision(12), hi: +(lo + w).toPrecision(12), c: 0 });
  a.sorted.forEach((v) => { const i = Math.min(out.length - 1, Math.floor((v - start) / w + 1e-9)); out[i].c++; });
  while (out.length > 1 && out[out.length - 1].c === 0) out.pop();
  return out;
}
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
export function fmt(v: number | undefined | null) {
  if (v === undefined || v === null || (typeof v === 'number' && isNaN(v))) return '—';
  if (!isFinite(v)) return v > 0 ? '∞' : '−∞';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e12 || a < 1e-6)) return v.toExponential(4);
  return nf.format(+v.toPrecision(10));
}
export function freqRows(a: Analysis) {
  if (a.counts.size <= 20) {
    let cum = 0;
    return Array.from(a.counts).sort((x, y) => x[0] - y[0]).map((e) => { cum += e[1]; return { label: fmt(e[0]), c: e[1], cum }; });
  }
  let c2 = 0;
  return bins(a).map((b, i, arr) => { c2 += b.c; return { label: fmt(b.lo) + ' – ' + (i === arr.length - 1 ? fmt(b.hi) : '< ' + fmt(b.hi)), c: b.c, cum: c2 }; });
}
const METHOD: Record<Method, string> = { inc: 'inclusive (Excel QUARTILE.INC, R type 7)', exc: 'exclusive (Excel QUARTILE.EXC, R type 6)', tukey: 'median of halves (TI)' };
/** Full precision with float noise removed (12 significant digits); NaN → null. */
const P = (v: number) => (isFinite(v) ? +v.toPrecision(12) : null);

export default defineTool({
  name: 'calc_stats',
  title: 'Descriptive statistics',
  webSlug: 'stats-calc',
  description:
    'Descriptive statistics for a list of numbers: count, sum, mean, median, mode(s), min, max, range, sample and population ' +
    'variance and SD, standard error, coefficient of variation, quartiles (inclusive = Excel QUARTILE.INC, exclusive = ' +
    'QUARTILE.EXC, or Tukey median-of-halves), IQR, 1.5×IQR outlier fences and outliers, a frequency table (values, or ' +
    'Sturges bins when there are more than 20 distinct values) and z-scores. Paste numbers separated by spaces, commas, ' +
    'semicolons, | or new lines; headers and text are skipped and reported. Commas can be separators, thousands marks or ' +
    `decimal commas. Up to 1,000,000 numbers. Web version: ${webUrl('stats-calc')}`,
  inputSchema: z.object({
    data: z.union([z.string(), z.array(z.number())]).describe('The numbers: a text blob (CSV column, list…) or an array of numbers.'),
    commas: z.enum(['sep', 'thou', 'dec']).optional().default('sep').describe('In text: commas separate values (sep), are thousands marks (thou: 1,234), or decimal commas (dec: 1,5).'),
    quartileMethod: z.enum(['inc', 'exc', 'tukey']).optional().default('inc').describe('Quartile method.'),
    frequency: z.boolean().optional().default(true).describe('Include the frequency table.'),
    zScores: z.boolean().optional().default(false).describe('Include a z-score for each value (first 1,000).'),
  }),
  outputSchema: z.object({
    count: z.number(), sum: z.number().nullable(), mean: z.number().nullable(), median: z.number().nullable(),
    modes: z.array(z.number()), modeCount: z.number(), min: z.number().nullable(), max: z.number().nullable(), range: z.number().nullable(),
    sampleVariance: z.number().nullable(), sampleSD: z.number().nullable(), populationVariance: z.number().nullable(), populationSD: z.number().nullable(),
    standardError: z.number().nullable(), coefficientOfVariation: z.number().nullable(),
    q1: z.number().nullable(), q3: z.number().nullable(), iqr: z.number().nullable(), quartileMethod: z.string(),
    lowerFence: z.number().nullable(), upperFence: z.number().nullable(), outliers: z.array(z.number()),
    whiskerLow: z.number().nullable(), whiskerHigh: z.number().nullable(),
    skipped: z.array(z.string()), skippedCount: z.number(),
    frequency: z.array(z.object({ value: z.string(), count: z.number(), relative: z.number(), cumulative: z.number() })).optional(),
    zScores: z.array(z.object({ index: z.number(), value: z.number(), z: z.number().nullable(), outlier: z.boolean() })).optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { data: '2, 4, 4, 4, 5, 5, 7, 9' }, note: 'mean 5, median 4.5, mode 4, population SD 2, sample SD 2.138' }],
  run(input) {
    let vals: number[], skipped: string[] = [];
    if (Array.isArray(input.data)) vals = input.data.filter((v) => isFinite(v));
    else ({ vals, skipped } = parse(input.data, input.commas));
    if (vals.length > 1_000_000) throw new ToolError('At most 1,000,000 numbers.');
    const a = analyze(vals, input.quartileMethod);
    if (!a) throw new ToolError('No numbers found. Separate numbers with commas, spaces or new lines.');
    const m = input.quartileMethod;
    const rows: [string, string][] = [
      ['Count (n)', fmt(a.n)], ['Sum', fmt(a.sum)], ['Mean', fmt(a.mean)], ['Median', fmt(a.median)],
      ['Mode', a.modes.length ? a.modes.slice(0, 8).map(fmt).join(', ') + (a.modes.length > 8 ? ' …' : '') + ' (×' + a.modeCount + ')' : 'none (all values unique)'],
      ['Minimum', fmt(a.min)], ['Maximum', fmt(a.max)], ['Range', fmt(a.range)],
      ['Sample variance (s²)', fmt(a.sampleVar)], ['Sample SD (s)', fmt(a.sampleSD)],
      ['Population variance (σ²)', fmt(a.popVar)], ['Population SD (σ)', fmt(a.popSD)],
      ['Standard error of the mean', fmt(a.se)], ['Coefficient of variation', isFinite(a.cv) ? fmt(a.cv) + '%' : '—'],
      ['Q1', fmt(a.q1)], ['Q3', fmt(a.q3)], ['IQR', fmt(a.iqr)], ['Quartile method', METHOD[m]],
      ['Outlier fences (1.5 × IQR)', fmt(a.lowerFence) + ' and ' + fmt(a.upperFence)],
      ['Outliers', a.outliers.length ? a.outliers.slice(0, 12).map(fmt).join(', ') + (a.outliers.length > 12 ? ' … (' + a.outliers.length + ')' : '') : 'none'],
    ];
    const out: Record<string, unknown> = {
      count: a.n, sum: P(a.sum), mean: P(a.mean), median: P(a.median), modes: a.modes, modeCount: a.modeCount, min: P(a.min), max: P(a.max), range: P(a.range),
      sampleVariance: P(a.sampleVar), sampleSD: P(a.sampleSD), populationVariance: P(a.popVar), populationSD: P(a.popSD), standardError: P(a.se), coefficientOfVariation: P(a.cv),
      q1: P(a.q1), q3: P(a.q3), iqr: P(a.iqr), quartileMethod: METHOD[m], lowerFence: P(a.lowerFence), upperFence: P(a.upperFence),
      outliers: a.outliers.slice(0, 1000), whiskerLow: P(a.whiskerLo), whiskerHigh: P(a.whiskerHi),
      skipped: skipped.slice(0, 20), skippedCount: skipped.length,
    };
    if (input.frequency) out.frequency = freqRows(a).map((r) => ({ value: r.label, count: r.c, relative: +(r.c / a.n).toFixed(6), cumulative: r.cum }));
    if (input.zScores) {
      const zs = zscores(vals, a);
      out.zScores = vals.slice(0, 1000).map((v, i) => ({ index: i + 1, value: v, z: isFinite(zs[i]) ? +zs[i].toFixed(6) : null, outlier: v < a.lowerFence || v > a.upperFence }));
    }
    out.summary = rows.map((r) => r[0] + ': ' + r[1]).join('\n');
    return out;
  },
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, clean, need, optNumLike } from './_common.js';

// Ported from https://github.com/s3eidat/percentage-calc (app.js): the same six calculators.

/** 12 significant digits hides float noise (0.1 + 0.2 → 0.3); up to `dec` decimals (default 6). */
export function fmt(v: number, dec?: number) {
  if (!isFinite(v)) return '—';
  v = Number(v.toPrecision(12));
  if (Object.is(v, -0)) v = 0;
  return Math.abs(v) >= 1e15 || (v !== 0 && Math.abs(v) < 1e-10) ? v.toExponential(6) : v.toLocaleString('en-US', { maximumFractionDigits: dec == null ? 6 : dec });
}

export const M = {
  of: (x: number, y: number) => (x / 100) * y,
  what: (x: number, y: number) => (y === 0 ? NaN : (x / y) * 100),
  change: (a: number, b: number) => (a === 0 ? NaN : ((b - a) / Math.abs(a)) * 100),
  inc: (y: number, x: number, d: '+' | '-') => y * (1 + (d === '-' ? -x : x) / 100),
  rev: (y: number, x: number, d: '+' | '-') => { const f = 1 + (d === '-' ? -x : x) / 100; return f === 0 ? NaN : y / f; },
  mm: (cost: number, price: number) => {
    const p = price - cost;
    return { profit: p, margin: price === 0 ? NaN : (p / price) * 100, markup: cost === 0 ? NaN : (p / cost) * 100 };
  },
};

const MODES = ['percent_of', 'what_percent', 'change', 'increase', 'decrease', 'reverse_increase', 'reverse_decrease', 'margin_markup'] as const;

export default defineTool({
  name: 'calc_percentage',
  title: 'Percentage calculator',
  webSlug: 'percentage-calc',
  description:
    'Every percentage question the website answers: "X% of Y" (percent_of: percent, value), "X is what % of Y" (what_percent: ' +
    'part, whole), percent change from A to B (change: from, to), increase/decrease a value by X% (increase/decrease: value, ' +
    'percent), find the original before a X% increase/decrease (reverse_increase/reverse_decrease: value, percent), and profit ' +
    'margin vs markup (margin_markup: cost, price). Returns the number, a display string and the worked formula. ' +
    `Web version: ${webUrl('percentage-calc')}`,
  inputSchema: z.object({
    mode: z.enum(MODES).describe('Which question to answer (see the description for the fields each one uses).'),
    percent: optNumLike('The percentage X (percent_of, increase, decrease, reverse_*).'),
    value: optNumLike('The value Y (percent_of: Y in "X% of Y"; increase/decrease: the starting value; reverse_*: the final value).'),
    part: optNumLike('what_percent: the part X in "X is what % of Y".'),
    whole: optNumLike('what_percent: the whole Y.'),
    from: optNumLike('change: the old value.'),
    to: optNumLike('change: the new value.'),
    cost: optNumLike('margin_markup: cost price.'),
    price: optNumLike('margin_markup: selling price.'),
  }),
  outputSchema: z.object({
    mode: z.string(), result: z.number().nullable(), formatted: z.string(), explanation: z.string(),
    direction: z.enum(['increase', 'decrease', 'no change']).optional(), difference: z.number().optional(),
    profit: z.number().optional(), margin: z.number().nullable().optional(), markup: z.number().nullable().optional(),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { mode: 'percent_of', percent: 15, value: 200 }, output: { result: 30 } },
    { input: { mode: 'reverse_increase', value: 115, percent: 15 }, note: 'original 100' },
  ],
  run(input) {
    const g = (k: keyof typeof input) => need(input[k] as number | string | undefined, k);
    switch (input.mode) {
      case 'percent_of': {
        const x = g('percent'), y = g('value'), r = M.of(x, y);
        return { mode: input.mode, result: clean(r), formatted: fmt(r), explanation: fmt(x) + ' ÷ 100 × ' + fmt(y) + ' = ' + fmt(r) };
      }
      case 'what_percent': {
        const x = g('part'), y = g('whole'), r = M.what(x, y);
        return { mode: input.mode, result: clean(r), formatted: isFinite(r) ? fmt(r) + '%' : '—',
          explanation: isFinite(r) ? fmt(x) + ' ÷ ' + fmt(y) + ' × 100 = ' + fmt(r) + '%' : "Can't divide by 0." };
      }
      case 'change': {
        const x = g('from'), y = g('to'), r = M.change(x, y);
        if (!isFinite(r)) return { mode: input.mode, result: null, formatted: '—', explanation: 'Change from 0 is undefined.', difference: clean(y - x)! };
        return { mode: input.mode, result: clean(r), formatted: (r > 0 ? '+' : '') + fmt(r) + '%',
          explanation: '(' + fmt(y) + ' − ' + fmt(x) + ') ÷ |' + fmt(x) + '| × 100 · difference ' + fmt(y - x),
          direction: r > 0 ? 'increase' : r < 0 ? 'decrease' : 'no change', difference: clean(y - x)! };
      }
      case 'increase':
      case 'decrease': {
        const d = input.mode === 'decrease' ? '-' : '+', y = g('value'), x = g('percent'), r = M.inc(y, x, d), s = d === '-' ? '−' : '+';
        return { mode: input.mode, result: clean(r), formatted: fmt(r), explanation: fmt(y) + ' × (1 ' + s + ' ' + fmt(x) + '/100) = ' + fmt(r) + ' · ' + s + fmt(Math.abs(r - y)),
          difference: clean(r - y)! };
      }
      case 'reverse_increase':
      case 'reverse_decrease': {
        const d = input.mode === 'reverse_decrease' ? '-' : '+', y = g('value'), x = g('percent'), r = M.rev(y, x, d), s = d === '-' ? '−' : '+';
        return { mode: input.mode, result: clean(r), formatted: fmt(r),
          explanation: isFinite(r) ? 'original = ' + fmt(y) + ' ÷ (1 ' + s + ' ' + fmt(x) + '/100) = ' + fmt(r) + ' · the ' + fmt(x) + '% part is ' + fmt(Math.abs(y - r))
            : 'A 100% decrease leaves nothing to reverse.' };
      }
      case 'margin_markup': {
        const c = g('cost'), p = g('price'), m = M.mm(c, p);
        return { mode: input.mode, result: clean(m.margin), formatted: isFinite(m.margin) ? fmt(m.margin, 2) + '%' : '—',
          explanation: 'Profit ' + fmt(m.profit) + ' · margin ' + (isFinite(m.margin) ? fmt(m.margin, 2) + '%' : '—') + ' · markup ' +
            (isFinite(m.markup) ? fmt(m.markup, 2) + '%' : '—') + '. Margin = profit ÷ price. Markup = profit ÷ cost.',
          profit: clean(m.profit)!, margin: clean(m.margin), markup: clean(m.markup) };
      }
      default:
        throw new ToolError('Unknown mode.');
    }
  },
});

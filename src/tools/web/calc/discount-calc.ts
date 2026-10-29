import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, money, need, optNumLike } from './_common.js';

// Ported from https://github.com/s3eidat/discount-calc (app.js): money in integer cents, each step rounds like a till.
type DType = 'percent' | 'amount';

/** Apply one discount (percent or fixed amount) to `c` cents; never below 0. */
export function applyDiscount(c: number, value: number, type: DType) {
  const off = type === 'amount' ? Math.round(value * 100) : Math.round((c * value) / 100);
  return Math.max(0, c - Math.max(0, off));
}
export function sale(price: number, d1: number, t1: DType, d2: number, t2: DType, taxPct: number) {
  const p = Math.round(price * 100), a = applyDiscount(p, d1, t1), b = applyDiscount(a, d2, t2), tax = Math.round((b * taxPct) / 100);
  return { price: p, off1: p - a, off2: a - b, net: b, tax, final: b + tax, saved: p - b, effPct: p ? ((p - b) / p) * 100 : 0 };
}
export const reversePct = (was: number, now: number) => (was > 0 ? ((was - now) / was) * 100 : NaN);
export const unitPrice = (price: number, qty: number) => (qty > 0 ? price / qty : NaN);

const pct = (v: number) => Number(v.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
const up = (v: number) => Number(v.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 4 });
const c = (x: number) => x / 100;
const r2 = (v: number) => Number(v.toFixed(2));

export default defineTool({
  name: 'calc_discount',
  title: 'Discount / sale price calculator',
  webSlug: 'discount-calc',
  description:
    'Three shop maths jobs. sale: price after one or two stacked discounts (each a percent or a fixed amount) plus optional ' +
    'tax/VAT, with what you save and the effective total discount (stacked percents multiply). reverse: the discount % between ' +
    'an old and a new price. compare: which of two deals is cheaper per unit (price and amount of each). Money is rounded to ' +
    `the cent at each step like a till. Web version: ${webUrl('discount-calc')}`,
  inputSchema: z.object({
    mode: z.enum(['sale', 'reverse', 'compare']).optional().default('sale').describe('Which calculator.'),
    price: optNumLike('sale: original price.'),
    discount: optNumLike('sale: first discount (percent by default).'),
    discountType: z.enum(['percent', 'amount']).optional().default('percent').describe('sale: first discount is a percent or a fixed amount.'),
    extraDiscount: optNumLike('sale: optional second discount applied after the first.'),
    extraDiscountType: z.enum(['percent', 'amount']).optional().default('percent').describe('sale: second discount type.'),
    taxPercent: optNumLike('sale: optional tax / VAT percent added after the discounts.'),
    was: optNumLike('reverse: the old price.'),
    now: optNumLike('reverse: the new price.'),
    unit: z.string().optional().describe('compare: the unit name (kg, L, item…). Default "unit".'),
    priceA: optNumLike('compare: price of deal A.'),
    amountA: optNumLike('compare: amount of deal A (e.g. 0.5 for 500 g when unit is kg).'),
    priceB: optNumLike('compare: price of deal B.'),
    amountB: optNumLike('compare: amount of deal B.'),
  }),
  outputSchema: z.object({
    mode: z.string(),
    sale: z.object({
      originalPrice: z.number(), discount1: z.number(), discount2: z.number(), priceAfterDiscounts: z.number(), tax: z.number(),
      youPay: z.number(), youSave: z.number(), effectiveDiscountPercent: z.number(), wasWithTax: z.number(), summary: z.string(),
    }).optional(),
    reverse: z.object({ discountPercent: z.number(), difference: z.number(), isIncrease: z.boolean(), text: z.string() }).optional(),
    compare: z.object({ unitPriceA: z.number(), unitPriceB: z.number(), cheaper: z.enum(['A', 'B', 'same']), percentCheaper: z.number(), text: z.string() }).optional(),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { price: 100, discount: 20, extraDiscount: 10, taxPercent: 16 }, note: 'youPay 83.52 (28% off in total)' },
    { input: { mode: 'compare', unit: 'kg', priceA: 4.5, amountA: 0.5, priceB: 7.2, amountB: 1 }, note: 'B is 20% cheaper per kg' },
  ],
  run(input) {
    if (input.mode === 'sale') {
      const price = need(input.price, 'price'), d1 = need(input.discount, 'discount', 0), d2 = need(input.extraDiscount, 'extraDiscount', 0);
      const tax = need(input.taxPercent, 'taxPercent', 0), t1 = input.discountType, t2 = input.extraDiscountType;
      if (!(price > 0)) throw new ToolError('Enter a price above 0.');
      if (!(d1 >= 0) || !(d2 >= 0) || !(tax >= 0)) throw new ToolError('Discounts and tax must be 0 or more.');
      if ((t1 === 'percent' && d1 > 100) || (t2 === 'percent' && d2 > 100)) throw new ToolError("A percent discount can't be more than 100%.");
      const r = sale(price, d1, t1, d2, t2, tax);
      const lab1 = t1 === 'percent' ? 'Discount ' + pct(d1) : 'Discount', lab2 = t2 === 'percent' ? 'Extra ' + pct(d2) : 'Extra discount';
      const summary = 'Original ' + money(c(r.price)) + (r.off1 ? ', ' + lab1 + ' −' + money(c(r.off1)) : '') + (r.off2 ? ', ' + lab2 + ' −' + money(c(r.off2)) : '') +
        (r.tax ? ', tax +' + money(c(r.tax)) : '') + '\nYou pay ' + money(c(r.final)) + ' (save ' + money(c(r.saved)) + ', ' + pct(r.effPct) + ')';
      return { mode: 'sale', sale: {
        originalPrice: c(r.price), discount1: c(r.off1), discount2: c(r.off2), priceAfterDiscounts: c(r.net), tax: c(r.tax), youPay: c(r.final),
        youSave: c(r.saved), effectiveDiscountPercent: r2(r.effPct), wasWithTax: c(r.price + Math.round((r.price * tax) / 100)), summary,
      } };
    }
    if (input.mode === 'reverse') {
      const was = need(input.was, 'was'), now = need(input.now, 'now');
      if (!(was > 0) || !(now >= 0)) throw new ToolError('Enter both prices (old price above 0).');
      const p = reversePct(was, now);
      return { mode: 'reverse', reverse: {
        discountPercent: r2(p), difference: Math.round((was - now) * 100) / 100, isIncrease: p < 0,
        text: p >= 0 ? pct(p) + ' off · you save ' + money(Math.round((was - now) * 100) / 100) : '+' + pct(-p) + " · that's a price increase of " + money(Math.round((now - was) * 100) / 100),
      } };
    }
    const u = input.unit?.trim() || 'unit';
    const ap = need(input.priceA, 'priceA'), aq = need(input.amountA, 'amountA'), bp = need(input.priceB, 'priceB'), bq = need(input.amountB, 'amountB');
    const ua = unitPrice(ap, aq), ub = unitPrice(bp, bq);
    if (!(ap >= 0) || !(bp >= 0) || !isFinite(ua) || !isFinite(ub)) throw new ToolError('Enter a price and an amount above 0 for both deals (e.g. 4.50 for 500 g).');
    if (Math.abs(ua - ub) < 1e-12) return { mode: 'compare', compare: { unitPriceA: Number(ua.toPrecision(6)), unitPriceB: Number(ub.toPrecision(6)), cheaper: 'same' as const, percentCheaper: 0, text: 'Same price per ' + u + ': ' + up(ua) + '.' } };
    const win = ua < ub ? 'A' : 'B', lo = Math.min(ua, ub), hi = Math.max(ua, ub);
    return { mode: 'compare', compare: {
      unitPriceA: Number(ua.toPrecision(6)), unitPriceB: Number(ub.toPrecision(6)), cheaper: win as 'A' | 'B', percentCheaper: r2(((hi - lo) / hi) * 100),
      text: 'Deal ' + win + ' is ' + pct(((hi - lo) / hi) * 100) + ' cheaper per ' + u + ' (A: ' + up(ua) + ', B: ' + up(ub) + ' per ' + u + ')',
    } };
  },
});

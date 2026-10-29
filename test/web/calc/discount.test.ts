import { describe, expect, it } from 'vitest';
import tool, { reversePct, sale, unitPrice } from '../../../src/tools/web/calc/discount-calc.js';
import { num } from '../../../src/tools/web/calc/_common.js';
import { fails, run } from './_run.js';

describe('calc_discount (discount-calc self-test)', () => {
  it('matches the website known answers', () => {
    const a = sale(100, 20, 'percent', 10, 'percent', 0), b = sale(100, 20, 'percent', 10, 'percent', 16), c = sale(80, 15, 'amount', 0, 'percent', 0);
    const d = sale(10, 25, 'amount', 0, 'percent', 0), e = sale(19.99, 15, 'percent', 0, 'percent', 0);
    expect(a.final).toBe(7200);
    expect(Number(a.effPct.toFixed(6))).toBe(28);
    expect([b.final, b.tax, c.final, d.final, e.final, e.off1]).toEqual([8352, 1152, 6500, 0, 1699, 300]);
    expect(reversePct(80, 60)).toBe(25);
    expect(reversePct(50, 60)).toBe(-20);
    expect(reversePct(0, 5)).toBeNaN();
    expect(unitPrice(4.5, 0.5)).toBe(9);
    expect(unitPrice(7.2, 1)).toBe(7.2);
    expect(unitPrice(5, 0)).toBeNaN();
    expect(num('1,299.50')).toBe(1299.5);
  });
  it('runs as a tool', async () => {
    const s = await run(tool, { price: 100, discount: 20, extraDiscount: 10, taxPercent: 16 });
    expect(s.sale).toMatchObject({ youPay: 83.52, tax: 11.52, youSave: 28, effectiveDiscountPercent: 28, wasWithTax: 116 });
    const r = await run(tool, { mode: 'reverse', was: 50, now: 60 });
    expect(r.reverse).toMatchObject({ discountPercent: -20, isIncrease: true });
    const c = await run(tool, { mode: 'compare', unit: 'kg', priceA: '4.50', amountA: 0.5, priceB: 7.2, amountB: 1 });
    expect(c.compare).toMatchObject({ cheaper: 'B', unitPriceA: 9, unitPriceB: 7.2, percentCheaper: 20 });
    expect(c.compare.text).toBe('Deal B is 20% cheaper per kg (A: 9, B: 7.2 per kg)');
    await fails(tool, { price: 10, discount: 120 }, /more than 100%/);
  });
});

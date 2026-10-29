import { describe, expect, it } from 'vitest';
import tool, { customCur, fmt, listFor, parseMoney, parseQty, sum } from '../../../src/tools/web/calc/cash-counter.js';
import { CURRENCIES } from '../../../src/tools/web/calc/_currencies.js';
import { fails, run } from './_run.js';

const MINUS = '−';

describe('calc_cash_count (cash-counter self-test)', () => {
  it('matches the website known answers', () => {
    const jod = listFor(CURRENCIES.JOD), s = sum(jod, { n50000: 3, c500: 2, c50: 7 });
    expect(s.total).toBe(151350);
    expect(fmt(s.total, 3)).toBe('151.350');
    expect(s.notes + '/' + s.coins).toBe('3/9');
    expect(fmt(sum(listFor(CURRENCIES.USD), { c10: 3, c1: 7 }).total, 2)).toBe('0.37');
    expect(fmt(sum(listFor(CURRENCIES.JOD), { c100: 3 }).total, 3)).toBe('0.300');
    expect(fmt(sum(listFor(CURRENCIES.EUR), { c1: 9999999, c2: 9999999, n50000: 1000 }).total, 2)).toBe('799,999.97');
    expect(parseMoney('151.35', 3)).toBe(151350);
    expect(parseMoney('\u0661\u0665\u0661\u066b\u0663\u0665', 3)).toBe(151350);
    expect(parseMoney('1,234.5', 3)).toBe(1234500);
    expect(parseMoney('1.2345', 3)).toBeNull();
    expect(parseMoney('abc', 2)).toBeNull();
    expect(parseMoney('.5', 2)).toBe(50);
    expect(parseMoney('-2', 2)).toBe(-200);
    expect(fmt(-50, 3)).toBe(MINUS + '0.050');
    expect(fmt(123456789, 0)).toBe('123,456,789');
    expect(parseQty('\u0667')).toBe(7);
    expect(parseQty('2.5')).toBeNull();
    expect(fmt(s.total - parseMoney('151.400', 3)!, 3)).toBe(MINUS + '0.050');
    for (const [k, c] of Object.entries(CURRENCIES)) for (const g of [c.n, c.c]) for (let i = 1; i < g.length; i++) expect(g[i][0] < g[i - 1][0], k).toBe(true);
    const cc = customCur({ name: 'X', dec: 2, notes: '20, 100, 20, abc', coins: '0.5, 0.25' });
    expect(cc.n.map((d) => d[0])).toEqual([10000, 2000]);
    expect(cc.c.map((d) => d[0])).toEqual([50, 25]);
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { currency: 'JOD', counts: [{ denomination: 50, count: 3 }, { denomination: '½ dinar', count: 2 }, { denomination: '0.05', count: '7' }], expected: '151.400', note: 'drawer 2' });
    expect([r.total, r.notes, r.coins]).toEqual(['151.350', 3, 9]);
    expect(r.expected).toEqual({ amount: '151.400', status: 'short', difference: '0.050' });
    expect(r.summary).toContain('50 JD × 3 = 150.000');
    expect(r.denominations[0].labelArabic).toBeTruthy();
    const sar = await run(tool, { currency: 'SAR', counts: [{ denomination: 1, count: 2, kind: 'coin' }, { denomination: '1 SAR note', count: 1 }] });
    expect(sar.total).toBe('3.00');
    await fails(tool, { currency: 'SAR', counts: [{ denomination: 1, count: 2 }] }, /both a note and a coin/);
    const c = await run(tool, { currency: 'CUSTOM', custom: { name: 'TRY', decimals: 2, notes: [200, 100], coins: '1, 0.5' }, counts: [{ denomination: 200, count: 2 }, { denomination: 0.5, count: 3 }] });
    expect(c.total).toBe('401.50');
    const l = await run(tool, { currency: 'GBP', list: true });
    expect(l.denominations.map((d: { label: string }) => d.label)).toContain('50p');
    await fails(tool, { currency: 'USD', counts: [{ denomination: 3, count: 1 }] }, /No note or coin/);
  });
});

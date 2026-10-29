import { describe, expect, it } from 'vitest';
import tool, { allocate, cents, compute, itemSubs } from '../../../src/tools/web/calc/split-bill.js';
import { fails, run } from './_run.js';

describe('calc_split_bill (split-bill self-test)', () => {
  it('matches the website known answers', () => {
    const a = allocate(1000, [1, 1, 1]);
    const s = compute({ subs: allocate(10000, [1, 1, 1]), taxPct: 0, tipPct: 10, tipOnTax: false, step: 0, even: true });
    const it2 = itemSubs([{ id: 1 }, { id: 2 }], [{ price: '12', who: [] }, { price: '6', who: [1] }]);
    const t = compute({ subs: it2, taxPct: 10, tipPct: 0, tipOnTax: false, step: 0 });
    const tt = compute({ subs: [10000], taxPct: 16, tipPct: 10, tipOnTax: true, step: 0 });
    const rr = compute({ subs: allocate(10000, [1, 1, 1]), taxPct: 0, tipPct: 0, tipOnTax: false, step: 100, even: true });
    expect(a).toEqual([334, 333, 333]);
    expect([s.total, s.pays, s.collected]).toEqual([11000, [3667, 3667, 3666], 11000]);
    expect(it2).toEqual([1200, 600]);
    expect(t.pays).toEqual([1320, 660]);
    expect([tt.tip, tt.total]).toEqual([1160, 12760]);
    expect([rr.pays, rr.collected - rr.total]).toEqual([[3400, 3400, 3400], 200]);
    expect(allocate(5, [0, 0])).toEqual([0, 0]);
    expect(cents('12.345')).toBe(1235);
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { bill: 100, people: 3, tipPercent: 10, currency: 'JOD' });
    expect(r.shares.map((x: { pays: number }) => x.pays)).toEqual([36.67, 36.67, 36.66]);
    expect(r.summary).toContain('2 × *36.67 JOD* + 1 × *36.66 JOD*');
    const i = await run(tool, {
      mode: 'items', people: ['Sara', 'Omar', 'Lina'], taxPercent: 16, tipPercent: 10, currency: '$',
      items: [{ name: 'Mansaf (large)', price: 18 }, { name: 'Mixed grill', price: '14.5', sharedBy: ['Sara', 'omar'] }, { name: 'Fattoush', price: 4.25, sharedBy: ['Lina'] }, { name: 'Lemon mint', price: 7.5 }],
    });
    expect(i.subtotal).toBe(44.25);
    expect(i.shares.reduce((s: number, x: { pays: number }) => s + Math.round(x.pays * 100), 0)).toBe(Math.round(i.total * 100));
    expect(i.shares[0]).toMatchObject({ name: 'Sara', items: 15.75 });
    expect(i.summary).toContain('• Lina: *$');
    const ro = await run(tool, { bill: 100, people: 3, tipPercent: 0, roundUpTo: 1 });
    expect([ro.collected, ro.roundingExtra]).toEqual([102, 2]);
    await fails(tool, { mode: 'items', people: ['A'], items: [{ price: 5, sharedBy: ['B'] }] }, /Unknown name/);
  });
});

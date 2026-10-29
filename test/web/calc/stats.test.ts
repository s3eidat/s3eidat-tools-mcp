import { describe, expect, it } from 'vitest';
import tool, { analyze, bins, parse, zscores } from '../../../src/tools/web/calc/stats-calc.js';
import { fails, run } from './_run.js';

describe('calc_stats (stats-calc self-test)', () => {
  const near = (x: number, y: number, e = 1e-9) => Math.abs(x - y) < e;
  it('matches the website known answers', () => {
    const d = [2, 4, 4, 4, 5, 5, 7, 9], a = analyze(d, 'inc')!;
    expect(a.mean).toBe(5);
    expect(near(a.popSD, 2)).toBe(true);
    expect(near(a.sampleSD, Math.sqrt(32 / 7)) && a.sampleSD.toFixed(3) === '2.138').toBe(true);
    expect(near(a.popVar, 4) && near(a.sampleVar, 32 / 7)).toBe(true);
    expect(a.median).toBe(4.5);
    expect([a.modes, a.modeCount]).toEqual([[4], 3]);
    expect([a.min, a.max, a.range, a.sum, a.n]).toEqual([2, 9, 7, 40, 8]);
    expect([a.q1, a.q3]).toEqual([4, 5.5]);
    const e = analyze(d, 'exc')!; expect([e.q1, e.q3]).toEqual([4, 6.5]);
    const t = analyze(d, 'tukey')!; expect([t.q1, t.q3]).toEqual([4, 6]);
    const t7 = analyze([1, 2, 3, 4, 5, 6, 7], 'tukey')!; expect([t7.q1, t7.q3]).toEqual([2, 6]);
    const i7 = analyze([1, 2, 3, 4, 5, 6, 7], 'inc')!; expect([i7.q1, i7.q3]).toEqual([2.5, 5.5]);
    const o = analyze([1, 2, 3, 4, 100], 'inc')!; expect([o.outliers, o.whiskerHi]).toEqual([[100], 4]);
    expect(analyze([1, 2, 3], 'inc')!.modes).toEqual([]);
    expect(analyze([1, 1, 2, 2, 3], 'inc')!.modes).toEqual([1, 2]);
    expect(zscores(d, a)[7].toFixed(4)).toBe((4 / Math.sqrt(32 / 7)).toFixed(4));
    expect(parse('1, 2; 3\n4\t5 | 6', 'sep').vals).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parse('1,234 5,678.5\n12', 'thou').vals).toEqual([1234, 5678.5, 12]);
    expect(parse('1,5 2,25;3', 'dec').vals).toEqual([1.5, 2.25, 3]);
    expect(parse('\u0661\u066b\u0665 \u0662', 'sep').vals).toEqual([1.5, 2]);
    const hd = parse('Score\n10\n-2.5\n1e3\nn/a', 'sep'); expect([hd.vals, hd.skipped.length]).toEqual([[10, -2.5, 1000], 2]);
    const big = analyze([1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16], 'inc')!; expect(near(big.popVar, 22.5, 1e-6)).toBe(true);
    const b = bins(analyze([1, 2, 2, 3, 3, 3, 4, 4, 5, 10], 'inc')!); expect(b.reduce((s, x) => s + x.c, 0)).toBe(10);
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { data: 'Score\n2, 4, 4, 4, 5, 5, 7, 9', zScores: true });
    expect(r).toMatchObject({ count: 8, mean: 5, median: 4.5, modes: [4], populationSD: 2, sampleSD: 2.1380899353, q1: 4, q3: 5.5, skipped: ['Score'] });
    expect(r.frequency[0]).toEqual({ value: '2', count: 1, relative: 0.125, cumulative: 1 });
    expect(r.zScores[7].z).toBe(1.870829);
    expect(r.summary).toContain('Mode: 4 (×3)');
    const arr = await run(tool, { data: Array.from({ length: 30 }, (_, i) => i * 1.5), quartileMethod: 'tukey' });
    expect(arr.frequency.length).toBeGreaterThan(1);
    expect(arr.frequency[0].value).toMatch(/ – < /);
    const one = await run(tool, { data: [7] });
    expect(one.sampleSD).toBeNull();
    await fails(tool, { data: 'abc def' }, /No numbers/);
  });
});

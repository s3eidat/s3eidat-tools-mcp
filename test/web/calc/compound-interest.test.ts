import { describe, expect, it } from 'vitest';
import tool, { project, type Plan } from '../../../src/tools/web/calc/compound-interest.js';
import { fails, run } from './_run.js';

describe('calc_compound_interest (compound-interest self-test)', () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.006;
  const base: Plan = { initial: 0, monthly: 0, rate: 5, years: 10, freq: 1, timing: 'end', inflation: 0 };
  const P = (o: Partial<Plan>) => project({ ...base, ...o });
  it('matches the website known answers', () => {
    expect(near(P({ initial: 10000 }).balance, 16288.95)).toBe(true);
    expect(near(P({ initial: 10000, freq: 12 }).balance, 16470.09)).toBe(true);
    expect(near(P({ initial: 1000, rate: 100, years: 1, freq: 0 }).balance, 2718.28)).toBe(true);
    expect(near(P({ monthly: 100, rate: 6, freq: 12 }).balance, 16387.93)).toBe(true);
    expect(near(P({ monthly: 100, rate: 6, freq: 12, timing: 'start' }).balance, 16469.87)).toBe(true);
    expect(P({ monthly: 100, rate: 0 }).balance).toBe(12000);
    expect(P({ monthly: 100, rate: 6, freq: 12 }).rows).toHaveLength(10);
    expect(P({ initial: 1000, rate: 0, inflation: 2 }).real).toBeCloseTo(1000 / Math.pow(1.02, 10), 9);
    expect(P({ initial: 500, years: 1.5 }).rows).toHaveLength(2);
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { initial: '10,000', annualRate: 5, years: 10, compounding: 'yearly' });
    expect(r.finalBalance).toBe(16288.95);
    expect(r.interestEarned).toBe(6288.95);
    expect(r.rows).toHaveLength(10);
    const i = await run(tool, { monthly: 100, annualRate: 6, years: 10, inflation: 3, table: false });
    expect(i.finalBalance).toBe(16387.93);
    expect(i.todaysMoney).toBeLessThan(i.finalBalance);
    expect(i.rows).toBeUndefined();
    await fails(tool, { annualRate: 5, years: 10 }, /initial deposit or a monthly/);
    await fails(tool, { initial: 1, annualRate: 5, years: 200 }, /100 years/);
  });
});

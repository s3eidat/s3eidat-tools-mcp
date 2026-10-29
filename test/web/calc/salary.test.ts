import { describe, expect, it } from 'vitest';
import tool, { convert, overtime, raisePct } from '../../../src/tools/web/calc/salary-calc.js';
import { fails, run } from './_run.js';

describe('calc_salary (salary-calc self-test)', () => {
  it('matches the website known answers', () => {
    const w = { hpw: 40, dpw: 5, wpy: 52 }, o = overtime(25, 5, 1.5, w);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    expect(near(convert(25, 'hour', 'year', w), 52000)).toBe(true);
    expect(near(convert(52000, 'year', 'hour', w), 25)).toBe(true);
    expect(near(convert(52000, 'year', 'day', w), 200)).toBe(true);
    expect(convert(52000, 'year', 'month', w).toFixed(2)).toBe('4333.33');
    expect(near(convert(52000, 'year', 'biweek', w), 2000)).toBe(true);
    expect(near(convert(1000, 'week', 'year', w), 52000)).toBe(true);
    expect(near(convert(1200, 'month', 'semimonth', w), 600)).toBe(true);
    expect(near(convert(30, 'hour', 'day', { hpw: 36, dpw: 4, wpy: 52 }), 270)).toBe(true);
    expect(near(o.week, 187.5) && near(o.month, 812.5)).toBe(true);
    expect(near(raisePct(52000, 54600), 5)).toBe(true);
    expect(raisePct(52000, 55000).toFixed(2)).toBe('5.77');
    expect(raisePct(0, 10)).toBeNaN();
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { amount: '52,000', period: 'year', overtimeHours: 5, raisePercent: 5, currency: 'usd' });
    expect(r.periods).toEqual({ hour: 25, day: 200, week: 1000, biweek: 2000, semimonth: 2166.67, month: 4333.33, year: 52000 });
    expect(r.overtime).toMatchObject({ hourlyRate: 25, overtimeRate: 37.5, perWeek: 187.5, perMonth: 812.5 });
    expect(r.raise.newYearly).toBe(54600);
    expect(r.summary).toContain('Per hour: $25.00');
    const n = await run(tool, { amount: 52000, period: 'year', newMonthlyPay: 55000 / 12 });
    expect(n.raise.percent).toBe(5.77);
    await fails(tool, { amount: 1, hoursPerWeek: 200 }, /168/);
  });
});

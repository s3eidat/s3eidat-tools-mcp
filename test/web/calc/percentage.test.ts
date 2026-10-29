import { describe, expect, it } from 'vitest';
import tool, { fmt, M } from '../../../src/tools/web/calc/percentage-calc.js';
import { num } from '../../../src/tools/web/calc/_common.js';
import { run } from './_run.js';

describe('calc_percentage (percentage-calc self-test)', () => {
  it('matches the website known answers', () => {
    const m = M.mm(80, 100);
    expect(M.of(15, 200)).toBe(30);
    expect(fmt(M.what(30, 200))).toBe('15');
    expect(M.change(50, 75)).toBe(50);
    expect(M.change(80, 60)).toBe(-25);
    expect(fmt(M.change(-50, -25))).toBe('50');
    expect(M.change(0, 5)).toBeNaN();
    expect(M.what(1, 0)).toBeNaN();
    expect(fmt(M.inc(200, 15, '+'))).toBe('230');
    expect(fmt(M.inc(200, 15, '-'))).toBe('170');
    expect(fmt(M.rev(115, 15, '+'))).toBe('100');
    expect(fmt(M.rev(80, 20, '-'))).toBe('100');
    expect(fmt(m.margin)).toBe('20');
    expect(fmt(m.markup)).toBe('25');
    expect(fmt(0.1 + 0.2)).toBe('0.3');
    expect(fmt(1234.5)).toBe('1,234.5');
    expect(num('1,000')).toBe(1000);
    expect(num('−5')).toBe(-5);
    expect(num('\u0661\u0665')).toBe(15);
  });
  it('answers every question type as a tool', async () => {
    expect((await run(tool, { mode: 'percent_of', percent: 15, value: 200 })).result).toBe(30);
    expect((await run(tool, { mode: 'what_percent', part: 30, whole: 120 })).formatted).toBe('25%');
    const ch = await run(tool, { mode: 'change', from: 80, to: 100 });
    expect([ch.result, ch.formatted, ch.direction, ch.difference]).toEqual([25, '+25%', 'increase', 20]);
    expect((await run(tool, { mode: 'change', from: 0, to: 5 })).result).toBeNull();
    expect((await run(tool, { mode: 'increase', value: 250, percent: 20 })).result).toBe(300);
    expect((await run(tool, { mode: 'decrease', value: 200, percent: '15%' })).result).toBe(170);
    expect((await run(tool, { mode: 'reverse_increase', value: 115, percent: 15 })).result).toBe(100);
    expect((await run(tool, { mode: 'reverse_decrease', value: 0, percent: 100 })).result).toBeNull();
    const mm = await run(tool, { mode: 'margin_markup', cost: 60, price: 100 });
    expect([mm.profit, mm.margin, mm.markup]).toEqual([40, 40, 66.6666666667]);
    await expect(run(tool, { mode: 'percent_of', percent: 5 })).rejects.toThrow(/"value" is required/);
  });
});

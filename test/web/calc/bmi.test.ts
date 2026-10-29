import { describe, expect, it } from 'vitest';
import bmiTool, { bmi, bmr, category, healthyRange, IN, LB, round1, whtr, whtrLabel } from '../../../src/tools/web/calc/bmi-calc.js';
import { fails, run } from './_run.js';

describe('calc_bmi (bmi-calc self-test)', () => {
  it('matches the website known answers', () => {
    const r = healthyRange(175);
    expect(round1(bmi(70, 175)).toFixed(1)).toBe('22.9');
    expect(category(bmi(70, 175)).name).toBe('Healthy weight');
    expect(Math.abs(bmi(150 * LB, 65 * IN) - (703 * 150) / (65 * 65))).toBeLessThan(0.02);
    expect([category(18.49).c, category(18.5).c, category(25).c]).toEqual([0, 1, 2]);
    expect(category(30).name).toBe('Obesity class I');
    expect(category(40).name).toBe('Obesity class III');
    expect(bmr(70, 175, 30, 'm')).toBe(1648.75);
    expect(bmr(70, 175, 30, 'f')).toBe(1482.75);
    expect([round1(r[0]), round1(r[1])]).toEqual([56.7, 76.3]);
    expect(whtr(80, 175).toFixed(2)).toBe('0.46');
    expect(whtrLabel(0.55)).toBe('Increased risk');
  });
  it('runs as a tool', async () => {
    const r = await run(bmiTool, { heightCm: 175, weight: 70, age: 30, waist: 80 });
    expect(r).toMatchObject({ bmi: 22.9, category: 'Healthy weight', bmiPrime: 0.91, bmr: 1649, toHealthyRange: 'you are in range' });
    expect(r.healthyRange).toEqual({ min: 56.7, max: 76.3, unit: 'kg' });
    expect(r.waistToHeight).toEqual({ ratio: 0.46, label: 'Healthy' });
    expect(r.calories[0]).toEqual({ activity: 'Sedentary', factor: 1.2, maintain: 1979, lose: 1500 });
    const i = await run(bmiTool, { units: 'imperial', heightFt: 5, heightIn: 5, weight: 150, age: 15 });
    expect(i.healthyRange.unit).toBe('lb');
    expect(i.bmr).toBeUndefined();
    expect(i.note).toMatch(/percentile/);
    await fails(bmiTool, { heightCm: 20, weight: 70 }, /between 50 and 272/);
  });
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, need, optNumLike } from './_common.js';

// Ported from https://github.com/s3eidat/bmi-calc (app.js): WHO adult categories, Mifflin-St Jeor BMR, waist-to-height.
export const LB = 0.45359237, IN = 2.54;
export const ACT: [number, string][] = [[1.2, 'Sedentary'], [1.375, 'Light'], [1.55, 'Moderate'], [1.725, 'Active'], [1.9, 'Very active']];
export const CATS = [
  { max: 18.5, name: 'Underweight', c: 0 }, { max: 25, name: 'Healthy weight', c: 1 }, { max: 30, name: 'Overweight', c: 2 },
  { max: 35, name: 'Obesity class I', c: 3 }, { max: 40, name: 'Obesity class II', c: 3 }, { max: Infinity, name: 'Obesity class III', c: 3 }];

export function bmi(kg: number, cm: number) { const m = cm / 100; return kg / (m * m); }
export function category(b: number) { for (const c of CATS) if (b < c.max) return c; return CATS[CATS.length - 1]; }
export function healthyRange(cm: number): [number, number] { const m = cm / 100; return [18.5 * m * m, 24.9 * m * m]; }
export function bmr(kg: number, cm: number, age: number, sex: 'm' | 'f') { return 10 * kg + 6.25 * cm - 5 * age + (sex === 'f' ? -161 : 5); }
export const whtr = (waist: number, cm: number) => waist / cm;
export const whtrLabel = (r: number) => (r < 0.4 ? 'Low — check with a doctor' : r < 0.5 ? 'Healthy' : r < 0.6 ? 'Increased risk' : 'High risk');
export const round1 = (v: number) => Math.round(v * 10) / 10;

export default defineTool({
  name: 'calc_bmi',
  title: 'BMI calculator',
  webSlug: 'bmi-calc',
  description:
    'Body mass index with the WHO adult category, the healthy weight range for your height (BMI 18.5–24.9), BMI Prime, optional ' +
    'waist-to-height ratio, and for adults (18–120, with age) BMR by Mifflin-St Jeor plus daily calories to maintain or lose ' +
    '~0.5 kg (1 lb) a week at five activity levels. Metric (cm, kg) or imperial (ft + in, lb). Height 50–272 cm, weight ' +
    `10–650 kg. Not medical advice; children need percentile charts. Web version: ${webUrl('bmi-calc')}`,
  inputSchema: z.object({
    units: z.enum(['metric', 'imperial']).optional().default('metric').describe('metric: cm and kg; imperial: ft + in and lb.'),
    heightCm: optNumLike('Height in cm (metric).'),
    heightFt: optNumLike('Height, feet part (imperial).'),
    heightIn: optNumLike('Height, inches part (imperial).'),
    weight: optNumLike('Weight in kg (metric) or lb (imperial).'),
    age: optNumLike('Age in years (adults 18+ get BMR and calories).'),
    sex: z.enum(['m', 'f']).optional().default('m').describe('Sex, for BMR (m or f).'),
    waist: optNumLike('Optional waist size in cm (metric) or inches (imperial).'),
  }),
  outputSchema: z.object({
    bmi: z.number(), category: z.string(), categoryClass: z.number(),
    healthyRange: z.object({ min: z.number(), max: z.number(), unit: z.string() }), toHealthyRange: z.string(),
    bmiPrime: z.number(),
    waistToHeight: z.object({ ratio: z.number(), label: z.string() }).optional(),
    bmr: z.number().optional(),
    calories: z.array(z.object({ activity: z.string(), factor: z.number(), maintain: z.number(), lose: z.number() })).optional(),
    note: z.string().optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { heightCm: 175, weight: 70, age: 30, sex: 'm' }, note: 'BMI 22.9 Healthy weight, BMR 1649 kcal' }],
  run(input) {
    const metric = input.units === 'metric';
    const cm = metric ? need(input.heightCm, 'heightCm') : (need(input.heightFt, 'heightFt', 0) * 12 + need(input.heightIn, 'heightIn', 0)) * IN;
    const w = need(input.weight, 'weight'), kg = metric ? w : w * LB;
    const age = need(input.age, 'age', NaN), waistIn = need(input.waist, 'waist', NaN), waist = metric ? waistIn : waistIn * IN;
    if (!(cm >= 50 && cm <= 272)) throw new ToolError('Enter a height between 50 and 272 cm (1′8″–8′11″).');
    if (!(kg >= 10 && kg <= 650)) throw new ToolError('Enter a weight between 10 and 650 kg (22–1,433 lb).');
    const showW = (k: number) => (metric ? round1(k) + ' kg' : round1(k / LB) + ' lb');
    const b = bmi(kg, cm), c = category(b), range = healthyRange(cm);
    const diff = kg < range[0] ? 'gain ' + showW(range[0] - kg) + ' to reach it' : kg > range[1] ? 'lose ' + showW(kg - range[1]) + ' to reach it' : 'you are in range';
    const out: Record<string, unknown> = {
      bmi: round1(b), category: c.name, categoryClass: c.c,
      healthyRange: { min: round1(metric ? range[0] : range[0] / LB), max: round1(metric ? range[1] : range[1] / LB), unit: metric ? 'kg' : 'lb' },
      toHealthyRange: diff, bmiPrime: Number((b / 25).toFixed(2)),
    };
    if (waist > 0) { const r = whtr(waist, cm); out.waistToHeight = { ratio: Number(r.toFixed(2)), label: whtrLabel(r) }; }
    const adult = age >= 18 && age <= 120;
    let base = 0;
    if (adult) {
      base = bmr(kg, cm, age, input.sex);
      out.bmr = Math.round(base);
      out.calories = ACT.map(([f, name]) => { const t = base * f; return { activity: name, factor: f, maintain: Math.round(t), lose: Math.round(Math.max(t - 500, input.sex === 'f' ? 1200 : 1500)) }; });
    } else {
      out.note = age > 0 && age < 18 ? 'BMI categories and calorie formulas here are for adults (18+). For children and teens, BMI is read on age-and-sex percentile charts.'
        : 'Add your age to see BMR and daily calories.';
    }
    out.summary = 'BMI ' + round1(b).toFixed(1) + ' (' + c.name + ')\nHealthy weight for ' + Math.round(cm) + ' cm: ' + showW(range[0]) + ' – ' + showW(range[1]) +
      (waist > 0 ? '\nWaist-to-height: ' + whtr(waist, cm).toFixed(2) : '') + (adult ? '\nBMR: ' + Math.round(base).toLocaleString('en-US') + ' kcal/day' : '');
    return out;
  },
});

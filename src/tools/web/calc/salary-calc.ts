import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, money, need, numLike, optNumLike, round } from './_common.js';

// Ported from https://github.com/s3eidat/salary-calc (app.js): every period goes through a yearly figure.
export const PERIODS = [['hour', 'Per hour'], ['day', 'Per day'], ['week', 'Per week'], ['biweek', 'Every 2 weeks'], ['semimonth', 'Twice a month'], ['month', 'Per month'], ['year', 'Per year']] as const;
export type Period = (typeof PERIODS)[number][0];
export interface Work { hpw: number; dpw: number; wpy: number }

/** How many of each period fit in a year, given the work pattern. */
export function perYear(p: Period, w: Work) {
  return { hour: w.hpw * w.wpy, day: w.dpw * w.wpy, week: w.wpy, biweek: w.wpy / 2, semimonth: 24, month: 12, year: 1 }[p];
}
export const convert = (amount: number, from: Period, to: Period, w: Work) => (amount * perYear(from, w)) / perYear(to, w);
export function overtime(hourly: number, hours: number, mult: number, w: Work) {
  const wk = hourly * mult * hours;
  return { week: wk, month: (wk * w.wpy) / 12, year: wk * w.wpy };
}
export const raisePct = (oldV: number, newV: number) => (oldV > 0 ? ((newV - oldV) / oldV) * 100 : NaN);

const periodEnum = z.enum(['hour', 'day', 'week', 'biweek', 'semimonth', 'month', 'year']);

export default defineTool({
  name: 'calc_salary',
  title: 'Salary / pay period converter',
  webSlug: 'salary-calc',
  description:
    'Convert pay between per hour, day, week, every 2 weeks, twice a month, month and year using your hours per week, days per ' +
    'week and weeks per year (defaults 40 / 5 / 52). Optional overtime (hours per week × multiplier, e.g. 1.25, 1.5, 2) and a ' +
    'raise given as a percent or as the new monthly pay. Amounts are rounded to 2 decimals. ' +
    `Web version: ${webUrl('salary-calc')}`,
  inputSchema: z.object({
    amount: numLike('The pay amount, e.g. 1200.'),
    period: periodEnum.optional().default('month').describe('The period "amount" is paid for.'),
    hoursPerWeek: optNumLike('Working hours per week (0–168, default 40).'),
    daysPerWeek: optNumLike('Working days per week (0–7, default 5).'),
    weeksPerYear: optNumLike('Paid weeks per year (0–53, default 52).'),
    overtimeHours: optNumLike('Optional overtime hours per week.'),
    overtimeMultiplier: optNumLike('Overtime rate multiplier (default 1.5).'),
    raisePercent: optNumLike('Optional raise in percent (gives the new pay).'),
    newMonthlyPay: optNumLike('Or: the new monthly pay (gives the raise percent).'),
    currency: z.string().max(3).optional().describe('Optional ISO currency code for the text summary (e.g. USD, JOD).'),
  }),
  outputSchema: z.object({
    periods: z.object({ hour: z.number(), day: z.number(), week: z.number(), biweek: z.number(), semimonth: z.number(), month: z.number(), year: z.number() }),
    overtime: z.object({ hourlyRate: z.number(), overtimeRate: z.number(), perWeek: z.number(), perMonth: z.number(), perYear: z.number(), monthlyWithOvertime: z.number() }).optional(),
    raise: z.object({ percent: z.number(), newMonthly: z.number(), newYearly: z.number(), newHourly: z.number(), increaseMonthly: z.number(), increaseYearly: z.number() }).optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { amount: 52000, period: 'year' }, note: 'hour 25, day 200, month 4333.33, biweek 2000' }],
  run(input) {
    const w: Work = { hpw: need(input.hoursPerWeek, 'hoursPerWeek', 40), dpw: need(input.daysPerWeek, 'daysPerWeek', 5), wpy: need(input.weeksPerYear, 'weeksPerYear', 52) };
    const amt = need(input.amount, 'amount'), per = input.period;
    if (!(w.hpw > 0 && w.hpw <= 168)) throw new ToolError('Hours per week must be between 0 and 168.');
    if (!(w.dpw > 0 && w.dpw <= 7)) throw new ToolError('Days per week must be between 0 and 7.');
    if (!(w.wpy > 0 && w.wpy <= 53)) throw new ToolError('Weeks per year must be between 0 and 53.');
    if (!(amt >= 0)) throw new ToolError('Enter a pay amount of 0 or more.');
    const cur = input.currency?.trim().toUpperCase();
    const fm = (v: number) => {
      if (cur) { try { return Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(v); } catch { /* unknown code: plain */ } }
      return money(v);
    };
    const periods = Object.fromEntries(PERIODS.map(([p]) => [p, round(convert(amt, per, p, w))])) as Record<Period, number>;
    const out: Record<string, unknown> = { periods };
    const hourly = convert(amt, per, 'hour', w), month = convert(amt, per, 'month', w);
    if (input.overtimeHours !== undefined) {
      const oh = need(input.overtimeHours, 'overtimeHours'), mult = need(input.overtimeMultiplier, 'overtimeMultiplier', 1.5);
      if (!(oh >= 0)) throw new ToolError('Overtime hours must be 0 or more.');
      if (!(mult > 0)) throw new ToolError('Overtime multiplier must be above 0.');
      const o = overtime(hourly, oh, mult, w);
      out.overtime = { hourlyRate: round(hourly), overtimeRate: round(hourly * mult), perWeek: round(o.week), perMonth: round(o.month), perYear: round(o.year), monthlyWithOvertime: round(month + o.month) };
    }
    if (input.raisePercent !== undefined || input.newMonthlyPay !== undefined) {
      let rp: number, nm: number;
      if (input.raisePercent !== undefined) { rp = need(input.raisePercent, 'raisePercent'); nm = month * (1 + rp / 100); }
      else { nm = need(input.newMonthlyPay, 'newMonthlyPay'); rp = raisePct(month, nm); }
      if (!isFinite(rp) || !isFinite(nm)) throw new ToolError('A raise needs a current pay above 0.');
      out.raise = { percent: round(rp), newMonthly: round(nm), newYearly: round(convert(nm, 'month', 'year', w)), newHourly: round(convert(nm, 'month', 'hour', w)),
        increaseMonthly: round(nm - month), increaseYearly: round((nm - month) * 12) };
    }
    out.summary = PERIODS.map(([p, label]) => label + ': ' + fm(convert(amt, per, p, w))).join('\n') + '\n(' + w.hpw + ' h/week, ' + w.dpw + ' days/week, ' + w.wpy + ' weeks/year)';
    return out;
  },
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, money, need, numLike, optNumLike, round } from './_common.js';

// Ported from https://github.com/s3eidat/compound-interest (app.js): month-by-month projection.
export const FREQ: Record<string, number> = { yearly: 1, 'half-yearly': 2, quarterly: 4, monthly: 12, daily: 365, continuously: 0 };

/** Effective rate per month for a nominal annual rate compounded `freq` times a year (0 = continuously). */
export function monthlyRate(annual: number, freq: number) {
  const r = annual / 100;
  if (freq === 0) return Math.exp(r / 12) - 1;
  return Math.pow(1 + r / freq, freq / 12) - 1;
}

export interface Plan { initial: number; monthly: number; rate: number; years: number; freq: number; timing: 'start' | 'end'; inflation: number }

/** One row per year: deposits, interest and balance (plus real value when inflation is set). */
export function project(o: Plan) {
  const rm = monthlyRate(o.rate, o.freq);
  let bal = o.initial, dep = o.initial, yDep = 0, yInt = 0;
  const rows: { year: number; months: number; deposits: number; interest: number; totalDep: number; balance: number; real: number }[] = [];
  const months = Math.round(o.years * 12);
  for (let m = 1; m <= months; m++) {
    if (o.timing === 'start') { bal += o.monthly; dep += o.monthly; yDep += o.monthly; }
    const i = bal * rm; bal += i; yInt += i;
    if (o.timing !== 'start') { bal += o.monthly; dep += o.monthly; yDep += o.monthly; }
    if (m % 12 === 0 || m === months) {
      const y = m / 12;
      rows.push({ year: Math.ceil(y), months: m, deposits: yDep, interest: yInt, totalDep: dep, balance: bal,
        real: o.inflation ? bal / Math.pow(1 + o.inflation / 100, y) : bal });
      yDep = 0; yInt = 0;
    }
  }
  const last = rows[rows.length - 1] || { balance: o.initial, totalDep: o.initial, real: o.initial };
  return { rows, balance: last.balance, deposits: last.totalDep, interest: last.balance - last.totalDep, real: last.real };
}

const yearsLabel = (y: number) => +y.toFixed(2) + (y === 1 ? ' year' : ' years');

export default defineTool({
  name: 'calc_compound_interest',
  title: 'Compound interest / savings growth',
  webSlug: 'compound-interest',
  description:
    'Project savings with compound interest: an initial deposit plus monthly contributions (at the start or end of each month), ' +
    'a nominal annual rate compounded yearly, half-yearly, quarterly, monthly, daily or continuously, optionally adjusted for ' +
    'inflation ("today\'s money"). Returns final balance, total deposits, interest earned and a year-by-year table. ' +
    `Rate -50–100 %, 1 month to 100 years. Web version: ${webUrl('compound-interest')}`,
  inputSchema: z.object({
    initial: optNumLike('Initial deposit (default 0).'),
    monthly: optNumLike('Monthly contribution (default 0).'),
    annualRate: numLike('Nominal annual interest rate in percent, e.g. 7.'),
    years: numLike('Duration in years (fractions allowed, e.g. 1.5; at least one month).'),
    compounding: z.enum(['yearly', 'half-yearly', 'quarterly', 'monthly', 'daily', 'continuously']).optional().default('monthly').describe('How often interest compounds.'),
    timing: z.enum(['end', 'start']).optional().default('end').describe('Contributions at the end (ordinary annuity) or start (annuity due) of each month.'),
    inflation: optNumLike('Optional yearly inflation in percent, to show the balance in today\'s money.'),
    table: z.boolean().optional().default(true).describe('Include the year-by-year table.'),
  }),
  outputSchema: z.object({
    finalBalance: z.number(), totalDeposits: z.number(), interestEarned: z.number(), growthMultiple: z.number().nullable(),
    todaysMoney: z.number().optional(),
    rows: z.array(z.object({ year: z.number(), months: z.number(), deposits: z.number(), interest: z.number(), totalDeposits: z.number(),
      totalInterest: z.number(), balance: z.number(), todaysMoney: z.number().optional() })).optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { initial: 10000, annualRate: 5, years: 10, compounding: 'yearly' }, note: 'finalBalance 16288.95' }],
  run(input) {
    const o: Plan = {
      initial: need(input.initial, 'initial', 0), monthly: need(input.monthly, 'monthly', 0), rate: need(input.annualRate, 'annualRate'),
      years: need(input.years, 'years'), freq: FREQ[input.compounding], timing: input.timing, inflation: need(input.inflation, 'inflation', 0),
    };
    if (!(o.initial >= 0) || !(o.monthly >= 0)) throw new ToolError('Amounts must be 0 or more.');
    if (!(o.initial > 0 || o.monthly > 0)) throw new ToolError('Enter an initial deposit or a monthly contribution.');
    if (!(o.rate >= -50 && o.rate <= 100)) throw new ToolError('Enter an annual rate between -50 and 100%.');
    if (!(o.years > 0 && o.years <= 100) || o.years * 12 < 1) throw new ToolError('Enter between 1 month (0.09) and 100 years.');
    if (!(o.inflation > -50 && o.inflation < 100)) throw new ToolError('Enter an inflation rate below 100%.');
    const r = project(o);
    const out: Record<string, unknown> = {
      finalBalance: round(r.balance), totalDeposits: round(r.deposits), interestEarned: round(r.interest),
      growthMultiple: r.deposits ? round(r.balance / r.deposits) : null,
    };
    if (o.inflation) out.todaysMoney = round(r.real);
    if (input.table) {
      out.rows = r.rows.map((x) => ({
        year: x.year, months: x.months, deposits: round(x.deposits), interest: round(x.interest), totalDeposits: round(x.totalDep),
        totalInterest: round(x.balance - x.totalDep), balance: round(x.balance), ...(o.inflation ? { todaysMoney: round(x.real) } : {}),
      }));
    }
    out.summary = 'Initial ' + money(o.initial) + ' + ' + money(o.monthly) + '/month at ' + o.rate + '% (compounded ' + input.compounding + ') for ' + yearsLabel(o.years) + '\n' +
      'Final balance: ' + money(r.balance) + '\nYour deposits: ' + money(r.deposits) + '\nInterest earned: ' + money(r.interest) +
      (o.inflation ? "\nIn today's money (" + o.inflation + '% inflation): ' + money(r.real) : '');
    return out;
  },
});

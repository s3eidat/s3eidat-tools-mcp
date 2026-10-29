import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, money, need, numLike, optNumLike } from './_common.js';

// Ported from https://github.com/s3eidat/loan-calc (app.js): whole-cent maths, the last payment absorbs the rounding.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthlyPayment(P: number, annual: number, n: number) {
  const r = annual / 1200;
  if (!r) return P / n;
  return (P * r) / (1 - Math.pow(1 + r, -n));
}

export interface Row { n: number; interest: number; principal: number; extra: number; payment: number; balance: number }

/** Schedule in integer cents. The final payment absorbs the rounding remainder so the balance ends at exactly 0. */
export function amortize(P: number, annual: number, n: number, extra = 0) {
  const r = annual / 1200;
  let bal = Math.round(P * 100);
  const pay = Math.round(monthlyPayment(P, annual, n) * 100);
  const ex = Math.round((extra || 0) * 100), rows: Row[] = [];
  for (let i = 1; i <= n && bal > 0; i++) {
    const interest = Math.round(bal * r);
    const princ = i === n ? bal : Math.max(0, Math.min(bal, pay - interest));
    const x = Math.min(bal - princ, ex);
    bal -= princ + x;
    rows.push({ n: i, interest, principal: princ, extra: x, payment: interest + princ + x, balance: bal });
  }
  let ti = 0, tp = 0;
  rows.forEach((row) => { ti += row.interest; tp += row.payment; });
  return { payment: pay, rows, interest: ti, total: tp };
}

export interface YM { y: number; m: number }
export function addMonths(ym: YM, k: number): YM { const t = ym.y * 12 + ym.m + k; return { y: Math.floor(t / 12), m: t % 12 }; }
const ymLabel = (ym: YM) => MONTHS[ym.m] + ' ' + ym.y;
const fmtYM = (ym: YM) => ym.y + '-' + String(ym.m + 1).padStart(2, '0');
const c2 = (c: number) => c / 100;
export function dur(n: number) {
  const y = Math.floor(n / 12), m = n % 12, s: string[] = [];
  if (y) s.push(y + (y === 1 ? ' year' : ' years'));
  if (m) s.push(m + (m === 1 ? ' month' : ' months'));
  return s.join(' ') || '0 months';
}
function defaultStart(): YM { const d = new Date(); return addMonths({ y: d.getFullYear(), m: d.getMonth() }, 1); }

/** Group months into calendar years (based on the first payment month). */
export function byYear(rows: Row[], start: YM) {
  const out: { year: number; interest: number; principal: number; extra: number; payment: number; balance: number }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const r of rows) {
    const ym = addMonths(start, r.n - 1);
    if (!cur || cur.year !== ym.y) { cur = { year: ym.y, interest: 0, principal: 0, extra: 0, payment: 0, balance: 0 }; out.push(cur); }
    cur.interest += r.interest; cur.principal += r.principal; cur.extra += r.extra; cur.payment += r.payment; cur.balance = r.balance;
  }
  return out;
}

const rowShape = {
  payment: z.number(), principal: z.number(), extra: z.number(), interest: z.number(), balance: z.number(),
};

export default defineTool({
  name: 'calc_loan',
  title: 'Loan / mortgage calculator',
  webSlug: 'loan-calc',
  description:
    'Monthly payment, total interest, total paid and payoff month for a fixed-rate loan or mortgage, with an optional extra ' +
    'monthly payment (shows interest saved and how much sooner it ends) and an amortization schedule by year or by month ' +
    '(or none). Maths is in whole cents like the website; the last payment absorbs the rounding so the balance ends at 0. ' +
    `Rate 0–100 %, term 1 month to 100 years. Web version: ${webUrl('loan-calc')}`,
  inputSchema: z.object({
    amount: numLike('Loan amount (principal), e.g. 250000 or "250,000".'),
    annualRate: numLike('Annual interest rate in percent, e.g. 6.5. 0 is allowed.'),
    term: numLike('Loan term, in years (default) or months (see termUnit).'),
    termUnit: z.enum(['years', 'months']).optional().default('years').describe('Unit of "term".'),
    extraMonthly: optNumLike('Optional extra principal paid every month.'),
    startMonth: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('First payment month "YYYY-MM". Default: next month.'),
    schedule: z.enum(['yearly', 'monthly', 'none']).optional().default('yearly').describe('Amortization table: per calendar year, per month, or omit it.'),
  }),
  outputSchema: z.object({
    monthlyPayment: z.number(), extraMonthly: z.number(), months: z.number(), duration: z.string(),
    totalInterest: z.number(), totalPaid: z.number(), firstPayment: z.string(), payoffMonth: z.string(), payoffLabel: z.string(),
    savings: z.object({ interestSaved: z.number(), monthsSooner: z.number(), sooner: z.string() }).optional(),
    schedule: z.array(z.object({ year: z.number().optional(), n: z.number().optional(), date: z.string().optional(), ...rowShape })).optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { amount: 200000, annualRate: 6, term: 30, schedule: 'none' }, note: 'monthlyPayment 1199.10, totalInterest 231,677.04, 360 months' }],
  run(input) {
    const P = need(input.amount, 'amount'), rate = need(input.annualRate, 'annualRate'), term = need(input.term, 'term');
    const extra = need(input.extraMonthly, 'extraMonthly', 0);
    const n = input.termUnit === 'years' ? Math.round(term * 12) : Math.round(term);
    if (!(P > 0)) throw new ToolError('Enter a loan amount above 0.');
    if (!(rate >= 0) || rate > 100) throw new ToolError('Enter an interest rate between 0 and 100%.');
    if (!(n >= 1) || n > 1200) throw new ToolError('Enter a term between 1 month and 100 years.');
    if (!(extra >= 0)) throw new ToolError('Extra payment must be 0 or more.');
    let start = defaultStart();
    if (input.startMonth) {
      const m = /^(\d{4})-(\d{2})$/.exec(input.startMonth)!;
      if (+m[2] < 1 || +m[2] > 12) throw new ToolError('startMonth must be YYYY-MM with a month 01–12.');
      start = { y: +m[1], m: +m[2] - 1 };
    }
    const res = amortize(P, rate, n, extra), base = extra ? amortize(P, rate, n, 0) : res;
    const payoff = addMonths(start, res.rows.length - 1);
    const out: Record<string, unknown> = {
      monthlyPayment: c2(res.payment), extraMonthly: c2(Math.round(extra * 100)), months: res.rows.length, duration: dur(res.rows.length),
      totalInterest: c2(res.interest), totalPaid: c2(res.total), firstPayment: fmtYM(start), payoffMonth: fmtYM(payoff), payoffLabel: ymLabel(payoff),
    };
    if (extra && res.rows.length < base.rows.length) {
      out.savings = { interestSaved: c2(base.interest - res.interest), monthsSooner: base.rows.length - res.rows.length, sooner: dur(base.rows.length - res.rows.length) };
    }
    if (input.schedule === 'yearly') {
      out.schedule = byYear(res.rows, start).map((y) => ({ year: y.year, payment: c2(y.payment), principal: c2(y.principal), extra: c2(y.extra), interest: c2(y.interest), balance: c2(y.balance) }));
    } else if (input.schedule === 'monthly') {
      out.schedule = res.rows.map((r) => ({ n: r.n, date: fmtYM(addMonths(start, r.n - 1)), payment: c2(r.payment), principal: c2(r.principal), extra: c2(r.extra), interest: c2(r.interest), balance: c2(r.balance) }));
    }
    out.summary = 'Loan ' + money(Math.round(P * 100) / 100) + ' at ' + rate + '% for ' + dur(n) + '\n' +
      'Monthly payment: ' + money(c2(res.payment)) + (extra ? ' (+ ' + money(Math.round(extra * 100) / 100) + ' extra)' : '') + '\n' +
      'Total interest: ' + money(c2(res.interest)) + '\nTotal paid: ' + money(c2(res.total)) + '\n' +
      'Paid off: ' + ymLabel(payoff) + ' (' + dur(res.rows.length) + ')';
    return out;
  },
});

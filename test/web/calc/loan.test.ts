import { describe, expect, it } from 'vitest';
import loan, { addMonths, amortize } from '../../../src/tools/web/calc/loan-calc.js';
import { num } from '../../../src/tools/web/calc/_common.js';
import { fails, run } from './_run.js';

describe('calc_loan (loan-calc self-test)', () => {
  it('matches the website known answers', () => {
    const a = amortize(200000, 6, 360, 0);
    const sumP = a.rows.reduce((s, r) => s + r.principal, 0);
    const z = amortize(1000, 0, 3, 0);
    const e = amortize(200000, 6, 360, 200);
    const eP = e.rows.reduce((s, r) => s + r.principal + r.extra, 0);
    const b = amortize(10000, 5, 12, 0);
    expect(a.payment).toBe(119910);
    expect(a.rows).toHaveLength(360);
    expect(sumP).toBe(20000000);
    expect(a.rows[359].balance).toBe(0);
    expect(Math.abs(a.interest - 23167638)).toBeLessThan(200);
    expect([z.payment, z.interest, z.rows[2].payment]).toEqual([33333, 0, 33334]);
    expect(e.rows.length).toBeLessThan(300);
    expect(eP).toBe(20000000);
    expect(e.interest).toBeLessThan(a.interest);
    expect(b.payment).toBe(85607);
    expect(num('200,000')).toBe(200000);
    expect(num('\u0666\u066b\u0665')).toBe(6.5);
    expect(addMonths({ y: 2026, m: 11 }, 1)).toEqual({ y: 2027, m: 0 });
  });

  it('runs as a tool', async () => {
    const r = await run(loan, { amount: '200,000', annualRate: 6, term: 30, startMonth: '2027-01', extraMonthly: 150 });
    expect(r.extraMonthly).toBe(150);
    expect(r.savings.monthsSooner).toBeGreaterThan(0);
    expect(r.schedule[0].year).toBe(2027);
    expect(r.firstPayment).toBe('2027-01');
    const n = await run(loan, { amount: 10000, annualRate: 5, term: 12, termUnit: 'months', schedule: 'monthly', startMonth: '2026-11' });
    expect(n.monthlyPayment).toBe(856.07);
    expect(n.schedule).toHaveLength(12);
    expect(n.schedule[1].date).toBe('2026-12');
    expect(n.payoffMonth).toBe('2027-10');
    expect(n.schedule.at(-1).balance).toBe(0);
    const none = await run(loan, { amount: 1000, annualRate: 0, term: 3, termUnit: 'months', schedule: 'none' });
    expect(none.schedule).toBeUndefined();
    expect(none.summary).toContain('Monthly payment: 333.33');
    await fails(loan, { amount: 0, annualRate: 5, term: 1 }, /above 0/);
    await fails(loan, { amount: 100, annualRate: 101, term: 1 }, /between 0 and 100/);
  });
});

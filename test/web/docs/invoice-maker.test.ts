import { describe, expect, it } from 'vitest';
import invoice, { calc, money, nextNumber } from '../../../src/tools/web/docs/invoice-maker.js';
import { round } from '../../../src/tools/web/docs/_pdf.js';
import { call, tempCtx } from '../../helpers.js';
import { pdfInfo } from './_helpers.js';

const ctx = tempCtx();
type Out = { path: string; pages: number; subtotal: number; discount: number; tax: number; total: number; formattedTotal: string; taxByRate: Record<string, number> };

// Known answers from invoice-maker's S3_SELFTEST.
describe('invoice maths (invoice-maker self-test)', () => {
  it('per-line rounding in the currency minor unit', () => {
    const c = calc({ currency: 'USD', items: [{ qty: 3, price: 19.99, disc: 10, tax: 16 }, { qty: 2, price: 1.005 }] });
    expect([c.sub, c.disc, c.tax, c.total, c.lines[0].net]).toEqual([61.98, 6, 8.64, 64.62, 53.97]);
    const j = calc({ currency: 'JOD', items: [{ qty: 1, price: 10.1235, tax: 16 }] });
    expect([j.d, j.sub, j.tax, j.total]).toEqual([3, 10.124, 1.62, 11.744]);
    const y = calc({ currency: 'JPY', items: [{ qty: 3, price: 333.5, tax: 10 }] });
    expect([y.d, y.sub, y.total]).toEqual([0, 1001, 1101]);
  });
  it('rounding and numbering', () => {
    expect(round((17.255 * 10) / 100, 3)).toBe(1.726);
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(-2.675, 2)).toBe(-2.68);
    expect(nextNumber('INV-0099')).toBe('INV-0100');
    expect(nextNumber('2026/7a')).toBe('2026/8a');
    expect(nextNumber('Draft')).toBe('Draft-2');
  });
  it('money formatting', () => {
    expect(money('USD', 1234.5)).toBe('$1,234.50');
    expect(money('JOD', 10.124).replace(/\s/g, ' ')).toBe('JOD 10.124');
    expect(money('INR', 5)).toMatch(/^INR\s5\.00$/); // ₹ is not in the PDF fonts: ISO code instead
  });
});

describe('doc_invoice tool', () => {
  it('writes a one-page invoice with the totals in it', async () => {
    const r = await call<Out>(invoice, {
      number: 'A-1', date: '2026-10-29', currency: 'USD', from: { name: 'Northwind Studio', address: '18 Harbour Street\nPortland' },
      to: { name: 'Blue Fern Café' }, items: [{ desc: 'Design', qty: 3, price: 19.99, disc: 10, tax: 16 }, { desc: 'Pins', qty: 2, price: 1.005 }],
      notes: 'Thank you!', terms: 'Net 14',
    }, ctx);
    expect([r.subtotal, r.discount, r.tax, r.total, r.formattedTotal]).toEqual([61.98, 6, 8.64, 64.62, '$64.62']);
    expect(r.taxByRate).toEqual({ 16: 8.64 });
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBe(1);
    expect(info.title).toBe('Invoice A-1');
    for (const t of ['INVOICE', 'A-1', '29 Oct 2026', 'Northwind Studio', 'Blue Fern Café', 'BILL TO', 'Design', '$53.97', '$61.98', '-$6.00', 'Tax 16%', '$8.64', 'Total USD', '$64.62', 'Thank you!', 'Net 14']) {
      expect(info.text).toContain(t);
    }
  });
  it('continues long item lists on more pages', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ desc: `Item ${i + 1}`, qty: 1, price: 10 }));
    const r = await call<Out>(invoice, { currency: 'EUR', items, paid: true }, ctx);
    expect(r.total).toBe(600);
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBeGreaterThan(1);
    expect(info.text).toContain('Item 60');
    expect(info.text).toContain('€600.00');
    expect(info.text).toContain('AMOUNT PAID');
  });
  it('refuses text the PDF fonts cannot show', async () => {
    await expect(call(invoice, { to: { name: 'شركة الأمل' }, items: [] }, ctx)).rejects.toThrow(/"to\.name" contains .*Only Latin text/);
  });
});

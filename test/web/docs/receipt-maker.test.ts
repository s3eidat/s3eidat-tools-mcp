import { describe, expect, it } from 'vitest';
import receipt, { calc } from '../../../src/tools/web/docs/receipt-maker.js';
import { MM, wrap } from '../../../src/tools/web/docs/_pdf.js';
import { call, tempCtx } from '../../helpers.js';
import { pdfInfo } from './_helpers.js';

const ctx = tempCtx();
type Out = { path: string; total: number; change: number; text: string };

// Known answers from receipt-maker's S3_SELFTEST.
describe('receipt maths (receipt-maker self-test)', () => {
  it('totals, discount types and rounding', () => {
    const c = calc({ items: [{ qty: 2, price: 3.5 }, { qty: 1, price: 10.255 }], disc: 10, discType: 'pct', tax: 16, paid: 20 }, 3);
    expect([c.sub, c.disc, c.tax, c.total, c.change]).toEqual([17.255, 1.726, 2.485, 18.014, 1.986]);
    const c2 = calc({ items: [{ qty: 1, price: 5 }], disc: 50, discType: 'amt', tax: 10 }, 2);
    expect([c2.disc, c2.total, c2.change]).toEqual([5, 0, 0]);
    expect(calc({ items: [{ qty: 3, price: 0.335 }], disc: 0 }, 2).total).toBe(1.01);
  });
  it('word wrap', () => {
    const m = (t: string) => t.length * 10;
    expect(wrap(m, 'aa bb cc', 50).join('|')).toBe('aa bb|cc');
    expect(wrap(m, 'abcdefghij', 40).join('|')).toBe('abcd|efgh|ij');
  });
});

describe('doc_receipt tool', () => {
  const demo = {
    shop: { name: 'Zaytoun Corner Café', address: 'Rainbow St. 12, Amman', phone: '06 555 0123', currency: 'JD', decimals: 3 },
    no: 1043, when: '2026-10-29T13:05', customer: 'Table 4', paid: 10, disc: 10, tax: 16,
    items: [{ name: 'Cappuccino', qty: 2, price: 2.25 }, { name: "Za'atar manakeesh", qty: 1, price: 1.5 }, { name: 'Fresh orange juice', qty: 1, price: 2 }],
  };
  it('thermal receipt: 80 mm wide, totals and plain text', async () => {
    const r = await call<Out>(receipt, demo, ctx);
    expect([r.total, r.change]).toEqual([8.352, 1.648]);
    expect(r.text.split('\n')).toContain('TOTAL' + ' '.repeat(19) + '8.352 JD');
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBe(1);
    expect(info.sizes[0][0]).toBeCloseTo(80 * MM, 0);
    for (const t of ['Zaytoun Corner Café', 'RECEIPT', 'R-1043', '29/10/2026', 'Cappuccino', '4.500 JD', 'Discount 10%', '-0.800 JD', 'Tax 16%', '1.152 JD', '8.352 JD', 'Change', '1.648 JD', 'Thank you!']) {
      expect(info.text).toContain(t);
    }
  });
  it('A5 page', async () => {
    const r = await call<Out>(receipt, { ...demo, format: 'a5', pay: 'card', paid: 0 }, ctx);
    const info = await pdfInfo(r.path);
    expect(info.sizes[0]).toEqual([Math.round(148 * MM * 10) / 10, Math.round(210 * MM * 10) / 10]);
    expect(info.text).toContain('Card');
    expect(info.text).not.toContain('Change');
  });
});

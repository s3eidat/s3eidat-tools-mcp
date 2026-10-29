import { describe, expect, it } from 'vitest';
import zakatTool, { zakat, type ZakatIn } from '../../../src/tools/web/calc/zakat-calc.js';
import { num } from '../../../src/tools/web/calc/_common.js';
import { fails, run } from './_run.js';

describe('calc_zakat (zakat-calc self-test)', () => {
  const Z = (x: Partial<ZakatIn>) => zakat({ cash: 0, bank: 0, inv: 0, trade: 0, recv: 0, debt: 0, goldG: 0, karat: 24, goldP: 0, silverG: 0, silverP: 0, basis: 'gold', ...x });
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  it('matches the website known answers', () => {
    const a = Z({ cash: 5000, bank: 10000, goldG: 100, karat: 21, goldP: 60, debt: 2000 });
    const b = Z({ cash: 4000, goldP: 60 }), c = Z({ cash: 4000, silverP: 0.8, basis: 'silver' }), d = Z({ cash: 5100, goldP: 60 }), e = Z({ cash: 1000, debt: 5000, goldP: 60 });
    expect(near(a.pureGold, 87.5) && near(a.goldV, 5250) && near(a.net, 18250) && near(a.nisab, 5100) && a.due && near(a.zakat, 456.25)).toBe(true);
    expect(!b.due && b.zakat === 0).toBe(true);
    expect(near(c.nisab, 476) && c.due && near(c.zakat, 100)).toBe(true);
    expect(d.due && near(d.zakat, 127.5)).toBe(true);
    expect(e.net === 0 && !e.due).toBe(true);
    expect(Z({ cash: 9999 }).due).toBe(false);
    expect(num('١٬٥٠٠')).toBe(1500);
  });
  it('runs as a tool', async () => {
    const r = await run(zakatTool, { cash: 5000, bank: '10,000', goldGrams: 100, goldKarat: 21, goldPricePerGram: 60, debts: 2000, currency: 'JOD' });
    expect(r).toMatchObject({ pureGoldGrams: 87.5, goldValue: 5250, netWealth: 18250, nisab: 5100, due: true, zakat: 456.25 });
    expect(r.summary).toContain('Zakat due (2.5%): 456.25 JOD');
    const s = await run(zakatTool, { cash: 400, silverPricePerGram: 0.8, nisabBasis: 'silver' });
    expect(s).toMatchObject({ nisab: 476, due: false, shortOfNisab: 76 });
    const n = await run(zakatTool, { cash: 400 });
    expect(n.nisab).toBeNull();
    expect(n.message).toMatch(/gold price/);
    await fails(zakatTool, { cash: -5 }, /check cash/);
  });
});

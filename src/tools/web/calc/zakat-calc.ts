import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, need, optNumLike, round } from './_common.js';

// Ported from https://github.com/s3eidat/zakat-calc (app.js): nisab 85 g pure gold or 595 g silver, zakat 2.5 %.
export const GOLD_NISAB = 85, SILVER_NISAB = 595, RATE = 0.025;

export interface ZakatIn {
  cash: number; bank: number; inv: number; trade: number; recv: number; debt: number;
  goldG: number; karat: number; goldP: number; silverG: number; silverP: number; basis: 'gold' | 'silver';
}
export function zakat(o: ZakatIn) {
  const pureGold = (o.goldG * o.karat) / 24, goldV = pureGold * o.goldP, silverV = o.silverG * o.silverP;
  const assets = o.cash + o.bank + o.inv + o.trade + o.recv + goldV + silverV, net = Math.max(0, assets - o.debt);
  const nisab = o.basis === 'silver' ? SILVER_NISAB * o.silverP : GOLD_NISAB * o.goldP;
  const due = nisab > 0 && net >= nisab;
  return { pureGold, goldV, silverV, assets, net, nisab, due, zakat: due ? net * RATE : 0 };
}

export default defineTool({
  name: 'calc_zakat',
  title: 'Zakat calculator',
  webSlug: 'zakat-calc',
  description:
    'Zakat on wealth: 2.5 % of net zakatable wealth (cash, bank, investments, trade goods, money owed to you, gold and silver, ' +
    'minus debts due now) when it reaches the nisab: the value of 85 g of pure gold (default) or 595 g of silver. Gold weight ' +
    'is converted to pure gold by karat (24/22/21/18). You give today\'s gold/silver price per gram in your currency: nothing is ' +
    `fetched from the network. An estimate only; consult a scholar. Web version: ${webUrl('zakat-calc')}`,
  inputSchema: z.object({
    cash: optNumLike('Cash in hand.'),
    bank: optNumLike('Bank balances.'),
    investments: optNumLike('Shares, funds and other investments.'),
    tradeGoods: optNumLike('Value of goods held for sale.'),
    receivables: optNumLike('Money owed to you that you expect back.'),
    debts: optNumLike('Debts you must pay now (deducted).'),
    goldGrams: optNumLike('Gold you own, in grams.'),
    goldKarat: z.union([z.literal(24), z.literal(22), z.literal(21), z.literal(18)]).optional().default(21).describe('Karat of that gold (default 21).'),
    goldPricePerGram: optNumLike('Price of 1 g of pure (24k) gold. Needed for the gold nisab and to value gold.'),
    silverGrams: optNumLike('Silver you own, in grams.'),
    silverPricePerGram: optNumLike('Price of 1 g of silver. Needed for the silver nisab and to value silver.'),
    nisabBasis: z.enum(['gold', 'silver']).optional().default('gold').describe('Which metal sets the nisab.'),
    currency: z.string().max(8).optional().describe('Currency label for the summary (e.g. JOD).'),
  }),
  outputSchema: z.object({
    pureGoldGrams: z.number(), goldValue: z.number(), silverValue: z.number(), totalAssets: z.number(), netWealth: z.number(),
    nisabBasis: z.enum(['gold', 'silver']), nisab: z.number().nullable(), due: z.boolean(), zakat: z.number(), shortOfNisab: z.number().optional(),
    message: z.string(), summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { cash: 5000, bank: 10000, goldGrams: 100, goldKarat: 21, goldPricePerGram: 60, debts: 2000 }, note: 'net 18250, nisab 5100, zakat 456.25' }],
  run(input) {
    const o: ZakatIn = {
      cash: need(input.cash, 'cash', 0), bank: need(input.bank, 'bank', 0), inv: need(input.investments, 'investments', 0),
      trade: need(input.tradeGoods, 'tradeGoods', 0), recv: need(input.receivables, 'receivables', 0), debt: need(input.debts, 'debts', 0),
      goldG: need(input.goldGrams, 'goldGrams', 0), karat: input.goldKarat, goldP: need(input.goldPricePerGram, 'goldPricePerGram', 0),
      silverG: need(input.silverGrams, 'silverGrams', 0), silverP: need(input.silverPricePerGram, 'silverPricePerGram', 0), basis: input.nisabBasis,
    };
    const bad = Object.entries(o).filter(([k, v]) => k !== 'basis' && !((v as number) >= 0)).map(([k]) => k);
    if (bad.length) throw new ToolError('Use plain positive numbers (0 or more): check ' + bad.join(', ') + '.');
    const r = zakat(o), metal = o.basis, cur = input.currency?.trim();
    const m = (v: number) => { const s = round(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return cur ? s + ' ' + cur : s; };
    let message: string;
    if (!r.nisab) message = "Enter today's " + metal + ' price per gram: the nisab is the value of ' + (metal === 'gold' ? '85 g of pure gold' : '595 g of silver') + '.';
    else if (r.due) message = m(r.zakat) + ' is due: 2.5% of ' + m(r.net) + ', above the nisab of ' + m(r.nisab) + '.';
    else message = r.net ? 'No zakat due: net wealth ' + m(r.net) + ' is below the nisab of ' + m(r.nisab) + ' (' + m(r.nisab - r.net) + ' short).' : 'No zakat due: nothing zakatable entered.';
    if (o.goldG && !o.goldP) message += ' Gold is not valued without a gold price.';
    if (o.silverG && !o.silverP) message += ' Silver is not valued without a silver price.';
    const out: Record<string, unknown> = {
      pureGoldGrams: round(r.pureGold), goldValue: round(r.goldV), silverValue: round(r.silverV), totalAssets: round(r.assets), netWealth: round(r.net),
      nisabBasis: metal, nisab: r.nisab ? round(r.nisab) : null, due: r.due, zakat: round(r.zakat), message,
      summary: r.nisab ? 'Zakat calculation\nNet zakatable wealth: ' + m(r.net) + '\nNisab (' + metal + '): ' + m(r.nisab) + '\n' +
        (r.due ? 'Zakat due (2.5%): ' + m(r.zakat) : 'Below the nisab: no zakat due') + '\n(Estimate only; consult a scholar.)' : message,
    };
    if (r.nisab && !r.due) out.shortOfNisab = round(r.nisab - r.net);
    return out;
  },
});

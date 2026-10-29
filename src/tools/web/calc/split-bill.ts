import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, num } from './_common.js';

// Ported from https://github.com/s3eidat/split-bill (app.js): integer cents; remainders go out by largest remainder.
export const cents = (v: unknown) => { const n = num(v); return n > 0 ? Math.round(n * 100) : 0; };

/** Split `total` cents in proportion to `weights`; the result always sums to `total` exactly. */
export function allocate(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const parts = weights.map((w, i) => { const exact = (total * w) / sum; return { i, v: Math.floor(exact), r: exact - Math.floor(exact) }; });
  const left = total - parts.reduce((a, p) => a + p.v, 0);
  parts.slice().sort((a, b) => b.r - a.r || a.i - b.i).slice(0, left).forEach((p) => { p.v++; });
  return parts.map((p) => p.v);
}
const roundUp = (c: number, step: number) => (step ? Math.ceil(c / step) * step : c);

export interface BillIn { subs: number[]; taxPct: number; tipPct: number; tipOnTax: boolean; step: number; even?: boolean }
export function compute(o: BillIn) {
  const sub = o.subs.reduce((a, b) => a + b, 0);
  const tax = Math.round((sub * o.taxPct) / 100);
  const tip = Math.round(((o.tipOnTax ? sub + tax : sub) * o.tipPct) / 100);
  const taxes = allocate(tax, o.subs), tips = allocate(tip, o.subs);
  const shares = o.even ? allocate(sub + tax + tip, o.subs.map(() => 1)) : o.subs.map((s, i) => s + taxes[i] + tips[i]);
  const pays = shares.map((s) => roundUp(s, o.step));
  const collected = pays.reduce((a, b) => a + b, 0);
  return { sub, tax, tip, total: sub + tax + tip, taxes, tips, shares, pays, collected };
}
/** Item subtotals per person: each item split evenly between the people who shared it (none chosen = everyone). */
export function itemSubs(people: { id: number | string }[], items: { price: unknown; who: (number | string)[] }[]) {
  const subs = people.map(() => 0);
  items.forEach((it) => {
    const c = cents(it.price);
    let idx = people.map((p, i) => (it.who.indexOf(p.id) >= 0 ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) idx = people.map((_, i) => i);
    allocate(c, idx.map(() => 1)).forEach((v, k) => { subs[idx[k]] += v; });
  });
  return subs;
}

export default defineTool({
  name: 'calc_split_bill',
  title: 'Split a bill',
  webSlug: 'split-bill',
  description:
    'Split a restaurant bill with tax/service and tip, in whole cents so the shares always add up exactly (left-over cents go ' +
    'to the largest remainders). simple: one bill split evenly between N people (1–100). items: list who had what; each item ' +
    'is split between the people who shared it (nobody listed = everyone), and tax and tip are shared in proportion. Tip can ' +
    'be on the subtotal or on subtotal + tax; each share can be rounded up to a step (e.g. 0.5 or 1). Returns a ready-to-send ' +
    `summary. Web version: ${webUrl('split-bill')}`,
  inputSchema: z.object({
    mode: z.enum(['simple', 'items']).optional().default('simple').describe('Even split, or itemised.'),
    bill: z.union([z.number(), z.string()]).optional().describe('simple: the bill subtotal (before tax and tip).'),
    people: z.union([z.number().int().min(1).max(100), z.array(z.string().max(24)).min(1).max(30)]).optional()
      .describe('simple: how many people (default 2). items: the names, e.g. ["Sara", "Omar", "Lina"].'),
    items: z.array(z.object({
      name: z.string().max(60).optional().describe('Item name.'),
      price: z.union([z.number(), z.string()]).describe('Item price.'),
      sharedBy: z.array(z.string()).optional().describe('Names who shared it (omit or [] = everyone).'),
    })).max(200).optional().describe('items: what was ordered.'),
    taxPercent: z.number().min(0).optional().default(0).describe('Tax / service charge percent.'),
    tipPercent: z.number().min(0).optional().default(10).describe('Tip percent (default 10).'),
    tipOnTax: z.boolean().optional().default(false).describe('Calculate the tip on subtotal + tax.'),
    roundUpTo: z.number().min(0).optional().default(0).describe('Round each share up to a multiple of this (e.g. 0.5, 1, 5). 0 = exact.'),
    currency: z.string().max(6).optional().describe('Currency, e.g. "JOD" (written after) or "$" (written before).'),
  }),
  outputSchema: z.object({
    subtotal: z.number(), tax: z.number(), tip: z.number(), total: z.number(), collected: z.number(), roundingExtra: z.number(),
    shares: z.array(z.object({ name: z.string(), items: z.number().optional(), taxAndTip: z.number().optional(), pays: z.number() })),
    unknownNames: z.array(z.string()).optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { bill: 100, people: 3, tipPercent: 10 }, note: '110.00 total: 36.67, 36.67, 36.66' }],
  run(input) {
    const simple = input.mode === 'simple', step = Math.round(input.roundUpTo * 100);
    let names: string[], subs: number[];
    const unknown = new Set<string>();
    if (simple) {
      const n = typeof input.people === 'number' ? input.people : Array.isArray(input.people) ? input.people.length : 2;
      if (!(cents(input.bill) > 0)) throw new ToolError('Enter the bill amount (above 0).');
      subs = allocate(cents(input.bill), Array(n).fill(1));
      names = Array.isArray(input.people) ? input.people.map((p, i) => p.trim() || 'Person ' + (i + 1)) : subs.map((_, i) => 'Person ' + (i + 1));
    } else {
      if (!Array.isArray(input.people)) throw new ToolError('items mode: give "people" as a list of names.');
      if (!input.items?.length) throw new ToolError('items mode: add items with prices.');
      names = input.people.map((p, i) => p.trim() || 'Person ' + (i + 1));
      const ids = names.map((nm) => nm.toLowerCase());
      subs = itemSubs(ids.map((id) => ({ id })), input.items.map((it) => ({
        price: it.price,
        who: (it.sharedBy ?? []).map((s) => { const k = s.trim().toLowerCase(); if (ids.indexOf(k) < 0) unknown.add(s); return k; }),
      })));
      if (unknown.size) throw new ToolError('Unknown name(s) in sharedBy: ' + [...unknown].join(', ') + '. Use names from "people".');
    }
    const r = compute({ subs, taxPct: input.taxPercent, tipPct: input.tipPercent, tipOnTax: input.tipOnTax, step, even: simple });
    if (!r.sub) throw new ToolError('Add items with prices.');
    const cur = (input.currency || '').trim();
    const money = (c: number) => { const s = (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return cur ? (/^[A-Za-z]{2,}$/.test(cur) ? s + ' ' + cur : cur + s) : s; };
    const n = names.length, lines = ['🧾 *Bill split*' + (simple ? ' — ' + n + (n === 1 ? ' person' : ' people') : '')];
    lines.push('Subtotal: ' + money(r.sub));
    if (r.tax) lines.push('Tax/service ' + input.taxPercent + '%: ' + money(r.tax));
    if (r.tip) lines.push('Tip ' + input.tipPercent + '%: ' + money(r.tip));
    lines.push('Total: *' + money(r.total) + '*', '');
    if (simple) {
      const counts: Record<number, number> = {};
      r.pays.forEach((p) => { counts[p] = (counts[p] || 0) + 1; });
      const keys = Object.keys(counts).map(Number).sort((a, b) => b - a);
      lines.push(keys.length === 1 ? 'Each pays: *' + money(keys[0]) + '*' : keys.map((k) => counts[k] + ' × *' + money(k) + '*').join(' + '));
    } else names.forEach((nm, i) => lines.push('• ' + nm + ': *' + money(r.pays[i]) + '*'));
    const extra = r.collected - r.total;
    if (extra > 0) lines.push('', '(Rounded up: ' + money(extra) + ' extra, add it to the tip)');
    const c = (x: number) => x / 100;
    return {
      subtotal: c(r.sub), tax: c(r.tax), tip: c(r.tip), total: c(r.total), collected: c(r.collected), roundingExtra: c(extra),
      shares: names.map((nm, i) => ({ name: nm, ...(simple ? {} : { items: c(subs[i]), taxAndTip: c(r.taxes[i] + r.tips[i]) }), pays: c(r.pays[i]) })),
      summary: lines.join('\n'),
    };
  },
});

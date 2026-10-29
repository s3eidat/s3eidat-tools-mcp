import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';
import { CURRENCIES, type Currency } from './_currencies.js';

// Ported from https://github.com/s3eidat/cash-counter (app.js): money kept as whole minor units (fils, cents).
export const MAX_QTY = 9999999;
const toAscii = (s: unknown) => String(s == null ? '' : s).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
  .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0)).replace(/\u066b/g, '.').replace(/[\u066c,\s_']/g, '');

/** "151.35" with 3 decimals → 151350 (integer). null if not a plain amount or too many decimals. */
export function parseMoney(s: unknown, dec: number): number | null {
  let t = toAscii(s), neg = false;
  if (/^-/.test(t)) { neg = true; t = t.slice(1); }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (!m[1] && !m[2]) || (m[2] || '').length > dec || (m[1] || '').length > 12) return null;
  const v = parseInt(m[1] || '0', 10) * Math.pow(10, dec) + parseInt(((m[2] || '') + '000').slice(0, dec) || '0', 10);
  return neg ? -v : v;
}
export function parseQty(s: unknown) { const t = toAscii(s); return /^\d{1,7}$/.test(t) ? Math.min(MAX_QTY, parseInt(t, 10)) : t === '' ? 0 : null; }
export function fmt(minor: number, dec: number) {
  const neg = minor < 0, a = Math.abs(minor), p = Math.pow(10, dec), whole = Math.floor(a / p), frac = a - whole * p;
  const s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + String(frac).padStart(dec, '0') : '');
  return (neg ? '−' : '') + s;
}
export interface Denom { key: string; v: number; en: string; ar: string; coin: boolean }
export function sum(denoms: Denom[], qty: Record<string, number>) {
  let total = 0, notes = 0, coins = 0;
  denoms.forEach((d) => { const q = qty[d.key] || 0; total += q * d.v; if (d.coin) coins += q; else notes += q; });
  return { total, notes, coins };
}
export function listFor(cur: Currency): Denom[] {
  return cur.n.map((d) => ({ key: 'n' + d[0], v: d[0], en: d[1], ar: d[2] || '', coin: false }))
    .concat(cur.c.map((d) => ({ key: 'c' + d[0], v: d[0], en: d[1], ar: d[2] || '', coin: true })));
}
/** A custom currency from comma-separated note and coin values (deduplicated, sorted, at most 20 each). */
export function customCur(c: { name?: string; dec?: number; notes?: string; coins?: string }): Currency {
  const dec = [0, 2, 3].indexOf(Number(c.dec)) >= 0 ? Number(c.dec) : 2;
  const list = (s: string | undefined, coin: boolean): [number, string][] => {
    const seen: Record<number, number> = {};
    return String(s || '').split(/[,\u060c;\s]+/).map((x) => parseMoney(x, dec))
      .filter((v): v is number => { if (!(v !== null && v > 0) || seen[v]) return false; seen[v] = 1; return true; })
      .sort((a, b) => b - a).slice(0, 20).map((v) => [v, fmt(v, dec) + (coin ? ' coin' : '')]);
  };
  return { name: c.name || 'Custom', ar: '', sym: (c.name || '').slice(0, 8), dec, n: list(c.notes, false), c: list(c.coins, true) };
}

const listText = (v: string | number[] | undefined) => (Array.isArray(v) ? v.join(', ') : v);

export default defineTool({
  name: 'calc_cash_count',
  title: 'Cash counter',
  webSlug: 'cash-counter',
  description:
    'Count a cash drawer by denomination with exact integer maths (no float errors): JOD (3 decimals, fils), USD, EUR, SAR, ' +
    'AED, GBP, KWD, EGP, or a custom currency (your own note and coin values, 0/2/3 decimals). Give how many of each note/coin ' +
    '(by value like 50 or 0.25, by label like "50 JD" or "¼ dinar"); returns per-denomination amounts, the total, notes and ' +
    'coins counted, and over/short against an expected amount. list=true shows the denominations of a currency. ' +
    `Web version: ${webUrl('cash-counter')}`,
  inputSchema: z.object({
    currency: z.enum(['JOD', 'USD', 'EUR', 'SAR', 'AED', 'GBP', 'KWD', 'EGP', 'CUSTOM']).optional().default('JOD').describe('Currency preset, or CUSTOM.'),
    custom: z.object({
      name: z.string().max(30).optional().describe('Currency name/symbol.'),
      decimals: z.union([z.literal(0), z.literal(2), z.literal(3)]).optional().default(2).describe('Decimal places.'),
      notes: z.union([z.string(), z.array(z.number())]).optional().describe('Note values, e.g. "100, 50, 20" or [100, 50, 20].'),
      coins: z.union([z.string(), z.array(z.number())]).optional().describe('Coin values, e.g. "1, 0.5, 0.25".'),
    }).optional().describe('CUSTOM currency definition.'),
    counts: z.array(z.object({
      denomination: z.union([z.number(), z.string()]).describe('Value in major units (50, 0.5) or the label ("50 JD", "1 SAR coin").'),
      count: z.union([z.number().int().min(0).max(MAX_QTY), z.string()]).describe('How many.'),
      kind: z.enum(['note', 'coin']).optional().describe('Only needed when a value exists as both a note and a coin (e.g. 1 SAR).'),
    })).max(100).optional().default([]).describe('What you counted.'),
    expected: z.union([z.number(), z.string()]).optional().describe('Expected total, to show over/short.'),
    note: z.string().max(500).optional().describe('Optional note for the summary (e.g. "Evening shift").'),
    list: z.boolean().optional().default(false).describe('Just list the denominations.'),
  }),
  outputSchema: z.object({
    currency: z.string(), name: z.string(), symbol: z.string(), decimals: z.number(),
    denominations: z.array(z.object({ key: z.string(), label: z.string(), labelArabic: z.string().optional(), kind: z.enum(['note', 'coin']), value: z.string(), count: z.number(), amount: z.string() })),
    total: z.string(), totalMinorUnits: z.number(), notes: z.number(), coins: z.number(),
    expected: z.object({ amount: z.string(), status: z.enum(['exact', 'over', 'short']), difference: z.string() }).optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { currency: 'JOD', counts: [{ denomination: 50, count: 3 }, { denomination: 0.5, count: 2 }, { denomination: 0.05, count: 7 }], expected: '151.400' },
    note: 'total 151.350 JD, short by 0.050' }],
  run(input) {
    const code = input.currency;
    if (code === 'CUSTOM' && !input.custom) throw new ToolError('Give "custom" with notes and/or coins for a CUSTOM currency.');
    const cur = code === 'CUSTOM' ? customCur({ name: input.custom!.name, dec: input.custom!.decimals, notes: listText(input.custom!.notes), coins: listText(input.custom!.coins) }) : CURRENCIES[code];
    const ds = listFor(cur), q: Record<string, number> = {};
    if (!ds.length) throw new ToolError('Add note or coin values for your currency.');
    if (!input.list) {
      for (const c of input.counts) {
        const n = parseQty(c.count);
        if (n === null) throw new ToolError(`Count for ${c.denomination} must be a whole number (0–${MAX_QTY}).`);
        const label = String(c.denomination).trim().toLowerCase();
        let hits = ds.filter((d) => d.en.toLowerCase() === label || d.key === label || (d.ar && d.ar === String(c.denomination).trim()));
        if (!hits.length) { const v = parseMoney(c.denomination, cur.dec); hits = v === null ? [] : ds.filter((d) => d.v === v); }
        if (c.kind) hits = hits.filter((d) => d.coin === (c.kind === 'coin'));
        if (!hits.length) throw new ToolError(`No ${c.kind ?? 'note or coin'} "${c.denomination}" in ${cur.name}. Denominations: ${ds.map((d) => d.en).join(', ')}.`);
        if (hits.length > 1) throw new ToolError(`"${c.denomination}" is both a note and a coin in ${cur.name}: set kind to "note" or "coin".`);
        q[hits[0].key] = Math.min(MAX_QTY, (q[hits[0].key] || 0) + n);
      }
    }
    const s = sum(ds, q), dec = cur.dec;
    const out: Record<string, unknown> = {
      currency: code, name: cur.name, symbol: cur.sym, decimals: dec,
      denominations: ds.map((d) => ({ key: d.key, label: d.en, ...(d.ar ? { labelArabic: d.ar } : {}), kind: d.coin ? 'coin' : 'note', value: fmt(d.v, dec), count: q[d.key] || 0, amount: fmt((q[d.key] || 0) * d.v, dec) })),
      total: fmt(s.total, dec), totalMinorUnits: s.total, notes: s.notes, coins: s.coins,
    };
    const lines = ['Cash count · ' + cur.name + (code !== 'CUSTOM' ? ' (' + code + ')' : ''), ''];
    ds.forEach((d) => { const n = q[d.key] || 0; if (n) lines.push(d.en + ' × ' + n + ' = ' + fmt(n * d.v, dec)); });
    lines.push('', 'Total: ' + fmt(s.total, dec) + ' ' + cur.sym + ' (' + s.notes + ' notes, ' + s.coins + ' coins)');
    if (input.expected !== undefined && String(input.expected).trim()) {
      const e = parseMoney(input.expected, dec);
      if (e === null) throw new ToolError('Use a plain expected amount with up to ' + dec + ' decimals.');
      const d = s.total - e;
      out.expected = { amount: fmt(e, dec), status: d === 0 ? 'exact' : d > 0 ? 'over' : 'short', difference: fmt(Math.abs(d), dec) };
      lines.push('Expected: ' + fmt(e, dec) + ' ' + cur.sym + ' · ' + (d === 0 ? 'exact' : (d > 0 ? 'over by ' : 'short by ') + fmt(Math.abs(d), dec)));
    }
    if (input.note?.trim()) lines.push('', 'Notes: ' + input.note.trim());
    out.summary = lines.join('\n');
    return out;
  },
});

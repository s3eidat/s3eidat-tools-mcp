import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { makeRandInt, seedSchema, type RandInt } from './_random.js';

// Ported from https://github.com/s3eidat/dice-roller (app.js): same notation parser, limits, keep/drop rules,
// coin streak stats and number sampling, all driven by fair (rejection-sampled) random integers.
export const LIM = { dice: 100, sides: 1000, terms: 20, constant: 100000 };

export interface Term { sign: number; constant?: number; n?: number; sides?: number; op?: string | null; k?: number }
export type Parsed = { terms: Term[]; error?: undefined } | { error: string; terms?: undefined };

export function parse(src: string): Parsed {
  let s = String(src || '').toLowerCase()
    .replace(/\s*drop\s*lowest/g, 'dl').replace(/\s*drop\s*highest/g, 'dh').replace(/\s*keep\s*highest/g, 'kh').replace(/\s*keep\s*lowest/g, 'kl')
    .replace(/\s*([+-])\s*/g, '$1').trim();
  if (!s) return { error: 'Type some dice notation, e.g. 2d6+3' };
  if (/\s/.test(s)) return { error: 'Join terms with + or −, e.g. 2d6+3' };
  const re = /^([+-]?)(?:(\d*)d(\d+|%)(?:(dl|dh|kh|kl|k)(\d*))?|(\d+))/;
  const terms: Term[] = [];
  let first = true;
  while (s.length) {
    const m = re.exec(s);
    if (!m || (!first && !m[1])) return { error: 'Can\'t read “' + s.slice(0, 12) + '”. Try 2d6+3 or 4d6dl1.' };
    first = false;
    s = s.slice(m[0].length);
    const sign = m[1] === '-' ? -1 : 1;
    if (m[6] !== undefined) {
      const c = +m[6];
      if (c > LIM.constant) return { error: 'Numbers up to ' + LIM.constant + ' only.' };
      terms.push({ sign, constant: c });
    } else {
      const n = m[2] === '' ? 1 : +m[2], sides = m[3] === '%' ? 100 : +m[3], op = m[4] === 'k' ? 'kh' : m[4];
      const k = m[5] === '' || m[5] === undefined ? 1 : +m[5];
      if (n < 1 || n > LIM.dice) return { error: 'Use 1 to ' + LIM.dice + ' dice per term.' };
      if (sides < 2 || sides > LIM.sides) return { error: 'Dice need 2 to ' + LIM.sides + ' sides.' };
      if (op && (op[0] === 'd' ? k >= n : k > n || k < 1)) {
        return { error: op[0] === 'd' ? "You can't drop " + k + ' of ' + n + ' dice.' : "You can't keep " + k + ' of ' + n + ' dice.' };
      }
      terms.push({ sign, n, sides, op: op || null, k: op ? k : 0 });
    }
    if (terms.length > LIM.terms) return { error: 'Up to ' + LIM.terms + ' terms.' };
  }
  return { terms };
}

function label(t: Term) {
  return t.constant !== undefined ? String(t.constant) : (t.n === 1 ? '' : String(t.n)) + 'd' + t.sides + (t.op ? t.op + t.k : '');
}
export function canon(p: { terms: Term[] }) {
  return p.terms.map((t, i) => (t.sign < 0 ? '-' : i ? '+' : '') + label(t)).join('');
}

export interface RollPart { t: Term; rolls?: { v: number; kept: boolean }[]; sub: number }
/** rng(sides) → 0..sides-1 */
export function roll(p: { terms: Term[] }, rng: RandInt) {
  let total = 0;
  const parts: RollPart[] = p.terms.map((t) => {
    if (t.constant !== undefined) {
      total += t.sign * t.constant;
      return { t, sub: t.constant };
    }
    const rolls: { v: number; kept: boolean }[] = [];
    for (let i = 0; i < t.n!; i++) rolls.push({ v: rng(t.sides!) + 1, kept: true });
    if (t.op) {
      const order = rolls.map((_, i) => i).sort((a, b) => rolls[a].v - rolls[b].v || a - b);
      const k = t.k!;
      const drop = t.op === 'dl' ? order.slice(0, k) : t.op === 'dh' ? order.slice(order.length - k) : t.op === 'kh' ? order.slice(0, order.length - k) : order.slice(k);
      drop.forEach((i) => { rolls[i].kept = false; });
    }
    const sub = rolls.reduce((a, r) => a + (r.kept ? r.v : 0), 0);
    total += t.sign * sub;
    return { t, rolls, sub };
  });
  return { total, parts };
}

export function describe(r: { total: number; parts: RollPart[] }) {
  return r.parts.map((p, i) => {
    const s = p.t.sign < 0 ? '− ' : i ? '+ ' : '';
    if (!p.rolls) return s + p.sub;
    return s + label(p.t) + ' [' + p.rolls.map((x) => (x.kept ? x.v : '~' + x.v + '~')).join(', ') + ']';
  }).join(' ') + ' = ' + r.total;
}

export interface CoinState { h: number; t: number; streak: number; side: 'h' | 't' | null; best: number; bestSide?: 'h' | 't' | null; seq: string[] }
export function coinStep(st: CoinState, heads: boolean) {
  const s = heads ? 'h' : 't';
  st[s]++;
  st.streak = st.side === s ? st.streak + 1 : 1;
  st.side = s;
  if (st.streak > st.best) { st.best = st.streak; st.bestSide = s; }
  st.seq = [s].concat(st.seq).slice(0, 24);
  return st;
}

/** Distinct sample of k values from 0..n-1: partial Fisher-Yates for small ranges, rejection with a Set otherwise. */
export function sampleUnique(n: number, k: number, rng: RandInt) {
  if (n <= 200000) {
    const a: number[] = [];
    for (let i = 0; i < n; i++) a.push(i);
    for (let j = 0; j < k; j++) { const r = j + rng(n - j), t = a[j]; a[j] = a[r]; a[r] = t; }
    return a.slice(0, k);
  }
  const seen = new Set<number>(), out: number[] = [];
  while (out.length < k) { const v = rng(n); if (!seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}
export function genNumbers(min: number, max: number, k: number, unique: boolean, rng: RandInt): { nums: number[]; error?: undefined } | { error: string; nums?: undefined } {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return { error: 'Min and max must be whole numbers.' };
  if (Math.abs(min) > 1e9 || Math.abs(max) > 1e9) return { error: 'Keep min and max between −1,000,000,000 and 1,000,000,000.' };
  if (min > max) { const s = min; min = max; max = s; }
  const n = max - min + 1;
  if (!Number.isInteger(k) || k < 1 || k > 10000) return { error: 'How many: 1 to 10,000.' };
  if (unique && k > n) return { error: 'Only ' + n + ' different numbers exist between ' + min + ' and ' + max + '.' };
  const vals = unique ? sampleUnique(n, k, rng) : Array.from({ length: k }, () => rng(n));
  return { nums: vals.map((v) => v + min) };
}

const rollShape = z.object({
  total: z.number(),
  breakdown: z.string().describe('e.g. "4d6dl1 [3, (1 dropped), 4, 6] = 13".'),
  terms: z.array(z.object({
    term: z.string(), sign: z.number(), subtotal: z.number(),
    rolls: z.array(z.object({ value: z.number(), kept: z.boolean() })).optional(),
  })),
});

export default defineTool({
  name: 'random_dice',
  title: 'Dice roller, coin flip, random numbers',
  webSlug: 'dice-roller',
  description:
    'Roll dice with standard notation (2d6+3, d20, d%, 4d6dl1 / "4d6 drop lowest", 2d20kh1 advantage, 2d20kl1, 5d10dh2; ' +
    'up to 100 dice per term, 2–1000 sides, 20 terms), flip coins (counts + streaks), or draw random whole numbers in a ' +
    'range (optionally unique and sorted, up to 10,000). Crypto random with rejection sampling (no modulo bias); optional ' +
    `seed for reproducible results. Web version: ${webUrl('dice-roller')}`,
  inputSchema: z.object({
    mode: z.enum(['dice', 'coin', 'numbers']).optional().default('dice').describe('What to do.'),
    notation: z.string().max(200).optional().default('2d6').describe('dice: the dice notation, e.g. "3d8+2d6+4".'),
    rolls: z.number().int().min(1).max(100).optional().default(1).describe('dice: how many times to roll the expression.'),
    flips: z.number().int().min(1).max(10000).optional().default(1).describe('coin: how many coins to flip.'),
    min: z.number().int().optional().default(1).describe('numbers: smallest value (inclusive).'),
    max: z.number().int().optional().default(100).describe('numbers: largest value (inclusive).'),
    count: z.number().int().min(1).max(10000).optional().default(1).describe('numbers: how many numbers.'),
    unique: z.boolean().optional().default(false).describe('numbers: no repeats.'),
    sort: z.boolean().optional().default(false).describe('numbers: sort ascending.'),
    seed: seedSchema(),
  }),
  outputSchema: z.object({
    mode: z.string(),
    notation: z.string().optional().describe('dice: canonical form of the notation.'),
    results: z.array(rollShape).optional(),
    coins: z.object({
      heads: z.number(), tails: z.number(), sequence: z.string().describe('H/T for every flip in order (first 1000).'),
      longestStreak: z.object({ count: z.number(), side: z.string() }),
      currentStreak: z.object({ count: z.number(), side: z.string() }),
    }).optional(),
    numbers: z.array(z.number()).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  examples: [
    { input: { notation: '4d6 drop lowest' }, note: 'e.g. total 13, breakdown "4d6dl1 [3, (1 dropped), 4, 6] = 13"' },
    { input: { mode: 'coin', flips: 10 } },
    { input: { mode: 'numbers', min: 1, max: 49, count: 6, unique: true, sort: true }, note: 'Lottery-style draw' },
  ],
  run(input) {
    const rng = makeRandInt(input.seed);
    if (input.mode === 'coin') {
      const st: CoinState = { h: 0, t: 0, streak: 0, side: null, best: 0, bestSide: null, seq: [] };
      let seq = '';
      for (let i = 0; i < input.flips; i++) {
        const heads = rng(2) === 0;
        coinStep(st, heads);
        if (i < 1000) seq += heads ? 'H' : 'T';
      }
      const side = (s?: string | null) => (s === 'h' ? 'heads' : 'tails');
      return {
        mode: 'coin',
        coins: {
          heads: st.h, tails: st.t, sequence: seq,
          longestStreak: { count: st.best, side: side(st.bestSide) },
          currentStreak: { count: st.streak, side: side(st.side) },
        },
      };
    }
    if (input.mode === 'numbers') {
      const r = genNumbers(input.min, input.max, input.count, input.unique, rng);
      if (r.error !== undefined) throw new ToolError(r.error);
      return { mode: 'numbers', numbers: input.sort ? r.nums.slice().sort((a, b) => a - b) : r.nums };
    }
    const p = parse(input.notation);
    if (p.error !== undefined) throw new ToolError(p.error);
    const results = [];
    for (let i = 0; i < input.rolls; i++) {
      const r = roll(p, rng);
      results.push({
        total: r.total,
        breakdown: describe(r).replace(/~(\d+)~/g, '($1 dropped)'),
        terms: r.parts.map((part) => ({
          term: label(part.t), sign: part.t.sign, subtotal: part.sub,
          ...(part.rolls ? { rolls: part.rolls.map((x) => ({ value: x.v, kept: x.kept })) } : {}),
        })),
      });
    }
    return { mode: 'dice', notation: canon(p), results };
  },
});

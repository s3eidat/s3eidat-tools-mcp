import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { cryptoU32, uniformFrom } from './_random.js';
import { PF_WORDS } from './_wordlists.js';

// Ported from https://github.com/s3eidat/pass-forge (app.js + words.js): same character sets, look-alike list,
// "every set at least once" rule, exact entropy (inclusion-exclusion with BigInt), passphrase word list and
// options, strength grades and crack-time estimate. Always the OS CSPRNG; there is deliberately no seed.
export const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!#$%&*+-=?@^_~()[]{}<>.,:;/|',
};
export const LOOKALIKE = 'Il1|O0o';
export const WORDS = Array.from(new Set(PF_WORDS));
const GUESS_RATE = 1e11; // offline attack, fast hash, large GPU rig

const randInt = (n: number) => uniformFrom(n, cryptoU32);

export function log2Big(x: bigint) {
  if (x <= 0n) return -Infinity;
  const bits = x.toString(2).length;
  if (bits <= 53) return Math.log2(Number(x));
  return Math.log2(Number(x >> BigInt(bits - 53))) + (bits - 53);
}
/** Number of length-L strings over the pool that contain at least one char from every required set. */
export function countValid(poolSize: number, setSizes: number[], L: number) {
  const k = setSizes.length;
  let total = 0n;
  for (let mask = 0; mask < (1 << k); mask++) {
    let removed = 0, bitsOn = 0;
    for (let i = 0; i < k; i++) if (mask & (1 << i)) { removed += setSizes[i]; bitsOn++; }
    const term = BigInt(poolSize - removed) ** BigInt(L);
    total += bitsOn % 2 ? -term : term;
  }
  return total;
}

export interface PwOptions { length: number; lower?: boolean; upper?: boolean; digits?: boolean; symbols?: boolean; lookalike?: boolean; require?: boolean; exclude?: string }
export function buildSets(o: PwOptions) {
  const ban = (o.lookalike ? LOOKALIKE : '') + (o.exclude || '');
  const sets: { name: string; chars: string }[] = [];
  (['lower', 'upper', 'digits', 'symbols'] as const).forEach((k) => {
    if (!o[k]) return;
    const chars = Array.from(SETS[k]).filter((c) => ban.indexOf(c) < 0).join('');
    if (chars) sets.push({ name: k, chars });
  });
  return sets;
}
export function passwordPlan(o: PwOptions) {
  const sets = buildSets(o), pool = sets.map((s) => s.chars).join('');
  const req = !!o.require && sets.length > 1 && o.length >= sets.length;
  const bits = !pool.length ? 0 : req
    ? log2Big(countValid(pool.length, sets.map((s) => s.chars.length), o.length))
    : o.length * Math.log2(pool.length);
  return { sets, pool: Array.from(pool), require: req, bits };
}
export function makePassword(o: PwOptions, plan = passwordPlan(o), rng = randInt) {
  if (!plan.pool.length) return '';
  for (let tries = 0; tries < 100000; tries++) {
    let out = '';
    for (let i = 0; i < o.length; i++) out += plan.pool[rng(plan.pool.length)];
    if (!plan.require || plan.sets.every((s) => Array.from(out).some((c) => s.chars.indexOf(c) >= 0))) return out;
  }
  throw new ToolError('Could not satisfy the rules');
}
export interface PhraseOptions { words: number; sep?: string; cap?: boolean; addnum?: boolean }
export function phraseBits(o: PhraseOptions) {
  let b = o.words * Math.log2(WORDS.length);
  if (o.addnum) b += Math.log2(100) + Math.log2(o.words);
  return b;
}
export function makePhrase(o: PhraseOptions, rng = randInt) {
  let w: string[] = [];
  for (let i = 0; i < o.words; i++) w.push(WORDS[rng(WORDS.length)]);
  const sep = o.sep ?? '-';
  if (o.cap || sep === '') w = w.map((x) => x.charAt(0).toUpperCase() + x.slice(1));
  if (o.addnum) { const at = rng(w.length); w[at] += rng(100); }
  return w.join(sep);
}
export function fmtTime(sec: number) {
  if (sec < 1) return 'less than a second';
  const units: [string, number][] = [['year', 31557600], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  if (sec >= 31557600 * 1e6) {
    const y = sec / 31557600, big: [string, number][] = [['quintillion', 1e18], ['quadrillion', 1e15], ['trillion', 1e12], ['billion', 1e9], ['million', 1e6]];
    if (y >= 1e21) return 'about 10^' + Math.floor(Math.log10(y)) + ' years';
    for (const [name, v] of big) if (y >= v) return (y / v).toFixed(1).replace(/\.0$/, '') + ' ' + name + ' years';
  }
  for (const [name, v] of units) if (sec >= v) {
    const n = Math.floor(sec / v);
    return n.toLocaleString('en-US') + ' ' + name + (n === 1 ? '' : 's');
  }
  return '';
}
export function grade(bits: number) {
  if (bits < 40) return 'Weak';
  if (bits < 60) return 'Fair';
  if (bits < 80) return 'Strong';
  if (bits < 128) return 'Very strong';
  return 'Overkill (excellent)';
}

export default defineTool({
  name: 'password_generate',
  title: 'Password & passphrase generator',
  webSlug: 'pass-forge',
  description:
    'Generate strong random passwords (8–128 chars; lower/upper/digits/symbols; skip look-alikes Il1|O0o; exclude your ' +
    'own characters; require every chosen set) or passphrases (3–12 words from the website\'s 2,381-word list, separator, ' +
    'capitalise, add a number). Returns 1–1000 results with exact entropy bits, a strength grade and the time to crack at ' +
    '100 billion guesses/s. Always crypto random (OS CSPRNG, rejection sampling); nothing is stored or logged. ' +
    `Web version: ${webUrl('pass-forge')}`,
  inputSchema: z.object({
    mode: z.enum(['password', 'passphrase']).optional().default('password').describe('Random characters or random words.'),
    length: z.number().int().min(8).max(128).optional().default(20).describe('password: number of characters.'),
    lower: z.boolean().optional().default(true).describe('password: include a–z.'),
    upper: z.boolean().optional().default(true).describe('password: include A–Z.'),
    digits: z.boolean().optional().default(true).describe('password: include 0–9.'),
    symbols: z.boolean().optional().default(true).describe('password: include symbols !#$%&*+-=?@^_~()[]{}<>.,:;/|'),
    avoidLookalikes: z.boolean().optional().default(true).describe('password: leave out I l 1 | O 0 o.'),
    requireEachSet: z.boolean().optional().default(true).describe('password: at least one character from every chosen set.'),
    exclude: z.string().max(200).optional().default('').describe('password: characters never to use.'),
    words: z.number().int().min(3).max(12).optional().default(6).describe('passphrase: number of words.'),
    separator: z.enum(['-', ' ', '.', '_', '']).optional().default('-').describe('passphrase: between words ("" = none, words then capitalised).'),
    capitalize: z.boolean().optional().default(false).describe('passphrase: capitalise each word.'),
    addNumber: z.boolean().optional().default(false).describe('passphrase: append a number 0–99 to one random word.'),
    count: z.number().int().min(1).max(1000).optional().default(1).describe('How many to generate.'),
  }),
  outputSchema: z.object({
    passwords: z.array(z.string()),
    bits: z.number().describe('Entropy in bits (exact for the chosen options).'),
    strength: z.string(),
    crackTime: z.string().describe('Average time to guess at 100 billion guesses per second.'),
    poolSize: z.number().optional().describe('password: number of possible characters.'),
    wordListSize: z.number().optional().describe('passphrase: words in the list.'),
    note: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  examples: [
    { input: { length: 20 }, note: '20 chars from 83 possible, ≈127.3 bits, "Very strong"' },
    { input: { mode: 'passphrase', words: 6, separator: '-' }, note: 'e.g. "maple-orbit-velvet-harbor-pencil-river", ≈67.3 bits' },
  ],
  run(input) {
    let bits: number, gen: () => string;
    const extra: Record<string, unknown> = {};
    if (input.mode === 'passphrase') {
      const o = { words: input.words, sep: input.separator, cap: input.capitalize, addnum: input.addNumber };
      bits = phraseBits(o);
      gen = () => makePhrase(o);
      extra.wordListSize = WORDS.length;
    } else {
      const o: PwOptions = {
        length: input.length, lower: input.lower, upper: input.upper, digits: input.digits, symbols: input.symbols,
        lookalike: input.avoidLookalikes, require: input.requireEachSet, exclude: input.exclude,
      };
      const plan = passwordPlan(o);
      if (!plan.pool.length) throw new ToolError('Pick at least one character set (and do not exclude all of its characters).');
      bits = plan.bits;
      gen = () => makePassword(o, plan);
      extra.poolSize = plan.pool.length;
      if (o.require && !plan.require && plan.sets.length > 1 && o.length < plan.sets.length) extra.note = 'Too short to require every set.';
    }
    const passwords = Array.from({ length: input.count }, gen);
    return { passwords, bits: Math.round(bits * 10) / 10, strength: grade(bits), crackTime: fmtTime(Math.pow(2, bits - 1) / GUESS_RATE), ...extra };
  },
});

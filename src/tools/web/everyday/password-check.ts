import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { PC_COMMON, PC_WORDS } from './_wordlists.js';

// Ported from https://github.com/s3eidat/password-check (app.js + data.js): the same zxcvbn-style estimator
// (dictionary / reversed / l33t, sequences, keyboard walks, repeats, years and dates, brute force; cheapest cover
// by dynamic programming), the same scores, crack-time scenarios and advice. Offline: no breach lookups.
const COMMON = new Map<string, number>();
PC_COMMON.forEach((w, i) => { if (!COMMON.has(w)) COMMON.set(w, i + 1); });
const WORDS = new Set(PC_WORDS);
const WORD_GUESSES = 20000;
const MAX_LEN = 256;

function log2fact(n: number) { let s = 0; for (let i = 2; i <= n; i++) s += Math.log2(i); return s; }
function nCk(n: number, k: number) { if (k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }
function log2add(a: number, b: number) { const hi = Math.max(a, b), lo = Math.min(a, b); return hi + Math.log2(1 + Math.pow(2, lo - hi)); }

type CharClass = 'lower' | 'upper' | 'digit' | 'symbol' | 'other';
export function charClass(c: string): CharClass {
  if (/[a-z]/.test(c)) return 'lower';
  if (/[A-Z]/.test(c)) return 'upper';
  if (/[0-9]/.test(c)) return 'digit';
  if (/[\x20-\x7e]/.test(c)) return 'symbol';
  return 'other';
}
const CARD: Record<CharClass, number> = { lower: 26, upper: 26, digit: 10, symbol: 33, other: 100 };
function cardinality(chars: string[]) {
  const seen: Partial<Record<CharClass, 1>> = {};
  let c = 0;
  chars.forEach((ch) => { const k = charClass(ch); if (!seen[k]) { seen[k] = 1; c += CARD[k]; } });
  return c;
}

export interface Match {
  i: number; j: number; type: string; token: string; log2: number;
  rank?: number; caps?: boolean; reversed?: boolean; leet?: string; base?: string; turns?: number;
}

const LEET: Record<string, string[]> = { '4': ['a'], '@': ['a'], '8': ['b'], '(': ['c'], '{': ['c'], '3': ['e'], '6': ['g'], '9': ['g'], '1': ['i', 'l'], '!': ['i'], '|': ['i', 'l'], '0': ['o'], $: ['s'], '5': ['s'], '7': ['t'], '+': ['t'], '2': ['z'], '%': ['x'] };

function upperVariations(token: string) {
  let U = 0, L = 0;
  Array.from(token).forEach((c) => { if (/[A-Z]/.test(c)) U++; else if (/[a-z]/.test(c)) L++; });
  if (!U) return 1;
  if (!L || (U === 1 && (/^[A-Z]/.test(token) || /[A-Z]$/.test(token)))) return 2;
  let v = 0;
  for (let i = 1; i <= Math.min(U, L); i++) v += nCk(U + L, i);
  return v;
}
function leetVariations(token: string, subs: Record<string, string>) {
  let v = 1;
  Object.keys(subs).forEach((leetChar) => {
    let S = 0, U = 0;
    const plain = subs[leetChar];
    Array.from(token.toLowerCase()).forEach((c) => { if (c === leetChar) S++; else if (c === plain) U++; });
    let p = 1;
    if (U) { p = 0; for (let i = 1; i <= Math.min(S, U); i++) p += nCk(S + U, i); }
    v *= Math.max(2, p);
  });
  return v;
}
/** All plain-letter readings of a l33t token (capped at 64 so pathological input can't explode). */
function unleet(lower: string) {
  let outs: { s: string; subs: Record<string, string> }[] = [{ s: '', subs: {} }];
  for (let k = 0; k < lower.length; k++) {
    const c = lower[k], opts = LEET[c], next: typeof outs = [];
    outs.forEach((o) => {
      next.push({ s: o.s + c, subs: o.subs });
      if (opts) opts.forEach((p) => { const s2 = Object.assign({}, o.subs); s2[c] = p; next.push({ s: o.s + p, subs: s2 }); });
    });
    outs = next.slice(0, 64);
  }
  return outs.filter((o) => Object.keys(o.subs).length);
}
function dictLookup(lower: string) {
  if (COMMON.has(lower)) return { rank: COMMON.get(lower)!, kind: 'common' };
  if (WORDS.has(lower)) return { rank: WORD_GUESSES, kind: 'word' };
  return null;
}
function dictionaryMatches(chars: string[]) {
  const out: Match[] = [], n = chars.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < Math.min(n, i + 24); j++) {
    const token = chars.slice(i, j + 1).join(''), lower = token.toLowerCase();
    const hit = dictLookup(lower), uv = upperVariations(token);
    if (hit) out.push({ i, j, type: hit.kind, token, log2: Math.log2(hit.rank * uv), rank: hit.rank, caps: uv > 1 });
    const rev = Array.from(lower).reverse().join('');
    if (rev !== lower) { const rh = dictLookup(rev); if (rh) out.push({ i, j, type: rh.kind, token, log2: Math.log2(rh.rank * uv * 2), rank: rh.rank, reversed: true, caps: uv > 1 }); }
    if (/[0-9@!$|(){}+%]/.test(lower)) unleet(lower).forEach((u) => {
      const lh = dictLookup(u.s);
      if (lh) out.push({ i, j, type: lh.kind, token, log2: Math.log2(lh.rank * uv * leetVariations(token, u.subs)), rank: lh.rank, leet: u.s, caps: uv > 1 });
    });
  }
  return out;
}

function sequenceMatches(chars: string[]) {
  const out: Match[] = [], n = chars.length;
  let i = 0;
  while (i < n - 2) {
    const d = chars[i + 1].charCodeAt(0) - chars[i].charCodeAt(0);
    let j = i + 1;
    if ((d === 1 || d === -1) && charClass(chars[i]) === charClass(chars[i + 1]) && /lower|upper|digit/.test(charClass(chars[i]))) {
      while (j + 1 < n && chars[j + 1].charCodeAt(0) - chars[j].charCodeAt(0) === d && charClass(chars[j + 1]) === charClass(chars[i])) j++;
    }
    if (j - i >= 2) {
      const first = chars[i], base = 'aAzZ019'.indexOf(first) >= 0 ? 4 : charClass(first) === 'digit' ? 10 : 26;
      out.push({ i, j, type: 'sequence', token: chars.slice(i, j + 1).join(''), log2: Math.log2(base * (j - i + 1) * (d < 0 ? 2 : 1)) });
      i = j;
    } else i++;
  }
  return out;
}

// Keyboard graph: QWERTY rows (slanted) + numeric keypad. Shifted characters map to the same key.
interface Key { b: string; r: number; c: number; s: number }
const ROWS = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];
const SROWS = ['~!@#$%^&*()_+', 'QWERTYUIOP{}|', 'ASDFGHJKL:"', 'ZXCVBNM<>?'];
const KEYS: Record<string, Key> = {};
ROWS.forEach((r, ri) => { Array.from(r).forEach((c, ci) => { KEYS[c] = { b: 'q', r: ri, c: ci, s: 0 }; KEYS[SROWS[ri][ci]] = { b: 'q', r: ri, c: ci, s: 1 }; }); });
const PAD = ['789', '456', '123', '0..'];
const PADKEYS: Record<string, Key> = {};
PAD.forEach((r, ri) => { Array.from(r).forEach((c, ci) => { if (c !== '.' || ri !== 3 || ci === 2) PADKEYS[c] = { b: 'k', r: ri, c: ci, s: 0 }; }); });
function adjacentQ(a: Key, b: Key) {
  const dr = b.r - a.r, dc = b.c - a.c;
  if (dr === 0) return Math.abs(dc) === 1;
  if (dr === -1) return dc === 0 || dc === 1;
  if (dr === 1) return dc === 0 || dc === -1;
  return false;
}
function adjacentK(a: Key, b: Key) { return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c)) === 1; }
function walks(chars: string[], map: Record<string, Key>, adj: (a: Key, b: Key) => boolean, starts: number, degree: number) {
  const out: Match[] = [], n = chars.length;
  let i = 0;
  while (i < n - 2) {
    let j = i, turns = 0, dir: string | null = null, shifted = map[chars[i]] ? map[chars[i]].s : 0;
    while (j + 1 < n && map[chars[j]] && map[chars[j + 1]] && adj(map[chars[j]], map[chars[j + 1]])) {
      const nd = (map[chars[j + 1]].r - map[chars[j]].r) + ',' + (map[chars[j + 1]].c - map[chars[j]].c);
      if (nd !== dir) { turns++; dir = nd; }
      shifted += map[chars[j + 1]].s;
      j++;
    }
    const len = j - i + 1;
    if (len >= 3) {
      let g = Math.log2(starts) + Math.log2(len) + (turns - 1) * Math.log2(degree);
      if (shifted && shifted < len) g += Math.log2(Math.min(len, 8) * 2);
      else if (shifted) g += 1;
      out.push({ i, j, type: 'keyboard', token: chars.slice(i, j + 1).join(''), log2: g, turns });
      i = j;
    } else i++;
  }
  return out;
}
export function spatialMatches(chars: string[]) {
  return walks(chars, KEYS, adjacentQ, 47, 4.6).concat(walks(chars, PADKEYS, adjacentK, 11, 5));
}

function repeatMatches(chars: string[], depth: number) {
  const out: Match[] = [], s = chars.join('');
  let pos = 0;
  while (pos < s.length) {
    const rest = s.slice(pos), g = /(.+)\1+/.exec(rest);
    if (!g) break;
    const l = /(.+?)\1+/.exec(rest)!, m = g[0].length > l[0].length ? g : l; // same start; prefer the longer run, else the smaller unit
    const base = m[1], token = m[0], reps = token.length / base.length;
    const i = Array.from(s.slice(0, pos + m.index)).length, len = Array.from(token).length;
    const baseG = depth > 2 ? Array.from(base).length * Math.log2(cardinality(Array.from(base))) : estimate(base, depth + 1).log2;
    out.push({ i, j: i + len - 1, type: 'repeat', token, base, log2: baseG + Math.log2(reps) });
    pos += m.index + token.length;
  }
  return out;
}

const NOW_YEAR = 2026;
function yearSpace(y: number) { return Math.max(Math.abs(y - NOW_YEAR), 20); }
function validDate(d: number, mo: number, y: number) { return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2099; }
function fullYear(s: string) { const y = +s; return s.length === 2 ? (y > 50 ? 1900 + y : 2000 + y) : y; }
function dateMatches(chars: string[]) {
  const out: Match[] = [], n = chars.length;
  for (let i = 0; i < n; i++) for (let j = i + 3; j < Math.min(n, i + 10); j++) {
    const t = chars.slice(i, j + 1).join('');
    if (/^\d{4}$/.test(t) && +t >= 1900 && +t <= 2099) out.push({ i, j, type: 'year', token: t, log2: Math.log2(yearSpace(+t)) });
    let parts: string[][] | null = null, sep = false;
    const m = /^(\d{1,4})([/\-. _])(\d{1,2})\2(\d{1,4})$/.exec(t);
    if (m) { parts = [[m[1], m[3], m[4]]]; sep = true; }
    else if (/^\d{4,8}$/.test(t)) {
      parts = [];
      for (let a = 1; a <= 4; a++) for (let b = 1; b <= 2; b++) { const c = t.length - a - b; if (c >= 1 && c <= 4) parts.push([t.slice(0, a), t.slice(a, a + b), t.slice(a + b)]); }
    }
    if (!parts) continue;
    let best: number | null = null;
    parts.forEach((p) => {
      [[0, 1, 2], [1, 0, 2], [2, 1, 0]].forEach((o) => { // d-m-y, m-d-y, y-m-d
        const ys = p[o[2]], ds = p[o[0]], ms = p[o[1]];
        if (!(ys.length === 2 || ys.length === 4) || ds.length > 2 || ms.length > 2) return;
        const y = fullYear(ys);
        if (validDate(+ds, +ms, y)) { const g = Math.log2(365 * yearSpace(y) * (sep ? 4 : 1)); if (best === null || g < best) best = g; }
      });
    });
    if (best !== null) out.push({ i, j, type: 'date', token: t, log2: best });
  }
  return out;
}

/** The search: cheapest cover of the whole password (log2 of guesses), as on the website. */
export function estimate(pw: string, depth = 0): { log2: number; seq: Match[]; chars: string[] } {
  const chars = Array.from(pw).slice(0, MAX_LEN), n = chars.length;
  if (!n) return { log2: 0, seq: [], chars };
  const matches = dictionaryMatches(chars).concat(sequenceMatches(chars), spatialMatches(chars), repeatMatches(chars, depth), dateMatches(chars));
  const perChar = Math.log2(cardinality(chars));
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
    matches.push({ i, j, type: 'bruteforce', token: chars.slice(i, j + 1).join(''), log2: Math.max((j - i + 1) * perChar, 1) });
  }
  const byEnd: Match[][] = [];
  for (let e = 0; e < n; e++) byEnd.push([]);
  matches.forEach((m) => byEnd[m.j].push(m));
  // best[j][k] = min sum(log2 guesses) covering chars[0..j] with k matches
  const best: Record<number, number>[] = [], back: Record<number, Match>[] = [];
  for (let jj = 0; jj < n; jj++) { best.push({}); back.push({}); }
  for (let j2 = 0; j2 < n; j2++) byEnd[j2].forEach((m) => {
    if (m.i === 0) { if (!(1 in best[j2]) || m.log2 < best[j2][1]) { best[j2][1] = m.log2; back[j2][1] = m; } return; }
    const prev = best[m.i - 1];
    for (const k in prev) {
      const k1 = +k + 1, v = prev[k] + m.log2;
      if (!(k1 in best[j2]) || v < best[j2][k1]) { best[j2][k1] = v; back[j2][k1] = m; }
    }
  });
  let bestTotal = Infinity, bestK = 1;
  for (const kk in best[n - 1]) {
    const K = +kk, tot = log2add(log2fact(K) + best[n - 1][kk], (K - 1) * Math.log2(10000));
    if (tot < bestTotal) { bestTotal = tot; bestK = K; }
  }
  const seq: Match[] = [];
  let at = n - 1, kNow = bestK;
  while (at >= 0) { const mm = back[at][kNow]; seq.unshift(mm); at = mm.i - 1; kNow--; }
  const extra = Array.from(pw).slice(MAX_LEN);
  if (extra.length) bestTotal += extra.length * Math.log2(cardinality(extra));
  return { log2: Math.max(bestTotal, 0), seq, chars };
}

export const RATES = [
  { attack: 'Online, rate-limited (100 / hour)', perSecond: 100 / 3600 },
  { attack: 'Online, no limit (10 / second)', perSecond: 10 },
  { attack: 'Offline, slow hash (10k / second, bcrypt)', perSecond: 1e4 },
  { attack: 'Offline, fast hash (10B / second, GPU, MD5)', perSecond: 1e10 },
];
export function fmtTime(sec: number) {
  if (sec < 1) return 'instant';
  const u: [string, number, string?][] = [['century', 3155760000, 'centuries'], ['year', 31557600], ['month', 2629800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  if (sec / 3155760000 >= 1e4) {
    const y = sec / 31557600, big: [string, number][] = [['trillion', 1e12], ['billion', 1e9], ['million', 1e6], ['thousand', 1e3]];
    if (y >= 1e15) return '10^' + Math.floor(Math.log10(y)) + ' years';
    for (const [name, v] of big) if (y >= v) return Math.round(y / v).toLocaleString('en-US') + ' ' + name + ' years';
  }
  for (const [name, v, plural] of u) if (sec >= v) {
    const n = Math.round(sec / v);
    return n.toLocaleString('en-US') + ' ' + (n === 1 ? name : plural || name + 's');
  }
  return '';
}
export const SCORES = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
export function score(bits: number) { return bits < 20 ? 0 : bits < 35 ? 1 : bits < 50 ? 2 : bits < 65 ? 3 : 4; }

export function tipsFor(r: ReturnType<typeof estimate>, pw: string) {
  const t: string[] = [], types: Record<string, Match> = {}, s = score(r.log2), len = r.chars.length;
  r.seq.forEach((m) => { types[m.type] = m; });
  if (r.seq.length === 1 && types.common) t.push('This is one of the most common passwords (about #' + types.common.rank + ' on lists attackers try first). Never use it.');
  else if (types.common) t.push('It contains a very common password. Attackers try those, and variations of them, first.');
  if (r.seq.length === 1 && types.word) t.push('A single dictionary word is guessed in seconds, whatever you do to it.');
  else if (types.word && s < 3) t.push('Common words are guessed early. A few unrelated random words are fine, one or two are not.');
  if (r.seq.some((m) => m.leet)) t.push('Swaps like @ for a or 0 for o are the first variations attackers try. They add almost nothing.');
  if (r.seq.some((m) => m.reversed)) t.push('Reversed words are no harder to guess than normal ones.');
  if (r.seq.some((m) => m.caps && /^[A-Z][^A-Z]*$/.test(m.token))) t.push('Capitalizing only the first letter barely helps.');
  if (r.seq.some((m) => m.caps && m.token.length > 2 && m.token === m.token.toUpperCase())) t.push('ALL CAPS is about as easy to guess as all lowercase.');
  if (types.keyboard) t.push('Keyboard patterns like qwerty, asdf or 1qaz2wsx are in every cracking list.');
  if (types.sequence) t.push('Sequences like abc or 6789 are easy to guess.');
  if (types.repeat) t.push('Repeats like aaa or abcabc add very little over the part being repeated.');
  if (types.year || types.date) t.push('Years and dates are easy to guess, especially birthdays and anniversaries.');
  if (/[!1.?]$/.test(pw) && r.seq.length > 1 && s < 4) t.push('Ending with ! or 1 is the most common trick, so attackers expect it.');
  if (len < 12) t.push('Use at least 12–16 characters. Length beats complexity.');
  if (s < 3) t.push('Try a passphrase of 5–6 random words (a generator picks better than people do).');
  if (s >= 4) t.push("Excellent. Keep it unique to one account so a leak elsewhere can't unlock it.");
  else if (s === 3) t.push('Good. Make it a little longer if this protects email, banking or a password manager.');
  t.push('Use a different password for every site. A password manager makes that painless.');
  return t;
}

const LABEL: Record<string, string> = { common: 'common password', word: 'dictionary word', keyboard: 'keyboard pattern', sequence: 'sequence', repeat: 'repeat', year: 'year', date: 'date', bruteforce: 'random characters' };

export default defineTool({
  name: 'password_check',
  title: 'Password strength check',
  webSlug: 'password-check',
  description:
    'Estimate how strong a password really is, the way attackers guess (zxcvbn-style): finds common passwords (1,282-entry ' +
    'list), dictionary words (also reversed, capitalised or l33t), keyboard walks, sequences, repeats, years and dates, ' +
    'then the cheapest way to guess the whole thing. Returns a 0–4 score, entropy bits, guesses, crack time for 4 attack ' +
    'scenarios, the pieces found, and advice. Offline only: no breach lookups, nothing stored or logged. ' +
    `Web version: ${webUrl('password-check')}`,
  inputSchema: z.object({
    password: z.string().min(1).max(1000).describe('The password to check (only the first 256 characters are analysed in detail).'),
    showPieces: z.boolean().optional().default(true).describe('Include the matched pieces (they contain parts of the password).'),
  }),
  outputSchema: z.object({
    score: z.number().describe('0 = very weak … 4 = very strong.'),
    label: z.string(),
    bits: z.number().describe('log2 of the estimated number of guesses.'),
    guessesLog10: z.number(),
    crackTimes: z.array(z.object({ attack: z.string(), time: z.string() })),
    pieces: z.array(z.object({ token: z.string(), type: z.string(), note: z.string(), bits: z.number() })).optional(),
    tips: z.array(z.string()),
    stats: z.object({ characters: z.number(), characterTypes: z.number(), piecesFound: z.number() }),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { password: 'Summer2024!' }, note: 'Weak: dictionary word + year + "!"' },
    { input: { password: 'correct horse battery staple' }, note: 'Strong passphrase (> 50 bits)' },
  ],
  run(input) {
    const pw = input.password, r = estimate(pw), s = score(r.log2);
    const classes = new Set(r.chars.map(charClass));
    const out: Record<string, unknown> = {
      score: s, label: SCORES[s], bits: Math.round(r.log2 * 10) / 10, guessesLog10: Math.round(r.log2 * Math.log10(2)),
      crackTimes: RATES.map((x) => ({ attack: x.attack, time: fmtTime(Math.pow(2, r.log2) / x.perSecond) })),
      tips: tipsFor(r, pw),
      stats: { characters: r.chars.length, characterTypes: classes.size, piecesFound: r.seq.length },
    };
    if (input.showPieces) {
      out.pieces = r.seq.map((m) => ({
        token: m.token, type: m.type,
        note: LABEL[m.type] + (m.type === 'common' ? ' #' + m.rank : '') + (m.leet ? ' (l33t)' : '') + (m.reversed ? ' (reversed)' : '') +
          (m.type === 'repeat' ? ' ×' + Math.round(Array.from(m.token).length / Array.from(m.base!).length) : ''),
        bits: Math.round(m.log2 * 10) / 10,
      }));
    }
    return out;
  },
});

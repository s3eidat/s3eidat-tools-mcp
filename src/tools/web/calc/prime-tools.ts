import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';

// Ported from https://github.com/s3eidat/prime-tools (app.js): BigInt Miller–Rabin, Pollard rho (Brent), segmented sieve.
const TWO64 = 1n << 64n;
const MR_BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]; // deterministic for n < 2^64

export function sieve(n: number) { const s = new Uint8Array(n + 1), out: number[] = []; for (let i = 2; i <= n; i++) { if (s[i]) continue; out.push(i); for (let j = i * i; j <= n; j += i) s[j] = 1; } return out; }
const SMALL = sieve(100000), SMALLB = SMALL.map(BigInt);

const babs = (a: bigint) => (a < 0n ? -a : a);
export function gcd(a: bigint, b: bigint) { a = babs(a); b = babs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
function modpow(b: bigint, e: bigint, m: bigint) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const bitLength = (n: bigint) => n.toString(2).length;
function randBelow(n: bigint) { // uniform-ish BigInt in [0, n)
  const bytes = randBytes(Math.ceil(bitLength(n) / 8) + 8);
  let x = 0n; bytes.forEach((b) => { x = (x << 8n) | BigInt(b); }); return x % n;
}
const randBytes = (n: number) => Uint8Array.from(randomBytes(n));
function isqrt(n: bigint) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))); if (x === 0n) x = 1n;
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) { while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; } x = y; }
}

function strongProbable(n: bigint, a: bigint, d: bigint, s: number) {
  a %= n; if (a === 0n) return true;
  let x = modpow(a, d, n);
  if (x === 1n || x === n - 1n) return true;
  for (let i = 1; i < s; i++) { x = (x * x) % n; if (x === n - 1n) return true; if (x === 1n) return false; }
  return false;
}
export interface PrimeTest { prime: boolean; method: string; witness?: bigint; rounds?: number }
export function isPrime(n: bigint | number, extraRounds?: number): PrimeTest {
  n = BigInt(n);
  if (n < 2n) return { prime: false, method: 'definition' };
  for (let i = 0; i < 168; i++) { const p = SMALLB[i]; if (n === p) return { prime: true, method: 'trial' }; if (n % p === 0n) return { prime: false, method: 'trial', witness: p }; }
  if (n < 1000000n) return { prime: true, method: 'trial' }; // no factor up to 997 < √n
  let d = n - 1n, s = 0; while ((d & 1n) === 0n) { d >>= 1n; s++; }
  for (const b of MR_BASES) if (!strongProbable(n, b, d, s)) return { prime: false, method: 'Miller-Rabin', witness: b };
  if (n < TWO64) return { prime: true, method: 'deterministic', rounds: MR_BASES.length };
  const k = extraRounds === undefined ? 24 : extraRounds;
  for (let i = 0; i < k; i++) { const a = 2n + randBelow(n - 3n); if (!strongProbable(n, a, d, s)) return { prime: false, method: 'Miller-Rabin', witness: a }; }
  return { prime: true, method: 'probabilistic', rounds: MR_BASES.length + k };
}

/** Pollard rho (Brent); null when the work budget runs out. */
export function rho(n: bigint, budget = 4000000): bigint | null {
  if (n % 2n === 0n) return 2n;
  let used = 0;
  for (let c = 1n; c < 40n; c++) {
    let y = 2n, g = 1n, r = 1, q = 1n, x = 0n, ys = 0n;
    const m = 128, f = (v: bigint) => (v * v + c) % n;
    while (g === 1n) {
      x = y;
      for (let i = 0; i < r; i++) y = f(y);
      let k = 0;
      while (k < r && g === 1n) {
        ys = y;
        const lim = Math.min(m, r - k);
        for (let i = 0; i < lim; i++) { y = f(y); q = (q * babs(x - y)) % n; }
        g = gcd(q, n); k += m; used += lim;
        if (used > budget) return null;
      }
      r *= 2;
    }
    if (g === n) { do { ys = f(ys); g = gcd(babs(x - ys), n); used++; } while (g === 1n && used < budget); }
    if (g !== n && g !== 1n) return g;
  }
  return null;
}

export interface Factored { factors: Map<string, number>; unfactored: bigint[]; probable: boolean }
export function factor(n: bigint | number): Factored {
  n = babs(BigInt(n));
  const F = new Map<string, number>(), rest: bigint[] = [];
  let probable = false;
  const addF = (p: bigint, e = 1) => { const k = p.toString(); F.set(k, (F.get(k) || 0) + e); };
  if (n < 2n) return { factors: F, unfactored: rest, probable: false };
  for (let i = 0; i < SMALLB.length && SMALLB[i] * SMALLB[i] <= n; i++) {
    const p = SMALLB[i];
    while (n % p === 0n) { n /= p; addF(p); }
  }
  if (n > 1n && n < 10000000000n) { addF(n); n = 1n; } // no factor below 10^5, so n < 10^10 is prime
  const stack: bigint[] = n > 1n ? [n] : [];
  while (stack.length) {
    const m = stack.pop()!;
    if (m === 1n) continue;
    const t = isPrime(m);
    if (t.prime) { addF(m); if (t.method === 'probabilistic') probable = true; continue; }
    const r2 = isqrt(m); if (r2 * r2 === m) { stack.push(r2, r2); continue; }
    const d = rho(m);
    if (!d) { rest.push(m); continue; }
    stack.push(d, m / d);
  }
  const sorted = new Map(Array.from(F).sort((a, b) => { const x = BigInt(a[0]), y = BigInt(b[0]); return x < y ? -1 : x > y ? 1 : 0; }));
  return { factors: sorted, unfactored: rest, probable };
}

export function divisorInfo(fr: Factored, n: bigint) {
  let count = 1n, sigma = 1n, phi = n;
  fr.factors.forEach((e, ps) => {
    const p = BigInt(ps); count *= BigInt(e + 1);
    sigma *= (p ** BigInt(e + 1) - 1n) / (p - 1n);
    phi = (phi / p) * (p - 1n);
  });
  let list: bigint[] | null = null;
  if (!fr.unfactored.length && count <= 20000n) {
    list = [1n];
    fr.factors.forEach((e, ps) => {
      const p = BigInt(ps), next: bigint[] = [];
      list!.forEach((dv) => { let pk = 1n; for (let k = 0; k <= e; k++) { next.push(dv * pk); pk *= p; } });
      list = next;
    });
    list!.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return { count, sigma, phi, list };
}
export function nextPrime(n: bigint | number) { n = BigInt(n); if (n < 2n) return 2n; let c = n + 1n; if (c > 2n && c % 2n === 0n) c++; for (let i = 0; i < 200000; i++, c += 2n) if (isPrime(c, 8).prime) return c; return null; }
export function prevPrime(n: bigint | number) {
  n = BigInt(n); if (n <= 2n) return null; if (n === 3n) return 2n;
  let c = n - 1n; if (c % 2n === 0n) c--;
  for (let i = 0; i < 200000 && c >= 3n; i++, c -= 2n) if (isPrime(c, 8).prime) return c;
  return c === 1n ? 2n : null;
}

export function euclidSteps(a: bigint, b: bigint) {
  const lines: string[] = []; a = babs(a); b = babs(b);
  if (a < b) { const t = a; a = b; b = t; }
  if (b === 0n) { lines.push('gcd(' + a + ', 0) = ' + a); return { g: a, lines }; }
  while (b) { const q = a / b, r = a % b; lines.push(a + ' = ' + q + ' × ' + b + ' + ' + r); a = b; b = r; }
  return { g: a, lines };
}
export function gcdLcm(nums: bigint[]) {
  let g = nums[0], l = nums[0];
  const steps: { head: string; lines: string[] }[] = [];
  for (let i = 1; i < nums.length; i++) {
    const e = euclidSteps(g, nums[i]);
    steps.push({ head: 'gcd(' + g + ', ' + nums[i] + ')', lines: e.lines.concat(['→ ' + e.g]) });
    const gl = gcd(l, nums[i]), nl = gl === 0n ? 0n : babs(l * nums[i]) / gl;
    steps.push({ head: 'lcm(' + l + ', ' + nums[i] + ') = ' + babs(l) + ' × ' + babs(nums[i]) + ' ÷ ' + gl + ' = ' + nl, lines: [] });
    g = e.g; l = nl;
  }
  return { gcd: babs(g), lcm: babs(l), steps };
}

export const RANGE_MAX = 10000000, HI_MAX = 1e15;
/** Segmented sieve over Numbers below 10^15. */
export function primesInRange(lo: number, hi: number) {
  lo = Math.max(2, Math.floor(lo)); hi = Math.floor(hi);
  if (hi < lo) return [];
  const lim = Math.floor(Math.sqrt(hi)), base = lim <= 100000 ? SMALL.filter((p) => p <= lim) : sieve(lim);
  const size = hi - lo + 1, mark = new Uint8Array(size), out: number[] = [];
  base.forEach((p) => { const start = Math.max(p * p, Math.ceil(lo / p) * p); for (let j = start; j <= hi; j += p) mark[j - lo] = 1; });
  for (let i = 0; i < size; i++) if (!mark[i]) out.push(lo + i);
  return out;
}

/** Whole numbers or a tiny expression (+ − × ^ ! and brackets), BigInt, no eval. */
export function parseBig(src: string): bigint | null {
  const s = String(src).replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/\*\*/g, '^').replace(/[,_\s']/g, '');
  if (!s) return null;
  let i = 0;
  const peek = () => s[i];
  function expr(): bigint { let v = term(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const w = term(); v = op === '+' ? v + w : v - w; } return v; }
  function term(): bigint { let v = power(); while (peek() === '*') { i++; v *= power(); } return v; }
  function power(): bigint {
    const b = atom();
    if (peek() === '^') {
      i++; const e = power();
      if (e < 0n) throw new ToolError("Negative powers aren't whole numbers");
      if (e > 100000n || (b > 1n && BigInt(bitLength(b)) * e > 1000000n)) throw new ToolError('That power is too large');
      return b ** e;
    }
    return b;
  }
  function atom(): bigint {
    if (peek() === '-') { i++; return -atom(); }
    if (peek() === '(') { i++; const v = expr(); if (s[i++] !== ')') throw new ToolError('Missing )'); return v; }
    const m = /^\d+/.exec(s.slice(i));
    if (!m) throw new ToolError(i < s.length ? 'Unexpected "' + s[i] + '"' : 'Incomplete expression');
    i += m[0].length;
    if (s[i] === '!') { i++; const n = BigInt(m[0]); if (n > 5000n) throw new ToolError('Factorial too large'); let f = 1n; for (let k = 2n; k <= n; k++) f *= k; return f; }
    return BigInt(m[0]);
  }
  const v = expr();
  if (i < s.length) throw new ToolError('Unexpected "' + s[i] + '"');
  return v;
}

export function factorText(fr: Factored, plain = false) {
  const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹', sup = (n: number) => String(n).split('').map((d) => SUP[+d]).join('');
  const parts: string[] = [];
  fr.factors.forEach((e, p) => parts.push(plain ? p + (e > 1 ? '^' + e : '') : p + (e > 1 ? sup(e) : '')));
  fr.unfactored.forEach((m) => parts.push(plain ? '(' + m + ')' : '(' + m + ' composite)'));
  return parts.join(plain ? ' * ' : ' × ');
}

export default defineTool({
  name: 'calc_primes',
  title: 'Prime number tools',
  webSlug: 'prime-tools',
  description:
    'Number theory with big integers, like the website. check: is a number prime (trial division, deterministic Miller-Rabin ' +
    'below 2^64, probabilistic above), its prime factorisation (Pollard rho), number of divisors, sum of divisors σ, Euler φ, ' +
    'the divisor list, previous/next prime and whether it is perfect; the number may be an expression like "2^61-1", "10!+1" ' +
    'or "1000003*1000033" (up to 400 digits). gcd_lcm: GCD and LCM of 2–50 numbers with Euclid\'s steps. range: list the ' +
    `primes between two numbers (below 10^15, at most 10,000,000 numbers per range). Web version: ${webUrl('prime-tools')}`,
  inputSchema: z.object({
    mode: z.enum(['check', 'gcd_lcm', 'range']).optional().default('check').describe('What to do.'),
    number: z.union([z.string(), z.number()]).optional().describe('check: the number or expression, e.g. "600851475143" or "2^89-1".'),
    numbers: z.array(z.union([z.string(), z.number()])).optional().describe('gcd_lcm: the whole numbers (2–50, expressions allowed).'),
    from: z.number().int().optional().describe('range: start (inclusive).'),
    to: z.number().int().optional().describe('range: end (inclusive), below 10^15.'),
    limit: z.number().int().min(0).max(100000).optional().default(10000).describe('range: return at most this many primes in the list (the count is always exact).'),
  }),
  outputSchema: z.object({
    mode: z.string(),
    number: z.string().optional(), digits: z.number().optional(), isPrime: z.boolean().optional(), verdict: z.string().optional(), method: z.string().optional(),
    factorization: z.string().optional(), factors: z.array(z.object({ prime: z.string(), exponent: z.number() })).optional(),
    unfactored: z.array(z.string()).optional(), probablePrimeFactors: z.boolean().optional(),
    divisorCount: z.string().optional(), divisorSum: z.string().optional(), eulerPhi: z.string().optional(), perfect: z.boolean().optional(),
    divisors: z.array(z.string()).optional(), previousPrime: z.string().nullable().optional(), nextPrime: z.string().nullable().optional(),
    gcd: z.string().optional(), lcm: z.string().optional(), coprime: z.boolean().optional(),
    steps: z.array(z.object({ head: z.string(), lines: z.array(z.string()) })).optional(),
    count: z.number().optional(), primes: z.array(z.number()).optional(), truncated: z.boolean().optional(),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { number: '600851475143' }, note: 'composite = 71 × 839 × 1471 × 6857' },
    { input: { mode: 'gcd_lcm', numbers: [84, 126, 210] }, note: 'gcd 42, lcm 1260' },
    { input: { mode: 'range', from: 1, to: 100 }, note: '25 primes' },
  ],
  run(input) {
    if (input.mode === 'range') {
      if (input.from === undefined || input.to === undefined) throw new ToolError('Give "from" and "to".');
      const lo = input.from, hi = input.to;
      if (hi >= HI_MAX) throw new ToolError('Keep "to" below 10^15.');
      if (hi - lo + 1 > RANGE_MAX) throw new ToolError('At most 10,000,000 numbers at a time.');
      const list = primesInRange(lo, hi);
      return { mode: 'range', count: list.length, primes: list.slice(0, input.limit), truncated: list.length > input.limit };
    }
    if (input.mode === 'gcd_lcm') {
      const nums = (input.numbers ?? []).map((x) => parseBig(String(x))).filter((x): x is bigint => x !== null);
      if (nums.length < 2) throw new ToolError('Type two or more whole numbers.');
      const r = gcdLcm(nums.slice(0, 50));
      return { mode: 'gcd_lcm', gcd: String(r.gcd), lcm: String(r.lcm), ...(nums.length === 2 ? { coprime: r.gcd === 1n } : {}), steps: r.steps };
    }
    if (input.number === undefined) throw new ToolError('Give "number".');
    const n = parseBig(String(input.number));
    if (n === null) throw new ToolError('Type a number.');
    if (n.toString().length > 400) throw new ToolError('Please keep it under 400 digits.');
    const a = babs(n), t = isPrime(a);
    const verdict = a < 2n ? (a === 0n ? '0 is neither prime nor composite' : '1 is neither prime nor composite (by definition)') : t.prime ? (t.method === 'probabilistic' ? 'Probable prime' : 'Prime') : 'Composite';
    const how = a < 2n ? '' : t.method === 'trial' ? 'Checked by trial division.' : t.method === 'deterministic' ? 'Deterministic Miller-Rabin (12 bases, exact for every number below 2^64).'
      : t.method === 'probabilistic' ? 'Miller-Rabin with ' + t.rounds + ' bases. Above 2^64 this is probabilistic: the chance a composite passes is below 4^-' + t.rounds + '.'
        : 'Miller-Rabin: base ' + t.witness + ' proves it composite.';
    const out: Record<string, unknown> = { mode: 'check', number: String(n), digits: a.toString().length, isPrime: t.prime, verdict, method: how + (n < 0n ? ' (Sign ignored for factors.)' : '') };
    if (a < 2n) return out;
    const fr = factor(a), info = divisorInfo(fr, a), full = !fr.unfactored.length;
    Object.assign(out, {
      factorization: t.prime ? String(a) : factorText(fr), factors: Array.from(fr.factors, ([p, e]) => ({ prime: p, exponent: e })),
      ...(fr.unfactored.length ? { unfactored: fr.unfactored.map(String) } : {}), probablePrimeFactors: fr.probable,
      ...(full ? { divisorCount: String(info.count), divisorSum: String(info.sigma), eulerPhi: String(info.phi), perfect: info.sigma === 2n * a } : {}),
      ...(info.list ? { divisors: info.list.slice(0, 5000).map(String) } : {}),
      previousPrime: prevPrime(a)?.toString() ?? null, nextPrime: nextPrime(a)?.toString() ?? null,
    });
    return out;
  },
});

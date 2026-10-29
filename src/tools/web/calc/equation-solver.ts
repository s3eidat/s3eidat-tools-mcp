import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';

// Ported from https://github.com/s3eidat/equation-solver (app.js): exact rationals (BigInt), surds for irrational roots,
// rational root test + trigonometric/Cardano for cubics, Gauss–Jordan for systems, with the same worked steps.
export interface Q { n: bigint; d: bigint }
const babs = (a: bigint) => (a < 0n ? -a : a);
function gcd(a: bigint, b: bigint) { a = babs(a); b = babs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
const err = (m: string) => new ToolError(m);
export function R(n: bigint | number | string, d: bigint | number | string = 1n): Q {
  let N = BigInt(n), D = BigInt(d);
  if (D === 0n) throw err('Division by zero');
  if (D < 0n) { N = -N; D = -D; }
  const g = gcd(N, D) || 1n;
  return { n: N / g, d: D / g };
}
const ZERO = R(0), ONE = R(1);
const add = (a: Q, b: Q) => R(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q) => R(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => R(a.n * b.n, a.d * b.d);
function div(a: Q, b: Q) { if (b.n === 0n) throw err('Division by zero'); return R(a.n * b.d, a.d * b.n); }
const neg = (a: Q) => R(-a.n, a.d);
const isZ = (a: Q) => a.n === 0n;
const sgn = (a: Q) => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0);
const eq = (a: Q, b: Q) => a.n === b.n && a.d === b.d;
const num = (a: Q) => Number(a.n) / Number(a.d);
export function str(a: Q) { const s = a.d === 1n ? String(a.n) : a.n + '/' + a.d; return s.replace('-', '−'); }
export function approx(v: number) { if (!isFinite(v)) return String(v); const r = +v.toPrecision(10); return String(Math.abs(r) < 1e-12 ? 0 : r).replace('-', '−'); }
const strA = (a: Q) => (a.d === 1n ? str(a) : str(a) + ' ≈ ' + approx(num(a)));

/** Coefficients: 3, -2.5, 3/4, -1 1/2, 1e-3, Arabic digits. Empty = 0. */
export function parseCoef(s: unknown): Q {
  const t = String(s == null ? '' : s).trim().replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/\u066b/g, '.').replace(/[−–]/g, '-').replace(/\s+/g, ' ');
  if (!t) return ZERO;
  let m: RegExpExecArray | null;
  if ((m = /^([+-]?)(\d+) (\d+)\/(\d+)$/.exec(t))) { const v = add(R(m[2]), R(m[3], m[4])); return m[1] === '-' ? neg(v) : v; }
  if ((m = /^([+-]?)(\d+)\s*\/\s*(\d+)$/.exec(t))) { if (/^0+$/.test(m[3])) throw err('"' + t + '" divides by zero'); return R((m[1] === '-' ? '-' : '') + m[2], m[3]); }
  if ((m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(t)) && (m[2] || m[3])) {
    const frac = m[3] || '', e = m[4] ? parseInt(m[4], 10) : 0;
    let n = BigInt((m[2] || '0') + frac), d = 10n ** BigInt(frac.length);
    if (Math.abs(e) > 300) throw err('Exponent too large');
    if (e > 0) n *= 10n ** BigInt(e); else if (e < 0) d *= 10n ** BigInt(-e);
    return R(m[1] === '-' ? -n : n, d);
  }
  throw err('"' + t + '" is not a number. Use 3, -2.5 or 3/4.');
}

// ---------- square roots of rationals: √(p/q) = k·√m with m square-free ----------
function isqrt(n: bigint) { if (n < 2n) return n; let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; }
export function squareFree(N: bigint) {
  let k = 1n, m = N, f = 2n, steps = 0;
  while (f * f <= m && steps < 200000) {
    while (m % (f * f) === 0n) { m /= f * f; k *= f; }
    f += f === 2n ? 1n : 2n; steps++;
  }
  const r = isqrt(m); if (r * r === m) { k *= r; m = 1n; }
  return { k, m };
}
function sqrtR(D: Q) { const s = squareFree(D.n * D.d); return { k: R(s.k, D.d), m: s.m }; } // √(n/d) = √(n·d)/d
function surd(s: Q, m: bigint) {
  if (m === 1n) return str(s);
  const top = (s.n === 1n ? '' : String(s.n)) + '√' + m;
  return s.d === 1n ? top : top + '/' + s.d;
}

// ---------- polynomial text ----------
const SUPS: Record<number, string> = { 1: '', 2: '²', 3: '³' };
export function poly(cs: Q[], v = 'x') { // highest degree first
  const deg = cs.length - 1, parts: { neg: boolean; t: string }[] = [];
  cs.forEach((c, i) => {
    const p = deg - i; if (isZ(c)) return;
    const a = { n: babs(c.n), d: c.d }, coef = p && eq(a, ONE) ? '' : str(a);
    parts.push({ neg: c.n < 0n, t: coef + (p ? v + SUPS[p] : '') });
  });
  if (!parts.length) return '0';
  return parts.map((x, i) => (i === 0 ? (x.neg ? '−' : '') + x.t : (x.neg ? ' − ' : ' + ') + x.t)).join('');
}
function lin(cs: Q[], vars: string[], rhs: Q) {
  const parts: { neg: boolean; t: string }[] = [];
  cs.forEach((c, i) => { if (isZ(c)) return; const a = { n: babs(c.n), d: c.d }; parts.push({ neg: c.n < 0n, t: (eq(a, ONE) ? '' : str(a)) + vars[i] }); });
  const left = parts.length ? parts.map((x, i) => (i === 0 ? (x.neg ? '−' : '') + x.t : (x.neg ? ' − ' : ' + ') + x.t)).join('') : '0';
  return left + ' = ' + str(rhs);
}

// Root objects: {re} exact, {re, s, m, sign} = re ± s√m, {re, s, m, im: true} complex, or {f, fi} numeric.
export interface Root { re?: Q; s?: Q; m?: bigint; sign?: number; im?: boolean; f?: number; fi?: number }
export interface Solved { kind: string; roots?: Root[]; D?: Q; steps: (string | { text: string; m?: string[][] })[]; numeric?: boolean; note?: string; vals?: Q[]; param?: string[] }

export function solveLinear(a: Q, b: Q, c: Q): Solved {
  const steps: string[] = ['Start: ' + poly([a, b]) + ' = ' + str(c)];
  const rhs = sub(c, b);
  if (!isZ(b)) steps.push((sgn(b) > 0 ? 'Subtract ' + str(b) : 'Add ' + str(neg(b))) + ' on both sides: ' + poly([a, ZERO]) + ' = ' + str(rhs));
  if (isZ(a)) {
    steps.push('The x term is gone: 0 = ' + str(rhs));
    return isZ(rhs) ? { kind: 'all', steps: steps.concat(['0 = 0 is always true, so every x is a solution.']) } : { kind: 'none', steps: steps.concat(['0 = ' + str(rhs) + ' is never true, so there is no solution.']) };
  }
  const x = div(rhs, a);
  if (!eq(a, ONE)) steps.push('Divide both sides by ' + str(a) + ': x = ' + str(x));
  return { kind: 'one', roots: [{ re: x }], steps };
}
function factorText(a: Q, roots: Q[]) {
  return (eq(a, ONE) ? '' : eq(a, R(-1)) ? '−' : str(a)) + roots.map((x) => (isZ(x) ? 'x' : '(x ' + (sgn(x) > 0 ? '− ' + str(x) : '+ ' + str(neg(x))) + ')')).join('') + ' = 0';
}
export function solveQuadratic(a: Q, b: Q, c: Q, pre?: string[]): Solved {
  const steps = pre || [];
  if (isZ(a)) { const l = solveLinear(b, c, ZERO); l.steps = (steps as Solved['steps']).concat(['a = 0, so this is a linear equation.'], l.steps); return l; }
  steps.push('Equation: ' + poly([a, b, c]) + ' = 0, with a = ' + str(a) + ', b = ' + str(b) + ', c = ' + str(c));
  const D = sub(mul(b, b), mul(R(4), mul(a, c)));
  steps.push('Discriminant: Δ = b² − 4ac = (' + str(b) + ')² − 4·(' + str(a) + ')·(' + str(c) + ') = ' + str(D));
  const r = div(neg(b), mul(R(2), a));
  if (isZ(D)) {
    steps.push('Δ = 0, so there is one repeated real root: x = −b / 2a = ' + str(r));
    return { kind: 'double', roots: [{ re: r }, { re: r }], D, steps };
  }
  const sq = sqrtR(D.n < 0n ? neg(D) : D), s = div(sq.k, mul(R(2), { n: babs(a.n), d: a.d }));
  steps.push('√' + (D.n < 0n ? '(−Δ)' : 'Δ') + ' = √' + str(D.n < 0n ? neg(D) : D) + ' = ' + surd(sq.k, sq.m) + (sq.m === 1n ? ' (a perfect square, so the roots are rational)' : ''));
  steps.push('Quadratic formula: x = (−b ± √Δ) / 2a = ' + str(r) + ' ± ' + surd(s, sq.m) + (D.n < 0n ? 'i' : ''));
  if (D.n < 0n) {
    steps.push('Δ < 0, so the roots are a complex-conjugate pair.');
    return { kind: 'complex', roots: [{ re: r, s, m: sq.m, im: true, sign: 1 }, { re: r, s, m: sq.m, im: true, sign: -1 }], D, steps };
  }
  if (sq.m === 1n) {
    const x1 = sub(r, s), x2 = add(r, s);
    steps.push('So x = ' + str(x1) + ' or x = ' + str(x2));
    steps.push('Factored: ' + factorText(a, [x1, x2]));
    return { kind: 'two', roots: [{ re: x1 }, { re: x2 }], D, steps };
  }
  steps.push('Δ > 0 and not a perfect square: two irrational real roots.');
  return { kind: 'two', roots: [{ re: r, s, m: sq.m, sign: -1 }, { re: r, s, m: sq.m, sign: 1 }], D, steps };
}
export function rootVal(x: Root): [number, number] {
  if (x.f !== undefined) return [x.f, x.fi || 0];
  if (x.s === undefined) return [num(x.re!), 0];
  const t = num(x.s) * Math.sqrt(Number(x.m));
  return x.im ? [num(x.re!), x.sign! * t] : [num(x.re!) + x.sign! * t, 0];
}
export function rootText(x: Root) {
  if (x.f !== undefined) return x.fi ? approx(x.f) + (x.fi < 0 ? ' − ' : ' + ') + approx(Math.abs(x.fi)) + 'i' : approx(x.f);
  if (x.s === undefined) return strA(x.re!);
  const v = rootVal(x), sur = surd(x.s, x.m!) + (x.im ? 'i' : ''), head = isZ(x.re!) ? (x.sign! < 0 ? '−' : '') + sur : str(x.re!) + (x.sign! < 0 ? ' − ' : ' + ') + sur;
  return head + ' ≈ ' + (x.im ? approx(v[0]) + (v[1] < 0 ? ' − ' : ' + ') + approx(Math.abs(v[1])) + 'i' : approx(v[0]));
}

function divisors(n: bigint, cap: number) {
  n = babs(n); const out: bigint[] = [];
  if (n === 0n || n > 10n ** 12n) return null;
  for (let i = 1n; i * i <= n; i++) if (n % i === 0n) { out.push(i); if (i * i !== n) out.push(n / i); if (out.length > cap) return null; }
  return out;
}
function evalPoly(cs: Q[], x: Q) { let v = ZERO; cs.forEach((c) => { v = add(mul(v, x), c); }); return v; }
/** Cubic: rational root test first (exact), otherwise trigonometric / Cardano with Newton polishing. */
export function solveCubic(a: Q, b: Q, c: Q, d: Q): Solved {
  if (isZ(a)) return solveQuadratic(b, c, d, ['a = 0, so this is a quadratic equation.']);
  const steps: string[] = ['Equation: ' + poly([a, b, c, d]) + ' = 0'];
  if (isZ(d)) {
    steps.push('d = 0, so x is a factor: x(' + poly([a, b, c]) + ') = 0, giving x = 0');
    const q0 = solveQuadratic(a, b, c, []);
    return { kind: 'cubic', roots: [{ re: ZERO } as Root].concat(q0.roots || []), steps: (steps as Solved['steps']).concat(q0.steps), note: q0.kind };
  }
  const L = [a, b, c, d].reduce((acc, x) => (acc / gcd(acc, x.d)) * x.d, 1n);
  const I = [a, b, c, d].map((x) => x.n * (L / x.d));
  const P = divisors(I[3], 5000), Qd = divisors(I[0], 5000);
  let found: Q | null = null;
  if (P && Qd) {
    steps.push('Rational root test: any rational root is ±p/q with p dividing ' + babs(I[3]) + ' and q dividing ' + babs(I[0]) + '.');
    const seen = new Set<string>();
    outer: for (let i = 0; i < Qd.length; i++) for (let j = 0; j < P.length; j++) {
      for (let s = 0; s < 2; s++) {
        const cand = R(s ? -P[j] : P[j], Qd[i]), key = str(cand);
        if (seen.has(key)) continue; seen.add(key);
        if (isZ(evalPoly([a, b, c, d], cand))) { found = cand; break outer; }
      }
    }
  }
  if (found) {
    const b2 = add(b, mul(a, found)), c2 = add(c, mul(b2, found));
    steps.push('x = ' + str(found) + ' is a root (it makes the left side 0).');
    steps.push('Divide by (x ' + (sgn(found) > 0 ? '− ' + str(found) : '+ ' + str(neg(found))) + ') with synthetic division: ' + poly([a, b2, c2]) + ' = 0');
    const qd = solveQuadratic(a, b2, c2, []);
    return { kind: 'cubic', roots: [{ re: found } as Root].concat(qd.roots || []), steps: (steps as Solved['steps']).concat(qd.steps) };
  }
  steps.push(P && Qd ? 'No rational root, so the roots are found numerically.' : 'The coefficients are too large for the rational root test, so the roots are found numerically.');
  const Dl = sub(add(sub(mul(R(18), mul(a, mul(b, mul(c, d)))), mul(R(4), mul(mul(b, mul(b, b)), d))), mul(mul(b, b), mul(c, c))),
    add(mul(R(4), mul(a, mul(c, mul(c, c)))), mul(R(27), mul(mul(a, a), mul(d, d)))));
  steps.push('Discriminant Δ = 18abcd − 4b³d + b²c² − 4ac³ − 27a²d² = ' + strA(Dl) + (sgn(Dl) > 0 ? ' > 0: three distinct real roots.' : ' < 0: one real root and a complex-conjugate pair.'));
  const A = num(a), B = num(b) / A, C = num(c) / A, Dd = num(d) / A;
  const p = C - (B * B) / 3, qq = (2 * B * B * B) / 27 - (B * C) / 3 + Dd, shift = -B / 3;
  steps.push('Substitute x = t − b/3a to get t³ + pt + q = 0 with p ≈ ' + approx(p) + ', q ≈ ' + approx(qq));
  const polish = (x: number) => {
    for (let k = 0; k < 60; k++) {
      const f = ((x + B) * x + C) * x + Dd, fp = (3 * x + 2 * B) * x + C; if (!fp) break;
      const nx = x - f / fp; if (Math.abs(nx - x) <= 1e-15 * Math.max(1, Math.abs(x))) { x = nx; break; } x = nx;
    }
    return x;
  };
  let roots: Root[];
  if (sgn(Dl) > 0) {
    const m = 2 * Math.sqrt(-p / 3), th = Math.acos(Math.max(-1, Math.min(1, (3 * qq) / (p * m)))) / 3;
    roots = [0, 1, 2].map((k) => ({ f: polish(m * Math.cos(th - (2 * Math.PI * k) / 3) + shift) })).sort((x, y) => x.f - y.f);
    steps.push('Trigonometric method: t = 2√(−p/3)·cos(⅓·arccos(3q/2p·√(−3/p)) − 2πk/3), k = 0, 1, 2');
  } else {
    const disc = (qq * qq) / 4 + (p * p * p) / 27, sq = Math.sqrt(Math.max(0, disc));
    const r = polish(Math.cbrt(-qq / 2 + sq) + Math.cbrt(-qq / 2 - sq) + shift);
    const e1 = B + r, e0 = C + r * e1; // x² + e1 x + e0 after dividing out (x − r)
    const re = -e1 / 2, im = Math.sqrt(Math.max(0, e0 - (e1 * e1) / 4));
    roots = [{ f: r }, { f: re, fi: im }, { f: re, fi: -im }];
    steps.push('Cardano: t = ∛(−q/2 + √(q²/4 + p³/27)) + ∛(−q/2 − √(q²/4 + p³/27)), then x = t − b/3a ≈ ' + approx(r));
    steps.push('Dividing out (x − ' + approx(r) + ') leaves a quadratic whose roots are ' + approx(re) + ' ± ' + approx(im) + 'i');
  }
  return { kind: 'cubic', roots, steps, numeric: true };
}

const snap = (A: Q[][]) => A.map((r) => r.map(str));
const paren = (x: Q) => (sgn(x) < 0 || x.d !== 1n ? '(' + str(x) + ')' : str(x));
const coefText = (x: Q) => (eq(x, ONE) ? '' : x.d !== 1n ? '(' + str(x) + ')' : str(x));
/** Gauss–Jordan on an augmented matrix of rationals, recording each step. */
export function solveSystem(M: Q[][], vars: string[]): Solved {
  const n = vars.length, rows = M.length, A = M.map((r) => r.slice()), steps: Solved['steps'] = [], pivots: number[] = [];
  let row = 0;
  steps.push({ text: 'Augmented matrix', m: snap(A) });
  for (let col = 0; col < n && row < rows; col++) {
    let r = -1;
    for (let i = row; i < rows; i++) if (!isZ(A[i][col])) { r = i; break; }
    if (r < 0) continue;
    const ops: string[] = [];
    if (r !== row) { const t = A[r]; A[r] = A[row]; A[row] = t; ops.push('R' + (row + 1) + ' ↔ R' + (r + 1)); }
    const pv = A[row][col];
    if (!eq(pv, ONE)) { A[row] = A[row].map((x) => div(x, pv)); ops.push('R' + (row + 1) + ' ← R' + (row + 1) + ' ÷ ' + paren(pv)); }
    for (let i = 0; i < rows; i++) {
      if (i === row || isZ(A[i][col])) continue;
      const f = A[i][col];
      A[i] = A[i].map((x, j) => sub(x, mul(f, A[row][j])));
      ops.push('R' + (i + 1) + ' ← R' + (i + 1) + (sgn(f) > 0 ? ' − ' + coefText(f) : ' + ' + coefText(neg(f))) + 'R' + (row + 1));
    }
    if (ops.length) steps.push({ text: 'Column ' + vars[col] + ': ' + ops.join(',  '), m: snap(A) });
    pivots.push(col); row++;
  }
  for (let i = row; i < rows; i++) if (!isZ(A[i][n])) {
    steps.push({ text: 'Row ' + (i + 1) + ' says 0 = ' + str(A[i][n]) + ', which is impossible.' });
    return { kind: 'none', steps };
  }
  if (pivots.length < n) {
    const free: number[] = []; for (let c = 0; c < n; c++) if (pivots.indexOf(c) < 0) free.push(c);
    const names = ['t', 's', 'u'], param: Record<number, string> = {};
    free.forEach((fc, k) => { param[fc] = names[k]; });
    const sol = vars.map((v, c) => {
      if (param[c]) return v + ' = ' + param[c];
      const pr = pivots.indexOf(c), terms: { neg: boolean; t: string }[] = [], k0 = A[pr][n];
      free.forEach((fc) => { const co = neg(A[pr][fc]); if (!isZ(co)) terms.push({ neg: sgn(co) < 0, t: coefText({ n: babs(co.n), d: co.d }) + param[fc] }); });
      let s = isZ(k0) && terms.length ? '' : str(k0);
      terms.forEach((tm, k) => { s += s || k ? (tm.neg ? ' − ' : ' + ') + tm.t : (tm.neg ? '−' : '') + tm.t; });
      return v + ' = ' + s;
    });
    steps.push({ text: 'Only ' + pivots.length + ' pivot' + (pivots.length === 1 ? '' : 's') + ' for ' + n + ' unknowns: ' + free.map((fc) => vars[fc]).join(', ') + ' can be anything.' });
    return { kind: 'many', param: sol, steps };
  }
  const vals = vars.map((_, c) => A[pivots.indexOf(c)][n]);
  steps.push({ text: 'Read off the solution: ' + vars.map((v, k) => v + ' = ' + str(vals[k])).join(', ') });
  const check = M.every((r) => { let s = ZERO; for (let j = 0; j < n; j++) s = add(s, mul(r[j], vals[j])); return eq(s, r[n]); });
  steps.push({ text: check ? 'Check: substituting back satisfies every equation ✓' : 'Check failed' });
  return { kind: 'one', vals, steps };
}

const coef = z.union([z.number(), z.string()]);
const SUB = '₀₁₂₃₄₅₆₇₈₉';

export default defineTool({
  name: 'calc_equation',
  title: 'Equation solver',
  webSlug: 'equation-solver',
  description:
    'Solve equations exactly with worked steps, like the website: linear a·x + b = c, quadratic a·x² + b·x + c = 0 (exact ' +
    'rational or surd roots like 1/2 + √5/2, complex roots), cubic a·x³ + b·x² + c·x + d = 0 (rational root test, else ' +
    'trigonometric/Cardano to 10 significant digits), and systems of 2 or 3 linear equations (Gauss–Jordan; no solution and ' +
    'infinitely many solutions are detected and parametrised). Coefficients may be integers, decimals, fractions ("3/4"), ' +
    `mixed numbers ("-1 1/2") or e-notation. Web version: ${webUrl('equation-solver')}`,
  inputSchema: z.object({
    type: z.enum(['linear', 'quadratic', 'cubic', 'system']).describe('Equation type.'),
    coefficients: z.array(coef).optional().describe('linear: [a, b, c] for a·x + b = c; quadratic: [a, b, c]; cubic: [a, b, c, d].'),
    system: z.array(z.array(coef)).optional().describe('system: rows of the augmented matrix, 2 rows of [a, b, rhs] (x, y) or 3 rows of [a, b, c, rhs] (x, y, z).'),
  }),
  outputSchema: z.object({
    equation: z.string(), kind: z.string(), result: z.array(z.string()),
    roots: z.array(z.object({ text: z.string(), re: z.number(), im: z.number(), exact: z.boolean() })).optional(),
    solution: z.record(z.string(), z.object({ exact: z.string(), value: z.number() })).optional(),
    parametric: z.array(z.string()).optional(),
    discriminant: z.string().optional(),
    steps: z.array(z.object({ text: z.string(), matrix: z.array(z.array(z.string())).optional() })),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { type: 'quadratic', coefficients: [1, -1, -1] }, note: 'x = 1/2 ± √5/2' },
    { input: { type: 'system', system: [[1, 1, 1, 6], [0, 2, 5, -4], [2, 5, -1, 27]] }, note: 'x = 5, y = 3, z = −2' },
  ],
  run(input) {
    let out: Solved, equation: string, vars: string[] = ['x'];
    if (input.type === 'system') {
      const rows = input.system;
      if (!rows || (rows.length !== 2 && rows.length !== 3)) throw err('system needs 2 or 3 rows.');
      const n = rows.length;
      if (rows.some((r) => r.length !== n + 1)) throw err(`Each row needs ${n + 1} numbers: ${n === 2 ? '[a, b, rhs] for a·x + b·y = rhs' : '[a, b, c, rhs] for a·x + b·y + c·z = rhs'}.`);
      vars = n === 2 ? ['x', 'y'] : ['x', 'y', 'z'];
      const M = rows.map((r) => r.map(parseCoef));
      equation = M.map((row) => lin(row.slice(0, n), vars, row[n])).join('   ·   ');
      out = solveSystem(M, vars);
    } else {
      const need = { linear: 3, quadratic: 3, cubic: 4 }[input.type];
      const raw = input.coefficients ?? [];
      if (raw.length > need) throw err(`${input.type} takes ${need} coefficients.`);
      const c = Array.from({ length: need }, (_, i) => parseCoef(raw[i]));
      if (input.type === 'linear') { equation = poly([c[0], c[1]]) + ' = ' + str(c[2]); out = solveLinear(c[0], c[1], c[2]); }
      else if (input.type === 'quadratic') { equation = poly(c) + ' = 0'; out = solveQuadratic(c[0], c[1], c[2]); }
      else { equation = poly(c) + ' = 0'; out = solveCubic(c[0], c[1], c[2], c[3]); }
    }
    const result: string[] = [];
    const res: Record<string, unknown> = { equation, kind: out.kind };
    if (out.kind === 'none') result.push('No solution');
    else if (out.kind === 'all') result.push('Every x is a solution');
    else if (out.kind === 'many') { result.push('Infinitely many solutions'); result.push(...out.param!); res.parametric = out.param; }
    else if (out.vals) {
      out.vals.forEach((v, k) => result.push(vars[k] + ' = ' + strA(v)));
      res.solution = Object.fromEntries(out.vals.map((v, k) => [vars[k], { exact: str(v), value: num(v) }]));
    } else {
      const rs = out.roots!, multi = rs.length > 1;
      if (out.kind === 'double') result.push('x = ' + rootText(rs[0]) + ' (repeated root, multiplicity 2)');
      else rs.forEach((x, k) => result.push((multi ? 'x' + SUB[k + 1] : 'x') + ' = ' + rootText(x) + (x.im || x.fi ? ' (complex)' : '')));
      res.roots = rs.map((x) => { const v = rootVal(x); return { text: rootText(x), re: +v[0].toPrecision(15), im: +v[1].toPrecision(15), exact: x.f === undefined }; });
      if (out.D) { res.discriminant = strA(out.D); result.push('Discriminant Δ = ' + strA(out.D)); }
      if (out.numeric) result.push('Irrational roots, shown to 10 significant digits.');
    }
    res.result = result;
    res.steps = out.steps.map((s) => (typeof s === 'string' ? { text: s } : { text: s.text, ...(s.m ? { matrix: s.m } : {}) }));
    return res;
  },
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';

// Ported from https://github.com/s3eidat/sci-calc (app.js): tokenizer → recursive-descent parser → closures.
// No eval, no globals: names resolve only to the built-in functions/constants and the caller's variables.
// Precedence (low → high): + −  |  × ÷ and implicit multiplication  |  unary −  |  ^ (right-assoc)  |  postfix ! %
// so 2^3^2 = 512, −2^2 = −4, 2(3+4) = 14, 2x^2 = 2·(x²).
export type Angle = 'deg' | 'rad' | 'grad';
type Fn = { arity: number | [number, number]; f: (...a: never[]) => number; angle: boolean };
const FN: Record<string, Fn> = Object.create(null), CONST: Record<string, number> = Object.create(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function def(name: string, arity: Fn['arity'], f: (...a: any[]) => number, angle = false) { FN[name] = { arity, f, angle }; }
const snap = (v: number) => (Math.abs(v) < 1e-15 ? 0 : v);
/** Trig in degrees is exact at multiples of 90° (sin 180° = 0, cos 90° = 0, tan 90° undefined). */
function trig(name: string, x: number, mode: Angle) {
  const deg = mode === 'deg' ? x : mode === 'grad' ? x * 0.9 : null;
  if (deg !== null && isFinite(deg) && deg % 90 === 0) {
    const q = (((deg / 90) % 4) + 4) % 4, s = [0, 1, 0, -1][q], c = [1, 0, -1, 0][q];
    if (name === 'sin') return s; if (name === 'cos') return c;
    if (name === 'tan') return c === 0 ? NaN : s / c; if (name === 'cot') return s === 0 ? NaN : c / s;
    if (name === 'sec') return c === 0 ? NaN : 1 / c; if (name === 'csc') return s === 0 ? NaN : 1 / s;
  }
  const r = deg !== null ? (deg * Math.PI) / 180 : x;
  const v = name === 'sin' ? Math.sin(r) : name === 'cos' ? Math.cos(r) : name === 'tan' ? Math.tan(r) : name === 'sec' ? 1 / Math.cos(r) : name === 'csc' ? 1 / Math.sin(r) : 1 / Math.tan(r);
  return snap(v);
}
const inv = (v: number, mode: Angle) => (mode === 'deg' ? (v * 180) / Math.PI : mode === 'grad' ? (v * 200) / Math.PI : v);
['sin', 'cos', 'tan', 'sec', 'csc', 'cot'].forEach((n) => def(n, 1, (x: number, m: Angle) => trig(n, x, m), true));
def('asin', 1, (x: number, m: Angle) => inv(Math.asin(x), m), true); def('acos', 1, (x: number, m: Angle) => inv(Math.acos(x), m), true);
def('atan', 1, (x: number, m: Angle) => inv(Math.atan(x), m), true);
def('atan2', 2, (y: number, x: number, m: Angle) => inv(Math.atan2(y, x), m), true);
def('sinh', 1, Math.sinh); def('cosh', 1, Math.cosh); def('tanh', 1, Math.tanh);
def('asinh', 1, Math.asinh); def('acosh', 1, Math.acosh); def('atanh', 1, Math.atanh);
def('sqrt', 1, Math.sqrt); def('cbrt', 1, Math.cbrt); def('abs', 1, Math.abs); def('exp', 1, Math.exp);
def('ln', 1, Math.log); def('log10', 1, Math.log10); def('log2', 1, Math.log2);
def('log', [1, 2], (x: number, b?: number) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)));
def('root', 2, (x: number, n: number) => (x < 0 && Math.round(n) === n && n % 2 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)));
def('floor', 1, Math.floor); def('ceil', 1, Math.ceil); def('round', 1, Math.round); def('sign', 1, Math.sign);
def('min', [1, 99], Math.min); def('max', [1, 99], Math.max);
def('mod', 2, (a: number, b: number) => a - b * Math.floor(a / b));
def('nCr', 2, (n: number, r: number) => comb(n, r, false)); def('nPr', 2, (n: number, r: number) => comb(n, r, true));
def('fact', 1, factorial); def('gamma', 1, gamma);
CONST.pi = Math.PI; CONST['π'] = Math.PI; CONST.e = Math.E; CONST.tau = 2 * Math.PI; CONST.phi = (1 + Math.sqrt(5)) / 2;
function comb(n: number, r: number, perm: boolean) {
  if (!(Number.isInteger(n) && Number.isInteger(r)) || n < 0 || r < 0 || r > n) return NaN;
  let v = 1;
  if (perm) { for (let i = 0; i < r; i++) v *= n - i; return v; }
  r = Math.min(r, n - r);
  for (let i = 1; i <= r; i++) v = (v * (n - r + i)) / i;
  return Math.round(v);
}
export function factorial(n: number): number {
  if (Number.isInteger(n)) { if (n < 0) return NaN; if (n > 170) return Infinity; let v = 1; for (let i = 2; i <= n; i++) v *= i; return v; }
  return gamma(n + 1);
}
const LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
/** Lanczos approximation. */
export function gamma(z: number): number {
  if (Number.isInteger(z) && z <= 0) return NaN;
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = LG[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) x += LG[i] / (z + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

export class ExprError extends ToolError { constructor(msg: string, public pos: number) { super(msg); } }
type Tok = { t: 'num'; v: number; p: number } | { t: 'id' | 'op'; v: string; p: number };
function tokenize(src: string): Tok[] {
  const s = String(src).replace(/[−–]/g, '-').replace(/[×·∙]/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^').replace(/²/g, '^2').replace(/³/g, '^3');
  const out: Tok[] = [];
  let i = 0, m: RegExpExecArray | null;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i)))) { out.push({ t: 'num', v: parseFloat(m[0]), p: i }); i += m[0].length; continue; }
    if ((m = /^[A-Za-zπθ][A-Za-z0-9πθ]*/.exec(s.slice(i)))) { out.push({ t: 'id', v: m[0], p: i }); i += m[0].length; continue; }
    if ('+-*/^()!%,√'.indexOf(c) >= 0) { out.push({ t: 'op', v: c, p: i }); i++; continue; }
    throw new ExprError('Unexpected character "' + c + '"', i);
  }
  return out;
}
/** Split an unknown run like "ax" or "pix" into known names (a·x, π·x). Functions may only come last. */
function split(word: string, vars: Set<string>, beforeParen: boolean) {
  const memo: Record<number, string[] | null> = {};
  function go(i: number): string[] | null {
    if (i === word.length) return [];
    if (i in memo) return memo[i];
    let best: string[] | null = null;
    for (let j = word.length; j > i; j--) {
      const part = word.slice(i, j);
      const isFn = part in FN && j === word.length && beforeParen, isVal = part in CONST || vars.has(part);
      if (!isFn && !isVal) continue;
      const rest = go(j);
      if (rest) { best = [part].concat(rest); break; }
    }
    return (memo[i] = best);
  }
  return go(0);
}
type Node = { t: 'num'; v: number } | { t: 'var'; n: string } | { t: 'neg'; a: Node } | { t: 'bin'; op: string; a: Node; b: Node } | { t: 'call'; f: string; args: Node[] };
export function parse(src: string, opts: { vars?: string[]; percent?: boolean } = {}) {
  const vars = new Set(opts.vars || []), used = new Set<string>();
  let toks = tokenize(src), k = 0;
  const t2: Tok[] = [];
  toks.forEach((t, idx) => {
    if (t.t !== 'id') { t2.push(t); return; }
    const next = toks[idx + 1], paren = !!(next && next.t === 'op' && next.v === '(');
    if ((t.v in FN && paren) || t.v in CONST || vars.has(t.v)) { t2.push(t); return; }
    const parts = split(t.v, vars, paren);
    if (!parts) throw new ExprError(t.v in FN ? t.v + ' needs brackets, like ' + t.v + '(x)' : 'Unknown name "' + t.v + '"', t.p);
    parts.forEach((p) => t2.push({ t: 'id', v: p, p: t.p }));
  });
  toks = t2;
  const peek = () => toks[k];
  const isOp = (v: string) => { const t = toks[k]; return !!t && t.t === 'op' && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw new ExprError('Expected "' + v + '"', toks[k] ? toks[k].p : String(src).length); k++; };
  const startsPrimary = (t: Tok | undefined) => !!t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && (t.v === '(' || t.v === '√')));
  function sum(): Node { let n = product(); while (isOp('+') || isOp('-')) { const op = toks[k++].v as string; n = { t: 'bin', op, a: n, b: product() }; } return n; }
  function product(): Node {
    let n = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) { const op = toks[k++].v as string; n = { t: 'bin', op, a: n, b: unary() }; }
      else if (startsPrimary(peek())) {
        if (peek().t === 'num') throw new ExprError('Missing operator before ' + peek().v, peek().p); // "3 4" is a typo, not 12
        n = { t: 'bin', op: '*', a: n, b: unary() }; // implicit: 2x, 2(3+4), (a)(b)
      } else return n;
    }
  }
  function unary(): Node {
    if (isOp('-')) { k++; return { t: 'neg', a: unary() }; }
    if (isOp('+')) { k++; return unary(); }
    if (isOp('√')) { k++; return { t: 'call', f: 'sqrt', args: [unary()] }; }
    return power();
  }
  function power(): Node { const base = postfix(); if (isOp('^')) { k++; return { t: 'bin', op: '^', a: base, b: unary() }; } return base; } // right-assoc, allows 2^-1
  function postfix(): Node {
    let n = primary();
    for (;;) {
      if (isOp('!')) { k++; n = { t: 'call', f: 'fact', args: [n] }; }
      else if (isOp('%') && opts.percent) { k++; n = { t: 'bin', op: '/', a: n, b: { t: 'num', v: 100 } }; }
      else return n;
    }
  }
  function primary(): Node {
    const t = toks[k];
    if (!t) throw new ExprError('Unexpected end', String(src).length);
    if (t.t === 'num') { k++; return { t: 'num', v: t.v }; }
    if (t.t === 'op' && t.v === '(') { k++; const e = sum(); expect(')'); return e; }
    if (t.t === 'id') {
      k++;
      if (t.v in FN && isOp('(')) {
        k++;
        const args: Node[] = [];
        if (!isOp(')')) { args.push(sum()); while (isOp(',')) { k++; args.push(sum()); } }
        expect(')');
        const ar = FN[t.v].arity, lo = Array.isArray(ar) ? ar[0] : ar, hi = Array.isArray(ar) ? ar[1] : ar;
        if (args.length < lo || args.length > hi) throw new ExprError(t.v + ' takes ' + (lo === hi ? lo : lo + '–' + hi) + ' argument' + (hi === 1 ? '' : 's'), t.p);
        return { t: 'call', f: t.v, args };
      }
      if (t.v in CONST) return { t: 'num', v: CONST[t.v] };
      if (vars.has(t.v)) { used.add(t.v); return { t: 'var', n: t.v }; }
      throw new ExprError('Unknown name "' + t.v + '"', t.p);
    }
    throw new ExprError('Unexpected "' + t.v + '"', t.p);
  }
  if (!toks.length) throw new ExprError('Empty expression', 0);
  const ast = sum();
  if (k < toks.length) throw new ExprError('Unexpected "' + toks[k].v + '"', toks[k].p);
  return { ast, used };
}
type Env = Record<string, number>;
/** Closures over the AST: variables are read from a null-prototype map, never from globals. */
export function compile(ast: Node, angle: Angle = 'rad'): (env: Env) => number {
  function c(n: Node): (env: Env) => number {
    if (n.t === 'num') { const v = n.v; return () => v; }
    if (n.t === 'var') { const name = n.n; return (env) => { const x = env[name]; return typeof x === 'number' ? x : NaN; }; }
    if (n.t === 'neg') { const a = c(n.a); return (env) => -a(env); }
    if (n.t === 'bin') {
      const l = c(n.a), r = c(n.b);
      switch (n.op) {
        case '+': return (e) => l(e) + r(e);
        case '-': return (e) => l(e) - r(e);
        case '*': return (e) => l(e) * r(e);
        case '/': return (e) => l(e) / r(e);
        case '^': return (e) => {
          const b = l(e), p = r(e);
          if (b < 0 && !Number.isInteger(p)) { const q = 1 / p; if (Number.isInteger(Math.round(q * 1e9) / 1e9) && Math.round(q) % 2) return -Math.pow(-b, p); } // (−8)^(1/3) = −2
          return Math.pow(b, p);
        };
      }
    }
    if (n.t === 'call') {
      const fn = FN[n.f], args = n.args.map(c);
      return (e) => { const vals: unknown[] = args.map((g) => g(e)); if (fn.angle) vals.push(angle); return (fn.f as (...a: unknown[]) => number)(...vals); };
    }
    throw new ExprError('Bad expression', 0);
  }
  return c(ast);
}
export function evaluate(src: string, env: Env = {}, opts: { angle?: Angle; percent?: boolean } = {}) {
  const p = parse(src, { vars: Object.keys(env), percent: opts.percent });
  const e: Env = Object.create(null);
  for (const key in env) if (Object.prototype.hasOwnProperty.call(env, key)) e[key] = env[key];
  return compile(p.ast, opts.angle)(e);
}

const SUP: Record<string, string> = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
/** Text you can paste back in (12 significant digits). */
export const plain = (v: number) => (isFinite(v) ? String(+v.toPrecision(12)) : String(v));
export function show(v: number, fmt: 'norm' | 'sci' = 'norm') {
  if (isNaN(v)) return 'Undefined';
  if (!isFinite(v)) return v > 0 ? '∞' : '−∞';
  const r = +v.toPrecision(12), a = Math.abs(r);
  if (fmt === 'sci' || (a !== 0 && (a >= 1e15 || a < 1e-9))) {
    const p = r.toExponential(fmt === 'sci' ? 9 : 11).split('e'), m = p[0].replace(/\.?0+$/, ''), ex = +p[1];
    return m.replace('-', '−') + ' × 10' + String(ex).split('').map((ch) => SUP[ch]).join('');
  }
  const s = String(r), neg = s[0] === '-', parts = (neg ? s.slice(1) : s).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : '') + parts.join('.');
}

export default defineTool({
  name: 'calc_expression',
  title: 'Scientific calculator',
  webSlug: 'sci-calc',
  description:
    'Evaluate a maths expression safely with the website\'s own parser (never eval): + − × ÷ ^ (right-associative), implicit ' +
    'multiplication (2(3+4), 2x), postfix ! and %, √, brackets; functions sin cos tan sec csc cot (+ asin acos atan atan2) in ' +
    'degrees (default), radians or grads, sinh cosh tanh and inverses, sqrt cbrt root(x,n) abs exp ln log(x[,base]) log10 log2 ' +
    'floor ceil round sign min max mod nCr nPr fact gamma; constants pi π e tau phi; "ans" and your own variables. Results to ' +
    `12 significant digits, plain or scientific notation. Web version: ${webUrl('sci-calc')}`,
  inputSchema: z.object({
    expression: z.string().min(1).max(2000).describe('The expression, e.g. "sin(30) + 2^3^2", "5!/(2!×3!)", "200×15%".'),
    angle: z.enum(['deg', 'rad', 'grad']).optional().default('deg').describe('Angle unit for trig functions.'),
    variables: z.record(z.string().regex(/^[A-Za-zθ][A-Za-z0-9θ]*$/), z.number()).optional().describe('Variables to use, e.g. {"x": 2, "r": 5}.'),
    ans: z.number().optional().describe('Value of "ans" (the previous answer). Default 0.'),
    format: z.enum(['norm', 'sci']).optional().default('norm').describe('Display: normal, or always scientific notation.'),
  }),
  outputSchema: z.object({ value: z.number().nullable(), display: z.string(), plain: z.string(), finite: z.boolean() }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { expression: 'sin(30) + cos(60)' }, output: { value: 1, display: '1' } },
    { input: { expression: 'nCr(52, 5)' }, output: { value: 2598960, display: '2,598,960' } },
  ],
  run(input) {
    const env: Env = { ans: input.ans ?? 0, ...(input.variables ?? {}) };
    const v = evaluate(input.expression, env, { angle: input.angle, percent: true });
    return { value: isFinite(v) ? +v.toPrecision(15) : null, display: show(v, input.format), plain: plain(v), finite: isFinite(v) };
  },
});

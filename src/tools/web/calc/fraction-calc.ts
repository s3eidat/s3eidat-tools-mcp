import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';

// Ported from https://github.com/s3eidat/fraction-calc (app.js): exact rational arithmetic with BigInt, nothing rounded.
export interface Q { n: bigint; d: bigint; raw?: boolean }

const babs = (a: bigint) => (a < 0n ? -a : a);
export function gcd(a: bigint, b: bigint) { a = babs(a); b = babs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
const lcm = (a: bigint, b: bigint) => (a / gcd(a, b)) * b;
const err = (m: string) => new ToolError(m);
export function R(n: bigint | number | string, d: bigint | number | string = 1n): Q {
  let N = BigInt(n), D = BigInt(d);
  if (D === 0n) throw err('Division by zero');
  if (D < 0n) { N = -N; D = -D; }
  const g = gcd(N, D) || 1n;
  return { n: N / g, d: D / g };
}
const raw = (n: bigint, d: bigint): Q => ({ n, d, raw: true }); // unsimplified, for showing steps
const add = (a: Q, b: Q) => R(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q) => R(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => R(a.n * b.n, a.d * b.d);
function div(a: Q, b: Q) { if (b.n === 0n) throw err('Division by zero'); return R(a.n * b.d, a.d * b.n); }
function pow(a: Q, e: Q) {
  if (e.d !== 1n) throw err('Only whole-number powers keep a fraction exact');
  const k = e.n < 0n ? -e.n : e.n;
  if (k > 4096n) throw err('Power too large');
  const r = R(a.n ** k, a.d ** k);
  return e.n < 0n ? div(R(1), r) : r;
}
export function cmp(a: Q, b: Q) { const x = a.n * b.d, y = b.n * a.d; return x < y ? -1 : x > y ? 1 : 0; }
const eq = (a: Q, b: Q) => a.n === b.n && a.d === b.d;
export const str = (a: Q) => (a.d === 1n ? String(a.n) : a.n + '/' + a.d);
export function mixed(a: Q) {
  if (a.d === 1n || babs(a.n) < a.d) return null;
  const neg = a.n < 0n, n = babs(a.n);
  return { neg, w: n / a.d, n: n % a.d, d: a.d };
}
export function mixedStr(a: Q) { const m = mixed(a); return m ? (m.neg ? '-' : '') + m.w + (m.n ? ' ' + m.n + '/' + m.d : '') : str(a); }

/** Exact decimal expansion with the repeating block in brackets: 1/7 → 0.(142857). */
export function decimal(a: Q, maxDigits = 2000) {
  const neg = a.n < 0n, n = babs(a.n), d = a.d, ip = n / d, seen = new Map<bigint, number>();
  let r = n % d, digits = '', rep = -1;
  while (r !== 0n && digits.length < maxDigits) {
    if (seen.has(r)) { rep = seen.get(r)!; break; }
    seen.set(r, digits.length);
    r *= 10n; digits += String(r / d); r %= d;
  }
  let s = (neg && (ip || digits) ? '-' : '') + ip;
  if (digits) s += '.' + (rep >= 0 ? digits.slice(0, rep) + '(' + digits.slice(rep) + ')' : digits + (r !== 0n ? '…' : ''));
  return { text: s, repeating: rep >= 0, cut: rep < 0 && r !== 0n };
}
/** Rounded decimal for display: 2/3 → 0.666667. */
export function approx(a: Q, places: number) {
  const neg = a.n < 0n, scale = 10n ** BigInt(places), n = babs(a.n) * scale * 2n + a.d, q = n / (2n * a.d);
  const s = q.toString().padStart(places + 1, '0');
  let out = s.slice(0, s.length - places) + (places ? '.' + s.slice(-places) : '');
  out = out.replace(/\.?0+$/, '') || '0';
  return (neg && out !== '0' ? '-' : '') + out;
}
export const percent = (v: Q) => decimal(mul(v, R(100))).text + '%';

const arDigits = (s: string) => s.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x660));
interface DecInfo { ip: string; fp: string; rp: string; all?: bigint; head?: bigint }
/** Parse a decimal like "-1.2(34)", "0.(3)", "12.5", "3". */
export function parseDecimal(s: string) {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*)(?:\((\d+)\))?)?\s*$/.exec(arDigits(String(s)).replace(/\u066b/g, '.').replace(/,/g, ''));
  if (!m || (!m[2] && !m[3] && !m[4])) return null;
  const sign = m[1] === '-' ? -1n : 1n, ip = m[2] || '0', fp = m[3] || '', rp = m[4] || '';
  const info: DecInfo = { ip, fp, rp };
  let val: Q;
  if (!rp) val = R(BigInt(ip + fp), 10n ** BigInt(fp.length));
  else {
    const all = BigInt(ip + fp + rp), head = BigInt(ip + fp);
    val = R(all - head, 10n ** BigInt(fp.length) * (10n ** BigInt(rp.length) - 1n));
    info.all = all; info.head = head;
  }
  return { v: R(val.n * sign, val.d), info, neg: sign < 0n };
}

// ---------- expression parser over rationals ----------
// Literals: 3, 3/4 (binds tighter than ÷), 2 3/4 (mixed), 0.25, 0.(3). Operators: + − × ÷ * / : ^ and brackets.
type Lit = { kind: 'mixed'; w: bigint; n: bigint; d: bigint } | { kind: 'frac'; n: bigint; d: bigint } | { kind: 'dec' | 'int'; text: string };
type Tok = { t: 'num'; v: Q; lit: Lit } | { t: 'op'; v: string };
export type Step = { op: 'mixed'; lit: Extract<Lit, { kind: 'mixed' }>; r: Q } | { op: 'simp'; a: Q; r: Q } | { op: 'dec'; text: string; r: Q } | { op: string; a: Q; b: Q; r: Q };

function tokenize(src: string): Tok[] {
  const s = arDigits(String(src).replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/[÷:]/g, '÷')).replace(/\u066b/g, '.');
  const out: Tok[] = [];
  let i = 0, m: RegExpExecArray | null;
  while (i < s.length) {
    const rest = s.slice(i);
    if (/^\s/.test(rest)) { i++; continue; }
    if ((m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)/.exec(rest))) { // mixed number
      const w = BigInt(m[1]), fn = BigInt(m[2]), fd = BigInt(m[3]);
      if (fd === 0n) throw err("A fraction can't have 0 as its denominator");
      out.push({ t: 'num', v: R(w * fd + fn, fd), lit: { kind: 'mixed', w, n: fn, d: fd } }); i += m[0].length; continue;
    }
    if ((m = /^(\d+)\s*\/\s*(\d+)/.exec(rest))) {
      if (BigInt(m[2]) === 0n) throw err("A fraction can't have 0 as its denominator");
      out.push({ t: 'num', v: R(m[1], m[2]), lit: { kind: 'frac', n: BigInt(m[1]), d: BigInt(m[2]) } }); i += m[0].length; continue;
    }
    if ((m = /^(\d*\.\d*(?:\(\d+\))?|\d+)/.exec(rest)) && m[0] !== '.') {
      const p = parseDecimal(m[0]); if (!p) throw err('Can\'t read "' + m[0] + '"');
      out.push({ t: 'num', v: p.v, lit: { kind: /\./.test(m[0]) ? 'dec' : 'int', text: m[0] } }); i += m[0].length; continue;
    }
    if ('+-*/÷^()'.indexOf(s[i]) >= 0) { out.push({ t: 'op', v: s[i] }); i++; continue; }
    throw err('Unexpected "' + s[i] + '"');
  }
  return out;
}
export function evaluate(src: string): { v: Q; steps: Step[] } {
  const toks = tokenize(src), steps: Step[] = [];
  let k = 0;
  if (!toks.length) throw err('Type an expression');
  const is = (v: string) => { const t = toks[k]; return !!t && t.t === 'op' && t.v === v; };
  function binop(op: string, a: Q, b: Q) {
    const r = op === '+' ? add(a, b) : op === '-' ? sub(a, b) : op === '×' ? mul(a, b) : div(a, b);
    steps.push({ op, a, b, r });
    return r;
  }
  function expr(): Q { let a = term(); while (is('+') || is('-')) { const op = (toks[k++] as { v: string }).v; a = binop(op, a, term()); } return a; }
  function term(): Q { let a = unary(); while (is('*') || is('/') || is('÷')) { const op = (toks[k++] as { v: string }).v; a = binop(op === '*' ? '×' : '÷', a, unary()); } return a; }
  function unary(): Q { if (is('-')) { k++; const v = unary(); return R(-v.n, v.d); } if (is('+')) { k++; return unary(); } return power(); }
  function power(): Q { const b = primary(); if (is('^')) { k++; const e = unary(); const r = pow(b, e); steps.push({ op: '^', a: b, b: e, r }); return r; } return b; }
  function primary(): Q {
    const t = toks[k];
    if (!t) throw err('The expression ends too early');
    if (t.t === 'num') {
      k++;
      if (t.lit.kind === 'mixed') steps.push({ op: 'mixed', lit: t.lit, r: t.v });
      else if (t.lit.kind === 'frac' && (t.lit.n !== t.v.n || t.lit.d !== t.v.d)) steps.push({ op: 'simp', a: raw(t.lit.n, t.lit.d), r: t.v });
      else if (t.lit.kind === 'dec') steps.push({ op: 'dec', text: t.lit.text, r: t.v });
      return t.v;
    }
    if (t.v === '(') { k++; const v = expr(); if (!is(')')) throw err('Missing ")"'); k++; return v; }
    throw err('Unexpected "' + t.v + '"');
  }
  const v = expr();
  if (k < toks.length) throw err('Unexpected "' + String(toks[k].t === 'op' ? toks[k].v : str(toks[k].v as Q)) + '"');
  return { v, steps };
}

// ---------- worked steps as text ----------
export interface StepText { text: string; math?: string }
const F = (a: Q) => (a.d === 1n && !a.raw ? String(a.n) : a.n + '/' + a.d);
const par = (a: Q) => (a.n < 0n ? '(' + F(a) + ')' : F(a));
const gcdNote = (n: bigint, d: bigint) => { const g = gcd(n, d); return g > 1n ? ' (divide by ' + g + ')' : ''; };

export function stepText(s: Step): StepText[] {
  const items: StepText[] = [];
  if (s.op === 'mixed') {
    const L = (s as Extract<Step, { op: 'mixed' }>).lit, imp = raw(L.w * L.d + L.n, L.d);
    items.push({ text: 'Mixed number to improper fraction', math: L.w + ' ' + L.n + '/' + L.d + ' = ' + F(imp) + ' (' + L.w + ' × ' + L.d + ' + ' + L.n + ')' });
    if (!eq(s.r, R(L.w * L.d + L.n, L.d)) || L.d !== s.r.d) items.push({ text: 'Simplify', math: F(imp) + ' = ' + F(s.r) });
  } else if (s.op === 'simp') {
    const a = (s as Extract<Step, { op: 'simp' }>).a, g = a.n === 0n ? a.d : gcd(a.n, a.d);
    items.push({ text: 'Simplify (divide by ' + g + ')', math: F(a) + ' = ' + F(s.r) });
  } else if (s.op === 'dec') {
    items.push({ text: 'Decimal to fraction', math: (s as Extract<Step, { op: 'dec' }>).text + ' = ' + F(s.r) });
  } else {
    const { a, b } = s as { a: Q; b: Q }, r = s.r;
    if (s.op === '+' || s.op === '-') {
      const sym = s.op === '+' ? '+' : '−';
      if (a.d === b.d) {
        const top = s.op === '+' ? a.n + b.n : a.n - b.n;
        items.push({ text: 'Same denominator: ' + (s.op === '+' ? 'add' : 'subtract') + ' the numerators', math: F(a) + ' ' + sym + ' ' + par(b) + ' = ' + F(raw(top, a.d)) });
        if (top !== r.n || a.d !== r.d) items.push({ text: 'Simplify' + gcdNote(top, a.d), math: F(raw(top, a.d)) + ' = ' + F(r) });
      } else {
        const Lc = lcm(a.d, b.d), an = a.n * (Lc / a.d), bn = b.n * (Lc / b.d), t2 = s.op === '+' ? an + bn : an - bn;
        items.push({ text: 'Lowest common denominator of ' + a.d + ' and ' + b.d + ' is ' + Lc, math: F(a) + ' ' + sym + ' ' + par(b) + ' = ' + F(raw(an, Lc)) + ' ' + sym + ' ' + par(raw(bn, Lc)) });
        items.push({ text: (s.op === '+' ? 'Add' : 'Subtract') + ' the numerators', math: '= ' + F(raw(t2, Lc)) });
        if (t2 !== r.n || Lc !== r.d) items.push({ text: 'Simplify' + gcdNote(t2, Lc), math: '= ' + F(r) });
      }
    } else if (s.op === '×') {
      const pn = a.n * b.n, pd = a.d * b.d;
      items.push({ text: 'Multiply tops and bottoms', math: par(a) + ' × ' + par(b) + ' = ' + F(raw(pn, pd)) });
      if (pn !== r.n || pd !== r.d) items.push({ text: 'Simplify' + gcdNote(pn, pd), math: '= ' + F(r) });
    } else if (s.op === '÷') {
      const recip = R(b.d, b.n), qn = a.n * recip.n, qd = a.d * recip.d;
      items.push({ text: 'Dividing is multiplying by the reciprocal', math: par(a) + ' ÷ ' + par(b) + ' = ' + par(a) + ' × ' + par(recip) });
      items.push({ text: 'Multiply', math: '= ' + F(raw(qn, qd)) });
      if (qn !== r.n || qd !== r.d) items.push({ text: 'Simplify' + gcdNote(qn, qd), math: '= ' + F(r) });
    } else if (s.op === '^') {
      items.push({ text: 'Raise top and bottom to the power ' + b.n, math: par(a) + '^' + b.n + ' = ' + F(r) });
    }
  }
  return items;
}

/** The number with the point moved right, as text with its repeating tail. */
export function shift(I: DecInfo, places: number) {
  let ext = I.fp + I.rp;
  while (ext.length < places) ext += I.rp;
  const ip = (I.ip + ext.slice(0, places)).replace(/^0+(?=\d)/, '');
  const restStart = places - I.fp.length, k = ((restStart % I.rp.length) + I.rp.length) % I.rp.length;
  return ip + '.(' + I.rp.slice(k) + I.rp.slice(0, k) + ')';
}
function decSteps(p: NonNullable<ReturnType<typeof parseDecimal>>): StepText[] {
  const I = p.info, s: StepText[] = [];
  if (!I.rp) {
    const den = 10n ** BigInt(I.fp.length), nm = BigInt(I.ip + I.fp);
    s.push({ text: I.fp.length + ' decimal place' + (I.fp.length === 1 ? '' : 's') + ', so put it over ' + den, math: (p.neg ? '-' : '') + I.ip + (I.fp ? '.' + I.fp : '') + ' = ' + F(raw(p.neg ? -nm : nm, den)) });
    if (nm !== babs(p.v.n) || den !== p.v.d) s.push({ text: 'Simplify' + gcdNote(nm, den), math: '= ' + F(p.v) });
    return s;
  }
  const k = I.fp.length, r = I.rp.length, x = (p.neg ? '-' : '') + I.ip + '.' + I.fp + '(' + I.rp + ')';
  const A = 10n ** BigInt(k + r), B = 10n ** BigInt(k), top = I.all! - I.head!;
  s.push({ text: 'Let x = ' + x + '. The block "' + I.rp + '" repeats every ' + r + ' digit' + (r === 1 ? '' : 's') + '.' });
  s.push({ text: 'Multiply by ' + A + ' and by ' + B + ' so the repeating tails line up', math: A + 'x = ' + shift(I, k + r) + ';  ' + B + 'x = ' + shift(I, k) });
  s.push({ text: 'Subtract: the repeating parts cancel', math: (A - B) + 'x = ' + top });
  s.push({ text: 'Divide', math: 'x = ' + F(raw(p.neg ? -top : top, A - B)) });
  if (top !== babs(p.v.n) || A - B !== p.v.d) s.push({ text: 'Simplify' + gcdNote(top, A - B), math: 'x = ' + F(p.v) });
  return s;
}
/** Close fractions with small denominators (continued fractions): 3.14159 → 22/7, 355/113. */
export function convergents(v: Q, maxDen: bigint) {
  const out: Q[] = [];
  let n = v.n, d = v.d, h0 = 0n, h1 = 1n, k0 = 1n, k1 = 0n;
  for (let i = 0; i < 40 && d !== 0n; i++) {
    let a = n / d; if (n < 0n && n % d !== 0n) a -= 1n;
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    out.push(R(h2, k2));
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    const r = n - a * d; n = d; d = r;
  }
  return out;
}
function approxList(v: Q) {
  if (v.d <= 1000n) return undefined;
  const all = convergents(v, 100000n).filter((c) => c.d > 1n), list: Q[] = [];
  [10n, 100n, 1000n, 10000n, 100000n].forEach((cap) => { // the best one under each denominator size
    const best = all.filter((c) => c.d <= cap).pop();
    if (best && !list.some((x) => eq(x, best))) list.push(best);
  });
  return list.length ? list.map((c) => ({ fraction: str(c), approx: approx(c, 8) })) : undefined;
}
function divSteps(v: Q): StepText[] {
  const s: StepText[] = [], m = mixed(v);
  if (m && m.n) s.push({ text: 'Whole part ' + m.w + ', remainder ' + m.n + '/' + m.d, math: F(v) + ' = ' + mixedStr(v) });
  const dec = decimal(v);
  s.push({ text: 'Divide ' + babs(v.n) + ' by ' + v.d + (dec.repeating ? '. A remainder comes back, so the digits repeat' : ''), math: F(v) + ' = ' + dec.text });
  let d = v.d; while (d % 2n === 0n) d /= 2n; while (d % 5n === 0n) d /= 5n;
  s.push({ text: d === 1n ? 'The denominator has only the prime factors 2 and 5, so the decimal ends.' : 'The denominator has a prime factor other than 2 and 5, so the decimal repeats forever.' });
  s.push({ text: 'Percent: multiply by 100', math: percent(v) });
  return s;
}

function forms(v: Q) {
  const dec = decimal(v);
  return {
    fraction: str(v), numerator: String(v.n), denominator: String(v.d), ...(mixed(v) ? { mixed: mixedStr(v) } : {}),
    decimal: dec.text, repeating: dec.repeating, ...(dec.repeating || dec.cut ? { rounded: approx(v, 6) } : {}), percent: percent(v),
  };
}

export default defineTool({
  name: 'calc_fraction',
  title: 'Fraction calculator',
  webSlug: 'fraction-calc',
  description:
    'Exact fraction maths with big integers (never rounded) and worked steps. calculate: an expression with fractions, mixed ' +
    'numbers ("1 1/2"), decimals and repeating decimals ("0.(3)"), + − × ÷ ^ and brackets (a/b binds tighter than ÷). ' +
    'decimal_to_fraction: "0.75", "0.1(6)" (brackets mark the repeating part), with close small-denominator approximations. ' +
    'fraction_to_decimal: exact decimal with the repeating block, and percent. compare: put two or more fractions in order. ' +
    `Web version: ${webUrl('fraction-calc')}`,
  inputSchema: z.object({
    mode: z.enum(['calculate', 'decimal_to_fraction', 'fraction_to_decimal', 'compare']).optional().default('calculate').describe('What to do.'),
    input: z.string().min(1).max(2000).describe('calculate: "1 1/2 + 3/4 × 2/5"; decimal_to_fraction: "0.1(6)"; fraction_to_decimal: "5/7"; compare: "2/3, 3/5, 7/10".'),
  }),
  outputSchema: z.object({
    mode: z.string(),
    fraction: z.string().optional(), numerator: z.string().optional(), denominator: z.string().optional(), mixed: z.string().optional(),
    decimal: z.string().optional(), repeating: z.boolean().optional(), rounded: z.string().optional(), percent: z.string().optional(),
    approximations: z.array(z.object({ fraction: z.string(), approx: z.string() })).optional(),
    order: z.array(z.object({ input: z.string(), fraction: z.string() })).optional(), chain: z.string().optional(), largest: z.string().optional(),
    steps: z.array(z.object({ text: z.string(), math: z.string().optional() })),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { input: '1 1/2 + 3/4' }, note: '9/4 = 2 1/4 = 2.25' },
    { input: { mode: 'decimal_to_fraction', input: '0.1(6)' }, note: '1/6' },
  ],
  run({ mode, input }) {
    const v = input.trim();
    if (mode === 'calculate') {
      const r = evaluate(v);
      const steps = r.steps.flatMap(stepText);
      return { mode, ...forms(r.v), steps: steps.length ? steps : [{ text: 'Nothing to work out: the input is already in lowest terms.' }] };
    }
    if (mode === 'decimal_to_fraction') {
      const p = parseDecimal(v);
      if (!p) throw err('Type a decimal like 0.75, 2.5 or 0.1(6)');
      const ap = approxList(p.v);
      return { mode, ...forms(p.v), ...(ap ? { approximations: ap } : {}), steps: decSteps(p) };
    }
    if (mode === 'fraction_to_decimal') {
      const q = evaluate(v);
      return { mode, ...forms(q.v), steps: divSteps(q.v) };
    }
    let parts = v.split(/\s*[,;]\s*|\s{2,}/).filter(Boolean);
    if (parts.length === 1) parts = v.split(/\s+(?![\d]+\s*\/)/).filter(Boolean); // "2/3 3/5" (but keep "1 1/2" together)
    const vals = parts.map((p) => ({ src: p.trim(), v: evaluate(p).v }));
    if (vals.length < 2) throw err('Type at least two fractions, separated by commas');
    const L = vals.reduce((acc, x) => lcm(acc, x.v.d), 1n);
    const sorted = vals.slice().sort((a, b) => cmp(a.v, b.v));
    const chain = sorted.map((x, i) => (i ? (cmp(sorted[i - 1].v, x.v) === 0 ? ' = ' : ' < ') : '') + str(x.v)).join('');
    const top = sorted[sorted.length - 1];
    const steps: StepText[] = [{ text: 'Lowest common denominator: ' + L }];
    vals.forEach((x) => steps.push({ text: x.src, math: F(x.v) + ' = ' + F(raw(x.v.n * (L / x.v.d), L)) }));
    steps.push({ text: 'With the same denominator, compare the numerators' });
    return { mode, order: sorted.map((x) => ({ input: x.src, fraction: str(x.v) })), chain, largest: top.src + ' (' + approx(top.v, 6) + ')', steps };
  },
});

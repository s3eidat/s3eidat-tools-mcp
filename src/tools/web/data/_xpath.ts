/**
 * XPath 1.0 over the nodes from _xml.ts: the headless stand-in for document.evaluate() used by
 * https://github.com/s3eidat/xml-format. Full expression grammar, all 13 axes (namespace axis is empty, as in Chrome),
 * node tests, predicates, operators and the XPath 1.0 core function library. No variables.
 */
import { ATTRIBUTE, CDATA, COMMENT, DOCUMENT, ELEMENT, PI, TEXT, XMLNS_NS, XML_NS, textContent, type XNode } from './_xml.js';

export class XPathError extends Error {}

export type XValue = number | string | boolean | XNode[];

// ---------------- lexer ----------------
type Tok = { t: 'num' | 'str' | 'name' | 'star' | 'op' | 'var'; v: string; num?: number };
const NC = '[A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][\\w.\\-\\u00B7\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u203F-\\u2040\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD]*';
const NAME_RE = new RegExp(`^${NC}(?::(?:\\*|${NC}))?`);

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, m: RegExpExecArray | null;
  while (i < src.length) {
    const c = src[i], rest = src.slice(i);
    if (/\s/.test(c)) { i++; continue; }
    if ((m = /^(\d+(\.\d*)?|\.\d+)/.exec(rest))) { out.push({ t: 'num', v: m[0], num: Number(m[0]) }); i += m[0].length; continue; }
    if (c === '"' || c === "'") {
      const e = src.indexOf(c, i + 1);
      if (e < 0) throw new XPathError('Unterminated string literal');
      out.push({ t: 'str', v: src.slice(i + 1, e) }); i = e + 1; continue;
    }
    if ((m = /^(\/\/|::|\.\.|!=|<=|>=|[/()[\]@,|+\-=<>.])/.exec(rest))) { out.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
    if (c === '*') { out.push({ t: 'star', v: '*' }); i++; continue; }
    if (c === '$') {
      m = NAME_RE.exec(src.slice(i + 1));
      throw new XPathError(`Variables are not supported ($${m ? m[0] : ''})`);
    }
    if ((m = NAME_RE.exec(rest))) {
      // "child::x" must not lex as the QName "child:" + ":x"
      let v = m[0];
      if (v.endsWith(':') && src[i + v.length] === ':') v = v.slice(0, -1);
      out.push({ t: 'name', v }); i += v.length; continue;
    }
    throw new XPathError(`Unexpected character "${c}" at ${i + 1}`);
  }
  return out;
}

// ---------------- AST ----------------
type Test = { kind: 'name'; prefix: string | null; local: string } | { kind: 'any'; prefix: string | null } | { kind: 'type'; type: string; arg?: string };
type Step = { axis: string; test: Test; preds: Expr[] };
type Expr =
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'neg'; a: Expr }
  | { k: 'union'; a: Expr; b: Expr }
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'fn'; name: string; args: Expr[] }
  | { k: 'path'; abs: boolean; steps: Step[]; filter?: { e: Expr; preds: Expr[] } };

const AXES = new Set(['ancestor', 'ancestor-or-self', 'attribute', 'child', 'descendant', 'descendant-or-self', 'following', 'following-sibling', 'namespace', 'parent', 'preceding', 'preceding-sibling', 'self']);
const NODE_TYPES = new Set(['comment', 'text', 'processing-instruction', 'node']);
const DOS: Step = { axis: 'descendant-or-self', test: { kind: 'type', type: 'node' }, preds: [] };

class P {
  p = 0;
  constructor(public toks: Tok[]) {}
  peek(o = 0) { return this.toks[this.p + o]; }
  isOp(v: string, o = 0) { const t = this.peek(o); return !!t && t.t === 'op' && t.v === v; }
  isName(v: string) { const t = this.peek(); return !!t && t.t === 'name' && t.v === v; }
  expect(v: string) { if (!this.isOp(v)) throw new XPathError(`Expected "${v}"${this.peek() ? ' but found "' + this.peek().v + '"' : ' at the end'}`); this.p++; }

  parse(): Expr {
    const e = this.or();
    if (this.p < this.toks.length) throw new XPathError(`Unexpected "${this.peek().v}"`);
    return e;
  }
  or(): Expr { let a = this.and(); while (this.isName('or')) { this.p++; a = { k: 'bin', op: 'or', a, b: this.and() }; } return a; }
  and(): Expr { let a = this.eq(); while (this.isName('and')) { this.p++; a = { k: 'bin', op: 'and', a, b: this.eq() }; } return a; }
  eq(): Expr { let a = this.rel(); while (this.isOp('=') || this.isOp('!=')) { const op = this.toks[this.p++].v; a = { k: 'bin', op, a, b: this.rel() }; } return a; }
  rel(): Expr {
    let a = this.add();
    while (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=')) { const op = this.toks[this.p++].v; a = { k: 'bin', op, a, b: this.add() }; }
    return a;
  }
  add(): Expr { let a = this.mul(); while (this.isOp('+') || this.isOp('-')) { const op = this.toks[this.p++].v; a = { k: 'bin', op, a, b: this.mul() }; } return a; }
  mul(): Expr {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t && (t.t === 'star' || (t.t === 'name' && (t.v === 'div' || t.v === 'mod')))) { this.p++; a = { k: 'bin', op: t.v, a, b: this.unary() }; }
      else return a;
    }
  }
  unary(): Expr { if (this.isOp('-')) { this.p++; return { k: 'neg', a: this.unary() }; } return this.union(); }
  union(): Expr { let a = this.pathExpr(); while (this.isOp('|')) { this.p++; a = { k: 'union', a, b: this.pathExpr() }; } return a; }

  startsFilter(): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.t === 'num' || t.t === 'str' || t.t === 'var') return true;
    if (t.t === 'op' && t.v === '(') return true;
    if (t.t === 'name' && this.isOp('(', 1) && !NODE_TYPES.has(t.v)) return true;
    return false;
  }
  pathExpr(): Expr {
    if (this.startsFilter()) {
      const e = this.primary();
      const preds: Expr[] = [];
      while (this.isOp('[')) preds.push(this.pred());
      if (!this.isOp('/') && !this.isOp('//')) return preds.length ? { k: 'path', abs: false, steps: [], filter: { e, preds } } : e;
      const steps: Step[] = [];
      if (this.toks[this.p++].v === '//') steps.push(DOS);
      steps.push(...this.relPath());
      return { k: 'path', abs: false, steps, filter: { e, preds } };
    }
    if (this.isOp('/')) {
      this.p++;
      const t = this.peek();
      const more = t && (t.t === 'name' || t.t === 'star' || (t.t === 'op' && (t.v === '.' || t.v === '..' || t.v === '@')));
      return { k: 'path', abs: true, steps: more ? this.relPath() : [] };
    }
    if (this.isOp('//')) { this.p++; return { k: 'path', abs: true, steps: [DOS, ...this.relPath()] }; }
    return { k: 'path', abs: false, steps: this.relPath() };
  }
  relPath(): Step[] {
    const steps = [this.step()];
    while (this.isOp('/') || this.isOp('//')) {
      if (this.toks[this.p++].v === '//') steps.push(DOS);
      steps.push(this.step());
    }
    return steps;
  }
  step(): Step {
    if (this.isOp('.')) { this.p++; return { axis: 'self', test: { kind: 'type', type: 'node' }, preds: [] }; }
    if (this.isOp('..')) { this.p++; return { axis: 'parent', test: { kind: 'type', type: 'node' }, preds: [] }; }
    let axis = 'child';
    if (this.isOp('@')) { this.p++; axis = 'attribute'; }
    else {
      const t = this.peek();
      if (t && t.t === 'name' && this.isOp('::', 1)) {
        if (!AXES.has(t.v)) throw new XPathError(`Unknown axis "${t.v}"`);
        axis = t.v; this.p += 2;
      }
    }
    const test = this.nodeTest();
    const preds: Expr[] = [];
    while (this.isOp('[')) preds.push(this.pred());
    return { axis, test, preds };
  }
  nodeTest(): Test {
    const t = this.peek();
    if (!t) throw new XPathError('Expected a node test at the end');
    if (t.t === 'star') { this.p++; return { kind: 'any', prefix: null }; }
    if (t.t !== 'name') throw new XPathError(`Expected a node test but found "${t.v}"`);
    this.p++;
    if (NODE_TYPES.has(t.v) && this.isOp('(')) {
      this.p++;
      let arg: string | undefined;
      if (t.v === 'processing-instruction' && this.peek()?.t === 'str') arg = this.toks[this.p++].v;
      this.expect(')');
      return { kind: 'type', type: t.v, arg };
    }
    const i = t.v.indexOf(':');
    if (i < 0) return { kind: 'name', prefix: null, local: t.v };
    const local = t.v.slice(i + 1);
    return local === '*' ? { kind: 'any', prefix: t.v.slice(0, i) } : { kind: 'name', prefix: t.v.slice(0, i), local };
  }
  pred(): Expr { this.expect('['); const e = this.or(); this.expect(']'); return e; }
  primary(): Expr {
    const t = this.toks[this.p++];
    if (t.t === 'num') return { k: 'num', v: t.num! };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'op' && t.v === '(') { const e = this.or(); this.expect(')'); return e; }
    // function call
    this.expect('(');
    const args: Expr[] = [];
    if (!this.isOp(')')) { args.push(this.or()); while (this.isOp(',')) { this.p++; args.push(this.or()); } }
    this.expect(')');
    return { k: 'fn', name: t.v, args };
  }
}

// ---------------- evaluation ----------------
type Ctx = { node: XNode; pos: number; size: number; ns: (p: string) => string | null; root: XNode };

const isNodes = (v: XValue): v is XNode[] => Array.isArray(v);
export function stringValue(n: XNode): string { return textContent(n); }

export function numToString(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Object.is(n, -0) || n === 0) return '0';
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}
export function toStr(v: XValue): string {
  if (isNodes(v)) return v.length ? stringValue(v[0]) : '';
  if (typeof v === 'number') return numToString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}
function strToNum(s: string): number { return /^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/.test(s) ? Number(s) : NaN; }
export function toNum(v: XValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return strToNum(toStr(v));
}
export function toBool(v: XValue): boolean {
  if (isNodes(v)) return v.length > 0;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'boolean') return v;
  return v.length > 0;
}

function docOrder(nodes: XNode[]): XNode[] {
  const seen = new Set<XNode>(), out: XNode[] = [];
  for (const n of nodes) if (!seen.has(n)) { seen.add(n); out.push(n); }
  return out.sort((a, b) => a.order - b.order);
}

function parentOf(n: XNode) { return n.type === ATTRIBUTE ? n.owner ?? null : n.parent; }
function descendants(n: XNode, out: XNode[]) { for (const c of n.children) { out.push(c); descendants(c, out); } return out; }
function root(n: XNode) { let r = n; while (parentOf(r)) r = parentOf(r)!; return r; }

function axis(name: string, n: XNode): XNode[] {
  switch (name) {
    case 'self': return [n];
    case 'child': return n.children.slice();
    case 'attribute': return n.type === ELEMENT ? n.attrs.filter((a) => a.ns !== XMLNS_NS) : [];
    case 'namespace': return [];
    case 'parent': { const p = parentOf(n); return p ? [p] : []; }
    case 'descendant': return descendants(n, []);
    case 'descendant-or-self': return descendants(n, [n]);
    case 'ancestor': case 'ancestor-or-self': {
      const out: XNode[] = name === 'ancestor-or-self' ? [n] : [];
      for (let p = parentOf(n); p; p = parentOf(p)) out.push(p);
      return out; // reverse document order
    }
    case 'following-sibling': case 'preceding-sibling': {
      if (n.type === ATTRIBUTE || !n.parent) return [];
      const sib = n.parent.children, i = sib.indexOf(n);
      return name === 'following-sibling' ? sib.slice(i + 1) : sib.slice(0, i).reverse();
    }
    case 'following': {
      const out: XNode[] = [];
      let cur: XNode | null = n.type === ATTRIBUTE ? n.owner! : n;
      if (n.type === ATTRIBUTE) descendants(cur, out); // nodes after an attribute include its element's content
      for (; cur && cur.parent; cur = cur.parent) {
        const sib = cur.parent.children;
        for (const s of sib.slice(sib.indexOf(cur) + 1)) { out.push(s); descendants(s, out); }
      }
      return out;
    }
    case 'preceding': {
      const anc = new Set<XNode>();
      for (let p = parentOf(n); p; p = parentOf(p)) anc.add(p);
      const all = descendants(root(n), []);
      const me = n.type === ATTRIBUTE ? n.owner! : n;
      return all.filter((x) => x.order < me.order && !anc.has(x)).reverse();
    }
  }
  throw new XPathError(`Unknown axis "${name}"`);
}
const REVERSE = new Set(['ancestor', 'ancestor-or-self', 'preceding', 'preceding-sibling']);

function matches(test: Test, n: XNode, axisName: string, ctx: Ctx): boolean {
  const principal = axisName === 'attribute' ? ATTRIBUTE : ELEMENT;
  if (test.kind === 'type') {
    switch (test.type) {
      case 'node': return true;
      case 'text': return n.type === TEXT || n.type === CDATA;
      case 'comment': return n.type === COMMENT;
      case 'processing-instruction': return n.type === PI && (test.arg == null || n.name === test.arg);
    }
    return false;
  }
  if (n.type !== principal) return false;
  const want = test.prefix == null ? null : test.prefix === 'xml' ? XML_NS : ctx.ns(test.prefix);
  if (test.prefix != null && want == null) throw new XPathError(`Namespace prefix "${test.prefix}" is not declared`);
  if (test.kind === 'any') return test.prefix == null || n.ns === want;
  return n.localName === test.local && (n.ns ?? null) === want;
}

function evalSteps(start: XNode[], steps: Step[], ctx: Ctx): XNode[] {
  let nodes = start;
  for (const st of steps) {
    const next: XNode[] = [];
    for (const n of nodes) {
      let sel = axis(st.axis, n).filter((x) => matches(st.test, x, st.axis, ctx));
      for (const pr of st.preds) sel = filter(sel, pr, ctx); // proximity order = axis order (reverse axes reversed)
      next.push(...sel);
    }
    nodes = docOrder(next);
  }
  return nodes;
}

function filter(nodes: XNode[], pred: Expr, ctx: Ctx): XNode[] {
  const size = nodes.length;
  return nodes.filter((n, i) => {
    const v = ev(pred, { ...ctx, node: n, pos: i + 1, size });
    return typeof v === 'number' ? v === i + 1 : toBool(v);
  });
}

function compare(op: string, a: XValue, b: XValue): boolean {
  if (isNodes(a) || isNodes(b)) {
    if (isNodes(a) && isNodes(b)) {
      const bs = b.map(stringValue);
      return a.some((x) => { const xs = stringValue(x); return bs.some((y) => compare(op, xs, y)); });
    }
    if (isNodes(a)) {
      if (typeof b === 'boolean') return compare(op, toBool(a), b);
      return a.some((x) => compare(op, typeof b === 'number' ? toNum(stringValue(x)) : stringValue(x), b));
    }
    const flip: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!=' };
    return compare(flip[op], b, a);
  }
  if (op === '=' || op === '!=') {
    let r: boolean;
    if (typeof a === 'boolean' || typeof b === 'boolean') r = toBool(a) === toBool(b);
    else if (typeof a === 'number' || typeof b === 'number') r = toNum(a) === toNum(b);
    else r = a === b;
    return op === '=' ? r : !r;
  }
  const x = toNum(a), y = toNum(b);
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
}

function arity(name: string, args: Expr[], min: number, max = min) {
  if (args.length < min || args.length > max) throw new XPathError(`${name}() takes ${min === max ? min : min + '-' + max} argument${max === 1 ? '' : 's'}`);
}

function nodeArg(name: string, args: Expr[], ctx: Ctx): XNode | null {
  arity(name, args, 0, 1);
  if (!args.length) return ctx.node;
  const v = ev(args[0], ctx);
  if (!isNodes(v)) throw new XPathError(`${name}() needs a node-set`);
  return v[0] ?? null;
}

function callFn(name: string, args: Expr[], ctx: Ctx): XValue {
  const s = (i: number) => toStr(ev(args[i], ctx));
  const n = (i: number) => toNum(ev(args[i], ctx));
  switch (name) {
    case 'last': arity(name, args, 0); return ctx.size;
    case 'position': arity(name, args, 0); return ctx.pos;
    case 'count': { arity(name, args, 1); const v = ev(args[0], ctx); if (!isNodes(v)) throw new XPathError('count() needs a node-set'); return v.length; }
    case 'id': {
      arity(name, args, 1);
      const v = ev(args[0], ctx);
      const ids = new Set((isNodes(v) ? v.map(stringValue).join(' ') : toStr(v)).split(/\s+/).filter(Boolean));
      const all = descendants(root(ctx.node), []).filter((e) => e.type === ELEMENT && e.attrs.some((a) => (a.name === 'id' || a.name === 'xml:id') && ids.has(a.value)));
      return all;
    }
    case 'local-name': { const x = nodeArg(name, args, ctx); return x && (x.type === ELEMENT || x.type === ATTRIBUTE) ? x.localName : x && x.type === PI ? x.name : ''; }
    case 'namespace-uri': { const x = nodeArg(name, args, ctx); return x && (x.type === ELEMENT || x.type === ATTRIBUTE) ? x.ns ?? '' : ''; }
    case 'name': { const x = nodeArg(name, args, ctx); return x && (x.type === ELEMENT || x.type === ATTRIBUTE || x.type === PI) ? x.name : ''; }
    case 'string': arity(name, args, 0, 1); return args.length ? s(0) : stringValue(ctx.node);
    case 'concat': if (args.length < 2) throw new XPathError('concat() takes 2 or more arguments'); return args.map((_, i) => s(i)).join('');
    case 'starts-with': arity(name, args, 2); return s(0).startsWith(s(1));
    case 'ends-with': arity(name, args, 2); return s(0).endsWith(s(1));
    case 'contains': arity(name, args, 2); return s(0).includes(s(1));
    case 'substring-before': { arity(name, args, 2); const a = s(0), b = s(1), i = a.indexOf(b); return i < 0 ? '' : a.slice(0, i); }
    case 'substring-after': { arity(name, args, 2); const a = s(0), b = s(1), i = a.indexOf(b); return i < 0 ? '' : a.slice(i + b.length); }
    case 'substring': {
      arity(name, args, 2, 3);
      const chars = Array.from(s(0)), start = Math.round(n(1));
      const end = args.length === 3 ? start + Math.round(n(2)) : Infinity;
      if (Number.isNaN(start) || Number.isNaN(end)) return '';
      return chars.filter((_, i) => i + 1 >= start && i + 1 < end).join('');
    }
    case 'string-length': arity(name, args, 0, 1); return Array.from(args.length ? s(0) : stringValue(ctx.node)).length;
    case 'normalize-space': arity(name, args, 0, 1); return (args.length ? s(0) : stringValue(ctx.node)).replace(/[ \t\r\n]+/g, ' ').trim();
    case 'translate': {
      arity(name, args, 3);
      const from = Array.from(s(1)), to = Array.from(s(2));
      return Array.from(s(0)).map((c) => { const i = from.indexOf(c); return i < 0 ? c : i < to.length ? to[i] : ''; }).join('');
    }
    case 'boolean': arity(name, args, 1); return toBool(ev(args[0], ctx));
    case 'not': arity(name, args, 1); return !toBool(ev(args[0], ctx));
    case 'true': arity(name, args, 0); return true;
    case 'false': arity(name, args, 0); return false;
    case 'lang': {
      arity(name, args, 1);
      const want = s(0).toLowerCase();
      for (let x: XNode | null = ctx.node; x; x = parentOf(x)) {
        const a = x.attrs.find((y) => y.localName === 'lang' && y.ns === XML_NS);
        if (a) { const l = a.value.toLowerCase(); return l === want || l.startsWith(want + '-'); }
      }
      return false;
    }
    case 'number': arity(name, args, 0, 1); return args.length ? n(0) : strToNum(stringValue(ctx.node));
    case 'sum': { arity(name, args, 1); const v = ev(args[0], ctx); if (!isNodes(v)) throw new XPathError('sum() needs a node-set'); return v.reduce((t, x) => t + strToNum(stringValue(x)), 0); }
    case 'floor': arity(name, args, 1); return Math.floor(n(0));
    case 'ceiling': arity(name, args, 1); return Math.ceil(n(0));
    case 'round': { arity(name, args, 1); const x = n(0); return Number.isNaN(x) || !Number.isFinite(x) ? x : x < 0 && x >= -0.5 ? -0 : Math.round(x); }
  }
  throw new XPathError(`Unknown function ${name}()`);
}

function ev(e: Expr, ctx: Ctx): XValue {
  switch (e.k) {
    case 'num': return e.v;
    case 'str': return e.v;
    case 'neg': return -toNum(ev(e.a, ctx));
    case 'fn': return callFn(e.name, e.args, ctx);
    case 'union': {
      const a = ev(e.a, ctx), b = ev(e.b, ctx);
      if (!isNodes(a) || !isNodes(b)) throw new XPathError('"|" needs node-sets on both sides');
      return docOrder([...a, ...b]);
    }
    case 'bin': {
      if (e.op === 'or') return toBool(ev(e.a, ctx)) || toBool(ev(e.b, ctx));
      if (e.op === 'and') return toBool(ev(e.a, ctx)) && toBool(ev(e.b, ctx));
      const a = ev(e.a, ctx), b = ev(e.b, ctx);
      switch (e.op) {
        case '+': return toNum(a) + toNum(b);
        case '-': return toNum(a) - toNum(b);
        case '*': return toNum(a) * toNum(b);
        case 'div': return toNum(a) / toNum(b);
        case 'mod': return toNum(a) % toNum(b);
        default: return compare(e.op, a, b);
      }
    }
    case 'path': {
      let start: XNode[];
      if (e.filter) {
        const v = ev(e.filter.e, ctx);
        if (!isNodes(v)) {
          if (e.filter.preds.length || e.steps.length) throw new XPathError('A predicate or path can only follow a node-set');
          return v;
        }
        start = docOrder(v);
        for (const pr of e.filter.preds) start = filter(start, pr, ctx);
      } else start = e.abs ? [ctx.root] : [ctx.node];
      return e.steps.length ? evalSteps(start, e.steps, ctx) : start;
    }
  }
}

/** Evaluate an XPath 1.0 expression with `doc` as the context node. `ns` maps prefixes to namespace URIs. */
export function evaluate(expr: string, doc: XNode, ns: Record<string, string>): XValue {
  if (!expr.trim()) throw new XPathError('Empty expression');
  const ast = new P(lex(expr)).parse();
  const r = root(doc);
  return ev(ast, { node: doc, pos: 1, size: 1, ns: (p) => ns[p] ?? null, root: r.type === DOCUMENT ? r : doc });
}

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { deliver, failAt, indentField, outputField, pathField, READ_ONLY, readText, resultShape, textField } from './_io.js';

// Ported from https://github.com/s3eidat/json-studio (app.js): sortDeep, locate, measure, pathJoin.

export function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

/** Error position across engines: "at position 42", "(line 3 column 5)", "at line 3 column 5". */
export function locate(msg: string, text: string): { line: number; col: number } | null {
  let m = /line (\d+) column (\d+)/i.exec(msg);
  if (m) return { line: +m[1], col: +m[2] };
  m = /position (\d+)/i.exec(msg);
  if (!m) return null;
  const before = text.slice(0, +m[1]).split('\n');
  return { line: before.length, col: before[before.length - 1].length + 1 };
}

export type JsonParse = { ok: true; data: unknown } | { ok: false; error: string; at: { line: number; col: number } | null };

export function parseJson(text: string): JsonParse {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    const msg = (e as Error).message;
    let at = locate(msg, text);
    // V8 gives no position for a truncated document: point at its end.
    if (!at && /end of JSON input/i.test(msg)) at = locate('position ' + text.replace(/\s+$/, '').length, text);
    return { ok: false, error: msg, at };
  }
}

/** Parse or throw a ToolError with line, column and the lines around the problem. */
export function parseJsonOrThrow(text: string, what = 'Invalid JSON'): unknown {
  const r = parseJson(text);
  if (!r.ok) failAt(what, r.error, text, r.at);
  return r.data;
}

export function measure(v: unknown) {
  let keys = 0, depth = 0, nodes = 0;
  (function walk(x: unknown, d: number) {
    nodes++;
    if (d > depth) depth = d;
    if (x && typeof x === 'object') {
      const ks = Object.keys(x);
      if (!Array.isArray(x)) keys += ks.length;
      for (const k of ks) walk((x as Record<string, unknown>)[k], d + 1);
    }
  })(v, 0);
  return { keys, depth, nodes };
}

export function pathJoin(path: string, key: string | number, isArr: boolean) {
  return isArr ? path + '[' + key + ']' : /^[A-Za-z_$][\w$]*$/.test(String(key)) ? path + '.' + key : path + '[' + JSON.stringify(String(key)) + ']';
}

// ---------------- JSONPath subset (the website has a tree view with "copy path"; this queries those paths) ----------------
type Sel =
  | { k: 'name'; name: string }
  | { k: 'wild' }
  | { k: 'index'; i: number }
  | { k: 'slice'; start?: number; end?: number; step: number }
  | { k: 'filter'; expr: FExpr };
type Seg = { desc: boolean; sels: Sel[] };
type FExpr =
  | { t: 'or' | 'and'; a: FExpr; b: FExpr }
  | { t: 'not'; a: FExpr }
  | { t: 'cmp'; op: string; a: FExpr; b: FExpr }
  | { t: 'lit'; v: unknown }
  | { t: 're'; re: RegExp }
  | { t: 'path'; root: '@' | '$'; segs: Seg[] };

const NAME_RE = /^[A-Za-z_$\u0080-￿][\w$\-\u0080-￿]*/;

function closeBracket(s: string, i: number): number {
  // s[i] === '['; returns index of the matching ']' (quotes and parens respected)
  let depth = 0, q: string | null = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') { depth--; if (depth === 0) return j; }
  }
  throw new ToolError(`JSONPath: missing "]" for the "[" at character ${i + 1}`);
}

function splitTop(s: string): string[] {
  const out: string[] = []; let cur = '', depth = 0, q: string | null = null;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) { cur += c; if (c === '\\') { cur += s[++j] ?? ''; } else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function unquote(s: string): string {
  const q = s[0];
  return s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === q || c === '\\' ? c : '\\' + c));
}

function parseBracket(body: string): Sel[] {
  const b = body.trim();
  if (b[0] === '?') {
    let e = b.slice(1).trim();
    if (e[0] === '(' && closeBracket(e, 0) === e.length - 1) e = e.slice(1, -1);
    return [{ k: 'filter', expr: parseFilter(e) }];
  }
  return splitTop(b).map((raw): Sel => {
    const p = raw.trim();
    if (p === '*') return { k: 'wild' };
    if (/^(['"]).*\1$/s.test(p)) return { k: 'name', name: unquote(p) };
    if (/^-?\d+$/.test(p)) return { k: 'index', i: +p };
    const m = /^(-?\d+)?\s*:\s*(-?\d+)?\s*(?::\s*(-?\d+)?)?$/.exec(p);
    if (m) {
      const step = m[3] != null ? +m[3] : 1;
      if (step === 0) throw new ToolError('JSONPath: slice step cannot be 0');
      return { k: 'slice', start: m[1] != null ? +m[1] : undefined, end: m[2] != null ? +m[2] : undefined, step };
    }
    if (NAME_RE.test(p) && NAME_RE.exec(p)![0] === p) return { k: 'name', name: p };
    throw new ToolError(`JSONPath: can't read "[${p}]". Use ['key'], [0], [-1], [*], [1:3], [0,2] or [?(@.x > 1)].`);
  });
}

/** Parse path segments from s starting at i; stops at the first character that can't continue a path. */
function parseSegs(s: string, i: number, allowBareStart: boolean): { segs: Seg[]; end: number } {
  const segs: Seg[] = [];
  let first = true;
  while (i < s.length) {
    const c = s[i];
    if (c === '.' && s[i + 1] === '.') {
      i += 2;
      if (s[i] === '[') { const e = closeBracket(s, i); segs.push({ desc: true, sels: parseBracket(s.slice(i + 1, e)) }); i = e + 1; }
      else if (s[i] === '*') { segs.push({ desc: true, sels: [{ k: 'wild' }] }); i++; }
      else {
        const m = NAME_RE.exec(s.slice(i)) || /^\d+/.exec(s.slice(i));
        if (!m) throw new ToolError(`JSONPath: expected a key after ".." at character ${i + 1}`);
        segs.push({ desc: true, sels: [{ k: 'name', name: m[0] }] }); i += m[0].length;
      }
    } else if (c === '.') {
      i++;
      if (s[i] === '*') { segs.push({ desc: false, sels: [{ k: 'wild' }] }); i++; }
      else {
        const m = NAME_RE.exec(s.slice(i)) || /^\d+/.exec(s.slice(i));
        if (!m) throw new ToolError(`JSONPath: expected a key after "." at character ${i + 1}`);
        segs.push({ desc: false, sels: [{ k: 'name', name: m[0] }] }); i += m[0].length;
      }
    } else if (c === '[') {
      const e = closeBracket(s, i);
      segs.push({ desc: false, sels: parseBracket(s.slice(i + 1, e)) }); i = e + 1;
    } else if (first && allowBareStart && (NAME_RE.test(s.slice(i)) || c === '*')) {
      const m = c === '*' ? ['*'] : NAME_RE.exec(s.slice(i))!;
      segs.push({ desc: false, sels: [m[0] === '*' ? { k: 'wild' } : { k: 'name', name: m[0] }] }); i += m[0].length;
    } else break;
    first = false;
  }
  return { segs, end: i };
}

export function parseJsonPath(expr: string): Seg[] {
  const s = expr.trim();
  if (!s || s === '$') return [];
  const start = s[0] === '$' ? 1 : 0;
  const { segs, end } = parseSegs(s, start, start === 0);
  if (end < s.length) throw new ToolError(`JSONPath: unexpected "${s.slice(end, end + 10)}" at character ${end + 1}`);
  return segs;
}

// --- filter expressions: @.a.b op literal, &&, ||, !, (), =~ /re/flags, existence ---
function parseFilter(src: string): FExpr {
  const toks: { t: string; v?: unknown }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i], rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '@' || c === '$') {
      const r = parseSegs(src, i + 1, false);
      toks.push({ t: 'path', v: { root: c, segs: r.segs } }); i = r.end; continue;
    }
    if ((m = /^(==|!=|<=|>=|=~|&&|\|\||<|>|!|\(|\))/.exec(rest))) { toks.push({ t: m[0] }); i += m[0].length; continue; }
    if ((m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest))) { toks.push({ t: 'lit', v: Number(m[0]) }); i += m[0].length; continue; }
    if ((m = /^(['"])(?:\\.|(?!\1).)*\1/s.exec(rest))) { toks.push({ t: 'lit', v: unquote(m[0]) }); i += m[0].length; continue; }
    if ((m = /^(true|false|null)\b/.exec(rest))) { toks.push({ t: 'lit', v: JSON.parse(m[0]) }); i += m[0].length; continue; }
    if ((m = /^\/((?:\\.|[^/\\])+)\/([gimsuy]*)/.exec(rest)) && toks.length && toks[toks.length - 1].t === '=~') {
      toks.push({ t: 're', v: new RegExp(m[1], m[2].replace('g', '')) }); i += m[0].length; continue;
    }
    throw new ToolError(`JSONPath filter: can't read "${rest.slice(0, 12)}"`);
  }
  let p = 0;
  const peek = () => toks[p]?.t;
  function prim(): FExpr {
    const t = toks[p++];
    if (!t) throw new ToolError('JSONPath filter: unexpected end');
    if (t.t === '(') { const e = or(); if (toks[p++]?.t !== ')') throw new ToolError('JSONPath filter: missing ")"'); return e; }
    if (t.t === '!') return { t: 'not', a: prim() };
    if (t.t === 'lit') return { t: 'lit', v: t.v };
    if (t.t === 're') return { t: 're', re: t.v as RegExp };
    if (t.t === 'path') { const v = t.v as { root: '@' | '$'; segs: Seg[] }; return { t: 'path', root: v.root, segs: v.segs }; }
    throw new ToolError(`JSONPath filter: unexpected "${t.t}"`);
  }
  function cmp(): FExpr {
    const a = prim();
    const op = peek();
    if (op && /^(==|!=|<=|>=|<|>|=~)$/.test(op)) { p++; return { t: 'cmp', op, a, b: prim() }; }
    return a;
  }
  function and(): FExpr { let a = cmp(); while (peek() === '&&') { p++; a = { t: 'and', a, b: cmp() }; } return a; }
  function or(): FExpr { let a = and(); while (peek() === '||') { p++; a = { t: 'or', a, b: and() }; } return a; }
  const e = or();
  if (p < toks.length) throw new ToolError(`JSONPath filter: unexpected "${toks[p].t}"`);
  return e;
}

type Match = { path: string; value: unknown };
const NOTHING = Symbol('nothing');

function children(n: Match): Match[] {
  const v = n.value;
  if (Array.isArray(v)) return v.map((x, i) => ({ path: pathJoin(n.path, i, true), value: x }));
  if (v && typeof v === 'object') return Object.keys(v).map((k) => ({ path: pathJoin(n.path, k, false), value: (v as Record<string, unknown>)[k] }));
  return [];
}

function select(n: Match, sel: Sel, root: unknown, inFilter: boolean): Match[] {
  const v = n.value;
  switch (sel.k) {
    case 'wild': return children(n);
    case 'name':
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, sel.name)) {
        return [{ path: pathJoin(n.path, sel.name, false), value: (v as Record<string, unknown>)[sel.name] }];
      }
      if (Array.isArray(v) && /^\d+$/.test(sel.name) && +sel.name < v.length) return [{ path: pathJoin(n.path, +sel.name, true), value: v[+sel.name] }];
      if (inFilter && sel.name === 'length' && (Array.isArray(v) || typeof v === 'string')) return [{ path: n.path + '.length', value: v.length }];
      return [];
    case 'index': {
      if (!Array.isArray(v)) return [];
      const i = sel.i < 0 ? v.length + sel.i : sel.i;
      return i >= 0 && i < v.length ? [{ path: pathJoin(n.path, i, true), value: v[i] }] : [];
    }
    case 'slice': {
      if (!Array.isArray(v)) return [];
      const len = v.length, step = sel.step;
      const norm = (x: number) => (x < 0 ? Math.max(len + x, step > 0 ? 0 : -1) : Math.min(x, step > 0 ? len : len - 1));
      const start = sel.start != null ? norm(sel.start) : step > 0 ? 0 : len - 1;
      const end = sel.end != null ? norm(sel.end) : step > 0 ? len : -1;
      const out: Match[] = [];
      for (let i = start; step > 0 ? i < end : i > end; i += step) out.push({ path: pathJoin(n.path, i, true), value: v[i] });
      return out;
    }
    case 'filter':
      return children(n).filter((c) => truthy(evalF(sel.expr, c.value, root)));
  }
}

function descendants(n: Match): Match[] {
  const out: Match[] = [n];
  for (const c of children(n)) out.push(...descendants(c));
  return out;
}

function run(segs: Seg[], start: Match, root: unknown, inFilter = false): Match[] {
  let nodes = [start];
  for (const seg of segs) {
    const next: Match[] = [];
    for (const n of nodes) {
      const bases = seg.desc ? descendants(n) : [n];
      for (const b of bases) for (const s of seg.sels) next.push(...select(b, s, root, inFilter));
    }
    nodes = next;
  }
  return nodes;
}

function evalF(e: FExpr, cur: unknown, root: unknown): unknown {
  switch (e.t) {
    case 'lit': return e.v;
    case 're': return e.re;
    case 'path': {
      const r = run(e.segs, { path: e.root, value: e.root === '@' ? cur : root }, root, true);
      return r.length ? r[0].value : NOTHING;
    }
    case 'not': return !truthy(evalF(e.a, cur, root));
    case 'and': return truthy(evalF(e.a, cur, root)) && truthy(evalF(e.b, cur, root));
    case 'or': return truthy(evalF(e.a, cur, root)) || truthy(evalF(e.b, cur, root));
    case 'cmp': {
      const a = evalF(e.a, cur, root), b = evalF(e.b, cur, root);
      if (a === NOTHING || b === NOTHING) return e.op === '!=' ? a !== b : false;
      switch (e.op) {
        case '==': return JSON.stringify(a) === JSON.stringify(b);
        case '!=': return JSON.stringify(a) !== JSON.stringify(b);
        case '=~': return b instanceof RegExp && typeof a === 'string' && b.test(a);
        default: {
          if (!((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string'))) return false;
          const x = a as number | string, y = b as number | string;
          return e.op === '<' ? x < y : e.op === '<=' ? x <= y : e.op === '>' ? x > y : x >= y;
        }
      }
    }
  }
}

function truthy(v: unknown) {
  // In a filter, a bare path means "exists"; literals use their own truth.
  return v !== NOTHING && v !== false && v !== null && v !== undefined;
}

export function jsonQuery(data: unknown, expr: string): Match[] {
  return run(parseJsonPath(expr), { path: '$', value: data }, data);
}

// ---------------- tools ----------------
const statsShape = z.object({ bytes: z.number(), keys: z.number(), depth: z.number(), values: z.number() });

const jsonFormat = defineTool({
  name: 'json_format',
  title: 'JSON format / minify / validate',
  webSlug: 'json-studio',
  description:
    'Validate, pretty-print (2 or 4 spaces, tab) or minify JSON, optionally sorting object keys (deeply). Invalid JSON gives ' +
    'a clear error with line and column and the lines around it. Also returns size, key count, depth and value count. ' +
    'Give "text" or a file "path"; "output" writes the result to a file. Uses the standard JSON parser (no comments or ' +
    `trailing commas). Web version: ${webUrl('json-studio')}`,
  inputSchema: z.object({
    text: textField('JSON'),
    path: pathField('JSON'),
    mode: z.enum(['format', 'minify', 'validate']).optional().default('format')
      .describe('"format" pretty-prints, "minify" removes all whitespace, "validate" only checks (never throws on bad JSON).'),
    indent: indentField('2'),
    sortKeys: z.boolean().optional().default(false).describe('Sort object keys alphabetically at every level.'),
    output: outputField(),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    error: z.string().optional(),
    line: z.number().optional(),
    column: z.number().optional(),
    stats: statsShape.optional(),
    ...resultShape,
  }),
  annotations: READ_ONLY,
  examples: [
    { input: { text: '{"b":1,"a":[1,2]}', sortKeys: true }, output: { valid: true, result: '{\n  "a": [\n    1,\n    2\n  ],\n  "b": 1\n}' } },
    { input: { text: '{"a":1,\n}', mode: 'validate' }, note: 'valid: false, line 2, column 1' },
  ],
  async run(input, ctx) {
    const text = await readText(input, ctx);
    if (!text.trim()) throw new ToolError('The JSON is empty.');
    const r = parseJson(text);
    if (!r.ok) {
      if (input.mode === 'validate') return { valid: false, error: r.error, ...(r.at ? { line: r.at.line, column: r.at.col } : {}) };
      failAt('Invalid JSON', r.error, text, r.at);
    }
    const data = input.sortKeys ? sortDeep(r.data) : r.data;
    const ind = input.indent === 'tab' ? '\t' : +input.indent;
    const out = input.mode === 'minify' ? JSON.stringify(data) : JSON.stringify(data, null, ind);
    const m = measure(data);
    const stats = { bytes: Buffer.byteLength(out), keys: m.keys, depth: m.depth, values: m.nodes };
    if (input.mode === 'validate') return { valid: true, stats };
    return { valid: true, stats, ...(await deliver(out, { output: input.output, defaultName: 'data.json', mimeType: 'application/json' }, ctx)) };
  },
});

const jsonQueryTool = defineTool({
  name: 'json_query',
  title: 'JSON query (JSONPath)',
  webSlug: 'json-studio',
  description:
    'Pick values out of JSON with a JSONPath expression. Supported: $ (root, optional), .key, [\'key\'], [0], [-1], [*], .*, ' +
    '..key (recursive), [start:end:step] slices, unions [0,2] / [\'a\',\'b\'], and filters like [?(@.price < 10 && @.tags)] ' +
    '(==, !=, <, <=, >, >=, =~ /regex/i, &&, ||, !, .length). Returns each match with its path (the same path style the ' +
    `website's tree view copies, e.g. $.store.book[0].title). Give "text" or a file "path". Web version: ${webUrl('json-studio')}`,
  inputSchema: z.object({
    text: textField('JSON'),
    path: pathField('JSON'),
    query: z.string().min(1).describe('JSONPath expression, e.g. "$.store.book[*].author" or "$..book[?(@.price < 10)].title".'),
    limit: z.number().int().min(1).max(100000).optional().default(1000).describe('Return at most this many matches (default 1000).'),
    output: outputField().describe('Optional: write the matched values as a JSON array to this file.'),
  }),
  outputSchema: z.object({
    count: z.number().describe('Total number of matches.'),
    matches: z.array(z.object({ path: z.string(), value: z.unknown() })).optional(),
    truncated: z.boolean().optional(),
    path: z.string().optional(),
    bytes: z.number().optional(),
  }),
  annotations: READ_ONLY,
  examples: [{ input: { text: '{"store":{"book":[{"title":"A","price":8},{"title":"B","price":12}]}}', query: '$..book[?(@.price < 10)].title' }, output: { count: 1, matches: [{ path: '$.store.book[0].title', value: 'A' }] } }],
  async run(input, ctx) {
    const text = await readText(input, ctx);
    const data = parseJsonOrThrow(text);
    const all = jsonQuery(data, input.query);
    if (input.output) {
      const w = await deliver(JSON.stringify(all.map((m) => m.value), null, 2), { output: input.output, defaultName: 'query.json', mimeType: 'application/json' }, ctx);
      return { count: all.length, path: w.path, bytes: w.bytes };
    }
    const matches = all.slice(0, input.limit);
    return { count: all.length, matches, ...(all.length > matches.length ? { truncated: true } : {}) };
  },
});

export default [jsonFormat, jsonQueryTool];

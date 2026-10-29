import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { deliver, outputField, pathField, READ_ONLY, readText, resultShape, textField } from './_io.js';
import { parseJsonOrThrow } from './json-studio.js';

// Ported from https://github.com/s3eidat/json-to-types (app.js): infer one merged type tree, print it in four languages.

export interface T {
  k: 'null' | 'array' | 'object' | 'int' | 'float' | 'bool' | 'string' | 'unknown' | 'union';
  item?: T; fields?: F[]; types?: T[]; nullable?: boolean; name?: string;
}
interface F { key: string; type: T; optional: boolean }

// ---------- inference ----------
export function infer(v: unknown): T {
  if (v === null) return { k: 'null' };
  if (Array.isArray(v)) return { k: 'array', item: v.map(infer).reduce(merge, { k: 'unknown' }) };
  if (typeof v === 'object') return { k: 'object', fields: Object.keys(v).map((key) => ({ key, type: infer((v as Record<string, unknown>)[key]), optional: false })) };
  if (typeof v === 'number') return { k: Number.isInteger(v) ? 'int' : 'float' };
  if (typeof v === 'boolean') return { k: 'bool' };
  return { k: 'string' };
}
function withNull(t: T): T { const c = Object.assign({}, t); if (c.k !== 'null') c.nullable = true; return c; }
function strip(t: T): T { const c = Object.assign({}, t); delete c.nullable; return c; }
export function merge(a: T, b: T): T {
  if (a.k === 'unknown') return b;
  if (b.k === 'unknown') return a;
  if (a.k === 'null') return withNull(b);
  if (b.k === 'null') return withNull(a);
  const nullable = !!(a.nullable || b.nullable);
  let r: T;
  if (a.k === b.k && a.k === 'object') {
    const map: Record<string, F> = {}, fields = a.fields!.map((f) => { const c = { key: f.key, type: f.type, optional: f.optional }; map[f.key] = c; return c; });
    const inB: Record<string, boolean> = {};
    for (const f of b.fields!) {
      inB[f.key] = true;
      if (map[f.key]) { map[f.key].type = merge(map[f.key].type, f.type); map[f.key].optional = map[f.key].optional || f.optional; }
      else fields.push({ key: f.key, type: f.type, optional: true });
    }
    for (const f of fields) if (!inB[f.key] && a.fields!.some((x) => x.key === f.key)) f.optional = true;
    r = { k: 'object', fields };
  } else if (a.k === b.k && a.k === 'array') r = { k: 'array', item: merge(a.item!, b.item!) };
  else if (a.k === b.k && a.k !== 'union') r = { k: a.k };
  else if ((a.k === 'int' && b.k === 'float') || (a.k === 'float' && b.k === 'int')) r = { k: 'float' };
  else {
    const types = (a.k === 'union' ? a.types! : [strip(a)]).slice();
    for (const t of b.k === 'union' ? b.types! : [strip(b)]) {
      const i = types.findIndex((x) => x.k === t.k || (x.k === 'int' && t.k === 'float') || (x.k === 'float' && t.k === 'int'));
      if (i >= 0) types[i] = merge(types[i], t); else types.push(t);
    }
    r = types.length === 1 ? types[0] : { k: 'union', types };
  }
  if (nullable) r.nullable = true;
  return r;
}

// ---------- naming ----------
function words(s: string) { return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean); }
export function pascal(s: string) {
  const p = words(s).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  if (!p) return 'Type';
  return /^\d/.test(p) ? 'T' + p : p;
}
export function singular(s: string) {
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
  if (/(ss|x|ch|sh)es$/i.test(s)) return s.slice(0, -2);
  if (/(us|is|ss)$/i.test(s)) return s; // status, analysis, class
  if (/s$/i.test(s)) return s.slice(0, -1);
  return s;
}
function sig(t: T): string {
  const n = t.nullable ? '?' : '';
  if (t.k === 'object') return '{' + t.fields!.map((f) => JSON.stringify(f.key) + (f.optional ? '?' : '') + ':' + sig(f.type)).join(',') + '}' + n;
  if (t.k === 'array') return '[' + sig(t.item!) + ']' + n;
  if (t.k === 'union') return '(' + t.types!.map(sig).join('|') + ')' + n;
  return t.k + n;
}
// Names every object type; identical shapes share one name. pre = parents first, post = dependencies first.
function nameAll(root: T, rootName: string) {
  const used: Record<string, boolean> = {}, bySig: Record<string, string> = {}, pre: T[] = [], post: T[] = [];
  function unique(n: string) { const b = n; let i = 2; while (used[n]) n = b + i++; used[n] = true; return n; }
  function walk(t: T, hint: string) {
    if (t.k === 'array') { const s = singular(hint); walk(t.item!, s === hint ? hint + 'Item' : s); return; }
    if (t.k === 'union') { for (const x of t.types!) walk(x, hint); return; }
    if (t.k !== 'object') return;
    const s2 = sig(strip(t));
    if (bySig[s2]) { t.name = bySig[s2]; return; }
    t.name = bySig[s2] = unique(pascal(hint));
    pre.push(t);
    for (const f of t.fields!) walk(f.type, f.key);
    post.push(t);
  }
  walk(root, rootName);
  return { pre, post };
}
type Names = ReturnType<typeof nameAll>;
export interface TypeOpts { rootName: string; exportKw?: boolean; tsType?: boolean; goOmit?: boolean }

// ---------- TypeScript ----------
const TS_ID = /^[A-Za-z_$][\w$]*$/;
function tsT(t: T): string {
  let s: string;
  if (t.k === 'array') { const i = tsT(t.item!); s = (/[|]/.test(i) ? '(' + i + ')' : i) + '[]'; }
  else if (t.k === 'object') s = t.name!;
  else if (t.k === 'union') s = t.types!.map(tsT).join(' | ');
  else s = ({ string: 'string', int: 'number', float: 'number', bool: 'boolean', null: 'null', unknown: 'unknown' } as Record<string, string>)[t.k];
  return t.nullable ? s + ' | null' : s;
}
function toTS(root: T, names: Names, o: TypeOpts) {
  const ex = o.exportKw ? 'export ' : '', out: string[] = [];
  for (const t of names.pre) {
    const body = t.fields!.map((f) => '  ' + (TS_ID.test(f.key) ? f.key : JSON.stringify(f.key)) + (f.optional ? '?' : '') + ': ' + tsT(f.type) + ';').join('\n');
    out.push(o.tsType ? ex + 'type ' + t.name + ' = {\n' + body + (body ? '\n' : '') + '};' : ex + 'interface ' + t.name + ' {\n' + body + (body ? '\n' : '') + '}');
  }
  if (root.k !== 'object' || root.nullable) out.unshift(ex + 'type ' + o.rootName + ' = ' + tsT(root) + ';');
  return out.join('\n\n') + '\n';
}

// ---------- Go ----------
const INITIALISMS: Record<string, number> = { ID: 1, URL: 1, URI: 1, API: 1, HTTP: 1, HTTPS: 1, JSON: 1, XML: 1, HTML: 1, UUID: 1, IP: 1, SQL: 1, CPU: 1, DNS: 1, TLS: 1, SSH: 1, UI: 1, UTC: 1 };
export function goName(key: string) {
  let n = words(key).map((w) => { const u = w.toUpperCase(); return INITIALISMS[u] ? u : w.charAt(0).toUpperCase() + w.slice(1); }).join('');
  if (!n) n = 'Field';
  return /^\d/.test(n) ? 'F' + n : n;
}
function goT(t: T, optional: boolean): string {
  let base: string | undefined;
  if (t.k === 'array') return '[]' + goT(t.item!, false);
  if (t.k === 'object') base = t.name;
  else base = ({ string: 'string', int: 'int64', float: 'float64', bool: 'bool' } as Record<string, string>)[t.k];
  if (!base) return 'any'; // null-only, unknown or mixed types
  return t.nullable || optional ? '*' + base : base;
}
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
function toGo(root: T, names: Names, o: TypeOpts) {
  const out: string[] = [];
  if (root.k !== 'object') out.push('type ' + o.rootName + ' ' + goT(root, false));
  for (const t of names.pre) {
    const seen: Record<string, boolean> = {};
    const rows = t.fields!.map((f) => {
      let n = goName(f.key);
      const b = n; let i = 2;
      while (seen[n]) n = b + i++;
      seen[n] = true;
      return [n, goT(f.type, f.optional), '`json:"' + f.key.replace(/["\\]/g, '\\$&') + (f.optional && o.goOmit ? ',omitempty' : '') + '"`'];
    });
    const w0 = Math.max(0, ...rows.map((r) => r[0].length)), w1 = Math.max(0, ...rows.map((r) => r[1].length));
    out.push('type ' + t.name + ' struct {\n' + rows.map((r) => '\t' + pad(r[0], w0) + ' ' + pad(r[1], w1) + ' ' + r[2]).join('\n') + (rows.length ? '\n' : '') + '}');
  }
  return out.join('\n\n') + '\n';
}

// ---------- Python ----------
const PY_KW = 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ');
export function pySnake(key: string) {
  let n = words(key).map((w) => w.toLowerCase()).join('_') || 'field';
  if (/^\d/.test(n)) n = 'f_' + n;
  return PY_KW.indexOf(n) >= 0 ? n + '_' : n;
}
function toPy(root: T, names: Names, o: TypeOpts) {
  const used: Record<string, number> = {};
  function pyT(t: T): string {
    let s: string;
    if (t.k === 'array') { used.List = 1; s = 'List[' + pyT(t.item!) + ']'; }
    else if (t.k === 'object') s = t.name!;
    else if (t.k === 'union') { used.Union = 1; s = 'Union[' + t.types!.map(pyT).join(', ') + ']'; }
    else if (t.k === 'null') { used.Optional = used.Any = 1; return 'Optional[Any]'; }
    else { s = ({ string: 'str', int: 'int', float: 'float', bool: 'bool', unknown: 'Any' } as Record<string, string>)[t.k]; if (s === 'Any') used.Any = 1; }
    if (t.nullable) { used.Optional = 1; s = 'Optional[' + s + ']'; }
    return s;
  }
  const blocks = names.post.map((t) => {
    const seen: Record<string, boolean> = {}, req: string[] = [], opt: string[] = [];
    for (const f of t.fields!) {
      let n = pySnake(f.key);
      const b = n; let i = 2;
      while (seen[n]) n = b + '_' + i++;
      seen[n] = true;
      let ty = pyT(f.type);
      const note = n !== f.key ? '  # ' + JSON.stringify(f.key) : '';
      if (f.optional) { if (!/^Optional\[/.test(ty)) { used.Optional = 1; ty = 'Optional[' + ty + ']'; } opt.push('    ' + n + ': ' + ty + ' = None' + note); }
      else req.push('    ' + n + ': ' + ty + note);
    }
    const body = req.concat(opt);
    return '@dataclass\nclass ' + t.name + ':\n' + (body.length ? body.join('\n') : '    pass');
  });
  if (root.k !== 'object') blocks.push(o.rootName + ' = ' + pyT(root));
  const typing = Object.keys(used).sort();
  const head = 'from __future__ import annotations\n\nfrom dataclasses import dataclass' + (typing.length ? '\nfrom typing import ' + typing.join(', ') : '');
  return head + '\n\n\n' + blocks.join('\n\n\n') + '\n';
}

// ---------- Zod ----------
function zT(t: T): string {
  let s: string;
  if (t.k === 'array') s = 'z.array(' + zT(t.item!) + ')';
  else if (t.k === 'object') s = t.name + 'Schema';
  else if (t.k === 'union') s = 'z.union([' + t.types!.map(zT).join(', ') + '])';
  else s = ({ string: 'z.string()', int: 'z.number().int()', float: 'z.number()', bool: 'z.boolean()', null: 'z.null()', unknown: 'z.unknown()' } as Record<string, string>)[t.k];
  return t.nullable ? s + '.nullable()' : s;
}
function toZod(root: T, names: Names, o: TypeOpts) {
  const ex = o.exportKw ? 'export ' : '', out = ['import { z } from "zod";'];
  for (const t of names.post) {
    const body = t.fields!.map((f) => '  ' + (TS_ID.test(f.key) ? f.key : JSON.stringify(f.key)) + ': ' + zT(f.type) + (f.optional ? '.optional()' : '') + ',').join('\n');
    out.push(ex + 'const ' + t.name + 'Schema = z.object({\n' + body + (body ? '\n' : '') + '});\n' + ex + 'type ' + t.name + ' = z.infer<typeof ' + t.name + 'Schema>;');
  }
  if (root.k !== 'object' || root.nullable) out.push(ex + 'const ' + o.rootName + 'Schema = ' + zT(root) + ';\n' + ex + 'type ' + o.rootName + ' = z.infer<typeof ' + o.rootName + 'Schema>;');
  return out.join('\n\n') + '\n';
}

export function generate(json: unknown, o: Partial<TypeOpts>) {
  const root = infer(json), rn = pascal(o.rootName || 'Root');
  const opts: TypeOpts = Object.assign({}, o, { rootName: rn });
  const names = nameAll(root, rn);
  return { root, count: names.pre.length, ts: toTS(root, names, opts), go: toGo(root, names, opts), py: toPy(root, names, opts), zod: toZod(root, names, opts) };
}

const EXT = { typescript: ['ts', 'types.ts'], go: ['go', 'types.go'], python: ['py', 'models.py'], zod: ['zod', 'schema.ts'] } as const;

export default defineTool({
  name: 'json_to_types',
  title: 'JSON to types (TypeScript, Go, Python, Zod)',
  webSlug: 'json-to-types',
  description:
    'Generate type definitions from a JSON sample: TypeScript interfaces (or type aliases), Go structs with json tags ' +
    '(initialisms like ID/URL, pointers for optional/nullable, optional omitempty), Python dataclasses (snake_case fields with ' +
    'the original key noted) and Zod schemas. All items of an array are merged into one type (missing keys become optional, ' +
    'null makes a field nullable, int+float → number/float64, mixed values → unions); identical shapes share one name. ' +
    `These four are every language the website supports. Give "text" or a file "path". Web version: ${webUrl('json-to-types')}`,
  inputSchema: z.object({
    text: textField('JSON sample'),
    path: pathField('JSON'),
    language: z.enum(['typescript', 'go', 'python', 'zod', 'all']).optional().default('typescript').describe('Output language, or "all" for all four.'),
    rootName: z.string().optional().default('Root').describe('Name of the top-level type (turned into PascalCase).'),
    export: z.boolean().optional().default(true).describe('TypeScript / Zod: add the export keyword.'),
    tsTypeAlias: z.boolean().optional().default(false).describe('TypeScript: use "type X = {…}" instead of "interface X {…}".'),
    goOmitEmpty: z.boolean().optional().default(true).describe('Go: add ,omitempty to optional fields.'),
    output: outputField().describe('Optional: write the code to this file (with language "all", the four outputs joined by headers).'),
  }),
  outputSchema: z.object({
    types: z.number().describe('Number of named object types.'),
    typescript: z.string().optional(), go: z.string().optional(), python: z.string().optional(), zod: z.string().optional(),
    ...resultShape,
  }),
  annotations: READ_ONLY,
  examples: [{
    input: { text: '[{"a":1},{"b":true}]', rootName: 'Root', export: false },
    output: { types: 1, result: 'type Root = RootItem[];\n\ninterface RootItem {\n  a?: number;\n  b?: boolean;\n}\n' },
  }],
  async run(input, ctx) {
    const text = await readText(input, ctx);
    const data = parseJsonOrThrow(text);
    const r = generate(data, { rootName: input.rootName.trim() || 'Root', exportKw: input.export, tsType: input.tsTypeAlias, goOmit: input.goOmitEmpty });
    const by = { typescript: r.ts, go: r.go, python: r.py, zod: r.zod };
    if (input.language === 'all') {
      if (input.output) {
        const joined = (Object.keys(by) as (keyof typeof by)[]).map((k) => `// ===== ${k} =====\n${by[k]}`).join('\n');
        return { types: r.count, ...(await deliver(joined, { output: input.output, defaultName: 'types.txt', mimeType: 'text/plain' }, ctx)) };
      }
      return { types: r.count, ...by };
    }
    const code = by[input.language];
    return { types: r.count, ...(await deliver(code, { output: input.output, defaultName: EXT[input.language][1], mimeType: 'text/plain' }, ctx)) };
  },
});

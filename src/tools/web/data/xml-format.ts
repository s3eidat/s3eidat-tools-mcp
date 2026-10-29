import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ATTRIBUTE, CDATA, COMMENT, DOCUMENT, ELEMENT, PI, TEXT, XMLNS_NS, allElements, elementChildren, parseXml, serialize, textContent, type XNode } from './_xml.js';
import { evaluate, numToString, XPathError } from './_xpath.js';
import { deliver, failAt, indentField, indentUnit, outputField, pathField, READ_ONLY, readText, resultShape, textField } from './_io.js';

// Ported from https://github.com/s3eidat/xml-format (app.js). The formatter works on the source text (it keeps
// attribute quoting, entities and CDATA exactly); validation, the JSON view and XPath use a parsed tree, which the
// website gets from the browser's DOMParser and here comes from _xml.ts / _xpath.ts.

// ================= tokenizer / tree (keeps the source text exactly) =================
type Tok = { t: 'text' | 'comment' | 'cdata' | 'pi' | 'doctype' | 'close' | 'open'; v: string; self?: boolean; preserve?: boolean };
type Node = { t: 'el'; open: string; kids: (Node | Tok)[]; close: string; preserve: boolean } | Tok;
type Root = { kids: (Node | Tok)[]; preserve?: boolean };

function tagEnd(s: string, i: number) {
  let q: string | null = null;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '>') return j + 1;
  }
  return s.length;
}
function doctypeEnd(s: string, i: number) {
  let depth = 0, q: string | null = null;
  for (let j = i + 2; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return j + 1;
  }
  return s.length;
}
function normTag(raw: string) { // whitespace between attributes only; values untouched
  let out = '', q: string | null = null, sp = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) { out += c; if (c === q) q = null; continue; }
    if (/\s/.test(c)) { sp = true; continue; }
    if (sp) { if (c !== '>' && c !== '=' && !/=$/.test(out) && !(c === '/' && raw[i + 1] === '>')) out += ' '; sp = false; }
    if (c === '"' || c === "'") q = c;
    out += c;
  }
  return out;
}
export function tokens(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, e: number;
  const n = s.length;
  while (i < n) {
    if (s[i] !== '<') { e = s.indexOf('<', i); if (e < 0) e = n; toks.push({ t: 'text', v: s.slice(i, e) }); i = e; continue; }
    if (s.startsWith('<!--', i)) { e = s.indexOf('-->', i + 4); e = e < 0 ? n : e + 3; toks.push({ t: 'comment', v: s.slice(i, e) }); i = e; continue; }
    if (s.startsWith('<![CDATA[', i)) { e = s.indexOf(']]>', i); e = e < 0 ? n : e + 3; toks.push({ t: 'cdata', v: s.slice(i, e) }); i = e; continue; }
    if (s.startsWith('<?', i)) { e = s.indexOf('?>', i); e = e < 0 ? n : e + 2; toks.push({ t: 'pi', v: s.slice(i, e) }); i = e; continue; }
    if (s.startsWith('<!', i)) { e = doctypeEnd(s, i); toks.push({ t: 'doctype', v: s.slice(i, e) }); i = e; continue; }
    if (s[i + 1] === '/') { e = s.indexOf('>', i); e = e < 0 ? n : e + 1; toks.push({ t: 'close', v: s.slice(i, e).replace(/\s+/g, '') }); i = e; continue; }
    e = tagEnd(s, i);
    const raw = s.slice(i, e);
    toks.push({ t: 'open', v: normTag(raw), self: /\/\s*>$/.test(raw), preserve: /\sxml:space\s*=\s*["']preserve["']/.test(raw) });
    i = e;
  }
  return toks;
}
function tree(s: string): Root {
  const root: Root = { kids: [] }, stack: (Root | Extract<Node, { t: 'el' }>)[] = [root];
  for (const k of tokens(s)) {
    const top = stack[stack.length - 1];
    if (k.t === 'open') {
      const node: Node = { t: 'el', open: k.v, kids: [], close: '', preserve: !!(k.preserve || top.preserve) };
      top.kids.push(node);
      if (!k.self) stack.push(node);
    } else if (k.t === 'close') { if (stack.length > 1) { (top as Extract<Node, { t: 'el' }>).close = k.v; stack.pop(); } }
    else top.kids.push(k);
  }
  return root;
}
const isWs = (k: Node | Tok) => k.t === 'text' && !/\S/.test((k as Tok).v);
function raw(n: Node | Tok): string { return n.t === 'el' ? n.open + n.kids.map(raw).join('') + n.close : n.v; }
const hasText = (n: Extract<Node, { t: 'el' }>) => n.kids.some((k) => (k.t === 'text' && !isWs(k)) || k.t === 'cdata');
const hasEl = (n: Extract<Node, { t: 'el' }>) => n.kids.some((k) => k.t === 'el');

export function pretty(src: string, unit: string, dropComments: boolean): string {
  const lines: string[] = [];
  function walk(kids: (Node | Tok)[], d: number) {
    for (const k of kids) {
      if (isWs(k)) continue;
      if (k.t === 'comment' && dropComments) continue;
      const pad = unit.repeat(d);
      if (k.t !== 'el') { lines.push(pad + (k.t === 'text' ? k.v.trim() : k.v)); continue; }
      if (k.preserve || (hasText(k) && hasEl(k))) { lines.push(pad + raw(k)); continue; } // mixed content stays exactly as written
      if (!hasEl(k) && !k.kids.some((x) => x.t === 'comment' || x.t === 'pi')) {
        lines.push(pad + k.open + k.kids.map(raw).join('') + k.close); continue;
      }
      lines.push(pad + k.open);
      walk(k.kids, d + 1);
      if (k.close) lines.push(pad + k.close);
    }
  }
  walk(tree(src).kids, 0);
  return lines.join('\n');
}
export function minify(src: string, dropComments: boolean): string {
  function walk(kids: (Node | Tok)[], keepWs: boolean): string {
    return kids.map((k) => {
      if (k.t === 'comment') return dropComments ? '' : k.v;
      if (isWs(k)) return keepWs ? (k as Tok).v : '';
      if (k.t !== 'el') return k.v;
      const keep = k.preserve || hasText(k);
      return k.open + walk(k.kids, keep) + k.close;
    }).join('');
  }
  return walk(tree(src).kids, false);
}

// ================= tree helpers: JSON, namespaces, XPath =================
/** prefix → URI for every xmlns:p in the document (first wins), plus the root's default namespace as "d" (or "dd"…). */
export function namespaces(doc: XNode): Record<string, string> {
  const map: Record<string, string> = {};
  const rootEl = doc.children.find((c) => c.type === ELEMENT);
  const all = allElements(doc);
  for (let i = 0; i < all.length && i < 20000; i++) {
    for (const a of all[i].attrs) {
      const m = /^xmlns:(.+)$/.exec(a.name);
      if (m && !(m[1] in map)) map[m[1]] = a.value;
    }
  }
  if (rootEl && rootEl.ns && !rootEl.prefix) {
    let p = 'd';
    while (p in map) p += 'd';
    map[p] = rootEl.ns;
    map.__default = p;
  }
  return map;
}

function toJson(el: XNode): unknown {
  const o: Record<string, unknown> = {};
  let text = '', hasKids = false;
  for (const a of el.attrs) o['@' + a.name] = a.value;
  for (const k of el.children) {
    if (k.type === ELEMENT) {
      hasKids = true;
      const v = toJson(k), name = k.name;
      if (Object.prototype.hasOwnProperty.call(o, name)) { if (!Array.isArray(o[name])) o[name] = [o[name]]; (o[name] as unknown[]).push(v); }
      else o[name] = v;
    } else if (k.type === TEXT || k.type === CDATA) text += k.value;
  }
  text = text.trim();
  if (!hasKids && el.attrs.length === 0) return text;
  if (text) o['#text'] = text;
  return o;
}
export function xmlToJson(doc: XNode) {
  const root = doc.children.find((c) => c.type === ELEMENT)!;
  return { [root.name]: toJson(root) };
}

export function pathOf(el: XNode, ns: Record<string, string>) {
  const parts: string[] = [];
  for (let n: XNode | null = el; n && n.type === ELEMENT; n = n.parent) {
    const name = n.prefix || !n.ns ? n.name : (ns.__default ? ns.__default + ':' : '') + n.localName;
    let idx = 1, same = 0;
    for (const s of n.parent ? n.parent.children : []) if (s.type === ELEMENT && s.name === n.name) { same++; if (s === n) idx = same; }
    parts.unshift(name + (same > 1 ? '[' + idx + ']' : ''));
  }
  return '/' + parts.join('/');
}

export function nodeText(n: XNode) {
  if (n.type === ATTRIBUTE) return n.name + '="' + n.value + '"';
  if (n.type === TEXT || n.type === CDATA) return n.value;
  if (n.type === DOCUMENT) return '(the whole document)';
  return serialize(n);
}

export type XPathResult = { kind: 'number' | 'string' | 'boolean'; value: number | string | boolean } | { kind: 'nodes'; nodes: XNode[] };
export function xpath(doc: XNode, expr: string, extra: Record<string, string> = {}): XPathResult {
  const v = evaluate(expr, doc, { ...namespaces(doc), ...extra });
  if (Array.isArray(v)) return { kind: 'nodes', nodes: v };
  return { kind: typeof v as 'number' | 'string' | 'boolean', value: v };
}

function depthOf(el: XNode, k = 1): number { let d = k; for (const c of elementChildren(el)) d = Math.max(d, depthOf(c, k + 1)); return d; }

// ================= tools =================
const xmlFormat = defineTool({
  name: 'xml_format',
  title: 'XML format / minify / validate / to JSON',
  webSlug: 'xml-format',
  description:
    'Validate XML (well-formedness and namespaces, with line and column for errors), pretty-print it (2, 4 spaces or tab; ' +
    'mixed content, CDATA and xml:space="preserve" kept exactly as written), minify it, or convert it to JSON (attributes as ' +
    '"@name", repeated elements as arrays, text as "#text"). Optionally removes comments. Never loads external DTDs or ' +
    `entities. Give "text" or a file "path". Web version: ${webUrl('xml-format')}`,
  inputSchema: z.object({
    text: textField('XML'),
    path: pathField('XML'),
    mode: z.enum(['format', 'minify', 'json', 'validate']).optional().default('format')
      .describe('"format" pretty-prints, "minify" strips layout whitespace, "json" converts to JSON, "validate" only checks (never throws on bad XML).'),
    indent: indentField('2'),
    removeComments: z.boolean().optional().default(false).describe('Drop <!-- comments --> (format and minify).'),
    output: outputField(),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    error: z.string().optional(), line: z.number().optional(), column: z.number().optional(),
    elements: z.number().optional(), depth: z.number().optional(),
    ...resultShape,
  }),
  annotations: READ_ONLY,
  examples: [
    { input: { text: "<r><a>1</a><b x='1'  y=\"2\"><c/></b></r>" }, output: { valid: true, elements: 4, depth: 3, result: "<r>\n  <a>1</a>\n  <b x='1' y=\"2\">\n    <c/>\n  </b>\n</r>" } },
    { input: { text: '<a>\n  <b></a>', mode: 'validate' }, output: { valid: false, error: 'Opening and ending tag mismatch: b line 2 and a', line: 2, column: 6 } },
  ],
  async run(input, ctx) {
    const src = await readText(input, ctx);
    if (!src.trim()) throw new ToolError('The XML is empty.');
    const r = parseXml(src);
    if (!r.ok) {
      if (input.mode === 'validate') return { valid: false, error: r.error, line: r.line, column: r.col };
      failAt('Invalid XML', r.error, src, { line: r.line, col: r.col });
    }
    const stats = { valid: true, elements: allElements(r.doc).length, depth: depthOf(r.root) };
    if (input.mode === 'validate') return stats;
    const unit = indentUnit(input.indent);
    if (input.mode === 'json') {
      const json = JSON.stringify(xmlToJson(r.doc), null, unit === '\t' ? '\t' : unit.length);
      return { ...stats, ...(await deliver(json, { output: input.output, defaultName: 'data.json', mimeType: 'application/json' }, ctx)) };
    }
    const out = input.mode === 'minify' ? minify(src, input.removeComments) : pretty(src, unit, input.removeComments);
    return { ...stats, ...(await deliver(out, { output: input.output, defaultName: 'data.xml', mimeType: 'application/xml' }, ctx)) };
  },
});

const TYPE_NAME: Record<number, string> = { [ELEMENT]: 'element', [ATTRIBUTE]: 'attribute', [TEXT]: 'text', [CDATA]: 'cdata', [COMMENT]: 'comment', [PI]: 'processing-instruction', [DOCUMENT]: 'document' };

const xmlQuery = defineTool({
  name: 'xml_query',
  title: 'XML XPath query',
  webSlug: 'xml-format',
  description:
    'Run an XPath 1.0 expression on XML: node-sets (elements, attributes, text…), numbers (count(), sum()), strings and ' +
    'booleans. Full XPath 1.0: all axes, predicates, operators and the core function library. Namespace prefixes declared ' +
    'anywhere in the document can be used as-is; a default namespace on the root gets the prefix "d" (e.g. //d:book), as on the ' +
    `website. Each matched node comes back as XML text plus its type, name and XPath location. Web version: ${webUrl('xml-format')}`,
  inputSchema: z.object({
    text: textField('XML'),
    path: pathField('XML'),
    xpath: z.string().min(1).describe('XPath 1.0 expression, e.g. "//book[price > 30]/title", "count(//item)", "//d:entry/@id".'),
    namespaces: z.record(z.string(), z.string()).optional().describe('Extra or overriding prefix → namespace URI bindings, e.g. {"atom":"http://www.w3.org/2005/Atom"}.'),
    limit: z.number().int().min(1).max(100000).optional().default(1000).describe('Return at most this many nodes (default 1000).'),
  }),
  outputSchema: z.object({
    kind: z.enum(['nodes', 'number', 'string', 'boolean']),
    value: z.union([z.number(), z.string(), z.boolean()]).optional().describe('For number / string / boolean results.'),
    count: z.number().optional().describe('Number of matched nodes.'),
    nodes: z.array(z.object({
      type: z.string(), name: z.string().optional(), location: z.string().optional().describe('XPath of the element (or its owner, for attributes).'),
      text: z.string().describe('The node as XML (attributes as name="value", text as its content).'),
    })).optional(),
    truncated: z.boolean().optional(),
    namespaces: z.record(z.string(), z.string()).describe('Prefixes available to the expression.'),
    hint: z.string().optional(),
  }),
  annotations: READ_ONLY,
  examples: [{ input: { text: '<lib><book><price>42</price><title>A</title></book><book><price>9</price><title>B</title></book></lib>', xpath: '//book[price > 30]/title' }, output: { kind: 'nodes', count: 1, nodes: [{ type: 'element', name: 'title', location: '/lib/book[1]/title', text: '<title>A</title>' }] } }],
  async run(input, ctx) {
    const src = await readText(input, ctx);
    const r = parseXml(src);
    if (!r.ok) failAt('Invalid XML', r.error, src, { line: r.line, col: r.col });
    const ns = namespaces(r.doc);
    const shown = Object.fromEntries(Object.entries({ ...ns, ...(input.namespaces ?? {}) }).filter(([k]) => k !== '__default'));
    let res: XPathResult;
    try {
      res = xpath(r.doc, input.xpath, input.namespaces);
    } catch (e) {
      if (e instanceof XPathError) throw new ToolError('Invalid XPath: ' + e.message);
      throw e;
    }
    if (res.kind !== 'nodes') return { kind: res.kind, value: res.kind === 'number' && !Number.isFinite(res.value as number) ? numToString(res.value as number) : res.value, namespaces: shown };
    const nodes = res.nodes.slice(0, input.limit).map((n) => {
      const el = n.type === ATTRIBUTE ? n.owner! : n.type === ELEMENT ? n : null;
      return {
        type: TYPE_NAME[n.type],
        ...(n.type === ELEMENT || n.type === ATTRIBUTE || n.type === PI ? { name: n.name } : {}),
        ...(el ? { location: pathOf(el, ns) + (n.type === ATTRIBUTE ? '/@' + n.name : '') } : {}),
        text: nodeText(n),
      };
    });
    const hint = !res.nodes.length
      ? ns.__default
        ? `No match. This document has a default namespace: prefix element names with ${ns.__default}: (e.g. //${ns.__default}:${r.root.localName}).`
        : 'No match. Try //* to list every element.'
      : undefined;
    return {
      kind: 'nodes', count: res.nodes.length, nodes, namespaces: shown,
      ...(res.nodes.length > nodes.length ? { truncated: true } : {}), ...(hint ? { hint } : {}),
    };
  },
});

export default [xmlFormat, xmlQuery];

// re-exported for tests
export { parseXml, serialize, textContent, XMLNS_NS };

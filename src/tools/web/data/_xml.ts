/**
 * A small, strict XML 1.0 parser with namespaces: the headless stand-in for the browser's
 * DOMParser("application/xml") that https://github.com/s3eidat/xml-format uses for validation, the JSON view and XPath.
 * Well-formedness errors carry line/column and libxml2-style messages (what Chrome shows).
 * Internal DTD entities are expanded (with loop and amplification limits); external DTDs are never loaded.
 */

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export const ELEMENT = 1, ATTRIBUTE = 2, TEXT = 3, CDATA = 4, PI = 7, COMMENT = 8, DOCUMENT = 9;

export interface XNode {
  type: number;
  parent: XNode | null;
  /** Children of an element or the document (text, cdata, comment, pi, element). */
  children: XNode[];
  /** Element attributes, including xmlns declarations. */
  attrs: XNode[];
  /** Qualified name (element / attribute), PI target, or "#text" etc. */
  name: string;
  prefix: string | null;
  localName: string;
  ns: string | null;
  /** Attribute value, text / CDATA / comment data, PI data. */
  value: string;
  /** Document order index. */
  order: number;
  /** For an attribute: its element (XPath parent). */
  owner?: XNode;
}

export class XmlError extends Error {
  constructor(message: string, public line: number, public col: number) { super(message); }
}

function mk(type: number, name: string, value = ''): XNode {
  return { type, parent: null, children: [], attrs: [], name, prefix: null, localName: name, ns: null, value, order: 0 };
}

const NAME_START = 'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHAR = NAME_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040';
const NAME_RE = new RegExp(`[:${NAME_START}][:${NAME_CHAR}]*`, 'uy');
const BAD_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;
const PREDEF: Record<string, string> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };
const MAX_EXPANSION = 10_000_000, MAX_DEPTH = 40;

interface Entity { value: string | null /* null = external, not loaded */ }

class Parser {
  i = 0;
  entities = new Map<string, Entity>();
  hasExternal = false; // external subset or PE references: undefined entities are then not fatal (as libxml2)
  expanded = 0;
  stack: string[] = [];
  constructor(public s: string, public base = 0, public whole = s) {}

  pos(off = this.i) {
    const abs = this.base + off;
    let line = 1, last = -1;
    for (let k = 0; k < abs; k++) if (this.whole.charCodeAt(k) === 10) { line++; last = k; }
    return { line, col: abs - last };
  }
  fail(msg: string, off = this.i): never { const p = this.pos(off); throw new XmlError(msg, p.line, p.col); }
  starts(t: string) { return this.s.startsWith(t, this.i); }
  ws() { const st = this.i; while (this.i < this.s.length && /[ \t\r\n]/.test(this.s[this.i])) this.i++; return this.i > st; }
  name(what: string): string {
    NAME_RE.lastIndex = this.i;
    const m = NAME_RE.exec(this.s);
    if (!m) this.fail(what);
    this.i += m[0].length;
    return m[0];
  }
  checkChars(t: string, off: number, what: string) {
    const m = BAD_CHAR.exec(t);
    if (m) this.fail(`${what} invalid Char value ${m[0].charCodeAt(0)}`, off + m.index);
  }

  // ---------------- document ----------------
  document(): XNode {
    const doc = mk(DOCUMENT, '#document');
    if (this.s.charCodeAt(0) === 0xfeff) this.i = 1;
    if (/^<\?xml[ \t\r\n?]/.test(this.s.slice(this.i, this.i + 6))) this.xmlDecl();
    let root: XNode | null = null, sawDoctype = false;
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) break;
      if (this.starts('<!--')) { this.append(doc, this.comment()); continue; }
      if (this.starts('<?')) { this.append(doc, this.pi()); continue; }
      if (this.starts('<!DOCTYPE')) {
        if (root || sawDoctype) this.fail(root ? 'Extra content at the end of the document' : 'DOCTYPE improperly terminated');
        this.doctype(); sawDoctype = true; continue;
      }
      if (this.s[this.i] === '<' && !root) { root = this.element(doc, new Map([['xml', XML_NS]]), 0); continue; }
      if (root) this.fail('Extra content at the end of the document');
      this.fail("Start tag expected, '<' not found");
    }
    if (!root) this.fail(this.s.trim() ? "Start tag expected, '<' not found" : 'Document is empty');
    return doc;
  }
  append(parent: XNode, n: XNode) {
    // Adjacent text merges into one node, as in the DOM.
    const last = parent.children[parent.children.length - 1];
    if (n.type === TEXT && last && last.type === TEXT) { last.value += n.value; return; }
    n.parent = parent; parent.children.push(n);
  }
  xmlDecl() {
    const st = this.i, e = this.s.indexOf('?>', this.i);
    if (e < 0) this.fail("parsing XML declaration: '?>' expected");
    const body = this.s.slice(this.i + 5, e);
    if (!/^\s+version\s*=\s*(["'])1\.\d+\1/.test(body)) this.fail('Malformed declaration expecting version', st + 5);
    if (!/^\s+version\s*=\s*(["'])[^"']*\1(\s+encoding\s*=\s*(["'])[A-Za-z][\w.-]*\3)?(\s+standalone\s*=\s*(["'])(yes|no)\5)?\s*$/.test(body)) {
      this.fail("parsing XML declaration: '?>' expected", st + 5);
    }
    this.i = e + 2;
  }
  comment(): XNode {
    const st = this.i, e = this.s.indexOf('-->', this.i + 4);
    if (e < 0) this.fail('Comment not terminated', st);
    const data = this.s.slice(this.i + 4, e);
    const dd = data.indexOf('--');
    if (dd >= 0 || data.endsWith('-')) this.fail('Double hyphen within comment', st + 4 + (dd >= 0 ? dd : data.length - 1));
    this.checkChars(data, st + 4, 'xmlParseComment:');
    this.i = e + 3;
    return mk(COMMENT, '#comment', data);
  }
  pi(): XNode {
    const st = this.i;
    this.i += 2;
    const target = this.name('xmlParsePI : no target name');
    if (target.toLowerCase() === 'xml') this.fail('XML declaration allowed only at the start of the document', st);
    const e = this.s.indexOf('?>', this.i);
    if (e < 0) this.fail(`ParsePI: PI ${target} never end ...`, st);
    if (this.i < e && !this.ws()) this.fail(`ParsePI: PI ${target} space expected`);
    const data = this.s.slice(this.i, e);
    this.i = e + 2;
    const n = mk(PI, target, data);
    return n;
  }
  doctype() {
    const st = this.i;
    this.i += 9;
    if (!this.ws()) this.fail('Space required after the DOCTYPE keyword');
    this.name('xmlParseDocTypeDecl : no DOCTYPE name !');
    // find the end, skipping quoted strings and the [ internal subset ]
    let depth = 0, q: string | null = null, j = this.i, subStart = -1, subEnd = -1;
    for (; j < this.s.length; j++) {
      const c = this.s[j];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '[') { if (depth === 0) subStart = j + 1; depth++; }
      else if (c === ']') { depth--; if (depth === 0) subEnd = j; }
      else if (c === '>' && depth <= 0) break;
    }
    if (j >= this.s.length) this.fail('DOCTYPE improperly terminated', st);
    const head = this.s.slice(this.i, subStart > 0 ? subStart - 1 : j);
    if (/\b(SYSTEM|PUBLIC)\b/.test(head)) this.hasExternal = true;
    if (subStart > 0) {
      const sub = this.s.slice(subStart, subEnd);
      if (/%[A-Za-z_][\w.-]*;/.test(sub.replace(/(["'])[\s\S]*?\1/g, ''))) this.hasExternal = true;
      const re = /<!ENTITY\s+(%\s+)?([^\s%]+)\s+(?:(["'])([\s\S]*?)\3|(?:SYSTEM|PUBLIC)\b[^>]*)\s*>|<!--[\s\S]*?-->|(["'])[\s\S]*?\5/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sub))) {
        if (!m[2] || m[1]) continue; // comments, stray strings, parameter entities
        if (!this.entities.has(m[2])) this.entities.set(m[2], { value: m[3] ? m[4] : null });
      }
    }
    this.i = j + 1;
  }

  // ---------------- elements ----------------
  element(parent: XNode, scope: Map<string, string>, depth: number): XNode {
    const st = this.i;
    if (depth > 1000) this.fail('Excessive depth in document: 1000');
    this.i++;
    const qname = this.name('StartTag: invalid element name');
    const el = mk(ELEMENT, qname);
    const seen = new Set<string>();
    let self = false;
    for (;;) {
      const hadWs = this.ws();
      if (this.i >= this.s.length) this.fail(`Couldn't find end of Start Tag ${qname} line ${this.pos(st).line}`);
      if (this.starts('/>')) { this.i += 2; self = true; break; }
      if (this.s[this.i] === '>') { this.i++; break; }
      if (!hadWs) this.fail('attributes construct error');
      const aSt = this.i;
      const an = this.name('attributes construct error');
      this.ws();
      if (this.s[this.i] !== '=') this.fail(`Specification mandates value for attribute ${an}`);
      this.i++;
      this.ws();
      const q = this.s[this.i];
      if (q !== '"' && q !== "'") this.fail('AttValue: " or \' expected');
      const e = this.s.indexOf(q, this.i + 1);
      if (e < 0) this.fail('AttValue: \' expected', this.s.length);
      const raw = this.s.slice(this.i + 1, e);
      const lt = raw.indexOf('<');
      if (lt >= 0) this.fail("Unescaped '<' not allowed in attributes values", this.i + 1 + lt);
      const val = this.attrValue(raw, this.i + 1);
      this.i = e + 1;
      if (seen.has(an)) this.fail(`Attribute ${an} redefined`, aSt);
      seen.add(an);
      const a = mk(ATTRIBUTE, an, val);
      a.owner = el; a.parent = el;
      el.attrs.push(a);
    }
    // namespaces
    let local = scope;
    for (const a of el.attrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
        if (local === scope) local = new Map(scope);
        const p = a.name === 'xmlns' ? '' : a.name.slice(6);
        if (p === 'xmlns' || (p === 'xml' && a.value !== XML_NS)) this.fail(`xmlns: prefix ${p} is reserved`, st);
        if (p && !a.value) this.fail(`xmlns:${p}: Empty XML namespace is not allowed`, st);
        local.set(p, a.value);
        a.ns = XMLNS_NS;
        a.prefix = p ? 'xmlns' : null;
        a.localName = p || 'xmlns';
      }
    }
    this.resolve(el, local, true, st);
    const anames = new Set<string>();
    for (const a of el.attrs) {
      if (a.ns === XMLNS_NS) continue;
      this.resolve(a, local, false, st);
      const key = (a.ns ?? '') + '\u0000' + a.localName;
      if (a.ns && anames.has(key)) this.fail(`Namespaced Attribute ${a.localName} in '${a.ns}' redefined`, st);
      anames.add(key);
    }
    this.append(parent, el);
    if (self) return el;
    this.content(el, local, depth + 1, false);
    // end tag
    if (!this.starts('</')) this.fail(`Premature end of data in tag ${qname} line ${this.pos(st).line}`);
    const cst = this.i;
    this.i += 2;
    NAME_RE.lastIndex = this.i;
    const m = NAME_RE.exec(this.s);
    const cname = m ? m[0] : '';
    this.i += cname.length;
    this.ws();
    if (cname !== qname) this.fail(`Opening and ending tag mismatch: ${qname} line ${this.pos(st).line} and ${cname}`, cst);
    if (this.s[this.i] !== '>') this.fail(`expected '>'`);
    this.i++;
    return el;
  }
  resolve(n: XNode, scope: Map<string, string>, isEl: boolean, at: number) {
    const parts = n.name.split(':');
    if (parts.length > 2 || (n.name.includes(':') && (!parts[0] || !parts[1]))) this.fail(`Failed to parse QName '${n.name}'`, at);
    if (parts.length === 2) {
      n.prefix = parts[0]; n.localName = parts[1];
      const ns = scope.get(parts[0]);
      if (ns == null) this.fail(`Namespace prefix ${parts[0]} ${isEl ? 'on ' + parts[1] : 'for ' + parts[1] + ' on ' + (n.owner?.name ?? '')} is not defined`, at);
      n.ns = ns;
    } else {
      n.localName = n.name;
      n.ns = isEl ? scope.get('') || null : null;
    }
  }

  /** Parse content until "</" (or the end when `fragment`). */
  content(parent: XNode, scope: Map<string, string>, depth: number, fragment: boolean) {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '<') {
        if (this.starts('</')) { if (fragment) this.fail('Opening and ending tag mismatch'); return; }
        if (this.starts('<!--')) { this.append(parent, this.comment()); continue; }
        if (this.starts('<![CDATA[')) {
          const st = this.i, e = s.indexOf(']]>', this.i + 9);
          if (e < 0) this.fail('CData section not finished', st);
          const data = s.slice(this.i + 9, e);
          this.checkChars(data, st + 9, 'PCDATA');
          this.append(parent, mk(CDATA, '#cdata-section', data));
          this.i = e + 3; continue;
        }
        if (this.starts('<?')) { this.append(parent, this.pi()); continue; }
        if (this.starts('<!')) this.fail('StartTag: invalid element name');
        this.element(parent, scope, depth);
        continue;
      }
      // text up to the next markup
      let e = s.indexOf('<', this.i);
      if (e < 0) e = s.length;
      const st = this.i, raw = s.slice(this.i, e);
      const bad = raw.indexOf(']]>');
      if (bad >= 0) this.fail("Sequence ']]>' not allowed in content", st + bad);
      this.checkChars(raw, st, 'PCDATA');
      let text = '', k = 0;
      while (k < raw.length) {
        const amp = raw.indexOf('&', k);
        if (amp < 0) { text += raw.slice(k); break; }
        text += raw.slice(k, amp);
        const semi = raw.indexOf(';', amp);
        const ref = semi > 0 ? raw.slice(amp + 1, semi) : '';
        if (!ref || /\s/.test(ref)) this.fail(ref[0] === '#' ? 'CharRef: invalid decimal value' : 'xmlParseEntityRef: no name', st + amp);
        if (ref[0] === '#') { text += this.charRef(ref, st + amp); k = semi + 1; continue; }
        if (PREDEF[ref]) { text += PREDEF[ref]; k = semi + 1; continue; }
        const ent = this.entities.get(ref);
        if (!ent) {
          if (!this.hasExternal) this.fail(`Entity '${ref}' not defined`, st + amp);
          k = semi + 1; continue; // external DTD not loaded: libxml2 only warns
        }
        k = semi + 1;
        if (ent.value == null) continue;
        if (text) { this.append(parent, mk(TEXT, '#text', text)); text = ''; }
        this.expand(ref, ent.value, parent, scope, depth, st + amp);
      }
      if (text) this.append(parent, mk(TEXT, '#text', text));
      this.i = e;
    }
    if (!fragment) this.fail(`Premature end of data in tag ${parent.name} line ${this.pos(this.i).line}`);
  }
  expand(name: string, value: string, parent: XNode, scope: Map<string, string>, depth: number, at: number) {
    if (this.stack.includes(name) || this.stack.length >= MAX_DEPTH) this.fail('Detected an entity reference loop', at);
    this.expanded += value.length;
    if (this.expanded > MAX_EXPANSION) this.fail('Maximum entity amplification factor exceeded', at);
    const sub = new Parser(value);
    sub.entities = this.entities; sub.hasExternal = this.hasExternal;
    sub.stack = this.stack.concat(name);
    sub.expanded = this.expanded;
    try {
      sub.content(parent, scope, depth, true);
    } catch (e) {
      if (!(e instanceof XmlError)) throw e;
      this.fail(/^(Detected|Maximum)/.test(e.message) ? e.message : `${e.message} (in entity '${name}')`, at);
    }
    this.expanded = sub.expanded;
  }
  charRef(ref: string, at: number) {
    const hex = ref[1] === 'x';
    const digits = ref.slice(hex ? 2 : 1);
    if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) this.fail(hex ? 'CharRef: invalid hexadecimal value' : 'CharRef: invalid decimal value', at);
    const cp = parseInt(digits, hex ? 16 : 10);
    const ok = cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
    if (!ok) this.fail(`xmlParseCharRef: invalid xmlChar value ${cp}`, at);
    return String.fromCodePoint(cp);
  }
  attrValue(raw: string, off: number): string {
    let out = '', k = 0;
    while (k < raw.length) {
      const c = raw[k];
      if (c === '&') {
        const semi = raw.indexOf(';', k);
        const ref = semi > 0 ? raw.slice(k + 1, semi) : '';
        if (!ref || /\s/.test(ref)) this.fail("xmlParseEntityRef: no name", off + k);
        if (ref[0] === '#') out += this.charRef(ref, off + k);
        else if (PREDEF[ref]) out += PREDEF[ref];
        else {
          const ent = this.entities.get(ref);
          if (!ent) { if (!this.hasExternal) this.fail(`Entity '${ref}' not defined`, off + k); }
          else if (ent.value == null) this.fail(`Attribute references external entity '${ref}'`, off + k);
          else {
            if (ent.value.includes('<')) this.fail(`'<' in entity '${ref}' is not allowed in attributes values`, off + k);
            this.expanded += ent.value.length;
            if (this.expanded > MAX_EXPANSION) this.fail('Maximum entity amplification factor exceeded', off + k);
            out += this.attrValue(ent.value, off + k);
          }
        }
        k = semi + 1; continue;
      }
      out += c === '\t' || c === '\n' || c === '\r' ? ' ' : c;
      k++;
    }
    this.checkChars(out, off, 'AttValue:');
    return out;
  }
}

function number(doc: XNode) {
  let n = 0;
  (function walk(x: XNode) {
    x.order = n++;
    for (const a of x.attrs) a.order = n++;
    for (const c of x.children) walk(c);
  })(doc);
}

export type ParseResult = { ok: true; doc: XNode; root: XNode } | { ok: false; error: string; line: number; col: number };

export function parseXml(text: string): ParseResult {
  try {
    const doc = new Parser(text).document();
    number(doc);
    return { ok: true, doc, root: doc.children.find((c) => c.type === ELEMENT)! };
  } catch (e) {
    if (e instanceof XmlError) return { ok: false, error: e.message, line: e.line, col: e.col };
    if (e instanceof RangeError) return { ok: false, error: 'Document too deeply nested', line: 1, col: 1 };
    throw e;
  }
}

// ---------------- DOM-ish helpers ----------------
export function textContent(n: XNode): string {
  if (n.type === ATTRIBUTE || n.type === TEXT || n.type === CDATA || n.type === COMMENT || n.type === PI) return n.value;
  let s = '';
  for (const c of n.children) if (c.type === TEXT || c.type === CDATA) s += c.value; else if (c.type === ELEMENT) s += textContent(c);
  return s;
}
export function elementChildren(n: XNode) { return n.children.filter((c) => c.type === ELEMENT); }
export function allElements(n: XNode, out: XNode[] = []): XNode[] {
  for (const c of n.children) if (c.type === ELEMENT) { out.push(c); allElements(c, out); }
  return out;
}

// ---------------- serializer (XMLSerializer-like) ----------------
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

export function serialize(n: XNode, scope: Map<string, string | null> = new Map([['xml', XML_NS]])): string {
  switch (n.type) {
    case DOCUMENT: return n.children.map((c) => serialize(c, scope)).join('');
    case TEXT: return escText(n.value);
    case CDATA: return '<![CDATA[' + n.value + ']]>';
    case COMMENT: return '<!--' + n.value + '-->';
    case PI: return '<?' + n.name + (n.value ? ' ' + n.value : '') + '?>';
    case ATTRIBUTE: return n.name + '="' + escAttr(n.value) + '"';
  }
  const local = new Map(scope);
  const decls: string[] = [];
  for (const a of n.attrs) if (a.ns === XMLNS_NS) local.set(a.prefix ? a.localName : '', a.value || null);
  const need = (p: string, ns: string | null) => {
    if ((local.get(p) ?? null) !== ns) { decls.push((p ? 'xmlns:' + p : 'xmlns') + '="' + escAttr(ns ?? '') + '"'); local.set(p, ns); }
  };
  need(n.prefix ?? '', n.ns);
  for (const a of n.attrs) if (a.ns !== XMLNS_NS && a.prefix && a.prefix !== 'xml') need(a.prefix, a.ns);
  const attrs = n.attrs.map((a) => ' ' + a.name + '="' + escAttr(a.value) + '"').join('') + decls.map((d) => ' ' + d).join('');
  if (!n.children.length) return '<' + n.name + attrs + '/>';
  return '<' + n.name + attrs + '>' + n.children.map((c) => serialize(c, local)).join('') + '</' + n.name + '>';
}

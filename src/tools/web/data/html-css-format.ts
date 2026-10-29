import { z } from 'zod';
import { defineTool, ToolError, webUrl, type ToolContext } from '../../../registry.js';
import { deliver, indentField, indentUnit, outputField, pathField, READ_ONLY, readText, resultShape, textField } from './_io.js';

// Ported from https://github.com/s3eidat/html-css-format (app.js): own HTML and CSS tokenizers. Output is text only.

function set(s: string) { const o: Record<string, boolean> = Object.create(null); for (const w of s.split(' ')) o[w] = true; return o; }

const VOID = set('area base br col embed hr img input link meta source track wbr param keygen command basefont frame isindex');
const RAW = set('script style textarea title pre xmp plaintext listing');
const INLINE = set('a abbr acronym b bdi bdo big br button cite code data dfn em font i img input kbd label mark meter ' +
  'output q ruby rp rt s samp select small span strike strong sub sup time tt u var wbr del ins textarea title');
// Opening one of these closes an open <p>; <li>, <option>, <tr>, <td> etc. close their own kind.
const CLOSES_P = set('address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 ' +
  'header hgroup hr main menu nav ol p pre section table ul');
const SELF_SIBLING: Record<string, Record<string, boolean>> = {
  li: set('li'), option: set('option optgroup'), dt: set('dt dd'), dd: set('dt dd'), tr: set('tr'),
  td: set('td th'), th: set('td th'), thead: set('tbody tfoot'), tbody: set('tbody tfoot'), optgroup: set('optgroup'),
};

// ================= HTML =================
type HTok = { t: 'text' | 'comment' | 'cdata' | 'decl' | 'close' | 'open' | 'raw'; v: string; name?: string; self?: boolean };
type HNode = { t: 'root' | 'el' | 'text' | 'comment' | 'cdata' | 'decl' | 'stray'; v?: string; name?: string; open?: string; kids: HNode[]; close?: string | null; raw?: string };

// Collapse whitespace between attributes (outside quotes) so tags are stable.
function normTag(raw: string) {
  let out = '', q: string | null = null, sp = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) { out += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (sp && !/=$/.test(out)) out += ' '; sp = false; q = c; out += c; continue; }
    if (/\s/.test(c)) { sp = true; continue; }
    if (sp) {
      if (c !== '>' && c !== '=' && !/=$/.test(out) && !(c === '/' && raw[i + 1] === '>')) out += ' ';
      else if (c === '/' && raw[i + 1] === '>') out += ' ';
      sp = false;
    }
    out += c;
  }
  return out;
}
function tagEnd(s: string, i: number) { // index after the closing ">" of a tag that starts at i, respecting quoted values
  let q: string | null = null;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (/[=\s]/.test(s[j - 1])) q = c; continue; }
    if (c === '>') return j + 1;
  }
  return s.length;
}
export function htmlTokens(s: string): HTok[] {
  const toks: HTok[] = [];
  let i = 0, text = '';
  const n = s.length;
  const flush = () => { if (text) { toks.push({ t: 'text', v: text }); text = ''; } };
  while (i < n) {
    if (s[i] !== '<') { let nx = s.indexOf('<', i); if (nx < 0) nx = n; text += s.slice(i, nx); i = nx; continue; }
    const c1 = s[i + 1] || '';
    let e: number;
    if (s.startsWith('<!--', i)) { flush(); e = s.indexOf('-->', i + 4); e = e < 0 ? n : e + 3; toks.push({ t: 'comment', v: s.slice(i, e) }); i = e; continue; }
    if (s.startsWith('<![CDATA[', i)) { flush(); e = s.indexOf(']]>', i); e = e < 0 ? n : e + 3; toks.push({ t: 'cdata', v: s.slice(i, e) }); i = e; continue; }
    if (c1 === '!' || c1 === '?') { flush(); e = s.indexOf('>', i); e = e < 0 ? n : e + 1; toks.push({ t: 'decl', v: s.slice(i, e).replace(/\s+/g, ' ') }); i = e; continue; }
    if (c1 === '/' && /[A-Za-z]/.test(s[i + 2] || '')) {
      flush(); e = s.indexOf('>', i); e = e < 0 ? n : e + 1;
      const cname = /^<\/([^\s>/]+)/.exec(s.slice(i, e))![1];
      toks.push({ t: 'close', name: cname.toLowerCase(), v: '</' + cname + '>' }); i = e; continue;
    }
    if (/[A-Za-z]/.test(c1)) {
      flush(); e = tagEnd(s, i);
      const raw = s.slice(i, e), name = /^<([^\s>/]+)/.exec(raw)![1], lname = name.toLowerCase();
      const tag = normTag(raw), self = /\/\s*>$/.test(raw);
      toks.push({ t: 'open', name: lname, v: tag, self });
      i = e;
      if (RAW[lname] && !self) {
        const m = new RegExp('</' + lname + '[\\s>]', 'i').exec(s.slice(i));
        const end = m ? i + m.index : n;
        toks.push({ t: 'raw', v: s.slice(i, end) }); i = end;
      }
      continue;
    }
    text += '<'; i++;
  }
  flush();
  return toks;
}
function buildTree(s: string): HNode {
  const root: HNode = { t: 'root', kids: [] }, stack: HNode[] = [root];
  const top = () => stack[stack.length - 1];
  for (const k of htmlTokens(s)) {
    if (k.t === 'open') {
      const T = top();
      if (T.name === 'p' && CLOSES_P[k.name!]) stack.pop();
      else if (T.name && SELF_SIBLING[T.name] && SELF_SIBLING[T.name][k.name!]) stack.pop();
      const node: HNode = { t: 'el', name: k.name, open: k.v, kids: [], close: null };
      top().kids.push(node);
      if (!k.self && !VOID[k.name!]) stack.push(node);
    } else if (k.t === 'raw') {
      top().raw = k.v;
    } else if (k.t === 'close') {
      let d: number;
      for (d = stack.length - 1; d > 0; d--) if (stack[d].name === k.name) break;
      if (d > 0) { stack[d].close = k.v; stack.length = d; }
      else top().kids.push({ t: 'stray', v: k.v, kids: [] });
    } else top().kids.push({ t: k.t as HNode['t'], v: k.v, kids: [] });
  }
  return root;
}
function isInline(n: HNode): boolean {
  if (n.t === 'text' || n.t === 'comment') return true;
  if (n.t !== 'el' || !INLINE[n.name!]) return false;
  return n.kids.every(isInline);
}
const wsCollapse = (s: string) => s.replace(/[ \t\n\r\f]+/g, ' ');
function inlineStr(n: HNode, dropComments: boolean): string {
  if (n.t === 'text') return wsCollapse(n.v!);
  if (n.t === 'comment') return dropComments && !/^<!--\[if/i.test(n.v!) ? '' : n.v!;
  return n.open + (n.raw != null ? n.raw : n.kids.map((k) => inlineStr(k, dropComments)).join('')) + (n.close || '');
}
export function beautifyHtml(src: string, unit: string, dropComments: boolean): string {
  const lines: string[] = [];
  const pad = (d: number) => unit.repeat(d);
  function print(kids: HNode[], d: number) {
    let run: HNode[] = [];
    function flushRun() {
      if (!run.length) return;
      const s = run.map((k) => inlineStr(k, dropComments)).join('').replace(/^ +| +$/g, '');
      if (s) lines.push(pad(d) + s);
      run = [];
    }
    for (const k of kids) {
      if (isInline(k)) { run.push(k); continue; }
      flushRun();
      if (k.t !== 'el') { lines.push(pad(d) + k.v!.trim()); continue; }
      if (k.raw != null) { lines.push(pad(d) + k.open + k.raw + (k.close || '')); continue; }
      if (k.kids.every(isInline)) {
        const inner = k.kids.map((x) => inlineStr(x, dropComments)).join('').replace(/^ +| +$/g, '');
        if (inner.length + k.open!.length <= 100 && inner.indexOf('\n') < 0) { lines.push(pad(d) + k.open + inner + (k.close || '')); continue; }
      }
      lines.push(pad(d) + k.open);
      print(k.kids, d + 1);
      if (k.close) lines.push(pad(d) + k.close);
    }
    flushRun();
  }
  print(buildTree(src).kids, 0);
  return lines.join('\n');
}
export function minifyHtml(src: string, dropComments: boolean): string {
  const isBlockish = (n: HNode | null) => !!n && !isInline(n);
  function sib(kids: HNode[], i: number, dir: number) { for (let j = i + dir; j >= 0 && j < kids.length; j += dir) if (kids[j].t !== 'comment') return kids[j]; return null; }
  function out(kids: HNode[], parentBlock: boolean): string {
    let s = '';
    kids.forEach((k, i) => {
      if (k.t === 'text') {
        let v = wsCollapse(k.v!);
        const prev = sib(kids, i, -1), next = sib(kids, i, 1);
        if (prev ? isBlockish(prev) : parentBlock) v = v.replace(/^ /, '');
        if (next ? isBlockish(next) : parentBlock) v = v.replace(/ $/, '');
        s += v;
      } else if (k.t === 'comment') {
        if (!dropComments || /^<!--\[if/i.test(k.v!)) s += k.v;
      } else if (k.t === 'el') {
        s += k.open + (k.raw != null ? k.raw : out(k.kids, !INLINE[k.name!])) + (k.close || '');
      } else s += k.v!.trim();
    });
    return s;
  }
  return out(buildTree(src).kids, true);
}

// ================= CSS =================
type CItem = { t: 'comment' | 'open' | 'decl' | 'close'; v: string };
// Split CSS into items: comment, open (prelude), decl, close. Strings, url() and escapes are kept intact.
function cssItems(s: string): CItem[] {
  const items: CItem[] = [];
  let buf = '', paren = 0, i = 0;
  const n = s.length;
  const flushDecl = () => { if (buf.trim()) items.push({ t: 'decl', v: buf }); buf = ''; };
  while (i < n) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') {
      let e = s.indexOf('*/', i + 2); e = e < 0 ? n : e + 2;
      if (!buf.trim()) { buf = ''; items.push({ t: 'comment', v: s.slice(i, e) }); } else buf += s.slice(i, e);
      i = e; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') j++; j++; }
      buf += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '\\') { buf += s.slice(i, i + 2); i += 2; continue; }
    if (/^url\(\s*[^\s"')]/i.test(s.slice(i, i + 64)) && !/[\w-]/.test(s[i - 1] || '')) {
      let k = s.indexOf(')', i); k = k < 0 ? n : k + 1;
      buf += s.slice(i, k); i = k; continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (paren === 0 && c === '{') { items.push({ t: 'open', v: buf }); buf = ''; i++; continue; }
    else if (paren === 0 && c === ';') { flushDecl(); i++; continue; }
    else if (paren === 0 && c === '}') { flushDecl(); items.push({ t: 'close', v: '' }); i++; continue; }
    buf += c; i++;
  }
  flushDecl();
  return items;
}
// Apply fn only to code outside strings, url(...) and comments.
function outside(text: string, fn: (x: string) => string, dropComments: boolean) {
  const re = /("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|url\(\s*[^\s"')][^)]*\)|\/\*[\s\S]*?(?:\*\/|$))/gi;
  let out = '', last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += fn(text.slice(last, m.index));
    out += dropComments && m[0].slice(0, 2) === '/*' && m[0][2] !== '!' ? '' : m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}
function splitTop(text: string, ch: string) { // split at ch outside parens/brackets/strings
  const parts: string[] = [];
  let depth = 0, q: string | null = null, cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { cur += c; if (c === '\\') { cur += text[++i] || ''; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ch && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}
const collapse = (t: string, drop: boolean) => outside(t, (x) => x.replace(/\s+/g, ' '), drop).trim();
function declParts(v: string, drop: boolean): { whole?: string; prop?: string; value?: string } {
  const t = collapse(v, drop);
  let idx = -1, depth = 0, q: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '(') depth++; else if (c === ')') depth--;
    else if (c === ':' && depth === 0) { idx = i; break; }
  }
  if (idx < 0 || t[0] === '@') return { whole: t };
  return { prop: t.slice(0, idx).trim(), value: t.slice(idx + 1).trim() };
}
export function beautifyCss(src: string, unit: string, drop: boolean): string {
  const lines: string[] = [];
  let d = 0, afterComment = false;
  const pad = () => unit.repeat(d);
  const all = cssItems(src);
  all.forEach((it, k) => {
    if (it.t === 'comment') {
      if (drop && it.v[2] !== '!') return;
      if (d === 0 && lines.length && lines[lines.length - 1] !== '' && !afterComment) lines.push('');
      lines.push(pad() + it.v.trim()); afterComment = true; return;
    }
    const wasComment = afterComment; afterComment = false;
    if (it.t === 'open') {
      let pre = collapse(it.v, drop);
      if (pre[0] !== '@') pre = splitTop(pre, ',').map((x) => x.trim()).join(',\n' + pad());
      else pre = outside(pre, (x) => x.replace(/\(\s*([\w-]+)\s*:\s*/g, '($1: '), drop);
      if (d === 0 && lines.length && lines[lines.length - 1] !== '' && !wasComment) lines.push('');
      lines.push(pad() + pre + (pre ? ' {' : '{'));
      d++; return;
    }
    if (it.t === 'decl') {
      const p = declParts(it.v, drop);
      if (p.whole == null && !p.prop) return;
      const val = p.whole != null ? '' : outside(p.value!, (x) => x.replace(/\s*,\s*/g, ', ').replace(/\s*!\s*important/gi, ' !important'), drop);
      lines.push(pad() + (p.whole != null ? p.whole : p.prop + ': ' + val) + ';');
      return;
    }
    d = Math.max(0, d - 1);
    lines.push(pad() + '}');
    if (d === 0 && all[k + 1]) lines.push('');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
export function minifyCss(src: string, drop: boolean): string {
  let out = '';
  const items = cssItems(src);
  items.forEach((it, k) => {
    if (it.t === 'comment') { if (!drop || it.v[2] === '!') out += it.v; return; }
    if (it.t === 'open') {
      let pre = collapse(it.v, drop);
      pre = outside(pre, pre[0] === '@'
        ? (x) => x.replace(/\s*([,:])\s*/g, '$1').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
        : (x) => x.replace(/\s*([,>~+])\s*/g, '$1'), drop);
      out += pre + '{'; return;
    }
    if (it.t === 'decl') {
      const p = declParts(it.v, drop);
      const body = p.whole != null ? p.whole : p.prop + ':' + outside(p.value!, (x) => x.replace(/\s*,\s*/g, ',').replace(/\s*!\s*important/gi, '!important'), drop);
      const next = items[k + 1];
      out += body + (next && next.t === 'close' ? '' : ';');
      return;
    }
    out += '}';
  });
  return out;
}

// ================= tools =================
const common = (what: string) => ({
  text: textField(what),
  path: pathField(what),
  mode: z.enum(['beautify', 'minify']).optional().default('beautify').describe('"beautify" (default) or "minify".'),
  indent: indentField('2'),
  removeComments: z.boolean().optional().default(false).describe(
    what === 'HTML' ? 'Drop comments (IE conditional comments are kept).' : 'Drop comments (/*! … */ license comments are kept).'),
  output: outputField(),
});
const outShape = z.object({ inputBytes: z.number(), outputBytes: z.number(), lines: z.number(), ...resultShape });

async function runFmt(
  input: { text?: string; path?: string; mode: 'beautify' | 'minify'; indent: string | number; removeComments: boolean; output?: string },
  ctx: ToolContext,
  beautify: (s: string, u: string, d: boolean) => string, minifyFn: (s: string, d: boolean) => string, name: string, mime: string,
) {
  const src = await readText(input, ctx);
  if (!src.trim()) throw new ToolError('The input is empty.');
  const out = input.mode === 'minify' ? minifyFn(src, input.removeComments) : beautify(src, indentUnit(input.indent), input.removeComments);
  return {
    inputBytes: Buffer.byteLength(src), outputBytes: Buffer.byteLength(out), lines: out.split('\n').length,
    ...(await deliver(out, { output: input.output, defaultName: (input.mode === 'minify' ? 'minified' : 'formatted') + name, mimeType: mime }, ctx)),
  };
}

const htmlFormat = defineTool({
  name: 'html_format',
  title: 'HTML beautify / minify',
  webSlug: 'html-css-format',
  description:
    'Beautify (indent block elements, keep inline runs on one line) or minify HTML with a forgiving tokenizer: implied end tags ' +
    '(<p>, <li>, <td>…), void elements, and <script>, <style>, <pre>, <textarea> contents kept byte-for-byte. Whitespace between ' +
    'attributes is normalised; attribute values are never changed. Optional comment removal (IE conditional comments kept). ' +
    `Text only: nothing is rendered or run. Give "text" or a file "path". Web version: ${webUrl('html-css-format')}`,
  inputSchema: z.object(common('HTML')),
  outputSchema: outShape,
  annotations: READ_ONLY,
  examples: [{ input: { text: '<div><p>Hi <b>there</b></p><ul><li>a<li>b</ul></div>' }, output: { result: '<div>\n  <p>Hi <b>there</b></p>\n  <ul>\n    <li>a\n    <li>b\n  </ul>\n</div>' } }],
  run: (input, ctx) => runFmt(input, ctx, beautifyHtml, minifyHtml, '.html', 'text/html'),
});

const cssFormat = defineTool({
  name: 'css_format',
  title: 'CSS beautify / minify',
  webSlug: 'html-css-format',
  description:
    'Beautify CSS (one declaration per line, one selector per line, blank line between top-level rules, nested @media blocks) ' +
    'or minify it. Strings, url(...) and escapes are kept intact; calc() spacing is preserved. Optional comment removal ' +
    `(/*! … */ kept). Give "text" or a file "path". Web version: ${webUrl('html-css-format')}`,
  inputSchema: z.object(common('CSS')),
  outputSchema: outShape,
  annotations: READ_ONLY,
  examples: [{ input: { text: 'a,b{color:red;margin:0 auto}' }, output: { result: 'a,\nb {\n  color: red;\n  margin: 0 auto;\n}' } }],
  run: (input, ctx) => runFmt(input, ctx, beautifyCss, minifyCss, '.css', 'text/css'),
});

export default [htmlFormat, cssFormat];

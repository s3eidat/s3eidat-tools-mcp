import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { deliver, outputField, READ_ONLY } from './_io.js';

// Ported from https://github.com/s3eidat/curl-convert (app.js). Parses the command text only; never sends anything.

// ================= shell words (POSIX sh quoting, as browsers' "Copy as cURL (bash)" writes it) =================
const ANSI: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
export function shellWords(src: string) {
  const s = src.replace(/\r\n?/g, '\n'), words: string[] = [];
  let cur: string | null = null, i = 0, stoppedAt: string | null = null;
  const n = s.length;
  const add = (t: string) => { cur = (cur || '') + t; };
  const end = () => { if (cur !== null) { words.push(cur); cur = null; } };
  while (i < n) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; } // bash line continuation
    if ((c === '^' || c === '`') && s[i + 1] === '\n' && cur === null) { i += 2; continue; } // cmd / PowerShell continuation
    if (c === ' ' || c === '\t' || c === '\n') { end(); i++; continue; }
    if (c === '#' && cur === null) { while (i < n && s[i] !== '\n') i++; continue; }
    if (cur === null && (c === '|' || c === ';' || c === '&' || c === '>' || c === '<')) { stoppedAt = s.slice(i).trim(); break; }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) throw new ToolError('Unclosed single quote');
      add(s.slice(i + 1, e)); i = e + 1; continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      // $'…' yields bytes: \xNN and octal are raw bytes, \u/\U and plain text are UTF-8. Decode the bytes as UTF-8 at the end.
      let j = i + 2;
      const bytes: number[] = [], enc = new TextEncoder();
      const txt = (t: string) => { for (const b of enc.encode(t)) bytes.push(b); };
      for (;;) {
        if (j >= n) throw new ToolError("Unclosed $'…' quote");
        const ch = s[j];
        if (ch === "'") break;
        if (ch !== '\\') { txt(ch); j++; continue; }
        const x = s[j + 1];
        if (ANSI[x] !== undefined) { txt(ANSI[x]); j += 2; continue; }
        let m: RegExpExecArray | null;
        if (x === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 2)))) { bytes.push(parseInt(m[0], 16)); j += 2 + m[0].length; continue; }
        if (x === 'u' && (m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(j + 2)))) { txt(String.fromCodePoint(parseInt(m[0], 16))); j += 2 + m[0].length; continue; }
        if (x === 'U' && (m = /^[0-9a-fA-F]{1,8}/.exec(s.slice(j + 2))) && parseInt(m[0], 16) <= 0x10ffff) { txt(String.fromCodePoint(parseInt(m[0], 16))); j += 2 + m[0].length; continue; }
        if ((m = /^[0-7]{1,3}/.exec(s.slice(j + 1)))) { bytes.push(parseInt(m[0], 8) & 255); j += 1 + m[0].length; continue; }
        txt('\\' + (x || '')); j += 2;
      }
      add(new TextDecoder('utf-8').decode(new Uint8Array(bytes))); i = j + 1; continue;
    }
    if (c === '"') {
      let k = i + 1, buf = '';
      for (;;) {
        if (k >= n) throw new ToolError('Unclosed double quote');
        const d = s[k];
        if (d === '"') break;
        if (d === '\\' && /["\\$`\n]/.test(s[k + 1] || '')) { if (s[k + 1] !== '\n') buf += s[k + 1]; k += 2; continue; }
        buf += d; k++;
      }
      add(buf); i = k + 1; continue;
    }
    if (c === '\\') { if (i + 1 < n) add(s[i + 1]); i += 2; continue; }
    add(c); i++;
  }
  end();
  return { words, stoppedAt };
}

// ================= curl options =================
function set(s: string) { const o: Record<string, boolean> = Object.create(null); for (const w of s.split(/\s+/)) if (w) o[w] = true; return o; }
const SHORT_ARG = set('X H d F u b A e o m x T r w c E K D U C P Y y z Q t');
const LONG_ARG = set('request header data data-raw data-binary data-ascii data-urlencode json form form-string user cookie user-agent ' +
  'referer url max-time connect-timeout proxy output cookie-jar cert key cacert capath retry retry-delay retry-max-time write-out ' +
  'resolve range upload-file oauth2-bearer aws-sigv4 unix-socket interface limit-rate max-redirs proxy-user dump-header config ' +
  'trace trace-ascii stderr ciphers connect-to continue-at expect100-timeout header-file keepalive-time local-port netrc-file ' +
  'noproxy pass proto proto-redir proxy-header socks5 socks5-hostname tls-max user-agent variable');
const IGNORED_NOTE = set('s S v i silent show-error verbose include o output w write-out f fail progress-bar # n O remote-name J remote-header-name ' +
  'trace trace-ascii stderr dump-header D c cookie-jar retry retry-delay retry-max-time limit-rate keepalive-time');

export function utf8Base64(s: string) { return Buffer.from(s, 'utf8').toString('base64'); }
// curl --data-urlencode uses RFC 3986 percent-encoding (space → %20), keeping only A-Z a-z 0-9 - . _ ~
function curlEscape(s: string) { return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }

interface FormItem { name: string; value?: string; file?: string; asText?: boolean; type?: string; filename?: string }
export interface Parsed {
  url: string; method: string; headers: [string, string][]; data: { kind: 'raw' | 'file'; value: string }[]; form: FormItem[];
  user: { user: string; pass: string } | null; cookie: string | null; get: boolean; head: boolean; upload: string | null;
  insecure: boolean; follow: boolean; compressed: boolean; timeout: number | null; connectTimeout: number | null; proxy: string | null;
  json: boolean; ignored: string[]; warnings: string[]; urls: string[]; body: string | null; bodyFile: string | null; jsonBody?: unknown;
}

export function parseCurl(text: string): Parsed {
  const sw = shellWords(text.trim().replace(/^\$\s+/, '')), w = sw.words;
  const r: Parsed = {
    url: '', method: '', headers: [], data: [], form: [], user: null, cookie: null, get: false, head: false, upload: null,
    insecure: false, follow: false, compressed: false, timeout: null, connectTimeout: null, proxy: null, json: false,
    ignored: [], warnings: [], urls: [], body: null, bodyFile: null,
  };
  let method: string | null = null;
  if (sw.stoppedAt) r.warnings.push('Ignored everything after “' + sw.stoppedAt.slice(0, 30) + '”');
  if (!w.length) throw new ToolError('Empty command');
  let start = 0;
  if (/^curl(\.exe)?$/i.test(w[0])) start = 1;
  else if (/^https?:/i.test(w[0]) || w[0][0] === '-') start = 0;
  else throw new ToolError("This doesn't start with curl");
  function opt(name: string, val: string | undefined) {
    const v = val as string;
    switch (name) {
      case 'X': case 'request': method = v.toUpperCase(); break;
      case 'H': case 'header': {
        const c = v.indexOf(':');
        if (c > 0) {
          const hv = v.slice(c + 1).replace(/^\s+/, '');
          if (hv === '' && v.slice(-1) === ':') r.headers = r.headers.filter((h) => h[0].toLowerCase() !== v.slice(0, c).trim().toLowerCase()); // "X-Foo:" removes
          else r.headers.push([v.slice(0, c).trim(), hv]);
        } else if (/;$/.test(v)) r.headers.push([v.slice(0, -1).trim(), '']);
        else if (v[0] === '@') r.warnings.push('Headers from a file (' + v + ") can't be read here");
        else r.warnings.push('Ignored a header without a colon: ' + v);
        break;
      }
      case 'd': case 'data': case 'data-ascii':
        if (v[0] === '@') { r.warnings.push('The body comes from the file ' + v.slice(1) + '; the code reads it as a placeholder'); r.data.push({ kind: 'file', value: v.slice(1) }); }
        else r.data.push({ kind: 'raw', value: v });
        break;
      case 'data-raw': r.data.push({ kind: 'raw', value: v }); break;
      case 'data-binary':
        if (v[0] === '@') { r.warnings.push('The body comes from the file ' + v.slice(1) + '; the code reads it as a placeholder'); r.data.push({ kind: 'file', value: v.slice(1) }); }
        else r.data.push({ kind: 'raw', value: v });
        break;
      case 'json':
        r.json = true;
        if (v[0] === '@') { r.warnings.push('The JSON body comes from the file ' + v.slice(1)); r.data.push({ kind: 'file', value: v.slice(1) }); }
        else r.data.push({ kind: 'raw', value: v });
        break;
      case 'data-urlencode': {
        const eq = v.indexOf('='), at = v.indexOf('@');
        if (at >= 0 && (eq < 0 || at < eq)) { r.warnings.push('--data-urlencode reads ' + v.slice(at + 1) + ' from a file; left as a placeholder'); r.data.push({ kind: 'raw', value: (at > 0 ? v.slice(0, at) + '=' : '') + '<urlencoded contents of ' + v.slice(at + 1) + '>' }); }
        else if (eq === 0) r.data.push({ kind: 'raw', value: curlEscape(v.slice(1)) });
        else if (eq > 0) r.data.push({ kind: 'raw', value: v.slice(0, eq) + '=' + curlEscape(v.slice(eq + 1)) });
        else r.data.push({ kind: 'raw', value: curlEscape(v) });
        break;
      }
      case 'F': case 'form': case 'form-string': {
        const fe = v.indexOf('=');
        if (fe < 1) { r.warnings.push('Ignored a malformed form field: ' + v); break; }
        const fname = v.slice(0, fe), fval = v.slice(fe + 1), item: FormItem = { name: fname };
        const parts = name === 'form-string' ? [fval] : fval.split(';');
        const main = parts[0];
        if (name !== 'form-string' && main[0] === '@') { item.file = main.slice(1); }
        else if (name !== 'form-string' && main[0] === '<') { item.file = main.slice(1); item.asText = true; }
        else item.value = name === 'form-string' ? fval : main;
        for (const p of parts.slice(1)) {
          const m = /^\s*(type|filename)=(.*)$/.exec(p);
          if (m) item[m[1] as 'type' | 'filename'] = m[2].replace(/^"|"$/g, '');
          else if (item.value !== undefined) item.value += ';' + p;
        }
        r.form.push(item);
        break;
      }
      case 'u': case 'user': {
        const uc = v.indexOf(':');
        r.user = uc < 0 ? { user: v, pass: '' } : { user: v.slice(0, uc), pass: v.slice(uc + 1) };
        if (uc < 0) r.warnings.push('No password after -u ' + v + ': curl would ask for one; an empty password is used');
        break;
      }
      case 'b': case 'cookie':
        if (v.indexOf('=') >= 0) r.cookie = r.cookie ? r.cookie + '; ' + v : v;
        else r.warnings.push('-b ' + v + " reads cookies from a file, which can't be done here");
        break;
      case 'A': case 'user-agent': r.headers.push(['User-Agent', v]); break;
      case 'e': case 'referer': r.headers.push(['Referer', v.replace(/;auto$/, '')]); break;
      case 'oauth2-bearer': r.headers.push(['Authorization', 'Bearer ' + v]); break;
      case 'url': r.urls.push(v); break;
      case 'm': case 'max-time': r.timeout = parseFloat(v); break;
      case 'connect-timeout': r.connectTimeout = parseFloat(v); break;
      case 'x': case 'proxy': r.proxy = v; break;
      case 'T': case 'upload-file': r.upload = v; r.warnings.push('-T uploads the file ' + v + '; the code reads it as a placeholder'); break;
      case 'G': case 'get': r.get = true; break;
      case 'I': case 'head': r.head = true; break;
      case 'k': case 'insecure': r.insecure = true; break;
      case 'L': case 'location': case 'location-trusted': r.follow = true; break;
      case 'compressed': r.compressed = true; break;
      default:
        r.ignored.push((name.length === 1 ? '-' : '--') + name + (val !== undefined ? ' ' + val : ''));
    }
  }
  for (let i = start; i < w.length; i++) {
    const a = w[i];
    let m: RegExpExecArray | null;
    if (a === '--') { r.urls = r.urls.concat(w.slice(i + 1)); break; }
    if ((m = /^--([\w.-]+)(?:=([\s\S]*))?$/.exec(a))) {
      const ln = m[1];
      if (/^no-/.test(ln) && !LONG_ARG[ln]) { r.ignored.push(a); continue; }
      if (LONG_ARG[ln]) {
        const v = m[2] !== undefined ? m[2] : w[++i];
        if (v === undefined) throw new ToolError(a + ' needs a value');
        opt(ln, v);
      } else opt(ln, undefined);
      continue;
    }
    if (a[0] === '-' && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (SHORT_ARG[ch]) {
          let val: string | undefined = a.slice(k + 1);
          if (!val) { val = w[++i]; if (val === undefined) throw new ToolError('-' + ch + ' needs a value'); }
          opt(ch, val); break;
        }
        opt(ch, undefined);
      }
      continue;
    }
    r.urls.push(a);
  }
  r.ignored = r.ignored.filter((x) => !IGNORED_NOTE[x.replace(/^-+/, '').split(' ')[0]]);
  if (!r.urls.length) throw new ToolError('No URL found');
  if (r.urls.length > 1) r.warnings.push('Only the first URL is converted (' + r.urls.length + ' given)');
  let url = r.urls[0];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http' + '://' + url;
  if (/[{}[\]]/.test(url) && !/\/\/\[/.test(url)) r.warnings.push('curl would expand [] and {} in the URL (globbing); they are kept as written');
  try { new URL(url); } catch { throw new ToolError('Not a valid URL: ' + url); }
  // Body, as curl builds it
  let body: string | null = null;
  if (r.data.length) body = r.data.map((d) => (d.kind === 'file' ? '<contents of ' + d.value + '>' : d.value)).join(r.json ? '' : '&');
  if (r.get && body !== null) { url += (url.indexOf('?') >= 0 ? '&' : '?') + body; body = null; }
  r.bodyFile = r.data.length === 1 && r.data[0].kind === 'file' ? r.data[0].value : null;
  r.url = url; r.body = body;
  r.method = method || (r.head ? 'HEAD' : body !== null || r.form.length ? 'POST' : r.upload ? 'PUT' : 'GET');
  const has = (h: string) => r.headers.some((x) => x[0].toLowerCase() === h);
  if (r.json) {
    if (!has('content-type')) r.headers.push(['Content-Type', 'application/json']);
    if (!has('accept')) r.headers.push(['Accept', 'application/json']);
  } else if (body !== null && !has('content-type')) r.headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  if (r.form.length) {
    const before = r.headers.length;
    r.headers = r.headers.filter((h) => !(h[0].toLowerCase() === 'content-type' && /multipart\/form-data/i.test(h[1])));
    if (before !== r.headers.length) r.warnings.push('Dropped the manual multipart Content-Type: each library adds it with the right boundary');
  }
  if (r.cookie) r.headers.push(['Cookie', r.cookie]);
  if (r.body !== null && r.form.length) { r.warnings.push("curl can't combine -d and -F; only the form is used"); r.body = null; }
  const ct = (r.headers.filter((h) => h[0].toLowerCase() === 'content-type')[0] || [])[1] || '';
  r.jsonBody = undefined;
  if (r.body !== null && /json/i.test(ct)) { try { r.jsonBody = JSON.parse(r.body); } catch { /* keep as text */ } }
  return r;
}

// ================= code generators =================
const js = (s: unknown) => JSON.stringify(s);
const pyStr = (s: string) => JSON.stringify(s);
export function phpStr(s: string) { return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
export function goStr(s: string) { return /["\n\\]/.test(s) && s.indexOf('`') < 0 && s.indexOf('\r') < 0 ? '`' + s + '`' : JSON.stringify(s); }
function indentLines(s: string, pad: string) { return s.split('\n').map((l, i) => (i ? pad + l : l)).join('\n'); }
function pyLit(v: unknown, d = 0): string {
  const pad = '    '.repeat(d + 1), end = '    '.repeat(d);
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number' || typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? '[\n' + v.map((x) => pad + pyLit(x, d + 1)).join(',\n') + ',\n' + end + ']' : '[]';
  const o = v as Record<string, unknown>, ks = Object.keys(o);
  return ks.length ? '{\n' + ks.map((k) => pad + JSON.stringify(k) + ': ' + pyLit(o[k], d + 1)).join(',\n') + ',\n' + end + '}' : '{}';
}
export function headerList(r: Parsed, withAuth: boolean) {
  const hs = r.headers.slice();
  if (withAuth && r.user) hs.push(['Authorization', 'Basic ' + utf8Base64(r.user.user + ':' + r.user.pass)]);
  return hs;
}
const fname = (p: string) => p.split(/[\\/]/).pop()!;

export function genFetch(r: Parsed) {
  const L: string[] = [], hs = headerList(r, true), o: string[] = [];
  if (r.insecure) L.push("// curl -k: browsers always verify TLS certificates; this can't be turned off from code.");
  if (r.cookie) L.push('// Browsers don\'t let scripts set the Cookie header; they send their own cookies (credentials: "include").');
  if (r.proxy) L.push('// curl used the proxy ' + r.proxy + '; fetch has no proxy option.');
  if (r.form.length) {
    L.push('const form = new FormData();');
    for (const f of r.form) {
      if (f.file) L.push('form.append(' + js(f.name) + ', fileInput.files[0]' + (f.filename || !f.asText ? ', ' + js(f.filename || fname(f.file)) : '') + '); // ' + (f.asText ? 'text of ' : '') + f.file + (f.type ? ' (' + f.type + ')' : ''));
      else L.push('form.append(' + js(f.name) + ', ' + js(f.value) + ');');
    }
    L.push('');
  }
  o.push('  method: ' + js(r.method) + ',');
  if (hs.length) o.push('  headers: {\n' + hs.map((h) => '    ' + js(h[0]) + ': ' + js(h[1]) + ',').join('\n') + '\n  },');
  if (r.form.length) o.push('  body: form,');
  else if (r.bodyFile) o.push('  body: fileInput.files[0], // ' + r.bodyFile);
  else if (r.upload) o.push('  body: fileInput.files[0], // ' + r.upload);
  else if (r.jsonBody !== undefined) o.push('  body: JSON.stringify(' + indentLines(JSON.stringify(r.jsonBody, null, 2), '  ') + '),');
  else if (r.body !== null) o.push('  body: ' + js(r.body) + ',');
  if (r.timeout) o.push('  signal: AbortSignal.timeout(' + Math.round(r.timeout * 1000) + '),');
  L.push('const response = await fetch(' + js(r.url) + ', {\n' + o.join('\n') + '\n});');
  L.push('const data = await response.text();', 'console.log(response.status, data);');
  return L.join('\n');
}
export function genAxios(r: Parsed) {
  const L = ['import axios from "axios";'], hs = headerList(r, false), o: string[] = [];
  if (r.insecure) L.push('import https from "node:https";');
  if (r.form.length && r.form.some((f) => f.file)) L.push('import { openAsBlob } from "node:fs";');
  L.push('');
  if (r.form.length) {
    L.push('const form = new FormData();');
    for (const f of r.form) {
      if (f.file) L.push('form.append(' + js(f.name) + ', await openAsBlob(' + js(f.file) + ')' + (f.asText ? '' : ', ' + js(f.filename || fname(f.file))) + ');');
      else L.push('form.append(' + js(f.name) + ', ' + js(f.value) + ');');
    }
    L.push('');
  }
  o.push('  method: ' + js(r.method.toLowerCase()) + ',', '  url: ' + js(r.url) + ',');
  if (hs.length) o.push('  headers: {\n' + hs.map((h) => '    ' + js(h[0]) + ': ' + js(h[1]) + ',').join('\n') + '\n  },');
  if (r.user) o.push('  auth: { username: ' + js(r.user.user) + ', password: ' + js(r.user.pass) + ' },');
  if (r.form.length) o.push('  data: form,');
  else if (r.bodyFile || r.upload) { o.push('  data: await openAsBlob(' + js(r.bodyFile || r.upload) + '),'); L.splice(1, 0, 'import { openAsBlob } from "node:fs";'); }
  else if (r.jsonBody !== undefined) o.push('  data: ' + indentLines(JSON.stringify(r.jsonBody, null, 2), '  ') + ',');
  else if (r.body !== null) o.push('  data: ' + js(r.body) + ',');
  if (r.timeout) o.push('  timeout: ' + Math.round(r.timeout * 1000) + ',');
  if (r.insecure) o.push('  httpsAgent: new https.Agent({ rejectUnauthorized: false }),');
  if (r.proxy) o.push("  // proxy: curl used " + r.proxy + " (see axios' proxy option)");
  o.push('  responseType: "text",');
  L.push('const response = await axios({\n' + o.join('\n') + '\n});');
  L.push('console.log(response.status, response.data);');
  return L.join('\n');
}
export function genPython(r: Parsed) {
  const L = ['import requests', ''], hs = headerList(r, false), args = ['url'];
  L.push('url = ' + pyStr(r.url));
  if (hs.length) { L.push('headers = {\n' + hs.map((h) => '    ' + pyStr(h[0]) + ': ' + pyStr(h[1]) + ',').join('\n') + '\n}'); args.push('headers=headers'); }
  if (r.form.length) {
    L.push('files = {\n' + r.form.map((f) =>
      '    ' + pyStr(f.name) + ': ' + (f.file
        ? (f.asText ? '(None, open(' + pyStr(f.file) + ').read())' : '(' + pyStr(f.filename || fname(f.file)) + ', open(' + pyStr(f.file) + ', "rb")' + (f.type ? ', ' + pyStr(f.type) : '') + ')')
        : '(None, ' + pyStr(f.value!) + ')') + ',').join('\n') + '\n}');
    args.push('files=files');
  } else if (r.bodyFile || r.upload) { L.push('data = open(' + pyStr((r.bodyFile || r.upload)!) + ', "rb")'); args.push('data=data'); }
  else if (r.jsonBody !== undefined) { L.push('json_data = ' + pyLit(r.jsonBody)); args.push('json=json_data'); }
  else if (r.body !== null) { L.push('data = ' + pyStr(r.body)); args.push('data=data'); }
  if (r.user) args.push('auth=(' + pyStr(r.user.user) + ', ' + pyStr(r.user.pass) + ')');
  if (r.insecure) args.push('verify=False');
  if (r.timeout || r.connectTimeout) args.push('timeout=' + (r.connectTimeout && r.timeout ? '(' + r.connectTimeout + ', ' + r.timeout + ')' : (r.timeout || r.connectTimeout)));
  if (r.proxy) args.push('proxies={"http": ' + pyStr(r.proxy) + ', "https": ' + pyStr(r.proxy) + '}');
  if (r.method === 'HEAD' && r.follow) args.push('allow_redirects=True');
  const m = r.method.toLowerCase(), callStr = /^(get|post|put|patch|delete|head|options)$/.test(m) ? 'requests.' + m + '(' : 'requests.request(' + pyStr(r.method) + ', ';
  L.push('', 'response = ' + callStr + (args.length > 2 ? '\n    ' + args.join(',\n    ') + ',\n)' : args.join(', ') + ')'));
  L.push('print(response.status_code)', 'print(response.text)');
  return L.join('\n');
}
export function genPhp(r: Parsed) {
  const L = ['<?php', '', '$ch = curl_init();', 'curl_setopt($ch, CURLOPT_URL, ' + phpStr(r.url) + ');', 'curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);'];
  const hs = headerList(r, false).filter((h) => h[0].toLowerCase() !== 'cookie');
  if (r.method === 'HEAD') L.push('curl_setopt($ch, CURLOPT_NOBODY, true);');
  else if (r.method !== 'GET' && !(r.method === 'POST' && (r.body !== null || r.form.length))) L.push('curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ' + phpStr(r.method) + ');');
  if (hs.length) L.push('curl_setopt($ch, CURLOPT_HTTPHEADER, [\n' + hs.map((h) => '    ' + phpStr(h[0] + ': ' + h[1]) + ',').join('\n') + '\n]);');
  if (r.cookie) L.push('curl_setopt($ch, CURLOPT_COOKIE, ' + phpStr(r.cookie) + ');');
  if (r.form.length) {
    L.push('curl_setopt($ch, CURLOPT_POSTFIELDS, [\n' + r.form.map((f) =>
      '    ' + phpStr(f.name) + ' => ' + (f.file
        ? (f.asText ? 'file_get_contents(' + phpStr(f.file) + ')' : 'new CURLFile(' + phpStr(f.file) + (f.type || f.filename ? ', ' + phpStr(f.type || '') + ', ' + phpStr(f.filename || fname(f.file)) : '') + ')')
        : phpStr(f.value!)) + ',').join('\n') + '\n]);');
  } else if (r.bodyFile || r.upload) L.push('curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents(' + phpStr((r.bodyFile || r.upload)!) + '));');
  else if (r.body !== null) L.push('curl_setopt($ch, CURLOPT_POSTFIELDS, ' + phpStr(r.body) + ');');
  if (r.user) L.push('curl_setopt($ch, CURLOPT_USERPWD, ' + phpStr(r.user.user + ':' + r.user.pass) + ');');
  if (r.follow) L.push('curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);');
  if (r.compressed) L.push("curl_setopt($ch, CURLOPT_ENCODING, '');");
  if (r.insecure) L.push('curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);', 'curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);');
  if (r.timeout) L.push('curl_setopt($ch, CURLOPT_TIMEOUT, ' + r.timeout + ');');
  if (r.connectTimeout) L.push('curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, ' + r.connectTimeout + ');');
  if (r.proxy) L.push('curl_setopt($ch, CURLOPT_PROXY, ' + phpStr(r.proxy) + ');');
  L.push('', '$response = curl_exec($ch);', 'if ($response === false) {', "    echo 'Error: ' . curl_error($ch);", '}', 'curl_close($ch);', '', 'echo $response;');
  return L.join('\n');
}
export function genGo(r: Parsed) {
  const imp: Record<string, number> = { fmt: 1, io: 1, log: 1, 'net/http': 1 }, B: string[] = [], hs = headerList(r, false);
  let bodyVar = 'nil';
  if (r.form.length) {
    imp.bytes = 1; imp['mime/multipart'] = 1;
    B.push('\tvar buf bytes.Buffer', '\tw := multipart.NewWriter(&buf)');
    for (const f of r.form) {
      if (f.file) {
        imp.os = 1;
        B.push('\tf, err := os.Open(' + goStr(f.file) + ')', '\tif err != nil {', '\t\tlog.Fatal(err)', '\t}',
          '\tpart, err := w.CreateFormFile(' + goStr(f.name) + ', ' + goStr(f.filename || fname(f.file)) + ')', '\tif err != nil {', '\t\tlog.Fatal(err)', '\t}',
          '\tif _, err := io.Copy(part, f); err != nil {', '\t\tlog.Fatal(err)', '\t}', '\tf.Close()');
      } else B.push('\tw.WriteField(' + goStr(f.name) + ', ' + goStr(f.value!) + ')');
    }
    B.push('\tw.Close()', '');
    bodyVar = '&buf';
  } else if (r.bodyFile || r.upload) {
    imp.os = 1;
    B.push('\tbody, err := os.Open(' + goStr((r.bodyFile || r.upload)!) + ')', '\tif err != nil {', '\t\tlog.Fatal(err)', '\t}', '\tdefer body.Close()', '');
    bodyVar = 'body';
  } else if (r.body !== null) {
    imp.strings = 1;
    B.push('\tbody := strings.NewReader(' + goStr(r.body) + ')', '');
    bodyVar = 'body';
  }
  B.push('\treq, err := http.NewRequest(' + goStr(r.method) + ', ' + goStr(r.url) + ', ' + bodyVar + ')', '\tif err != nil {', '\t\tlog.Fatal(err)', '\t}');
  const seen: Record<string, number> = {};
  for (const h of hs) { const k = h[0].toLowerCase(); B.push('\treq.Header.' + (seen[k] ? 'Add' : 'Set') + '(' + goStr(h[0]) + ', ' + goStr(h[1]) + ')'); seen[k] = 1; }
  if (r.form.length) B.push('\treq.Header.Set("Content-Type", w.FormDataContentType())');
  if (r.user) B.push('\treq.SetBasicAuth(' + goStr(r.user.user) + ', ' + goStr(r.user.pass) + ')');
  const client: string[] = [];
  if (r.insecure || r.proxy) {
    const tr: string[] = [];
    if (r.insecure) { imp['crypto/tls'] = 1; tr.push('\t\t\tTLSClientConfig: &tls.Config{InsecureSkipVerify: true},'); }
    if (r.proxy) { imp['net/url'] = 1; B.push('\tproxyURL, _ := url.Parse(' + goStr(/:\/\//.test(r.proxy) ? r.proxy : 'http' + '://' + r.proxy) + ')'); tr.push('\t\t\tProxy: http.ProxyURL(proxyURL),'); }
    client.push('\t\tTransport: &http.Transport{\n' + tr.join('\n') + '\n\t\t},');
  }
  if (r.timeout) { imp.time = 1; client.push('\t\tTimeout: ' + (r.timeout === Math.round(r.timeout) ? r.timeout + ' * time.Second' : Math.round(r.timeout * 1000) + ' * time.Millisecond') + ','); }
  if (!r.follow) client.push("\t\t// curl doesn't follow redirects without -L; Go does by default.");
  B.push('', '\tclient := &http.Client{' + (client.length ? '\n' + client.join('\n') + '\n\t' : '') + '}',
    '\tresp, err := client.Do(req)', '\tif err != nil {', '\t\tlog.Fatal(err)', '\t}', '\tdefer resp.Body.Close()', '',
    '\tdata, err := io.ReadAll(resp.Body)', '\tif err != nil {', '\t\tlog.Fatal(err)', '\t}', '\tfmt.Println(resp.Status)', '\tfmt.Printf("%s\\n", data)');
  const imports = Object.keys(imp).sort();
  return 'package main\n\nimport (\n' + imports.map((x) => '\t"' + x + '"').join('\n') + '\n)\n\nfunc main() {\n' + B.join('\n') + '\n}';
}
export function genNode(r: Parsed) {
  if (r.form.length) {
    const F = ['import { openAsBlob } from "node:fs";', '', '// Node 18+: multipart is easiest with the built-in fetch and FormData.', 'const form = new FormData();'];
    for (const f of r.form) {
      if (f.file) F.push('form.append(' + js(f.name) + ', await openAsBlob(' + js(f.file) + ')' + (f.asText ? '' : ', ' + js(f.filename || fname(f.file))) + ');');
      else F.push('form.append(' + js(f.name) + ', ' + js(f.value) + ');');
    }
    const hs0 = headerList(r, true);
    F.push('', 'const response = await fetch(' + js(r.url) + ', {', '  method: ' + js(r.method) + ',');
    if (hs0.length) F.push('  headers: {\n' + hs0.map((h) => '    ' + js(h[0]) + ': ' + js(h[1]) + ',').join('\n') + '\n  },');
    F.push('  body: form,', '});', 'console.log(response.status, await response.text());');
    return F.join('\n');
  }
  const mod = /^https:/i.test(r.url) ? 'https' : 'http', L = ['const ' + mod + ' = require("node:' + mod + '");', ''], hs = headerList(r, true), o: string[] = [];
  const hasBody = r.body !== null || r.bodyFile || r.upload;
  if (r.bodyFile || r.upload) { L.splice(1, 0, 'const fs = require("node:fs");'); L.push('const body = fs.readFileSync(' + js(r.bodyFile || r.upload) + ');'); }
  else if (r.jsonBody !== undefined) L.push('const body = JSON.stringify(' + JSON.stringify(r.jsonBody, null, 2) + ');');
  else if (r.body !== null) L.push('const body = ' + js(r.body) + ';');
  if (hasBody) L.push('');
  o.push('  method: ' + js(r.method) + ',');
  const hl = hs.map((h) => '    ' + js(h[0]) + ': ' + js(h[1]) + ',');
  if (hasBody) hl.push('    "Content-Length": Buffer.byteLength(body),');
  if (hl.length) o.push('  headers: {\n' + hl.join('\n') + '\n  },');
  if (r.insecure) o.push('  rejectUnauthorized: false,');
  if (r.timeout) o.push('  timeout: ' + Math.round(r.timeout * 1000) + ',');
  L.push('const req = ' + mod + '.request(' + js(r.url) + ', {\n' + o.join('\n') + '\n}, (res) => {',
    '  let data = "";', '  res.setEncoding("utf8");', '  res.on("data", (chunk) => (data += chunk));', '  res.on("end", () => console.log(res.statusCode, data));', '});');
  if (r.timeout) L.push('req.on("timeout", () => req.destroy(new Error("timeout")));');
  L.push('req.on("error", console.error);');
  if (hasBody) L.push('req.write(body);');
  L.push('req.end();');
  if (r.follow) L.push('// curl -L follows redirects; node:' + mod + ' does not, check res.headers.location.');
  if (r.compressed) L.push('// --compressed: if the server compresses the reply, decode it with node:zlib.');
  return L.join('\n');
}
export const GEN = { fetch: genFetch, axios: genAxios, python: genPython, php: genPhp, go: genGo, node: genNode };
const FILE: Record<keyof typeof GEN, string> = { fetch: 'request.js', axios: 'request.mjs', python: 'request.py', php: 'request.php', go: 'main.go', node: 'request.js' };

const SECRET_H = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;
function mask(v: string) { const m = /^(Basic|Bearer|Token|Digest)\s+/i.exec(v); return (m ? m[0] : '') + '••••••••'; }

export default defineTool({
  name: 'curl_to_code',
  title: 'cURL to code',
  webSlug: 'curl-convert',
  description:
    'Convert a curl command (bash/zsh quoting incl. $\'…\', line continuations, "Copy as cURL" from browsers) into code for ' +
    'JavaScript fetch, axios, Python requests, PHP cURL, Go net/http or Node.js http/https: every target the website supports. ' +
    'Understands -X, -H, -d/--data-raw/--data-binary/--data-urlencode, --json, -F forms and files, -u, -b, -A, -e, -G, -I, -k, ' +
    '-L, -m, --connect-timeout, -x, -T, --compressed, --oauth2-bearer. Also returns the parsed request (secrets masked unless ' +
    `revealSecrets) and notes on what could not be converted. Only parses text; never sends the request. Web version: ${webUrl('curl-convert')}`,
  inputSchema: z.object({
    command: z.string().min(1).describe('The curl command, e.g. "curl -X POST https://api.example.com -H \'Content-Type: application/json\' -d \'{"a":1}\'".'),
    language: z.enum(['fetch', 'axios', 'python', 'php', 'go', 'node', 'all']).optional().default('fetch')
      .describe('Target: fetch (browser/Node fetch), axios, python (requests), php (cURL), go (net/http), node (http/https), or "all".'),
    revealSecrets: z.boolean().optional().default(false).describe('Show Authorization/Cookie/API-key header values and the basic-auth password in the parsed summary (the code always contains them).'),
    output: outputField().describe('Optional: write the code to this file (single language only).'),
  }),
  outputSchema: z.object({
    method: z.string(), url: z.string(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
    body: z.string().nullable(),
    basicAuth: z.object({ user: z.string(), password: z.string() }).optional(),
    warnings: z.array(z.string()),
    notConverted: z.array(z.string()).describe('curl options with no equivalent in the generated code.'),
    code: z.string().optional(),
    codes: z.record(z.string(), z.string()).optional().describe('With language "all": code per target.'),
    path: z.string().optional(), bytes: z.number().optional(),
  }),
  annotations: READ_ONLY,
  examples: [{ input: { command: "curl -u user:pass https://s3eidat.github.io", language: 'python' }, note: 'requests.get(url, auth=("user", "pass"))' }],
  async run(input, ctx) {
    const r = parseCurl(input.command);
    const summary = {
      method: r.method, url: r.url,
      headers: r.headers.map(([name, value]) => ({ name, value: SECRET_H.test(name) && !input.revealSecrets ? mask(value) : value })),
      body: r.body,
      ...(r.user ? { basicAuth: { user: r.user.user, password: input.revealSecrets ? r.user.pass : '••••••••' } } : {}),
      warnings: r.warnings,
      notConverted: r.ignored,
    };
    if (input.language === 'all') {
      const codes: Record<string, string> = {};
      for (const k of Object.keys(GEN) as (keyof typeof GEN)[]) codes[k] = GEN[k](r);
      return { ...summary, codes };
    }
    const code = GEN[input.language](r);
    if (input.output) {
      const w = await deliver(code, { output: input.output, defaultName: FILE[input.language], mimeType: 'text/plain' }, ctx);
      return { ...summary, path: w.path, bytes: w.bytes };
    }
    return { ...summary, code };
  },
});

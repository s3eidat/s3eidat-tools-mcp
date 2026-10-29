import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { HTML5_ENTITIES } from './_html-entities.js';

// Ported from https://github.com/s3eidat/text-escape (app.js): the same escape/unescape functions for 12 targets.
// The only change: the website decodes named HTML entities with the browser's DOMParser; here the same WHATWG
// table is used directly (with the browser's legacy rule for names without a semicolon).
export interface EscOpts {
  ascii?: boolean; named?: boolean; form?: boolean; wrap?: boolean; mysql?: boolean; always?: boolean; delim?: string;
  format?: 'u4' | 'ubrace' | 'u8' | 'html' | 'uplus'; all?: boolean;
}
interface Mode { id: string; name: string; esc: (s: string, o: EscOpts) => string; unesc: (s: string, o: EscOpts) => string; opts: unknown[] }

const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);

function hex(n: number, w?: number) { return n.toString(16).toUpperCase().padStart(w || 0, "0"); }
function cps(s: string) { return Array.from(s); }
function utf8(s: string) { return Array.from(new TextEncoder().encode(s)); }
function fromBytes(b: number[]) { return new TextDecoder("utf-8").decode(new Uint8Array(b)); }
function oct3(b: number) { return "\\" + b.toString(8).padStart(3, "0"); }
function nonAscii(c: string) { return c.codePointAt(0)! > 0x7e; }
function units(c: string) { var o = ""; for (var i = 0; i < c.length; i++) o += "\\u" + hex(c.charCodeAt(i), 4); return o; }

// ---------- JSON ----------
function jsonEsc(s: string, o: EscOpts) {
  var r = JSON.stringify(s).slice(1, -1).split(LS).join("\\u2028").split(PS).join("\\u2029");
  return o.ascii ? cps(r).map(function (c) { return nonAscii(c) ? units(c) : c; }).join("") : r;
}
function jsonUnesc(s: string): string {
  try { return JSON.parse('"' + s + '"'); }
  catch (e) { throw new Error("Not a valid JSON string body (raw quotes and newlines must be escaped)"); }
}

// ---------- JavaScript ----------
const JS_MAP: Record<string, string> = { "\\": "\\\\", "'": "\\'", '"': '\\"', "`": "\\`", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f", "\v": "\\v" };
function jsEsc(s: string, o: EscOpts) {
  var out = "", a = cps(s);
  a.forEach(function (c, i) {
    var n = c.codePointAt(0)!;
    if (JS_MAP[c]) out += JS_MAP[c];
    else if (c === "$" && a[i + 1] === "{") out += "\\$";
    else if (n === 0) out += /[0-9]/.test(a[i + 1] || "") ? "\\x00" : "\\0";
    else if (n < 0x20 || n === 0x7f) out += "\\x" + hex(n, 2);
    else if (c === LS || c === PS) out += "\\u" + hex(n, 4);
    else if (o.ascii && n > 0x7e) out += n > 0xffff ? "\\u{" + hex(n) + "}" : "\\u" + hex(n, 4);
    else out += c;
  });
  return out;
}
const JS_SIMPLE: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
function jsUnesc(s: string) {
  var out = "", i = 0;
  while (i < s.length) {
    var c = s[i];
    if (c !== "\\") { out += c; i++; continue; }
    var x = s[i + 1], m: RegExpExecArray | null;
    if (x === undefined) throw new Error("A lone backslash at the end");
    if (JS_SIMPLE[x]) { out += JS_SIMPLE[x]; i += 2; continue; }
    if (x === "0" && !/[0-9]/.test(s[i + 2] || "")) { out += String.fromCharCode(0); i += 2; continue; }
    if (x === "x") { m = /^[0-9a-fA-F]{2}/.exec(s.slice(i + 2)); if (!m) throw new Error("Bad \\x escape at " + i); out += String.fromCharCode(parseInt(m[0], 16)); i += 4; continue; }
    if (x === "u") {
      if (s[i + 2] === "{") { m = /^\{([0-9a-fA-F]{1,6})\}/.exec(s.slice(i + 2)); if (!m || parseInt(m[1], 16) > 0x10ffff) throw new Error("Bad \\u{…} escape at " + i); out += String.fromCodePoint(parseInt(m[1], 16)); i += 2 + m[0].length; continue; }
      m = /^[0-9a-fA-F]{4}/.exec(s.slice(i + 2)); if (!m) throw new Error("Bad \\u escape at " + i);
      out += String.fromCharCode(parseInt(m[0], 16)); i += 6; continue;
    }
    if (x === "\r" && s[i + 2] === "\n") { i += 3; continue; }
    if (x === "\n" || x === "\r" || x === LS || x === PS) { i += 2; continue; }
    out += x; i += 2;
  }
  return out;
}

// ---------- HTML ----------
const NAMED: Record<number, string> = { 160: "nbsp", 169: "copy", 174: "reg", 8482: "trade", 8230: "hellip", 8212: "mdash", 8211: "ndash", 8216: "lsquo", 8217: "rsquo",
  8220: "ldquo", 8221: "rdquo", 171: "laquo", 187: "raquo", 8364: "euro", 163: "pound", 165: "yen", 162: "cent", 167: "sect", 176: "deg",
  177: "plusmn", 215: "times", 247: "divide", 189: "frac12", 188: "frac14", 190: "frac34", 183: "middot", 8226: "bull", 182: "para",
  233: "eacute", 232: "egrave", 225: "aacute", 224: "agrave", 252: "uuml", 246: "ouml", 228: "auml", 231: "ccedil", 241: "ntilde", 223: "szlig" };
function htmlEsc(s: string, o: EscOpts) {
  return cps(s).map(function (c) {
    switch (c) { case "&": return "&amp;"; case "<": return "&lt;"; case ">": return "&gt;"; case '"': return "&quot;"; case "'": return "&#39;"; }
    var n = c.codePointAt(0)!;
    if (o.ascii && n > 0x7e) return o.named && NAMED[n] ? "&" + NAMED[n] + ";" : "&#x" + hex(n) + ";";
    return c;
  }).join("");
}
function decodeNamed(ent: string) { // ent matches &[A-Za-z][A-Za-z0-9]*;? — decoded like the HTML parser does in text
  const s = ent.slice(1);
  if (Object.hasOwn(HTML5_ENTITIES, s)) return HTML5_ENTITIES[s];
  for (let x = s.length - 1; x > 1; x--) if (Object.hasOwn(HTML5_ENTITIES, s.slice(0, x))) return HTML5_ENTITIES[s.slice(0, x)] + s.slice(x);
  return ent;
}
function numericRef(n: number) { return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? String.fromCharCode(0xfffd) : String.fromCodePoint(n); }
function htmlUnesc(s: string) {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([A-Za-z][A-Za-z0-9]*));?/g, function (m, h, d, name) {
    if (h) return numericRef(parseInt(h, 16));
    if (d) return numericRef(parseInt(d, 10));
    return decodeNamed(m);
  });
}

// ---------- XML ----------
function xmlEsc(s: string) { return s.replace(/[&<>"']/g, function (c) { return (<Record<string, string>>{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]; }); }
function xmlUnesc(s: string) {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, function (m, h, d, name) {
    if (h) return numericRef(parseInt(h, 16));
    if (d) return numericRef(parseInt(d, 10));
    return (<Record<string, string>>{ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name];
  });
}

// ---------- URL ----------
function urlEsc(s: string, o: EscOpts) {
  try { var r = encodeURIComponent(s); } catch (e) { throw new Error("The text has a broken surrogate pair, which can't be URL-encoded"); }
  return o.form ? r.replace(/%20/g, "+") : r;
}
function urlUnesc(s: string, o: EscOpts) {
  try { return decodeURIComponent(o.form ? s.replace(/\+/g, " ") : s); }
  catch (e) { throw new Error("Malformed percent-encoding (a % not followed by valid UTF-8 bytes)"); }
}

// ---------- SQL ----------
function sqlEsc(s: string, o: EscOpts) {
  var r = (o.mysql ? s.replace(/\\/g, "\\\\") : s).replace(/'/g, "''");
  return o.wrap ? "'" + r + "'" : r;
}
function sqlUnesc(s: string, o: EscOpts) {
  var r = s;
  if (o.wrap && /^'[\s\S]*'$/.test(r) && r.length >= 2) r = r.slice(1, -1);
  r = r.replace(/''/g, "'");
  if (o.mysql) r = r.replace(/\\([\s\S])/g, function (m, c) { return (<Record<string, string>>{ n: "\n", r: "\r", t: "\t", 0: String.fromCharCode(0), Z: String.fromCharCode(26) })[c] || c; });
  return r;
}

// ---------- CSV ----------
function csvEsc(s: string, o: EscOpts) {
  var d = o.delim || ",";
  var need = o.always || s.indexOf(d) >= 0 || /["\r\n]/.test(s) || /^\s|\s$/.test(s);
  return need ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvUnesc(s: string) {
  if (/^"[\s\S]*"$/.test(s) && s.length >= 2) {
    var inner = s.slice(1, -1);
    if (inner.replace(/""/g, "").indexOf('"') >= 0) throw new Error("A lone quote inside a quoted field");
    return inner.replace(/""/g, '"');
  }
  return s;
}

// ---------- regex ----------
function reEsc(s: string) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }
function reUnesc(s: string) { return s.replace(/\\([\s\S])/g, "$1"); }

// ---------- shell (POSIX single quotes) ----------
function shEsc(s: string) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function shUnesc(s: string) {
  var out = "", i = 0;
  while (i < s.length) {
    var c = s[i];
    if (c === "'") { var e = s.indexOf("'", i + 1); if (e < 0) throw new Error("Unclosed single quote"); out += s.slice(i + 1, e); i = e + 1; continue; }
    if (c === '"') {
      var j = i + 1;
      for (;;) {
        if (j >= s.length) throw new Error("Unclosed double quote");
        if (s[j] === '"') break;
        if (s[j] === "\\" && /["\\$`\n]/.test(s[j + 1] || "")) { if (s[j + 1] !== "\n") out += s[j + 1]; j += 2; continue; }
        out += s[j]; j++;
      }
      i = j + 1; continue;
    }
    if (c === "\\") { if (s[i + 1] !== "\n") out += s[i + 1] || ""; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// ---------- C / C++ ----------
const C_MAP: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r", "\b": "\\b", "\f": "\\f", "\v": "\\v" };
C_MAP[String.fromCharCode(7)] = "\\a";
function cEsc(s: string, o: EscOpts) {
  return cps(s).map(function (c) {
    var n = c.codePointAt(0)!;
    if (C_MAP[c]) return C_MAP[c];
    if (c === "?") return "?"; // trigraphs are gone in modern C/C++
    if (n < 0x20 || n === 0x7f) return oct3(n);
    if (o.ascii && n > 0x7e) return utf8(c).map(oct3).join("");
    return c;
  }).join("");
}
const C_SIMPLE: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "'": 39, '"': 34, "?": 63, e: 27 };
function cUnesc(s: string) {
  var bytes: number[] = [], i = 0, m: RegExpExecArray | null;
  function text(t: string) { utf8(t).forEach(function (b) { bytes.push(b); }); }
  while (i < s.length) {
    var c = s[i];
    if (c !== "\\") { var cp = s.codePointAt(i)!, ch = String.fromCodePoint(cp); text(ch); i += ch.length; continue; }
    var x = s[i + 1];
    if (x === undefined) throw new Error("A lone backslash at the end");
    if (C_SIMPLE[x] !== undefined) { bytes.push(C_SIMPLE[x]); i += 2; continue; }
    if ((m = /^[0-7]{1,3}/.exec(s.slice(i + 1)))) { bytes.push(parseInt(m[0], 8) & 255); i += 1 + m[0].length; continue; }
    if (x === "x" && (m = /^[0-9a-fA-F]+/.exec(s.slice(i + 2)))) { bytes.push(parseInt(m[0].slice(-2), 16)); i += 2 + m[0].length; continue; }
    if (x === "u" && (m = /^[0-9a-fA-F]{4}/.exec(s.slice(i + 2)))) { text(String.fromCodePoint(parseInt(m[0], 16))); i += 6; continue; }
    if (x === "U" && (m = /^[0-9a-fA-F]{8}/.exec(s.slice(i + 2))) && parseInt(m[0], 16) <= 0x10ffff) { text(String.fromCodePoint(parseInt(m[0], 16))); i += 10; continue; }
    if (x === "\n") { i += 2; continue; }
    throw new Error("Unknown escape \\" + x);
  }
  return fromBytes(bytes);
}

// ---------- Java / C# ----------
const J_MAP: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r", "\b": "\\b", "\f": "\\f" };
function javaEsc(s: string, o: EscOpts) {
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s[i], n = s.charCodeAt(i);
    if (J_MAP[c]) out += J_MAP[c];
    // control characters as octal: a \\u000a escape would end the string literal before Java even lexes it
    else if (n < 0x20 || n === 0x7f) out += oct3(n);
    else if ((o.ascii && n > 0x7e) || n === 0x2028 || n === 0x2029) out += "\\u" + hex(n, 4);
    else out += c;
  }
  return out;
}
function javaUnesc(s: string) {
  var out = "", i = 0, m: RegExpExecArray | null;
  var simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", s: " ", '"': '"', "'": "'", "\\": "\\" };
  while (i < s.length) {
    var c = s[i];
    if (c !== "\\") { out += c; i++; continue; }
    var x = s[i + 1];
    if (x === undefined) throw new Error("A lone backslash at the end");
    if (simple[x] !== undefined) { out += simple[x]; i += 2; continue; }
    if ((m = /^u+([0-9a-fA-F]{4})/.exec(s.slice(i + 1)))) { out += String.fromCharCode(parseInt(m[1], 16)); i += 1 + m[0].length; continue; }
    if ((m = /^([0-3][0-7]{0,2}|[4-7][0-7]?)/.exec(s.slice(i + 1)))) { out += String.fromCharCode(parseInt(m[0], 8)); i += 1 + m[0].length; continue; }
    if (x === "\n") { i += 2; continue; }
    throw new Error("Unknown escape \\" + x);
  }
  return out;
}

// ---------- Unicode escapes ----------
function uniEsc(s: string, o: EscOpts) {
  var f = o.format || "u4", all = o.all || f === "uplus";
  var parts = cps(s).map(function (c) {
    var n = c.codePointAt(0)!;
    if (!all && n >= 0x20 && n <= 0x7e && c !== "\\" && c !== "&") return c;
    switch (f) {
      case "u4": return units(c);
      case "ubrace": return "\\u{" + hex(n) + "}";
      case "u8": return "\\U" + hex(n, 8);
      case "html": return "&#x" + hex(n) + ";";
      case "uplus": return "U+" + hex(n, 4);
    }
  });
  return f === "uplus" ? parts.join(" ") : parts.join("");
}
function uniUnesc(s: string, o: EscOpts) {
  if ((o.format || "u4") === "uplus") {
    return s.trim() ? s.trim().split(/[\s,]+/).map(function (t) {
      var m = /^(?:U\+|u\+|0x)?([0-9a-fA-F]{1,6})$/.exec(t);
      if (!m || parseInt(m[1], 16) > 0x10ffff) throw new Error("Not a code point: " + t);
      return String.fromCodePoint(parseInt(m[1], 16));
    }).join("") : "";
  }
  return s.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|&#[xX]([0-9a-fA-F]+);|&#(\d+);/g, function (m, a, b, c, d, e) {
    var n = parseInt(a || b || c || d || e, a || b || c || d ? 16 : 10);
    if (n > 0x10ffff) throw new Error("Code point out of range: " + m);
    return b ? String.fromCharCode(n) : String.fromCodePoint(n);
  });
}

// In "non-ASCII only" mode a literal backslash or ampersand is escaped too, so unescaping is unambiguous.

export const MODES: Mode[] = [
  { id: "json", name: "JSON", esc: jsonEsc, unesc: jsonUnesc, opts: [["ascii", "Escape non-ASCII as \\uXXXX"]] },
  { id: "js", name: "JavaScript", esc: jsEsc, unesc: jsUnesc, opts: [["ascii", "Escape non-ASCII"]] },
  { id: "html", name: "HTML", esc: htmlEsc, unesc: htmlUnesc, opts: [["ascii", "Encode non-ASCII"], ["named", "Prefer named entities"]] },
  { id: "xml", name: "XML", esc: xmlEsc, unesc: xmlUnesc, opts: [] },
  { id: "url", name: "URL", esc: urlEsc, unesc: urlUnesc, opts: [["form", "Form style (+ for spaces)"]] },
  { id: "sql", name: "SQL", esc: sqlEsc, unesc: sqlUnesc, opts: [["wrap", "Wrap in quotes"], ["mysql", "Backslashes too (MySQL)"]] },
  { id: "csv", name: "CSV field", esc: csvEsc, unesc: csvUnesc, opts: [["always", "Always quote"], ["delim", "Delimiter", [[",", "Comma"], [";", "Semicolon"], ["\t", "Tab"]]]] },
  { id: "regex", name: "Regex", esc: reEsc, unesc: reUnesc, opts: [] },
  { id: "shell", name: "Shell", esc: shEsc, unesc: shUnesc, opts: [] },
  { id: "c", name: "C / C++", esc: cEsc, unesc: cUnesc, opts: [["ascii", "Non-ASCII as UTF-8 octal"]] },
  { id: "java", name: "Java / C#", esc: javaEsc, unesc: javaUnesc, opts: [["ascii", "Escape non-ASCII"]] },
  { id: "unicode", name: "Unicode", esc: uniEsc, unesc: uniUnesc, opts: [["format", "Format", [["u4", "\\uXXXX (JS, JSON, Java)"], ["ubrace", "\\u{X} (ES6, Rust, Swift)"], ["u8", "\\UXXXXXXXX (Python, C)"], ["html", "&#xX; (HTML)"], ["uplus", "U+XXXX (code points)"]]], ["all", "Every character"]] }
];
const BY: Record<string, Mode> = {}; MODES.forEach(function (m) { BY[m.id] = m; });
export const NOTES: Record<string, string> = {
  regex: "Escapes the characters that are special in JavaScript, PCRE and Python regexes, including / for literals.",
  shell: "POSIX single quotes: safe for sh, bash and zsh.",
  sql: "Standard SQL doubles single quotes. Prefer parameterised queries over escaping.",
  csv: "Quotes the field only when needed (RFC 4180).",
  url: "encodeURIComponent: for one query value or path segment."
};
export function run(id: string, dir: 'esc' | 'unesc', text: string, o?: EscOpts): string { var m = BY[id]; return dir === "esc" ? m.esc(text, o || {}) : m.unesc(text, o || {}); }

export { jsonEsc, jsUnesc, jsEsc, htmlEsc, htmlUnesc, xmlEsc, urlEsc, urlUnesc, sqlEsc, csvEsc, reEsc, shEsc, shUnesc, cEsc, cUnesc, javaEsc, javaUnesc, uniEsc };

const TARGETS = MODES.map((m) => m.id) as [string, ...string[]];
const MAX_CHARS = 2_000_000;

export default defineTool({
  name: 'text_escape',
  title: 'Escape / unescape text',
  webSlug: 'text-escape',
  description:
    'Escape or unescape a string for a target: JSON (string body), JavaScript (incl. template literals), HTML, XML, URL ' +
    '(encodeURIComponent, optional form +), SQL (doubled quotes, optional MySQL backslashes and wrapping quotes), CSV field ' +
    '(RFC 4180; comma, semicolon or tab), regex, POSIX shell single quotes, C/C++, Java/C#, and Unicode escapes ' +
    '(\\uXXXX, \\u{X}, \\UXXXXXXXX, &#xX;, U+XXXX). Options per target as on the website. Set "allTargets" to get the ' +
    `escaped form for every target at once. Web version: ${webUrl('text-escape')}`,
  inputSchema: z.object({
    text: z.string().max(MAX_CHARS).describe('The text to escape, or the escaped text to unescape.'),
    target: z.enum(TARGETS).describe('Format: json, js, html, xml, url, sql, csv, regex, shell, c, java, unicode.'),
    direction: z.enum(['escape', 'unescape']).optional().default('escape').describe('escape (default) or unescape.'),
    ascii: z.boolean().optional().default(false).describe('json/js/html/c/java: also escape non-ASCII characters (c: as UTF-8 octal).'),
    named: z.boolean().optional().default(false).describe('html (with ascii): prefer named entities such as &copy;.'),
    form: z.boolean().optional().default(false).describe('url: form style, + for spaces.'),
    wrap: z.boolean().optional().default(false).describe('sql: wrap in single quotes (unescape: strip them).'),
    mysql: z.boolean().optional().default(false).describe('sql: escape backslashes too (MySQL).'),
    alwaysQuote: z.boolean().optional().default(false).describe('csv: always quote the field.'),
    delimiter: z.enum([',', ';', '\t']).optional().default(',').describe('csv: field delimiter (comma, semicolon or tab).'),
    unicodeFormat: z.enum(['u4', 'ubrace', 'u8', 'html', 'uplus']).optional().default('u4')
      .describe('unicode: u4 = \\uXXXX (JS, JSON, Java), ubrace = \\u{X} (ES6, Rust, Swift), u8 = \\UXXXXXXXX (Python, C), html = &#xX;, uplus = U+XXXX.'),
    every: z.boolean().optional().default(false).describe('unicode: escape every character, not only non-ASCII.'),
    allTargets: z.boolean().optional().default(false).describe('escape only: also return the text escaped for every target.'),
  }),
  outputSchema: z.object({
    result: z.string(),
    note: z.string().optional().describe('A short hint about the target.'),
    inputCharacters: z.number(), outputCharacters: z.number(),
    allTargets: z.array(z.object({ target: z.string(), name: z.string(), result: z.string() })).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: "O'Brien", target: 'sql', wrap: true }, output: { result: "'O''Brien'", note: NOTES.sql, inputCharacters: 7, outputCharacters: 10 } },
    { input: { text: 'a%20b%26c', target: 'url', direction: 'unescape' }, output: { result: 'a b&c', note: NOTES.url, inputCharacters: 9, outputCharacters: 5 } },
  ],
  run(input) {
    const o: EscOpts = {
      ascii: input.ascii, named: input.named, form: input.form, wrap: input.wrap, mysql: input.mysql, always: input.alwaysQuote,
      delim: input.delimiter, format: input.unicodeFormat, all: input.every,
    };
    const dir = input.direction === 'escape' ? 'esc' : 'unesc';
    let result: string;
    try {
      result = run(input.target, dir, input.text, o);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    return {
      result,
      ...(NOTES[input.target] ? { note: NOTES[input.target] } : {}),
      inputCharacters: cps(input.text).length, outputCharacters: cps(result).length,
      ...(input.allTargets && dir === 'esc' ? {
        allTargets: MODES.map((m) => {
          let v: string;
          try { v = m.esc(input.text, m.id === input.target ? o : { delim: ',', format: 'u4' }); } catch (e) { v = '(' + (e as Error).message + ')'; }
          return { target: m.id, name: m.name, result: v };
        }),
      } : {}),
    };
  },
});

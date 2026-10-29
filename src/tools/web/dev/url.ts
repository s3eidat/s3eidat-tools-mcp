import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/url-toolkit (app.js): WHATWG URL parser plus encodeURIComponent/encodeURI,
// the same query parser (keeps order, duplicates and bare flags) and the same tracking-parameter list.
export const TRACKING =
  /^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|igsh|yclid|twclid|ttclid|li_fat_id|_ga|_gl|_hsenc|_hsmi|__hstc|__hssc|__hsfp|hsctatracking|mkt_tok|oly_anon_id|oly_enc_id|vero_id|rb_clickid|s_cid|ef_id|srsltid)$/i;

type Param = [string, string | null];

function dec(s: string, plus: boolean) {
  if (plus) s = s.replace(/\+/g, ' ');
  return decodeURIComponent(s);
}
function safeDec(s: string) {
  try {
    return dec(s, true);
  } catch {
    return s;
  }
}
/** Query string → [[key, value|null]], keeping order, duplicates and bare flags. */
export function parseQuery(q: string): Param[] {
  q = q.replace(/^\?/, '');
  if (!q) return [];
  return q
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [safeDec(p), null] : [safeDec(p.slice(0, i)), safeDec(p.slice(i + 1))];
    });
}
export function buildQuery(params: Param[]) {
  return params
    .filter((p) => p[0] !== '' || p[1])
    .map((p) => encodeURIComponent(p[0]) + (p[1] == null ? '' : '=' + encodeURIComponent(p[1])))
    .join('&');
}
export function toURL(text: string): URL | null {
  const s = String(text).trim();
  if (!s) return null;
  let u: URL | null = null;
  try {
    u = new URL(s);
  } catch {
    /* maybe no scheme */
  }
  if (!u && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    try {
      u = new URL('https://' + s);
    } catch {
      /* invalid */
    }
  }
  return u && !/[%\s]/.test(u.hostname) ? u : null;
}
function withQuery(u: URL, params: Param[]) {
  const c = new URL(u.href), q = buildQuery(params);
  c.search = q ? '?' + q : '';
  return c.href;
}
export function stripTracking(href: string) {
  const u = toURL(href);
  if (!u) return null;
  const params = parseQuery(u.search), kept = params.filter((p) => !TRACKING.test(p[0]));
  // Leave untouched query strings byte-for-byte when nothing is removed.
  return { href: kept.length === params.length ? u.href : withQuery(u, kept), removed: params.length - kept.length };
}

export type Mode = 'component' | 'full';
export function encode(s: string, m: Mode) {
  return m === 'full' ? encodeURI(s) : encodeURIComponent(s);
}
export function decode(s: string, m: Mode, plus = false) {
  if (plus) s = s.replace(/\+/g, ' ');
  return m === 'full' ? decodeURI(s) : decodeURIComponent(s);
}

const DEF_PORT: Record<string, string> = { 'http:': '80', 'https:': '443', 'ftp:': '21', 'ws:': '80', 'wss:': '443' };

export function parts(u: URL) {
  const path = u.pathname, dpath = safeDec(path.replace(/\+/g, '%2B'));
  const frag = u.hash.replace(/^#/, '');
  return {
    href: u.href,
    protocol: u.protocol.replace(/:$/, ''),
    username: u.username ? safeDec(u.username) : '',
    hasPassword: !!u.password,
    host: u.hostname,
    port: u.port,
    defaultPort: !u.port && DEF_PORT[u.protocol] ? DEF_PORT[u.protocol] : undefined,
    path,
    pathDecoded: dpath !== path ? dpath : undefined,
    query: u.search.replace(/^\?/, ''),
    fragment: frag,
    fragmentDecoded: frag && safeDec(frag) !== frag ? safeDec(frag) : undefined,
    origin: u.origin === 'null' ? '' : u.origin,
  };
}

const modeSchema = z
  .enum(['component', 'full'])
  .optional()
  .default('component')
  .describe('"component" = encodeURIComponent (for one query value or path segment; escapes / ? & = #). "full" = encodeURI (a whole URL; keeps those).');
const annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const urlEncode = defineTool({
  name: 'url_encode',
  title: 'URL encode',
  webSlug: 'url-toolkit',
  description:
    'Percent-encode text for URLs, exactly like JavaScript encodeURIComponent ("component", default) or encodeURI ("full"). ' +
    `UTF-8 based. Web version: ${webUrl('url-toolkit')}`,
  inputSchema: z.object({ text: z.string().describe('Text to encode.'), mode: modeSchema }),
  outputSchema: z.object({ result: z.string() }),
  annotations,
  examples: [{ input: { text: 'a b&c/d?é' }, output: { result: 'a%20b%26c%2Fd%3F%C3%A9' } }],
  run(input) {
    try {
      return { result: encode(input.text, input.mode) };
    } catch {
      throw new ToolError("Can't encode: the text has a broken surrogate pair");
    }
  },
});

const urlDecode = defineTool({
  name: 'url_decode',
  title: 'URL decode',
  webSlug: 'url-toolkit',
  description:
    'Decode percent-encoded text (decodeURIComponent, or decodeURI with mode "full"). Optionally turn "+" into spaces ' +
    `(form encoding). Errors on malformed %-sequences. Web version: ${webUrl('url-toolkit')}`,
  inputSchema: z.object({
    text: z.string().describe('Percent-encoded text.'),
    mode: modeSchema,
    plusAsSpace: z.boolean().optional().default(false).describe('Treat "+" as a space (application/x-www-form-urlencoded).'),
  }),
  outputSchema: z.object({ result: z.string() }),
  annotations,
  examples: [{ input: { text: 'x+y%20%E2%9C%93', plusAsSpace: true }, output: { result: 'x y ✓' } }],
  run(input) {
    try {
      return { result: decode(input.text, input.mode, input.plusAsSpace) };
    } catch {
      throw new ToolError('Malformed %-sequence — check for a lone % or a cut-off code');
    }
  },
});

const urlParse = defineTool({
  name: 'url_parse',
  title: 'URL parse',
  webSlug: 'url-toolkit',
  description:
    'Split a URL into protocol, user, host, port, path, query, fragment and origin (with decoded forms), list its query ' +
    'parameters in order (duplicates and bare flags kept, + as space) and flag tracking parameters (utm_*, fbclid, gclid, ' +
    'msclkid, mc_cid, _ga, _hsenc…). Optionally returns the URL with tracking removed. A missing scheme means https://. ' +
    `Passwords are never echoed. Web version: ${webUrl('url-toolkit')}`,
  inputSchema: z.object({
    url: z.string().describe('The URL to parse.'),
    stripTracking: z.boolean().optional().default(false).describe('Also return "cleanUrl" with tracking parameters removed.'),
  }),
  outputSchema: z.object({
    parts: z.record(z.string(), z.unknown()),
    params: z.array(z.object({ key: z.string(), value: z.string().nullable(), tracking: z.boolean() })),
    trackingCount: z.number(),
    cleanUrl: z.string().optional(),
    removed: z.number().optional(),
  }),
  annotations,
  examples: [
    {
      input: { url: 'https://example.com/shop/item?id=42&utm_source=newsletter&fbclid=IwAR0xYz#reviews', stripTracking: true },
      note: 'cleanUrl = https://example.com/shop/item?id=42#reviews, removed = 2',
    },
  ],
  run(input) {
    const u = toURL(input.url);
    if (!u) throw new ToolError('Not a valid URL');
    const params = parseQuery(u.search).map(([key, value]) => ({ key, value, tracking: TRACKING.test(key) }));
    const out: Record<string, unknown> = {
      parts: JSON.parse(JSON.stringify(parts(u))),
      params,
      trackingCount: params.filter((p) => p.tracking).length,
    };
    if (input.stripTracking) {
      const r = stripTracking(u.href)!;
      out.cleanUrl = r.href;
      out.removed = r.removed;
    }
    return out;
  },
});

export default [urlEncode, urlDecode, urlParse];

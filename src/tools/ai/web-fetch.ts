import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { ToolError } from '../../util/errors.js';
import { emitMarkdown, htmlToMarkdown, maxCharsInput, mdOutputInput, mdOutputShape, tidyMd } from './_md.js';

export const USER_AGENT = 's3eidat-tools-mcp (+https://github.com/s3eidat/s3eidat-tools-mcp)';
const UA_TOKEN = 's3eidat-tools-mcp';
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// ---------- private address check ----------

function v4Private(ip: string) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && ip.split('.')[2] === '0') || (a === 198 && (b === 18 || b === 19));
}

/** Loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip);
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4Private(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return v4Private([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  if (s === '::' || s === '::1') return true;
  return /^(f[cd]|fe[89ab]|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8:');
}

async function checkHost(url: URL, allowPrivate: boolean) {
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new ToolError(`Refusing to fetch a local address (${host}). Set allowPrivate: true to allow it.`);
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new ToolError(`Could not resolve host "${host}".`);
    }
  }
  if (addrs.some(isPrivateIp)) throw new ToolError(`Refusing to fetch ${host}: it points to a private or local address. Set allowPrivate: true to allow it.`);
}

// ---------- robots.txt ----------

async function robotsAllows(url: URL, signal: AbortSignal, cache: Map<string, (u: string) => boolean>, allowPrivate: boolean) {
  let check = cache.get(url.origin);
  if (!check) {
    const robotsUrl = url.origin + '/robots.txt';
    let text = '';
    try {
      // Follow a few redirects by hand (e.g. http -> https) so each hop passes the same host check.
      let at = new URL(robotsUrl);
      for (let hop = 0; hop < 4; hop++) {
        const res = await fetch(at, { headers: { 'user-agent': USER_AGENT, accept: 'text/plain' }, redirect: 'manual', signal });
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.body?.cancel();
          at = new URL(loc, at);
          if (at.protocol !== 'http:' && at.protocol !== 'https:') break;
          await checkHost(at, allowPrivate);
          continue;
        }
        // No robots.txt (4xx) means everything is allowed; so does a server error we can't read.
        if (res.ok) text = (await readCapped(res, 512 * 1024)).text;
        else await res.body?.cancel();
        break;
      }
    } catch (e) {
      if (signal.aborted) throw e;
    }
    // CommonJS module whose typings declare an ES default export: take whichever shape loads.
    type Parse = (url: string, txt: string) => { isAllowed(url: string, ua?: string): boolean | undefined };
    const mod = (await import('robots-parser')) as unknown as { default: Parse | { default: Parse } };
    const robotsParser = typeof mod.default === 'function' ? mod.default : mod.default.default;
    const robots = robotsParser(robotsUrl, text);
    check = (u: string) => robots.isAllowed(u, UA_TOKEN) !== false;
    cache.set(url.origin, check);
  }
  return check(url.href);
}

// ---------- body ----------

async function readCapped(res: Response, cap: number) {
  const chunks: Uint8Array[] = [];
  let size = 0, cut = false;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > cap) {
        chunks.push(value.subarray(0, cap - size));
        size = cap;
        cut = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  }
  const bytes = Buffer.concat(chunks, size);
  return { bytes, cut, text: bytes.toString('utf8') };
}

function decode(bytes: Buffer, contentType: string) {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = bytes.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)$/i;
const TEXT_TYPE = /^(text\/[\w.+-]+|application\/(json|xml|[\w.+-]+\+(json|xml)))$/i;

export default defineTool({
  name: 'ai_web_fetch',
  title: 'Fetch a web page as Markdown',
  description:
    'Fetch a web page (http/https) and return its readable content as clean Markdown, with title, byline, final URL ' +
    'after redirects and a word count. Uses Mozilla Readability to keep the main article (falls back to the whole page), ' +
    'or a CSS "selector" you give. Respects robots.txt (refuses pages disallowed for the s3eidat-tools-mcp user agent), ' +
    'only reads HTML and text responses, stops at 5 MB and 20 seconds, follows up to 5 redirects, and refuses private, ' +
    'local and loopback addresses unless allowPrivate is true. Does not run JavaScript, so pages that build their content ' +
    'in the browser may come back nearly empty. Inline Markdown is cut at maxChars (default 200k); "output" saves it to a file.',
  inputSchema: z.object({
    url: z.string().min(1).describe('The page to fetch (http:// or https://).'),
    selector: z.string().optional().describe('CSS selector: convert only the matching elements instead of the Readability main content.'),
    readable: z.boolean().optional().default(true).describe('Keep only the main content (default true). False converts the whole page body.'),
    includeLinks: z.boolean().optional().default(true).describe('Keep links (made absolute) and images. False turns links into plain text and drops images.'),
    allowPrivate: z.boolean().optional().default(false).describe('Allow private, local and loopback hosts (e.g. a dev server on localhost). Default false.'),
    maxChars: maxCharsInput(),
    output: mdOutputInput(),
  }),
  outputSchema: z.object({
    url: z.string().describe('The URL asked for.'),
    finalUrl: z.string().describe('The URL after redirects.'),
    status: z.number(),
    contentType: z.string(),
    title: z.string().optional(),
    byline: z.string().optional(),
    excerpt: z.string().optional(),
    siteName: z.string().optional(),
    lang: z.string().optional(),
    publishedTime: z.string().optional(),
    source: z.enum(['selector', 'readability', 'body', 'text']).describe('What was converted.'),
    bodyTruncated: z.boolean().describe('True when the page was over 5 MB and only the first 5 MB were read.'),
    ...mdOutputShape,
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  examples: [
    { input: { url: 'https://en.wikipedia.org/wiki/Markdown' } },
    { input: { url: 'https://example.com/docs/page', selector: 'main', includeLinks: false } },
  ],
  async run(input, ctx) {
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      throw new ToolError(`Not a valid URL: "${input.url}".`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError(`Only http and https URLs can be fetched (got ${url.protocol}).`);
    if (url.username || url.password) throw new ToolError('URLs with a user name or password are not fetched.');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const robots = new Map<string, (u: string) => boolean>();
    try {
      let res: Response | undefined;
      for (let hop = 0; ; hop++) {
        await checkHost(url, input.allowPrivate);
        if (!(await robotsAllows(url, ac.signal, robots, input.allowPrivate))) {
          throw new ToolError(`robots.txt of ${url.origin} does not allow ${UA_TOKEN} to fetch ${url.pathname}.`);
        }
        res = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1', 'accept-language': 'en;q=0.9,*;q=0.5' },
          redirect: 'manual',
          signal: ac.signal,
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          await res.body?.cancel();
          if (hop >= MAX_REDIRECTS) throw new ToolError(`Too many redirects (more than ${MAX_REDIRECTS}).`);
          const next = new URL(res.headers.get('location')!, url);
          if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new ToolError(`Redirected to a non-http URL (${next.protocol}).`);
          url = next;
          continue;
        }
        break;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new ToolError(`The server answered ${res.status} ${res.statusText} for ${url.href}.`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const mime = contentType.split(';')[0].trim().toLowerCase();
      if (mime && !HTML_TYPE.test(mime) && !TEXT_TYPE.test(mime)) {
        await res.body?.cancel();
        throw new ToolError(`Not a web page: the content type is ${mime}. Only HTML and text are read.`);
      }
      const body = await readCapped(res, MAX_BYTES);
      const text = decode(body.bytes, contentType);
      const isHtml = HTML_TYPE.test(mime) || (!mime && /^\s*(<!doctype html|<html|<head|<body)/i.test(text));

      const out: Record<string, unknown> = {
        url: input.url, finalUrl: url.href, status: res.status, contentType: contentType || 'unknown', bodyTruncated: body.cut,
      };
      let md: string;
      if (isHtml) {
        const r = await htmlToMarkdown(text, { selector: input.selector, readable: input.readable, baseUrl: url.href, includeLinks: input.includeLinks });
        md = r.markdown;
        for (const k of ['title', 'byline', 'excerpt', 'siteName', 'lang', 'publishedTime'] as const) if (r[k]) out[k] = r[k];
        out.source = r.source;
      } else {
        if (input.selector) throw new ToolError(`"selector" only works on HTML pages; this is ${mime}.`);
        md = mime === 'text/markdown' || mime === 'text/plain' ? tidyMd(text) : '```\n' + text.trim() + '\n```\n';
        out.source = 'text';
      }
      const slug = (url.pathname.split('/').filter(Boolean).pop() || url.hostname).replace(/\.[a-z0-9]+$/i, '');
      Object.assign(out, await emitMarkdown(md, { output: input.output, maxChars: input.maxChars, defaultName: slug + '.md' }, ctx));
      return out;
    } catch (e) {
      if (ac.signal.aborted) throw new ToolError(`Timed out after ${TIMEOUT_MS / 1000} s fetching ${url.href}.`);
      if (e instanceof ToolError) throw e;
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new ToolError(`Could not fetch ${url.href}: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  },
});

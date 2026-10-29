import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { outputPath, writeOutput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/meta-tags (app.js): the same escaped <head> tags, length checks and preview
// truncation (Google 60/160, Facebook 88/110, X 70/125).
const LIMITS: Record<string, [number, number, number]> = { title: [30, 60, 70], description: [70, 160, 200] }; // [ok from, ok to, hard]

/** Same as the website kit's S3.esc. */
export function esc(s: unknown) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function chars(s?: string) {
  return Array.from(String(s || '')).length;
}
export function truncate(s: string, n: number) {
  const a = Array.from(String(s || '').trim());
  return a.length > n ? a.slice(0, n - 1).join('').trimEnd() + '…' : a.join('');
}
export function absUrl(s?: string) {
  s = String(s || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s;
}
function parseUrl(s?: string) {
  try {
    const u = new URL(absUrl(s));
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}
const norm = (s?: string) => {
  const u = parseUrl(s);
  return u ? u.href : absUrl(s);
};
export function domain(s?: string) {
  const u = parseUrl(s);
  return u ? u.hostname.replace(/^www\./, '') : '';
}
export function crumb(s?: string) {
  const u = parseUrl(s);
  if (!u) return '';
  const parts = u.pathname.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  return [u.hostname.replace(/^www\./, '')].concat(parts).join(' › ');
}
export function handle(s?: string) {
  s = String(s || '').trim().replace(/^(https?:\/\/)?(www\.)?(twitter|x)\.com\//i, '').replace(/^@+/, '').replace(/\/.*$/, '');
  return s ? '@' + s : '';
}

export interface MetaFields {
  title?: string;
  description?: string;
  url?: string;
  image?: string;
  imageAlt?: string;
  siteName?: string;
  twitter?: string;
  type?: string;
  card?: string;
  locale?: string;
}
export function build(d: MetaFields) {
  const url = norm(d.url), img = norm(d.image), tw = handle(d.twitter), L: string[] = [];
  const meta = (attr: string, key: string, val?: string) => {
    if (val) L.push('<meta ' + attr + '="' + key + '" content="' + esc(val) + '">');
  };
  if (d.title) L.push('<title>' + esc(d.title) + '</title>');
  meta('name', 'description', d.description);
  if (url) L.push('<link rel="canonical" href="' + esc(url) + '">');
  L.push('', '<!-- Open Graph (Facebook, LinkedIn, WhatsApp, Slack…) -->');
  meta('property', 'og:type', d.type || 'website');
  meta('property', 'og:url', url);
  meta('property', 'og:title', d.title);
  meta('property', 'og:description', d.description);
  meta('property', 'og:image', img);
  meta('property', 'og:image:alt', img && d.imageAlt);
  meta('property', 'og:site_name', d.siteName);
  meta('property', 'og:locale', d.locale);
  L.push('', '<!-- X (Twitter) -->');
  meta('name', 'twitter:card', d.card || 'summary_large_image');
  meta('name', 'twitter:site', tw);
  meta('name', 'twitter:title', d.title);
  meta('name', 'twitter:description', d.description);
  meta('name', 'twitter:image', img);
  meta('name', 'twitter:image:alt', img && d.imageAlt);
  return L.join('\n');
}

type Level = 'ok' | 'warn' | 'bad';
/** {field: [level, message]} */
export function lint(d: MetaFields): Record<string, [Level, string]> {
  const r: Record<string, [Level, string]> = {};
  (['title', 'description'] as const).forEach((k) => {
    const n = chars(d[k]), l = LIMITS[k];
    r[k] = !n ? ['bad', 'required'] : n < l[0] ? ['warn', n + ' · short'] : n <= l[1] ? ['ok', n + ' / ' + l[1]] : n <= l[2] ? ['warn', n + ' · may be cut'] : ['bad', n + ' · too long'];
  });
  r.url = !d.url ? ['warn', 'recommended'] : parseUrl(d.url) ? ['ok', 'valid'] : ['bad', 'not a web URL'];
  r.image = !d.image ? ['warn', 'no image: plain cards'] : parseUrl(d.image) ? ['ok', 'valid'] : ['bad', 'not a web URL'];
  const tw = handle(d.twitter);
  r.twitter = !tw ? ['ok', 'optional'] : /^@\w{1,15}$/.test(tw) ? ['ok', tw] : ['bad', '1–15 letters, digits, _'];
  return r;
}

export function previews(d: MetaFields) {
  const dom = domain(d.url) || 'yoursite.com', title = (d.title || '').trim() || 'Your page title', desc = (d.description || '').trim() || 'Your description shows here.';
  return {
    google: { site: (d.siteName || '').trim() || dom, breadcrumb: crumb(d.url) || dom, title: truncate(title, 60), description: truncate(desc, 160) },
    facebook: { domain: dom.toUpperCase(), title: truncate(title, 88), description: truncate(desc, 110) },
    x: { card: d.card === 'summary' ? 'summary' : 'summary_large_image', domain: dom, title: truncate(title, 70), description: truncate(desc, 125) },
  };
}

export default defineTool({
  name: 'meta_tags_generate',
  title: 'Meta tags generator',
  webSlug: 'meta-tags',
  description:
    'Generate the <head> HTML for SEO and social sharing: <title>, meta description, canonical link, Open Graph (og:type, ' +
    'url, title, description, image + alt, site_name, locale) and X/Twitter card tags. All values are HTML-escaped. Also ' +
    'checks lengths (title 30–60, description 70–160 characters), URLs and the @handle, and shows how Google, Facebook ' +
    'and X would truncate the title and description. URLs without a scheme get https://. Optionally writes the tags ' +
    `to an .html file. Web version: ${webUrl('meta-tags')}`,
  inputSchema: z.object({
    title: z.string().optional().default('').describe('Page title (aim for 30–60 characters).'),
    description: z.string().optional().default('').describe('Meta description (aim for 70–160 characters).'),
    url: z.string().optional().default('').describe('Canonical page URL.'),
    image: z.string().optional().default('').describe('Share image URL (1200×630 recommended).'),
    imageAlt: z.string().optional().default('').describe('Alt text for the share image.'),
    siteName: z.string().optional().default('').describe('Site name (og:site_name).'),
    twitter: z.string().optional().default('').describe('X/Twitter handle: "@name", "name" or a profile URL.'),
    type: z.string().optional().default('website').describe('og:type, e.g. website, article, product, profile. Default website.'),
    card: z.enum(['summary_large_image', 'summary']).optional().default('summary_large_image').describe('X card type. Default summary_large_image.'),
    locale: z.string().optional().default('').describe('og:locale, e.g. en_US or ar_AR.'),
    output: outputPath(),
  }),
  outputSchema: z.object({
    html: z.string(),
    path: z.string().optional(),
    problems: z.number().describe('How many fields have a blocking problem (level "bad").'),
    checks: z.record(z.string(), z.object({ level: z.enum(['ok', 'warn', 'bad']), message: z.string() })),
    previews: z.object({
      google: z.object({ site: z.string(), breadcrumb: z.string(), title: z.string(), description: z.string() }),
      facebook: z.object({ domain: z.string(), title: z.string(), description: z.string() }),
      x: z.object({ card: z.string(), domain: z.string(), title: z.string(), description: z.string() }),
    }),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: {
        title: 'Meta Tags: free SEO and social preview generator',
        description: 'Create meta, Open Graph and X card tags with live Google, Facebook and X previews. Free, private and it runs in your browser.',
        url: 'https://s3eidat.github.io/meta-tags/',
        image: 'https://s3eidat.github.io/meta-tags/screenshot.png',
        siteName: 'S3eidat Tools',
        twitter: '@s3eidat',
        locale: 'en_US',
      },
    },
  ],
  async run(input, ctx) {
    const d: MetaFields = input;
    const html = build(d);
    const lt = lint(d);
    const checks: Record<string, { level: Level; message: string }> = {};
    for (const [k, [level, message]] of Object.entries(lt)) checks[k] = { level, message };
    const out: Record<string, unknown> = {
      html,
      problems: Object.values(lt).filter((v) => v[0] === 'bad').length,
      checks,
      previews: previews(d),
    };
    if (input.output) out.path = (await writeOutput(html + '\n', { output: input.output, defaultName: 'meta-tags.html', mimeType: 'text/html' }, ctx)).path;
    return out;
  },
});

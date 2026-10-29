import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, readInput } from '../../../util/files.js';

// Port of https://github.com/s3eidat/qr-scanner (app.js): jsQR on the image at 1600/900/500 px with both
// normal and inverted attempts, then the same content classification (Wi-Fi, contact, link safety notes…).
// The camera part of the website can't run headless; this reads image files.

type JsQr = (data: Uint8ClampedArray, w: number, h: number, o?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }) =>
  { data: string; version: number; binaryData: number[]; location: Record<string, { x: number; y: number }> } | null;
let jsqrP: Promise<JsQr> | undefined;
function loadJsQr() {
  jsqrP ??= import('jsqr').then((m) => {
    const d = (m as unknown as { default: JsQr & { default?: JsQr } }).default;
    return (d.default ?? d) as JsQr;
  });
  return jsqrP;
}

// ---------- parsing (same as the website) ----------
function splitEsc(s: string, sep: string) {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (c === sep) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
const unesc = (s: string) => s.replace(/\\(.)/g, '$1');
function kv(body: string) {
  const o: Record<string, string[]> = {};
  splitEsc(body, ';').forEach((f) => {
    const i = f.indexOf(':');
    if (i < 1) return;
    const k = f.slice(0, i).toUpperCase();
    (o[k] = o[k] || []).push(unesc(f.slice(i + 1)));
  });
  return o;
}
function vcard(text: string) {
  const o: Record<string, string[]> = {};
  text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i < 1) return;
    const key = line.slice(0, i).split(';')[0].toUpperCase().replace(/^ITEM\d+\./, '');
    const val = line.slice(i + 1).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
    (o[key] = o[key] || []).push(val);
  });
  return o;
}

export interface UrlInfo { href: string; protocol: string; host: string; rest?: string; openable: boolean; warn: string[] }
export function analyzeUrl(raw: string): UrlInfo | null {
  let s = raw.trim(), u: URL;
  if (/^www\./i.test(s)) s = 'https://' + s;
  try { u = new URL(s); } catch { return null; }
  const web = u.protocol === 'https:' || u.protocol === 'http:', warn: string[] = [];
  if (!web) return { href: u.href, protocol: u.protocol, host: u.host, openable: false, warn: ['Uses the “' + u.protocol + "” scheme, which isn't a web page. It can't be opened from here."] };
  if (u.protocol === 'http:') warn.push('Not encrypted (http). Anyone on the network could see or change this page.');
  if (u.username || u.password) warn.push('The link hides text before an @ sign. The real site is ' + u.hostname + ', not what comes before the @.');
  if (/(^|\.)xn--/i.test(u.hostname)) warn.push('International domain shown in its real form (' + u.hostname + '). Lookalike letters are a common phishing trick.');
  if (/^\d{1,3}(\.\d{1,3}){3}$|^\[/.test(u.hostname)) warn.push('Points to a bare IP address instead of a named website.');
  if (u.port) warn.push('Uses an unusual port (' + u.port + ').');
  return { href: u.href, protocol: u.protocol, host: u.hostname, rest: (u.port ? ':' + u.port : '') + u.pathname + u.search + u.hash, openable: true, warn };
}

type Row = [string, string, boolean?];
export interface Classified { type: string; rows?: Row[]; url?: UrlInfo; vcf?: string }
export function classify(text: string): Classified {
  const t = text.trim(), up = t.toUpperCase();
  if (/^https?:\/\//i.test(t) || /^www\.[^\s]+\.[^\s]+$/i.test(t)) { const u = analyzeUrl(t); if (u) return { type: 'Link', url: u }; }
  if (up.indexOf('WIFI:') === 0) {
    const w = kv(t.slice(5));
    return { type: 'Wi-Fi', rows: [['Network', (w.S || [''])[0]], ['Password', (w.P || [''])[0], true], ['Security', (w.T || ['none'])[0] || 'none'], ['Hidden', w.H && /true/i.test(w.H[0]) ? 'Yes' : 'No']] };
  }
  if (up.indexOf('BEGIN:VCARD') === 0) {
    const v = vcard(t), rows: Row[] = [];
    const name = (v.FN || [])[0] || (v.N ? v.N[0].split(';').slice(0, 2).reverse().join(' ').trim() : '');
    if (name) rows.push(['Name', name]);
    ([['ORG', 'Company'], ['TITLE', 'Title'], ['TEL', 'Phone'], ['EMAIL', 'Email'], ['URL', 'Website'], ['ADR', 'Address'], ['NOTE', 'Note']] as const).forEach((p) => {
      (v[p[0]] || []).forEach((x) => { x = p[0] === 'ADR' || p[0] === 'ORG' ? x.split(';').filter(Boolean).join(', ') : x; if (x) rows.push([p[1], x, true]); });
    });
    return { type: 'Contact', rows, vcf: t };
  }
  if (up.indexOf('MECARD:') === 0) {
    const m = kv(t.slice(7)), mr: Row[] = [];
    if (m.N) mr.push(['Name', m.N[0].split(',').reverse().join(' ').trim()]);
    (m.TEL || []).forEach((x) => mr.push(['Phone', x, true]));
    (m.EMAIL || []).forEach((x) => mr.push(['Email', x, true]));
    (m.URL || []).forEach((x) => mr.push(['Website', x, true]));
    (m.ADR || []).forEach((x) => mr.push(['Address', x, true]));
    return { type: 'Contact', rows: mr };
  }
  if (/^mailto:/i.test(t)) {
    const q = t.slice(7).split('?'), p = new URLSearchParams(q[1] || ''), er: Row[] = [['To', safeDecode(q[0]), true]];
    if (p.get('subject')) er.push(['Subject', p.get('subject')!]);
    if (p.get('body')) er.push(['Message', p.get('body')!, true]);
    return { type: 'Email', rows: er };
  }
  if (up.indexOf('MATMSG:') === 0) {
    const mm = kv(t.slice(7));
    return { type: 'Email', rows: [['To', (mm.TO || [''])[0], true], ['Subject', (mm.SUB || [''])[0]], ['Message', (mm.BODY || [''])[0], true]] };
  }
  if (/^tel:/i.test(t)) return { type: 'Phone', rows: [['Number', t.slice(4), true]] };
  if (/^smsto:/i.test(t)) { const sp = t.slice(6), ci = sp.indexOf(':'); return { type: 'SMS', rows: [['To', ci < 0 ? sp : sp.slice(0, ci), true], ['Message', ci < 0 ? '' : sp.slice(ci + 1), true]] }; }
  if (/^sms:/i.test(t)) { const sq = t.slice(4).split('?'); return { type: 'SMS', rows: [['To', sq[0], true], ['Message', new URLSearchParams(sq[1] || '').get('body') || '', true]] }; }
  if (/^geo:/i.test(t)) {
    const g = /^geo:(-?[\d.]+),(-?[\d.]+)/i.exec(t);
    if (g) return { type: 'Location', rows: [['Latitude', g[1], true], ['Longitude', g[2], true], ['Both', g[1] + ', ' + g[2], true]] };
  }
  if (up.indexOf('BEGIN:VEVENT') === 0 || up.indexOf('BEGIN:VCALENDAR') === 0) {
    const e = vcard(t);
    return { type: 'Event', rows: ([['Title', (e.SUMMARY || [''])[0]], ['Starts', (e.DTSTART || [''])[0]], ['Ends', (e.DTEND || [''])[0]], ['Where', (e.LOCATION || [''])[0]]] as Row[]).filter((r) => r[1]) };
  }
  if (/^[a-z][a-z0-9+.-]{1,20}:\S/i.test(t) && !/\s/.test(t)) { const other = analyzeUrl(t); if (other) return { type: 'Link', url: other }; }
  return { type: 'Text' };
}
function safeDecode(s: string) { try { return decodeURIComponent(s); } catch { return s; } }

// ---------- decoding ----------
export interface Decoded { text: string; version: number; bytes: number; scale: number; location: Record<string, { x: number; y: number }> }

/** Decode the first QR code in an image buffer (any format sharp reads). Tries 1600, 900 and 500 px, normal + inverted. */
export async function decodeImage(bytes: Buffer): Promise<Decoded | null> {
  const { default: sharp } = await import('sharp');
  const jsQR = await loadJsQr();
  let meta;
  try { meta = await sharp(bytes, { limitInputPixels: 268e6 }).rotate().metadata(); } catch { throw new ToolError("Couldn't read that image."); }
  const oriented = (meta.orientation ?? 1) >= 5;
  const sw = (oriented ? meta.height : meta.width) ?? 0, sh = (oriented ? meta.width : meta.height) ?? 0;
  if (!sw || !sh) throw new ToolError("Couldn't read that image.");
  let lastW = 0;
  for (const max of [1600, 900, 500]) {
    const k = Math.min(1, max / Math.max(sw, sh)), w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    if (w === lastW) continue; // same size as the previous try
    lastW = w;
    const raw = await sharp(bytes, { limitInputPixels: 268e6 }).rotate().flatten({ background: '#ffffff' })
      .resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
    const r = jsQR(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length), w, h, { inversionAttempts: 'attemptBoth' });
    if (r) {
      const loc: Record<string, { x: number; y: number }> = {};
      for (const [key, p] of Object.entries(r.location)) if (p) loc[key] = { x: Math.round((p.x / k) * 10) / 10, y: Math.round((p.y / k) * 10) / 10 };
      return { text: r.data, version: r.version, bytes: r.binaryData.length, scale: k, location: loc };
    }
  }
  return null;
}

const point = z.object({ x: z.number(), y: z.number() });

export default defineTool({
  name: 'qr_read',
  title: 'QR code reader',
  webSlug: 'qr-scanner',
  description:
    'Read (decode) a QR code from an image file: photo, screenshot or scan (PNG, JPEG, WebP, GIF, TIFF, AVIF, SVG). Uses jsQR ' +
    'like the website, trying several sizes and inverted (light-on-dark) codes. Returns the text plus what it is (Link, Wi-Fi, ' +
    'Contact, Email, SMS, Phone, Location, Event or Text) with parsed fields, and safety notes for links (http, hidden @ ' +
    'user part, punycode lookalikes, bare IPs, odd ports). Links are never opened. Reads one code per image. ' +
    `Web version (with camera): ${webUrl('qr-scanner')}`,
  inputSchema: z.object({
    image: fileInput('image containing a QR code'),
  }),
  outputSchema: z.object({
    text: z.string().describe('The decoded content.'),
    type: z.string().describe('Link, Wi-Fi, Contact, Email, SMS, Phone, Location, Event or Text.'),
    fields: z.array(z.object({ label: z.string(), value: z.string() })).describe('Parsed fields (e.g. Network, Password).'),
    url: z.object({ href: z.string(), protocol: z.string(), host: z.string(), openable: z.boolean(), warnings: z.array(z.string()) }).optional()
      .describe('For links: the real host and safety warnings.'),
    version: z.number().describe('QR version (1-40).'),
    bytes: z.number().describe('Number of data bytes.'),
    location: z.record(z.string(), point).describe('Corner and finder positions in image pixels.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { image: '/path/to/photo-of-qr.jpg' }, note: 'e.g. { text: "WIFI:T:WPA;S:Home;P:secret;;", type: "Wi-Fi", fields: [{label:"Network",value:"Home"},…] }' }],
  async run(input, ctx) {
    const file = await readInput(input.image, ctx, 'image');
    const d = await decodeImage(file.bytes);
    if (!d) throw new ToolError('No QR code found. Try a sharper, closer or uncropped image.');
    const c = classify(d.text);
    return {
      text: d.text, type: c.type,
      fields: (c.rows ?? []).map((r) => ({ label: r[0], value: r[1] ?? '' })),
      ...(c.url ? { url: { href: c.url.href, protocol: c.url.protocol, host: c.url.host, openable: c.url.openable, warnings: c.url.warn } } : {}),
      version: d.version, bytes: d.bytes, location: d.location,
    };
  },
});

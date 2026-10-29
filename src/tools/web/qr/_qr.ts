/**
 * QR payload builders, SVG drawing and contrast checks, ported from https://github.com/s3eidat/qr-studio (app.js)
 * and wifi-card (app.js). Shared by qr_generate, qr_wifi and the business card maker.
 */
import { ToolError } from '../../../registry.js';
import { makeQR, QrOverflowError, type EccLevel, type QrMatrix, type QrMode } from './_qrcode.js';

// ---------- payloads (qr-studio) ----------
export function wifiEsc(s: string) { return String(s).replace(/([\\;,:"])/g, '\\$1'); }
export function vEsc(s: string) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
export function withScheme(u: string) {
  u = u.trim();
  return !u || /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(mailto|tel|sms|geo):/i.test(u) ? u : 'https://' + u;
}

export type PayloadType = 'url' | 'text' | 'wifi' | 'vcard' | 'email' | 'sms' | 'tel' | 'geo';
/** Field values keyed like the website's form (url, text, ssid, pass, sec, hidden, first, last, tel, …). */
export type PayloadValues = Record<string, string | boolean | undefined>;

/** The website's payload(): returns "" when required fields are empty, or {error} for invalid input. */
export function payload(type: PayloadType, v: PayloadValues): string | { error: string } {
  const t = (k: string) => String(v[k] ?? '').trim();
  const s = (k: string) => String(v[k] ?? '');
  switch (type) {
    case 'url': return withScheme(s('url'));
    case 'text': return s('text');
    case 'wifi': {
      if (!t('ssid')) return '';
      const sec = s('sec') || 'WPA';
      return 'WIFI:T:' + sec + ';S:' + wifiEsc(s('ssid')) + ';' + (sec !== 'nopass' ? 'P:' + wifiEsc(s('pass')) + ';' : '') + (v.hidden ? 'H:true;' : '') + ';';
    }
    case 'vcard': {
      if (!t('first') && !t('last') && !t('tel') && !t('email') && !t('org')) return '';
      const L = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + vEsc(t('last')) + ';' + vEsc(t('first')) + ';;;', 'FN:' + vEsc((t('first') + ' ' + t('last')).trim() || t('org'))];
      if (t('org')) L.push('ORG:' + vEsc(t('org')));
      if (t('title')) L.push('TITLE:' + vEsc(t('title')));
      if (t('tel')) L.push('TEL;TYPE=CELL:' + t('tel'));
      if (t('email')) L.push('EMAIL:' + t('email'));
      if (t('web')) L.push('URL:' + withScheme(t('web')));
      if (t('adr')) L.push('ADR:;;' + vEsc(t('adr')) + ';;;;');
      L.push('END:VCARD');
      return L.join('\r\n');
    }
    case 'email': {
      if (!t('to')) return '';
      const q: string[] = [];
      if (t('subject')) q.push('subject=' + encodeURIComponent(t('subject')));
      if (v.body) q.push('body=' + encodeURIComponent(s('body')));
      return 'mailto:' + t('to') + (q.length ? '?' + q.join('&') : '');
    }
    case 'sms': return t('num') ? 'SMSTO:' + t('num').replace(/[^\d+]/g, '') + ':' + s('msg') : '';
    case 'tel': return t('num') ? 'tel:' + t('num').replace(/[^\d+*#]/g, '') : '';
    case 'geo': {
      const la = parseFloat(s('lat')), lo = parseFloat(s('lng'));
      if (!isFinite(la) || !isFinite(lo)) return '';
      if (Math.abs(la) > 90 || Math.abs(lo) > 180) return { error: 'Latitude must be −90…90 and longitude −180…180' };
      return 'geo:' + la + ',' + lo + (t('q') ? '?q=' + encodeURIComponent(t('q')) : '');
    }
  }
  return '';
}

/** Wi-Fi payload exactly as wifi-card builds it. */
export function wifiPayload(ssid: string, pass: string, sec: string, hidden: boolean) {
  if (!ssid) return '';
  return 'WIFI:T:' + sec + ';S:' + wifiEsc(ssid) + ';' + (sec !== 'nopass' ? 'P:' + wifiEsc(pass) + ';' : '') + (hidden ? 'H:true;' : '') + ';';
}

/** makeQR with a friendly ToolError when the data doesn't fit. */
export function qrOrThrow(text: string, ecc: EccLevel, opts: { mode?: QrMode; version?: number; mask?: number } = {}): QrMatrix {
  try {
    return makeQR(text, ecc, opts);
  } catch (e) {
    if (e instanceof QrOverflowError) {
      throw new ToolError(opts.version
        ? `Too much data for a version ${opts.version} QR code at level ${ecc}. Use a higher version, version 0 (auto), or a lower error correction level.`
        : 'Too much data for one QR code. Shorten the text or lower the error correction level.');
    }
    throw new ToolError(e instanceof Error ? e.message : String(e));
  }
}

// ---------- contrast (WCAG relative luminance) ----------
export function lum(hex: string) {
  const v = [1, 3, 5].map((i) => {
    const x = parseInt(hex.substr(i, 2), 16) / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
export function contrast(a: string, b: string) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** The website's warnings under the preview. */
export function styleWarnings(fg: string, bg: string, margin: number) {
  const cr = contrast(fg, bg), w: string[] = [];
  if (cr < 3) w.push('Contrast is ' + cr.toFixed(1) + ":1. Many phones can't scan below about 3:1, so make the dots darker or the background lighter.");
  else if (cr < 4.5) w.push('Contrast ' + cr.toFixed(1) + ':1 is borderline. Test it with a phone before printing.');
  if (lum(fg) > lum(bg)) w.push("Light dots on a dark background: some older scanners can't read inverted codes.");
  if (margin < 2) w.push('A margin under 2 modules can stop scanners finding the code. Leave space around it when you print.');
  return { contrast: Math.round(cr * 100) / 100, warnings: w };
}

// ---------- drawing (qr-studio's svg()) ----------
export type Shape = 'square' | 'rounded' | 'dots';
function isFinder(r: number, c: number, n: number) { return (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7); }
export function logoBox(n: number) { let s = Math.round(n * 0.22); if ((n - s) % 2) s++; return { a: (n - s) / 2, b: (n + s) / 2 }; }
function covered(r: number, c: number, box: { a: number; b: number } | null) {
  return !!box && r >= box.a - 0.5 && r < box.b + 0.5 && c >= box.a - 0.5 && c < box.b + 0.5;
}
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface SvgOpts { fg: string; bg: string; shape: Shape; margin: number; logoUrl?: string }

export function qrSvg(qr: QrMatrix, px: number, o: SvgOpts) {
  const n = qr.moduleCount, N = n + 2 * o.margin, off = o.margin, box = o.logoUrl ? logoBox(n) : null;
  const round = o.shape !== 'square';
  let d = '', dots = '';
  const rr = (x: number, y: number, w: number, r: number) =>
    'M' + (x + r) + ' ' + y + 'h' + (w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + 'v' + (w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + -r + ' ' + r +
    'h' + (2 * r - w) + 'a' + r + ' ' + r + ' 0 0 1 ' + -r + ' ' + -r + 'v' + (2 * r - w) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + -r + 'z';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c) || covered(r, c, box) || (round && isFinder(r, c, n))) continue;
    if (o.shape === 'square') d += 'M' + (c + off) + ' ' + (r + off) + 'h1v1h-1z';
    else if (o.shape === 'dots') dots += '<circle cx="' + (c + off + 0.5) + '" cy="' + (r + off + 0.5) + '" r="0.5"/>';
    else d += rr(c + off, r + off, 1, 0.3);
  }
  let finders = '';
  if (round) for (const p of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    const x = p[1] + off, y = p[0] + off;
    finders += '<path fill-rule="evenodd" d="' + rr(x, y, 7, 2.2) + rr(x + 1, y + 1, 5, 1.5) + '"/><path d="' + rr(x + 2, y + 2, 3, 1) + '"/>';
  }
  let logo = '';
  if (box && o.logoUrl) {
    const bs = box.b - box.a, pad = 0.4;
    logo = '<rect x="' + (box.a + off - pad) + '" y="' + (box.a + off - pad) + '" width="' + (bs + 2 * pad) + '" height="' + (bs + 2 * pad) + '" rx="1" fill="' + o.bg + '"/>' +
      '<image x="' + (box.a + off) + '" y="' + (box.a + off) + '" width="' + bs + '" height="' + bs + '" preserveAspectRatio="xMidYMid meet" href="' + esc(o.logoUrl) + '"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + N + ' ' + N + '"' + (o.shape === 'square' ? ' shape-rendering="crispEdges"' : '') + '>' +
    '<rect width="' + N + '" height="' + N + '" fill="' + o.bg + '"/><g fill="' + o.fg + '">' + (d ? '<path d="' + d + '"/>' : '') + dots + finders + '</g>' + logo + '</svg>';
}

/** Rasterise an SVG string to PNG with sharp. */
export async function svgToPng(svg: string) {
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(svg), { density: 72, limitInputPixels: false }).png({ compressionLevel: 9 }).toBuffer();
}

/** SVG path data ("M x y h1v1h-1z…") of the dark modules, `m` modules of quiet zone offset. For PDF drawing. */
export function modulesPath(qr: QrMatrix, m = 0) {
  let d = '';
  const n = qr.moduleCount;
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) { c++; continue; }
      let e = c;
      while (e < n && qr.isDark(r, e)) e++;
      d += 'M' + (c + m) + ' ' + (r + m) + 'h' + (e - c) + 'v1h' + (c - e) + 'z';
      c = e;
    }
  }
  return d;
}

export function normHex(v: string) {
  let x = v.trim();
  if (x[0] !== '#') x = '#' + x;
  if (!/^#[0-9a-f]{6}$/i.test(x)) throw new ToolError(`"${v}" is not a hex colour like #0d0f12.`);
  return x.toLowerCase();
}

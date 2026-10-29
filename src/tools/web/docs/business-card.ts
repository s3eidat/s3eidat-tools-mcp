import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, returnBase64 } from '../../../util/files.js';
import { makeQR, type QrMatrix } from '../qr/_qrcode.js';
import { modulesPath } from '../qr/_qr.js';
import { Draw, MM, embedImage, imageInput, luminance, mixHex, newDoc, pdfOutputShape, savePdf, userText, type Fonts } from './_pdf.js';
import type { PDFImage } from 'pdf-lib';

// Port of https://github.com/s3eidat/business-card (app.js): the four card templates and three backs, drawn in mm
// exactly as the site's canvas does, the vCard for the QR, and the print sheet (cards centred, 8 mm margin, crop marks,
// backs mirrored for long-edge duplex). The site's Arabic back side needs an Arabic font, so it isn't offered here yet.
const SIZES = { eu: { w: 85, h: 55, label: '85 × 55 mm' }, us: { w: 88.9, h: 50.8, label: '3.5 × 2 in' } };
const SHEETS: Record<string, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4] };
export const THEMES = {
  teal: { accent: '#0e9f9a', paper: '#ffffff', ink: '#16191e' },
  navy: { accent: '#c9a227', paper: '#14213d', ink: '#f4f1e8' },
  charcoal: { accent: '#e2604a', paper: '#ffffff', ink: '#1f2329' },
  forest: { accent: '#2f7d4f', paper: '#f6f3ea', ink: '#1d2a22' },
  violet: { accent: '#6650c8', paper: '#ffffff', ink: '#1b1830' },
  mono: { accent: '#111111', paper: '#ffffff', ink: '#111111' },
};

export function px(mm: number) { return Math.round((mm / 25.4) * 300); }
export function vesc(s: unknown) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
export interface CardFields { name?: string; title?: string; company?: string; phone?: string; email?: string; website?: string; address?: string; tagline?: string }
export function vcard(d: CardFields) {
  const fn = (d.name || '').trim();
  const parts = fn.split(/\s+/).filter(Boolean), family = parts.length > 1 ? parts.pop()! : '', given = parts.join(' ');
  const L = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + vesc(family) + ';' + vesc(given) + ';;;', 'FN:' + vesc(fn)];
  if (d.company) L.push('ORG:' + vesc(d.company));
  if (d.title) L.push('TITLE:' + vesc(d.title));
  if (d.phone) L.push('TEL;TYPE=CELL:' + vesc(d.phone));
  if (d.email) L.push('EMAIL;TYPE=INTERNET:' + vesc(d.email));
  if (d.website) L.push('URL:' + String(d.website).replace(/\s+/g, ''));
  if (d.address) L.push('ADR;TYPE=WORK:;;' + vesc(d.address) + ';;;;');
  L.push('END:VCARD');
  return L.join('\r\n');
}

/** Cards per sheet, centred, with an 8 mm minimum margin left for crop marks. */
export function sheetLayout(paper: string, size: keyof typeof SIZES, gap: number) {
  const P = SHEETS[paper] || SHEETS.A4, S = SIZES[size] || SIZES.eu, W = P[0], H = P[1], m = 8;
  const cols = Math.max(1, Math.floor((W - 2 * m + gap) / (S.w + gap))), rows = Math.max(1, Math.floor((H - 2 * m + gap) / (S.h + gap)));
  const gw = cols * S.w + (cols - 1) * gap, gh = rows * S.h + (rows - 1) * gap;
  const x0 = (W - gw) / 2, y0 = (H - gh) / 2, pos: { x: number; y: number }[] = [], xs: number[] = [], ys: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pos.push({ x: x0 + c * (S.w + gap), y: y0 + r * (S.h + gap) });
  for (let c = 0; c < cols; c++) { xs.push(x0 + c * (S.w + gap)); xs.push(x0 + c * (S.w + gap) + S.w); }
  for (let r = 0; r < rows; r++) { ys.push(y0 + r * (S.h + gap)); ys.push(y0 + r * (S.h + gap) + S.h); }
  const uniq = (a: number[]) => a.map((v) => Math.round(v * 1000) / 1000).filter((v, i, arr) => arr.indexOf(v) === i);
  return { W, H, w: S.w, h: S.h, cols, rows, n: cols * rows, x0, y0, pos, xs: uniq(xs), ys: uniq(ys) };
}

// ---------- drawing (all coordinates in mm, same numbers as the site) ----------
interface Opts { W: number; H: number; tpl: string; accent: string; paper: string; ink: string; logo?: PDFImage; qr: QrMatrix | null; back: string }
function onColor(hex: string) { return luminance(hex) > 0.45 ? '#14171b' : '#ffffff'; }

function txt(g: Draw, s: string | undefined, x: number, y: number, o: { size: number; weight?: number; color: string; align?: 'left' | 'center' | 'right'; maxW?: number }) {
  if (!s) return 0;
  return g.text(s, x, y, { size: o.size, font: (o.weight ?? 400) >= 600 ? g.fonts.bold : g.fonts.sans, color: o.color, align: o.align ?? 'left', maxW: o.maxW, minScale: 0.6 });
}
function rr(x: number, y: number, w: number, h: number, r: number) {
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - h}a${r} ${r} 0 0 1 ${r} ${-r}z`;
}
function icon(g: Draw, kind: string, cx: number, cy: number, s: number, color: string) {
  const r = s / 2, st = { stroke: color, lineWidth: s * 0.13 };
  if (kind === 'phone') { g.path(rr(cx - r * 0.55, cy - r, r * 1.1, r * 2, r * 0.25), st); g.path(`M${cx - r * 0.18} ${cy + r * 0.68}L${cx + r * 0.18} ${cy + r * 0.68}`, st); }
  else if (kind === 'mail') { g.path(`M${cx - r} ${cy - r * 0.68}h${2 * r}v${r * 1.36}h${-2 * r}z`, st); g.path(`M${cx - r} ${cy - r * 0.68}L${cx} ${cy + r * 0.1}L${cx + r} ${cy - r * 0.68}`, st); }
  else if (kind === 'web') {
    g.path(`M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`, st);
    g.path(`M${cx - r * 0.42} ${cy}a${r * 0.42} ${r} 0 1 0 ${r * 0.84} 0a${r * 0.42} ${r} 0 1 0 ${-r * 0.84} 0z`, st);
    g.path(`M${cx - r} ${cy}L${cx + r} ${cy}`, st);
  } else {
    const R = r * 0.62, ccy = cy - r * 0.25, a1 = Math.PI * 0.85, a2 = Math.PI * 2.15;
    g.path(`M${cx + R * Math.cos(a1)} ${ccy + R * Math.sin(a1)}A${R} ${R} 0 1 1 ${cx + R * Math.cos(a2)} ${ccy + R * Math.sin(a2)}L${cx} ${cy + r}z`, st);
    const d = r * 0.2;
    g.path(`M${cx - d} ${ccy}a${d} ${d} 0 1 0 ${2 * d} 0a${d} ${d} 0 1 0 ${-2 * d} 0z`, { fill: color });
  }
}
function qrDraw(g: Draw, q: QrMatrix, x: number, y: number, s: number, ink: string) {
  const n = q.moduleCount, cell = s / (n + 4);
  g.path(rr(x, y, s, s, cell * 1.5), { fill: '#ffffff' });
  g.sub(x, y, cell).path(modulesPath(q, 2), { fill: luminance(ink) < 0.3 ? ink : '#000000' });
}

export function drawFront(g: Draw, d: CardFields, o: Opts) {
  const W = o.W, H = o.H, pad = 6, ink2 = mixHex(o.ink, o.paper, 0.38);
  const contacts = ([['phone', d.phone], ['mail', d.email], ['web', d.website], ['pin', d.address]] as const).filter((c) => c[1]);
  g.rect(0, 0, W, H, { fill: o.paper });
  const qs = o.qr ? 17 : 0, t = o.tpl;
  const contactList = (x0: number, yTop: number, step: number, maxW: number, align: 'left' | 'right') => {
    contacts.forEach((c, i) => {
      const y = yTop + i * step;
      if (align === 'right') {
        const w = txt(g, c[1], x0, y, { size: 2.35, color: o.ink, align: 'right', maxW, weight: 450 });
        icon(g, c[0], x0 - w - 2.2, y - 0.8, 2.1, o.accent);
      } else {
        icon(g, c[0], x0 + 1.05, y - 0.8, 2.1, o.accent);
        txt(g, c[1], x0 + 3.4, y, { size: 2.35, color: o.ink, align: 'left', maxW: maxW - 3.4, weight: 450 });
      }
    });
  };
  if (t === 'band') {
    const bw = W * 0.36, bx = 0, on = onColor(o.accent);
    g.rect(bx, 0, bw, H, { fill: o.accent });
    const lb = g.imageIn(o.logo, bx + 5, H * 0.22, bw - 10, H * 0.38, 'center');
    if (!lb && d.company) txt(g, d.company, bx + bw / 2, H / 2 + 1.2, { size: 3.6, weight: 750, color: on, align: 'center', maxW: bw - 7 });
    else if (lb && d.company) txt(g, d.company, bx + bw / 2, H * 0.22 + H * 0.38 + 5, { size: 2.4, weight: 650, color: on, align: 'center', maxW: bw - 7 });
    const x0 = bw + 5, mw = W - x0 - pad;
    txt(g, d.name, x0, 15, { size: 4.6, weight: 750, color: o.ink, maxW: mw });
    txt(g, d.title, x0, 19.6, { size: 2.6, weight: 500, color: ink2, maxW: mw });
    g.rect(x0, 22.6, 9, 0.6, { fill: o.accent });
    if (o.qr) qrDraw(g, o.qr, W - pad - qs, H - pad - qs, qs, o.ink);
    contactList(x0, 29.5, 4, mw - (qs ? qs + 2 : 0), 'left');
  } else if (t === 'centered') {
    const lc = g.imageIn(o.logo, W / 2 - 14, 5.5, 28, 10, 'center'), ny = lc ? 27 : 22;
    txt(g, d.name, W / 2, ny, { size: 4.8, weight: 750, color: o.ink, align: 'center', maxW: W - 14 });
    txt(g, [d.title, d.company].filter(Boolean).join('  ·  '), W / 2, ny + 4.6, { size: 2.6, weight: 500, color: ink2, align: 'center', maxW: W - 14 });
    g.rect(W / 2 - 5, ny + 7.2, 10, 0.6, { fill: o.accent });
    const row1 = [d.phone, d.email].filter(Boolean).join('   ·   '), row2 = [d.website, d.address].filter(Boolean).join('   ·   ');
    const cw = W - 12 - (qs ? 2 * (qs + 1) : 0);
    txt(g, row1, W / 2, H - (row2 ? 9.2 : 6), { size: 2.3, color: o.ink, align: 'center', maxW: cw, weight: 450 });
    txt(g, row2, W / 2, H - 6, { size: 2.3, color: o.ink, align: 'center', maxW: cw, weight: 450 });
    g.rect(0, H - 1.6, W, 1.6, { fill: o.accent });
    if (o.qr) qrDraw(g, o.qr, W - 4 - 13, H - 4 - 13 - 1.6, 13, o.ink);
  } else if (t === 'minimal') {
    g.rect(0, 0, W, 1.2, { fill: o.accent });
    const mwN = W - 2 * pad - (qs ? qs + 3 : 0);
    txt(g, d.name, pad, 13, { size: 5.1, weight: 750, color: o.ink, maxW: mwN });
    txt(g, d.title, pad, 17.6, { size: 2.6, weight: 500, color: ink2, maxW: mwN });
    txt(g, d.company, pad, 21.4, { size: 2.6, weight: 700, color: o.accent, maxW: mwN });
    if (o.qr) qrDraw(g, o.qr, W - pad - qs, 5, qs, o.ink);
    g.imageIn(o.logo, pad, H - pad - 9, 22, 9, 'left');
    contactList(W - pad, H - pad - (contacts.length - 1) * 3.6, 3.6, W * 0.62, 'right');
  } else { // classic
    g.rect(W - 2.2, 0, 2.2, H, { fill: o.accent });
    const ll = g.imageIn(o.logo, pad, pad - 0.5, 30, 11, 'left');
    const mw2 = W - 2 * pad - 2.2;
    if (!ll) txt(g, d.company, pad, pad + 4, { size: 3.1, weight: 750, color: o.accent, maxW: mw2 });
    const top = contacts.length > 3 ? 21 : 24;
    txt(g, d.name, pad, top, { size: 4.8, weight: 750, color: o.ink, maxW: mw2 });
    txt(g, d.title, pad, top + 4.4, { size: 2.6, weight: 500, color: ink2, maxW: mw2 });
    if (ll && d.company) txt(g, d.company, pad, top + 8, { size: 2.5, weight: 700, color: o.accent, maxW: mw2 });
    if (o.qr) qrDraw(g, o.qr, W - pad - 2.2 - qs, H - pad - qs, qs, o.ink);
    contactList(pad, H - pad - (contacts.length - 1) * 3.5, 3.5, mw2 - (qs ? qs + 2 : 0), 'left');
  }
}

export function drawBack(g: Draw, d: CardFields, o: Opts) {
  const W = o.W, H = o.H;
  if (o.back === 'logo') {
    const on = onColor(o.accent);
    g.rect(0, 0, W, H, { fill: o.accent });
    const lb = g.imageIn(o.logo, W * 0.2, H * 0.2, W * 0.6, H * (d.tagline ? 0.42 : 0.5), 'center');
    const y = lb ? H * 0.2 + H * (d.tagline ? 0.42 : 0.5) + 6 : H / 2 + (d.tagline ? -1 : 1.5);
    if (!lb) txt(g, d.company || d.name, W / 2, y, { size: 5, weight: 800, color: on, align: 'center', maxW: W - 14 });
    if (d.tagline) txt(g, d.tagline, W / 2, lb ? y : y + 6, { size: 2.6, weight: 500, color: on, align: 'center', maxW: W - 14 });
    if (d.website) txt(g, d.website, W / 2, H - 5, { size: 2.2, weight: 600, color: on, align: 'center', maxW: W - 14 });
  } else if (o.back === 'qr') {
    g.rect(0, 0, W, H, { fill: o.paper });
    g.rect(0, H - 1.6, W, 1.6, { fill: o.accent });
    const s = H * 0.6;
    if (o.qr) qrDraw(g, o.qr, (W - s) / 2, 5, s, o.ink);
    txt(g, o.qr ? 'Scan to save my contact' : 'Add your name to make the QR', W / 2, 5 + s + 5.4, { size: 2.6, weight: 650, color: o.ink, align: 'center', maxW: W - 12 });
    if (d.tagline) txt(g, d.tagline, W / 2, 5 + s + 9.4, { size: 2.2, weight: 450, color: mixHex(o.ink, o.paper, 0.38), align: 'center', maxW: W - 12 });
  } else g.rect(0, 0, W, H, { fill: o.paper });
}

function cropMarks(g: Draw, L: ReturnType<typeof sheetLayout>) {
  const top = L.y0, left = L.x0, bottom = Math.max(...L.ys), right = Math.max(...L.xs);
  let d = '';
  L.xs.forEach((x) => { d += 'M' + x + ' ' + (top - 1.5) + 'V' + (top - 6) + 'M' + x + ' ' + (bottom + 1.5) + 'V' + (bottom + 6); });
  L.ys.forEach((y) => { d += 'M' + (left - 1.5) + ' ' + y + 'H' + (left - 6) + 'M' + (right + 1.5) + ' ' + y + 'H' + (right + 6); });
  g.path(d, { stroke: '#000000', lineWidth: 0.2 });
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #0e9f9a');

export default defineTool({
  name: 'doc_business_cards',
  title: 'Business cards PDF',
  webSlug: 'business-card',
  description:
    'Design business cards and get a print-ready PDF sheet: cards centred on A4 or Letter with crop marks (10 per sheet for ' +
    '85 × 55 mm EU or 3.5 × 2 in US cards), plus a back side page mirrored for long-edge duplex printing. Four front ' +
    'templates (classic, band, centered, minimal), backs with your logo, a "scan to save my contact" vCard QR code, or ' +
    'blank; six colour themes or your own accent/paper/ink colours; optional logo and a vCard QR on the front. Also ' +
    'returns the vCard text. Print at 100% / actual size. Latin text only for now (the website also does an Arabic side). ' +
    `Web version: ${webUrl('business-card')}`,
  inputSchema: z.object({
    name: z.string().min(1).max(80).describe('Your name.'),
    title: z.string().max(80).optional().default('').describe('Job title.'),
    company: z.string().max(80).optional().default('').describe('Company.'),
    phone: z.string().max(40).optional().default(''), email: z.string().max(80).optional().default(''),
    website: z.string().max(80).optional().default(''), address: z.string().max(120).optional().default(''),
    tagline: z.string().max(80).optional().default('').describe('Short line for the back.'),
    template: z.enum(['classic', 'band', 'centered', 'minimal']).optional().default('classic').describe('Front layout.'),
    back: z.enum(['logo', 'qr', 'none']).optional().default('logo').describe('Back side: logo/company on the accent colour, a contact QR code, or none.'),
    qrFront: z.boolean().optional().default(false).describe('Also put the contact QR code on the front.'),
    theme: z.enum(['teal', 'navy', 'charcoal', 'forest', 'violet', 'mono']).optional().default('teal').describe('Colour preset (navy = navy & gold).'),
    accent: hex.optional().describe('Override the accent colour.'),
    paperColor: hex.optional().describe('Override the card background colour.'),
    ink: hex.optional().describe('Override the text colour.'),
    size: z.enum(['eu', 'us']).optional().default('eu').describe('eu = 85 × 55 mm, us = 3.5 × 2 in.'),
    sheet: z.enum(['A4', 'Letter']).optional().default('A4').describe('Paper for the print sheet.'),
    gap: z.number().min(0).max(10).optional().default(0).describe('Gap between cards in mm (0 = shared cut lines).'),
    sides: z.enum(['both', 'front', 'back']).optional().default('both').describe('Which pages to include (both = front page then mirrored back page).'),
    logo: imageInput(),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfOutputShape,
    cardsPerSheet: z.number(), columns: z.number(), rows: z.number(),
    vcard: z.string().describe('The vCard 3.0 text (what the QR code holds).'),
    qrVersion: z.number().nullable(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: { name: 'Lina Haddad', title: 'Optometrist', company: 'Lumen Eye Clinic', phone: '+962 79 000 0000', email: 'lina@lumen.example', website: 'lumen.example', address: 'Amman, Jordan', back: 'qr' },
    note: 'A4 sheet of 10 fronts + mirrored sheet of 10 QR backs.',
  }],
  async run(input, ctx) {
    const d: CardFields = {};
    for (const k of ['name', 'title', 'company', 'phone', 'email', 'website', 'address', 'tagline'] as const) d[k] = userText(input[k], k).trim();
    if (!d.name) throw new ToolError('Add your name.');
    const th = THEMES[input.theme];
    const v = vcard(d);
    let qr: QrMatrix | null = null;
    if (input.qrFront || input.back === 'qr') {
      try { qr = makeQR(v, 'M'); } catch { throw new ToolError('Too much text for the QR code: shorten the fields or turn the QR off.'); }
    }
    const L = sheetLayout(input.sheet, input.size, input.gap);
    const { doc, fonts } = await newDoc(`Business cards: ${d.name}`, ctx);
    const logo = await embedImage(doc, input.logo, ctx, 'logo', 1200);
    const o: Opts = {
      W: L.w, H: L.h, tpl: input.template, accent: (input.accent ?? th.accent).toLowerCase(), paper: (input.paperColor ?? th.paper).toLowerCase(),
      ink: (input.ink ?? th.ink).toLowerCase(), logo, qr: null, back: input.back,
    };
    let sides: ('front' | 'back')[] = input.sides === 'both' ? ['front', 'back'] : [input.sides];
    if (input.back === 'none') sides = sides.filter((s) => s === 'front');
    if (!sides.length) throw new ToolError('The back side is "none": nothing to print. Use sides "front" or "both".');
    for (const side of sides) {
      const page = doc.addPage([L.W * MM, L.H * MM]);
      const g = new Draw(page, fonts as Fonts, MM);
      for (const p of L.pos) {
        const x = side === 'back' ? L.W - p.x - L.w : p.x; // mirrored for long-edge duplex
        const cg = g.sub(x, p.y);
        if (side === 'front') drawFront(cg, d, { ...o, qr: input.qrFront ? qr : null });
        else drawBack(cg, d, { ...o, qr });
      }
      cropMarks(g, L);
    }
    const base = (d.name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'business-card') + '-cards.pdf';
    const out = await savePdf(doc, { output: input.output, defaultName: base, base64: input.returnBase64 }, ctx);
    return { ...out, mimeType: 'application/pdf', cardsPerSheet: L.n, columns: L.cols, rows: L.rows, vcard: v, qrVersion: qr ? qr.version : null };
  },
});

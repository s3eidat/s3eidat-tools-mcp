import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { outputPath, returnBase64 } from '../../../util/files.js';
import { Draw, color, embedImage, imageInput, newDoc, num, pdfOutputShape, pdfSafe, round, savePdf, userText, wrap, type Fonts } from './_pdf.js';
import { degrees, type PDFDocument, type PDFImage } from 'pdf-lib';

// Port of https://github.com/s3eidat/invoice-maker (app.js): same fields, per-line rounding to the currency's minor
// unit, discount/tax maths, number and date formatting. The site prints its HTML page; this draws the same A4 layout.
export const CUR = ['USD', 'EUR', 'GBP', 'JOD', 'SAR', 'AED', 'EGP', 'KWD', 'QAR', 'BHD', 'OMR', 'IQD', 'LBP', 'MAD', 'TND', 'DZD',
  'TRY', 'INR', 'PKR', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'ZAR', 'BRL', 'MXN', 'SGD'] as const;

// ---------- pure logic (same as the website) ----------
export function digits(c: string) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}
export function pct(v: unknown) { return Math.min(100, Math.max(0, num(v))); }
export interface Item { desc?: string; qty?: number; price?: number; disc?: number; tax?: number }
/** Each line: gross = qty×price, discount and tax rounded per line to the currency's minor unit. */
export function calc(inv: { currency: string; items: Item[] }) {
  const d = digits(inv.currency);
  let sub = 0, disc = 0, tax = 0;
  const rates: Record<string, number> = {};
  const lines = inv.items.map((it) => {
    const gross = round(num(it.qty) * num(it.price), d);
    const dc = round((gross * pct(it.disc)) / 100, d);
    const net = round(gross - dc, d);
    const tx = round((net * pct(it.tax)) / 100, d);
    sub += gross; disc += dc; tax += tx;
    if (pct(it.tax)) rates[pct(it.tax)] = round((rates[pct(it.tax)] || 0) + tx, d);
    return { gross, disc: dc, net, tax: tx };
  });
  sub = round(sub, d); disc = round(disc, d); tax = round(tax, d);
  return { d, lines, sub, disc, tax, rates, total: round(sub - disc + tax, d) };
}
export function nextNumber(s: string) {
  const m = /^(.*?)(\d+)(\D*)$/.exec(s || '');
  if (!m) return (s || 'INV') + '-2';
  let n = String(Number(m[2]) + 1);
  while (n.length < m[2].length) n = '0' + n;
  return m[1] + n + m[3];
}

const fmtCache: Record<string, Intl.NumberFormat> = {};
/** en-US currency format with the currency's own decimals; falls back to the ISO code if the symbol isn't Latin-1. */
export function money(c: string, v: number) {
  const d = digits(c);
  const f = fmtCache[c] || (fmtCache[c] = new Intl.NumberFormat('en-US', { style: 'currency', currency: c, minimumFractionDigits: d, maximumFractionDigits: d }));
  const s = pdfSafe(f.format(v));
  if (/^[\x20-\x7e\xa0-\xff€]*$/.test(s)) return s;
  return pdfSafe(new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'code', minimumFractionDigits: d, maximumFractionDigits: d }).format(v));
}
export function plain(v: number) { return String(Math.round(v * 1e6) / 1e6); }
export function fmtDate(s: string) {
  if (!s) return '';
  const p = s.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function isoToday(add = 0) {
  const d = new Date(); d.setDate(d.getDate() + add);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------- drawing ----------
const EM = 9.6; // print font size (pt)
const GREY = '#525a66', LIGHT = '#7a828e', LINE = '#e8ebef', INK = '#111111', BODY = '#1d2127';

interface Inv {
  number: string; date: string; due: string; currency: string; accent: string; paid: boolean;
  from: { name: string; email: string; phone: string; address: string; taxId: string };
  to: { name: string; email: string; address: string };
  items: Required<Item>[]; notes: string; terms: string;
}

async function drawInvoice(doc: PDFDocument, fonts: Fonts, inv: Inv, logo: PDFImage | undefined) {
  const W = 595.28, H = 841.89, PX = 15 * 72 / 25.4, PT = 16 * 72 / 25.4, PB = 16 * 72 / 25.4, cw = W - 2 * PX, gap = 2.4 * EM;
  const c = calc(inv), m = (v: number) => money(inv.currency, v);
  const hasDisc = inv.items.some((it) => pct(it.disc) > 0), hasTax = inv.items.some((it) => pct(it.tax) > 0);
  let page = doc.addPage([W, H]), g = new Draw(page, fonts);
  const lh = EM * 1.45;
  const mw = (t: string, size = EM, f = fonts.sans) => g.width(t, size, f);
  const lines = (text: string, x: number, y: number, maxW: number, color = GREY, size = EM, align: 'left' | 'right' = 'left') => {
    for (const l of wrap((t) => mw(t, size), text, maxW)) { g.text(l, align === 'right' ? x + maxW : x, y + size, { size, color, align }); y += size * 1.45; }
    return y;
  };

  // ---- header: business (left) + INVOICE meta (right)
  const metaRows: [string, string][] = [['Invoice no.', inv.number], ['Issue date', fmtDate(inv.date)]];
  if (inv.due) metaRows.push(['Due date', fmtDate(inv.due)]);
  const metaW = Math.max(mw('INVOICE', 2.4 * EM, fonts.bold), ...metaRows.map(([k, v]) => mw(k) + EM + mw(v, EM, fonts.bold)));
  const leftW = cw - metaW - 2 * EM;
  let y = PT, ly = PT;
  if (logo) { const s = g.imageIn(logo, PX, ly, 13 * EM, 6 * EM, 'left', 'top'); if (s) ly += s.h + 0.6 * EM; }
  if (inv.from.name) { for (const l of wrap((t) => mw(t, 1.35 * EM, fonts.bold), inv.from.name, leftW)) { g.text(l, PX, ly + 1.35 * EM, { size: 1.35 * EM, font: fonts.bold, color: INK }); ly += 1.35 * EM * 1.45; } ly += 0.25 * EM; }
  if (inv.from.address) ly = lines(inv.from.address, PX, ly, leftW) + 0.25 * EM;
  const contact = [inv.from.email, inv.from.phone].filter(Boolean).join('  ·  ');
  if (contact) ly = lines(contact, PX, ly, leftW) + 0.25 * EM;
  if (inv.from.taxId) ly = lines('Tax ID: ' + inv.from.taxId, PX, ly, leftW) + 0.25 * EM;
  let ry = y;
  g.text('INVOICE', W - PX, ry + 2.4 * EM * 0.8, { size: 2.4 * EM, font: fonts.bold, color: inv.accent, align: 'right' });
  ry += 2.4 * EM + 0.35 * 2.4 * EM;
  for (const [k, v] of metaRows) {
    const vw = g.text(v, W - PX, ry + EM, { size: EM, font: fonts.bold, color: INK, align: 'right' });
    g.text(k, W - PX - vw - EM, ry + EM, { size: EM, color: LIGHT, align: 'right' });
    ry += lh + 0.3 * EM;
  }
  y = Math.max(ly, ry) + gap;

  // ---- parties: Bill to + Amount due
  const pp = { x: 1.6 * EM, y: 1.4 * EM }, label = (t: string, x: number, yy: number, align: 'left' | 'right' = 'left') =>
    g.text(t.toUpperCase(), x, yy + 0.78 * EM, { size: 0.78 * EM, font: fonts.bold, color: '#8a919c', align });
  const dueW = Math.max(mw(m(c.total), 1.9 * EM, fonts.bold), mw('AMOUNT DUE', 0.78 * EM, fonts.bold)) + 2 * EM;
  const billW = cw - 2 * pp.x - dueW - 2 * EM;
  // measure the bill-to block first
  const billLines: { t: string; size: number; bold?: boolean; color: string }[] = [];
  if (inv.to.name) for (const l of wrap((t) => mw(t, 1.12 * EM, fonts.bold), inv.to.name, billW)) billLines.push({ t: l, size: 1.12 * EM, bold: true, color: INK });
  for (const part of [inv.to.address, inv.to.email]) if (part) for (const l of wrap((t) => mw(t), part, billW)) billLines.push({ t: l, size: EM, color: GREY });
  const billH = 0.78 * EM * 1.45 + 0.35 * EM + billLines.reduce((s, l) => s + l.size * 1.45, 0);
  const dueH = 0.78 * EM * 1.45 + 0.35 * EM + 1.9 * EM * 1.3 + (inv.paid ? 2.2 * EM : 0);
  const boxH = Math.max(billH, dueH) + 2 * pp.y;
  g.roundRect(PX, y, cw, boxH, 0.6 * EM, { fill: '#f5f7f9' });
  label('Bill to', PX + pp.x, y + pp.y);
  let by = y + pp.y + 0.78 * EM * 1.45 + 0.35 * EM;
  for (const l of billLines) { g.text(l.t, PX + pp.x, by + l.size, { size: l.size, font: l.bold ? fonts.bold : fonts.sans, color: l.color }); by += l.size * 1.45; }
  const rx = W - PX - pp.x;
  label(inv.paid ? 'Amount paid' : 'Amount due', rx, y + pp.y, 'right');
  const bigY = y + pp.y + 0.78 * EM * 1.45 + 0.35 * EM;
  g.text(m(c.total), rx, bigY + 1.9 * EM * 0.95, { size: 1.9 * EM, font: fonts.bold, color: INK, align: 'right' });
  if (inv.paid) {
    const sw = mw('PAID', EM * 1.1, fonts.bold) + 1.8 * EM, sh = 1.9 * EM, sx = rx - sw, sy = bigY + 1.9 * EM * 1.3 + 0.2 * EM;
    // rotated -6° like the website's stamp (pdf-lib rotates counter-clockwise around the bottom-left corner)
    const a = (6 * Math.PI) / 180, bx = g.X(sx), byy = g.Y(sy + sh);
    page.drawRectangle({ x: bx, y: byy, width: sw, height: sh, borderColor: color('#1f9d61'), borderWidth: 0.18 * EM, rotate: degrees(6) });
    const tw = mw('PAID', EM * 1.1, fonts.bold), lx = (sw - tw) / 2, lyy = sh * 0.3;
    page.drawText('PAID', { x: bx + lx * Math.cos(a) - lyy * Math.sin(a), y: byy + lx * Math.sin(a) + lyy * Math.cos(a), size: EM * 1.1, font: fonts.bold, color: color('#1f9d61'), rotate: degrees(6) });
  }
  y += boxH + gap;

  // ---- items table
  const head = ['Description', 'Qty', 'Unit price', ...(hasDisc ? ['Disc.'] : []), ...(hasTax ? ['Tax'] : []), 'Amount'];
  const rows = inv.items.map((it, i) => [it.desc || '—', plain(num(it.qty)), m(num(it.price)),
    ...(hasDisc ? [pct(it.disc) ? plain(pct(it.disc)) + '%' : '—'] : []), ...(hasTax ? [pct(it.tax) ? plain(pct(it.tax)) + '%' : '—'] : []), m(c.lines[i].net)]);
  const padX = 0.8 * EM, hs = 0.78 * EM;
  const colW = head.map((h, ci) => ci === 0 ? 0 : Math.max(mw(h.toUpperCase(), hs, fonts.bold), ...rows.map((r) => mw(r[ci], EM, ci === head.length - 1 ? fonts.bold : fonts.sans))) + 2 * padX);
  colW[0] = Math.max(8 * EM, cw - colW.slice(1).reduce((a, b) => a + b, 0));
  const colX: number[] = [];
  colW.reduce((x, w, i) => { colX[i] = x; return x + w; }, PX);
  const headH = hs * 1.45 + 1.4 * EM;
  const drawHead = () => {
    g.roundRect(PX, y, cw, headH, 0.4 * EM, { fill: inv.accent });
    head.forEach((h, ci) => g.text(h.toUpperCase(), ci === 0 ? colX[ci] + padX : colX[ci] + colW[ci] - padX, y + 0.7 * EM + hs, { size: hs, font: fonts.bold, color: '#ffffff', align: ci === 0 ? 'left' : 'right' }));
    y += headH;
  };
  const newPage = () => { page = doc.addPage([W, H]); g = new Draw(page, fonts); y = PT; };
  drawHead();
  if (!rows.length) y += lh + 1.5 * EM;
  rows.forEach((r) => {
    const descLines = wrap((t) => mw(t), r[0], colW[0] - 2 * padX);
    const rowH = descLines.length * lh + 1.5 * EM;
    if (y + rowH > H - PB) { newPage(); drawHead(); }
    descLines.forEach((l, li) => g.text(l, colX[0] + padX, y + 0.75 * EM + EM + li * lh, { size: EM, color: BODY }));
    r.slice(1).forEach((v, k) => {
      const ci = k + 1, last = ci === head.length - 1;
      g.text(v, colX[ci] + colW[ci] - padX, y + 0.75 * EM + EM, { size: EM, font: last ? fonts.bold : fonts.sans, color: last ? INK : BODY, align: 'right' });
    });
    y += rowH;
    g.line(PX, y, PX + cw, y, { color: LINE, width: 0.75 });
  });

  // ---- totals
  const totRows: [string, string][] = [['Subtotal', m(c.sub)]];
  if (c.disc) totRows.push(['Discount', '-' + m(c.disc)]);
  Object.keys(c.rates).sort((a, b) => +a - +b).forEach((r) => totRows.push(['Tax ' + plain(+r) + '%', m(c.rates[r])]));
  const totH = totRows.length * (lh + 0.45 * EM) + 1.15 * EM * 1.45 + 1.7 * EM;
  y += gap - EM;
  if (y + totH > H - PB) newPage();
  const tw = Math.min(22 * EM, cw), tx = PX + cw - tw;
  for (const [k, v] of totRows) {
    g.text(k, tx + padX, y + EM, { size: EM, color: GREY });
    g.text(v, tx + tw - padX, y + EM, { size: EM, color: GREY, align: 'right' });
    y += lh + 0.45 * EM;
  }
  y += 0.3 * EM;
  g.rect(tx, y, tw, 0.15 * EM, { fill: inv.accent });
  const ts = 1.15 * EM;
  g.text('Total ' + inv.currency, tx + padX, y + 0.7 * EM + ts, { size: ts, font: fonts.bold, color: INK });
  g.text(m(c.total), tx + tw - padX, y + 0.7 * EM + ts, { size: ts, font: fonts.bold, color: INK, align: 'right' });
  y += 0.7 * EM * 2 + ts * 1.45;

  // ---- footer (notes + payment terms) at the bottom of the last page
  const foot = ([['Notes', inv.notes], ['Payment terms', inv.terms]] as const).filter(([, v]) => v);
  if (foot.length) {
    const fw = foot.length === 2 ? (cw - 1.6 * EM) / 2 : cw;
    const blocks = foot.map(([k, v]) => ({ k, lines: wrap((t) => mw(t), v, fw) }));
    const fh = 1.4 * EM + 0.78 * EM * 1.45 + 0.35 * EM + Math.max(...blocks.map((b) => b.lines.length)) * lh;
    if (y + gap + fh > H - PB) newPage();
    const fy = Math.max(y + gap, H - PB - fh);
    g.line(PX, fy, PX + cw, fy, { color: LINE, width: 0.75 });
    blocks.forEach((b, i) => {
      const fx = PX + i * (fw + 1.6 * EM);
      let yy = fy + 1.4 * EM;
      label(b.k, fx, yy);
      yy += 0.78 * EM * 1.45 + 0.35 * EM;
      for (const l of b.lines) { g.text(l, fx, yy + EM, { size: EM, color: GREY }); yy += lh; }
    });
  }
  return c;
}

const itemSchema = z.object({
  desc: z.string().max(500).optional().default('').describe('Description of the product or service.'),
  qty: z.number().optional().default(1).describe('Quantity (default 1).'),
  price: z.number().optional().default(0).describe('Unit price.'),
  disc: z.number().optional().default(0).describe('Line discount in % (0-100).'),
  tax: z.number().optional().default(0).describe('Line tax rate in % (0-100), applied after the discount.'),
});

export default defineTool({
  name: 'doc_invoice',
  title: 'Invoice PDF',
  webSlug: 'invoice-maker',
  description:
    'Make a clean A4 invoice PDF: your business (logo, name, address, email, phone, tax ID), client, invoice number and ' +
    'dates, line items with quantity, unit price, per-line discount % and tax %, subtotal, discount, tax per rate and total, ' +
    'notes, payment terms, and an optional PAID stamp. Same maths as the website: every line is rounded to the currency\'s ' +
    'minor unit (2 decimals, 3 for JOD/KWD/BHD/OMR/TND…, 0 for JPY…) with half-up rounding; amounts formatted en-US style ' +
    '($1,234.50, JOD 10.124). Long item lists continue on more pages. Returns the PDF path and the computed totals. ' +
    `Latin text only for now. Web version: ${webUrl('invoice-maker')}`,
  inputSchema: z.object({
    number: z.string().max(40).optional().default('INV-0001').describe('Invoice number.'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Issue date, YYYY-MM-DD (default today).'),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date, YYYY-MM-DD (optional).'),
    currency: z.enum(CUR).optional().default('USD').describe('Currency code.'),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#0e9f9a').describe('Accent colour (hex).'),
    paid: z.boolean().optional().default(false).describe('Mark as paid (shows "Amount paid" and a PAID stamp).'),
    from: z.object({
      name: z.string().max(120).optional().default(''), email: z.string().max(120).optional().default(''), phone: z.string().max(60).optional().default(''),
      address: z.string().max(400).optional().default('').describe('Multi-line address (use \\n).'), taxId: z.string().max(60).optional().default(''),
    }).optional().default({ name: '', email: '', phone: '', address: '', taxId: '' }).describe('Your business: name, email, phone, address, taxId.'),
    to: z.object({
      name: z.string().max(120).optional().default(''), email: z.string().max(120).optional().default(''), address: z.string().max(400).optional().default(''),
    }).optional().default({ name: '', email: '', address: '' }).describe('The client (bill to): name, email, address.'),
    items: z.array(itemSchema).max(300).describe('Line items: desc, qty, price, disc %, tax %.'),
    notes: z.string().max(4000).optional().default('').describe('Notes shown at the bottom.'),
    terms: z.string().max(4000).optional().default('').describe('Payment terms shown at the bottom.'),
    logo: imageInput(),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfOutputShape,
    subtotal: z.number(), discount: z.number(), tax: z.number(), total: z.number(),
    taxByRate: z.record(z.string(), z.number()).describe('Tax amount per rate (%).'),
    lineAmounts: z.array(z.number()).describe('Net amount of each line (after discount, before tax).'),
    currency: z.string(), decimals: z.number(), formattedTotal: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: {
      number: 'INV-0042', currency: 'USD', from: { name: 'Northwind Studio', email: 'hello@northwind.studio' }, to: { name: 'Blue Fern Café' },
      items: [{ desc: 'Brand identity design', qty: 1, price: 1200, tax: 8 }, { desc: 'Menu layout (per page)', qty: 4, price: 85, disc: 10, tax: 8 }],
      terms: 'Bank transfer within 14 days.',
    },
    note: 'Subtotal $1,540.00, discount $34.00, tax 8% $120.48, total $1,626.48.',
  }],
  async run(input, ctx) {
    const inv: Inv = {
      number: userText(input.number, 'number') || 'INV-0001', date: input.date ?? isoToday(), due: input.due ?? '', currency: input.currency,
      accent: input.accent.toLowerCase(), paid: input.paid,
      from: {
        name: userText(input.from.name, 'from.name'), email: userText(input.from.email, 'from.email'), phone: userText(input.from.phone, 'from.phone'),
        address: userText(input.from.address, 'from.address'), taxId: userText(input.from.taxId, 'from.taxId'),
      },
      to: { name: userText(input.to.name, 'to.name'), email: userText(input.to.email, 'to.email'), address: userText(input.to.address, 'to.address') },
      items: input.items.map((it, i) => ({ desc: userText(it.desc, `items[${i}].desc`), qty: num(it.qty), price: num(it.price), disc: pct(it.disc), tax: pct(it.tax) })),
      notes: userText(input.notes, 'notes'), terms: userText(input.terms, 'terms'),
    };
    const { doc, fonts } = await newDoc(`Invoice ${inv.number}`, ctx);
    doc.setSubject(['Invoice', inv.number, inv.to.name].filter(Boolean).join(' · ').replace(/·/g, '-'));
    const logo = await embedImage(doc, input.logo, ctx, 'logo', 960);
    const c = await drawInvoice(doc, fonts, inv, logo);
    const out = await savePdf(doc, { output: input.output, defaultName: `invoice-${inv.number}.pdf`, base64: input.returnBase64 }, ctx);
    return {
      ...out, mimeType: 'application/pdf', subtotal: c.sub, discount: c.disc, tax: c.tax, total: c.total, taxByRate: c.rates,
      lineAmounts: c.lines.map((l) => l.net), currency: inv.currency, decimals: c.d, formattedTotal: money(inv.currency, c.total),
    };
  },
});

import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { outputPath, returnBase64 } from '../../../util/files.js';
import { Draw, MM, newDoc, num, pdfOutputShape, pdfSafe, round, savePdf, userText, wrap } from './_pdf.js';


// Port of https://github.com/s3eidat/receipt-maker (app.js): same row model, maths (rounded to the chosen decimals,
// discount as % or amount, tax after discount, change) and formats (80 mm thermal roll or A5), English labels.
const LBL: Record<string, string> = {
  receipt: 'Receipt', no: 'No.', date: 'Date', customer: 'Customer', subtotal: 'Subtotal', discount: 'Discount', tax: 'Tax', total: 'Total',
  payment: 'Payment', paid: 'Paid', change: 'Change', taxId: 'Tax no.', phone: 'Tel',
  cash: 'Cash', card: 'Card', transfer: 'Bank transfer', wallet: 'E-wallet', other: 'Other',
};
const PAYS = ['cash', 'card', 'transfer', 'wallet', 'other'] as const;

export interface RcItem { name?: string; qty?: number; price?: number }
export interface Rc { items: RcItem[]; disc?: number; discType?: 'pct' | 'amt'; tax?: number; paid?: number }
export function calc(r: Rc, d: number) {
  let sub = 0;
  const lines = r.items.map((it) => { const a = round(num(it.qty) * num(it.price), d); sub += a; return a; });
  sub = round(sub, d);
  const disc = r.discType === 'amt' ? Math.min(sub, Math.max(0, round(num(r.disc), d))) : round((sub * Math.min(100, Math.max(0, num(r.disc)))) / 100, d);
  const net = round(sub - disc, d), tax = round((net * Math.min(100, Math.max(0, num(r.tax)))) / 100, d), total = round(net + tax, d);
  const paid = Math.max(0, num(r.paid));
  return { lines, sub, disc, tax, total, paid, change: paid ? round(paid - total, d) : 0 };
}
const fmtNum = (v: number) => String(Math.round(v * 1000) / 1000);
function fmtWhen(s: string) { const p = s.split(/[-T:]/); return p[2] + '/' + p[1] + '/' + p[0] + '  ' + p[3] + ':' + p[4]; }
function nowLocal() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }

type Row = { t: 'title' | 'center' | 'head' | 'rule' | 'kv' | 'total' | 'item'; text?: string; k?: string; v?: string; name?: string; sub?: string; amt?: string; bold?: boolean; ph?: boolean };
interface Shop { name: string; address: string; phone: string; taxId: string; currency: string; decimals: number; prefix: string; footer: string }
interface Receipt { no: number; when: string; customer: string; pay: typeof PAYS[number]; items: RcItem[]; disc: number; discType: 'pct' | 'amt'; tax: number; paid: number; note: string }

export function model(shop: Shop, rc: Receipt) {
  const c = calc(rc, shop.decimals), rows: Row[] = [];
  const money = (v: number) => {
    const s = new Intl.NumberFormat('en-US', { minimumFractionDigits: shop.decimals, maximumFractionDigits: shop.decimals }).format(v);
    return shop.currency ? s + ' ' + shop.currency : s;
  };
  rows.push({ t: 'title', text: shop.name || 'Your shop', ph: !shop.name });
  if (shop.address) rows.push({ t: 'center', text: shop.address });
  if (shop.phone) rows.push({ t: 'center', text: LBL.phone + ': ' + shop.phone });
  if (shop.taxId) rows.push({ t: 'center', text: LBL.taxId + ': ' + shop.taxId });
  rows.push({ t: 'rule' });
  rows.push({ t: 'head', text: LBL.receipt });
  rows.push({ t: 'kv', k: LBL.no, v: shop.prefix + rc.no });
  rows.push({ t: 'kv', k: LBL.date, v: fmtWhen(rc.when) });
  if (rc.customer) rows.push({ t: 'kv', k: LBL.customer, v: rc.customer });
  rows.push({ t: 'rule' });
  let any = false;
  rc.items.forEach((it, i) => {
    if (!it.name && !num(it.price)) return;
    any = true;
    rows.push({ t: 'item', name: it.name || '—', sub: fmtNum(num(it.qty)) + ' × ' + money(num(it.price)), amt: money(c.lines[i]) });
  });
  if (!any) rows.push({ t: 'center', text: 'Add items in the form', ph: true });
  rows.push({ t: 'rule' });
  rows.push({ t: 'kv', k: LBL.subtotal, v: money(c.sub) });
  if (c.disc) rows.push({ t: 'kv', k: LBL.discount + (rc.discType === 'pct' ? ' ' + fmtNum(num(rc.disc)) + '%' : ''), v: '−' + money(c.disc) });
  if (c.tax) rows.push({ t: 'kv', k: LBL.tax + ' ' + fmtNum(num(rc.tax)) + '%', v: money(c.tax) });
  rows.push({ t: 'total', k: LBL.total, v: money(c.total) });
  rows.push({ t: 'kv', k: LBL.payment, v: LBL[rc.pay] });
  if (c.paid) { rows.push({ t: 'kv', k: LBL.paid, v: money(c.paid) }); rows.push({ t: 'kv', k: LBL.change, v: money(c.change) }); }
  if (rc.note || shop.footer) rows.push({ t: 'rule' });
  if (rc.note) rows.push({ t: 'center', text: rc.note });
  if (shop.footer) rows.push({ t: 'center', text: shop.footer, bold: true });
  return { rows, c, money };
}

/** The website's plain-text (32 columns) rendering. */
export function renderText(rows: Row[]) {
  const W = 32, out: string[] = [];
  const pad = (a: string, b: string) => a + ' '.repeat(Math.max(1, W - a.length - b.length)) + b;
  const center = (t: string) => ' '.repeat(Math.max(0, Math.floor((W - t.length) / 2))) + t;
  rows.forEach((r) => {
    if (r.ph) return;
    if (r.t === 'rule') out.push('-'.repeat(W));
    else if (r.t === 'item') { out.push(r.name!); out.push(pad('  ' + r.sub, r.amt!)); }
    else if (r.t === 'kv') out.push(pad(r.k!, r.v!));
    else if (r.t === 'total') out.push(pad(r.k!.toUpperCase(), r.v!));
    else out.push(center(r.text!));
  });
  return out.join('\n');
}

export default defineTool({
  name: 'doc_receipt',
  title: 'Receipt PDF',
  webSlug: 'receipt-maker',
  description:
    'Make a simple sales receipt as PDF: an 80 mm thermal-roll receipt (page height fits the content, monospace) or an A5 ' +
    'page. Shop header (name, address, phone, tax number), receipt number with prefix, date/time, customer, items ' +
    '(name × qty × price), discount (% or fixed amount), tax % after discount, total, payment method, amount paid and ' +
    'change, note and footer. Same maths as the website: amounts rounded half-up to 0, 2 or 3 decimals. Also returns the ' +
    `totals and a 32-column plain-text version. English labels, Latin text only for now. Web version: ${webUrl('receipt-maker')}`,
  inputSchema: z.object({
    shop: z.object({
      name: z.string().max(80).optional().default('').describe('Shop name.'),
      address: z.string().max(160).optional().default(''), phone: z.string().max(40).optional().default(''), taxId: z.string().max(40).optional().default(''),
      currency: z.string().max(8).optional().default('JD').describe('Currency text written after amounts, e.g. JD, USD, $ (default JD).'),
      decimals: z.union([z.literal(0), z.literal(2), z.literal(3)]).optional().default(2).describe('Decimals: 0, 2 (default) or 3.'),
      prefix: z.string().max(10).optional().default('R-').describe('Receipt number prefix (default "R-").'),
      footer: z.string().max(120).optional().default('Thank you!').describe('Footer line.'),
    }).optional().default({ name: '', address: '', phone: '', taxId: '', currency: 'JD', decimals: 2, prefix: 'R-', footer: 'Thank you!' })
      .describe('Shop details: name, address, phone, taxId, currency, decimals, prefix, footer.'),
    no: z.number().int().min(1).optional().default(1).describe('Receipt number.'),
    when: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().describe('Date and time, YYYY-MM-DDTHH:MM (default now).'),
    customer: z.string().max(80).optional().default('').describe('Customer name or table (optional).'),
    pay: z.enum(PAYS).optional().default('cash').describe('Payment method.'),
    items: z.array(z.object({
      name: z.string().max(120).optional().default(''), qty: z.number().optional().default(1), price: z.number().optional().default(0),
    })).max(200).describe('Items: name, qty, price.'),
    disc: z.number().optional().default(0).describe('Discount: a percentage, or an amount when discType is "amt".'),
    discType: z.enum(['pct', 'amt']).optional().default('pct').describe('pct = percent of subtotal (default), amt = fixed amount.'),
    tax: z.number().optional().default(0).describe('Tax rate % applied after the discount.'),
    paid: z.number().optional().default(0).describe('Amount the customer paid (shows change).'),
    note: z.string().max(200).optional().default('').describe('Note line above the footer.'),
    format: z.enum(['thermal', 'a5']).optional().default('thermal').describe('thermal = 80 mm roll (default), a5 = A5 page.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfOutputShape,
    subtotal: z.number(), discount: z.number(), tax: z.number(), total: z.number(), paid: z.number(), change: z.number(),
    text: z.string().describe('Plain-text receipt (32 columns).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: {
      shop: { name: 'Zaytoun Corner Café', address: 'Rainbow St. 12, Amman', currency: 'JD', decimals: 3 }, no: 1043, customer: 'Table 4', paid: 10, disc: 10, tax: 16,
      items: [{ name: 'Cappuccino', qty: 2, price: 2.25 }, { name: "Za'atar manakeesh", qty: 1, price: 1.5 }, { name: 'Fresh orange juice', qty: 1, price: 2 }],
    },
    note: 'Subtotal 8.000, discount 0.800, tax 1.152, total 8.352 JD, change 1.648.',
  }],
  async run(input, ctx) {
    const s = input.shop;
    const shop: Shop = {
      name: userText(s.name, 'shop.name'), address: userText(s.address, 'shop.address'), phone: userText(s.phone, 'shop.phone'), taxId: userText(s.taxId, 'shop.taxId'),
      currency: userText(s.currency, 'shop.currency'), decimals: s.decimals, prefix: userText(s.prefix, 'shop.prefix'), footer: userText(s.footer, 'shop.footer'),
    };
    const rc: Receipt = {
      no: input.no, when: input.when ?? nowLocal(), customer: userText(input.customer, 'customer'), pay: input.pay,
      items: input.items.map((it, i) => ({ name: userText(it.name, `items[${i}].name`), qty: it.qty, price: it.price })),
      disc: input.disc, discType: input.discType, tax: input.tax, paid: input.paid, note: userText(input.note, 'note'),
    };
    const { rows, c } = model(shop, rc);
    const thermal = input.format === 'thermal';
    const { doc, fonts } = await newDoc(`Receipt ${shop.prefix}${rc.no}`, ctx);

    // Layout in pt. Thermal: 80 mm, 12.5 px monospace, padding 5/4.5/7 mm. A5: 14 px sans, padding 14/13 mm.
    const W = (thermal ? 80 : 148) * MM, em = (thermal ? 12.5 : 14) * 0.75, LH = thermal ? 1.45 : 1.5;
    const padX = (thermal ? 4.5 : 13) * MM, padT = (thermal ? 5 : 14) * MM, padB = (thermal ? 7 : 14) * MM;
    const reg = thermal ? fonts.mono : fonts.sans, bold = thermal ? fonts.monoBold : fonts.bold;
    const inner = W - 2 * padX;
    const pass = (g: Draw | null) => {
      let y = padT;
      const measure = (f: typeof reg, size: number) => (t: string) => f.widthOfTextAtSize(pdfSafe(t), size);
      const center = (text: string, size: number, f: typeof reg, color: string) => {
        for (const l of wrap(measure(f, size), text, inner)) { g?.text(l, W / 2, y + size * 0.8 + (LH - 1) * size / 2, { size, font: f, color, align: 'center' }); y += size * LH; }
      };
      for (const r of rows) {
        if (r.ph) continue;
        if (r.t === 'rule') { y += 0.7 * em; g?.line(padX, y, W - padX, y, { color: '#9aa0a8', width: 1.1, dash: [3, 3] }); y += 0.7 * em + 1.1; continue; }
        if (r.t === 'title') { const sz = em * (thermal ? 1.45 : 1.8); for (const l of wrap(measure(bold, sz), r.text!, inner)) { g?.text(l, W / 2, y + sz * 0.95, { size: sz, font: bold, align: 'center' }); y += sz * 1.2; } y += 0.2 * em; continue; }
        if (r.t === 'head') { const sz = em * 1.1; g?.text(r.text!.toUpperCase(), W / 2, y + sz * 0.8 + (LH - 1) * sz / 2, { size: sz, font: bold, align: 'center' }); y += sz * LH + 0.3 * em; continue; }
        if (r.t === 'center') { if (r.bold) y += 0.2 * em; center(r.text!, r.bold ? em : em * 0.93, r.bold ? bold : reg, r.bold ? '#111111' : '#444444'); continue; }
        const kv = (k: string, v: string, size: number, kf: typeof reg, kc: string) => {
          const base = y + size * 0.8 + (LH - 1) * size / 2;
          const vw = g ? g.text(v, W - padX, base, { size, font: bold, align: 'right', color: '#111111' }) : bold.widthOfTextAtSize(pdfSafe(v), size);
          g?.text(k, padX, base, { size, font: kf, color: kc, maxW: inner - vw - em });
          y += size * LH;
        };
        if (r.t === 'item') {
          for (const l of wrap(measure(bold, em), r.name!, inner)) { g?.text(l, padX, y + em * 0.8 + (LH - 1) * em / 2, { size: em, font: bold }); y += em * LH; }
          kv(r.sub!, r.amt!, em, reg, '#555555');
          y += 0.45 * em; continue;
        }
        if (r.t === 'total') {
          const sz = em * 1.3;
          y += 0.2 * sz; g?.rect(padX, y, inner, 1.5, { fill: '#111111' }); y += 1.5 + 0.25 * sz;
          kv(r.k!, r.v!, sz, bold, '#111111');
          y += 0.25 * sz; g?.rect(padX, y, inner, 1.5, { fill: '#111111' }); y += 1.5 + 0.2 * sz;
          continue;
        }
        kv(r.k!, r.v!, em, reg, '#111111');
      }
      return y + padB;
    };
    const fullH = pass(null);
    const H = thermal ? Math.max(fullH, 60 * MM) : 210 * MM;
    if (!thermal && fullH > H) {
      // Long A5 receipts: scale the content down to fit one page.
      const page = doc.addPage([W, H]);
      const k = H / fullH;
      pass(new Draw(page, fonts).sub((W - W * k) / 2, 0, k));
    } else {
      pass(new Draw(doc.addPage([W, H]), fonts));
    }
    const out = await savePdf(doc, { output: input.output, defaultName: `receipt-${(shop.prefix + rc.no).replace(/[^\w-]+/g, '')}.pdf`, base64: input.returnBase64 }, ctx);
    return {
      ...out, mimeType: 'application/pdf', subtotal: c.sub, discount: c.disc, tax: c.tax, total: c.total, paid: c.paid, change: c.change,
      text: renderText(rows),
    };
  },
});

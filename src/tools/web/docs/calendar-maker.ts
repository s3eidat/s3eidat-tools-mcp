import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, returnBase64 } from '../../../util/files.js';
import { Draw, MM, isWinAnsi, mixHex, newDoc, pdfOutputShape, pdfSafe, savePdf, userText } from './_pdf.js';

// Port of https://github.com/s3eidat/calendar-maker (app.js): day-number calendar maths (no Date drift), week start,
// Hijri (Umm al-Qura via Intl), events (one-off or yearly), month and year layouts on A4/Letter with 10 mm margins.

// ---------- calendar maths (same as the website) ----------
export function isLeap(y: number) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }
export function dim(y: number, m: number) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
/** Days from civil (1970-01-01 = 0). */
export function dfc(y: number, m: number, d: number) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400), yoe = y - era * 400, doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
export function cfd(z: number) {
  z += 719468;
  const era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153), m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d: doy - Math.floor((153 * mp + 2) / 5) + 1 };
}
export function wd(z: number) { return ((z % 7) + 11) % 7; } // 0 = Sunday
const iso = (y: number, m: number, d: number) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
/** The cells of a month grid, including the neighbouring months' days that fill the first and last week. */
export function monthCells(y: number, m: number, weekStart: number) {
  const first = dfc(y, m, 1), lead = (wd(first) - weekStart + 7) % 7, n = dim(y, m), rows = Math.ceil((lead + n) / 7), cells = [];
  for (let i = 0; i < rows * 7; i++) { const z = first - lead + i, o = cfd(z); cells.push({ z, y: o.y, m: o.m, d: o.d, inMonth: o.m === m }); }
  return { lead, rows, cells };
}
function asDate(z: number) { const o = cfd(z), d = new Date(0); d.setUTCFullYear(o.y, o.m - 1, o.d); return d; }
let HP: Intl.DateTimeFormat | null = null;
const HM: Record<string, Intl.DateTimeFormat> = {};
export function hijriParts(z: number) {
  try {
    HP = HP || new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric' });
    const p: Record<string, number> = {};
    HP.formatToParts(asDate(z)).forEach((x) => { if (/^(year|month|day)$/.test(x.type)) p[x.type] = parseInt(x.value, 10); });
    return p.year ? { y: p.year, m: p.month, d: p.day } : null;
  } catch { return null; }
}
export function hijriMonthName(z: number, locale = 'en') {
  try {
    HM[locale] = HM[locale] || new Intl.DateTimeFormat(locale + '-u-ca-islamic-umalqura', { timeZone: 'UTC', month: 'long' });
    return pdfSafe(HM[locale].format(asDate(z)));
  } catch { return ''; }
}

export const COLORS: Record<string, string> = { teal: '#0f9e99', blue: '#3e63dd', purple: '#8e4ec6', red: '#e5484d', orange: '#ef6c1a', yellow: '#c98a00', green: '#2f9e5d' };
export interface CalEvent { date: string; text: string; color: string; yearly: boolean }
export function cleanEvents(list: unknown): CalEvent[] {
  const out: CalEvent[] = [];
  (Array.isArray(list) ? list : []).slice(0, 1000).forEach((e) => {
    if (!e || typeof e !== 'object') return;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.date);
    if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > dim(+m[1], +m[2])) return;
    const text = typeof e.text === 'string' ? e.text.trim().slice(0, 60) : '';
    if (!text) return;
    out.push({ date: e.date, text, color: COLORS[e.color] ? e.color : 'teal', yearly: e.yearly === true });
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
export function eventsOn(evs: CalEvent[], y: number, m: number, d: number) {
  const full = iso(y, m, d), md = full.slice(5);
  return evs.filter((e) => e.date === full || (e.yearly && e.date.slice(5) === md && +e.date.slice(0, 4) <= y));
}

// ---------- names ----------
const EN = {
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], mini: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'], ah: 'AH',
};
type Names = typeof EN;
export function namesFor(locale: string): Names {
  if (!locale || /^en(-|$)/i.test(locale)) return EN;
  let fm: Intl.DateTimeFormat, fd: Intl.DateTimeFormat, fs: Intl.DateTimeFormat;
  try {
    fm = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    fd = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    fs = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  } catch { throw new ToolError(`Unknown locale "${locale}".`); }
  const cap = (s: string) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
  const n: Names = {
    months: EN.months.map((_, i) => cap(fm.format(new Date(Date.UTC(2026, i, 15))))),
    days: EN.days.map((_, i) => cap(fd.format(new Date(Date.UTC(2026, 1, 1 + i))))), // 2026-02-01 is a Sunday
    mini: EN.days.map((_, i) => Array.from(cap(fs.format(new Date(Date.UTC(2026, 1, 1 + i)))).replace(/\.$/, '')).slice(0, 2).join('')),
    ah: 'AH',
  };
  for (const s of [...n.months, ...n.days]) {
    for (const ch of pdfSafe(s)) if (!isWinAnsi(ch)) throw new ToolError(`Locale "${locale}" uses characters the built-in PDF fonts can't show ("${s}"). Only Latin-script locales are supported in PDF output for now.`);
  }
  return n;
}

// ---------- drawing ----------
const PAPER: Record<string, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4] }, MARGIN = 10;
interface St { y: number; m: number; weekStart: number; hijri: boolean; title: string; orient: 'landscape' | 'portrait'; locale: string; names: Names; events: CalEvent[] }

function hijriRange(st: St, zFrom: number, zTo: number) {
  const a = hijriParts(zFrom), b = hijriParts(zTo);
  if (!a || !b) return '';
  const na = hijriMonthName(zFrom, st.locale), nb = hijriMonthName(zTo, st.locale), suf = ' ' + st.names.ah;
  return (a.m === b.m && a.y === b.y ? na + ' ' + a.y : na + (a.y !== b.y ? ' ' + a.y : '') + ' – ' + nb + ' ' + b.y) + suf;
}
const order = (ws: number) => Array.from({ length: 7 }, (_, i) => (ws + i) % 7);

function drawMonth(g: Draw, W: number, H: number, st: St) {
  const q = W / 100, f = g.fonts, g6 = '#6b7280';
  let y = 0;
  if (st.title) { g.text(st.title, 0, y + 1.5 * q * 0.9, { size: 1.5 * q, font: f.bold, color: g6, maxW: W * 0.6 }); y += 1.5 * q * 1.25; }
  const base = y + 4.4 * q * 0.82;
  const mw = g.text(st.names.months[st.m - 1] + ' ', 0, base, { size: 4.4 * q, font: f.bold, color: '#0b6f6b' });
  g.text(String(st.y), mw, base, { size: 4.4 * q, font: f.bold, color: '#111827' });
  if (st.hijri) g.text(hijriRange(st, dfc(st.y, st.m, 1), dfc(st.y, st.m, dim(st.y, st.m))), W, base, { size: 1.5 * q, color: g6, align: 'right', maxW: W * 0.4 });
  y += 4.4 * q + 1.4 * q;
  const cw = W / 7, wkH = 1.35 * q * 1.25 + q;
  order(st.weekStart).forEach((d, c) => g.text(st.names.days[d].toUpperCase(), c * cw + 0.6 * q, y + 0.5 * q + 1.35 * q * 0.95, { size: 1.35 * q, font: f.bold, color: '#374151', maxW: cw - 1.2 * q }));
  y += wkH;
  g.rect(0, y, W, 0.53, { fill: '#111827' });
  y += 0.53;
  const grid = monthCells(st.y, st.m, st.weekStart), rh = (H - y) / grid.rows, line = { color: '#d1d5db', width: 0.26 };
  for (let c = 0; c <= 7; c++) g.line(c * cw, y, c * cw, H, line);
  for (let r = 1; r <= grid.rows; r++) g.line(0, y + r * rh, W, y + r * rh, line);
  grid.cells.forEach((c, i) => {
    const x = (i % 7) * cw, top = y + Math.floor(i / 7) * rh;
    g.text(String(c.d), x + 0.6 * q, top + 0.5 * q + 1.9 * q * 0.78, { size: 1.9 * q, font: c.inMonth ? f.bold : f.sans, color: c.inMonth ? '#111827' : '#c4c8cf' });
    if (!c.inMonth) return;
    if (st.hijri) {
      const hp = hijriParts(c.z);
      if (hp) g.text(hp.d === 1 || c.d === 1 ? hp.d + ' ' + hijriMonthName(c.z, st.locale) : String(hp.d), x + cw - 0.6 * q, top + 0.6 * q + 1.05 * q * 0.8, { size: 1.05 * q, color: '#9ca3af', align: 'right', maxW: cw * 0.7 });
    }
    let ey = top + 0.5 * q + 1.9 * q + 0.3 * q;
    const eh = 1.1 * q * 1.3 + 0.3 * q;
    for (const e of eventsOn(st.events, c.y, c.m, c.d)) {
      if (ey + eh > top + rh - 0.3 * q) break;
      const col = COLORS[e.color];
      g.roundRect(x + 0.6 * q, ey, cw - 1.2 * q, eh, 0.35 * q, { fill: mixHex('#ffffff', col, 0.14) });
      g.rect(x + 0.6 * q, ey, 0.3 * q, eh, { fill: col });
      g.text(e.text, x + 0.6 * q + 0.75 * q, ey + 0.15 * q + 1.1 * q * 0.98, { size: 1.1 * q, font: f.bold, color: '#111827', maxW: cw - 1.2 * q - 1.2 * q });
      ey += eh + 0.25 * q;
    }
  });
}

function drawYear(g: Draw, W: number, H: number, st: St) {
  const q = W / 100, f = g.fonts, g6 = '#6b7280', portrait = st.orient === 'portrait';
  let y = 0;
  if (st.title) { g.text(st.title, 0, y + 1.5 * q * 0.9, { size: 1.5 * q, font: f.bold, color: g6, maxW: W * 0.6 }); y += 1.5 * q * 1.25; }
  const base = y + 4 * q * 0.82;
  g.text(String(st.y), 0, base, { size: 4 * q, font: f.bold, color: '#0b6f6b' });
  if (st.hijri) g.text(hijriRange(st, dfc(st.y, 1, 1), dfc(st.y, 12, 31)), W, base, { size: 1.5 * q, color: g6, align: 'right', maxW: W * 0.5 });
  y += 4 * q + 1.4 * q;
  const S = portrait ? { name: 2.1, cell: 1.5, lh: 2.7, mw: 1.2, small: 1.15 } : { name: 1.6, cell: 1.15, lh: 2.05, mw: 0.95, small: 0.95 };
  const cols = portrait ? 3 : 4, rows = 12 / cols, colW = (W - (cols - 1) * 2.4 * q) / cols;
  const yearEvents = st.events.filter((e) => e.yearly || +e.date.slice(0, 4) === st.y).slice(0, 24);
  // legend size
  const legendItems = yearEvents.map((e) => ({ e, t: +e.date.slice(8) + ' ' + st.names.months[+e.date.slice(5, 7) - 1].slice(0, 3) + ' · ' + e.text }));
  const legendRows: typeof legendItems[] = [];
  let row: typeof legendItems = [], rw = 0;
  for (const it of legendItems) {
    const w = 1.4 * q + g.width(it.t, q) + 1.6 * q;
    if (row.length && rw + w > W) { legendRows.push(row); row = []; rw = 0; }
    row.push(it); rw += w;
  }
  if (row.length) legendRows.push(row);
  const legendH = legendRows.length ? 1.2 * q + 0.8 * q + legendRows.length * 1.4 * q : 0;
  const miniH = S.name * q * 1.3 + (st.hijri ? S.small * q * 1.2 : 0) + 0.4 * q + S.mw * q * 1.3 + 0.2 * q + 6 * (S.lh + 0.15) * q;
  const avail = H - y - legendH, gap = Math.max(1.6 * q, (avail - rows * miniH) / (rows + 1));
  let my = y + (avail - rows * miniH - (rows - 1) * gap) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const m = r * cols + c + 1, x = c * (colW + 2.4 * q);
      let yy = my;
      g.text(st.names.months[m - 1], x, yy + S.name * q * 0.95, { size: S.name * q, font: f.bold, color: '#0b6f6b', maxW: colW });
      yy += S.name * q * 1.3;
      if (st.hijri) { g.text(hijriRange(st, dfc(st.y, m, 1), dfc(st.y, m, dim(st.y, m))), x, yy + S.small * q * 0.85, { size: S.small * q, color: '#9ca3af', maxW: colW }); yy += S.small * q * 1.2; }
      yy += 0.4 * q;
      const dw = colW / 7;
      order(st.weekStart).forEach((d, k) => g.text(st.names.mini[d], x + k * dw + dw / 2, yy + S.mw * q, { size: S.mw * q, font: f.bold, color: g6, align: 'center' }));
      yy += S.mw * q * 1.3 + 0.2 * q;
      const grid = monthCells(st.y, m, st.weekStart);
      grid.cells.forEach((cell, i) => {
        if (!cell.inMonth) return;
        const cx = x + (i % 7) * dw + dw / 2, cy = yy + Math.floor(i / 7) * (S.lh + 0.15) * q + (S.lh * q) / 2;
        const evs = eventsOn(st.events, cell.y, cell.m, cell.d);
        if (evs.length) {
          const rr = Math.min(dw, S.lh * q) / 2;
          g.path(`M${cx - rr} ${cy}a${rr} ${rr} 0 1 0 ${2 * rr} 0a${rr} ${rr} 0 1 0 ${-2 * rr} 0z`, { fill: COLORS[evs[0].color] });
        }
        g.text(String(cell.d), cx, cy + S.cell * q * 0.36, { size: S.cell * q, font: evs.length ? f.bold : f.sans, color: evs.length ? '#ffffff' : '#111827', align: 'center' });
      });
    }
    my += miniH + gap;
  }
  if (legendRows.length) {
    let ly = H - legendH + 1.2 * q;
    g.line(0, ly, W, ly, { color: '#e5e7eb', width: 0.26 });
    ly += 0.8 * q;
    for (const lr of legendRows) {
      let lx = 0;
      for (const it of lr) {
        const r = 0.45 * q;
        g.path(`M${lx} ${ly + 0.7 * q}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`, { fill: COLORS[it.e.color] });
        const w = g.text(it.t, lx + 1.4 * q, ly + 1.05 * q, { size: q, color: '#374151' });
        lx += 1.4 * q + w + 1.6 * q;
      }
      ly += 1.4 * q;
    }
  }
}

export default defineTool({
  name: 'doc_calendar',
  title: 'Calendar PDF',
  webSlug: 'calendar-maker',
  description:
    'Make a printable calendar PDF: a month grid (one page per month, several months in a row if you like) or a whole year ' +
    'on one page, A4 or Letter, landscape or portrait. Week starts on Saturday (default, like the website), Sunday or ' +
    'Monday; optional Hijri (Umm al-Qura) dates; events (one-off or yearly, 7 colours) shown in the day cells, or as ' +
    'coloured days plus a legend in the year view; optional title. English names by default; other Latin-script locales ' +
    `(fr, de, es, tr…) use their own month/day names. Web version: ${webUrl('calendar-maker')}`,
  inputSchema: z.object({
    view: z.enum(['month', 'year']).optional().default('month').describe('month = month grid pages, year = 12 months on one page.'),
    year: z.number().int().min(1900).max(2100).optional().describe('Year (default: this year).'),
    month: z.number().int().min(1).max(12).optional().describe('Month 1-12 (month view; default: this month).'),
    months: z.number().int().min(1).max(24).optional().default(1).describe('Month view: how many consecutive months (one page each).'),
    weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]).optional().default(6).describe('First day of the week: 6 = Saturday (default), 0 = Sunday, 1 = Monday.'),
    hijri: z.boolean().optional().default(false).describe('Show Hijri (Umm al-Qura) dates.'),
    paper: z.enum(['A4', 'Letter']).optional().default('A4'),
    orientation: z.enum(['landscape', 'portrait']).optional().default('landscape'),
    title: z.string().max(60).optional().default('').describe('Optional title above the month name, e.g. "Family calendar".'),
    locale: z.string().max(20).optional().default('en').describe('Language for month/day names (default en). Latin-script locales only.'),
    events: z.array(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
      text: z.string().max(60).describe('What it is.'),
      color: z.enum(['teal', 'blue', 'purple', 'red', 'orange', 'yellow', 'green']).optional().default('teal'),
      yearly: z.boolean().optional().default(false).describe('Repeats every year from that date on (birthdays, holidays).'),
    })).max(1000).optional().default([]).describe('Events to show.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...pdfOutputShape, from: z.string(), to: z.string().describe('Last month covered, YYYY-MM.') }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { year: 2026, month: 12, title: 'Family calendar', hijri: true, events: [{ date: '2026-12-03', text: "Sara's birthday", color: 'purple', yearly: true }] } },
    { input: { view: 'year', year: 2027, weekStart: 1, orientation: 'portrait' } },
  ],
  async run(input, ctx) {
    const now = new Date();
    const names = namesFor(input.locale);
    const events = cleanEvents(input.events.map((e, i) => ({ ...e, text: userText(e.text, `events[${i}].text`) })));
    const st: St = {
      y: input.year ?? now.getFullYear(), m: input.month ?? now.getMonth() + 1, weekStart: input.weekStart, hijri: input.hijri,
      title: userText(input.title, 'title'), orient: input.orientation, locale: input.locale, names, events,
    };
    let [PW, PH] = PAPER[input.paper];
    if (input.orientation === 'landscape') [PW, PH] = [PH, PW];
    const W = PW - 2 * MARGIN, H = PH - 2 * MARGIN;
    const { doc, fonts } = await newDoc(input.view === 'year' ? `Calendar ${st.y}` : `Calendar ${iso(st.y, st.m, 1).slice(0, 7)}`, ctx);
    const from = iso(st.y, st.m, 1).slice(0, 7);
    let last = from;
    if (input.view === 'year') {
      drawYear(new Draw(doc.addPage([PW * MM, PH * MM]), fonts, MM).sub(MARGIN, MARGIN), W, H, st);
      last = st.y + '-12';
    } else {
      for (let k = 0; k < input.months; k++) {
        const t = st.y * 12 + st.m - 1 + k, yy = Math.floor(t / 12), mm = (t % 12) + 1;
        if (yy > 2100) break;
        drawMonth(new Draw(doc.addPage([PW * MM, PH * MM]), fonts, MM).sub(MARGIN, MARGIN), W, H, { ...st, y: yy, m: mm });
        last = iso(yy, mm, 1).slice(0, 7);
      }
    }
    const name = input.view === 'year' ? `calendar-${st.y}.pdf` : `calendar-${from}${input.months > 1 ? '-to-' + last : ''}.pdf`;
    const out = await savePdf(doc, { output: input.output, defaultName: name, base64: input.returnBase64 }, ctx);
    return { ...out, mimeType: 'application/pdf', from: input.view === 'year' ? st.y + '-01' : from, to: last };
  },
});

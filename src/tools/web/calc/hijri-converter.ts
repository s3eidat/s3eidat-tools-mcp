import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';
import { cfd, dfc, DAYS, fromHijri, hdim, hPrev, iso, parseOr, toHijri, wd } from './_cal.js';

// Ported from https://github.com/s3eidat/hijri-converter (app.js): Umm al-Qura via Intl, day numbers avoid time-zone drift.
// Arabic names copied programmatically from the website's app.js as \u escapes.
export const H_EN = ['Muharram', 'Safar', 'Rabi al-Awwal', 'Rabi al-Thani', 'Jumada al-Ula', 'Jumada al-Akhirah', 'Rajab', "Sha'ban", 'Ramadan', 'Shawwal', "Dhu al-Qa'dah", 'Dhu al-Hijjah'];
export const H_AR = ["\u0645\u062d\u0631\u0645","\u0635\u0641\u0631","\u0631\u0628\u064a\u0639 \u0627\u0644\u0623\u0648\u0644","\u0631\u0628\u064a\u0639 \u0627\u0644\u0622\u062e\u0631","\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0623\u0648\u0644\u0649","\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0622\u062e\u0631\u0629","\u0631\u062c\u0628","\u0634\u0639\u0628\u0627\u0646","\u0631\u0645\u0636\u0627\u0646","\u0634\u0648\u0627\u0644","\u0630\u0648 \u0627\u0644\u0642\u0639\u062f\u0629","\u0630\u0648 \u0627\u0644\u062d\u062c\u0629"];
export const W_AR = ["\u0627\u0644\u0623\u062d\u062f","\u0627\u0644\u0627\u062b\u0646\u064a\u0646","\u0627\u0644\u062b\u0644\u0627\u062b\u0627\u0621","\u0627\u0644\u0623\u0631\u0628\u0639\u0627\u0621","\u0627\u0644\u062e\u0645\u064a\u0633","\u0627\u0644\u062c\u0645\u0639\u0629","\u0627\u0644\u0633\u0628\u062a"];
export const G_AR: Record<'intl' | 'levant', string[]> = {"intl":["\u064a\u0646\u0627\u064a\u0631","\u0641\u0628\u0631\u0627\u064a\u0631","\u0645\u0627\u0631\u0633","\u0623\u0628\u0631\u064a\u0644","\u0645\u0627\u064a\u0648","\u064a\u0648\u0646\u064a\u0648","\u064a\u0648\u0644\u064a\u0648","\u0623\u063a\u0633\u0637\u0633","\u0633\u0628\u062a\u0645\u0628\u0631","\u0623\u0643\u062a\u0648\u0628\u0631","\u0646\u0648\u0641\u0645\u0628\u0631","\u062f\u064a\u0633\u0645\u0628\u0631"],"levant":["\u0643\u0627\u0646\u0648\u0646 \u0627\u0644\u062b\u0627\u0646\u064a","\u0634\u0628\u0627\u0637","\u0622\u0630\u0627\u0631","\u0646\u064a\u0633\u0627\u0646","\u0623\u064a\u0627\u0631","\u062d\u0632\u064a\u0631\u0627\u0646","\u062a\u0645\u0648\u0632","\u0622\u0628","\u0623\u064a\u0644\u0648\u0644","\u062a\u0634\u0631\u064a\u0646 \u0627\u0644\u0623\u0648\u0644","\u062a\u0634\u0631\u064a\u0646 \u0627\u0644\u062b\u0627\u0646\u064a","\u0643\u0627\u0646\u0648\u0646 \u0627\u0644\u0623\u0648\u0644"]};
const G_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AH_AR = ' \u0647\u0640', AD_AR = ' \u0645';
export const H_MIN = 1300, H_MAX = 1600;

/** Age as of day zt for a birth on day zb, counted in Hijri years / months / days, plus the next Hijri birthday. */
export function hijriAge(zb: number, zt: number) {
  const b = toHijri(zb), t = toHijri(zt);
  let y = t.y - b.y, m = t.m - b.m, d = t.d - b.d;
  if (d < 0) { m--; const p = hPrev(t.y, t.m); d += hdim(p.y, p.m); }
  if (m < 0) { y--; m += 12; }
  // next Hijri birthday on or after zt (a 30th falls back to the 29th in a short month)
  let ny = t.y, nz: number | null = null;
  for (let i = 0; i < 2; i++, ny++) {
    nz = fromHijri(ny, b.m, Math.min(b.d, hdim(ny, b.m)));
    if (nz != null && nz >= zt) break;
  }
  return { y, m, d, days: zt - zb, next: nz };
}

interface Fmt { arabicDigits: boolean; gm: 'intl' | 'levant' }
const A = (n: number, f: Fmt) => (f.arabicDigits ? String(n).replace(/\d/g, (c) => String.fromCharCode(0x660 + +c)) : String(n));
const hEn = (z: number) => { const h = toHijri(z); return h.d + ' ' + H_EN[h.m - 1] + ' ' + h.y + ' AH'; };
const hAr = (z: number, f: Fmt) => { const h = toHijri(z); return A(h.d, f) + ' ' + H_AR[h.m - 1] + ' ' + A(h.y, f) + AH_AR; };
const gEn = (z: number) => { const g = cfd(z); return g.d + ' ' + G_EN[g.m - 1] + ' ' + g.y; };
const gAr = (z: number, f: Fmt) => { const g = cfd(z); return A(g.d, f) + ' ' + G_AR[f.gm][g.m - 1] + ' ' + A(g.y, f) + AD_AR; };
const inRange = (z: number) => { const h = toHijri(z); return h.y >= H_MIN && h.y <= H_MAX; };

function describe(z: number, f: Fmt) {
  const h = toHijri(z), w = wd(z);
  return {
    gregorian: { date: iso(cfd(z)), weekday: DAYS[w], text: DAYS[w] + ', ' + gEn(z), arabic: W_AR[w] + ' ' + gAr(z, f) },
    hijri: { year: h.y, month: h.m, day: h.d, monthName: H_EN[h.m - 1], monthNameArabic: H_AR[h.m - 1],
      iso: h.y + '-' + String(h.m).padStart(2, '0') + '-' + String(h.d).padStart(2, '0'), text: DAYS[w] + ', ' + hEn(z), arabic: W_AR[w] + ' ' + hAr(z, f) },
    approximate: !inRange(z),
  };
}

const dayInfo = z.object({
  gregorian: z.object({ date: z.string(), weekday: z.string(), text: z.string(), arabic: z.string() }),
  hijri: z.object({ year: z.number(), month: z.number(), day: z.number(), monthName: z.string(), monthNameArabic: z.string(), iso: z.string(), text: z.string(), arabic: z.string() }),
  approximate: z.boolean(),
});

export default defineTool({
  name: 'calc_hijri',
  title: 'Hijri ⇄ Gregorian converter',
  webSlug: 'hijri-converter',
  description:
    'Convert between Gregorian and Hijri dates with the Umm al-Qura calendar (the same Intl calendar the website uses), both ' +
    'ways. Modes: to_hijri (a Gregorian date), to_gregorian (Hijri year, month 1–12, day), month (length of a Hijri month and ' +
    'its Gregorian start/end), age (age in Hijri and Gregorian years, next Hijri birthday). Results come in English and ' +
    'Arabic (Arabic-Indic digits by default; Gregorian month names in the Egyptian/Gulf or Levant style). Supported range ' +
    `1300–1600 AH (1882–2174). Web version: ${webUrl('hijri-converter')}`,
  inputSchema: z.object({
    mode: z.enum(['to_hijri', 'to_gregorian', 'month', 'age']).describe('Which conversion.'),
    date: z.string().optional().describe('to_hijri: Gregorian date YYYY-MM-DD (default today).'),
    hijriYear: z.number().int().optional().describe('to_gregorian / month: Hijri year (1300–1600).'),
    hijriMonth: z.number().int().min(1).max(12).optional().describe('to_gregorian / month: Hijri month 1–12 (1 = Muharram, 9 = Ramadan).'),
    hijriDay: z.number().int().optional().describe('to_gregorian: Hijri day 1–30.'),
    birthDate: z.string().optional().describe('age: Gregorian date of birth YYYY-MM-DD.'),
    onDate: z.string().optional().describe('age: age on this Gregorian date (default today).'),
    arabicDigits: z.boolean().optional().default(true).describe('Use Arabic-Indic digits in the Arabic text.'),
    gregorianArabicMonths: z.enum(['intl', 'levant']).optional().default('intl').describe('Arabic Gregorian month names: intl (Egypt/Gulf style, January = Yanayir) or levant (Syria/Jordan style, January = Kanun al-Thani).'),
  }),
  outputSchema: z.object({
    mode: z.string(),
    day: dayInfo.optional(),
    month: z.object({ year: z.number(), month: z.number(), name: z.string(), nameArabic: z.string(), days: z.number(), start: z.string(), end: z.string() }).optional(),
    age: z.object({ hijriYears: z.number(), hijriMonths: z.number(), hijriDays: z.number(), gregorianYears: z.number(), daysLived: z.number(),
      bornHijri: z.string(), nextHijriBirthday: z.object({ gregorian: z.string(), hijri: z.string(), inDays: z.number() }).nullable() }).optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { mode: 'to_hijri', date: '2000-01-01' }, note: '24 Ramadan 1420 AH (Saturday)' },
    { input: { mode: 'to_gregorian', hijriYear: 1447, hijriMonth: 9, hijriDay: 1 }, note: '2026-02-18 (Wednesday)' },
  ],
  run(input) {
    const f: Fmt = { arabicDigits: input.arabicDigits, gm: input.gregorianArabicMonths };
    const line = (z: number) => DAYS[wd(z)] + ', ' + gEn(z) + ' = ' + hEn(z) + ' · ' + W_AR[wd(z)] + ' ' + hAr(z, f);
    const hy = input.hijriYear, hm = input.hijriMonth;
    const checkYear = () => {
      if (hy === undefined || hm === undefined) throw new ToolError('Give hijriYear and hijriMonth.');
      if (!(hy >= H_MIN && hy <= H_MAX)) throw new ToolError('Year must be 1300–1600 AH.');
    };
    if (input.mode === 'to_hijri') {
      const z = dfc(parseOr(input.date, 'date'));
      if (z < dfc({ y: 1882, m: 11, d: 12 }) || z > dfc({ y: 2174, m: 11, d: 25 })) throw new ToolError('Supported Gregorian dates: 1882-11-12 to 2174-11-25 (1300–1600 AH).');
      return { mode: input.mode, day: describe(z, f), summary: line(z) };
    }
    if (input.mode === 'to_gregorian') {
      checkYear();
      const d = input.hijriDay;
      if (d === undefined || !(d >= 1 && d <= 30)) throw new ToolError('Day must be 1–30.');
      const n = hdim(hy!, hm!);
      if (d > n) throw new ToolError(H_EN[hm! - 1] + ' ' + hy + ' has ' + n + ' days.');
      const z = fromHijri(hy!, hm!, d)!;
      return { mode: input.mode, day: describe(z, f), summary: line(z) };
    }
    if (input.mode === 'month') {
      checkYear();
      const s = fromHijri(hy!, hm!, 1)!, n = hdim(hy!, hm!);
      return { mode: input.mode, month: { year: hy!, month: hm!, name: H_EN[hm! - 1], nameArabic: H_AR[hm! - 1], days: n, start: iso(cfd(s)), end: iso(cfd(s + n - 1)) },
        summary: H_EN[hm! - 1] + ' ' + hy + ' AH has ' + n + ' days: ' + gEn(s) + ' – ' + gEn(s + n - 1) + '.' };
    }
    if (!input.birthDate) throw new ToolError('Give birthDate for mode "age".');
    const zb = dfc(parseOr(input.birthDate, 'birthDate')), zt = dfc(parseOr(input.onDate, 'onDate'));
    if (zb > zt) throw new ToolError('That date is in the future.');
    if (!inRange(zb)) throw new ToolError('Supported from 1882 (1300 AH).');
    const a = hijriAge(zb, zt), g = cfd(zb), t = cfd(zt);
    const gy = t.y - g.y - (t.m < g.m || (t.m === g.m && t.d < g.d) ? 1 : 0);
    const next = a.next != null ? { gregorian: iso(cfd(a.next)), hijri: hEn(a.next), inDays: a.next - zt } : null;
    return {
      mode: 'age',
      age: { hijriYears: a.y, hijriMonths: a.m, hijriDays: a.d, gregorianYears: gy, daysLived: a.days, bornHijri: hEn(zb), nextHijriBirthday: next },
      summary: 'Hijri age ' + a.y + ' years, ' + a.m + ' months, ' + a.d + ' days (Gregorian ' + gy + '). Born ' + hEn(zb) + ' (' + DAYS[wd(zb)] + '). Next Hijri birthday: ' +
        (a.next != null ? gEn(a.next) + ', ' + hEn(a.next) + (a.next === zt ? ' (today!)' : ' (in ' + (a.next - zt) + ' days)') : '—') + '.',
    };
  },
});

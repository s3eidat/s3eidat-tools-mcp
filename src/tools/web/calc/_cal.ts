/**
 * Calendar maths shared by the date calculators (age-calc, date-diff, hijri-converter, due-date): pure calendar-day
 * arithmetic on day numbers (days since 1970-01-01, H. Hinnant's algorithms), so time zones and DST never shift a day,
 * and Umm al-Qura Hijri dates through Intl, exactly like the website. Not a tool (leading underscore).
 */
import { ToolError } from '../../../registry.js';

export interface YMD { y: number; m: number; d: number }

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function isLeap(y: number) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }
export function dim(y: number, m: number) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }

/** Days since 1970-01-01 (days_from_civil). */
export function dfc(o: YMD) {
  const y = o.y - (o.m <= 2 ? 1 : 0), era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (o.m + (o.m > 2 ? -3 : 9)) + 2) / 5) + o.d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
/** Civil date from a day number (civil_from_days). */
export function cfd(z: number): YMD {
  z += 719468;
  const era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d: doy - Math.floor((153 * mp + 2) / 5) + 1 };
}
/** Weekday of a day number, 0 = Sunday. */
export function wd(z: number) { return ((z % 7) + 11) % 7; }
export function weekday(o: YMD) { return DAYS[wd(dfc(o))]; }

/** Add months; the day clamps to the end of a shorter month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(o: YMD, k: number): YMD {
  const t = o.y * 12 + o.m - 1 + k, y = Math.floor(t / 12), m = t - y * 12 + 1;
  return { y, m, d: Math.min(o.d, dim(y, m)) };
}
/** Whole years, months, days from a to b (a <= b). */
export function diff(a: YMD, b: YMD) {
  let months = (b.y - a.y) * 12 + (b.m - a.m), anchor = addMonths(a, months);
  if (dfc(anchor) > dfc(b)) { months--; anchor = addMonths(a, months); }
  return { y: Math.floor(months / 12), m: months % 12, d: dfc(b) - dfc(anchor), months, days: dfc(b) - dfc(a) };
}

export function parse(v: string | undefined | null): YMD | null {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(v || '');
  if (!m) return null;
  const o = { y: +m[1], m: +m[2], d: +m[3] };
  return o.y >= 1 && o.m >= 1 && o.m <= 12 && o.d >= 1 && o.d <= dim(o.y, o.m) ? o : null;
}
/** Parse an ISO date input or throw a clear error; undefined gives today (local). */
export function parseOr(v: string | undefined, field: string): YMD {
  if (v === undefined || v === '' || v === 'today') return todayLocal();
  const o = parse(v.trim());
  if (!o) throw new ToolError(`"${field}" must be a real date as YYYY-MM-DD (got ${JSON.stringify(v)}).`);
  return o;
}
export function iso(o: YMD) { return String(o.y).padStart(4, '0') + '-' + String(o.m).padStart(2, '0') + '-' + String(o.d).padStart(2, '0'); }
export function todayLocal(): YMD { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }; }
export function asDate(o: YMD) { const d = new Date(0); d.setUTCFullYear(o.y, o.m - 1, o.d); return d; }
/** "15 May 1994" (or with weekday: "Sunday, 15 May 1994"). */
export function nice(o: YMD, withWeekday = false, shortMonth = false) {
  return Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: withWeekday ? 'long' : undefined, day: 'numeric', month: shortMonth ? 'short' : 'long', year: 'numeric' }).format(asDate(o));
}
/** Long Umm al-Qura date via Intl, e.g. "Ramadan 24, 1420 AH" (en) or the Arabic form (ar-SA). */
export function hijriText(o: YMD, locale = 'en') {
  try { return Intl.DateTimeFormat(locale + '-u-ca-islamic-umalqura', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(asDate(o)); }
  catch { return ''; }
}

let HP: Intl.DateTimeFormat | null = null;
const CACHE = new Map<number, YMD>();
/** Umm al-Qura {y, m, d} for a day number. */
export function toHijri(z: number): YMD {
  const hit = CACHE.get(z);
  if (hit) return hit;
  HP = HP || new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
  const p: Record<string, number> = {};
  HP.formatToParts(asDate(cfd(z))).forEach((x) => { if (/^(year|month|day)$/.test(x.type)) p[x.type] = parseInt(x.value, 10); });
  const h = { y: p.year, m: p.month, d: p.day };
  if (CACHE.size > 20000) CACHE.clear();
  CACHE.set(z, h);
  return h;
}
export function hijriParts(o: YMD): YMD | null { try { const h = toHijri(dfc(o)); return h.y ? h : null; } catch { return null; } }

/** Hijri → Gregorian day number: estimate from the mean month, then search nearby days for the exact Umm al-Qura match. */
export function fromHijri(hy: number, hm: number, hd: number): number | null {
  const est = Math.round(dfc({ y: 622, m: 7, d: 19 }) + (hy - 1) * 354.36707 + (hm - 1) * 29.530589 + hd - 1);
  for (let k = 0; k <= 45; k++) {
    for (let s = -1; s <= 1; s += 2) {
      const h = toHijri(est + k * s);
      if (h.y === hy && h.m === hm && h.d === hd) return est + k * s;
      if (!k) break;
    }
  }
  return null;
}
export const hNext = (hy: number, hm: number) => (hm === 12 ? { y: hy + 1, m: 1 } : { y: hy, m: hm + 1 });
export const hPrev = (hy: number, hm: number) => (hm === 1 ? { y: hy - 1, m: 12 } : { y: hy, m: hm - 1 });
/** Days in a Hijri month (29 or 30), from the Umm al-Qura month starts. */
export function hdim(hy: number, hm: number) { const n = hNext(hy, hm); return fromHijri(n.y, n.m, 1)! - fromHijri(hy, hm, 1)!; }

export function plural(n: number, w: string) { return n.toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's'); }
/** "1 year, 2 months, 3 days" (zero parts left out). */
export function ymd(a: { y: number; m: number; d: number }) {
  return [a.y && plural(a.y, 'year'), a.m && plural(a.m, 'month'), (a.d || (!a.y && !a.m)) && plural(a.d, 'day')].filter(Boolean).join(', ');
}

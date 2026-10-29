// Timezone helpers shared by time_convert and cron_explain. Ported from https://github.com/s3eidat/timestamp-convert
// (app.js): Intl's tz database only, nothing remote.
import { ToolError } from '../../../registry.js';

export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const dtfCache: Record<string, Intl.DateTimeFormat> = {};
function dtf(tz: string) {
  return (dtfCache[tz] ??= new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short',
  }));
}

/** Throws a ToolError for an unknown IANA zone; returns the canonical spelling. */
export function checkTz(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new ToolError(`Unknown timezone "${tz}". Use an IANA name like "Europe/London", "Asia/Amman" or "UTC".`);
  }
}

/** Wall-clock parts of instant `ms` in `tz`. */
export function parts(ms: number, tz: string): WallParts {
  const o: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  let y = +o.year;
  if (/^B/.test(o.era)) y = 1 - y;
  return { y, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
export function utcOf(y: number, mo: number, d: number, h: number, mi: number, s: number) {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, 0);
  return t.getTime();
}
/** Offset of tz from UTC at instant ms, in ms (e.g. +3h → 10800000). */
export function tzOffset(ms: number, tz: string) {
  const p = parts(ms, tz), base = Math.floor(ms / 1000) * 1000;
  return utcOf(p.y, p.mo, p.d, p.h, p.mi, p.s) - base;
}
/** Wall-clock time in tz → epoch ms. Two passes settle DST edges. */
export function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string) {
  const guess = utcOf(y, mo, d, h, mi, s), t = guess - tzOffset(guess, tz), off2 = tzOffset(t, tz);
  return guess - off2;
}
export function fmtOffset(off: number) {
  let m = Math.round(off / 60000);
  const sign = m < 0 ? '−' : '+';
  m = Math.abs(m);
  return 'UTC' + sign + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** ISO 8601 with the zone's offset, e.g. 2026-10-26T12:30:00+03:00 (Z for the UTC zone). */
export function isoInZone(ms: number, tz: string) {
  const p = parts(ms, tz), off = Math.round(tzOffset(ms, tz) / 60000), a = Math.abs(off);
  const year = p.y >= 0 && p.y <= 9999 ? pad(p.y, 4) : (p.y < 0 ? '-' : '+') + pad(Math.abs(p.y), 6);
  const frac = ((ms % 1000) + 1000) % 1000;
  return `${year}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${frac ? '.' + pad(Math.floor(frac), 3) : ''}` +
    (off === 0 && tz === 'UTC' ? 'Z' : (off < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60));
}

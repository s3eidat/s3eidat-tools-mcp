/** Time-zone helpers shared by prayer_times and time_world_clock: all zone maths uses Node's own Intl data, like the website. */
import { ToolError } from '../../../registry.js';

export function validZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export function checkZone(tz: string) {
  if (!validZone(tz)) throw new ToolError(`Unknown time zone "${tz}". Use an IANA name like "Europe/London" or "Asia/Amman".`);
}

const ymdFmt = new Map<string, Intl.DateTimeFormat>();
/** Calendar date of an instant in a zone (website `ymdIn`). */
export function ymdIn(tz: string, date: Date) {
  let f = ymdFmt.get(tz);
  if (!f) ymdFmt.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })));
  const o: Record<string, number> = {};
  f.formatToParts(date).forEach((p) => { o[p.type] = +p.value; });
  return { y: o.year, m: o.month, d: o.day };
}

export interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string }
const partsFmt = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of an instant in a zone (world-clock `parts`). */
export function parts(tz: string, date: Date): Parts {
  let f = partsFmt.get(tz);
  if (!f) {
    partsFmt.set(tz, (f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    })));
  }
  const o: Record<string, string | number> = {};
  f.formatToParts(date).forEach((p) => { if (p.type !== 'literal') o[p.type] = p.type === 'weekday' ? p.value : +p.value; });
  o.hour = (o.hour as number) % 24;
  return o as unknown as Parts;
}
/** UTC offset of a zone at an instant, in minutes (world-clock `offsetMin`). */
export function offsetMin(tz: string, date: Date) {
  const p = parts(tz, date), t = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t) / 60000);
}
/** The instant of local midnight starting y-m-d in a zone. */
export function zoneMidnight(tz: string, y: number, m: number, d: number) {
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - offsetMin(tz, new Date(wall)) * 60000;
  t = wall - offsetMin(tz, new Date(t)) * 60000;
  return t;
}

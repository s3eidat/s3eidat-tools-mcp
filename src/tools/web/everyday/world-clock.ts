import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { offsetMin, parts, validZone, ymdIn, zoneMidnight, type Parts } from './_time.js';

// Ported from https://github.com/s3eidat/world-clock (app.js): same zone search (IANA ids + city aliases), offset and
// difference formatting, day/work/awake/night bands and the 24-hour meeting-planner overlap.
const FALLBACK = ['UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Istanbul', 'Europe/Moscow', 'Asia/Amman', 'Asia/Riyadh', 'Asia/Dubai',
  'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
  'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Mexico_City'];
// Well-known cities whose name is not in the IANA zone id.
const ALIAS: Record<string, string> = {
  Mecca: 'Asia/Riyadh', Makkah: 'Asia/Riyadh', Medina: 'Asia/Riyadh', Jeddah: 'Asia/Riyadh', 'Abu Dhabi': 'Asia/Dubai', Doha: 'Asia/Qatar',
  'San Francisco': 'America/Los_Angeles', Seattle: 'America/Los_Angeles', 'Washington DC': 'America/New_York', Boston: 'America/New_York', Miami: 'America/New_York',
  Houston: 'America/Chicago', Dallas: 'America/Chicago', Montreal: 'America/Toronto', Delhi: 'Asia/Kolkata', Mumbai: 'Asia/Kolkata', Bangalore: 'Asia/Kolkata',
  Beijing: 'Asia/Shanghai', Shenzhen: 'Asia/Shanghai', Osaka: 'Asia/Tokyo', Irbid: 'Asia/Amman', Aqaba: 'Asia/Amman', Alexandria: 'Africa/Cairo',
  Ankara: 'Europe/Istanbul', Milan: 'Europe/Rome', Barcelona: 'Europe/Madrid', Munich: 'Europe/Berlin', Manchester: 'Europe/London', Edinburgh: 'Europe/London',
  Melbourne: 'Australia/Melbourne', Gaza: 'Asia/Gaza', Jerusalem: 'Asia/Jerusalem', Ramallah: 'Asia/Hebron', 'Kuwait City': 'Asia/Kuwait', Manama: 'Asia/Bahrain',
  Muscat: 'Asia/Muscat', Sanaa: 'Asia/Aden', Tunis: 'Africa/Tunis', Algiers: 'Africa/Algiers', Casablanca: 'Africa/Casablanca', Khartoum: 'Africa/Khartoum',
};
const MINUS = '−';

export function fmtOffset(min: number) {
  const s = min < 0 ? MINUS : '+', a = Math.abs(min);
  return 'UTC' + (min === 0 ? '' : s + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''));
}
export function fmtDiff(min: number) {
  if (min === 0) return 'same time';
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  return (min > 0 ? '+' : MINUS) + (h ? h + 'h' : '') + (m ? (h ? ' ' : '') + m + 'm' : '');
}
/** Hour as a fraction (9.5 = 09:30) → working / awake / night. */
export function kind(hf: number) { return hf >= 9 && hf < 17 ? 'work' : hf >= 7 && hf < 22 ? 'awake' : 'night'; }
/** Which of the 24 hourly moments starting at startMs fall inside working hours in every zone? */
export function workingOverlap(list: string[], startMs: number) {
  const out: number[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(startMs + i * 3600000);
    if (list.every((tz) => { const p = parts(tz, d); return kind(p.hour + p.minute / 60) === 'work'; })) out.push(i);
  }
  return out;
}
export function label(tz: string) {
  if (tz === 'UTC') return { city: 'UTC', region: 'Coordinated Universal Time' };
  const bits = tz.split('/');
  return { city: bits[bits.length - 1].replace(/_/g, ' '), region: bits.slice(0, -1).join(' / ').replace(/_/g, ' ') };
}
function timeStr(p: Parts, h12: boolean, withSec = true) {
  let h = p.hour, suf = '';
  if (h12) { suf = h < 12 ? ' AM' : ' PM'; h = h % 12 || 12; }
  return (h12 ? String(h) : String(h).padStart(2, '0')) + ':' + String(p.minute).padStart(2, '0') + (withSec ? ':' + String(p.second).padStart(2, '0') : '') + suf;
}
function shortHour(p: Parts, h12: boolean) {
  if (!h12) return String(p.hour) + (p.minute ? ':' + String(p.minute).padStart(2, '0') : '');
  const h = p.hour % 12 || 12;
  return h + (p.minute ? ':' + String(p.minute).padStart(2, '0') : '') + (p.hour < 12 ? 'a' : 'p');
}

let options: { text: string; tz: string }[] | undefined;
function getOptions() {
  if (options) return options;
  const zones = ((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? FALLBACK).slice();
  if (zones.indexOf('UTC') < 0) zones.unshift('UTC');
  const o: { text: string; tz: string }[] = [];
  zones.forEach((tz) => o.push({ text: label(tz).city + ' (' + tz + ')', tz }));
  Object.keys(ALIAS).forEach((c) => { if (validZone(ALIAS[c])) o.push({ text: c + ' (' + ALIAS[c] + ')', tz: ALIAS[c] }); });
  o.sort((a, b) => a.text.localeCompare(b.text));
  return (options = o);
}
/** Website search: exact zone id / "City (Zone)" / city name, else the first partial match. Any valid IANA id is also accepted as is. */
export function resolve(q: string): string | null {
  const raw = q.trim();
  if (!raw) return null;
  if (raw.includes('/') && validZone(raw)) {
    const hit = getOptions().find((o) => o.tz.toLowerCase() === raw.toLowerCase());
    return hit ? hit.tz : raw;
  }
  q = raw.toLowerCase();
  const m = /\(([^)]+)\)$/.exec(q);
  if (m) q = m[1];
  const opts = getOptions();
  const exact = opts.find((o) => o.tz.toLowerCase() === q || o.text.toLowerCase() === q || o.text.toLowerCase().split(' (')[0] === q);
  if (exact) return exact.tz;
  const part = opts.filter((o) => o.text.toLowerCase().indexOf(q) >= 0);
  if (part.length) return part[0].tz;
  return validZone(raw) ? raw : null;
}

export default defineTool({
  name: 'time_world_clock',
  title: 'World clock & meeting planner',
  webSlug: 'world-clock',
  description:
    'Current (or any given) time in a list of time zones or cities: local time, date, weekday, UTC offset, difference ' +
    'from a home zone, day/night and working-hours flags. Plus the website\'s meeting planner: the 24 hours of a day in ' +
    'the home zone, each zone\'s local hour and band (work 9–17, awake 7–22, night), and the hours when everyone is in ' +
    'working hours. Zones: IANA ids ("Asia/Tokyo") or city names ("Mecca", "New York", "Tokyo"). Uses Node\'s ICU ' +
    `time-zone data; no network. Web version: ${webUrl('world-clock')}`,
  inputSchema: z.object({
    zones: z.array(z.string()).min(1).max(50).describe('Time zones or cities, e.g. ["Asia/Amman", "London", "New York"]. The first is the home zone unless homeZone is set.'),
    homeZone: z.string().optional().describe('Zone the differences and the planner day are measured from. Default: the first of zones.'),
    at: z.string().optional().describe('The instant to show (ISO 8601, e.g. "2026-01-15T12:00:00Z"). Default: now.'),
    hour12: z.boolean().optional().default(false).describe('12-hour clock (AM/PM) instead of 24-hour.'),
    planner: z.boolean().optional().default(true).describe('Include the 24-hour meeting planner.'),
    plannerDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Planner day (YYYY-MM-DD in the home zone). Default: the date of "at" there.'),
  }),
  outputSchema: z.object({
    at: z.string(), homeZone: z.string(),
    clocks: z.array(z.object({
      zone: z.string(), city: z.string(), region: z.string(), time: z.string(), date: z.string(), weekday: z.string(),
      offset: z.string(), offsetMinutes: z.number(), diff: z.string(), isDay: z.boolean(), band: z.string(), workingHours: z.boolean(),
    })),
    planner: z.object({
      date: z.string(), startUtc: z.string(), overlapHours: z.array(z.number()), overlapUtc: z.array(z.string()), summary: z.string(),
      rows: z.array(z.object({ zone: z.string(), city: z.string(), hours: z.array(z.object({ label: z.string(), band: z.string() })) })),
    }).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { zones: ['Europe/London', 'America/New_York'], at: '2026-01-15T12:00:00Z' }, note: 'Working-hours overlap 14:00–16:00 UTC (hours 14, 15, 16)' },
    { input: { zones: ['Asia/Amman', 'Mecca', 'Tokyo', 'Los Angeles'], hour12: true } },
  ],
  run(input) {
    const zones: string[] = [];
    for (const q of input.zones) {
      const tz = resolve(q);
      if (!tz) throw new ToolError(`No time zone matches "${q}". Use an IANA id like "Europe/London" or a city name.`);
      if (!zones.includes(tz)) zones.push(tz);
    }
    let home = zones[0];
    if (input.homeZone) {
      const tz = resolve(input.homeZone);
      if (!tz) throw new ToolError(`No time zone matches "${input.homeZone}".`);
      home = tz;
    }
    const at = input.at ? new Date(input.at) : new Date();
    if (isNaN(at.getTime())) throw new ToolError(`"at" is not a valid ISO date-time: ${input.at}`);
    const h12 = input.hour12;
    const homeOff = offsetMin(home, at);
    const clocks = zones.map((tz) => {
      const p = parts(tz, at), hf = p.hour + p.minute / 60, off = offsetMin(tz, at), l = label(tz);
      return {
        zone: tz, city: l.city, region: l.region, time: timeStr(p, h12),
        date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, weekday: p.weekday,
        offset: fmtOffset(off), offsetMinutes: off, diff: tz === home ? 'home' : fmtDiff(off - homeOff),
        isDay: hf >= 6 && hf < 18, band: kind(hf), workingHours: kind(hf) === 'work' && p.weekday !== 'Sat' && p.weekday !== 'Sun',
      };
    });
    const out: Record<string, unknown> = { at: at.toISOString(), homeZone: home, clocks };
    if (input.planner) {
      const day = input.plannerDate ? input.plannerDate.split('-').map(Number) : (({ y, m, d }) => [y, m, d])(ymdIn(home, at));
      const start = zoneMidnight(home, day[0], day[1], day[2]);
      const list = zones.includes(home) ? zones : [home, ...zones];
      const ov = workingOverlap(list, start);
      out.planner = {
        date: `${day[0]}-${String(day[1]).padStart(2, '0')}-${String(day[2]).padStart(2, '0')}`,
        startUtc: new Date(start).toISOString(),
        overlapHours: ov,
        overlapUtc: ov.map((i) => new Date(start + i * 3600000).toISOString()),
        summary: list.length < 2 ? 'Add another zone to compare.'
          : ov.length ? 'Everyone is in working hours for ' + ov.length + ' hour' + (ov.length > 1 ? 's' : '') + '.'
            : "No hour where everyone is inside 9–17. Look for the 'awake' hours instead.",
        rows: list.map((tz) => {
          const baseDay = parts(tz, new Date(start)).day;
          return {
            zone: tz, city: label(tz).city,
            hours: Array.from({ length: 24 }, (_, i) => {
              const p = parts(tz, new Date(start + i * 3600000));
              return { label: p.day !== baseDay && p.hour === 0 ? p.month + '/' + p.day : shortHour(p, h12), band: kind(p.hour + p.minute / 60) };
            }),
          };
        }),
      };
    }
    return out;
  },
});

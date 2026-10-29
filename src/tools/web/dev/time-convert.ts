import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { checkTz, fmtOffset, isoInZone, LOCAL_TZ, parts, tzOffset, wallToEpoch } from './_tz.js';

// Ported from https://github.com/s3eidat/timestamp-convert (app.js): same unit auto-detection (BigInt keeps µs/ns exact),
// timezone maths on Intl's tz database, relative-time wording and ISO week numbers.
const MAX_MS = 8.64e15;
export type Unit = 's' | 'ms' | 'us' | 'ns';
const UNIT_NAMES: Record<Unit, string> = { s: 'seconds', ms: 'milliseconds', us: 'microseconds', ns: 'nanoseconds' };

/** → {ms, unit} or throws. Auto-detects the unit from magnitude. */
export function parseTs(input: string, unit?: Unit | 'auto'): { ms: number; unit: Unit } {
  const s = String(input).trim().replace(/[\s,_']/g, '');
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) throw new ToolError('Use digits only, e.g. 1700000000');
  const neg = s.charAt(0) === '-', intPart = s.replace(/^[-+]/, '').split('.')[0], frac = s.split('.')[1] || '';
  const mag = intPart.replace(/^0+/, '').length;
  const u: Unit = !unit || unit === 'auto' ? (mag <= 11 ? 's' : mag <= 14 ? 'ms' : mag <= 17 ? 'us' : 'ns') : unit;
  const div = { s: 1e-3, ms: 1, us: 1e3, ns: 1e6 }[u];
  let ms: number;
  if (u === 'us' || u === 'ns') {
    const big = BigInt(intPart), q = big / BigInt(div), r = Number(big % BigInt(div)) / div;
    ms = Number(q) + r + (frac ? Number('0.' + frac) / div : 0);
  } else ms = Number(s.replace(/^[-+]/, '')) / div;
  if (neg) ms = -ms;
  if (!isFinite(ms) || Math.abs(ms) > MAX_MS) throw new ToolError('That is outside the range a date can show (±275,000 years)');
  return { ms, unit: u };
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function rel(ms: number, now: number) {
  const s = (ms - now) / 1000;
  const U: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31557600], ['month', 2629800], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  for (let i = 0; i < U.length; i++) if (Math.abs(s) >= U[i][1] || i === U.length - 1) return rtf.format(Math.round(s / U[i][1]), U[i][0]);
  return '';
}
export function isoWeek(ms: number, tz: string) {
  const p = parts(ms, tz), t = new Date(Date.UTC(p.y, p.mo - 1, p.d)), day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const doy = Math.floor((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(p.y, 0, 1)) / 864e5) + 1;
  return { week: Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7), doy };
}
function fmtIn(ms: number, tz: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));
}

const WALL = /^(\d{4,})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/;

export default defineTool({
  name: 'time_convert',
  title: 'Timestamp convert',
  webSlug: 'timestamp-convert',
  description:
    'Convert a Unix timestamp (seconds, ms, µs or ns — auto-detected from the number of digits, or set "unit") or a date ' +
    'string to ISO 8601 (UTC and in a timezone), RFC 7231 / UTC string, local time in any IANA timezone with its offset, ' +
    'relative time ("3 hours ago"), day of year, ISO week, and Unix seconds/ms. A wall-clock time without an offset ' +
    '(e.g. "2026-10-26T14:30") is read in "timezone". Also shows the same instant in extra "zones" (world clock). No ' +
    `value = now. Date arithmetic is not done here. Web version: ${webUrl('timestamp-convert')}`,
  inputSchema: z.object({
    value: z
      .union([z.string(), z.number()])
      .optional()
      .describe('A Unix timestamp (e.g. 1700000000 or "1700000000123"), an ISO/RFC date string, or a wall-clock "YYYY-MM-DDTHH:MM[:SS]". Default: now.'),
    unit: z.enum(['auto', 's', 'ms', 'us', 'ns']).optional().default('auto').describe('Unit of a numeric timestamp. Default: auto-detect.'),
    timezone: z.string().optional().describe(`IANA timezone for the local view and for wall-clock input. Default: the server's (${LOCAL_TZ}).`),
    zones: z.array(z.string()).max(50).optional().describe('Extra IANA timezones to show the same instant in, e.g. ["UTC","Asia/Tokyo"].'),
    now: z.number().optional().describe('Reference "now" in Unix ms for the relative time. Default: the current time.'),
  }),
  outputSchema: z.object({
    input: z.string(),
    detectedUnit: z.string().optional(),
    unixSeconds: z.number(),
    unixMilliseconds: z.number(),
    iso: z.string(),
    utc: z.string(),
    timezone: z.string(),
    local: z.string(),
    localIso: z.string(),
    offset: z.string(),
    relative: z.string(),
    dayOfYear: z.number(),
    isoWeek: z.number(),
    zones: z.array(z.object({ zone: z.string(), time: z.string(), iso: z.string(), offset: z.string() })).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { value: 1700000000, timezone: 'Asia/Amman' }, note: 'iso 2023-11-14T22:13:20.000Z, localIso 2023-11-15T01:13:20+03:00, detectedUnit seconds' },
    { input: { value: '2026-07-01T09:00', timezone: 'Asia/Tokyo' }, note: 'unixSeconds 1782864000 (2026-07-01T00:00:00Z)' },
  ],
  run(input) {
    const tz = checkTz(input.timezone || LOCAL_TZ);
    const now = input.now ?? Date.now();
    let ms: number, unit: Unit | undefined;
    const raw = input.value == null ? '' : String(input.value).trim();
    if (!raw) ms = now;
    else if (/^[-+]?[\d\s,_']+(\.\d+)?$/.test(raw)) ({ ms, unit } = parseTs(raw, input.unit));
    else {
      const m = WALL.exec(raw);
      if (m) ms = wallToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
      else {
        ms = Date.parse(raw);
        if (isNaN(ms)) throw new ToolError("Couldn't read that date. ISO 8601 like 2026-10-26T14:30:00Z works best.");
      }
    }
    const d = new Date(ms), w = isoWeek(ms, tz);
    const out: Record<string, unknown> = {
      input: raw || 'now',
      unixSeconds: Math.floor(ms / 1000),
      unixMilliseconds: Math.floor(ms),
      iso: d.toISOString(),
      utc: d.toUTCString(),
      timezone: tz,
      local: fmtIn(ms, tz),
      localIso: isoInZone(ms, tz),
      offset: fmtOffset(tzOffset(ms, tz)),
      relative: rel(ms, now),
      dayOfYear: w.doy,
      isoWeek: w.week,
    };
    if (unit) out.detectedUnit = UNIT_NAMES[unit];
    if (input.zones?.length) {
      out.zones = input.zones.map((z0) => {
        const z = checkTz(z0);
        return { zone: z, time: fmtIn(ms, z), iso: isoInZone(ms, z), offset: fmtOffset(tzOffset(ms, z)) };
      });
    }
    return out;
  },
});

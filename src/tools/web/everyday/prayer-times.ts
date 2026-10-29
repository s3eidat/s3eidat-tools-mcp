import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import {
  addDays, CalculationMethod, CalculationParameters, prayerTimes, recommendedHighLatitudeRule,
  type HighLatitudeRule, type Madhab, type PrayerKey, type Ymd,
} from './_adhan.js';
import { CITY_IDS, findCity } from './_cities.js';
import { checkZone, ymdIn } from './_time.js';

// Ported from https://github.com/s3eidat/prayer-times (app.js + lib/adhan.min.js): same methods (incl. Jordan's
// Awqaf parameters), Asr schools, high-latitude rule (>48°), city list and next-prayer logic. Times match the site.
export const KEYS: PrayerKey[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

export const METHODS: Record<string, { name: string; make: () => CalculationParameters }> = {
  jordan: {
    name: 'Jordan (Awqaf: 18°/18°, Maghrib +5 min)',
    make() { const p = CalculationMethod.Other(); p.fajrAngle = 18; p.ishaAngle = 18; p.methodAdjustments = { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 5, isha: 0 }; return p; },
  },
  mwl: { name: 'Muslim World League', make: () => CalculationMethod.MuslimWorldLeague() },
  ummalqura: { name: 'Umm al-Qura (Makkah)', make: () => CalculationMethod.UmmAlQura() },
  egyptian: { name: 'Egyptian General Authority', make: () => CalculationMethod.Egyptian() },
  isna: { name: 'ISNA (North America)', make: () => CalculationMethod.NorthAmerica() },
  karachi: { name: 'University of Islamic Sciences, Karachi', make: () => CalculationMethod.Karachi() },
  dubai: { name: 'Dubai', make: () => CalculationMethod.Dubai() },
  kuwait: { name: 'Kuwait', make: () => CalculationMethod.Kuwait() },
  qatar: { name: 'Qatar', make: () => CalculationMethod.Qatar() },
  turkey: { name: 'Turkey (Diyanet)', make: () => CalculationMethod.Turkey() },
  singapore: { name: 'Singapore / Malaysia / Indonesia', make: () => CalculationMethod.Singapore() },
  tehran: { name: 'Institute of Geophysics, Tehran', make: () => CalculationMethod.Tehran() },
  moonsighting: { name: 'Moonsighting Committee', make: () => CalculationMethod.MoonsightingCommittee() },
};
const METHOD_IDS = Object.keys(METHODS) as [string, ...string[]];

/** Website `params`: the method, the Asr school, and the recommended high-latitude rule beyond 48°. */
export function params(method: string, madhab: Madhab, lat: number, lon: number, rule: HighLatitudeRule | 'auto' = 'auto') {
  const p = METHODS[method].make();
  p.madhab = madhab === 'hanafi' ? 'hanafi' : 'shafi';
  if (rule !== 'auto') p.highLatitudeRule = rule;
  else if (Math.abs(lat) > 48) p.highLatitudeRule = recommendedHighLatitudeRule({ latitude: lat, longitude: lon });
  return p;
}
/** y/m/d are the calendar date AT THE LOCATION. */
export function compute(lat: number, lon: number, day: Ymd, method: string, madhab: Madhab, rule: HighLatitudeRule | 'auto' = 'auto') {
  const pt = prayerTimes({ latitude: lat, longitude: lon }, day, params(method, madhab, lat, lon, rule));
  const o = {} as Record<PrayerKey, Date>;
  KEYS.forEach((k) => { o[k] = pt[k]; });
  return o;
}
export function nextOf(today: Record<string, Date>, tomorrow: Record<string, Date>, now: Date) {
  const order = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  for (const k of order) if (today[k] > now) return { key: k, time: today[k], tomorrow: false };
  return { key: 'fajr', time: tomorrow.fajr, tomorrow: true };
}

const valid = (d: Date) => !isNaN(d.getTime());
const hmFmt = new Map<string, Intl.DateTimeFormat>();
function hm(d: Date, tz: string) {
  if (!valid(d)) return null;
  let f = hmFmt.get(tz);
  if (!f) hmFmt.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })));
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}
function hijri(day: Ymd, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(day.y, day.m - 1, day.d, 12)));
  } catch {
    return '';
  }
}
const iso = (d: Ymd) => `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
function parseYmd(s: string): Ymd {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new ToolError(`Date "${s}" must be YYYY-MM-DD.`);
  const d = { y: +m[1], m: +m[2], d: +m[3] };
  if (iso(addDays(d, 0)) !== s) throw new ToolError(`Date "${s}" does not exist.`);
  return d;
}
const hms = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

const timesShape = z.object({ fajr: z.string().nullable(), sunrise: z.string().nullable(), dhuhr: z.string().nullable(), asr: z.string().nullable(), maghrib: z.string().nullable(), isha: z.string().nullable() });

export default defineTool({
  name: 'prayer_times',
  title: 'Prayer times',
  webSlug: 'prayer-times',
  description:
    'Islamic prayer times (Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha) for any coordinates + IANA time zone, or a known city, ' +
    'for one day, several days or a whole month, plus the Hijri (Umm al-Qura) date and the next prayer with a countdown. ' +
    'Same astronomy as the website (adhan.js): 13 methods (Jordan Awqaf, MWL, Umm al-Qura, Egyptian, ISNA, Karachi, Dubai, ' +
    'Kuwait, Qatar, Turkey, Singapore, Tehran, Moonsighting), Shafi\'i or Hanafi Asr, and the recommended high-latitude ' +
    'rule beyond 48° (overridable). Times are local HH:MM (24 h) in the given zone, plus UTC ISO. Coordinates are rounded ' +
    `to 4 decimals like the site. Web version: ${webUrl('prayer-times')}`,
  inputSchema: z.object({
    city: z.string().optional().describe(`A known city (sets coordinates, time zone and its usual method): ${CITY_IDS.join(', ')}.`),
    latitude: z.number().min(-90).max(90).optional().describe('Latitude in degrees (−90..90). Use with longitude and timezone.'),
    longitude: z.number().min(-180).max(180).optional().describe('Longitude in degrees (−180..180).'),
    timezone: z.string().optional().describe('IANA time zone of the place, e.g. "Asia/Amman" (required with coordinates; overrides the city\'s).'),
    date: z.string().optional().describe('First day, YYYY-MM-DD in the place\'s calendar. Default: today there.'),
    days: z.number().int().min(1).max(31).optional().default(1).describe('How many consecutive days to return.'),
    month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Or a whole month timetable, YYYY-MM (overrides date/days).'),
    method: z.enum(METHOD_IDS).optional().describe('Calculation method. Default: the city\'s usual method, else "mwl".'),
    asr: z.enum(['shafi', 'hanafi']).optional().describe('Asr school: "shafi" (standard: Shafi\'i, Maliki, Hanbali) or "hanafi". Default shafi (hanafi for Karachi-method cities).'),
    highLatitudeRule: z.enum(['auto', 'middleofthenight', 'seventhofthenight', 'twilightangle']).optional().default('auto')
      .describe('"auto" = website behaviour (recommended rule when |latitude| > 48°).'),
    now: z.string().optional().describe('Reference instant (ISO 8601) for "today" and the next prayer. Default: the current time.'),
  }),
  outputSchema: z.object({
    place: z.string().optional(), latitude: z.number(), longitude: z.number(), timezone: z.string(),
    method: z.object({ id: z.string(), name: z.string() }), asr: z.string(), highLatitudeRule: z.string().nullable(),
    days: z.array(z.object({ date: z.string(), weekday: z.string(), hijri: z.string(), hijriAr: z.string(), times: timesShape, utc: timesShape })),
    next: z.object({ prayer: z.string(), time: z.string().nullable(), utc: z.string(), tomorrow: z.boolean(), countdown: z.string(), minutes: z.number() }),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { city: 'amman', date: '2026-01-15', method: 'mwl' }, note: 'Dhuhr 12:47 (09:47 UTC)' },
    { input: { latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London', month: '2026-03' }, note: 'London monthly timetable, MWL, seventh-of-the-night rule' },
  ],
  run(input) {
    let lat = input.latitude, lon = input.longitude, tz = input.timezone, place: string | undefined, cityMethod: string | undefined;
    if (input.city) {
      const c = findCity(input.city);
      if (!c) throw new ToolError(`Unknown city "${input.city}". Known: ${CITY_IDS.join(', ')}. Or give latitude, longitude and timezone.`);
      lat = c.lat; lon = c.lon; tz = input.timezone ?? c.tz; place = c.en; cityMethod = c.method;
    }
    if (lat == null || lon == null) throw new ToolError('Give latitude and longitude (or a city).');
    if (!tz) throw new ToolError('Give the IANA "timezone" of the place, e.g. "Europe/London".');
    checkZone(tz);
    lat = Math.round(lat * 1e4) / 1e4;
    lon = Math.round(lon * 1e4) / 1e4;
    const method = input.method ?? cityMethod ?? 'mwl';
    const madhab: Madhab = input.asr ?? (cityMethod === 'karachi' && !input.method ? 'hanafi' : 'shafi');
    const now = input.now ? new Date(input.now) : new Date();
    if (!valid(now)) throw new ToolError(`"now" is not a valid ISO date-time: ${input.now}`);
    const today = ymdIn(tz, now);

    let first: Ymd, count: number;
    if (input.month) {
      const [y, m] = input.month.split('-').map(Number);
      if (m < 1 || m > 12) throw new ToolError(`Month "${input.month}" must be YYYY-MM.`);
      first = { y, m, d: 1 };
      count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    } else {
      first = input.date ? parseYmd(input.date) : today;
      count = input.days;
    }
    const rule = input.highLatitudeRule as HighLatitudeRule | 'auto';
    const days = [];
    for (let i = 0; i < count; i++) {
      const day = addDays(first, i), t = compute(lat, lon, day, method, madhab, rule);
      const times = {} as Record<PrayerKey, string | null>, utc = {} as Record<PrayerKey, string | null>;
      for (const k of KEYS) { times[k] = hm(t[k], tz); utc[k] = valid(t[k]) ? t[k].toISOString() : null; }
      days.push({
        date: iso(day),
        weekday: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(Date.UTC(day.y, day.m - 1, day.d, 12))),
        hijri: hijri(day, 'en-u-ca-islamic-umalqura'), hijriAr: hijri(day, 'ar-u-ca-islamic-umalqura-nu-latn'),
        times, utc,
      });
    }
    const real = compute(lat, lon, today, method, madhab, rule), tmr = compute(lat, lon, addDays(today, 1), method, madhab, rule);
    const nx = nextOf(real, tmr, now);
    const p = params(method, madhab, lat, lon, rule);
    return {
      ...(place ? { place } : {}), latitude: lat, longitude: lon, timezone: tz,
      method: { id: method, name: METHODS[method].name }, asr: madhab,
      highLatitudeRule: rule !== 'auto' || Math.abs(lat) > 48 ? p.highLatitudeRule : null,
      days,
      next: {
        prayer: nx.key, time: hm(nx.time, tz), utc: valid(nx.time) ? nx.time.toISOString() : '', tomorrow: nx.tomorrow,
        countdown: hms(nx.time.getTime() - now.getTime()), minutes: Math.max(0, Math.floor((nx.time.getTime() - now.getTime()) / 60000)),
      },
    };
  },
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';
import { addMonths, cfd, dfc, diff, hijriText, iso, nice, parseOr, plural, wd, DAYS, ymd } from './_cal.js';

// Ported from https://github.com/s3eidat/date-diff (app.js): calendar-day arithmetic on day numbers.
export const WEEKENDS: Record<string, number[]> = { 'fri-sat': [5, 6], 'sat-sun': [6, 0], fri: [5], sun: [0] }; // 0 = Sunday
const WLABEL: Record<string, string> = { 'fri-sat': 'Fri–Sat', 'sat-sun': 'Sat–Sun', fri: 'Fri', sun: 'Sun' };

/** Working days in the half-open range [za, zb). */
export function businessDays(za: number, zb: number, weekend: number[]) {
  const n = zb - za, full = Math.floor(n / 7);
  let count = full * (7 - weekend.length);
  for (let z = za + full * 7; z < zb; z++) if (weekend.indexOf(wd(z)) < 0) count++;
  return count;
}
export function addBusinessDays(z: number, n: number, weekend: number[]) {
  const step = n < 0 ? -1 : 1;
  if (weekend.length >= 7) return z;
  for (let left = Math.abs(n); left > 0;) { z += step; if (weekend.indexOf(wd(z)) < 0) left--; }
  return z;
}

const UNIT_NAME: Record<string, string> = { d: 'days', bd: 'business days', w: 'weeks', m: 'months', y: 'years' };

export default defineTool({
  name: 'calc_date_diff',
  title: 'Date difference / add days',
  webSlug: 'date-diff',
  description:
    'Two date jobs. difference: days between two dates (optionally counting the end day), as years/months/days, weeks, whole ' +
    'months, working days and weekend days for a chosen weekend (Fri–Sat default, Sat–Sun, Fri only, Sun only; public holidays ' +
    'are not counted). add: add or subtract days, business days, weeks, months or years to a date (month ends clamp: Jan 31 + 1 ' +
    'month = Feb 28/29). Results include the weekday and Umm al-Qura Hijri date. Dates are ISO YYYY-MM-DD; for Hijri ⇄ ' +
    `Gregorian conversion use calc_hijri. Web version: ${webUrl('date-diff')}`,
  inputSchema: z.object({
    mode: z.enum(['difference', 'add']).optional().default('difference').describe('difference between two dates, or add/subtract an amount.'),
    start: z.string().optional().describe('difference: start date YYYY-MM-DD (default today).'),
    end: z.string().optional().describe('difference: end date YYYY-MM-DD (default today).'),
    inclusive: z.boolean().optional().default(false).describe('difference: count the end date too.'),
    weekend: z.enum(['fri-sat', 'sat-sun', 'fri', 'sun']).optional().default('fri-sat').describe('Weekend days skipped by working-day counts.'),
    date: z.string().optional().describe('add: the starting date YYYY-MM-DD (default today).'),
    amount: z.number().int().min(0).max(1_000_000).optional().describe('add: how many units to add (use subtract to go back).'),
    unit: z.enum(['days', 'business_days', 'weeks', 'months', 'years']).optional().default('days').describe('add: unit of amount.'),
    subtract: z.boolean().optional().default(false).describe('add: go back in time instead.'),
  }),
  outputSchema: z.object({
    mode: z.string(),
    days: z.number().optional(), years: z.number().optional(), months: z.number().optional(), remainderDays: z.number().optional(), text: z.string().optional(),
    weeks: z.number().optional(), weeksRemainderDays: z.number().optional(), wholeMonths: z.number().optional(),
    workingDays: z.number().optional(), weekendDays: z.number().optional(), endBeforeStart: z.boolean().optional(),
    result: z.object({ date: z.string(), weekday: z.string(), long: z.string(), hijri: z.string(), hijriArabic: z.string() }).optional(),
    calendarDays: z.number().optional(), note: z.string().optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { start: '2026-10-26', end: '2026-10-31', weekend: 'sat-sun' }, note: '5 days, 5 working days' },
    { input: { mode: 'add', date: '2026-10-30', amount: 5, unit: 'business_days', weekend: 'sat-sun' }, note: '2026-11-06' },
  ],
  run(input) {
    const we = WEEKENDS[input.weekend];
    if (input.mode === 'difference') {
      const a = parseOr(input.start, 'start'), b = parseOr(input.end, 'end');
      const neg = dfc(b) < dfc(a), lo = neg ? b : a, hi = neg ? a : b, incl = input.inclusive;
      const za = dfc(lo), zb = dfc(hi) + (incl ? 1 : 0), days = zb - za;
      const ym = diff(lo, incl ? cfd(zb) : hi), bd = businessDays(za, zb, we);
      return {
        mode: 'difference', days, years: ym.y, months: ym.m, remainderDays: ym.d, text: ymd(ym), weeks: Math.floor(days / 7), weeksRemainderDays: days % 7,
        wholeMonths: ym.months, workingDays: bd, weekendDays: days - bd, endBeforeStart: neg,
        summary: 'From ' + nice(lo, true) + ' to ' + nice(hi, true) + (incl ? ' (inclusive)' : '') + ': ' + plural(days, 'day') + ' (' + ymd(ym) + '), ' +
          plural(bd, 'working day') + ' with ' + WLABEL[input.weekend] + ' weekends',
      };
    }
    const s = parseOr(input.date, 'date');
    if (input.amount === undefined) throw new ToolError('"amount" is required for mode "add".');
    const n = input.amount, k = input.subtract ? -n : n, z = dfc(s);
    const unit = { days: 'd', business_days: 'bd', weeks: 'w', months: 'm', years: 'y' }[input.unit];
    let r;
    if (unit === 'd') r = cfd(z + k);
    else if (unit === 'w') r = cfd(z + 7 * k);
    else if (unit === 'bd') r = cfd(addBusinessDays(z, k, we));
    else r = addMonths(s, unit === 'm' ? k : 12 * k);
    if (r.y < 1 || r.y > 9999) throw new ToolError('The result is outside years 1–9999.');
    let note: string | undefined;
    if ((unit === 'm' || unit === 'y') && r.d !== s.d) note = 'Day ' + s.d + ' does not exist in that month, so it lands on the last day (' + r.d + ').';
    if (unit === 'bd') note = 'Skips ' + WLABEL[input.weekend] + ' weekends; public holidays are not counted.';
    return {
      mode: 'add',
      result: { date: iso(r), weekday: DAYS[wd(dfc(r))], long: nice(r, true), hijri: hijriText(r), hijriArabic: hijriText(r, 'ar-SA') },
      calendarDays: Math.abs(dfc(r) - z), ...(note ? { note } : {}),
      summary: nice(s, true) + ' ' + (input.subtract ? '−' : '+') + ' ' + n + ' ' + UNIT_NAME[unit] + ' = ' + nice(r, true) + ' (' + hijriText(r) + ')',
    };
  },
});

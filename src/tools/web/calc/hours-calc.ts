import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';
import { cfd, dfc, parseOr, wd, DAYS, iso } from './_cal.js';

// Ported from https://github.com/s3eidat/hours-calc (app.js): a weekly time card in whole minutes;
// an end at or before the start rolls to the next day (overnight).
export function toMin(t: string | undefined) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; }
/** Worked minutes of one shift; null when the times are incomplete. */
export function shiftMinutes(start: string, end: string, breakMin: number, round: number) {
  const s = toMin(start);
  let e = toMin(end);
  if (s == null || e == null) return null;
  if (e <= s) e += 1440;
  const m = Math.max(0, e - s - (breakMin > 0 ? breakMin : 0));
  return round > 0 ? Math.round(m / round) * round : m;
}
export function overnight(start: string, end: string) { const s = toMin(start), e = toMin(end); return s != null && e != null && e <= s; }
/** Daily overtime first, then weekly overtime on what's left of the regular hours. */
export function weekCalc(dayMins: number[], dailyT: number | null, weeklyT: number | null) {
  const dailyOT = dayMins.map((m) => (dailyT != null ? Math.max(0, m - dailyT) : 0));
  const total = dayMins.reduce((a, b) => a + b, 0), dOT = dailyOT.reduce((a, b) => a + b, 0), reg = total - dOT;
  const wOT = weeklyT != null ? Math.max(0, reg - weeklyT) : 0;
  return { total, regular: reg - wOT, overtime: dOT + wOT, dailyOT, weeklyOT: wOT };
}
export function pay(c: { regular: number; overtime: number }, rate: number, mult: number) {
  const r = rate / 60;
  return { regular: c.regular * r, overtime: c.overtime * r * mult, total: c.regular * r + c.overtime * r * mult };
}
export function hm(m: number) { const neg = m < 0; m = Math.abs(Math.round(m)); return (neg ? '-' : '') + Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); }
export const dec = (m: number) => (m / 60).toFixed(2);

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const time = z.string().regex(/^\d{1,2}:\d{2}$/);

export default defineTool({
  name: 'calc_hours',
  title: 'Work hours / time card',
  webSlug: 'hours-calc',
  description:
    'Weekly time card: add shifts (start and end "HH:MM", unpaid break minutes; an end at or before the start is an overnight ' +
    'shift), up to 6 shifts a day. Totals per shift, per day and per week in h:mm and decimal hours; optional rounding of each ' +
    'shift to 5, 6 or 15 minutes; overtime over N hours a day and/or N regular hours a week (daily first, then weekly), paid at ' +
    `a multiplier (default 1.5); pay at an hourly rate. Web version: ${webUrl('hours-calc')}`,
  inputSchema: z.object({
    shifts: z.array(z.object({
      day: z.enum(DAY_KEYS).describe('Day of the week.'),
      start: time.describe('Start time, 24 h "HH:MM".'),
      end: time.describe('End time, 24 h "HH:MM" (at or before start = next day).'),
      breakMinutes: z.number().int().min(0).max(1439).optional().default(0).describe('Unpaid break in minutes.'),
    })).max(42).describe('The week\'s shifts.'),
    dailyOvertimeHours: z.number().min(0).optional().describe('Hours per day after which time is overtime (e.g. 8).'),
    weeklyOvertimeHours: z.number().min(0).optional().describe('Regular hours per week after which time is overtime (e.g. 40).'),
    overtimeMultiplier: z.number().min(0).optional().default(1.5).describe('Overtime pay multiplier.'),
    hourlyRate: z.number().min(0).optional().describe('Pay per regular hour.'),
    currency: z.string().max(6).optional().describe('Currency label for the summary.'),
    roundMinutes: z.union([z.literal(0), z.literal(5), z.literal(6), z.literal(15)]).optional().default(0).describe('Round each shift to the nearest 5, 6 or 15 minutes (0 = off).'),
    weekStart: z.enum(['saturday', 'sunday', 'monday']).optional().default('saturday').describe('First day of the week (order of the days).'),
    weekOf: z.string().optional().describe('Optional: any date in that week (YYYY-MM-DD) to date each day.'),
  }),
  outputSchema: z.object({
    shifts: z.array(z.object({ day: z.string(), start: z.string(), end: z.string(), breakMinutes: z.number(), minutes: z.number(), hm: z.string(), hours: z.string(), overnight: z.boolean(), warning: z.string().optional() })),
    days: z.array(z.object({ day: z.string(), date: z.string().optional(), minutes: z.number(), hm: z.string(), hours: z.string(), overtimeMinutes: z.number() })),
    total: z.object({ minutes: z.number(), hm: z.string(), hours: z.string() }),
    regular: z.object({ minutes: z.number(), hm: z.string(), hours: z.string() }),
    overtime: z.object({ minutes: z.number(), hm: z.string(), hours: z.string(), daily: z.number(), weekly: z.number() }),
    pay: z.object({ regular: z.number(), overtime: z.number(), total: z.number() }).optional(),
    note: z.string(), summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { shifts: [{ day: 'monday', start: '09:00', end: '17:30', breakMinutes: 30 }, { day: 'tuesday', start: '22:00', end: '06:00', breakMinutes: 30 }], hourlyRate: 20 }, note: '15:30 total, pay 310' }],
  run(input) {
    const ws = { sunday: 0, monday: 1, saturday: 6 }[input.weekStart], order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
    let dates: string[] | null = null;
    if (input.weekOf) {
      const z0 = dfc(parseOr(input.weekOf, 'weekOf')), first = z0 - ((wd(z0) - ws + 7) % 7);
      dates = Array.from({ length: 7 }, (_, d) => iso(cfd(first + ((d - ws + 7) % 7))));
    }
    const perDay = DAY_KEYS.map(() => 0 as number), counts = DAY_KEYS.map(() => 0);
    const shifts = input.shifts.map((s) => {
      const d = DAY_KEYS.indexOf(s.day);
      if (++counts[d] > 6) throw new ToolError('At most 6 shifts per day (' + s.day + ').');
      const m = shiftMinutes(s.start, s.end, s.breakMinutes, input.roundMinutes);
      if (m == null) throw new ToolError(`Shift on ${s.day}: times must be HH:MM between 00:00 and 23:59.`);
      perDay[d] += m;
      const tooLong = s.breakMinutes > 0 && shiftMinutes(s.start, s.end, 0, 0)! <= s.breakMinutes;
      return { day: DAYS[d], start: s.start, end: s.end, breakMinutes: s.breakMinutes, minutes: m, hm: hm(m), hours: dec(m), overnight: overnight(s.start, s.end), ...(tooLong ? { warning: 'break too long' } : {}) };
    });
    const dt = input.dailyOvertimeHours, wt = input.weeklyOvertimeHours, mult = input.overtimeMultiplier, rate = input.hourlyRate;
    const c = weekCalc(perDay, dt != null ? dt * 60 : null, wt != null ? wt * 60 : null);
    const cur = input.currency?.trim(), money = (v: number) => (cur ? cur + ' ' : '') + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const p = rate != null ? pay(c, rate, mult) : null;
    const bits: string[] = [];
    if (dt != null) bits.push('over ' + dt + ' h a day');
    if (wt != null) bits.push('over ' + wt + ' regular hours a week');
    const roundNote = input.roundMinutes ? ' Each shift is rounded to the nearest ' + input.roundMinutes + ' minutes.' : '';
    const note = (bits.length ? 'Overtime counts hours ' + bits.join(', then ') + ', paid at ×' + mult + '.' : 'No overtime rules set; give dailyOvertimeHours or weeklyOvertimeHours to split regular and overtime hours.') +
      roundNote + (rate != null ? ' Rate: ' + money(rate) + ' per hour.' : '');
    const lines: string[] = [];
    order.forEach((d) => {
      const parts = input.shifts.filter((s) => s.day === DAY_KEYS[d]).map((s) => s.start + '–' + s.end + (s.breakMinutes ? ' (' + s.breakMinutes + ' min break)' : ''));
      if (parts.length) lines.push(DAYS[d] + (dates ? ' ' + dates[d] : '') + ': ' + parts.join(', ') + ' = ' + hm(perDay[d]) + ' (' + dec(perDay[d]) + ' h)');
    });
    lines.push('Total: ' + hm(c.total) + ' (' + dec(c.total) + ' h) · regular ' + hm(c.regular) + ' · overtime ' + hm(c.overtime));
    if (p) lines.push('Pay: ' + money(p.total) + ' at ' + money(rate!) + '/h, overtime ×' + mult);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      shifts,
      days: order.map((d) => ({ day: DAYS[d], ...(dates ? { date: dates[d] } : {}), minutes: perDay[d], hm: hm(perDay[d]), hours: dec(perDay[d]), overtimeMinutes: c.dailyOT[d] })),
      total: { minutes: c.total, hm: hm(c.total), hours: dec(c.total) },
      regular: { minutes: c.regular, hm: hm(c.regular), hours: dec(c.regular) },
      overtime: { minutes: c.overtime, hm: hm(c.overtime), hours: dec(c.overtime), daily: c.dailyOT.reduce((a, b) => a + b, 0), weekly: c.weeklyOT },
      ...(p ? { pay: { regular: r2(p.regular), overtime: r2(p.overtime), total: r2(p.total) } } : {}),
      note, summary: lines.join('\n'),
    };
  },
});

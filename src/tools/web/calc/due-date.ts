import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';
import { cfd, dfc, hijriText, iso, nice, parseOr, plural } from './_cal.js';

// Ported from https://github.com/s3eidat/due-date (app.js): calendar-day arithmetic on day numbers.
export type Method = 'lmp' | 'conception' | 'ivf';

/** The "gestational start" (equivalent first day of last period, cycle-adjusted) and the due date. */
export function estimate(method: Method, z: number, cycle: number, ivfDay: number) {
  let start: number;
  if (method === 'lmp') start = z + (cycle - 28); // Naegele's rule with cycle adjustment
  else if (method === 'conception') start = z - 14;
  else start = z - 14 - ivfDay; // embryo was conceived ivfDay days before transfer
  return { start, due: start + 280, conception: start + 14 };
}
export function progress(start: number, now: number) {
  const d = now - start, wk = Math.floor(d / 7);
  return { days: d, weeks: wk, rest: d - wk * 7, tri: d < 0 ? 0 : wk < 14 ? 1 : wk < 28 ? 2 : 3, left: 280 - d };
}
export const MILESTONES: [number, number, string][] = [
  [4, 0, 'A home pregnancy test can usually turn positive around now'],
  [6, 0, 'A heartbeat can often be seen on an early ultrasound (weeks 6–7)'],
  [8, 0, 'First prenatal visit is commonly booked between weeks 8 and 10'],
  [11, 0, 'First-trimester screening window (nuchal scan, weeks 11–13+6)'],
  [14, 0, 'Second trimester begins'],
  [16, 0, 'Some people start to feel first movements (weeks 16–22)'],
  [18, 0, 'Detailed anatomy scan window (weeks 18–22)'],
  [24, 0, 'Glucose screening for gestational diabetes is often done (weeks 24–28)'],
  [28, 0, 'Third trimester begins'],
  [32, 0, 'Growth checks and more frequent visits are common from here'],
  [37, 0, 'Early term'],
  [39, 0, 'Full term'],
  [40, 0, 'Estimated due date'],
  [41, 0, 'Late term'],
  [42, 0, 'Post-term: care teams usually plan delivery before now'],
];
export const HOW: Record<Method, string> = {
  lmp: 'Due date = first day of last period + 280 days, adjusted by your cycle length minus 28.',
  conception: 'Due date = conception date + 266 days (38 weeks).',
  ivf: "Due date = transfer date + 266 days − the embryo's age (261 days for a day-5 transfer, 263 for day 3).",
};

export default defineTool({
  name: 'calc_due_date',
  title: 'Pregnancy due date',
  webSlug: 'due-date',
  description:
    'Estimated pregnancy due date from the first day of the last period (Naegele\'s rule, adjusted for cycle length 20–45 days), ' +
    'the conception date, or an IVF embryo transfer date (day-3 or day-5 embryo). Also gives the estimated conception date, ' +
    'full-term date, how far along you are on a given day (weeks + days, trimester, days to go) and a dated timeline of common ' +
    `milestones (weeks 4–42), optionally with Hijri dates. Estimate only, not medical advice. Web version: ${webUrl('due-date')}`,
  inputSchema: z.object({
    method: z.enum(['lmp', 'conception', 'ivf']).optional().default('lmp').describe('lmp = first day of last period; conception; ivf = embryo transfer date.'),
    date: z.string().describe('The date for that method, YYYY-MM-DD.'),
    cycleLength: z.number().int().min(20).max(45).optional().default(28).describe('lmp: average cycle length in days (default 28).'),
    ivfEmbryoDay: z.union([z.literal(3), z.literal(5)]).optional().default(5).describe('ivf: embryo age at transfer, day 3 or day 5.'),
    today: z.string().optional().describe('Work out progress on this date, YYYY-MM-DD (default today).'),
    hijri: z.boolean().optional().default(false).describe('Also give Umm al-Qura Hijri dates.'),
  }),
  outputSchema: z.object({
    dueDate: z.string(), dueDateLong: z.string(), dueDateHijri: z.string().optional(), dueDateHijriArabic: z.string().optional(),
    conception: z.string(), fullTermFrom: z.string(), equivalentLastPeriod: z.string(),
    status: z.string(),
    progress: z.object({ weeks: z.number(), days: z.number(), totalDays: z.number(), trimester: z.number(), daysToGo: z.number(), percent: z.number() }).optional(),
    milestones: z.array(z.object({ week: z.number(), date: z.string(), hijri: z.string().optional(), text: z.string(), past: z.boolean() })),
    method: z.string(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { method: 'lmp', date: '2026-01-01', today: '2026-03-01' }, note: 'due 2026-10-08, 8 weeks 3 days, 1st trimester' }],
  run(input) {
    const z0 = dfc(parseOr(input.date, 'date'));
    const e = estimate(input.method, z0, input.cycleLength, input.ivfEmbryoDay), now = dfc(parseOr(input.today, 'today')), p = progress(e.start, now);
    const status = p.days < 0 ? 'That date is in the future. Check the date you entered.' : p.days > 301 ? 'This due date has passed.'
      : 'Today you are ' + plural(p.weeks, 'week') + ' and ' + plural(p.rest, 'day') + ' (' + p.weeks + '+' + p.rest + ').';
    const out: Record<string, unknown> = {
      dueDate: iso(cfd(e.due)), dueDateLong: nice(cfd(e.due), true),
      ...(input.hijri ? { dueDateHijri: hijriText(cfd(e.due)), dueDateHijriArabic: hijriText(cfd(e.due), 'ar-SA') } : {}),
      conception: iso(cfd(e.conception)), fullTermFrom: iso(cfd(e.start + 259)), equivalentLastPeriod: iso(cfd(e.start)), status,
    };
    if (p.days >= 0 && p.days <= 301) {
      out.progress = { weeks: p.weeks, days: p.rest, totalDays: p.days, trimester: p.tri, daysToGo: p.left, percent: Math.min(100, Math.round((p.days / 280) * 100)) };
    }
    out.milestones = MILESTONES.map(([w, d, text]) => {
      const dz = e.start + w * 7 + d;
      return { week: w, date: iso(cfd(dz)), ...(input.hijri ? { hijri: hijriText(cfd(dz)) } : {}), text, past: dz <= now && p.days >= 0 };
    });
    out.method = HOW[input.method];
    out.summary = 'Estimated due date: ' + nice(cfd(e.due), true) + (input.hijri ? ' (' + hijriText(cfd(e.due)) + ')' : '') +
      (p.days >= 0 && p.days <= 301 ? '\nToday: ' + p.weeks + ' weeks ' + p.rest + ' days, trimester ' + p.tri : '') +
      '\nEstimated conception: ' + nice(cfd(e.conception), true) + '\n(' + HOW[input.method] + ' Estimate only, not medical advice.)';
    return out;
  },
});

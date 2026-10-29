import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';

// Ported from https://github.com/s3eidat/sleep-calc (app.js): minutes-of-day arithmetic (mod 24 h).
const DAY = 1440;
export const mod = (m: number) => ((m % DAY) + DAY) % DAY;
export function toMin(t: string | undefined) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; }
export function fmt(m: number, h12: boolean) {
  m = mod(Math.round(m));
  const hh = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  if (!h12) return String(hh).padStart(2, '0') + ':' + mm;
  return (hh % 12 || 12) + ':' + mm + ' ' + (hh < 12 ? 'AM' : 'PM');
}
/** Bedtimes for a wake-up time: wake − n cycles − fall-asleep time. */
export const bedtimes = (wake: number, cycles: number[], fall: number, cyc: number) => cycles.map((n) => ({ n, at: mod(wake - n * cyc - fall), sleep: n * cyc }));
/** Wake times for a bedtime: bed + fall-asleep time + n cycles. */
export const wakeTimes = (bed: number, cycles: number[], fall: number, cyc: number) => cycles.map((n) => ({ n, at: mod(bed + fall + n * cyc), sleep: n * cyc }));
export function dur(m: number) { const hh = Math.floor(m / 60), mm = m % 60; return hh + ' h' + (mm ? ' ' + mm + ' min' : ''); }
const LABELS: Record<number, string> = { 6: 'Full night', 5: 'Recommended', 4: 'Short night', 3: 'Bare minimum' };

export default defineTool({
  name: 'calc_sleep',
  title: 'Sleep cycle calculator',
  webSlug: 'sleep-calc',
  description:
    'Sleep in whole cycles so you wake in light sleep: given a wake-up time, the bedtimes for 6, 5, 4 or 3 cycles; given a ' +
    'bedtime (or "now"), the wake-up times. Defaults: 90-minute cycles (70–110) and 15 minutes to fall asleep (0–60). ' +
    'With mode "bed"/"now" it also lists nap alarms (20, 30, 60 min and one full cycle). 12- or 24-hour clock. ' +
    `Web version: ${webUrl('sleep-calc')}`,
  inputSchema: z.object({
    mode: z.enum(['wake', 'bed', 'now']).optional().default('wake').describe('wake: I must wake at "time"; bed: I go to bed at "time"; now: I go to bed now (server clock).'),
    time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('"HH:MM" 24 h: the wake-up time (wake) or bedtime (bed). Default 07:00 / 23:00.'),
    fallAsleepMinutes: z.number().int().min(0).max(60).optional().default(15).describe('Minutes it takes you to fall asleep.'),
    cycleMinutes: z.number().int().min(70).max(110).optional().default(90).describe('Length of one sleep cycle.'),
    clock: z.enum(['12', '24']).optional().default('12').describe('12-hour (AM/PM) or 24-hour times in the output.'),
  }),
  outputSchema: z.object({
    title: z.string(),
    options: z.array(z.object({ cycles: z.number(), label: z.string(), time: z.string(), time24: z.string(), sleep: z.string(), sleepMinutes: z.number() })),
    naps: z.array(z.object({ minutes: z.number(), name: z.string(), about: z.string(), wakeAt: z.string() })).optional(),
    note: z.string(), summary: z.string(),
  }),
  annotations: { ...ANNOTATIONS, idempotentHint: false },
  examples: [{ input: { mode: 'wake', time: '07:00', clock: '24' }, note: 'bed at 21:45 (6 cycles), 23:15 (5), 00:45 (4), 02:15 (3)' }],
  run(input) {
    const n = [6, 5, 4, 3], h12 = input.clock === '12', fall = input.fallAsleepMinutes, cyc = input.cycleMinutes;
    let ref: number, title: string, list;
    if (input.mode === 'now') { const d = new Date(); ref = d.getHours() * 60 + d.getMinutes(); }
    else {
      const t = toMin(input.time ?? (input.mode === 'wake' ? '07:00' : '23:00'));
      if (t == null) throw new ToolError('"time" must be HH:MM between 00:00 and 23:59.');
      ref = t;
    }
    if (input.mode === 'wake') { list = bedtimes(ref, n, fall, cyc); title = 'To wake up at ' + fmt(ref, h12) + ', go to bed at'; }
    else { list = wakeTimes(ref, n, fall, cyc); title = input.mode === 'now' ? 'Going to bed now (' + fmt(ref, h12) + '), wake up at' : 'Going to bed at ' + fmt(ref, h12) + ', wake up at'; }
    const out: Record<string, unknown> = {
      title,
      options: list.map((x) => ({ cycles: x.n, label: LABELS[x.n], time: fmt(x.at, h12), time24: fmt(x.at, false), sleep: dur(x.sleep), sleepMinutes: x.sleep })),
    };
    if (input.mode !== 'wake') {
      const naps: [number, string, string][] = [[20, 'Power nap', 'Light sleep only; a quick boost without grogginess'], [30, 'Short nap', 'Can leave you groggy for a few minutes'],
        [60, 'Hour nap', 'Reaches deep sleep: helps memory, but expect some grogginess'], [cyc, 'Full cycle', 'One whole cycle, waking in lighter sleep']];
      out.naps = naps.map((x) => ({ minutes: x[0], name: x[1], about: x[2], wakeAt: fmt(ref + fall + x[0], h12) }));
    }
    out.note = 'Includes ' + fall + ' minutes to fall asleep and ' + cyc + '-minute cycles. ' + (input.mode === 'wake' ? 'Times are counted back from your alarm.' : 'Set your alarm for one of these.');
    out.summary = title + ': ' + list.map((x) => fmt(x.at, h12) + ' (' + x.n + ' cycles, ' + dur(x.sleep) + ')').join(', ');
    return out;
  },
});

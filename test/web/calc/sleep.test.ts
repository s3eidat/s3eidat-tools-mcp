import { describe, expect, it } from 'vitest';
import tool, { bedtimes, dur, fmt, toMin, wakeTimes } from '../../../src/tools/web/calc/sleep-calc.js';
import { run } from './_run.js';

describe('calc_sleep (sleep-calc self-test)', () => {
  it('matches the website known answers', () => {
    const b = bedtimes(toMin('07:00')!, [6, 5, 4], 15, 90), w = wakeTimes(toMin('23:00')!, [6, 5, 4], 15, 90), z = wakeTimes(toMin('00:10')!, [5], 0, 90);
    expect([fmt(b[0].at, false), fmt(b[1].at, false), fmt(b[2].at, false), b[1].sleep]).toEqual(['21:45', '23:15', '00:45', 450]);
    expect([fmt(w[0].at, false), fmt(w[1].at, false), fmt(w[2].at, false), fmt(z[0].at, false)]).toEqual(['08:15', '06:45', '05:15', '07:40']);
    expect([fmt(1305, true), fmt(45, true), fmt(720, true), fmt(-30, false)]).toEqual(['9:45 PM', '12:45 AM', '12:00 PM', '23:30']);
    expect([dur(450), dur(540), toMin('24:00')]).toEqual(['7 h 30 min', '9 h', null]);
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { mode: 'wake', time: '06:30' });
    expect(r.options.map((o: { time: string }) => o.time)).toEqual(['9:15 PM', '10:45 PM', '12:15 AM', '1:45 AM']);
    expect(r.options[1]).toMatchObject({ cycles: 5, label: 'Recommended', sleep: '7 h 30 min' });
    expect(r.naps).toBeUndefined();
    const b = await run(tool, { mode: 'bed', time: '23:00', clock: '24', cycleMinutes: 100, fallAsleepMinutes: 10 });
    expect(b.options[0].time).toBe('09:10');
    expect(b.naps[3]).toMatchObject({ minutes: 100, wakeAt: '00:50' });
    const now = await run(tool, { mode: 'now' });
    expect(now.options).toHaveLength(4);
  });
});

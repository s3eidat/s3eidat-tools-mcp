import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import clock, { fmtDiff, fmtOffset, kind, resolve, workingOverlap } from '../../../src/tools/web/everyday/world-clock.js';
import { offsetMin, parts, zoneMidnight } from '../../../src/tools/web/everyday/_time.js';

// Known answers copied from world-clock's S3_SELFTEST.
describe('time_world_clock (world-clock self-test)', () => {
  const jan = new Date(Date.UTC(2026, 0, 15, 12)), jul = new Date(Date.UTC(2026, 6, 15, 12));
  it('zone maths', () => {
    expect([offsetMin('Asia/Tokyo', jan), offsetMin('UTC', jan), offsetMin('Asia/Kolkata', jan)]).toEqual([540, 0, 330]);
    expect([offsetMin('America/New_York', jan), offsetMin('America/New_York', jul), offsetMin('Europe/London', jul)]).toEqual([-300, -240, 60]);
    const p = parts('Asia/Tokyo', jan);
    expect([p.hour, p.day, p.minute]).toEqual([21, 15, 0]);
    expect(workingOverlap(['Europe/London', 'America/New_York'], Date.UTC(2026, 0, 15, 0)).join(',')).toBe('14,15,16');
    expect(fmtOffset(330)).toBe('UTC+5:30');
    expect(fmtOffset(-300)).toBe('UTC−5');
    expect(fmtDiff(-90)).toBe('−1h 30m');
    expect([kind(9), kind(17), kind(23)]).toEqual(['work', 'awake', 'night']);
    expect(resolve('Mecca')).toBe('Asia/Riyadh');
    expect(resolve('america/chicago')).toBe('America/Chicago');
    expect(new Date(zoneMidnight('America/New_York', 2026, 3, 8)).toISOString()).toBe('2026-03-08T05:00:00.000Z'); // DST day
    expect(new Date(zoneMidnight('Asia/Amman', 2026, 1, 15)).toISOString()).toBe('2026-01-14T21:00:00.000Z');
  });
  it('runs as a tool', async () => {
    type Out = { homeZone: string; clocks: { zone: string; time: string; offset: string; diff: string; workingHours: boolean }[]; planner: { overlapHours: number[]; overlapUtc: string[]; rows: { hours: { label: string; band: string }[] }[] } };
    const r = await call<Out>(clock, { zones: ['Europe/London', 'New York', 'Tokyo'], at: '2026-01-15T12:00:00Z' });
    expect(r.homeZone).toBe('Europe/London');
    expect(r.clocks.map((c) => c.zone)).toEqual(['Europe/London', 'America/New_York', 'Asia/Tokyo']);
    expect(r.clocks.map((c) => c.time)).toEqual(['12:00:00', '07:00:00', '21:00:00']);
    expect(r.clocks.map((c) => c.diff)).toEqual(['home', '−5h', '+9h']);
    expect(r.clocks[0].workingHours).toBe(true);
    expect(r.planner.overlapHours).toEqual([]);
    expect(r.planner.rows[2].hours[0]).toEqual({ label: '9', band: 'work' });
    const two = await call<Out>(clock, { zones: ['Europe/London', 'America/New_York'], at: '2026-01-15T12:00:00Z', hour12: true });
    expect(two.planner.overlapUtc).toEqual(['2026-01-15T14:00:00.000Z', '2026-01-15T15:00:00.000Z', '2026-01-15T16:00:00.000Z']);
    expect(two.clocks[1].time).toBe('7:00:00 AM');
    await expect(call(clock, { zones: ['Nowhere Land'] })).rejects.toThrow(/No time zone/);
  });
});

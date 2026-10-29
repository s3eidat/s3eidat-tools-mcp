import { describe as group, expect, it } from 'vitest';
import tool, { describe, nextRuns, parse } from '../../../src/tools/web/dev/cron.js';
import { call } from '../../helpers.js';

const D = (e: string) => describe(parse(e));
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo, d, h, mi);
const FROM = at(2026, 9, 26, 9, 0); // Monday 26 Oct 2026 09:00 (wall clock, UTC here)

group('cron-explain self-test', () => {
  it('describes', () => {
    const cases: Record<string, string> = {
      '* * * * *': 'Every minute',
      '*/5 * * * *': 'Every 5 minutes',
      '0 9 * * 1-5': 'At 09:00, on Monday through Friday',
      '30 8 * * MON': 'At 08:30, on Monday',
      '0 9,21 * * *': 'At 09:00 and 21:00',
      '*/15 9-17 * * *': 'Every 15 minutes, between 09:00 and 17:59',
      '0 0 1 */3 *': 'At 00:00, on day 1 of the month, every 3rd month',
      '5 */2 * * *': 'At minute 5 past every 2nd hour',
      '0 0 13 * 5': 'At 00:00, on day 13 of the month or on Friday',
      '@daily': 'At 00:00',
    };
    for (const [k, v] of Object.entries(cases)) expect(D(k)).toBe(v);
    expect(describe(parse('30 21 * * *'), true)).toBe('At 9:30 PM');
  });
  it('next runs', () => {
    expect(nextRuns(parse('30 8 * * 1'), FROM, 2)).toEqual([at(2026, 10, 2, 8, 30), at(2026, 10, 9, 8, 30)]);
    expect(nextRuns(parse('0 0 29 2 *'), FROM, 1)[0]).toBe(at(2028, 1, 29));
    expect(nextRuns(parse('0 0 13 * 5'), FROM, 1)[0]).toBe(at(2026, 9, 30));
    expect(nextRuns(parse('0 0 */2 * 5'), FROM, 1)[0]).toBe(at(2026, 10, 13));
    expect(nextRuns(parse('0 0 31 2 *'), FROM, 1)).toHaveLength(0);
    expect(nextRuns(parse('*/20 * * * *'), FROM, 3).map((t) => new Date(t).getUTCMinutes())).toEqual([20, 40, 0]);
  });
  it('parses and rejects', () => {
    expect(parse('0 0 * * 7').fields!.dow.set[0]).toBe(true);
    const bad = parse('60 25 * * *');
    expect(bad.ok).toBe(false);
    expect(bad.errors.minute && bad.errors.hour && !bad.errors.dom).toBeTruthy();
    expect(parse('0 0 0 * * *').ok).toBe(false);
    expect(parse('0 0 L * *').ok).toBe(false);
    expect(parse('@reboot').reboot).toBe(true);
  });
});

group('cron_explain tool', () => {
  it('lists runs in a timezone', async () => {
    const r = await call<Record<string, any>>(tool, { expression: '30 8 * * MON', count: 2, timezone: 'Asia/Amman', from: '2026-10-26T06:00:00Z' });
    expect(r.description).toBe('At 08:30, on Monday.');
    // 09:00 in Amman (UTC+3) is after 08:30, so the next is the following Monday
    expect(r.nextRuns.map((x: { iso: string }) => x.iso)).toEqual(['2026-11-02T08:30:00+03:00', '2026-11-09T08:30:00+03:00']);
    expect(r.nextRuns[0].utc).toBe('2026-11-02T05:30:00.000Z');
  });
  it('handles DST in New York', async () => {
    const r = await call<Record<string, any>>(tool, { expression: '0 12 * * *', count: 2, timezone: 'America/New_York', from: '2026-10-31T12:00:00Z' });
    expect(r.nextRuns.map((x: { utc: string }) => x.utc)).toEqual(['2026-10-31T16:00:00.000Z', '2026-11-01T17:00:00.000Z']);
  });
  it('reports errors', async () => {
    const r = await call<Record<string, any>>(tool, { expression: '60 25 * * *', timezone: 'UTC' });
    expect(r.valid).toBe(false);
    expect(r.errors.minute).toBe('Minute: 60 is out of range (0–59)');
    expect((await call<Record<string, any>>(tool, { expression: '0 0 * * * *', timezone: 'UTC' })).error).toMatch(/Quartz/);
  });
});

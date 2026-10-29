import { describe, expect, it } from 'vitest';
import tool, { isoWeek, parseTs, rel } from '../../../src/tools/web/dev/time-convert.js';
import { fmtOffset, isoInZone, tzOffset, wallToEpoch } from '../../../src/tools/web/dev/_tz.js';
import { call } from '../../helpers.js';

describe('timestamp-convert self-test', () => {
  it('parses timestamps', () => {
    let r = parseTs('1700000000');
    expect(r.unit).toBe('s');
    expect(new Date(r.ms).toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(parseTs('1700000000123')).toEqual({ unit: 'ms', ms: 1700000000123 });
    r = parseTs('1700000000123456');
    expect(r.unit).toBe('us');
    expect(Math.abs(r.ms - 1700000000123.456)).toBeLessThan(1e-3);
    r = parseTs('1700000000123456789');
    expect([r.unit, Math.floor(r.ms)]).toEqual(['ns', 1700000000123]);
    expect(parseTs('-86400').ms).toBe(-86400000);
    expect(parseTs('1,700,000,000').ms).toBe(1.7e12);
    expect(parseTs('0').ms).toBe(0);
    expect(parseTs('1700000000', 'ms').ms).toBe(1700000000);
    expect(() => parseTs('12abc')).toThrow();
  });
  it('timezones and weeks', () => {
    expect(tzOffset(Date.UTC(2026, 0, 15, 12), 'America/New_York')).toBe(-5 * 3600e3);
    expect(tzOffset(Date.UTC(2026, 6, 15, 12), 'America/New_York')).toBe(-4 * 3600e3);
    expect(tzOffset(Date.UTC(2026, 6, 1), 'Asia/Kolkata')).toBe(5.5 * 3600e3);
    expect(wallToEpoch(2026, 7, 1, 9, 0, 0, 'Asia/Tokyo')).toBe(Date.UTC(2026, 6, 1, 0, 0));
    expect(wallToEpoch(2026, 1, 15, 12, 0, 0, 'America/New_York')).toBe(Date.UTC(2026, 0, 15, 17));
    expect(wallToEpoch(2026, 7, 15, 12, 0, 0, 'America/New_York')).toBe(Date.UTC(2026, 6, 15, 16));
    expect(fmtOffset(-3.5 * 3600e3)).toBe('UTC−03:30');
    expect(isoWeek(Date.UTC(2021, 0, 3, 12), 'UTC')).toEqual({ week: 53, doy: 3 });
    expect(isoWeek(Date.UTC(2026, 9, 26, 12), 'UTC').week).toBe(44);
    expect(isoInZone(Date.UTC(2023, 10, 14, 22, 13, 20), 'Asia/Kolkata')).toBe('2023-11-15T03:43:20+05:30');
    expect(rel(0, 3 * 3600e3)).toBe('3 hours ago');
  });
});

describe('time_convert tool', () => {
  it('converts a timestamp', async () => {
    const r = await call(tool, { value: 1700000000, timezone: 'America/New_York', zones: ['UTC', 'Asia/Tokyo'], now: 1700000000000 + 2 * 86400e3 });
    expect(r).toMatchObject({
      detectedUnit: 'seconds', unixSeconds: 1700000000, iso: '2023-11-14T22:13:20.000Z', utc: 'Tue, 14 Nov 2023 22:13:20 GMT',
      localIso: '2023-11-14T17:13:20-05:00', offset: 'UTC−05:00', relative: '2 days ago', dayOfYear: 318, isoWeek: 46,
    });
    expect((r.zones as { iso: string }[]).map((z) => z.iso)).toEqual(['2023-11-14T22:13:20Z', '2023-11-15T07:13:20+09:00']);
  });
  it('reads wall-clock and ISO input', async () => {
    expect(await call(tool, { value: '2026-07-01T09:00', timezone: 'Asia/Tokyo' })).toMatchObject({ unixSeconds: 1782864000 });
    expect(await call(tool, { value: '2026-10-26T14:30:00Z', timezone: 'UTC' })).toMatchObject({ unixMilliseconds: Date.UTC(2026, 9, 26, 14, 30) });
    await expect(call(tool, { value: 'yesterday-ish' })).rejects.toThrow(/Couldn't read/);
    await expect(call(tool, { value: 0, timezone: 'Mars/Base' })).rejects.toThrow(/Unknown timezone/);
  });
});

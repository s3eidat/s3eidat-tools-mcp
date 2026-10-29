import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import prayer, { KEYS, compute, nextOf } from '../../../src/tools/web/everyday/prayer-times.js';
import { addDays } from '../../../src/tools/web/everyday/_adhan.js';
import { ymdIn } from '../../../src/tools/web/everyday/_time.js';

// Vectors produced by the website's own lib/adhan.min.js with the website's params() (one per method, plus
// high-latitude and southern cases). The port matched that build on 405,132 times in a scratch comparison.
const VECTORS: [number, number, string, string, 'shafi' | 'hanafi', string[]][] = [
  [31.9539, 35.9106, '2026-03-01', 'jordan', 'shafi', ['03-01 02:43', '03-01 04:04', '03-01 09:49', '03-01 13:06', '03-01 15:39', '03-01 16:55']],
  [21.4225, 39.8262, '2026-06-21', 'ummalqura', 'shafi', ['06-21 01:11', '06-21 02:39', '06-21 09:22', '06-21 12:42', '06-21 16:06', '06-21 17:36']],
  [51.5074, -0.1278, '2026-06-21', 'mwl', 'shafi', ['06-21 02:40', '06-21 03:43', '06-21 12:03', '06-21 16:25', '06-21 20:22', '06-21 21:25']],
  [30.0444, 31.2357, '2026-12-21', 'egyptian', 'hanafi', ['12-21 03:14', '12-21 04:47', '12-21 09:54', '12-21 13:23', '12-21 14:59', '12-21 16:23']],
  [40.7128, -74.006, '2026-01-15', 'isna', 'shafi', ['01-15 10:58', '01-15 12:18', '01-15 17:07', '01-15 19:35', '01-15 21:53', '01-15 23:14']],
  [24.8607, 67.0011, '2026-04-10', 'karachi', 'hanafi', ['04-09 23:57', '04-10 01:15', '04-10 07:34', '04-10 12:05', '04-10 13:52', '04-10 15:10']],
  [25.2048, 55.2708, '2026-08-01', 'dubai', 'shafi', ['08-01 00:21', '08-01 01:43', '08-01 08:28', '08-01 11:55', '08-01 15:07', '08-01 16:29']],
  [29.3759, 47.9774, '2026-02-02', 'kuwait', 'shafi', ['02-02 02:16', '02-02 03:37', '02-02 09:02', '02-02 12:06', '02-02 14:27', '02-02 15:46']],
  [25.2854, 51.531, '2026-05-05', 'qatar', 'shafi', ['05-05 00:32', '05-05 01:55', '05-05 08:31', '05-05 11:59', '05-05 15:06', '05-05 16:36']],
  [41.0082, 28.9784, '2026-09-09', 'turkey', 'hanafi', ['09-09 02:03', '09-09 03:31', '09-09 10:06', '09-09 14:36', '09-09 16:31', '09-09 17:53']],
  [3.139, 101.6869, '2026-11-11', 'singapore', 'shafi', ['11-10 21:38', '11-10 22:58', '11-11 04:59', '11-11 08:20', '11-11 10:57', '11-11 12:09']],
  [35.6892, 51.389, '2026-07-07', 'tehran', 'shafi', ['07-06 23:40', '07-07 01:25', '07-07 08:39', '07-07 12:28', '07-07 16:14', '07-07 17:13']],
  [56, -3.2, '2026-06-15', 'moonsighting', 'shafi', ['06-15 02:31', '06-15 03:26', '06-15 12:18', '06-15 16:46', '06-15 21:04', '06-15 21:56']],
  [-33.8688, 151.2093, '2026-06-21', 'mwl', 'shafi', ['06-20 19:31', '06-20 21:00', '06-21 01:58', '06-21 04:36', '06-21 06:54', '06-21 08:18']],
  [-54.8, -68.3, '2026-12-21', 'mwl', 'shafi', ['12-21 04:31', '12-21 07:51', '12-21 16:32', '12-21 21:01', '12-22 01:11', '12-22 04:32']],
];
const ymd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };

describe('prayer_times (prayer-times self-test)', () => {
  it('matches the website build of adhan.js for every method', () => {
    for (const [lat, lon, date, method, madhab, want] of VECTORS) {
      const t = compute(lat, lon, ymd(date), method, madhab);
      expect(KEYS.map((k) => t[k].toISOString().slice(5, 16).replace('T', ' ')), `${method} ${date}`).toEqual(want);
    }
  });
  it('known value and method facts', () => {
    const mine = compute(31.9539, 35.9106, ymd('2026-01-15'), 'mwl', 'shafi');
    expect(mine.dhuhr.toISOString().slice(11, 16)).toBe('09:47');
    const places: [number, number, string][] = [[31.9539, 35.9106, 'jordan'], [21.4225, 39.8262, 'ummalqura'], [51.5074, -0.1278, 'mwl'], [30.0444, 31.2357, 'egyptian'], [-33.8688, 151.2093, 'mwl'], [40.7128, -74.006, 'isna']];
    for (const c of places) for (const d of ['2026-01-15', '2026-06-21', '2026-12-21']) for (const mh of ['shafi', 'hanafi'] as const) {
      const x = compute(c[0], c[1], ymd(d), c[2], mh);
      for (let i = 1; i < KEYS.length; i++) expect(x[KEYS[i - 1]] < x[KEYS[i]]).toBe(true);
    }
    const mk = compute(21.4225, 39.8262, ymd('2026-03-01'), 'ummalqura', 'shafi');
    expect(mk.isha.getTime() - mk.maghrib.getTime()).toBe(90 * 60000);
    const jo = compute(31.9539, 35.9106, ymd('2026-03-01'), 'jordan', 'shafi'), mw = compute(31.9539, 35.9106, ymd('2026-03-01'), 'mwl', 'shafi');
    expect(jo.maghrib.getTime() - mw.maghrib.getTime()).toBe(5 * 60000);
    expect(jo.isha > mw.isha && jo.fajr <= mw.fajr).toBe(true);
    expect(compute(31.9539, 35.9106, ymd('2026-03-01'), 'jordan', 'hanafi').asr > jo.asr).toBe(true);
    const n1 = nextOf(mine, mine, new Date(mine.dhuhr.getTime() + 1000)), n2 = nextOf(mine, { fajr: new Date(1) }, new Date(mine.isha.getTime() + 1000));
    expect([n1.key, n2.key, n2.tomorrow]).toEqual(['asr', 'fajr', true]);
    expect(addDays({ y: 2026, m: 12, d: 31 }, 1)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(ymdIn('Asia/Tokyo', new Date(Date.UTC(2026, 0, 15, 20))).d).toBe(16);
  });
  it('runs as a tool', async () => {
    type Out = { place: string; method: { id: string }; asr: string; highLatitudeRule: string | null; days: { date: string; hijri: string; times: Record<string, string>; utc: Record<string, string> }[]; next: { prayer: string; tomorrow: boolean; countdown: string } };
    const r = await call<Out>(prayer, { city: 'amman', date: '2026-01-15', method: 'mwl', now: '2026-01-15T09:48:00Z' });
    expect(r.place).toBe('Amman');
    expect(r.days[0].times.dhuhr).toBe('12:47');
    expect(r.days[0].utc.dhuhr).toBe('2026-01-15T09:47:00.000Z');
    expect(r.days[0].hijri).toMatch(/1447/);
    expect(r.next.prayer).toBe('asr');
    expect(r.next.tomorrow).toBe(false);
    const k = await call<Out>(prayer, { city: 'karachi', date: '2026-04-10' });
    expect([k.method.id, k.asr, k.days[0].utc.asr]).toEqual(['karachi', 'hanafi', '2026-04-10T12:05:00.000Z']);
    const m = await call<Out>(prayer, { latitude: 51.50741, longitude: -0.12779, timezone: 'Europe/London', month: '2026-06', now: '2026-06-21T12:00:00Z' });
    expect(m.days).toHaveLength(30);
    expect(m.highLatitudeRule).toBe('seventhofthenight');
    expect(m.days[20].times).toMatchObject({ fajr: '03:40', isha: '22:25' }); // BST
    await expect(call(prayer, { latitude: 1, longitude: 2 })).rejects.toThrow(/timezone/);
    await expect(call(prayer, { latitude: 1, longitude: 2, timezone: 'Mars/Base' })).rejects.toThrow(/Unknown time zone/);
  });
});

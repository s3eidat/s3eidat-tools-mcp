import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import qibla, { KAABA, angDiff, bearing, distanceKm, point16, point8ar, turn } from '../../../src/tools/web/everyday/qibla-finder.js';

// Known answers copied from qibla-finder's S3_SELFTEST.
describe('qibla_direction (qibla-finder self-test)', () => {
  const amman = bearing(31.9539, 35.9106, KAABA.lat, KAABA.lon), london = bearing(51.5074, -0.1278, KAABA.lat, KAABA.lon);
  it('bearings and distances', () => {
    expect(Math.abs(amman - 160.71)).toBeLessThan(0.05);
    expect(Math.abs(london - 118.99)).toBeLessThan(0.1);
    expect(Math.abs(bearing(40.7128, -74.006, KAABA.lat, KAABA.lon) - 58.48)).toBeLessThan(0.1);
    const jak = bearing(-6.2088, 106.8456, KAABA.lat, KAABA.lon);
    expect(Math.abs(jak - 295.15)).toBeLessThan(0.2);
    const dA = distanceKm(31.9539, 35.9106, KAABA.lat, KAABA.lon);
    expect(dA > 1225 && dA < 1245).toBe(true);
    expect(distanceKm(KAABA.lat, KAABA.lon, KAABA.lat, KAABA.lon)).toBeLessThan(1e-6);
    expect([point16(amman), point16(359), point16(london)]).toEqual(['SSE', 'N', 'ESE']);
    expect(point8ar(amman)).toBe('جنوب'); // south
    expect(point8ar(jak)).toBe('شمال غرب'); // north-west
    expect(turn(160.7).dir).toBe('right');
    expect(turn(300)).toEqual({ dir: 'left', deg: 60 });
    expect(angDiff(10, 350)).toBe(20);
    expect(angDiff(350, 10)).toBe(-20);
  });
  it('runs as a tool', async () => {
    const r = await call<{ bearing: number; direction: string; distanceKm: number; place: string; fromHeading: { turn: string; degrees: number } }>(
      qibla, { city: 'Amman', heading: 100 });
    expect(r).toMatchObject({ bearing: 160.7, direction: 'SSE', place: 'Amman' });
    expect(r.distanceKm).toBeGreaterThan(1225);
    expect(r.fromHeading).toEqual({ aligned: false, turn: 'right', degrees: 61 });
    const m = await call<{ atKaaba: boolean }>(qibla, { city: 'mecca' });
    expect(m.atKaaba).toBe(true);
    await expect(call(qibla, {})).rejects.toThrow(/latitude/);
  });
});

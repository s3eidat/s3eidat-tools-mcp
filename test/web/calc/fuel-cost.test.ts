import { describe, expect, it } from 'vitest';
import tool, { fromL100, L_PER_GALUK, L_PER_GALUS, num, pricePerLitre, toL100, trip } from '../../../src/tools/web/calc/fuel-cost.js';
import { fails, run } from './_run.js';

describe('calc_fuel_cost (fuel-cost self-test)', () => {
  const near = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;
  it('matches the website known answers', () => {
    const t = trip({ km: 100, l100: 8, ppl: 1, people: 4 });
    expect(near(toL100(30, 'mpgus')!, 7.84049) && near(toL100(30, 'mpguk')!, 9.41604) && near(fromL100(7.84049, 'mpgus')!, 30)).toBe(true);
    expect(near(fromL100(toL100(42.5, 'mpguk')!, 'mpgus')!, (42.5 * L_PER_GALUS) / L_PER_GALUK)).toBe(true);
    expect(near(toL100(20, 'kml')!, 5) && near(fromL100(5, 'kml')!, 20)).toBe(true);
    expect(near(fromL100(toL100(55, 'mpgus')!, 'mpguk')!, 66.05, 0.01)).toBe(true);
    expect(near(235.2146 / 10, fromL100(10, 'mpgus')!)).toBe(true);
    expect(near(pricePerLitre(3.785411784, 'galUS'), 1) && near(pricePerLitre(4.54609, 'galUK'), 1) && pricePerLitre(2, 'L') === 2).toBe(true);
    expect(near(t.litres, 8) && near(t.cost, 8) && near(t.each, 2) && near(t.perKm, 0.08)).toBe(true);
    expect([toL100(0, 'l100'), toL100(-5, 'kml'), num('7,5'), num('\u0661\u0660'), num('x')]).toEqual([null, null, 7.5, 10, null]);
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { distance: 335, roundTrip: true, price: '0.90', consumption: 10.5, people: 3, currency: 'JD', name: 'Family SUV',
      compare: { consumption: 50, consumptionUnit: 'mpgus', name: 'Hybrid' } });
    expect(r).toMatchObject({ distanceKm: 670, litres: 70.35, cost: 63.32, costEach: 21.11, l100km: 10.5 });
    expect(r.consumptionIn.mpgus).toBe(22.4);
    expect(r.compare).toMatchObject({ name: 'Hybrid', cheaper: 'Hybrid' });
    expect(r.summary).toMatch(/^Trip: 670 km \(round trip\), Family SUV at 10.5 L\/100 km: 70.4 L = JD 63.32 \(JD 21.11 each for 3\)/);
    const g = await run(tool, { distance: 100, distanceUnit: 'mi', price: 3.5, priceUnit: 'galUS', consumption: 30, consumptionUnit: 'mpgus' });
    expect(g.cost).toBeCloseTo(11.67, 2);
    expect(g.gallons).toBeCloseTo(3.33, 2);
    await fails(tool, { distance: 0, price: 1, consumption: 5 }, /distance/);
  });
});

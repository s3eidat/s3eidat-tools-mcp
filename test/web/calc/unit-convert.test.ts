import { describe, expect, it } from 'vitest';
import tool, { cat, convert, fmt, parseQuery, unit, type Unit } from '../../../src/tools/web/calc/unit-convert.js';
import { fails, run } from './_run.js';

describe('calc_unit_convert (unit-convert self-test)', () => {
  const U = (c: string, s: string) => unit(cat(c)!, s) as Unit;
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  it('matches the website known answers', () => {
    const p = parseQuery('5 km to mi')!, q = parseQuery('72 f in c')!;
    expect(near(convert(100, U('temp', '°C'), U('temp', '°F')), 212)).toBe(true);
    expect(near(convert(-40, U('temp', '°C'), U('temp', '°F')), -40)).toBe(true);
    expect(near(convert(0, U('temp', '°C'), U('temp', 'K')), 273.15)).toBe(true);
    expect(near(convert(491.67, U('temp', '°R'), U('temp', '°C')), 0)).toBe(true);
    expect(near(convert(1, U('length', 'mi'), U('length', 'km')), 1.609344)).toBe(true);
    expect(near(convert(1, U('length', 'ft'), U('length', 'in')), 12)).toBe(true);
    expect(near(convert(1, U('mass', 'lb'), U('mass', 'g')), 453.59237)).toBe(true);
    expect(near(convert(1, U('data', 'GiB'), U('data', 'B')), 1073741824)).toBe(true);
    expect(fmt(convert(1, U('data', 'GB'), U('data', 'GiB')))).toBe('0.9313225746');
    expect(fmt(convert(10, U('fuel', 'L/100km'), U('fuel', 'mpg')))).toBe('23.52145833');
    expect(fmt(convert(1, U('pressure', 'atm'), U('pressure', 'psi')))).toBe('14.69594878');
    expect(near(convert(1, U('energy', 'kWh'), U('energy', 'MJ')), 3.6)).toBe(true);
    expect(near(convert(Math.PI, U('angle', 'rad'), U('angle', '°')), 180)).toBe(true);
    expect(near(convert(1, U('area', 'dunam'), U('area', 'm²')), 1000)).toBe(true);
    expect(near(convert(3, U('cooking', 'tsp'), U('cooking', 'tbsp')), 1)).toBe(true);
    expect(fmt(0.1 + 0.2)).toBe('0.3');
    expect(p.b.sym).toBe('mi');
    expect(fmt(convert(p.v, p.a, p.b))).toBe('3.106855961');
    expect([q.a.sym, q.b.sym]).toEqual(['°F', '°C']);
    expect(fmt(convert(q.v, q.a, q.b))).toBe('22.22222222');
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { query: '5 km to mi' });
    expect(r).toMatchObject({ category: 'length', result: 3.10685596119, formatted: '3.106855961 mi', oneUnit: '1 km = 0.6213711922 mi' });
    const t = await run(tool, { value: 37, from: 'C', to: 'fahrenheit' });
    expect(t.result).toBe(98.6);
    expect(t.oneUnit).toBeUndefined();
    expect(t.note).toMatch(/offsets/);
    const a = await run(tool, { value: '1', from: 'GB', all: true });
    expect(a.all.find((x: { symbol: string }) => x.symbol === 'MiB').formatted).toBe('953.6743164');
    const pt = await run(tool, { value: 2, from: 'cup', to: 'mL', category: 'cooking' });
    expect(pt.result).toBe(473.176473);
    const sq = await run(tool, { value: 1, from: 'acre', to: 'm2' });
    expect(sq.to.symbol).toBe('m²');
    const l = await run(tool, { list: true });
    expect(l.categories).toHaveLength(14);
    await fails(tool, { value: 1, from: 'km', to: 'kg' }, /same category/);
    await fails(tool, { value: 1, from: 'parsec', to: 'km' }, /Unknown unit/);
  });
});

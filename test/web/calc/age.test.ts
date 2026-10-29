import { describe, expect, it } from 'vitest';
import age, { animal, zodiac } from '../../../src/tools/web/calc/age-calc.js';
import { cfd, dfc, diff, hijriParts, parse, weekday, type YMD } from '../../../src/tools/web/calc/_cal.js';
import { fails, run } from './_run.js';

describe('calc_age (age-calc self-test)', () => {
  const D = (s: string) => parse(s) as YMD;
  it('matches the website known answers', () => {
    const a = diff(D('1994-05-15'), D('2026-10-26')), b = diff(D('1990-01-31'), D('1990-02-28'));
    const c = diff(D('2000-02-29'), D('2001-02-28')), e = diff(D('2000-01-31'), D('2000-03-01'));
    const h = hijriParts(D('2000-01-01'))!, r = cfd(dfc(D('1600-02-29')) + 1);
    expect([a.y, a.m, a.d]).toEqual([32, 5, 11]);
    expect([b.y, b.m, b.d]).toEqual([0, 1, 0]);
    expect([c.y, c.m, c.d]).toEqual([1, 0, 0]);
    expect([e.m, e.d]).toEqual([1, 1]);
    expect(dfc(D('2001-01-01')) - dfc(D('2000-01-01'))).toBe(366);
    expect(dfc(D('1970-01-01'))).toBe(0);
    expect(weekday(D('2027-05-15'))).toBe('Saturday');
    expect(weekday(D('2000-01-01'))).toBe('Saturday');
    expect(r).toEqual({ y: 1600, m: 3, d: 1 });
    expect(parse('2023-02-29')).toBeNull();
    expect(parse('2024-02-29')).not.toBeNull();
    expect(zodiac(D('1994-05-15'))).toBe('Taurus ♉');
    expect(zodiac(D('2000-01-19'))).toBe('Capricorn ♑');
    expect(zodiac(D('2000-01-20'))).toBe('Aquarius ♒');
    expect(animal(2020)).toBe('Rat');
    expect([h.y, h.m]).toEqual([1420, 9]);
  });
  it('runs as a tool', async () => {
    const r = await run(age, { birthDate: '1994-05-15', onDate: '2026-10-26', otherBirthDate: '1997-02-28', otherName: 'Sara' });
    expect([r.years, r.months, r.days, r.text]).toEqual([32, 5, 11, '32 years, 5 months, 11 days']);
    expect(r.bornOn.weekday).toBe('Sunday');
    expect(r.nextBirthday).toEqual({ date: '2027-05-15', weekday: 'Saturday', inDays: 201, turning: 33 });
    expect(r.hijri.age).toBe(33);
    expect(r.comparison).toMatch(/^Sara is 2 years, 9 months, 13 days younger than you/);
    const leap = await run(age, { birthDate: '2000-02-29', onDate: '2001-02-28' });
    expect(leap.birthdayToday).toBe(true);
    await fails(age, { birthDate: '2030-01-01', onDate: '2026-01-01' }, /after the "on" date/);
    await fails(age, { birthDate: '2023-02-29' }, /real date/);
  });
});

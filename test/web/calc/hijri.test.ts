import { describe, expect, it } from 'vitest';
import tool, { hijriAge } from '../../../src/tools/web/calc/hijri-converter.js';
import { cfd, dfc, DAYS, fromHijri, hdim, iso, toHijri, wd } from '../../../src/tools/web/calc/_cal.js';
import { fails, run } from './_run.js';

describe('calc_hijri (hijri-converter self-test)', () => {
  const D = (y: number, m: number, d: number) => dfc({ y, m, d });
  const hStart = (y: number, m: number) => fromHijri(y, m, 1)!;
  it('matches the website known answers', () => {
    expect(iso(cfd(fromHijri(1447, 1, 1)!))).toBe('2025-06-26');
    const r = fromHijri(1447, 9, 1)!, rh = toHijri(r);
    expect([rh.y, rh.m, rh.d]).toEqual([1447, 9, 1]);
    expect(iso(cfd(r))).toBe('2026-02-18');
    expect(DAYS[wd(r)]).toBe('Wednesday');
    expect(toHijri(D(2000, 1, 1))).toEqual({ y: 1420, m: 9, d: 24 });
    expect(iso(cfd(fromHijri(1300, 1, 1)!))).toBe('1882-11-12');
    for (let y = 1440; y <= 1450; y++) {
      expect([354, 355]).toContain(hStart(y + 1, 1) - hStart(y, 1));
      for (let m = 1; m <= 12; m++) expect([29, 30]).toContain(hdim(y, m));
    }
    let seed = 12345;
    const lo = D(1883, 1, 1), hi = D(2173, 12, 31);
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 100; i++) {
      const z = lo + rnd(hi - lo), h = toHijri(z);
      expect(fromHijri(h.y, h.m, h.d)).toBe(z);
      const hy = 1301 + rnd(298), hm = 1 + rnd(12), hd = 1 + rnd(29), g = fromHijri(hy, hm, hd);
      expect(g === null ? null : toHijri(g)).toEqual({ y: hy, m: hm, d: hd });
    }
    const a = hijriAge(D(2000, 1, 1), D(2026, 10, 26)), rab2 = hdim(1448, 4);
    expect([a.y, a.m, a.d]).toEqual([27, 7, 15 - 24 + rab2]);
    const b = hijriAge(D(2025, 6, 26), fromHijri(1448, 1, 1)!);
    expect([b.y, b.m, b.d]).toEqual([1, 0, 0]);
    const next = toHijri(b.next!);
    expect([next.m, next.d]).toEqual([1, 1]);
  });
  it('runs as a tool, both ways', async () => {
    const h = await run(tool, { mode: 'to_hijri', date: '2000-01-01', arabicDigits: false });
    expect(h.day.hijri).toMatchObject({ year: 1420, month: 9, day: 24, monthName: 'Ramadan', iso: '1420-09-24', text: 'Saturday, 24 Ramadan 1420 AH' });
    expect(h.day.hijri.arabic).toBe('\u0627\u0644\u0633\u0628\u062a 24 \u0631\u0645\u0636\u0627\u0646 1420 \u0647\u0640');
    expect(h.day.approximate).toBe(false);
    const g = await run(tool, { mode: 'to_gregorian', hijriYear: 1447, hijriMonth: 9, hijriDay: 1 });
    expect(g.day.gregorian).toMatchObject({ date: '2026-02-18', weekday: 'Wednesday', text: 'Wednesday, 18 February 2026' });
    expect(g.day.gregorian.arabic).toContain('\u0661\u0668 ');
    const lev = await run(tool, { mode: 'to_hijri', date: '2026-02-18', gregorianArabicMonths: 'levant', arabicDigits: false });
    expect(lev.day.gregorian.arabic).toContain('18 \u0634\u0628\u0627\u0637 2026');
    const m = await run(tool, { mode: 'month', hijriYear: 1447, hijriMonth: 1 });
    expect(m.month).toMatchObject({ start: '2025-06-26', name: 'Muharram' });
    expect([29, 30]).toContain(m.month.days);
    const a = await run(tool, { mode: 'age', birthDate: '2025-06-26', onDate: iso(cfd(fromHijri(1448, 1, 1)!)) });
    expect(a.age).toMatchObject({ hijriYears: 1, hijriMonths: 0, hijriDays: 0, gregorianYears: 0 });
    expect(a.age.nextHijriBirthday.inDays).toBe(0);
    await fails(tool, { mode: 'to_gregorian', hijriYear: 1200, hijriMonth: 1, hijriDay: 1 }, /1300–1600/);
    const short = [1440, 1441, 1442, 1443].flatMap((y) => Array.from({ length: 12 }, (_, i) => [y, i + 1])).find(([y, mm]) => hdim(y, mm) === 29)!;
    await fails(tool, { mode: 'to_gregorian', hijriYear: short[0], hijriMonth: short[1], hijriDay: 30 }, /has 29 days/);
  });
});

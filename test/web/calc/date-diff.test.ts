import { describe, expect, it } from 'vitest';
import tool, { addBusinessDays, businessDays, WEEKENDS } from '../../../src/tools/web/calc/date-diff.js';
import { addMonths, cfd, dfc, diff, fromHijri, hijriParts, iso, parse, wd, type YMD } from '../../../src/tools/web/calc/_cal.js';
import { run } from './_run.js';

describe('calc_date_diff (date-diff self-test)', () => {
  const D = (s: string) => parse(s) as YMD;
  it('matches the website known answers', () => {
    const mon = dfc(D('2026-10-26')), sat = dfc(D('2026-10-31')), y1 = diff(D('2024-02-29'), D('2025-02-28'));
    const h = hijriParts(D('2000-01-01'))!, back = fromHijri(h.y, h.m, h.d);
    expect(dfc(D('2026-12-31')) - dfc(D('2026-01-01'))).toBe(364);
    expect(dfc(D('2025-01-01')) - dfc(D('2024-01-01'))).toBe(366);
    expect(wd(mon)).toBe(1);
    expect(wd(dfc(D('1970-01-01')))).toBe(4);
    expect(businessDays(mon, sat, WEEKENDS['sat-sun'])).toBe(5);
    expect(businessDays(mon, sat, WEEKENDS['fri-sat'])).toBe(4);
    expect(businessDays(mon, mon + 14, WEEKENDS['sat-sun'])).toBe(10);
    expect(iso(cfd(addBusinessDays(dfc(D('2026-10-30')), 5, WEEKENDS['sat-sun'])))).toBe('2026-11-06');
    expect(iso(cfd(addBusinessDays(dfc(D('2026-11-06')), -5, WEEKENDS['sat-sun'])))).toBe('2026-10-30');
    expect(iso(addMonths(D('2024-01-31'), 1))).toBe('2024-02-29');
    expect(iso(addMonths(D('2023-01-31'), 1))).toBe('2023-02-28');
    expect(iso(addMonths(D('2024-02-29'), 12))).toBe('2025-02-28');
    expect(iso(addMonths(D('2026-11-15'), -11))).toBe('2025-12-15');
    expect([y1.y, y1.m, y1.d]).toEqual([1, 0, 0]);
    expect(iso(cfd(dfc(D('1999-12-31')) + 1))).toBe('2000-01-01');
    expect([h.y, h.m, h.d]).toEqual([1420, 9, 24]);
    expect(iso(cfd(back!))).toBe('2000-01-01');
  });
  it('runs as a tool', async () => {
    const d = await run(tool, { start: '2026-10-26', end: '2027-03-31' });
    expect([d.days, d.text, d.wholeMonths]).toEqual([156, '5 months, 5 days', 5]);
    expect(d.workingDays + d.weekendDays).toBe(156);
    const inc = await run(tool, { start: '2026-10-31', end: '2026-10-26', inclusive: true, weekend: 'sat-sun' });
    expect([inc.days, inc.workingDays, inc.endBeforeStart]).toEqual([6, 5, true]);
    const a = await run(tool, { mode: 'add', date: '2026-10-30', amount: 5, unit: 'business_days', weekend: 'sat-sun' });
    expect(a.result.date).toBe('2026-11-06');
    expect(a.result.weekday).toBe('Friday');
    const m = await run(tool, { mode: 'add', date: '2024-01-31', amount: 1, unit: 'months' });
    expect(m.result.date).toBe('2024-02-29');
    expect(m.note).toMatch(/last day \(29\)/);
    const s = await run(tool, { mode: 'add', date: '2026-01-01', amount: 2, unit: 'weeks', subtract: true });
    expect(s.result.date).toBe('2025-12-18');
  });
});

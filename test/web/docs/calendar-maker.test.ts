import { describe, expect, it } from 'vitest';
import calendar, { cleanEvents, dfc, eventsOn, hijriMonthName, hijriParts, monthCells, namesFor, wd } from '../../../src/tools/web/docs/calendar-maker.js';
import { call, tempCtx } from '../../helpers.js';
import { pdfInfo } from './_helpers.js';

const ctx = tempCtx();
type Out = { path: string; pages: number; from: string; to: string };

// Known answers from calendar-maker's S3_SELFTEST.
describe('calendar maths (calendar-maker self-test)', () => {
  it('weekdays, leading days and rows', () => {
    const a = monthCells(2027, 1, 6), b = monthCells(2027, 1, 0), c = monthCells(2027, 1, 1), f = monthCells(2026, 2, 0), au = monthCells(2026, 8, 0);
    expect(wd(dfc(2027, 1, 1))).toBe(5);
    expect([a.lead, b.lead, c.lead, a.cells[6].d, a.cells[0].m]).toEqual([6, 5, 4, 1, 12]);
    expect([f.lead, f.rows, au.lead, au.rows, monthCells(2026, 8, 6).lead, wd(dfc(2026, 10, 26))]).toEqual([0, 4, 6, 6, 0, 1]);
  });
  it('Hijri via Intl (Umm al-Qura)', () => {
    expect(hijriParts(dfc(2000, 1, 1))).toEqual({ y: 1420, m: 9, d: 24 });
    expect(hijriParts(dfc(2026, 2, 18))).toMatchObject({ m: 9, d: 1 });
    expect(hijriMonthName(dfc(2000, 1, 1)).indexOf('Ram')).toBe(0);
  });
  it('events', () => {
    const evs = cleanEvents([{ date: '2026-02-30', text: 'x' }, { date: '2026-05-01', text: '  ' }, { date: '2026-05-01', text: '<b>x</b>', color: 'javascript:', yearly: 'yes' },
      { date: '2024-02-29', text: 'Leap', yearly: true }, 7]);
    expect(evs).toHaveLength(2);
    expect(evs[1]).toMatchObject({ color: 'teal', yearly: false, text: '<b>x</b>' });
    expect(eventsOn(evs, 2028, 2, 29)).toHaveLength(1);
    expect(eventsOn(evs, 2023, 2, 28)).toHaveLength(0);
  });
  it('locale names', () => {
    expect(namesFor('en').months[0]).toBe('January');
    expect(namesFor('fr').months[1]).toBe('Février');
    expect(() => namesFor('ar')).toThrow(/Latin-script/);
  });
});

describe('doc_calendar tool', () => {
  it('month page with Saturday first, Hijri and events', async () => {
    const r = await call<Out>(calendar, {
      year: 2026, month: 12, hijri: true, title: 'Family calendar',
      events: [{ date: '2026-12-03', text: "Sara's birthday", color: 'purple', yearly: true }, { date: '2026-12-25', text: 'Christmas', yearly: true }],
    }, ctx);
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBe(1);
    expect(info.sizes[0][0]).toBeGreaterThan(info.sizes[0][1]); // landscape
    expect(info.text).toContain('Family calendar');
    expect(info.text).toContain('December 2026');
    expect(info.text.indexOf('SATURDAY')).toBeLessThan(info.text.indexOf('FRIDAY'));
    for (const t of ["Sara's birthday", 'Christmas', 'Jumada II', 'Rajab 1448 AH']) expect(info.text).toContain(t);
  });
  it('several months, and a year page', async () => {
    const r = await call<Out>(calendar, { year: 2026, month: 11, months: 3, weekStart: 1, orientation: 'portrait', paper: 'Letter' }, ctx);
    expect([r.pages, r.from, r.to]).toEqual([3, '2026-11', '2027-01']);
    const info = await pdfInfo(r.path);
    expect(info.sizes[0]).toEqual([612, 792]);
    expect(info.pages[2]).toContain('January 2027');
    const y = await call<Out>(calendar, { view: 'year', year: 2027, events: [{ date: '2027-05-10', text: 'Exam', color: 'red' }] }, ctx);
    const yi = await pdfInfo(y.path);
    expect(yi.pageCount).toBe(1);
    for (const m of ['January', 'June', 'December', '10 May · Exam']) expect(yi.text).toContain(m);
  });
});

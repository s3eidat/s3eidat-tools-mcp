import { describe, expect, it } from 'vitest';
import tool, { estimate, progress } from '../../../src/tools/web/calc/due-date.js';
import { cfd, dfc, hijriText, iso, parse, type YMD } from '../../../src/tools/web/calc/_cal.js';
import { run } from './_run.js';

describe('calc_due_date (due-date self-test)', () => {
  const P = (s: string) => dfc(parse(s) as YMD);
  const I = (z: number) => iso(cfd(z));
  it('matches the website known answers', () => {
    const a = estimate('lmp', P('2026-01-01'), 28, 5), b = estimate('lmp', P('2026-01-01'), 32, 5), c = estimate('conception', P('2026-01-15'), 28, 5);
    const d5 = estimate('ivf', P('2026-01-20'), 28, 5), d3 = estimate('ivf', P('2026-01-20'), 28, 3);
    const p = progress(P('2026-01-01'), P('2026-03-01')), q = progress(0, 98), r = progress(0, 196);
    expect([I(a.due), I(a.conception), I(b.due), I(c.due)]).toEqual(['2026-10-08', '2026-01-15', '2026-10-12', '2026-10-08']);
    expect(d5.due - P('2026-01-20')).toBe(261);
    expect(d3.due - P('2026-01-20')).toBe(263);
    expect([p.days, p.weeks, p.rest, p.tri, q.tri, r.tri]).toEqual([59, 8, 3, 1, 2, 3]);
    expect(I(P('2024-02-29') + 365)).toBe('2025-02-28');
    expect(parse('2026-02-30')).toBeNull();
    expect(hijriText(parse('2000-01-01')!)).toContain('1420');
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { date: '2026-01-01', today: '2026-03-01', hijri: true });
    expect(r).toMatchObject({ dueDate: '2026-10-08', conception: '2026-01-15', fullTermFrom: '2026-09-17', equivalentLastPeriod: '2026-01-01' });
    expect(r.progress).toEqual({ weeks: 8, days: 3, totalDays: 59, trimester: 1, daysToGo: 221, percent: 21 });
    expect(r.milestones).toHaveLength(15);
    expect(r.milestones[0]).toMatchObject({ week: 4, date: '2026-01-29', past: true });
    expect(r.milestones[12]).toMatchObject({ week: 40, date: '2026-10-08', past: false });
    expect(r.dueDateHijri).toBeTruthy();
    const ivf = await run(tool, { method: 'ivf', date: '2026-01-20', ivfEmbryoDay: 3, today: '2025-12-01' });
    expect(ivf.progress).toBeUndefined();
    expect(ivf.status).toMatch(/future/);
  });
});

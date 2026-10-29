import { describe, expect, it } from 'vitest';
import gpa, { cumulative, f2, needed, points, weighted } from '../../../src/tools/web/calc/gpa-calc.js';
import { run } from './_run.js';

describe('calc_gpa (gpa-calc self-test)', () => {
  it('matches the website known answers', () => {
    const s = weighted([{ credits: 3, value: points('4.0', 'A') }, { credits: 3, value: points('4.0', 'B+') }, { credits: 4, value: points('4.0', 'C') }]);
    const c = cumulative(30, 3.2, s), n = needed(c, 3.3, 15);
    const p = weighted([{ credits: 3, value: 90 }, { credits: 3, value: 75 }, { credits: 2, value: NaN }]);
    expect(Math.abs(s.gpa - 2.99)).toBeLessThan(1e-9);
    expect([s.credits, f2(c.gpa), c.credits, f2(n)]).toEqual([10, '3.15', 40, '3.71']);
    expect([p.gpa, p.credits]).toEqual([82.5, 6]);
    expect(points('4.3', 'A+')).toBe(4.3);
    expect(points('5.0', 'B')).toBe(4);
    expect(points('4.0', 'A+')).toBeNaN();
    expect(weighted([]).gpa).toBeNaN();
    expect(f2(cumulative(0, NaN, s).gpa)).toBe('2.99');
    expect(f2(2.675)).toBe('2.68');
  });
  it('runs as a tool', async () => {
    const r = await run(gpa, { courses: [{ credits: 3, grade: 'A' }, { credits: 3, grade: 'b+' }, { credits: 4, grade: 'C' }, { name: 'Lab', credits: 1, grade: 'A+' }],
      previousCredits: 30, previousGpa: 3.2, targetGpa: 3.3, remainingCredits: 15 });
    expect(r.semester).toMatchObject({ gpa: 2.99, credits: 10 });
    expect(r.cumulative).toMatchObject({ gpa: 3.15, credits: 40 });
    expect(r.target).toMatchObject({ status: 'needed', neededAverage: 3.71, letter: 'A' });
    expect(r.skipped).toHaveLength(1);
    const p = await run(gpa, { scale: 'percent', courses: [{ credits: 3, grade: 90 }, { credits: 3, grade: '75' }, { credits: 2, grade: 20 }], targetGpa: 99, remainingCredits: 3 });
    expect(p.semester.display).toBe('82.50%');
    expect(p.target.status).toBe('not_reachable');
    const f = await run(gpa, { scale: '5.0', courses: [{ credits: 3, grade: 'A+' }, { credits: 3, grade: 'B' }] });
    expect(f.semester.gpa).toBe(4.5);
  });
});

import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import check, { estimate, fmtTime, score, spatialMatches } from '../../../src/tools/web/everyday/password-check.js';

// Known answers copied from password-check's S3_SELFTEST, plus exact values from the website's own estimator
// (the port matched the site's app.js on 438 passwords, tips included, in a scratch comparison).
const bits = (p: string) => estimate(p).log2;
const types = (p: string) => estimate(p).seq.map((m) => m.type);

describe('password_check (password-check self-test)', () => {
  it('matches the website self-test', () => {
    expect(bits('password')).toBeLessThan(5);
    expect(types('password')[0]).toBe('common');
    expect(bits('123456')).toBeLessThan(3);
    const lp = estimate('P4ssw0rd');
    expect(lp.log2).toBeLessThan(15);
    expect(lp.seq[0].leet).toBeTruthy();
    expect(bits('drowssap')).toBeLessThan(10);
    expect(bits('abcdefghij')).toBeLessThan(10);
    expect(types('abcdefghij')[0]).toBe('sequence');
    expect(bits('aaaaaaaaaaaa')).toBeLessThan(10);
    expect(types('aaaaaaaaaaaa')[0]).toBe('repeat');
    const sp = spatialMatches(Array.from('wsxedc'));
    expect([sp.length, sp[0].j, sp[1].i]).toEqual([2, 2, 3]);
    expect(bits('wsxedcrfv')).toBeLessThan(30);
    expect(bits('19/07/1994')).toBeLessThan(25);
    expect(types('19/07/1994')[0]).toBe('date');
    expect(types('1994')[0]).toBe('year');
    expect(bits('Summer2024!')).toBeLessThan(40);
    expect(bits('kT9#vQ2$xL7!mR4@')).toBeGreaterThan(80);
    expect(bits('correct horse battery staple')).toBeGreaterThan(50);
    expect(bits('')).toBe(0);
    expect(Math.abs(bits('zq') - Math.log2(26 * 26 + 1))).toBeLessThan(1e-9);
    expect(fmtTime(59)).toBe('59 seconds');
    expect(fmtTime(3600)).toBe('1 hour');
    expect([score(19.9), score(70)]).toEqual([0, 4]);
  });
  it('exact values from the website estimator', () => {
    expect(bits('Summer2024!')).toBeCloseTo(26.601502404993134, 12);
    expect(types('Summer2024!')).toEqual(['common', 'year', 'bruteforce']);
    expect(bits('Tr0ub4dor&3')).toBeCloseTo(72.26841169164042, 12);
    expect(bits('qwerty123')).toBeCloseTo(8.113742166049187, 12);
    expect(bits('correct horse battery staple')).toBeCloseTo(126.17916804865783, 12);
  });
  it('runs as a tool', async () => {
    type Out = { score: number; label: string; bits: number; crackTimes: { time: string }[]; pieces: { type: string; note: string }[]; tips: string[] };
    const r = await call<Out>(check, { password: 'Summer2024!' });
    expect([r.score, r.label, r.bits]).toEqual([1, 'Weak', 26.6]);
    expect(r.crackTimes.map((c) => c.time)).toEqual(['1 century', '4 months', '3 hours', 'instant']);
    expect(r.pieces.map((p) => p.note)).toEqual(['common password #' + estimate('Summer2024!').seq[0].rank, 'year', 'random characters']);
    expect(r.tips.some((t) => /Ending with ! or 1/.test(t))).toBe(true);
    const q = await call<Out>(check, { password: 'qwerty123', showPieces: false });
    expect(q.score).toBe(0);
    expect(q.pieces).toBeUndefined();
  });
});

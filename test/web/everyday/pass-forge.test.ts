import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import gen, { WORDS, countValid, fmtTime, log2Big, makePassword, makePhrase, passwordPlan, phraseBits } from '../../../src/tools/web/everyday/pass-forge.js';

// Known answers copied from pass-forge's S3_SELFTEST.
describe('password_generate (pass-forge self-test)', () => {
  it('entropy maths', () => {
    expect(Math.abs(passwordPlan({ lower: true, length: 10 }).bits - 10 * Math.log2(26))).toBeLessThan(1e-9);
    expect(countValid(36, [26, 10], 2)).toBe(520n);
    expect(Math.abs(passwordPlan({ lower: true, digits: true, require: true, length: 2 }).bits - Math.log2(520))).toBeLessThan(1e-9);
    expect(Math.abs(log2Big(2n ** 200n * 3n) - (200 + Math.log2(3)))).toBeLessThan(1e-9);
  });
  it('excludes look-alikes and custom chars, requires every set', () => {
    const opt = { length: 64, lower: true, upper: true, digits: true, symbols: true, lookalike: true, require: true, exclude: 'xyz#' };
    const plan = passwordPlan(opt);
    for (let n = 0; n < 300; n++) {
      const pw = makePassword(opt, plan);
      expect(pw).toHaveLength(64);
      expect(pw).not.toMatch(/[Il1|O0oxyz#]/);
    }
    const short = { length: 8, lower: true, upper: true, digits: true, symbols: true, lookalike: true, require: true };
    const sp = passwordPlan(short);
    for (let m = 0; m < 300; m++) {
      const s = makePassword(short, sp);
      expect(/[a-z]/.test(s) && /[A-Z]/.test(s) && /[2-9]/.test(s) && /[^A-Za-z0-9]/.test(s)).toBe(true);
    }
  });
  it('passphrases', () => {
    expect(WORDS.length).toBe(2381);
    const ph = makePhrase({ words: 5, sep: '-', cap: false, addnum: false }).split('-');
    expect(ph).toHaveLength(5);
    expect(ph.every((w) => WORDS.includes(w))).toBe(true);
    expect(Math.abs(phraseBits({ words: 6 }) - 6 * Math.log2(WORDS.length))).toBeLessThan(1e-9);
    expect(makePhrase({ words: 4, sep: ' ', addnum: true })).toMatch(/\d/);
    expect(makePhrase({ words: 3, sep: '' })).toMatch(/^([A-Z][a-z]+){3}$/);
    expect(fmtTime(0.5)).toBe('less than a second');
    expect(fmtTime(3600 * 5)).toBe('5 hours');
    expect(fmtTime(31557600 * 2.5e9)).toBe('2.5 billion years');
  });
  it('runs as a tool', async () => {
    const r = await call<{ passwords: string[]; bits: number; strength: string; poolSize: number; crackTime: string }>(gen, { count: 3 });
    expect(r.passwords).toHaveLength(3);
    expect(r.passwords[0]).toHaveLength(20);
    expect(r.poolSize).toBe(83); // 26 + 26 + 10 + 28 symbols, minus the 7 look-alikes
    expect(r.strength).toBe('Very strong');
    const p = await call<{ passwords: string[]; bits: number; wordListSize: number }>(gen, { mode: 'passphrase', words: 6 });
    expect(p.passwords[0].split('-')).toHaveLength(6);
    expect(p.bits).toBe(67.3);
    await expect(call(gen, { lower: false, upper: false, digits: false, symbols: false })).rejects.toThrow(/character set/);
  });
});

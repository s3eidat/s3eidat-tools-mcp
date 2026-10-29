import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { analyze, formulas, sentences, syllables, verdict } from '../../../src/tools/web/text/readability.js';

// Known answers from the website's S3_SELFTEST (readability/app.js).
describe('text_readability', () => {
  it('syllables', () => {
    const syl: Record<string, number> = { the: 1, cat: 1, make: 1, table: 2, people: 2, readability: 5, wanted: 2, jumped: 1, boxes: 2, makes: 1, simple: 2, computer: 3, yes: 1 };
    for (const [w, n] of Object.entries(syl)) expect(syllables(w), w).toBe(n);
  });
  it('formulas', () => {
    const f = formulas({ words: 100, sentences: 5, syllables: 150, complex: 10, poly: 10, letters: 470, chars: 470 });
    expect(f.fre).toBeCloseTo(59.635, 2);
    expect(f.fk).toBeCloseTo(9.91, 2);
    expect(f.fog).toBeCloseTo(12, 2);
    expect(f.smog).toBeCloseTo(11.208, 2);
    expect(f.cli).toBeCloseTo(10.356, 2);
    expect(f.ari).toBeCloseTo(10.707, 2);
  });
  it('sentences, passive, adverbs, long sentences', () => {
    const t = 'Dr. Smith arrived at 3.30 p.m. today. He left! Did J. K. Rowling call? Yes';
    const ss = sentences(t).map((s) => t.slice(s.start, s.end));
    expect(ss).toHaveLength(4);
    expect(ss[0]).toBe('Dr. Smith arrived at 3.30 p.m. today.');
    expect(ss[2]).toBe('Did J. K. Rowling call?');
    expect(ss[3]).toBe('Yes');
    const a = analyze('The ball was thrown by the boy. The cake was quickly eaten. He really ran only daily.');
    expect(a.marks.filter((m) => m.kind === 'passive')).toHaveLength(2);
    expect(a.marks.filter((m) => m.kind === 'adverb')).toHaveLength(1);
    const long = analyze(new Array(26).join('word ') + 'end.');
    expect(long.sents).toHaveLength(1);
    expect(long.sents[0].level).toBe('hard');
    expect(verdict(65)[0]).toBe('Plain English');
    expect(analyze('').scores).toBeNull();
  });
  it('runs as a tool', async () => {
    const r = await call<Record<string, unknown>>(tool, { text: 'The ball was thrown by the boy. The cake was quickly eaten. He really ran only daily.' });
    expect(r).toMatchObject({ words: 17, sentences: 3, passive: ['was thrown', 'was quickly eaten'], adverbs: ['really'] });
    expect(r.verdict).toBeTypeOf('string');
    const e = await call<Record<string, unknown>>(tool, { text: '' });
    expect(e).toMatchObject({ scores: null, readingEase: null, words: 0 });
  });
});

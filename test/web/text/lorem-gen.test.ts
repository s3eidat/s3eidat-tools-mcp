import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { countWords, generate, LIMITS, OPENER, type LoremOptions } from '../../../src/tools/web/text/lorem-gen.js';

// Known answers copied verbatim from the website's S3_SELFTEST (lorem-gen/app.js).
describe('text_lorem', () => {
  it('matches the website self-test', () => {
    const base: LoremOptions = { style: 'lorem', unit: 'words', count: 25, opener: true, html: false, seed: 42 };
    var w = generate(base);
    var okWords = countWords(w) === 25 && w.indexOf("Lorem ipsum dolor sit amet") === 0 && /\.$/.test(w);
    var p = generate({ style: "english", unit: "paragraphs", count: 4, opener: false, html: false, seed: 7 });
    var okParas = p.split("\n\n").length === 4 && p.indexOf("Lorem") === -1;
    var s = generate({ style: "lorem", unit: "sentences", count: 6, opener: false, html: false, seed: 3 });
    var okSent = (s.match(/\./g) || []).length === 6;
    var a = generate({ style: "arabic", unit: "paragraphs", count: 2, opener: true, html: false, seed: 9 });
    var okAr = a.indexOf(OPENER.arabic) === 0 && !/[A-Za-z]/.test(a) && /^[؀-ۿ\s.،]+$/.test(a);
    var h = generate({ style: "lorem", unit: "paragraphs", count: 2, opener: false, html: true, seed: 1 });
    var okHtml = /^<p>[^<>]+<\/p>\n<p>[^<>]+<\/p>$/.test(h);
    var same = generate(base) === w; // seeded = repeatable
    var clamp = countWords(generate({ style: "lorem", unit: "words", count: 99999, opener: false, html: false, seed: 1 })) === LIMITS.words;
    expect({ okWords, okParas, okSent, okAr, okHtml, same, clamp }).toEqual({ okWords: true, okParas: true, okSent: true, okAr: true, okHtml: true, same: true, clamp: true });
  });

  it('runs as a tool, seeded and repeatable', async () => {
    const a = await call<{ text: string; words: number; seed: number }>(tool, { unit: 'words', count: 25, seed: 42 });
    expect(a.text).toBe(generate({ style: 'lorem', unit: 'words', count: 25, opener: true, html: false, seed: 42 }));
    expect(a.words).toBe(25);
    expect(a.seed).toBe(42);
    const b = await call<{ text: string; seed: number }>(tool, { style: 'english', unit: 'sentences', count: 3 });
    const c = await call<{ text: string }>(tool, { style: 'english', unit: 'sentences', count: 3, seed: b.seed });
    expect(c.text).toBe(b.text);
    const big = await call<{ words: number }>(tool, { unit: 'words', count: 1e6, seed: 1, opener: false });
    expect(big.words).toBe(LIMITS.words);
  });
});

import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { apply, STYLES } from '../../../src/tools/web/text/fancy-text.js';

// Known answers copied verbatim from the website's S3_SELFTEST (fancy-text/app.js).
describe('text_fancy', () => {
  it('matches the website self-test', () => {
    function by(n: string) { return STYLES.filter(function (s) { return s[0] === n; })[0]; }
    var t = [
      [apply(by("Bold"), "Ab1"), "𝐀𝐛𝟏"],
      [apply(by("Italic"), "hi"), "ℎ𝑖"],
      [apply(by("Script"), "Be"), "ℬℯ"],
      [apply(by("Fraktur"), "Ca"), "ℭ𝔞"],
      [apply(by("Double-struck"), "RZ1"), "ℝℤ𝟙"],
      [apply(by("Monospace"), "a0"), "𝚊𝟶"],
      [apply(by("Sans bold"), "Z9"), "𝗭𝟵"],
      [apply(by("Circled"), "a1 0"), "ⓐ① ⓪"],
      [apply(by("Circled dark"), "ab 10"), "🅐🅑 ❶⓿"],
      [apply(by("Squared"), "Ok"), "🄾🄺"],
      [apply(by("Fullwidth"), "A! b"), "Ａ！　ｂ"],
      [apply(by("Small caps"), "Hi"), "ʜɪ"],
      [apply(by("Superscript"), "x2"), "ˣ²"],
      [apply(by("Upside down"), "abc!"), "¡ɔqɐ"],
      [apply(by("Upside down"), "ab\ncd"), "pɔ\nqɐ"],
      [apply(by("Strikethrough"), "ab"), "a̶b̶"],
      [apply(by("Wide spaced"), "abc"), "a b c"],
      [apply(by("Bold"), "مرحبا 😀"), "مرحبا 😀"]
    ];
    expect(STYLES.length).toBeGreaterThanOrEqual(25);
    t.forEach((p) => expect(p[0]).toBe(p[1]));
  });

  it('runs as a tool', async () => {
    const one = await call<{ results: { style: string; text: string }[] }>(tool, { text: 'Ab1', style: 'Bold' });
    expect(one.results).toEqual([{ style: 'Bold', text: '\u{1D400}\u{1D41B}\u{1D7CF}' }]);
    const all = await call<{ results: unknown[] }>(tool, { text: 'x' });
    expect(all.results).toHaveLength(STYLES.length);
    await expect(call(tool, { text: 'x', style: 'Nope' })).rejects.toThrow();
  });
});

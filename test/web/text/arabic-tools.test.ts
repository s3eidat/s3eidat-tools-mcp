import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { arabizi, clean, counts } from '../../../src/tools/web/text/arabic-tools.js';

// Known answers copied verbatim from the website's S3_SELFTEST (arabic-tools/app.js).
describe('text_arabic', () => {
  it('matches the website self-test', () => {
    var all = { tashkeel: true, tatweel: true, alef: true, ya: true, ta: true, hamza: true, digits: "western" as const };
    var t = [
      [clean("مُحَمَّدٌ", { tashkeel: true }), "محمد"],
      [clean("مُحَمَّدٌ", { tashkeel: true, keepShadda: true }), "محمّد"],
      [clean("هٰذا الرَّحْمَٰنِ", { tashkeel: true }), "هذا الرحمن"],
      [clean("مـــرحبا", { tatweel: true }), "مرحبا"],
      [clean("أحمد إبراهيم آمال ٱلله", { alef: true }), "احمد ابراهيم امال الله"],
      [clean("على مدرسة سؤال قائم", all), "علي مدرسه سوال قايم"],
      [clean("١٢٣ ۴۵", { digits: "western" }), "123 45"],
      [clean("2026", { digits: "arabic" }), "٢٠٢٦"],
      [clean("كيف حالك? نعم, لا;", { punct: true }), "كيف حالك؟ نعم، لا؛"],
      [clean("نص بدون تغيير", {}), "نص بدون تغيير"],
      [arabizi("mar7aba"), "مرحبا"],
      [arabizi("7abibi"), "حبيبي"],
      [arabizi("3arabi"), "عربي"],
      [arabizi("ana"), "انا"],
      [arabizi("kteer"), "كتير"],
      [arabizi("5ala9"), "خلص"],
      [arabizi("sho"), "شو"],
      [arabizi("3'arb"), "غرب"],
      [arabizi("yalla"), "يلا"],
      [arabizi("el bait"), "البيت"],
      [arabizi("shukran, kifak?"), "شكرن، كيفك؟"],
      [arabizi("2ana 3 days 2026"), "أنا 3 ديس 2026"]
    ];
    var c = counts("مُحَمَّدٌ رسول");
    t.forEach((p) => expect(p[0]).toBe(p[1]));
    expect([c.letters, c.marks, c.words]).toEqual([8, 5, 2]);
  });

  it('runs as a tool (both modes)', async () => {
    const a = await call<{ text: string; marksRemoved: number }>(tool, { text: "مُحَمَّدٌ"}); expect(a.text).toBe( "محمد"); expect(a.marksRemoved).toBe(5);
    const r = await call<{ text: string; marksRemoved?: number }>(tool, { mode: 'arabizi', text: 'yalla' });
    expect(r.text).toBe(arabizi('yalla'));
    expect(r.marksRemoved).toBeUndefined();
    const d = await call<{ text: string; words: number }>(tool, { text: '2026 x', digits: 'arabic' });
    expect(d.text).toBe(clean('2026 x', { digits: 'arabic' }));
    expect(d.words).toBe(counts(d.text).words);
  });
});

import { describe, expect, it } from 'vitest';
import { call } from '../helpers.js';
import tool from '../../src/tools/ai/detect-language.js';

type Out = {
  language: string | null; name: string | null; iso6391: string | null; tooShort: boolean; script: string | null; isCJK: boolean;
  candidates: { code: string; score: number }[]; scripts: { script: string; percent: number }[]; note?: string;
};

describe('ai_detect_language', () => {
  it('detects English, Arabic, French, Russian', async () => {
    const en = await call<Out>(tool, { text: 'The quick brown fox jumps over the lazy dog near the river bank every morning.' });
    expect(en).toMatchObject({ language: 'eng', name: 'English', iso6391: 'en', script: 'Latin', tooShort: false });
    expect(en.candidates).toHaveLength(3);
    expect(en.candidates[0].score).toBe(1);

    const ar = await call<Out>(tool, { text: 'مرحبا بكم في موقعنا، نتمنى لكم يوما سعيدا مع عائلتكم وأصدقائكم' });
    expect(ar).toMatchObject({ language: 'arb', iso6391: 'ar', script: 'Arabic' });

    const fr = await call<Out>(tool, { text: "Bonjour tout le monde, je suis très heureux d'être ici avec vous aujourd'hui." });
    expect(fr.language).toBe('fra');

    const ru = await call<Out>(tool, { text: 'Привет, как дела? Я очень рад видеть тебя сегодня здесь.' });
    expect(ru).toMatchObject({ language: 'rus', script: 'Cyrillic' });
  });

  it('reports CJK script', async () => {
    const ja = await call<Out>(tool, { text: 'こんにちは、今日はとても良い天気ですね。散歩に行きましょう。' });
    expect(ja.language).toBe('jpn');
    expect(ja.isCJK).toBe(true);
  });

  it('short text: script only', async () => {
    const r = await call<Out>(tool, { text: 'مرحبا' });
    expect(r).toMatchObject({ tooShort: true, language: null, script: 'Arabic', candidates: [] });
    expect(r.note).toMatch(/too short/i);
  });
});

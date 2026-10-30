import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { readTextInput } from '../../util/files.js';
import { pathField, textField } from './_text.js';

/** franc-min codes (ISO 639-3) -> English name and ISO 639-1 (null when there is none). */
export const LANGS: Record<string, [string, string | null]> = {
  spa: ['Spanish', 'es'], eng: ['English', 'en'], por: ['Portuguese', 'pt'], ind: ['Indonesian', 'id'], fra: ['French', 'fr'],
  deu: ['German', 'de'], jav: ['Javanese', 'jv'], vie: ['Vietnamese', 'vi'], ita: ['Italian', 'it'], tur: ['Turkish', 'tr'],
  pol: ['Polish', 'pl'], swh: ['Swahili', 'sw'], sun: ['Sundanese', 'su'], ron: ['Romanian', 'ro'], hau: ['Hausa', 'ha'],
  fuv: ['Nigerian Fulfulde', 'ff'], bos: ['Bosnian', 'bs'], hrv: ['Croatian', 'hr'], nld: ['Dutch', 'nl'], srp: ['Serbian', 'sr'],
  ckb: ['Central Kurdish (Sorani)', 'ku'], yor: ['Yoruba', 'yo'], uzn: ['Uzbek', 'uz'], zlm: ['Malay', 'ms'], ibo: ['Igbo', 'ig'],
  ceb: ['Cebuano', null], tgl: ['Tagalog', 'tl'], hun: ['Hungarian', 'hu'], azj: ['Azerbaijani', 'az'], ces: ['Czech', 'cs'],
  run: ['Rundi', 'rn'], plt: ['Malagasy', 'mg'], qug: ['Quichua', 'qu'], mad: ['Madurese', null], nya: ['Chichewa', 'ny'],
  zyb: ['Zhuang', 'za'], kin: ['Kinyarwanda', 'rw'], zul: ['Zulu', 'zu'], swe: ['Swedish', 'sv'], lin: ['Lingala', 'ln'],
  som: ['Somali', 'so'], hms: ['Southern Qiandong Miao', null], hnj: ['Hmong Njua', null], ilo: ['Ilocano', null],
  rus: ['Russian', 'ru'], ukr: ['Ukrainian', 'uk'], koi: ['Komi-Permyak', null], bel: ['Belarusian', 'be'], bul: ['Bulgarian', 'bg'],
  kaz: ['Kazakh', 'kk'], arb: ['Arabic', 'ar'], urd: ['Urdu', 'ur'], pes: ['Persian', 'fa'], skr: ['Saraiki', null],
  pbu: ['Pashto', 'ps'], hin: ['Hindi', 'hi'], mar: ['Marathi', 'mr'], mai: ['Maithili', null], bho: ['Bhojpuri', null],
  npi: ['Nepali', 'ne'], mag: ['Magahi', null], cmn: ['Chinese (Mandarin)', 'zh'], ben: ['Bengali', 'bn'], jpn: ['Japanese', 'ja'],
  kor: ['Korean', 'ko'], tel: ['Telugu', 'te'], tam: ['Tamil', 'ta'], guj: ['Gujarati', 'gu'], kan: ['Kannada', 'kn'],
  mal: ['Malayalam', 'ml'], mya: ['Burmese', 'my'], pan: ['Punjabi', 'pa'], amh: ['Amharic', 'am'], tha: ['Thai', 'th'],
  sin: ['Sinhala', 'si'], ell: ['Greek', 'el'],
};

const SCRIPTS: [string, RegExp][] = [
  ['Latin', /\p{Script=Latin}/u], ['Arabic', /\p{Script=Arabic}/u], ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u], ['Hebrew', /\p{Script=Hebrew}/u], ['Han', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u], ['Katakana', /\p{Script=Katakana}/u], ['Hangul', /\p{Script=Hangul}/u],
  ['Devanagari', /\p{Script=Devanagari}/u], ['Bengali', /\p{Script=Bengali}/u], ['Gurmukhi', /\p{Script=Gurmukhi}/u],
  ['Gujarati', /\p{Script=Gujarati}/u], ['Tamil', /\p{Script=Tamil}/u], ['Telugu', /\p{Script=Telugu}/u],
  ['Kannada', /\p{Script=Kannada}/u], ['Malayalam', /\p{Script=Malayalam}/u], ['Sinhala', /\p{Script=Sinhala}/u],
  ['Thai', /\p{Script=Thai}/u], ['Lao', /\p{Script=Lao}/u], ['Myanmar', /\p{Script=Myanmar}/u], ['Khmer', /\p{Script=Khmer}/u],
  ['Ethiopic', /\p{Script=Ethiopic}/u], ['Georgian', /\p{Script=Georgian}/u], ['Armenian', /\p{Script=Armenian}/u],
  ['Tibetan', /\p{Script=Tibetan}/u], ['Syriac', /\p{Script=Syriac}/u], ['Thaana', /\p{Script=Thaana}/u],
];
const CJK = new Set(['Han', 'Hiragana', 'Katakana', 'Hangul']);

/** Letters per writing system, most used first. */
export function scripts(text: string) {
  const counts = new Map<string, number>();
  let letters = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    const s = SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? 'Other';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const list = [...counts].map(([script, chars]) => ({ script, chars, percent: Math.round((chars / letters) * 1000) / 10 }))
    .sort((a, b) => b.chars - a.chars);
  return { letters, list };
}

export const MIN_CHARS = 20;

export default defineTool({
  name: 'ai_detect_language',
  title: 'Detect language',
  description:
    'Detect the language of a text with franc-min (82 languages with 8M+ speakers, ISO 639-3 codes) and the writing systems ' +
    'it uses (Latin, Arabic, Cyrillic, Han/CJK, Hangul, Devanagari, Greek, Hebrew, Thai…). Returns the top 3 candidates with ' +
    'scores (1 = best match, relative to the others), English names and ISO 639-1 codes where they exist, plus a share per script. ' +
    'Texts under 20 characters are "too short": only the script is reported. Works best on a sentence or more of one language; ' +
    'for mixed text the dominant script wins; long texts are judged on their first 100,000 characters. Hebrew is not among the languages (script only). Give "text" or "path" (file path or base64).',
  inputSchema: z.object({
    text: textField(),
    path: pathField(),
    only: z.array(z.string()).optional().describe('Restrict to these ISO 639-3 codes (e.g. ["arb","eng","fra"]).'),
  }),
  outputSchema: z.object({
    language: z.string().nullable().describe('Best ISO 639-3 code, or null when too short/undetermined.'),
    name: z.string().nullable(),
    iso6391: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low', 'none']),
    tooShort: z.boolean(),
    note: z.string().optional(),
    candidates: z.array(z.object({ code: z.string(), name: z.string(), iso6391: z.string().nullable(), score: z.number() })),
    script: z.string().nullable().describe('Dominant writing system.'),
    isCJK: z.boolean(),
    scripts: z.array(z.object({ script: z.string(), chars: z.number(), percent: z.number() })),
    characters: z.number(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'The quick brown fox jumps over the lazy dog near the river bank.' }, output: { language: 'eng', iso6391: 'en', script: 'Latin' } },
    { input: { text: 'مرحبا بكم في موقعنا، نتمنى لكم يوما سعيدا' }, output: { language: 'arb', iso6391: 'ar', script: 'Arabic' } },
    { input: { text: 'Hi there' }, output: { tooShort: true, script: 'Latin' } },
  ],
  async run(input, ctx) {
    const full = await readTextInput(input.text, input.path, ctx);
    // A sample is plenty: franc itself reads at most 2048 characters.
    const text = full.length > 100_000 ? full.slice(0, 100_000) : full;
    const sc = scripts(text);
    const top = sc.list[0]?.script ?? null;
    const base = {
      script: top,
      isCJK: !!top && CJK.has(top),
      scripts: sc.list,
      characters: [...full].length,
    };
    const trimmed = text.trim();
    if ([...trimmed].length < MIN_CHARS) {
      return {
        language: null, name: null, iso6391: null, confidence: 'none' as const, tooShort: true,
        note: `Too short to detect a language reliably (under ${MIN_CHARS} characters); only the script is reported.`,
        candidates: [], ...base,
      };
    }
    const { francAll } = await import('franc-min');
    const all = francAll(trimmed, { minLength: MIN_CHARS, ...(input.only?.length ? { only: input.only } : {}) });
    const cands = all.filter(([c]) => c !== 'und').slice(0, 3).map(([code, score]) => ({
      code, name: LANGS[code]?.[0] ?? code, iso6391: LANGS[code]?.[1] ?? null, score: Math.round(score * 1000) / 1000,
    }));
    if (!cands.length) {
      return {
        language: null, name: null, iso6391: null, confidence: 'none' as const, tooShort: false,
        note: 'No language could be determined (no letters, or a script franc-min does not model).', candidates: [], ...base,
      };
    }
    const margin = cands.length > 1 ? cands[0].score - cands[1].score : 1;
    const n = [...trimmed].length;
    // Languages that are alone in their script get a perfect margin from franc; that's real certainty.
    const confidence = n >= 100 && margin >= 0.15 ? 'high' : n < 40 || margin < 0.05 ? 'low' : 'medium';
    const second = sc.list[1];
    return {
      language: cands[0].code, name: cands[0].name, iso6391: cands[0].iso6391, confidence, tooShort: false,
      ...(second && second.percent >= 20 ? { note: `Mixed scripts: ${second.percent}% ${second.script}; the language is detected from the dominant ${top} text.` } : {}),
      candidates: cands, ...base,
    };
  },
});

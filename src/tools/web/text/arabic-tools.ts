import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { readTextInput, writeOutput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/arabic-tools (app.js): pure string transforms. Every Arabic constant and
// regex below is copied byte for byte from the website source.
// Harakat U+064B–U+0652 (fathatan…sukun), extended marks U+0653–U+065F, superscript alef U+0670,
// Quranic annotation marks U+0610–U+061A and U+06D6–U+06ED (small high/low signs, not letters).
const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/g;
const TASHKEEL_NO_SHADDA = /[ؐ-ًؚ-ِْ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/g;
const TATWEEL = /ـ/g;
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩", FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export interface CleanOpts {
  tashkeel: boolean; keepShadda: boolean; tatweel: boolean; alef: boolean; ya: boolean; ta: boolean; hamza: boolean; punct: boolean;
  digits: 'keep' | 'western' | 'arabic';
}

export function clean(text: string, o: Partial<CleanOpts>) {
  var t = text;
  if (o.tashkeel) t = t.replace(o.keepShadda ? TASHKEEL_NO_SHADDA : TASHKEEL, "");
  if (o.tatweel) t = t.replace(TATWEEL, "");
  if (o.alef) t = t.replace(/[آأإٱ]/g, "ا");
  if (o.ya) t = t.replace(/[ىی]/g, "ي");
  if (o.ta) t = t.replace(/ة/g, "ه");
  if (o.hamza) t = t.replace(/ؤ/g, "و").replace(/ئ/g, "ي");
  if (o.punct) t = t.replace(/,/g, "،").replace(/;/g, "؛").replace(/\?/g, "؟");
  if (o.digits === "western") t = t.replace(/[٠-٩]/g, function (d) { return "" + AR_DIGITS.indexOf(d); }).replace(/[۰-۹]/g, function (d) { return "" + FA_DIGITS.indexOf(d); });
  if (o.digits === "arabic") t = t.replace(/[0-9]/g, function (d) { return AR_DIGITS[+d]; }).replace(/[۰-۹]/g, function (d) { return AR_DIGITS[FA_DIGITS.indexOf(d)]; });
  return t;
}

// ---------- Arabizi → Arabic ----------
const CONS: Record<string, string> = { b: "ب", c: "ك", d: "د", f: "ف", g: "ج", h: "ه", j: "ج", k: "ك", l: "ل", m: "م", n: "ن", p: "ب", q: "ق", r: "ر", s: "س",
  t: "ت", v: "ف", w: "و", x: "كس", y: "ي", z: "ز", "2": "ء", "3": "ع", "5": "خ", "6": "ط", "7": "ح", "8": "ق", "9": "ص",
  "3'": "غ", "6'": "ظ", "7'": "خ", "9'": "ض", sh: "ش", ch: "ش", kh: "خ", gh: "غ", th: "ث", dh: "ذ" };
const LONG: Record<string, string> = { aa: "ا", ee: "ي", ii: "ي", ei: "ي", ey: "ي", ai: "ي", ay: "ي", oo: "و", ou: "و", uu: "و" };
const MULTI = ["3'", "6'", "7'", "9'", "sh", "ch", "kh", "gh", "th", "dh", "aa", "ee", "ii", "ei", "ey", "ai", "ay", "oo", "ou", "uu"];
const VOWEL = /^[aeiou]$/;

function word(w: string) {
  w = w.toLowerCase();
  if (/^\d+$/.test(w) || !/[a-z]/.test(w)) return w; // plain numbers stay numbers
  var units: string[] = [];
  for (var i = 0; i < w.length;) {
    var two = w.substr(i, 2), u = MULTI.indexOf(two) >= 0 ? two : w[i];
    units.push(u); i += u.length;
  }
  var out = "", last = "";
  units.forEach(function (u, i) {
    var first = i === 0, end = i === units.length - 1, ch: string | undefined;
    if (u === "'") return;
    if (LONG[u]) ch = first ? "ا" + (u[0] === "a" ? "" : LONG[u]) : LONG[u];
    else if (VOWEL.test(u)) {
      if (first) ch = "ا";
      else if (end) ch = (<Record<string, string>>{ a: "ا", e: "ه", i: "ي", o: "و", u: "و" })[u];
      else ch = (<Record<string, string>>{ a: "", e: "", i: "ي", o: "و", u: "" })[u];
    } else if (u === "2" && first) ch = "أ";
    else ch = CONS[u] != null ? CONS[u] : u;
    if (ch && ch === last && CONS[u] && !LONG[u]) return; // doubled consonant (shadda) → one letter
    out += ch; if (ch) last = ch;
  });
  return out;
}

export function arabizi(text: string) {
  var parts = text.split(/([A-Za-z0-9']+)/), out = "";
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (i % 2 === 0) { out += p.replace(/,/g, "،").replace(/;/g, "؛").replace(/\?/g, "؟"); continue; }
    if (/^(el|al|il)$/i.test(p) && /^[ -]$/.test(parts[i + 1] || "") && /[a-z]/i.test(parts[i + 2] || "")) {
      out += "ال" + word(parts[i + 2]); i += 2; continue;
    }
    out += word(p);
  }
  return out;
}

export function counts(text: string) {
  var letters = (text.match(/[ء-غف-يٱ-ۓۺ-ۿ]/g) || []).length;
  var marks = (text.match(TASHKEEL) || []).length;
  var words = (text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}ـ]*/gu) || []).length;
  return { letters: letters, marks: marks, words: words, chars: Array.from(text).length };
}

export default defineTool({
  name: 'text_arabic',
  title: 'Arabic text tools',
  webSlug: 'arabic-tools',
  description:
    'Arabic text utilities. mode "clean": remove tashkeel (harakat and Quranic marks, optionally keeping shadda), remove ' +
    'tatweel (kashida), normalise letters (alef with hamza/madda/wasla → bare alef; alef maqsura and Farsi ya → ya; ta ' +
    'marbuta → ha; hamza on waw/ya → waw/ya), switch Latin , ; ? to Arabic punctuation, and convert digits (Arabic-Indic ' +
    '↔ Western). mode "arabizi": turn Arabizi / Franco-Arabic chat text (mar7aba, 3arabi, 5ala9, el bait) into Arabic ' +
    'script. Returns the result with letter/word/character counts. Give "text" or a text file "path". ' +
    `Web version: ${webUrl('arabic-tools')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('The text to transform.'),
    path: z.string().optional().describe('Or: a path to a UTF-8 text file.'),
    mode: z.enum(['clean', 'arabizi']).optional().default('clean').describe('"clean" = clean & normalise Arabic text (default); "arabizi" = Arabizi (Latin letters + numbers) → Arabic script.'),
    removeTashkeel: z.boolean().optional().default(true).describe('clean: remove tashkeel / harakat (default true).'),
    keepShadda: z.boolean().optional().default(false).describe('clean: when removing tashkeel, keep the shadda.'),
    removeTatweel: z.boolean().optional().default(true).describe('clean: remove tatweel / kashida (default true).'),
    normalizeAlef: z.boolean().optional().default(false).describe('clean: alef with hamza above/below, madda or wasla → bare alef.'),
    normalizeYa: z.boolean().optional().default(false).describe('clean: alef maqsura and Farsi ya → Arabic ya.'),
    taMarbutaToHa: z.boolean().optional().default(false).describe('clean: ta marbuta → ha.'),
    normalizeHamza: z.boolean().optional().default(false).describe('clean: hamza on waw → waw, hamza on ya → ya.'),
    arabicPunctuation: z.boolean().optional().default(false).describe('clean: Latin comma, semicolon and question mark → Arabic ones.'),
    digits: z.enum(['keep', 'western', 'arabic']).optional().default('keep').describe('clean: keep digits, convert Arabic-Indic/Persian digits to 0-9 ("western"), or 0-9 to Arabic-Indic ("arabic").'),
    output: z.string().optional().describe('Optional: write the result to this file path (or folder ending in "/") instead of returning it.'),
  }),
  outputSchema: z.object({
    text: z.string().optional().describe('The result (omitted when written to "output").'),
    path: z.string().optional(), bytes: z.number().optional(),
    arabicLetters: z.number(), words: z.number(), characters: z.number(),
    marksRemoved: z.number().optional().describe('clean mode: how many tashkeel marks were removed.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { mode: 'arabizi', text: 'mar7aba, kifak?' }, output: run0({ mode: 'arabizi', text: 'mar7aba, kifak?' }) },
    { input: { text: '2026', digits: 'arabic' }, output: run0({ text: '2026', digits: 'arabic' }) },
  ],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    const r = transform(text, input);
    if (input.output) {
      const f = await writeOutput(r.text, { output: input.output, defaultName: 'arabic.txt', mimeType: 'text/plain' }, ctx);
      const { text: _t, ...rest } = r;
      return { path: f.path, bytes: f.bytes, ...rest };
    }
    return r;
  },
});

interface Input {
  mode: 'clean' | 'arabizi'; removeTashkeel: boolean; keepShadda: boolean; removeTatweel: boolean; normalizeAlef: boolean; normalizeYa: boolean;
  taMarbutaToHa: boolean; normalizeHamza: boolean; arabicPunctuation: boolean; digits: CleanOpts['digits'];
}
export function transform(t: string, i: Input) {
  const res = !t ? '' : i.mode === 'arabizi' ? arabizi(t) : clean(t, {
    tashkeel: i.removeTashkeel, keepShadda: i.keepShadda, tatweel: i.removeTatweel, alef: i.normalizeAlef, ya: i.normalizeYa,
    ta: i.taMarbutaToHa, hamza: i.normalizeHamza, punct: i.arabicPunctuation, digits: i.digits,
  });
  const c = counts(res), before = counts(t);
  return {
    text: res, arabicLetters: c.letters, words: c.words, characters: c.chars,
    ...(i.mode === 'clean' ? { marksRemoved: Math.max(0, before.marks - c.marks) } : {}),
  };
}
/** Example helper: defaults applied as the schema would. */
function run0(x: Partial<Input> & { text: string }) {
  return transform(x.text, {
    mode: 'clean', removeTashkeel: true, keepShadda: false, removeTatweel: true, normalizeAlef: false, normalizeYa: false,
    taMarbutaToHa: false, normalizeHamza: false, arabicPunctuation: false, digits: 'keep', ...x,
  });
}

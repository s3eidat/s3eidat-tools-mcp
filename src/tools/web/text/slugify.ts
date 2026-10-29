import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/slugify (app.js) so slugs match the website.
// Arabic constants are copied byte for byte from the website source.
const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;
const SPECIAL: Record<string, string> = { "ß": "ss", "ẞ": "SS", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D", "ł": "l", "Ł": "L", "þ": "th", "Þ": "TH", "ð": "d", "Ð": "D", "ı": "i", "ħ": "h" };
const AR: Record<string, string> = { "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ٱ": "a", "ء": "", "ؤ": "u", "ئ": "i", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh",
  "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "q",
  "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "ة": "a", "ى": "a", "پ": "p", "چ": "ch", "ڤ": "v", "گ": "g", "ک": "k", "ی": "i" };
const STOP = new Set(("a an and are as at be by for from has have how in is it its of on or that the this to was were what when where which who why will with " +
  "في من على إلى الى عن مع هذا هذه ذلك التي الذي أن ان إن كان و أو او ثم هو هي ما لا لم قد كل بعض عند بين حتى").split(" "));

export interface SlugOptions {
  sep: string;
  lower: boolean;
  accents: boolean;
  stop: boolean;
  arabic: 'latin' | 'keep';
  max: number;
}

function arabicToLatin(word: string) {
  var w = word, pre = "";
  if (/^ال.{2,}/.test(w)) { pre = "al "; w = w.slice(2); } // definite article becomes its own word: al-bayt
  var out = "";
  Array.from(w).forEach(function (c, i) {
    if (c === "و") out += i === 0 ? "w" : "u";
    else if (c === "ي") out += i === 0 ? "y" : "i";
    else out += AR[c] != null ? AR[c] : c;
  });
  return pre + out;
}

// o: {sep, lower, accents, stop, arabic: "latin"|"keep", max}
export function slugify(text: string, o: SlugOptions): string {
  var s = text.normalize("NFKC").replace(TASHKEEL, "")
    .replace(/[٠-٩]/g, function (d) { return "" + "٠١٢٣٤٥٦٧٨٩".indexOf(d); })
    .replace(/[۰-۹]/g, function (d) { return "" + "۰۱۲۳۴۵۶۷۸۹".indexOf(d); })
    .replace(/&/g, " and ")
    .replace(/(\p{L})['’](?=\p{L})/gu, "$1"); // don't → dont
  if (o.arabic === "latin") s = s.replace(/[ء-يٱ-ۓ]+/g, arabicToLatin);
  if (o.accents) {
    // Fold accents on non-Arabic runs only: NFD on Arabic would strip the hamza from أ and the madda from آ.
    s = s.replace(/[^؀-ۿ]+/g, function (m) {
      return m.replace(/[ßẞæÆœŒøØđĐłŁþÞðÐıħ]/g, function (c) { return SPECIAL[c]; }).normalize("NFD").replace(/\p{M}/gu, "");
    });
  }
  if (o.lower) s = s.toLocaleLowerCase();
  var words = s.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  if (o.stop) {
    var kept = words.filter(function (w) { return !STOP.has(w.toLowerCase()); });
    if (kept.length) words = kept;
  }
  var max = o.max | 0, sep = o.sep;
  if (max > 0) {
    var outW: string[] = [], len = 0;
    for (var i = 0; i < words.length; i++) {
      var add = Array.from(words[i]).length + (outW.length ? sep.length : 0);
      if (len + add > max) break;
      outW.push(words[i]); len += add;
    }
    if (!outW.length && words.length) outW = [Array.from(words[0]).slice(0, max).join("")]; // one long word: hard cut
    words = outW;
  }
  return words.join(sep);
}

export default defineTool({
  name: 'text_slugify',
  title: 'Slugify',
  webSlug: 'slugify',
  description:
    'Turn titles into clean URL slugs, one slug per non-empty line (bulk). Folds accents (é → e, ß → ss), ' +
    'transliterates Arabic to Latin (the article al- becomes its own word) or keeps Arabic letters, converts Arabic-Indic digits, ' +
    'drops tashkeel, turns & into "and", can remove stop words (English and Arabic) and cap the length at a word ' +
    `boundary. Web version: ${webUrl('slugify')}`,
  inputSchema: z.object({
    text: z.string().describe('Title(s) to slugify. Each non-empty line becomes one slug.'),
    separator: z.enum(['-', '_', '.']).optional().default('-').describe('Word separator: dash (default), underscore or dot.'),
    lowercase: z.boolean().optional().default(true).describe('Lowercase the slug (default true).'),
    foldAccents: z.boolean().optional().default(true).describe('Transliterate accents: é → e, ß → ss, æ → ae (default true).'),
    removeStopWords: z.boolean().optional().default(false).describe('Remove stop words in English and Arabic such as the, of, and (kept if nothing else is left).'),
    arabic: z.enum(['latin', 'keep']).optional().default('latin').describe('"latin" transliterates Arabic letters (default); "keep" keeps them.'),
    maxLength: z.number().int().min(0).max(500).optional().default(0).describe('Maximum slug length in characters, cut at a word boundary (0 = no limit).'),
  }),
  outputSchema: z.object({
    slugs: z.array(z.object({
      title: z.string().describe('The input line.'),
      slug: z.string().describe('The slug (empty if nothing was left).'),
      length: z.number().describe('Slug length in characters.'),
      encodedLength: z.number().describe('Length once percent-encoded for a URL (differs for Arabic).'),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'Crème Brûlée & Café au Lait: A Love Story' }, output: { slugs: [{ title: 'Crème Brûlée & Café au Lait: A Love Story', slug: 'creme-brulee-and-cafe-au-lait-a-love-story', length: 42, encodedLength: 42 }] } },
    { input: { text: 'The Lord of the Rings', removeStopWords: true }, note: 'lord-rings' },
  ],
  run(input) {
    const o: SlugOptions = {
      sep: input.separator, lower: input.lowercase, accents: input.foldAccents, stop: input.removeStopWords,
      arabic: input.arabic, max: input.maxLength,
    };
    const lines = input.text.split('\n').filter((l) => l.trim());
    return {
      slugs: lines.map((title) => {
        const slug = slugify(title, o);
        return { title, slug, length: Array.from(slug).length, encodedLength: encodeURI(slug).length };
      }),
    };
  },
});

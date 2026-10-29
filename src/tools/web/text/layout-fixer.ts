import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { readTextInput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/layout-fixer (app.js): remaps keys between US QWERTY and Arabic (101), and in
// mixed text converts only the words that look mistyped (letter-pair models). Arabic constants copied byte for byte.
function cp(n: number) { return String.fromCharCode(n); }

// ---------- the layout: US key -> what Arabic (101) types on that key ----------
export const FATHA = cp(0x64E), FATHATAN = cp(0x64B), DAMMA = cp(0x64F), DAMMATAN = cp(0x64C), KASRA = cp(0x650),
  KASRATAN = cp(0x64D), SUKUN = cp(0x652), SHADDA = cp(0x651);
const BASE: Record<string, string> = {
  "`": "ذ", q: "ض", w: "ص", e: "ث", r: "ق", t: "ف", y: "غ", u: "ع", i: "ه", o: "خ", p: "ح", "[": "ج", "]": "د",
  a: "ش", s: "س", d: "ي", f: "ب", g: "ل", h: "ا", j: "ت", k: "ن", l: "م", ";": "ك", "'": "ط",
  z: "ئ", x: "ء", c: "ؤ", v: "ر", b: "لا", n: "ى", m: "ة", ",": "و", ".": "ز", "/": "ظ"
};
const SHIFT: Record<string, string> = {
  "~": SHADDA, Q: FATHA, W: FATHATAN, E: DAMMA, R: DAMMATAN, T: "لإ", Y: "إ", U: cp(0x2018), I: "÷", O: "×", P: "؛",
  "{": "<", "}": ">", A: KASRA, S: KASRATAN, D: "]", F: "[", G: "لأ", H: "أ", J: "ـ", K: "،", L: "/",
  Z: "~", X: SUKUN, C: "}", V: "{", B: "لآ", N: "آ", M: cp(0x2019), "<": ",", ">": ".", "?": "؟", "(": ")", ")": "("
};
const E2A: Record<string, string> = Object.assign({}, BASE, SHIFT);
const A2E: Record<string, string> = {};            // single Arabic char -> key
const A2E_PAIR: Record<string, string> = {};       // lam + alef-with-hamza/madda (one key each)
Object.keys(E2A).forEach(function (k) {
  var v = E2A[k];
  if (v.length === 1) A2E[v] = k; else if (k !== "b") A2E_PAIR[v] = k;
});
A2E["ی"] = "d"; A2E["ک"] = ";";                        // Persian ya / kaf typed by some phone keyboards
// Presentation-form ligatures some keyboards emit for lam-alef keys.
A2E["ﻻ"] = "b"; A2E["ﻼ"] = "b"; A2E["ﻷ"] = "G"; A2E["ﻸ"] = "G";
A2E["ﻹ"] = "T"; A2E["ﻺ"] = "T"; A2E["ﻵ"] = "B"; A2E["ﻶ"] = "B";
// Lone punctuation (no letters around it) gets its natural counterpart instead of the key it sits on.
const PUNCT_A: Record<string, string> = { "?": "؟", ",": "،", ";": "؛" }, PUNCT_E: Record<string, string> = { "؟": "?", "،": ",", "؛": ";" };

const AR_LETTER = /[ء-يٱ-ۓیکﻵ-ﻼ]/, LATIN = /[A-Za-z]/;
function countOf(s: string, re: RegExp) { var n = 0; for (var i = 0; i < s.length; i++) if (re.test(s[i])) n++; return n; }
export function detect(text: string) {
  var la = countOf(text, LATIN), ar = countOf(text, AR_LETTER);
  return la === 0 && ar === 0 ? null : la >= ar ? "ar" : "en";
}

function tokenToArabic(tok: string, lower: boolean) {
  var out = "";
  for (var i = 0; i < tok.length; i++) {
    var c = tok[i];
    if (lower && /[A-Z]/.test(c)) c = c.toLowerCase();
    out += E2A[c] != null ? E2A[c] : c;
  }
  return out;
}

// "لا" is both the B key and G+H. Pick "gh" where English spelling makes it likely (light, high, though).
function lamAlef(prev2: string, next: string | null) {
  var p = prev2.slice(-1);
  if (next === "t") return "gh";
  if (!/[a-z]/i.test(next || "") && (p === "i" || /^(ou|au|ei)$/i.test(prev2))) return "gh";
  return "b";
}
function tokenToEnglish(tok: string) {
  var units: (string | null)[] = [];
  for (var i = 0; i < tok.length; i++) {
    var two = tok.substr(i, 2);
    if (two === "لا") { units.push(null); i++; continue; }
    if (A2E_PAIR[two]) { units.push(A2E_PAIR[two]); i++; continue; }
    units.push(A2E[tok[i]] != null ? A2E[tok[i]] : tok[i]);
  }
  var out = "";
  units.forEach(function (u, i) {
    if (u === null) {
      var next: string | null = null;
      for (var j = i + 1; j < units.length && next === null; j++) next = units[j] === null ? "b" : units[j]![0];
      u = lamAlef(out.slice(-2), next);
    }
    out += u;
  });
  return out;
}

// ---------- which words were mistyped? (only needed when a text mixes both scripts) ----------
// Tiny letter-pair models built from everyday English and Arabic sentences: "hgsghl" is a very unlikely
// English word but "السلام" is a very likely Arabic one, so that word gets converted and "meeting" does not.
var CORPUS_EN = "the quick brown fox jumps over the lazy dog. hello, how are you today? i think we should meet at the office tomorrow morning because there is a lot of work to do. please send me the file when you have time. thank you very much for your help, it was really nice to see you again. what time is the meeting? i don't know yet, but i will call you later tonight. we need to buy some bread, milk and water from the shop on the way home. this is a good idea and everyone agrees with it. my phone number changed last week, so write the new one down. can you check the email and tell me if anything is missing? the weather is great, let's go out for a walk in the park. people often forget to switch the keyboard language while they are typing a message. where are you going? i am going to the doctor with my brother. thanks, see you soon. ok, sounds good. what about the price? it depends on the size and the color. could you open the window please, it's getting hot in here. my friends and i played football after school yesterday. the train leaves at nine, so we have to hurry up.";
var CORPUS_AR = "السلام عليكم ورحمة الله وبركاته. كيف حالك اليوم؟ أنا بخير والحمد لله. أين أنت الآن؟ أنا في البيت وسوف أذهب إلى العمل بعد قليل. هل يمكنك أن ترسل لي الملف عندما يكون عندك وقت؟ شكرا جزيلا على مساعدتك، كان من الجميل أن أراك مرة أخرى. متى موعد الاجتماع؟ لا أعرف حتى الآن، لكنني سأتصل بك في المساء. نحتاج أن نشتري خبزا وحليبا وماء من المحل في طريق العودة. هذه فكرة جيدة والجميع موافق عليها. تغير رقم هاتفي الأسبوع الماضي فاكتب الرقم الجديد. الجو جميل اليوم، هيا نخرج نتمشى في الحديقة. كثير من الناس ينسون تغيير لغة لوحة المفاتيح أثناء كتابة الرسائل. إلى أين أنت ذاهب؟ أنا ذاهب إلى الطبيب مع أخي. يعطيك العافية، نشوفك قريبا. تمام، ماشي الحال. شو الأخبار؟ والله مشتاقين كثير. صباح الخير، مساء النور. إن شاء الله نلتقي غدا. كم السعر؟ يعتمد على الحجم واللون. ممكن تساعدني لو سمحت؟ طبعا، بكل سرور. عيد مبارك وكل عام وأنتم بخير.";
function model(text: string) {
  var big: Record<string, number> = {}, uni: Record<string, number> = {}, alpha: Record<string, number> = { "^": 1, "$": 1 }, V = 2;
  text.toLowerCase().split(/[^\p{L}']+/u).forEach(function (w) {
    if (!w) return;
    var s = ["^"].concat(Array.from(w), ["$"]);
    for (var i = 0; i < s.length - 1; i++) {
      big[s[i] + s[i + 1]] = (big[s[i] + s[i + 1]] || 0) + 1; uni[s[i]] = (uni[s[i]] || 0) + 1;
      if (!alpha[s[i + 1]]) { alpha[s[i + 1]] = 1; V++; }
    }
  });
  return function (w: string) {   // mean log-probability per letter pair, relative to random letters
    var s = ["^"].concat(Array.from(w.toLowerCase()), ["$"]), lp = 0;
    for (var i = 0; i < s.length - 1; i++) {
      var a = s[i], b = s[i + 1];
      lp += alpha[a] && alpha[b] ? Math.log(((big[a + b] || 0) + 0.1) / ((uni[a] || 0) + 0.1 * V)) : Math.log(1e-4);
    }
    return lp / (s.length - 1) + Math.log(V);
  };
}
var scoreEn = model(CORPUS_EN), scoreAr = model(CORPUS_AR);
function core(s: string) { return s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""); }
// gain = how much more plausible the converted word is than the word as typed
function worthConverting(asTyped: string, converted: string, toArabic: boolean) {
  var a = core(asTyped), c = core(converted);
  if (!a || !c) return false;
  var gain = toArabic ? scoreAr(c) - scoreEn(a) : scoreEn(c) - scoreAr(a);
  var len = Math.max(Array.from(a).length, Array.from(c).length);
  return gain > (len <= 2 ? 1.2 : len === 3 ? 0.5 : 0.1);
}

// Converts token by token so text that is already right is left alone.
export function convert(text: string, dir?: string, opt?: { lower?: boolean }) {
  opt = opt || {};
  var tla = countOf(text, LATIN), tar = countOf(text, AR_LETTER), d: string | null | undefined = dir, n = 0;
  if (dir === "auto" || !dir) d = tla && tar ? "mixed" : tla ? "ar" : tar ? "en" : null;
  if (!d) return { text: text, dir: null, changed: 0 };
  var parts = text.split(/(\s+)/), lower = !!opt.lower;
  for (var i = 0; i < parts.length; i += 2) {
    var tok = parts[i];
    if (!tok) continue;
    var la = countOf(tok, LATIN), ar = countOf(tok, AR_LETTER), res = tok, cand: string;
    if (la === 0 && ar === 0) {
      var pm = d === "ar" ? PUNCT_A : d === "en" ? PUNCT_E : <Record<string, string>>{};
      res = tok.replace(/[?,;؟،؛]/g, function (c) { return pm[c] || c; });
    } else if (d === "mixed") {
      if (la > ar) { cand = tokenToArabic(tok, lower); if (worthConverting(tok, cand, true)) res = cand; }
      else if (ar > la) { cand = tokenToEnglish(tok); if (worthConverting(tok, cand, false)) res = cand; }
    } else if (d === "ar" && la > ar) res = tokenToArabic(tok, lower);
    else if (d === "en" && ar > la) res = tokenToEnglish(tok);
    if (res !== tok) n++;
    parts[i] = res;
  }
  return { text: parts.join(""), dir: d, changed: n };
}

export default defineTool({
  name: 'text_layout_fix',
  title: 'Keyboard layout fixer (EN ⇄ AR)',
  webSlug: 'layout-fixer',
  description:
    'Fix text typed with the wrong keyboard layout between US English (QWERTY) and Arabic (101): "hgsghl ugd;l" becomes ' +
    'the Arabic greeting, and Arabic gibberish typed on English keys becomes "hello". Direction "auto" detects it; in ' +
    'mixed text only the words that look mistyped are converted (using small English/Arabic letter-pair models), so ' +
    'words that are already right stay as they are. Handles the shift layer (harakat, hamza forms), lam-alef keys and ' +
    `Caps Lock (all-caps Latin input is treated as lowercase). Web version: ${webUrl('layout-fixer')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('The mistyped text.'),
    path: z.string().optional().describe('Or: a path to a UTF-8 text file.'),
    direction: z.enum(['auto', 'ar', 'en']).optional().default('auto')
      .describe('"auto" (default) detects; "ar" = typed on English keys, convert to Arabic; "en" = typed on Arabic keys, convert to English.'),
    capsLock: z.boolean().optional().default(false)
      .describe('Caps Lock was on: treat capital Latin letters as lowercase (detected automatically when all letters are capitals).'),
  }),
  outputSchema: z.object({
    text: z.string().describe('The fixed text.'),
    direction: z.enum(['ar', 'en', 'mixed']).nullable().describe('ar = converted to Arabic, en = converted to English, mixed = only mistyped words fixed, null = no letters.'),
    wordsChanged: z.number(),
    capsLockIgnored: z.boolean().describe('True when all-caps input was treated as Caps Lock.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: ';dt phg;?' }, output: fixLayout(';dt phg;?', 'auto', false) },
    { input: { text: 'Hi, ok ' + convert('hello', 'ar').text }, note: 'Mixed text: only the mistyped Arabic-looking word becomes "hello".' },
  ],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    return fixLayout(text, input.direction, input.capsLock);
  },
});

/** What the website does on each keystroke (including its Caps Lock detection). */
export function fixLayout(t: string, dir: string, caps: boolean) {
  if (!t.trim()) return { text: t, direction: null, wordsChanged: 0, capsLockIgnored: false };
  const letters = t.replace(/[^A-Za-z]/g, ''), capsOn = caps || (letters.length >= 3 && letters === letters.toUpperCase() && /[A-Z]/.test(letters));
  const r = convert(t, dir, { lower: capsOn });
  return { text: r.text, direction: (r.dir ?? null) as 'ar' | 'en' | 'mixed' | null, wordsChanged: r.changed, capsLockIgnored: capsOn && !caps && r.dir === 'ar' };
}

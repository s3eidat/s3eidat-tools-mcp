import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/number-words (app.js): English (cardinal, ordinal, cheque) and Arabic
// tafqeet with currency, gender and number agreement. Arabic words are copied byte for byte from the website.
export const MAX_INT = 999999999999999n; // 999 trillion

export interface Num { neg: boolean; int: bigint; frac: string }
export type Parsed = Partial<Num> & { empty?: boolean; error?: string };
interface ArNoun { s: string; d: string; p: string; a: string; f?: boolean }
interface ArScale { s: string; d: string; dc: string; p: string; a: string }
export interface Currency { label: string; per: number; en: [string, string]; enSub: [string, string]; ar: ArNoun; arSub: ArNoun }
export interface Opts { only: boolean; brit: boolean; subStyle: 'words' | 'fraction'; mia: boolean }

// ---------- currencies ----------
// en: [singular, plural]; ar: {s: singular, d: dual, p: plural (3-10), a: accusative singular (11-99), f: feminine noun?}
export const CUR = <Record<string, Currency>><unknown>{
  none: { label: "No currency" },
  JOD: { label: "Jordanian dinar (JOD)", per: 1000, en: ["dinar", "dinars"], enSub: ["fils", "fils"],
    ar: { s: "دينار", d: "ديناران", p: "دنانير", a: "ديناراً" }, arSub: { s: "فلس", d: "فلسان", p: "فلوس", a: "فلساً" } },
  USD: { label: "US dollar (USD)", per: 100, en: ["dollar", "dollars"], enSub: ["cent", "cents"],
    ar: { s: "دولار", d: "دولاران", p: "دولارات", a: "دولاراً" }, arSub: { s: "سنت", d: "سنتان", p: "سنتات", a: "سنتاً" } },
  SAR: { label: "Saudi riyal (SAR)", per: 100, en: ["riyal", "riyals"], enSub: ["halala", "halalas"],
    ar: { s: "ريال", d: "ريالان", p: "ريالات", a: "ريالاً" }, arSub: { s: "هللة", d: "هللتان", p: "هللات", a: "هللة", f: true } },
  AED: { label: "UAE dirham (AED)", per: 100, en: ["dirham", "dirhams"], enSub: ["fils", "fils"],
    ar: { s: "درهم", d: "درهمان", p: "دراهم", a: "درهماً" }, arSub: { s: "فلس", d: "فلسان", p: "فلوس", a: "فلساً" } },
  KWD: { label: "Kuwaiti dinar (KWD)", per: 1000, en: ["dinar", "dinars"], enSub: ["fils", "fils"],
    ar: { s: "دينار", d: "ديناران", p: "دنانير", a: "ديناراً" }, arSub: { s: "فلس", d: "فلسان", p: "فلوس", a: "فلساً" } },
  EGP: { label: "Egyptian pound (EGP)", per: 100, en: ["pound", "pounds"], enSub: ["piastre", "piastres"],
    ar: { s: "جنيه", d: "جنيهان", p: "جنيهات", a: "جنيهاً" }, arSub: { s: "قرش", d: "قرشان", p: "قروش", a: "قرشاً" } },
  GBP: { label: "British pound (GBP)", per: 100, en: ["pound", "pounds"], enSub: ["penny", "pence"],
    ar: { s: "جنيه", d: "جنيهان", p: "جنيهات", a: "جنيهاً" }, arSub: { s: "بنس", d: "بنسان", p: "بنسات", a: "بنساً" } }
};

// ---------- parsing ----------
// Returns {neg, int: BigInt, frac: "digits as typed"} or {error}
export function parse(raw: string | number): Parsed {
  var s = String(raw).trim()
    .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x660); })
    .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x6F0); })
    .replace(/٫/g, ".").replace(/[,٬_\s']/g, "");
  if (!s) return { empty: true };
  var m = /^([-+−]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return { error: "That isn't a number. Use digits, with an optional decimal point." };
  var int = BigInt(m[2] || "0");
  if (int > MAX_INT) return { error: "Numbers up to 999 trillion (15 digits) are supported." };
  return { neg: m[1] === "-" || m[1] === "−", int: int, frac: m[3] || "" };
}
// Split into main units and sub-units, rounding half up to the currency's precision.
export function money(p: Num, per: number) {
  var digits = per === 1000 ? 3 : 2, f = (p.frac + "000").slice(0, digits), next = +(p.frac.charAt(digits) || 0);
  var total = p.int * BigInt(per) + BigInt(f) + (next >= 5 ? 1n : 0n);
  return { main: total / BigInt(per), sub: Number(total % BigInt(per)) };
}
function groups(n: bigint | number) { var g: number[] = []; n = BigInt(n); do { g.push(Number(n % 1000n)); n /= 1000n; } while (n > 0n); return g; } // least significant first

// ---------- English ----------
var EN1 = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
var EN10 = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
var ENS = ["", "thousand", "million", "billion", "trillion"];
function en100(n: number): string { return n < 20 ? EN1[n] : EN10[Math.floor(n / 10)] + (n % 10 ? "-" + EN1[n % 10] : ""); }
function en1000(n: number, brit?: boolean) {
  var h = Math.floor(n / 100), r = n % 100, out: string[] = [];
  if (h) out.push(EN1[h] + " hundred");
  if (r) out.push((h && brit ? "and " : "") + en100(r));
  return out.join(" ");
}
export function enInt(n: bigint | number, brit?: boolean): string {
  n = BigInt(n);
  if (n > MAX_INT) throw new Error("over 999 trillion");
  if (n === 0n) return "zero";
  var g = groups(n), parts: string[] = [];
  for (var i = g.length - 1; i >= 0; i--) {
    if (!g[i]) continue;
    var w = en1000(g[i], brit);
    // British: "one thousand and five" when the last group is under 100
    if (brit && i === 0 && g.length > 1 && g[0] < 100) w = "and " + w;
    parts.push(w + (i ? " " + ENS[i] : ""));
  }
  return parts.join(" ");
}
const ORD: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
export function enOrdinal(words: string) {
  return words.replace(/([a-z]+)$/, function (w) { return ORD[w] || (/y$/.test(w) ? w.slice(0, -1) + "ieth" : w + "th"); });
}
export function ordSuffix(n: bigint | number) { n = BigInt(n); var t = Number(n % 100n), u = Number(n % 10n); return (t >= 11 && t <= 13) ? "th" : ["th", "st", "nd", "rd"][u] || "th"; }
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
export function enCheque(p: Num, c: Currency, o: Partial<Opts>) {
  var m = money(p, c.per), parts: string[] = [], digits = c.per === 1000 ? 3 : 2;
  if (o.subStyle === "fraction") {
    var main = enInt(m.main, o.brit), frac = String(m.sub).padStart(digits, "0") + "/" + c.per;
    return cap(main + " and " + frac + " " + (m.main === 1n ? c.en[0] : c.en[1])) + (o.only ? " only" : "");
  }
  if (m.main > 0n || m.sub === 0) parts.push(enInt(m.main, o.brit) + " " + (m.main === 1n ? c.en[0] : c.en[1]));
  if (m.sub) parts.push(enInt(m.sub, o.brit) + " " + (m.sub === 1 ? c.enSub[0] : c.enSub[1]));
  return cap(parts.join(" and ")) + (o.only ? " only" : "");
}
export function enCardinal(p: Num, brit?: boolean) {
  var w = enInt(p.int, brit);
  if (p.frac) w += " point " + Array.from(p.frac).map(function (d) { return EN1[+d]; }).join(" ");
  return (p.neg && (p.int > 0n || /[1-9]/.test(p.frac)) ? "minus " : "") + w;
}

// ---------- Arabic ----------
var AR_M = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة"]; // forms used with a masculine noun
var AR_F = ["", "واحدة", "اثنتان", "ثلاث", "أربع", "خمس", "ست", "سبع", "ثماني", "تسع", "عشر"];      // forms used with a feminine noun
var AR_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
var AR_H = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
const AR_SCALE: (ArScale | null)[] = [null,
  { s: "ألف", d: "ألفان", dc: "ألفا", p: "آلاف", a: "ألفاً" },
  { s: "مليون", d: "مليونان", dc: "مليونا", p: "ملايين", a: "مليوناً" },
  { s: "مليار", d: "ملياران", dc: "مليارا", p: "مليارات", a: "ملياراً" },
  { s: "تريليون", d: "تريليونان", dc: "تريليونا", p: "تريليونات", a: "تريليوناً" }];

function ar100(n: number, fem?: boolean): string {
  if (n <= 10) return (fem ? AR_F : AR_M)[n];
  if (n === 11) return fem ? "إحدى عشرة" : "أحد عشر";
  if (n === 12) return fem ? "اثنتا عشرة" : "اثنا عشر";
  if (n < 20) return (fem ? AR_F : AR_M)[n - 10] + (fem ? " عشرة" : " عشر");
  var u = n % 10, t = AR_TENS[Math.floor(n / 10)];
  if (!u) return t;
  var unit = u === 1 ? (fem ? "إحدى" : "واحد") : (fem ? AR_F : AR_M)[u];
  return unit + " و" + t;
}
// construct: "مائتان" becomes "مائتا" when a noun follows it directly (مائتا ألف، مائتا دينار)
function ar1000(n: number, fem?: boolean, construct?: boolean) {
  var h = Math.floor(n / 100), r = n % 100, out: string[] = [];
  if (h) out.push(h === 2 && !r && construct ? "مائتا" : AR_H[h]);
  if (r) out.push(ar100(r, fem));
  return out.join(" و");
}
// Number words; `fem` applies to the last (units) group, `nounFollows` turns a trailing dual into its construct form.
export function arInt(n: bigint | number, fem?: boolean, nounFollows?: boolean): string {
  n = BigInt(n);
  if (n > MAX_INT) throw new Error("over 999 trillion");
  if (n === 0n) return "صفر";
  var g = groups(n), parts: string[] = [];
  var lowest = g.findIndex(function (x) { return x !== 0; });
  for (var i = g.length - 1; i >= 0; i--) {
    var v = g[i]; if (!v) continue;
    var last = i === lowest;
    if (i === 0) { parts.push(ar1000(v, fem, nounFollows && last)); continue; }
    var sc = AR_SCALE[i]!, r = v % 100, w: string;
    if (v === 1) w = sc.s;
    else if (v === 2) w = last && nounFollows ? sc.dc : sc.d;
    else if (v <= 10) w = ar100(v, false) + " " + sc.p;
    else if (v < 100) w = ar100(v, false) + " " + sc.a;
    else w = ar1000(v, false, true) + " " + (r === 0 || r <= 2 ? sc.s : r <= 10 ? sc.p : sc.a);
    parts.push(w);
  }
  return parts.join(" و");
}
// The counted noun's form depends on the number: 1 (noun + واحد), 2 (dual alone), 3-10 plural, 11-99 accusative, 100+ by the last two digits.
function arCount(n: bigint | number, noun: ArNoun) {
  n = BigInt(n);
  var fem = !!noun.f;
  if (n === 1n) return noun.s + " " + (fem ? "واحدة" : "واحد");
  if (n === 2n) return noun.d;
  var r = Number(n % 100n);
  if (n < 100n) return arInt(n, fem) + " " + (n <= 10n ? noun.p : noun.a);
  if (r === 0) return arInt(n, fem, true) + " " + noun.s;
  return arInt(n, fem) + " " + (r <= 2 ? noun.s : r <= 10 ? noun.p : noun.a);
}
export function arMoney(p: Num, c: Currency, o: Partial<Opts>) {
  var m = money(p, c.per), parts: string[] = [];
  if (m.main > 0n || m.sub === 0) parts.push(m.main === 0n ? "صفر " + c.ar.s : arCount(m.main, c.ar));
  if (m.sub) parts.push(arCount(m.sub, c.arSub));
  var s = parts.join(" و");
  if (o.only) s = "فقط " + s + " لا غير";
  return o.mia ? s.replace(/مائ/g, "مئ") : s;
}
export function arCardinal(p: Num, o: Partial<Opts>) {
  var s = arInt(p.int, false);
  if (p.frac) {
    var lead = (/^0+/.exec(p.frac) || [""])[0], rest = p.frac.slice(lead.length);
    s += " فاصلة " + (Array.from(lead).map(function () { return "صفر"; }).concat(rest ? [arInt(BigInt(rest), false)] : [])).join(" ");
  }
  if (p.neg && (p.int > 0n || /[1-9]/.test(p.frac))) s = "سالب " + s;
  return o.mia ? s.replace(/مائ/g, "مئ") : s;
}

const withCommas = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const CURRENCIES = Object.keys(CUR) as [string, ...string[]];

export default defineTool({
  name: 'text_number_to_words',
  title: 'Number to words (English & Arabic)',
  webSlug: 'number-words',
  description:
    'Spell a number in words in English and Arabic: English cardinal (with decimals, optional British "and"), ordinal ' +
    '(twenty-first), cheque wording for an amount in a currency (cents in words or as 25/100, optional "only"), Arabic ' +
    'cardinal, and Arabic tafqeet for amounts with correct gender/number agreement of the currency noun (optional ' +
    '"faqat … la ghayr" wrapper and the modern 100 spelling). Currencies: JOD, USD, SAR, AED, KWD, EGP, GBP (or none). ' +
    'Accepts Arabic-Indic digits and thousands separators. Up to 999 trillion (15 digits). ' +
    `Web version: ${webUrl('number-words')}`,
  inputSchema: z.object({
    number: z.union([z.string(), z.number()]).describe('The number or amount, e.g. "1500.250", "1,234,567.89", -12.05 (Arabic-Indic digits work too).'),
    currency: z.enum(CURRENCIES).optional().default('none').describe('Currency for cheque / tafqeet wording: none (default), JOD, USD, SAR, AED, KWD, EGP, GBP.'),
    only: z.boolean().optional().default(false).describe('Add "only" (English) and the Arabic "faqat … la ghayr" wrapper to amounts.'),
    british: z.boolean().optional().default(false).describe('British English "and": one hundred and five.'),
    subStyle: z.enum(['words', 'fraction']).optional().default('words').describe('Cheque sub-units in words (twenty-five cents) or as a fraction (25/100).'),
    modernHundred: z.boolean().optional().default(false).describe('Arabic: use the modern spelling of "hundred" (without the extra alif).'),
  }),
  outputSchema: z.object({
    digits: z.string().describe('The number as parsed, with thousands separators.'),
    english: z.string().describe('English cardinal words.'),
    ordinal: z.string().optional().describe('English ordinal (whole non-negative numbers only).'),
    ordinalShort: z.string().optional().describe('Ordinal in digits, e.g. 21st.'),
    arabic: z.string().describe('Arabic cardinal words.'),
    englishAmount: z.string().optional().describe('Cheque wording in the currency (when a currency is set).'),
    arabicAmount: z.string().optional().describe('Arabic tafqeet of the amount (when a currency is set).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { number: '21' }, output: convert({ number: '21', currency: 'none', only: false, british: false, subStyle: 'words', modernHundred: false }) },
    { input: { number: '1500.25', currency: 'USD' }, note: 'englishAmount: "One thousand five hundred dollars and twenty-five cents", plus the Arabic tafqeet' },
  ],
  run: (input) => convert(input),
});

interface Input { number: string | number; currency: string; only: boolean; british: boolean; subStyle: 'words' | 'fraction'; modernHundred: boolean }

/** Everything the website shows for one number. */
export function convert(input: Input) {
  const p = parse(input.number);
  if (p.empty) throw new ToolError('Give a number.');
  if (p.error) throw new ToolError(p.error);
  const n = p as Num, o: Opts = { only: input.only, brit: input.british, subStyle: input.subStyle, mia: input.modernHundred };
  const isMoney = input.currency !== 'none', c = CUR[input.currency];
  const out: Record<string, string> = {
    digits: (n.neg ? '−' : '') + withCommas(n.int) + (n.frac ? '.' + n.frac : '') + (isMoney ? ' ' + input.currency : ''),
    english: enCardinal(n, o.brit),
  };
  if (!n.neg && !/[1-9]/.test(n.frac)) {
    out.ordinal = enOrdinal(enInt(n.int, o.brit));
    out.ordinalShort = withCommas(n.int) + ordSuffix(n.int);
  }
  out.arabic = arCardinal(n, o);
  if (isMoney) {
    if (n.neg) throw new ToolError("Amounts in words can't be negative.");
    if (money(n, c.per).main > MAX_INT) throw new ToolError('After rounding to ' + c.per + ' sub-units this is over 999 trillion.');
    out.englishAmount = enCheque(n, c, o);
    out.arabicAmount = arMoney(n, c, o);
  }
  return out;
}

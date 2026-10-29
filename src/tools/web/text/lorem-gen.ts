import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { writeOutput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/lorem-gen (app.js): same word lists, sentence shapes and seeded PRNG
// (mulberry32), so a given seed gives the same text as the website's generator. Word lists copied byte for byte.
export type Style = 'lorem' | 'english' | 'arabic';
export type Unit = 'paragraphs' | 'sentences' | 'words';
export interface LoremOptions { style: Style; unit: Unit; count: number; opener: boolean; html: boolean; seed: number }

const WORDS: Record<Style, string[]> = {
  lorem: ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua " +
    "enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in " +
    "reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui " +
    "officia deserunt mollit anim id est laborum curabitur pretium tincidunt lacus nunc pulvinar sapien ligula vitae accumsan " +
    "faucibus orci luctus ultrices posuere cubilia integer feugiat scelerisque varius morbi blandit cursus risus viverra maecenas " +
    "pharetra convallis aenean euismod elementum nisl purus mattis vulputate dignissim suspendisse potenti nullam porttitor").split(" "),
  english: ("the a and of to in that it with as for on was this by from at but they have one all were we when your can said there " +
    "use each which she do how their if will up other about out many then them these so some her would make like him into time " +
    "has look two more write go see number no way could people my than first water been call who oil its now find long down day " +
    "did get come made may part over new sound take only little work know place year live back give most very after thing our " +
    "just name good sentence man think say great where help through much before line right too mean old any same tell boy follow " +
    "came want show also around form three small set put end does another well large must big even such because turn here why " +
    "ask went men read need land different home us move try kind hand picture again change off play spell air away animal house " +
    "point page letter mother answer found study still learn should world high every near add food between own below country plant " +
    "last school father keep tree never start city earth eye light thought head under story saw left few while along might close " +
    "something seem next hard open example begin life always those both paper together got group often run important until " +
    "children side feet car mile night walk white sea began grow took river four carry state once book hear stop without second " +
    "later miss idea enough eat face watch far real almost let above girl sometimes mountain cut young talk soon list song being " +
    "leave family quiet bright simple design gentle").split(" "),
  arabic: ("في من على إلى عن مع هذا هذه التي الذي كان يكون كل بعض بين عند حتى أن لكن ثم قد لقد ما لا هو هي نحن هم " +
    "الوقت اليوم العالم الناس الحياة الطريق البيت المدينة الكتاب العمل الفكرة الصورة النص المساحة الشكل التصميم الموقع الصفحة " +
    "القارئ الكلمات الحروف الفقرة المحتوى المثال الطبيعي الجديد الجميل الواضح البسيط الكبير الصغير الأول الأخير الحقيقي " +
    "يمكن يجب يبدو يستطيع يعطي يقدم يساعد يجعل يظهر يكتب يقرأ يعرف يرى يأتي يذهب يبقى يعمل يحتاج يستخدم يختار يضيف " +
    "توزيع مقبول طويل قصير سهل جيد أفضل أكثر أقل دائما أحيانا كثيرا قليلا معا هنا هناك أيضا فقط تماما ربما " +
    "مصمم عميل مشروع نموذج تجربة فكرة رسالة قصة لون ضوء ماء سماء أرض شمس قمر بحر جبل شجرة زهرة طفل صديق معلم").split(" ")
};
export const OPENER: Record<Style, string> = {
  lorem: "Lorem ipsum dolor sit amet, consectetur adipiscing elit",
  english: "The quick brown fox jumps over the lazy dog",
  arabic: "هذا النص هو مثال لنص يمكن أن يستبدل في نفس المساحة"
};
export const LIMITS: Record<Unit, number> = { paragraphs: 100, sentences: 500, words: 10000 };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Seeded PRNG (mulberry32) so the self-test is repeatable.
function rng(seed: number) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function between(r: () => number, lo: number, hi: number) { return lo + Math.floor(r() * (hi - lo + 1)); }
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

function pickWords(style: Style, n: number, r: () => number, prev: string | undefined) {
  var list = WORDS[style], out: string[] = [];
  for (var i = 0; i < n; i++) {
    var w: string;
    do { w = list[Math.floor(r() * list.length)]; } while (w === (out.length ? out[out.length - 1] : prev) && list.length > 1);
    out.push(w);
  }
  return out;
}

function sentence(style: Style, r: () => number, opener: boolean) {
  var comma = style === "arabic" ? "،" : ",";
  var words = opener ? OPENER[style].split(" ") : [];
  var extra = opener ? between(r, 0, 4) : between(r, 6, 14);
  words = words.concat(pickWords(style, extra, r, words[words.length - 1]));
  if (!opener && words.length > 7 && r() < 0.5) { var at = between(r, 2, words.length - 3); words[at] += comma; }
  var s = words.join(" ");
  return (style === "arabic" ? s : cap(s)) + ".";
}

// opts: {style, unit, count, opener, html, seed}
export function generate(opts: LoremOptions): string {
  var r = rng(opts.seed), style = opts.style, n = Math.max(1, Math.min(LIMITS[opts.unit], opts.count | 0 || 1));
  var paras: string[] = [];
  if (opts.unit === "words") {
    var w = opts.opener ? OPENER[style].replace(/,/g, "").split(" ").slice(0, n) : [];
    w = w.concat(pickWords(style, n - w.length, r, w[w.length - 1]));
    var t = w.join(" ");
    paras.push((style === "arabic" ? t : cap(t)) + ".");
  } else if (opts.unit === "sentences") {
    var ss: string[] = [];
    for (var i = 0; i < n; i++) ss.push(sentence(style, r, opts.opener && i === 0));
    paras.push(ss.join(" "));
  } else {
    for (var p = 0; p < n; p++) {
      var k = between(r, 3, 7), list: string[] = [];
      for (var j = 0; j < k; j++) list.push(sentence(style, r, opts.opener && p === 0 && j === 0));
      paras.push(list.join(" "));
    }
  }
  if (opts.html) return paras.map(function (x) { return "<p>" + esc(x) + "</p>"; }).join("\n");
  return paras.join("\n\n");
}

export function countWords(text: string) { var m = text.replace(/<\/?p>/g, " ").match(/[^\s]+/g); return m ? m.length : 0; }

export default defineTool({
  name: 'text_lorem',
  title: 'Lorem ipsum generator',
  webSlug: 'lorem-gen',
  description:
    'Generate placeholder text: classic Lorem ipsum, readable English filler, or Arabic filler. Choose paragraphs ' +
    `(max ${LIMITS.paragraphs}), sentences (max ${LIMITS.sentences}) or words (max ${LIMITS.words}); optionally start with the ` +
    'classic opener and wrap paragraphs in <p> tags. Give a seed for repeatable output (the same seed gives the same text). ' +
    `Writes a .txt/.html file instead when "output" is given. Web version: ${webUrl('lorem-gen')}`,
  inputSchema: z.object({
    style: z.enum(['lorem', 'english', 'arabic']).optional().default('lorem').describe('Word list: lorem (Latin), english, or arabic.'),
    unit: z.enum(['paragraphs', 'sentences', 'words']).optional().default('paragraphs').describe('What "count" counts.'),
    count: z.number().int().min(1).optional().default(3).describe('How many paragraphs / sentences / words (clamped to the unit limit).'),
    opener: z.boolean().optional().default(true).describe('Start with the classic opening line ("Lorem ipsum dolor sit amet…", "The quick brown fox…", or the Arabic one). Default true.'),
    html: z.boolean().optional().default(false).describe('Wrap each paragraph in <p>…</p>.'),
    seed: z.number().int().min(0).max(4294967295).optional().describe('Seed for repeatable output (default: random).'),
    output: z.string().optional().describe('Optional: write the text to this file path (or folder ending in "/") instead of returning it.'),
  }),
  outputSchema: z.object({
    text: z.string().optional().describe('The generated text (omitted when written to "output").'),
    path: z.string().optional(), bytes: z.number().optional(),
    words: z.number(), characters: z.number(), paragraphs: z.number(), seed: z.number().describe('Seed used: pass it again to get the same text.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  examples: [
    { input: { unit: 'words', count: 25, seed: 42 }, note: '25 words starting "Lorem ipsum dolor sit amet…"' },
    { input: { style: 'arabic', unit: 'paragraphs', count: 2 } },
  ],
  async run(input, ctx) {
    const seed = input.seed ?? randomInt(0, 2 ** 32);
    const count = Math.max(1, Math.min(LIMITS[input.unit], input.count));
    const text = generate({ style: input.style, unit: input.unit, count, opener: input.opener, html: input.html, seed });
    const plain = text.replace(/<\/?p>/g, '');
    const stats = {
      words: countWords(text), characters: plain.replace(/\n/g, '').length,
      paragraphs: input.unit === 'paragraphs' ? count : 1, seed,
    };
    if (input.output) {
      const f = await writeOutput(text + '\n', {
        output: input.output, defaultName: input.html ? 'placeholder.html' : 'placeholder.txt', mimeType: input.html ? 'text/html' : 'text/plain',
      }, ctx);
      return { path: f.path, bytes: f.bytes, ...stats };
    }
    return { text, ...stats };
  },
});

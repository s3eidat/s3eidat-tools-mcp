import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { readTextInput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/word-count (app.js) so counts match the website.
const READ_WPM = 238, SPEAK_WPM = 150;
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}ـ_]|['’\-](?=[\p{L}\p{N}])|(?<=\p{N})[.,](?=\p{N}))*/gu;
const HAS_WORD = new RegExp(WORD.source, 'u');
const TASHKEEL = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e8\u06ea-\u06ed\u0640]/g;

const STOP = new Set((
  "a about above after again against all am an and any are aren't as at be because been before being below between both but by " +
  "can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't " +
  "have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is " +
  "isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves " +
  "out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves " +
  "then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd " +
  "we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's will with won't would " +
  "wouldn't you you'd you'll you're you've your yours yourself yourselves also just can will may might us get got one two like " +
  "في من على علي إلى الى عن مع هذا هذه ذلك تلك هؤلاء التي الذي الذين اللذين اللتين اللاتي أن ان إن لأن كان كانت يكون تكون كانوا " +
  "لا ما لم لن قد لقد و أو او ثم هو هي هم هن نحن أنا انا أنت انت أنتم كل بعض عند بين حتى إذا اذا لكن ولكن بل غير سوى منذ خلال " +
  "عليه عليها عليهم فيه فيها فيهم منه منها منهم به بها بهم له لها لهم إليه اليه إليها كما أي اي أيضا ايضا هناك هنا وقد وهو وهي " +
  "ولا وما وفي ومن وعلى وإلى وأن وان التى الذى فى أى يا ثم إلا الا كيف متى أين اين لماذا ماذا قبل بعد فوق تحت عندما حيث"
).split(/\s+/));

export function words(text: string): string[] {
  return text.match(WORD) || [];
}

const graphemer = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function charCount(s: string) {
  if (!s) return 0;
  let n = 0;
  for (const _ of graphemer.segment(s)) n++;
  return n;
}

const normalize = (w: string) => w.replace(TASHKEEL, '').replace(/’/g, "'").toLocaleLowerCase();

export function analyze(text: string) {
  const ws = words(text);
  const sentences = text.split(/[.!?؟۔…]+(?=\s|$|["'”’)\]])|\n\s*\n/).filter((s) => HAS_WORD.test(s)).length;
  const paragraphs = text.split(/\n/).filter((l) => /\S/.test(l)).length;
  const lines = text ? text.split('\n').length : 0;
  const uniq = new Set(ws.map(normalize));
  const letters = ws.reduce((s, w) => s + charCount(w.replace(TASHKEEL, '')), 0);
  const longest = ws.reduce((a, w) => (charCount(w) > charCount(a) ? w : a), '');
  return {
    words: ws.length, chars: charCount(text), charsNoSpaces: charCount(text.replace(/\s+/g, '')),
    sentences, paragraphs, lines, unique: uniq.size,
    avgWord: ws.length ? letters / ws.length : 0, longest,
    readSec: Math.round((ws.length / READ_WPM) * 60), speakSec: Math.round((ws.length / SPEAK_WPM) * 60),
  };
}

export function keywords(text: string, includeStop: boolean, limit = 12) {
  const ws = words(text), total = ws.length, map = new Map<string, number>();
  for (const w of ws) {
    const k = normalize(w);
    if (/^\p{N}+$/u.test(k) || Array.from(k).length < 2) continue;
    if (!includeStop && (STOP.has(k) || STOP.has(k.replace(/^[وف](?=.{3,})/, '')))) continue;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return Array.from(map, ([word, count]) => ({ word, count, density: total ? (count / total) * 100 : 0 }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1))
    .slice(0, limit);
}

export default defineTool({
  name: 'text_word_count',
  title: 'Word count',
  webSlug: 'word-count',
  description:
    'Count words, characters (with and without spaces), sentences, paragraphs, lines and unique words; estimate reading ' +
    '(238 wpm) and speaking (150 wpm) time; list the most used keywords with density. Works for English and Arabic ' +
    `(tashkeel ignored). Give "text" or a text file "path". Web version: ${webUrl('word-count')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('The text to analyse.'),
    path: z.string().optional().describe('Or: a path to a UTF-8 text file.'),
    keywords: z.number().int().min(0).max(100).optional().default(12).describe('How many top keywords to return (0 = none).'),
    includeStopWords: z.boolean().optional().default(false).describe('Count common words like "the"/"في" as keywords.'),
  }),
  outputSchema: z.object({
    words: z.number(), characters: z.number(), charactersNoSpaces: z.number(), sentences: z.number(),
    paragraphs: z.number(), lines: z.number(), uniqueWords: z.number(), averageWordLength: z.number(),
    longestWord: z.string(), readingTimeSeconds: z.number(), speakingTimeSeconds: z.number(),
    keywords: z.array(z.object({ word: z.string(), count: z.number(), density: z.number() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { text: 'Hello world. This is a test! Is it?\n\nNew paragraph here.' }, note: '11 words, 4 sentences, 2 paragraphs' }],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    const a = analyze(text);
    return {
      words: a.words, characters: a.chars, charactersNoSpaces: a.charsNoSpaces, sentences: a.sentences,
      paragraphs: a.paragraphs, lines: a.lines, uniqueWords: a.unique, averageWordLength: Math.round(a.avgWord * 100) / 100,
      longestWord: a.longest, readingTimeSeconds: a.readSec, speakingTimeSeconds: a.speakSec,
      keywords: input.keywords ? keywords(text, input.includeStopWords, input.keywords).map((k) => ({ ...k, density: Math.round(k.density * 100) / 100 })) : [],
    };
  },
});

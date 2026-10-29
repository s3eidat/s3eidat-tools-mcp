import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { readTextInput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/readability (app.js): classic English readability formulas plus
// Hemingway-style hints, same sentence splitter, syllable estimate and constants as the website.

// ---------- text analysis ----------
const ABBR = new Set('mr mrs ms dr prof st jr sr vs etc eg ie no fig mt approx dept est inc ltd co jan feb mar apr jun jul aug sep sept oct nov dec'.split(' '));
const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const HAS_WORD = new RegExp(WORD.source, 'u');

export interface Sentence { start: number; end: number; words?: number; level?: '' | 'hard' | 'vhard' }

// Sentences with offsets: end at . ! ? when the next word starts with a capital or digit (or at the end), and at line breaks.
export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [], re = /[.!?…]+["'”’)\]]*(?=\s+["'“‘(\[]?[\p{Lu}\p{N}]|\s*$)|\n+/gu;
  let start = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === '.') {
      const prev = /([\p{L}.]+)$/u.exec(text.slice(start, m.index)), tok = prev ? prev[1].replace(/\./g, '') : '';
      if (prev && (ABBR.has(tok.toLowerCase()) || /^\p{Lu}$/u.test(tok))) continue; // Dr. Smith, J. K. Rowling
    }
    const end = m[0][0] === '\n' ? m.index : m.index + m[0].length;
    out.push({ start, end });
    start = m.index + m[0].length;
  }
  out.push({ start, end: text.length });
  return out.map((s) => {
    while (s.start < s.end && /\s/.test(text[s.start])) s.start++;
    while (s.end > s.start && /\s/.test(text[s.end - 1])) s.end--;
    return s;
  }).filter((s) => HAS_WORD.test(text.slice(s.start, s.end)));
}

// English syllable estimate (no dictionary): vowel groups, minus silent endings.
export function syllables(word: string) {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?<=[^td])ed$/, '').replace(/(?<=[^laeiouysxzhc])es$/, '').replace(/(?<=[^laeiouy])e$/, '').replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}

export interface Counts { words: number; sentences: number; syllables: number; complex: number; poly: number; letters: number; chars: number }

export function formulas(c: Counts) {
  const wps = c.words / c.sentences, spw = c.syllables / c.words;
  return {
    fre: 206.835 - 1.015 * wps - 84.6 * spw,
    fk: 0.39 * wps + 11.8 * spw - 15.59,
    fog: 0.4 * (wps + 100 * c.complex / c.words),
    smog: 1.043 * Math.sqrt(c.poly * 30 / c.sentences) + 3.1291,
    cli: 0.0588 * (c.letters / c.words * 100) - 0.296 * (c.sentences / c.words * 100) - 15.8,
    ari: 4.71 * (c.chars / c.words) + 0.5 * wps - 21.43,
  };
}

const PASSIVE = /\b(am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(\w+ed|known|done|made|seen|given|taken|written|shown|built|found|kept|left|said|told|thought|brought|bought|caught|taught|held|paid|sent|spent|won|led|put|set|cut|hit|hurt|begun|broken|chosen|driven|eaten|fallen|forgotten|gotten|hidden|ridden|spoken|stolen|thrown|worn|drawn|grown|flown|blown|sold|understood|felt|heard|met|meant|born|lost|run)\b/gi;
const NOT_ADVERB = new Set('only family early reply supply apply july fly holy ugly belly bully daily friendly lovely lonely silly rely ally italy jelly rally lily bully holly folly costly elderly likely lowly orderly unlikely ugly assembly anomaly monopoly melancholy butterfly dragonfly firefly sly wily oily curly hilly chilly smelly jolly woolly comply multiply imply ply'.split(' '));
const ADVERB = /\b[A-Za-z]{2,}ly\b/g;

export interface Mark { start: number; end: number; kind: 'passive' | 'adverb' }

export function analyze(text: string) {
  const sents = sentences(text), all = text.match(WORD) || [];
  const c: Counts = { words: all.length, sentences: Math.max(1, sents.length), syllables: 0, complex: 0, poly: 0, letters: 0, chars: 0 };
  all.forEach((w) => {
    const s = syllables(w);
    c.syllables += s;
    if (s >= 3) {
      c.poly++;
      // Gunning Fog leaves out words that only reach 3 syllables through -es, -ed or -ing.
      const stem = w.replace(/(es|ed|ing)$/i, '');
      if (stem === w || syllables(stem) >= 3) c.complex++;
    }
    c.letters += (w.match(/\p{L}/gu) || []).length;
    c.chars += (w.match(/[\p{L}\p{N}]/gu) || []).length;
  });
  const marks: Mark[] = [];
  sents.forEach((s) => {
    const n = (text.slice(s.start, s.end).match(WORD) || []).length;
    s.words = n; s.level = n > 30 ? 'vhard' : n > 20 ? 'hard' : '';
  });
  let m: RegExpExecArray | null;
  PASSIVE.lastIndex = 0;
  while ((m = PASSIVE.exec(text))) marks.push({ start: m.index, end: m.index + m[0].length, kind: 'passive' });
  ADVERB.lastIndex = 0;
  while ((m = ADVERB.exec(text))) {
    const hit = m;
    if (NOT_ADVERB.has(hit[0].toLowerCase())) continue;
    if (marks.some((x) => hit.index < x.end && hit.index + hit[0].length > x.start)) continue;
    marks.push({ start: hit.index, end: hit.index + hit[0].length, kind: 'adverb' });
  }
  marks.sort((a, b) => a.start - b.start);
  const arabic = (text.match(/[؀-ۿ]/g) || []).length, latin = (text.match(/[A-Za-z]/g) || []).length;
  return { counts: c, sents, marks, scores: c.words ? formulas(c) : null, arabic: arabic > latin };
}

export function verdict(fre: number): [string, 'ok' | 'warn' | 'bad', string] {
  if (fre >= 80) return ['Very easy', 'ok', 'Short sentences and everyday words. Almost anyone can follow it.'];
  if (fre >= 70) return ['Easy', 'ok', 'Conversational. Comfortable for most readers.'];
  if (fre >= 60) return ['Plain English', 'ok', 'Clear for most adults. A good target for the web.'];
  if (fre >= 50) return ['Fairly difficult', 'warn', 'Readers need to concentrate. Shorter sentences would help.'];
  if (fre >= 30) return ['Difficult', 'warn', 'Reads like a report or a paper. Split long sentences and swap long words for short ones.'];
  return ['Very difficult', 'bad', 'Academic or legal level. Most readers will struggle.'];
}

export function gradeText(g: number) {
  if (!isFinite(g)) return '';
  const r = Math.round(g);
  if (r <= 0) return 'kindergarten';
  if (r > 16) return 'post-graduate';
  if (r > 12) return 'college (' + (r - 12) + (r - 12 === 1 ? 'st' : r - 12 === 2 ? 'nd' : r - 12 === 3 ? 'rd' : 'th') + ' year)';
  return 'grade ' + r + ' · age ' + (r + 5) + '–' + (r + 6);
}

const r1 = (n: number) => (isFinite(n) ? Math.round(n * 10) / 10 : null);
const MAX_LIST = 200;

const score = z.object({ score: z.number().nullable(), grade: z.string() });

export default defineTool({
  name: 'text_readability',
  title: 'Readability score',
  webSlug: 'readability',
  description:
    'Score how easy an English text is to read: Flesch Reading Ease, Flesch-Kincaid Grade, Gunning Fog, SMOG, Coleman-Liau ' +
    'and Automated Readability Index (same formulas, sentence splitter and syllable estimate as the website), plus a verdict, ' +
    'average grade level, and Hemingway-style hints: long sentences (over 20 / 30 words), passive voice and adverbs. ' +
    'The formulas are built for English; for Arabic text the result says so (arabicWarning). Give "text" or a text file ' +
    `"path". Web version: ${webUrl('readability')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('The text to score.'),
    path: z.string().optional().describe('Or: a path to a UTF-8 text file.'),
  }),
  outputSchema: z.object({
    readingEase: z.number().nullable().describe('Flesch Reading Ease clamped to 0–100 and rounded (the big number on the website).'),
    verdict: z.string().nullable(), verdictLevel: z.enum(['ok', 'warn', 'bad']).nullable(), advice: z.string().nullable(),
    averageGrade: z.number().nullable().describe('Mean of the five grade-level formulas.'), averageGradeText: z.string(),
    scores: z.object({
      fleschReadingEase: z.number().nullable(), fleschKincaidGrade: score, gunningFog: score, smog: score, colemanLiau: score, automatedReadability: score,
    }).nullable(),
    words: z.number(), sentences: z.number(), syllablesPerWord: z.number().nullable(), wordsPerSentence: z.number().nullable(),
    longSentences: z.array(z.object({ text: z.string(), words: z.number(), level: z.enum(['hard', 'vhard']) })).describe('Sentences over 20 (hard) or 30 (vhard) words.'),
    passive: z.array(z.string()).describe('Passive-voice phrases found.'),
    adverbs: z.array(z.string()).describe('Adverbs found (-ly words, with common non-adverbs excluded).'),
    tips: z.array(z.string()),
    smogNote: z.string().optional(), arabicWarning: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'Keep it short. Use plain words. Readers scan, so put the main point first and cut what they don\'t need.' }, note: 'Returns all six scores, the verdict and hints.' },
  ],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    const r = analyze(text), c = r.counts;
    const hard = r.sents.filter((s) => s.level === 'hard').length, vhard = r.sents.filter((s) => s.level === 'vhard').length;
    const passive = r.marks.filter((m) => m.kind === 'passive'), adverbs = r.marks.filter((m) => m.kind === 'adverb');
    const tips: string[] = [];
    if (vhard) tips.push(vhard + ' very long sentence' + (vhard > 1 ? 's' : '') + ' (over 30 words)');
    if (hard) tips.push(hard + ' long sentence' + (hard > 1 ? 's' : '') + ' (over 20 words)');
    if (passive.length) tips.push(passive.length + ' passive voice use' + (passive.length > 1 ? 's' : ''));
    if (adverbs.length > Math.max(2, c.words / 100 * 2)) tips.push(adverbs.length + ' adverbs (try fewer)');
    const s = r.scores, v = s ? verdict(s.fre) : null;
    const avg = s ? [s.fk, s.fog, s.smog, s.cli, s.ari].reduce((a, b) => a + b, 0) / 5 : NaN;
    const g = (n: number) => ({ score: r1(n), grade: gradeText(n) });
    return {
      readingEase: s ? Math.round(Math.max(0, Math.min(100, s.fre))) : null,
      verdict: v ? v[0] : null, verdictLevel: v ? v[1] : null, advice: v ? v[2] : null,
      averageGrade: s ? r1(avg) : null, averageGradeText: gradeText(avg),
      scores: s ? { fleschReadingEase: r1(s.fre), fleschKincaidGrade: g(s.fk), gunningFog: g(s.fog), smog: g(s.smog), colemanLiau: g(s.cli), automatedReadability: g(s.ari) } : null,
      words: c.words, sentences: r.sents.length,
      syllablesPerWord: c.words ? Math.round((c.syllables / c.words) * 100) / 100 : null,
      wordsPerSentence: c.words ? r1(c.words / Math.max(1, r.sents.length)) : null,
      longSentences: r.sents.filter((x) => x.level).slice(0, MAX_LIST)
        .map((x) => ({ text: text.slice(x.start, x.end), words: x.words!, level: x.level as 'hard' | 'vhard' })),
      passive: passive.slice(0, MAX_LIST).map((m) => text.slice(m.start, m.end)),
      adverbs: adverbs.slice(0, MAX_LIST).map((m) => text.slice(m.start, m.end)),
      tips: s ? (tips.length ? tips : ['No long sentences, passive voice or extra adverbs found.']) : [],
      ...(s && r.sents.length < 30 ? { smogNote: `SMOG is designed for 30+ sentences; with ${r.sents.length} it is a rough estimate.` } : {}),
      ...(r.arabic ? { arabicWarning: 'These formulas are built for English. Scores for Arabic text are not meaningful.' } : {}),
    };
  },
});

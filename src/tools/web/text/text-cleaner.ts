import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { readTextInput, writeOutput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/text-cleaner (app.js) so results match the website.
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•", euro: "€" };
function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
    if (e[0] === "#") {
      var n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
  });
}
// Text only: drop script/style/comments, turn block ends into line breaks, remove every tag, then decode entities.
function stripHtml(s: string) {
  return decode(s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|section|article|header|footer|ul|ol|table)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, ""));
}
// Pictographic emoji plus the joiners/modifiers that build them. ©, ® and ™ are kept: they are text symbols.
const EMOJI = /(?![©®™])\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}‍️⃣]/gu;

function shuffle(a: string[], rand: () => number) {
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
const cryptoRand = () => randomInt(0, 2 ** 32) / 4294967296;
/** The website's seeded LCG, used for a reproducible shuffle. */
export function seeded(sd: number): () => number { var a = sd >>> 0; return function () { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

const collator = new Intl.Collator(undefined, { sensitivity: "variant" });
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export type SortMode = 'none' | 'az' | 'za' | 'natural' | 'length';
export interface CleanOptions {
  html: boolean; emoji: boolean; trim: boolean; collapse: boolean; empty: boolean; dupes: boolean;
  ignoreCase: boolean; sort: SortMode; reverse: boolean; shuffle: boolean; number: boolean;
}
export const DEFAULTS: CleanOptions = { html: false, emoji: false, trim: true, collapse: true, empty: true, dupes: false, ignoreCase: false, sort: "none", reverse: false, shuffle: false, number: false };

// o: options; rand: random source for shuffle. Returns {text, stats}.
export function clean(text: string, o: CleanOptions, rand?: () => number) {
  var s = text.replace(/\r\n?/g, "\n"), st = { dupes: 0, empty: 0 };
  if (o.html) s = stripHtml(s);
  if (o.emoji) s = s.replace(EMOJI, "");
  var lines = s.split("\n");
  if (o.trim) lines = lines.map(function (l) { return l.trim(); });
  if (o.collapse) lines = lines.map(function (l) { return l.replace(/[ \t ]{2,}/g, " "); });
  if (o.empty) { var n = lines.length; lines = lines.filter(function (l) { return /\S/.test(l); }); st.empty = n - lines.length; }
  if (o.dupes) {
    var seen = new Set(), before = lines.length;
    lines = lines.filter(function (l) { var k = o.ignoreCase ? l.toLocaleLowerCase() : l; if (seen.has(k)) return false; seen.add(k); return true; });
    st.dupes = before - lines.length;
  }
  if (o.sort === "az") lines.sort(collator.compare);
  else if (o.sort === "za") lines.sort(function (a, b) { return collator.compare(b, a); });
  else if (o.sort === "natural") lines.sort(natural.compare);
  else if (o.sort === "length") lines.sort(function (a, b) { return Array.from(a).length - Array.from(b).length || natural.compare(a, b); });
  if (o.reverse) lines.reverse();
  if (o.shuffle) shuffle(lines, rand || cryptoRand);
  if (o.number) {
    var w = String(lines.length).length;
    lines = lines.map(function (l, i) { return String(i + 1).padStart(w, " ") + ". " + l; });
  }
  return { text: lines.join("\n"), lines: lines.length, stats: st };
}

const flag = (d: boolean, what: string) => z.boolean().optional().default(d).describe(`${what} (default ${d}).`);

export default defineTool({
  name: 'text_clean',
  title: 'Text cleaner',
  webSlug: 'text-cleaner',
  description:
    'Clean up text line by line with a fixed pipeline (same order as the website): strip HTML tags and decode entities → ' +
    'remove emojis → trim each line → collapse repeated spaces → remove empty lines → remove duplicate lines (optionally ' +
    'ignoring case) → sort (A–Z, Z–A, natural, by length) → reverse → shuffle (seedable) → add line numbers. Returns the ' +
    'cleaned text plus counts, or writes it to a file when "output" is given. Give "text" or a text file "path". ' +
    `Web version: ${webUrl('text-cleaner')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('The text to clean.'),
    path: z.string().optional().describe('Or: a path to a UTF-8 text file.'),
    stripHtml: flag(false, 'Strip HTML tags (drops script/style/comments, block ends become line breaks) and decode entities'),
    removeEmoji: flag(false, 'Remove emojis (©, ® and ™ are kept)'),
    trim: flag(true, 'Trim spaces at the start and end of each line'),
    collapseSpaces: flag(true, 'Collapse runs of spaces/tabs into one space'),
    removeEmptyLines: flag(true, 'Remove empty (whitespace-only) lines'),
    removeDuplicates: flag(false, 'Remove duplicate lines, keeping the first'),
    ignoreCase: flag(false, 'When removing duplicates, treat lines that differ only in case as duplicates'),
    sort: z.enum(['none', 'az', 'za', 'natural', 'length']).optional().default('none')
      .describe('Sort lines: none (default), az, za, natural (item 2 before item 10), length (shortest first).'),
    reverse: flag(false, 'Reverse the line order'),
    shuffle: flag(false, 'Shuffle the lines'),
    seed: z.number().int().min(0).max(4294967295).optional().describe('Seed for a reproducible shuffle (default: random).'),
    numberLines: flag(false, 'Prefix each line with its number ("1. ", padded)'),
    output: z.string().optional().describe('Optional: write the cleaned text to this file path (or folder ending in "/") instead of returning it.'),
  }),
  outputSchema: z.object({
    text: z.string().optional().describe('The cleaned text (omitted when written to "output").'),
    path: z.string().optional(), bytes: z.number().optional(),
    linesIn: z.number(), linesOut: z.number(), duplicatesRemoved: z.number(), emptyLinesRemoved: z.number(), charactersOut: z.number(),
    seed: z.number().optional().describe('Seed used for the shuffle.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'item 10\nitem 2\nitem 2\n\nitem 1', removeDuplicates: true, sort: 'natural' },
      output: { text: 'item 1\nitem 2\nitem 10', linesIn: 5, linesOut: 3, duplicatesRemoved: 1, emptyLinesRemoved: 1, charactersOut: 21 } },
  ],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    const o: CleanOptions = {
      html: input.stripHtml, emoji: input.removeEmoji, trim: input.trim, collapse: input.collapseSpaces, empty: input.removeEmptyLines,
      dupes: input.removeDuplicates, ignoreCase: input.ignoreCase, sort: input.sort, reverse: input.reverse, shuffle: input.shuffle,
      number: input.numberLines,
    };
    const seed = input.shuffle ? input.seed ?? randomInt(0, 2 ** 32) : undefined;
    const r = clean(text, o, seeded(seed ?? 0));
    const stats = {
      linesIn: text ? text.split(/\r\n?|\n/).length : 0, linesOut: text ? r.lines : 0,
      duplicatesRemoved: r.stats.dupes, emptyLinesRemoved: r.stats.empty, charactersOut: Array.from(r.text).length,
      ...(seed != null ? { seed } : {}),
    };
    if (input.output) {
      const file = await writeOutput(r.text + '\n', { output: input.output, defaultName: 'cleaned.txt', mimeType: 'text/plain' }, ctx);
      return { path: file.path, bytes: file.bytes, ...stats };
    }
    return { text: r.text, ...stats };
  },
});

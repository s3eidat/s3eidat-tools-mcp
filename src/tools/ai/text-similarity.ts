import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { readInput } from '../../util/files.js';
import { ToolError } from '../../util/errors.js';

// Arabic diacritics and tatweel are ignored so "مُحَمَّد" and "محمد" compare equal.
const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_']*/gu;

/** Lower-cased words with punctuation and Arabic diacritics dropped. */
export function tokenize(text: string): string[] {
  return (text.normalize('NFKC').replace(TASHKEEL, '').toLocaleLowerCase().match(WORD) || []).map((w) => w.replace(/'/g, ''));
}

/** Word shingles of length k (a text shorter than k words is one shingle). */
export function shingles(words: string[], k: number): Set<string> {
  const out = new Set<string>();
  if (!words.length) return out;
  if (words.length <= k) { out.add(words.join(' ')); return out; }
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** murmur3 finaliser: a good 32-bit mixer. */
function fmix(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function seeds(n: number): Uint32Array {
  // mulberry32 with a fixed seed: the same seeds every run, so signatures are reproducible.
  let s = 0x5eed1234;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (t ^ (t >>> 14)) >>> 0;
  }
  return out;
}

export function minhash(set: Set<string>, numHashes: number): Uint32Array {
  const sd = seeds(numHashes);
  const sig = new Uint32Array(numHashes).fill(0xffffffff);
  for (const x of set) {
    const h = fnv1a(x);
    for (let i = 0; i < numHashes; i++) {
      const v = fmix(h ^ sd[i]);
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

export function minhashSimilarity(a: Uint32Array, b: Uint32Array, emptyA: boolean, emptyB: boolean): number {
  if (emptyA && emptyB) return 1;
  if (emptyA || emptyB) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

export function termFreq(words: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) dot += v * w; }
  for (const v of b.values()) nb += v * v;
  return dot / Math.sqrt(na * nb);
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

const METRICS = ['jaccard', 'minhash', 'cosine'] as const;

export default defineTool({
  name: 'ai_text_similarity',
  title: 'Text similarity and near-duplicates',
  description:
    'Compare two or more texts (or text files) for overlap. For every pair returns: Jaccard similarity of word shingles ' +
    '(k=3 words by default), a MinHash estimate of that Jaccard (128 hashes), and cosine similarity of word frequencies. ' +
    'Words are lower-cased, punctuation and Arabic diacritics ignored. Measures wording overlap, not meaning (no embeddings): ' +
    'paraphrases score low. Mode "pairs" (default) lists pairs sorted by the chosen metric; mode "dedupe" groups ' +
    'near-duplicates whose metric is at least "threshold" (default 0.8; groups are connected, so A~B and B~C put A, B, C ' +
    'together). Give "texts" (inline strings) and/or "paths" (file paths or base64). Up to 1000 texts.',
  inputSchema: z.object({
    texts: z.array(z.string()).optional().describe('Texts to compare (inline).'),
    paths: z.array(z.string()).optional().describe('Or/also: UTF-8 text files (local paths or base64).'),
    labels: z.array(z.string()).optional().describe('Optional names for the texts, in order (texts first, then paths). Default: "#1", "#2"… or the file name.'),
    mode: z.enum(['pairs', 'dedupe']).optional().default('pairs').describe('"pairs" (similarity of each pair) or "dedupe" (groups of near-duplicates).'),
    metric: z.enum(METRICS).optional().default('jaccard').describe('Metric used to sort pairs and to group duplicates. Default jaccard.'),
    threshold: z.number().min(0).max(1).optional().default(0.8).describe('Dedupe: pairs at or above this are duplicates. Default 0.8.'),
    shingleSize: z.number().int().min(1).max(10).optional().default(3).describe('Words per shingle (k). Default 3.'),
    numHashes: z.number().int().min(16).max(1024).optional().default(128).describe('MinHash signature length. Default 128 (error about ±0.09).'),
    maxPairs: z.number().int().min(1).max(100_000).optional().default(200).describe('Most pairs to return (highest first). Default 200.'),
  }),
  outputSchema: z.object({
    count: z.number().describe('Texts compared.'),
    texts: z.array(z.object({ index: z.number(), label: z.string(), words: z.number(), shingles: z.number() })),
    pairs: z.array(z.object({ a: z.number(), b: z.number(), labelA: z.string(), labelB: z.string(), jaccard: z.number(), minhash: z.number(), cosine: z.number() })),
    pairCount: z.number().describe('All pairs compared.'),
    truncated: z.boolean().optional(),
    groups: z.array(z.object({ members: z.array(z.number()), labels: z.array(z.string()), keep: z.number(), minSimilarity: z.number() })).optional()
      .describe('Dedupe: groups of 2+ near-duplicates; "keep" is the first member.'),
    uniqueCount: z.number().optional().describe('Dedupe: texts left after keeping one per group.'),
    duplicateCount: z.number().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { texts: ['the cat sat on the mat', 'the cat sat on the mat', 'a completely different sentence here'] }, note: 'Pair #1/#2 scores 1 on every metric.' },
    { input: { texts: ['Hello world, this is a test.', 'hello world this is a test', 'Something else entirely.'], mode: 'dedupe' }, note: 'One group: #1 and #2.' },
  ],
  async run(input, ctx) {
    const docs: { label: string; text: string }[] = [];
    for (const t of input.texts ?? []) docs.push({ label: `#${docs.length + 1}`, text: t });
    for (const p of input.paths ?? []) {
      const f = await readInput(p, ctx, 'path');
      docs.push({ label: f.path ? f.name : `#${docs.length + 1}`, text: f.bytes.toString('utf8').replace(/^﻿/, '') });
    }
    if (docs.length < 2) throw new ToolError('Give at least 2 texts (in "texts" and/or "paths").');
    if (docs.length > 1000) throw new ToolError(`Too many texts (${docs.length}); the limit is 1000.`);
    input.labels?.forEach((l, i) => { if (docs[i] && l) docs[i].label = l; });

    const prepared = docs.map((d) => {
      const words = tokenize(d.text);
      const sh = shingles(words, input.shingleSize);
      return { words, sh, tf: termFreq(words), sig: minhash(sh, input.numHashes) };
    });

    const all: { a: number; b: number; jaccard: number; minhash: number; cosine: number }[] = [];
    for (let a = 0; a < docs.length; a++) {
      for (let b = a + 1; b < docs.length; b++) {
        const A = prepared[a], B = prepared[b];
        all.push({
          a, b,
          jaccard: r4(jaccard(A.sh, B.sh)),
          minhash: r4(minhashSimilarity(A.sig, B.sig, !A.sh.size, !B.sh.size)),
          cosine: r4(cosine(A.tf, B.tf)),
        });
      }
    }
    const m = input.metric;
    const sorted = all.slice().sort((x, y) => y[m] - x[m] || x.a - y.a || x.b - y.b);
    const result: Record<string, unknown> = {
      count: docs.length,
      texts: docs.map((d, i) => ({ index: i, label: d.label, words: prepared[i].words.length, shingles: prepared[i].sh.size })),
      pairCount: all.length,
    };

    if (input.mode === 'dedupe') {
      const parent = docs.map((_, i) => i);
      const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
      const dups = all.filter((p) => p[m] >= input.threshold);
      for (const p of dups) { const ra = find(p.a), rb = find(p.b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }
      const byRoot = new Map<number, number[]>();
      docs.forEach((_, i) => { const r = find(i); byRoot.set(r, [...(byRoot.get(r) ?? []), i]); });
      const groups = [...byRoot.values()].filter((g) => g.length > 1).map((members) => {
        const inGroup = new Set(members);
        const sims = dups.filter((p) => inGroup.has(p.a) && inGroup.has(p.b)).map((p) => p[m]);
        return { members, labels: members.map((i) => docs[i].label), keep: members[0], minSimilarity: Math.min(...sims) };
      });
      result.groups = groups;
      result.duplicateCount = groups.reduce((s, g) => s + g.members.length - 1, 0);
      result.uniqueCount = docs.length - (result.duplicateCount as number);
      const shown = dups.sort((x, y) => y[m] - x[m] || x.a - y.a || x.b - y.b);
      result.pairs = shown.slice(0, input.maxPairs).map((p) => ({ ...p, labelA: docs[p.a].label, labelB: docs[p.b].label }));
      if (shown.length > input.maxPairs) result.truncated = true;
    } else {
      result.pairs = sorted.slice(0, input.maxPairs).map((p) => ({ ...p, labelA: docs[p.a].label, labelB: docs[p.b].label }));
      if (sorted.length > input.maxPairs) result.truncated = true;
    }
    return result;
  },
});

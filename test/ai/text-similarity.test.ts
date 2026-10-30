import { describe, expect, it } from 'vitest';
import { call } from '../helpers.js';
import tool, { jaccard, shingles, tokenize } from '../../src/tools/ai/text-similarity.js';

type Pair = { a: number; b: number; jaccard: number; minhash: number; cosine: number };
type Out = { pairs: Pair[]; pairCount: number; groups?: { members: number[]; keep: number }[]; uniqueCount?: number; duplicateCount?: number };

describe('ai_text_similarity', () => {
  it('known Jaccard of 3-word shingles', () => {
    // a b c d -> {abc, bcd}; a b c e -> {abc, bce}: 1 shared of 3 -> 1/3.
    const A = shingles(tokenize('a b c d'), 3), B = shingles(tokenize('a b c e'), 3);
    expect(jaccard(A, B)).toBeCloseTo(1 / 3, 10);
    expect(tokenize('Hello, WORLD! مُحَمَّد')).toEqual(['hello', 'world', 'محمد']);
  });

  it('scores identical texts 1 and unrelated texts 0', async () => {
    const r = await call<Out>(tool, { texts: ['the cat sat on the mat', 'The cat sat on the mat!', 'quantum flux capacitors explode'] });
    expect(r.pairCount).toBe(3);
    expect(r.pairs[0]).toMatchObject({ a: 0, b: 1, jaccard: 1, minhash: 1, cosine: 1 });
    const unrelated = r.pairs.find((p) => p.a === 0 && p.b === 2)!;
    expect(unrelated).toMatchObject({ jaccard: 0, cosine: 0 });
    expect(unrelated.minhash).toBeLessThan(0.1);
  });

  it('cosine of term frequencies (known answer)', async () => {
    // tf a=(x:1,y:1), b=(x:1,z:1): cos = 1/2.
    const r = await call<Out>(tool, { texts: ['x y', 'x z'] });
    expect(r.pairs[0].cosine).toBe(0.5);
  });

  it('MinHash tracks Jaccard on longer texts', async () => {
    const base = Array.from({ length: 300 }, (_, i) => `w${i}`);
    const b = base.slice(0, 200).concat(Array.from({ length: 100 }, (_, i) => `v${i}`));
    const r = await call<Out>(tool, { texts: [base.join(' '), b.join(' ')], numHashes: 256 });
    expect(Math.abs(r.pairs[0].minhash - r.pairs[0].jaccard)).toBeLessThan(0.12);
  });

  it('dedupe groups near-duplicates transitively', async () => {
    const t = 'Our refund policy lets you return any item within thirty days of purchase for a full refund';
    const r = await call<Out>(tool, {
      texts: [t, t + ' today', 'Completely unrelated text about the weather in Amman this week and next', t.replace('full', 'complete')],
      mode: 'dedupe', threshold: 0.7,
    });
    expect(r.groups).toHaveLength(1);
    expect(r.groups![0].members).toEqual([0, 1, 3]);
    expect(r.uniqueCount).toBe(2);
    expect(r.duplicateCount).toBe(2);
  });

  it('needs two texts', async () => {
    await expect(call(tool, { texts: ['only one'] })).rejects.toThrow(/at least 2/);
  });
});

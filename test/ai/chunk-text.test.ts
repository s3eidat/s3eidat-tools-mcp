import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../helpers.js';
import tool from '../../src/tools/ai/chunk-text.js';
import { getEncoder } from '../../src/tools/ai/_text.js';

type C = { index: number; text?: string; tokens: number; startChar: number; endChar: number; headings: string[] };
type Out = { chunkCount: number; chunks: C[]; path?: string; totalTokens: number };

describe('ai_chunk_text', () => {
  it('splits at markdown headings and keeps the heading path', async () => {
    const md = '# Guide\n\nIntro text.\n\n## Install\n\nRun npm install.\n\n## Use\n\nCall the tool.\n\n```\n# not a heading\n```\n';
    const r = await call<Out>(tool, { text: md, maxTokens: 100, overlapTokens: 0 });
    expect(r.chunks.map((c) => c.headings)).toEqual([['Guide'], ['Guide', 'Install'], ['Guide', 'Use']]);
    expect(r.chunks[1].text).toBe('## Install\n\nRun npm install.');
    expect(r.chunks[2].text).toContain('# not a heading');
    for (const c of r.chunks) expect(md.slice(c.startChar, c.endChar)).toBe(c.text);
  });

  it('a heading with no body joins its first subsection', async () => {
    const r = await call<Out>(tool, { text: '# Guide\n\n## Install\n\nRun it.', maxTokens: 100, overlapTokens: 0 });
    expect(r.chunkCount).toBe(1);
    expect(r.chunks[0]).toMatchObject({ headings: ['Guide', 'Install'], text: '# Guide\n\n## Install\n\nRun it.' });
  });

  it('respects maxTokens, splits by sentence, overlaps, and offsets match', async () => {
    const enc = await getEncoder('o200k_base');
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} talks about topic ${i % 7}.`);
    const text = sentences.slice(0, 30).join(' ') + '\n\n' + sentences.slice(30).join(' ');
    const r = await call<Out>(tool, { text, maxTokens: 60, overlapTokens: 15, markdown: false });
    expect(r.chunkCount).toBeGreaterThan(5);
    for (const c of r.chunks) {
      expect(c.tokens).toBeLessThanOrEqual(60);
      expect(enc.count(c.text!)).toBe(c.tokens);
      expect(text.slice(c.startChar, c.endChar)).toBe(c.text);
    }
    // Consecutive chunks overlap (next starts before the previous one ends).
    expect(r.chunks[1].startChar).toBeLessThan(r.chunks[0].endChar);
    // Every sentence is covered.
    for (const s of sentences) expect(r.chunks.some((c) => c.text!.includes(s))).toBe(true);
  });

  it('hard-splits a sentence longer than maxTokens', async () => {
    const long = 'word '.repeat(400).trim();
    const r = await call<Out>(tool, { text: long, maxTokens: 50, overlapTokens: 0 });
    expect(r.chunkCount).toBeGreaterThanOrEqual(8);
    for (const c of r.chunks) expect(c.tokens).toBeLessThanOrEqual(50);
    expect(r.chunks.map((c) => c.text).join(' ')).toBe(long);
  });

  it('writes JSONL', async () => {
    const ctx = tempCtx();
    const r = await call<Out>(tool, { text: 'One.\n\nTwo.', maxTokens: 50, overlapTokens: 0, output: 'out.jsonl' }, { ...ctx, root: ctx.outDir });
    const lines = readFileSync(r.path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(r.chunkCount);
    expect(lines[0]).toMatchObject({ index: 0, text: 'One.\n\nTwo.', startChar: 0 });
    expect(r.chunks[0].text).toBeUndefined();
  });

  it('rejects overlap >= maxTokens', async () => {
    await expect(call(tool, { text: 'x', maxTokens: 20, overlapTokens: 20 })).rejects.toThrow(/overlap/);
  });
});

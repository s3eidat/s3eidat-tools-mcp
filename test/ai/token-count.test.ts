import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../helpers.js';
import tool from '../../src/tools/ai/token-count.js';

type Out = { tokens: number; words: number; characters: number; encoding: string; summary: string; contextFit: { window: string; fits: boolean }[]; claudeEstimate: { low: number; high: number } };

describe('ai_token_count', () => {
  it('counts known o200k and cl100k answers', async () => {
    const a = await call<Out>(tool, { text: 'hello world' });
    expect(a).toMatchObject({ tokens: 2, words: 2, characters: 11, encoding: 'o200k_base' });
    const b = await call<Out>(tool, { text: 'hello world', encoding: 'cl100k_base' });
    expect(b.tokens).toBe(2);
    // "tiktoken is great!" is 6 tokens in cl100k_base (the OpenAI cookbook example).
    const c = await call<Out>(tool, { text: 'tiktoken is great!', encoding: 'cl100k_base' });
    expect(c.tokens).toBe(6);
  });

  it('treats special-token text as plain text and reports context fit', async () => {
    const r = await call<Out>(tool, { text: 'a <|endoftext|> b' });
    expect(r.tokens).toBeGreaterThan(3);
    expect(r.contextFit.find((f) => f.window === '200k')?.fits).toBe(true);
    expect(r.summary).toContain('fits in 200k: yes');
    expect(r.claudeEstimate.high).toBeGreaterThanOrEqual(r.tokens);
  });

  it('reads a file and handles empty text', async () => {
    const ctx = tempCtx();
    const p = join(ctx.outDir, 'a.txt');
    writeFileSync(p, 'hello world');
    expect((await call<Out>(tool, { path: p }, ctx)).tokens).toBe(2);
    expect((await call<Out>(tool, { text: '' })).tokens).toBe(0);
  });
});

describe('graphemeCount', () => {
  it('counts graphemes like Intl.Segmenter, fast on long text', async () => {
    const { graphemeCount } = await import('../../src/tools/ai/_text.js');
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const sample = 'Hi 👋🏽 مُحَمَّد é 👨‍👩‍👧 ok\n';
    expect(graphemeCount(sample)).toBe([...seg.segment(sample)].length);
    const long = sample.repeat(20_000);
    const t = Date.now();
    expect(graphemeCount(long)).toBe(graphemeCount(sample) * 20_000);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

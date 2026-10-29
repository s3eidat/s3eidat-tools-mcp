import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInput, writeOutput } from '../../src/util/files.js';
import { loadPdfJs, parsePageRanges, renderPage } from '../../src/util/pdf.js';
import { samplePdf, tempCtx } from '../helpers.js';

describe('parsePageRanges', () => {
  it('parses ranges', () => {
    expect(parsePageRanges('1-3, 5, 8-', 10)).toEqual([0, 1, 2, 4, 7, 8, 9]);
    expect(parsePageRanges('all', 3)).toEqual([0, 1, 2]);
    expect(parsePageRanges('odd', 5)).toEqual([0, 2, 4]);
    expect(parsePageRanges('even', 5)).toEqual([1, 3]);
    expect(parsePageRanges('3-1', 3)).toEqual([2, 1, 0]);
    expect(parsePageRanges('last', 4)).toEqual([3]);
    expect(() => parsePageRanges('0', 3)).toThrow();
    expect(() => parsePageRanges('x', 3)).toThrow();
  });
});

describe('file helpers', () => {
  it('reads paths, base64 and data URIs', async () => {
    const ctx = tempCtx();
    const p = join(ctx.outDir, 'a.txt');
    writeFileSync(p, 'hello');
    expect((await readInput(p, ctx)).bytes.toString()).toBe('hello');
    expect((await readInput('data:text/plain;base64,aGVsbG8=', ctx)).bytes.toString()).toBe('hello');
    expect((await readInput('base64:aGVsbG8=', ctx)).bytes.toString()).toBe('hello');
    await expect(readInput('/no/such/file.pdf', ctx)).rejects.toThrow(/not found/);
  });
  it('enforces --root', async () => {
    const ctx = tempCtx();
    const root = join(ctx.outDir, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'in.txt'), 'x');
    writeFileSync(join(ctx.outDir, 'secret.txt'), 's');
    symlinkSync(join(ctx.outDir, 'secret.txt'), join(root, 'link.txt'));
    const rctx = { ...ctx, root, outDir: join(root, 'out') };
    expect((await readInput('in.txt', rctx)).bytes.toString()).toBe('x');
    await expect(readInput('../secret.txt', rctx)).rejects.toThrow(/outside/);
    await expect(readInput('link.txt', rctx)).rejects.toThrow(/outside/);
    await expect(writeOutput('x', { output: '/tmp/escape.txt', defaultName: 'a.txt' }, rctx)).rejects.toThrow(/outside/);
    const w = await writeOutput('x', { defaultName: 'a.txt' }, rctx);
    expect(w.path.startsWith(root)).toBe(true);
  });
  it('never overwrites without an explicit path', async () => {
    const ctx = tempCtx();
    const a = await writeOutput('1', { defaultName: 'x.txt' }, ctx);
    const b = await writeOutput('2', { defaultName: 'x.txt' }, ctx);
    expect(a.path).not.toBe(b.path);
    expect(b.path).toMatch(/x-2\.txt$/);
  });
});

describe('pdf.js', () => {
  it('reads text and renders a page', async () => {
    const doc = await loadPdfJs(await samplePdf(2));
    expect(doc.numPages).toBe(2);
    const tc = await (await doc.getPage(2)).getTextContent();
    expect(tc.items.map((i) => ('str' in i ? i.str : '')).join('')).toContain('Page 2');
    const img = await renderPage(doc, 1, { dpi: 72 });
    expect([img.width, img.height]).toEqual([595, 842]);
    expect(img.data.subarray(1, 4).toString()).toBe('PNG');
  });
});

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import splitTools, { plan } from '../../../src/tools/web/pdf/pdf-split.js';
import { toRangeText } from '../../../src/tools/web/pdf/_common.js';
import { call, tempCtx } from '../../helpers.js';
import { widthsOf, widthsPdf } from './_pdf.js';

const [split, extract] = splitTools;

describe('pdf_split / pdf_extract_pages (pdf-split self-test)', () => {
  it('plans like the website', () => {
    expect(plan('extract', 3, { sel: '3,1' })[0].pages).toEqual([2, 0]);
    expect(plan('every', 3, { every: 2 }).map((p) => p.pages.join())).toEqual(['0,1', '2']);
    expect(plan('single', 3, {})).toHaveLength(3);
    const rg = plan('ranges', 3, { ranges: '1-2, 3' });
    expect(rg).toHaveLength(2);
    expect(rg[1].pages.join()).toBe('2');
    expect(toRangeText([4, 0, 1, 2, 9])).toBe('1-3, 5, 10');
    expect(() => plan('extract', 3, { sel: '4' })).toThrow();
  });
  it('extracts and splits to files', async () => {
    const ctx = tempCtx();
    const src = join(ctx.outDir, 'Book.pdf');
    writeFileSync(src, await widthsPdf([100, 200, 300]));
    const ex = await call<{ path: string; pages: number[] }>(extract, { file: src, pages: '3,1' }, ctx);
    expect(await widthsOf(ex.path)).toBe('300,100');
    expect(ex.path).toMatch(/Book-pages-1_3\.pdf$/);
    const ev = await call<{ folder: string; files: { path: string }[] }>(split, { file: src, mode: 'every', every: 2, output: join(ctx.outDir, 'parts') }, ctx);
    expect(await Promise.all(ev.files.map((f) => widthsOf(f.path)))).toEqual(['100,200', '300']);
    expect(readdirSync(ev.folder).sort()).toEqual(['Book-part-01.pdf', 'Book-part-02.pdf']);
    const sg = await call<{ files: { path: string }[] }>(split, { file: src, mode: 'single' }, ctx);
    expect(sg.files.map((f) => f.path.split(/[\\/]/).pop())).toEqual(['Book-page-001.pdf', 'Book-page-002.pdf', 'Book-page-003.pdf']);
  });
});

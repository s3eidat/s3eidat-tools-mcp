import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import merge from '../../../src/tools/web/pdf/pdf-merge.js';
import { parseRangeList } from '../../../src/tools/web/pdf/_common.js';
import { call, tempCtx } from '../../helpers.js';
import { b64, widthsOf, widthsPdf } from './_pdf.js';

describe('pdf_merge (pdf-merge self-test)', () => {
  it('parses ranges like the website', () => {
    expect(parseRangeList('1-3, 5, 8-', 9).join()).toBe('0,1,2,4,7,8');
    expect(parseRangeList('', 3).join()).toBe('0,1,2');
    expect(parseRangeList('3-1', 3).join()).toBe('2,1,0');
    expect(() => parseRangeList('2-7', 5)).toThrow(/7/);
    expect(parseRangeList('odd, last', 5).join()).toBe('0,2,4,4');
  });
  it('merges with ranges, and refuses encrypted files', async () => {
    const ctx = tempCtx();
    const a = await widthsPdf([100, 200, 300]), b = await widthsPdf([400, 500]);
    const pa = join(ctx.outDir, 'a.pdf');
    writeFileSync(pa, a);
    const r = await call<{ path: string; pages: number }>(merge, { files: [{ file: pa, pages: '3,1' }, b64(b)] }, ctx);
    expect(r.pages).toBe(4);
    expect(await widthsOf(r.path)).toBe('300,100,400,500');
    const enc = Buffer.from(b.toString('latin1').replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>'), 'latin1');
    await expect(call(merge, { files: [pa, b64(enc)] }, ctx)).rejects.toThrow(/password-protected/);
    await expect(call(merge, { files: [{ file: pa, pages: '9' }] }, ctx)).rejects.toThrow(/doesn't exist/);
  });
});

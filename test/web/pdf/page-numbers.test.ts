import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import pn, { DEF, fillTokens, plan } from '../../../src/tools/web/pdf/pdf-page-numbers.js';
import { closeJs } from '../../../src/tools/web/pdf/_common.js';
import { loadPdfJs, pdfjs } from '../../../src/util/pdf.js';
import { call, tempCtx } from '../../helpers.js';

describe('pdf_page_numbers (pdf-page-numbers self-test)', () => {
  it('plans numbers like the website', () => {
    const p = plan(5, { ...DEF, skip: 1, start: 1 });
    expect(p[0]).toBeNull();
    expect([p[1]?.n, p[4]?.n, p[4]?.total]).toEqual([1, 4, 4]);
    const q = plan(6, { ...DEF, range: '2-4, 6', start: 10 });
    expect(q.map((x) => (x ? x.n : '-')).join()).toBe('-,10,11,12,-,13');
    expect(q[1]?.total).toBe(13);
    expect(() => plan(3, { ...DEF, range: '2-9' })).toThrow(/9/);
    expect(fillTokens('Page {n} of {total} · {filename}', { n: 2, total: 7, filename: 'a.pdf' })).toBe('Page 2 of 7 · a.pdf');
  });
  it('stamps numbers + header in the right place, upright on rotated pages', async () => {
    const ctx = tempCtx();
    const d = await PDFDocument.create();
    d.addPage([595.28, 841.89]); d.addPage([842, 595]);
    const r3 = d.addPage([400, 600]); r3.setMediaBox(20, 30, 400, 600); r3.setRotation(degrees(90));
    const src = join(ctx.outDir, 'test.pdf');
    writeFileSync(src, await d.save());
    const r = await call<{ path: string; numbered: number }>(pn, { file: src, format: 'Page {n} of {total}', position: 'bc', skip: 1, header: '{filename}', headerAlign: 'l', margin: 30, size: 12 }, ctx);
    expect(r.numbered).toBe(2);
    const js = await loadPdfJs(readFileSync(r.path)), PU = (await pdfjs()).Util;
    const texts = [];
    for (let i = 1; i <= 3; i++) {
      const pg = await js.getPage(i), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
      texts.push((tc.items as { str: string; transform: number[] }[]).filter((t) => t.str?.trim()).map((t) => {
        const m = PU.transform(vp.transform, t.transform);
        return { s: t.str, x: m[4], y: m[5], a: m[0], b: m[1], W: vp.width, H: vp.height };
      }));
    }
    await closeJs(js);
    expect(texts[0]).toHaveLength(0);
    const n2 = texts[1].find((t) => t.s === 'Page 1 of 2')!, h2 = texts[1].find((t) => t.s === 'test.pdf')!, n3 = texts[2].find((t) => t.s === 'Page 2 of 2')!;
    expect(n2 && h2 && n3).toBeTruthy();
    expect(Math.abs(n2.y - (n2.H - 30))).toBeLessThan(1);
    expect(n2.x).toBeGreaterThan(n2.W / 2 - 60); expect(n2.x).toBeLessThan(n2.W / 2);
    expect(Math.abs(h2.x - 30)).toBeLessThan(1);
    expect(Math.abs(h2.y - (30 + 12 * 0.72))).toBeLessThan(1);
    expect([n3.W, n3.H]).toEqual([600, 400]);
    expect(Math.abs(n3.y - (400 - 30))).toBeLessThan(1);
    expect(n3.x).toBeGreaterThan(240); expect(n3.x).toBeLessThan(300);
    expect(n3.a).toBeGreaterThan(0);
    expect(Math.abs(n3.b)).toBeLessThan(1e-6);
  });
});

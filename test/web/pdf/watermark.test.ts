import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import sharp from 'sharp';
import wm, { DEF, markFor, placements } from '../../../src/tools/web/pdf/pdf-watermark.js';
import { closeJs, renderToCanvas } from '../../../src/tools/web/pdf/_common.js';
import { loadPdfJs, pdfjs } from '../../../src/util/pdf.js';
import { call, tempCtx } from '../../helpers.js';
import { b64, load } from './_pdf.js';

async function threePages() {
  const d = await PDFDocument.create();
  d.addPage([595.28, 841.89]); d.addPage([842, 595]);
  const r3 = d.addPage([400, 600]); r3.setMediaBox(20, 30, 400, 600); r3.setRotation(degrees(90));
  return d.save();
}

describe('pdf_watermark (pdf-watermark self-test)', () => {
  it('centres text at 45° as shown, on rotated pages too', async () => {
    const ctx = tempCtx(), bytes = await threePages();
    const r = await call<{ path: string; pagesStamped: number }>(wm, { file: b64(bytes), text: 'CONFIDENTIAL', size: 60, angle: 45, pages: '1,3', opacity: 30 }, ctx);
    expect(r.pagesStamped).toBe(2);
    const js = await loadPdfJs(readFileSync(r.path)), PU = (await pdfjs()).Util;
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold), w = font.widthOfTextAtSize('CONFIDENTIAL', 60);
    for (const n of [1, 2, 3]) {
      const pg = await js.getPage(n), vp = pg.getViewport({ scale: 1 });
      const items = (await pg.getTextContent()).items.filter((t) => 'str' in t && t.str.trim()) as { str: string; transform: number[] }[];
      if (n === 2) { expect(items).toHaveLength(0); continue; }
      const t = items.find((x) => x.str === 'CONFIDENTIAL')!;
      expect(t).toBeTruthy();
      const m = PU.transform(vp.transform, t.transform), ang = (Math.atan2(-m[1], m[0]) * 180) / Math.PI;
      const th = (45 * Math.PI) / 180, cx = m[4] + (Math.cos(th) * w) / 2 - Math.sin(th) * 60 * 0.36, cy = m[5] - (Math.sin(th) * w) / 2 - Math.cos(th) * 60 * 0.36;
      expect(Math.abs(ang - 45)).toBeLessThan(0.5);
      expect(Math.abs(cx - vp.width / 2)).toBeLessThan(1.5);
      expect(Math.abs(cy - vp.height / 2)).toBeLessThan(1.5);
    }
    await closeJs(js);
  });
  it('image watermark at 50% opacity, sized to % of page width', async () => {
    const ctx = tempCtx();
    const sq = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const r = await call<{ path: string }>(wm, { file: b64(await threePages()), image: b64(sq), scale: 20, angle: 0, opacity: 50, pages: '2' }, ctx);
    const js = await loadPdfJs(readFileSync(r.path)), c = await renderToCanvas(await js.getPage(2), 1), x = c.getContext('2d');
    const mid = x.getImageData(421, 297, 1, 1).data, edge = x.getImageData(421 + 90, 297, 1, 1).data;
    expect(mid[0]).toBeGreaterThan(235);
    expect(mid[1]).toBeGreaterThan(105); expect(mid[1]).toBeLessThan(150);
    expect(mid[2]).toBeGreaterThan(105); expect(mid[2]).toBeLessThan(150);
    expect(edge[1]).toBeGreaterThan(240);
    await closeJs(js);
  });
  it('tiles, and stamps Arabic as an image', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold);
    const tiles = placements(595, 842, markFor({ ...DEF, size: 36 }, 595, (t, s) => font.widthOfTextAtSize(t, s)), { ...DEF, mode: 'tile', gap: 60 });
    expect(tiles.length).toBeGreaterThanOrEqual(8);
    expect(tiles.length).toBeLessThan(200);
    const r = await call<{ path: string }>(wm, { file: b64(await threePages()), text: 'سري للغاية', pages: '1' }, tempCtx());
    expect((await load(r.path)).getPageCount()).toBe(3);
  });
});

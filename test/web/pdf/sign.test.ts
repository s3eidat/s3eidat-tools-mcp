import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import sharp from 'sharp';
import sign, { knockOut } from '../../../src/tools/web/pdf/pdf-sign.js';
import { closeJs, renderToCanvas, toUser } from '../../../src/tools/web/pdf/_common.js';
import { loadPdfJs } from '../../../src/util/pdf.js';
import { call, tempCtx } from '../../helpers.js';
import { b64, load } from './_pdf.js';

async function threePages() {
  const d = await PDFDocument.create();
  d.addPage([595.28, 841.89]); d.addPage([792, 612]);
  const p3 = d.addPage([400, 600]); p3.setMediaBox(20, 30, 400, 600); p3.setRotation(degrees(90));
  return d.save();
}
async function pixels(path: string, n: number) {
  const js = await loadPdfJs(readFileSync(path)), c = await renderToCanvas(await js.getPage(n), 1), x = c.getContext('2d');
  await closeJs(js);
  return (px: number, py: number) => Array.from(x.getImageData(Math.round(px), Math.round(py), 1, 1).data);
}
const isRed = (p: number[]) => p[0] > 200 && p[1] < 70 && p[2] < 70, isWhite = (p: number[]) => p[0] > 240 && p[1] > 240 && p[2] > 240;

describe('pdf_sign_image (pdf-sign self-test)', () => {
  it('maps shown-page corners to user space', () => {
    const B = { x: 10, y: 20, w: 100, h: 200 };
    expect([toUser(B, 0, 0, 0), toUser(B, 90, 0, 0), toUser(B, 180, 0, 0), toUser(B, 270, 0, 0)].map((p) => p.join())).toEqual(['10,20', '110,20', '110,220', '10,220']);
  });
  it('places the image where asked, upright on rotated pages, plus text marks', async () => {
    const ctx = tempCtx();
    const red = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const r1 = await call<{ path: string; signedPages: number[]; signature: { width: number; height: number } }>(sign, {
      file: b64(await threePages()), signature: b64(red), pages: '1', x: 100, y: 200, width: 120,
      texts: [{ text: 'Hello PDF', page: 2, x: 72, y: 72, size: 14, color: '#000000' }, { text: 'مرحبا بكم', page: 2, x: 300, y: 300, size: 24, color: '#000000' }],
    }, ctx);
    expect(r1.signedPages).toEqual([1, 2]);
    expect(r1.signature).toEqual({ width: 120, height: 60 });
    const a = await pixels(r1.path, 1);
    expect([a(160, 230), a(105, 205), a(215, 255)].every(isRed)).toBe(true);
    expect([a(95, 230), a(160, 266)].every(isWhite)).toBe(true);
    const js = await loadPdfJs(readFileSync(r1.path)), p2 = await js.getPage(2), vp2 = p2.getViewport({ scale: 1 });
    const hello = (await p2.getTextContent()).items.find((t) => 'str' in t && t.str.includes('Hello PDF')) as { transform: number[] };
    const [vx, vy] = vp2.convertToViewportPoint(hello.transform[4], hello.transform[5]);
    expect(Math.abs(vx - 72)).toBeLessThan(1);
    expect(Math.abs(vy - (72 + 0.947 * 14))).toBeLessThan(1);
    await closeJs(js);
    const b2 = await pixels(r1.path, 2);
    let dark = 0;
    for (let yy = 302; yy < 330; yy += 2) for (let xx = 300; xx < 420; xx += 2) if (b2(xx, yy)[0] < 120) dark++;
    expect(dark).toBeGreaterThan(15);

    const r3 = await call<{ path: string }>(sign, { file: b64(await threePages()), signature: b64(red), pages: '3', x: 50, y: 40, width: 150, height: 75 }, ctx);
    const d3 = await load(r3.path);
    expect(d3.getPageCount()).toBe(3);
    expect(d3.getPage(2).getRotation().angle).toBe(90);
    const c3 = await pixels(r3.path, 3);
    expect([c3(125, 77), c3(195, 45), c3(55, 110)].every(isRed)).toBe(true);
    expect([c3(55, 125), c3(205, 60), c3(500, 350)].every(isWhite)).toBe(true);
  });
  it('knocks out a paper background and trims to the ink', async () => {
    const scan = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#f4f1ea' } })
      .composite([{ input: { create: { width: 100, height: 30, channels: 3, background: '#202020' } }, left: 150, top: 80 }]).jpeg().toBuffer();
    const k = await knockOut(scan, 210);
    expect(Math.abs(k.w - 108)).toBeLessThanOrEqual(2);
    expect(Math.abs(k.h - 38)).toBeLessThanOrEqual(2);
    const { data } = await sharp(k.png).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0); // corner pixel is transparent now
  });
});

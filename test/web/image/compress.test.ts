import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import compress, { pct } from '../../../src/tools/web/image/image-squeeze.js';
import { fit, outName } from '../../../src/tools/web/image/_img.js';
import { b64, head, meta, px } from './fixtures.js';

const ctx = tempCtx();
type R = { path: string; bytes: number; width: number; height: number; format: string; inputBytes: number; kept: boolean; savedPercent: number; quality?: number; targetReached?: boolean; summary: string };

/** Vertical gradient with the website's LCG noise; optional transparent left third. */
async function sample(w: number, h: number, alpha = false) {
  const d = Buffer.alloc(w * h * 4);
  let s = 7;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = (s % 17) - 8;
      const t = y / h;
      d[i] = Math.max(0, Math.min(255, 20 + 200 * t + n));
      d[i + 1] = Math.max(0, Math.min(255, 32 + 60 * t + n));
      d[i + 2] = Math.max(0, Math.min(255, 79 + 40 * t + n));
      d[i + 3] = alpha && x < w / 3 ? 0 : 255;
    }
  return sharp(d, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

describe('image_compress (image-squeeze self-test)', () => {
  it('JPEG at max 600 px: right size, real JPEG bytes, smaller than the PNG', async () => {
    const png = await sample(1200, 800);
    const a = await call<R>(compress, { image: b64(png), format: 'jpeg', quality: 70, maxSide: 600 }, ctx);
    expect(head(a.path, 2)).toEqual([0xff, 0xd8]);
    expect([a.width, a.height]).toEqual([600, 400]);
    expect(a.bytes).toBeLessThan(png.length);
    expect(a.savedPercent).toBe(pct(png.length, a.bytes));
    expect(a.summary).toMatch(/1200×800 → 600×400 · JPEG/);
  });
  it('transparency: PNG kept as PNG keeps alpha; JPEG gets a white background', async () => {
    const tp = b64(await sample(300, 200, true));
    const k = await call<R>(compress, { image: tp, format: 'keep', keepSmaller: false }, ctx);
    expect(k.format).toBe('png');
    expect((await px(k.path, 10, 100))[3]).toBe(0);
    const j = await call<R>(compress, { image: tp, format: 'jpeg', quality: 90, keepSmaller: false }, ctx);
    const jp = await px(j.path, 10, 100);
    expect(Math.min(jp[0], jp[1], jp[2])).toBeGreaterThan(245);
  });
  it('size maths and the keep-original-if-smaller rule', async () => {
    const f = fit(30000, 20000, 0);
    expect(f.w * f.h).toBeLessThanOrEqual(100e6);
    expect(f.note).toBeTruthy();
    expect(fit(4000, 3000, 1000)).toMatchObject({ w: 1000, h: 750 });
    const jpg = await sharp(await sample(400, 300)).jpeg({ quality: 60 }).toBuffer();
    const big = await call<R>(compress, { image: b64(jpg), quality: 100 }, ctx);
    expect(big.kept).toBe(true);
    expect(big.bytes).toBe(jpg.length);
    expect(outName('my.photo.PNG', 'webp')).toBe('my.photo.webp');
  });
  it('targetBytes finds a quality that fits', async () => {
    const png = b64(await sample(800, 600));
    const r = await call<R>(compress, { image: png, format: 'webp', targetBytes: 8000 }, ctx);
    expect(r.targetReached).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(8000);
    expect(r.quality).toBeGreaterThan(1);
    expect((await meta(r.path)).format).toBe('webp');
  });
});

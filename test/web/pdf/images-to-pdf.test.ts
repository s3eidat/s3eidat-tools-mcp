import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import img2pdf, { MM, exifOrientation, pageFor, prepare } from '../../../src/tools/web/pdf/images-to-pdf.js';
import { call, tempCtx } from '../../helpers.js';
import { b64, load } from './_pdf.js';

const mk = (w: number, h: number, fmt: 'jpeg' | 'png') => sharp({ create: { width: w, height: h, channels: 3, background: '#3a9' } })[fmt]().toBuffer();
const sizes = async (path: string) => (await load(path)).getPages().map((p) => Math.round(p.getWidth()) + 'x' + Math.round(p.getHeight())).join();

describe('pdf_from_images (images-to-pdf self-test)', () => {
  it('reads EXIF orientation like the website', () => {
    const exif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xd9]);
    expect(exifOrientation(exif)).toBe(6);
    expect(exifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(Math.abs(pageFor(300, 200, { size: 'a4', orient: 'auto', margin: 10 }).x - 10 * MM)).toBeLessThan(0.01);
  });
  it('builds pages with the right sizes and orientation', async () => {
    const ctx = tempCtx();
    const [a, b, c] = await Promise.all([mk(300, 200, 'jpeg'), mk(200, 300, 'png'), mk(100, 100, 'jpeg')]);
    const prep = [await prepare(a, 0, 'original'), await prepare(b, 0, 'original'), await prepare(c, 90, 'original')];
    expect(prep[0].bytes).toBe(a);
    expect(prep[1].kind).toBe('png');
    expect(prep[2].kind).toBe('jpg');
    const r = await call<{ path: string; pages: number }>(img2pdf, { images: [b64(a), b64(b), { file: b64(c), rotate: 90 }], quality: 'original' }, ctx);
    expect(await sizes(r.path)).toBe('842x595,595x842,595x842');
    const fit = await call<{ path: string }>(img2pdf, { images: [b64(a)], pageSize: 'fit', margin: 0 }, ctx);
    expect(await sizes(fit.path)).toBe('225x150');
  });
  it('turns photos upright from EXIF and keeps transparency', async () => {
    const ctx = tempCtx();
    const sideways = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#a33' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const p = await prepare(sideways, 0, 'original');
    expect([p.kind, p.w, p.h]).toEqual(['jpg', 200, 300]);
    const clear = await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
    expect((await prepare(clear, 0, 'original')).kind).toBe('png');
    expect((await prepare(clear, 0, 'high')).kind).toBe('jpg');
    const big = await mk(4000, 1000, 'png');
    const s = await prepare(big, 0, 'small');
    expect([s.w, s.h]).toEqual([1400, 350]);
    const r = await call<{ path: string }>(img2pdf, { images: [b64(sideways)], pageSize: 'letter' }, ctx);
    expect(await sizes(r.path)).toBe('612x792');
  });
});

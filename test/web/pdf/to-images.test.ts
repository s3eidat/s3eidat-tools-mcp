import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import toImages, { fitScale } from '../../../src/tools/web/pdf/pdf-to-images.js';
import { parseRangeSet } from '../../../src/tools/web/pdf/_common.js';
import { call, tempCtx } from '../../helpers.js';
import { b64 } from './_pdf.js';

async function bands() { // solid pages with a coloured band across the top 28%
  const d = await PDFDocument.create();
  for (const [w, h, c] of [[72, 144, rgb(1, 0, 0)], [144, 72, rgb(0, 1, 0)], [100, 100, rgb(0, 0, 1)]] as const) {
    d.addPage([w, h]).drawRectangle({ x: 0, y: h * 0.72, width: w, height: h * 0.28, color: c });
  }
  return d.save();
}

type Res = { folder: string; files: { page: number; path: string; width: number; height: number }[] };

describe('pdf_to_images (pdf-to-images self-test)', () => {
  it('renders pages at the DPI and format asked', async () => {
    const ctx = tempCtx(), file = b64(await bands());
    const r = await call<Res>(toImages, { file, pages: '2', dpi: 150 }, ctx);
    expect(r.files).toHaveLength(1);
    expect([r.files[0].width, r.files[0].height]).toEqual([300, 150]);
    const { data, info } = await sharp(r.files[0].path).raw().toBuffer({ resolveWithObject: true });
    expect(info.format).toBe('raw');
    const at = (10 * info.width + 150) * info.channels;
    expect(data[at + 1]).toBeGreaterThan(200);
    expect(data[at]).toBeLessThan(40);
    const j = await call<Res>(toImages, { file, pages: '3', dpi: 72, format: 'jpeg', quality: 80, transparent: true }, ctx);
    expect(j.files[0].width).toBe(100);
    expect((await sharp(j.files[0].path).metadata()).format).toBe('jpeg');
    const all = await call<Res>(toImages, { file, dpi: 36, format: 'webp' }, ctx);
    expect(readdirSync(all.folder).sort()).toEqual(['document-p001.webp', 'document-p002.webp', 'document-p003.webp']);
    expect([...parseRangeSet('3-1, 2', 3)].join()).toBe('0,1,2');
    expect(() => parseRangeSet('4', 3)).toThrow();
  });
  it('transparent PNG keeps alpha; huge pages are capped', async () => {
    const r = await call<Res>(toImages, { file: b64(await bands()), pages: '1', dpi: 72, transparent: true }, tempCtx());
    const { data, info } = await sharp(r.files[0].path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[(130 * info.width + 10) * 4 + 3]).toBe(0);
    const capped = fitScale(5000, 5000, 600 / 72);
    expect(capped.capped).toBe(true);
    expect(Math.floor(5000 * capped.scale)).toBeLessThanOrEqual(4096);
  });
});

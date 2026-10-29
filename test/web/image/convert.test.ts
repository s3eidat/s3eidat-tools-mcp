import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import convert from '../../../src/tools/web/image/image-convert.js';
import { outName, svgSize } from '../../../src/tools/web/image/_img.js';
import { b64, bmp, fromSvg, head, meta, px } from './fixtures.js';

const ctx = tempCtx();
type R = { path: string; width: number; height: number; format: string; inputFormat: string; scaled: boolean };
// The website's sticker: a circle on a transparent square.
const sticker = () =>
  fromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="84" fill="#3dd6d0"/></svg>');
const SVG_SAMPLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160"><rect width="240" height="160" rx="24" fill="#0e7c86"/><circle cx="80" cy="80" r="44" fill="#f5b971"/><path d="M140 112l30-56 30 56z" fill="#fff"/></svg>';

describe('image_convert (image-convert self-test)', () => {
  it('transparent PNG → JPEG fills the background colour', async () => {
    const r = await call<R>(convert, { image: b64(await sticker()), format: 'jpeg', quality: 90, background: '#ff0000' }, ctx);
    expect(head(r.path, 3)).toEqual([255, 216, 255]);
    const c = await px(r.path, 2, 2);
    expect(c[0]).toBeGreaterThan(240);
    expect(c[1]).toBeLessThan(20);
    expect(c[2]).toBeLessThan(20);
    expect(r.path.endsWith('image.jpg')).toBe(true);
  });
  it('PNG keeps alpha, WebP writes RIFF…WEBP', async () => {
    const p = await call<R>(convert, { image: b64(await sticker()), format: 'png', background: '#ff0000' }, ctx);
    expect(head(p.path, 4)).toEqual([137, 80, 78, 71]);
    expect((await px(p.path, 2, 2))[3]).toBe(0);
    const w = await call<R>(convert, { image: b64(await sticker()), format: 'webp', quality: 80 }, ctx);
    const h = Buffer.from(head(w.path, 12));
    expect(h.subarray(0, 4).toString()).toBe('RIFF');
    expect(h.subarray(8, 12).toString()).toBe('WEBP');
  });
  it('SVG (viewBox only) → PNG 240×160 with the right colour; BMP keeps size and colour', async () => {
    const s = await call<R>(convert, { image: 'data:image/svg+xml;base64,' + Buffer.from(SVG_SAMPLE).toString('base64'), format: 'png' }, ctx);
    expect([s.width, s.height, s.inputFormat]).toEqual([240, 160, 'svg']);
    expect((await px(s.path, 120, 10)).slice(0, 3)).toEqual([14, 124, 134]);
    const b = await call<R>(convert, { image: b64(bmp(3, 2, [10, 200, 30])), format: 'png' }, ctx);
    expect([b.width, b.height, b.inputFormat]).toEqual([3, 2, 'bmp']);
    expect((await px(b.path, 2, 1)).slice(0, 3)).toEqual([10, 200, 30]);
  });
  it('svgSize and outName', () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="50" viewBox="0 0 100 40"/>')).toEqual({ w: 50, h: 20 });
    expect(outName('a.b.png', 'jpeg')).toBe('a.b.jpg');
  });
  it('writes AVIF, GIF and TIFF too', async () => {
    for (const f of ['avif', 'gif', 'tiff'] as const) {
      const r = await call<R>(convert, { image: b64(await sticker()), format: f }, ctx);
      const m = await meta(r.path);
      expect(m.format).toBe(f === 'avif' ? 'heif' : f);
      expect(m.width).toBe(200);
    }
  });
});

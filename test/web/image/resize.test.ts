import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import tools, { defaultCrop, moveCrop, outSize, parseRatio, ratioFor, type ResizeOpts } from '../../../src/tools/web/image/image-resize.js';
import { b64, halves, head, meta, px, solid } from './fixtures.js';

const [resize, crop] = tools;
const ctx = tempCtx();
type R = { path: string; width: number; height: number; format: string; crop: { x: number; y: number; w: number; h: number } };
const base: ResizeOpts = { mode: 'px', w: '', h: '', lock: true, anchor: 'w', pct: 50, ratio: 'free' };
const t = (o: Partial<ResizeOpts>, cw: number, ch: number) => {
  const s = outSize(cw, ch, { ...base, ...o });
  return s.w + 'x' + s.h;
};

describe('image_resize (image-resize self-test)', () => {
  it('geometry matches the website', () => {
    expect(t({ mode: 'pct', pct: 50 }, 4000, 3000)).toBe('2000x1500');
    expect(t({ w: 1080 }, 1600, 900)).toBe('1080x608');
    expect(t({ h: 500, anchor: 'h' }, 1600, 900)).toBe('889x500');
    expect(t({ w: 1080, h: 1920, lock: false }, 506, 900)).toBe('1080x1920');
    expect(defaultCrop(1600, 900, ratioFor({ ...base, w: 1080, h: 1920, lock: false }, 1600, 900))).toEqual({ x: 547, y: 0, w: 506, h: 900 });
    expect(moveCrop({ x: 0, y: 0, w: 50, h: 50 }, 500, -9, 200, 100)).toEqual({ x: 150, y: 0, w: 50, h: 50 });
    expect(parseRatio('16:9')).toBe(1.7778);
    expect(parseRatio('4x3')).toBeCloseTo(4 / 3);
    expect(parseRatio('orig')).toBe('orig');
  });
  it('crops the right half of a red|blue image to 100×100 blue PNG', async () => {
    const img = await halves(2000, 1000, '#ff0000', '#0000ff');
    const r = await call<R>(resize, { image: b64(img), width: 100, crop: { x: 1000, y: 0, width: 1000, height: 1000 } }, ctx);
    expect([r.width, r.height, r.format]).toEqual([100, 100, 'png']);
    const p = await px(r.path, 50, 50);
    expect(p[2]).toBeGreaterThan(250);
    expect(p[0]).toBeLessThan(5);
    expect(head(r.path, 2)[1]).toBe(80);
    expect(r.path.endsWith('image-100x100.png')).toBe(true);
  });
  it('width only keeps the aspect; both sides cover-crop; presets; percent; contain; fill', async () => {
    const img = b64(await solid(1600, 900, '#336699', 'jpeg'));
    const a = await call<R>(resize, { image: img, width: 1080 }, ctx);
    expect([a.width, a.height, a.format]).toEqual([1080, 608, 'jpeg']);
    const b = await call<R>(resize, { image: img, width: 1080, height: 1920 }, ctx);
    expect([b.width, b.height]).toEqual([1080, 1920]);
    expect(b.crop).toEqual({ x: 547, y: 0, w: 506, h: 900 });
    const c = await call<R>(resize, { image: img, preset: 'instagram-post', format: 'webp' }, ctx);
    expect([c.width, c.height, (await meta(c.path)).format]).toEqual([1080, 1080, 'webp']);
    const d = await call<R>(resize, { image: img, percent: 25 }, ctx);
    expect([d.width, d.height]).toEqual([400, 225]);
    const e = await call<R>(resize, { image: img, width: 500, height: 500, fit: 'contain' }, ctx);
    expect([e.width, e.height]).toEqual([500, 281]);
    const f = await call<R>(resize, { image: img, width: 500, height: 500, fit: 'fill' }, ctx);
    expect([f.width, f.height, f.crop.w]).toEqual([500, 500, 1600]);
    const g = await call<R>(resize, { image: img, height: 500, ratio: '1:1' }, ctx);
    expect([g.width, g.height]).toEqual([500, 500]);
  });
});

describe('image_crop', () => {
  it('ratio crop is centred; box crop is clamped inside', async () => {
    const img = b64(await halves(400, 200, '#ff0000', '#0000ff'));
    const a = await call<R>(crop, { image: img, ratio: '1:1' }, ctx);
    expect(a.crop).toEqual({ x: 100, y: 0, w: 200, h: 200 });
    const l = await call<R>(crop, { image: img, ratio: '1:1', position: 'left' }, ctx);
    expect(l.crop.x).toBe(0);
    expect((await px(l.path, 100, 100))[0]).toBe(255);
    const b = await call<R>(crop, { image: img, x: 350, y: 10, width: 100, height: 50 }, ctx);
    expect(b.crop).toEqual({ x: 300, y: 10, w: 100, h: 50 });
    expect((await px(b.path, 50, 25)).slice(0, 3)).toEqual([0, 0, 255]);
    await expect(call(crop, { image: img }, ctx)).rejects.toThrow(/crop box/);
  });
});

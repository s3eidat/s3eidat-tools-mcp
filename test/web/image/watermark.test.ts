import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import watermark from '../../../src/tools/web/image/watermark.js';
import { b64, head, meta, px, solid } from './fixtures.js';

const ctx = tempCtx();
type R = { path: string; width: number; height: number; format: string };
const base = { text: 'WWW', color: '#ffffff', weight: '900', shadow: false, position: 'bottom-right', tiled: false, opacity: 100, size: 30, rotation: 0, margin: 5 };

/** Count bright pixels per quadrant [tl, tr, bl, br] and the max red value (the website's quads()). */
async function quads(path: string) {
  const { data, info } = await sharp(readFileSync(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const q = [0, 0, 0, 0];
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > max) max = data[i];
    if (data[i] > 60) {
      const p = i / 4;
      const x = p % info.width;
      const y = Math.floor(p / info.width);
      q[(y >= info.height / 2 ? 2 : 0) + (x >= info.width / 2 ? 1 : 0)]++;
    }
  }
  return { q, max };
}

describe('image_watermark (watermark self-test)', () => {
  it('positions, tiling and opacity', async () => {
    const black = b64(await solid(400, 300, '#000000'));
    const br = await quads((await call<R>(watermark, { image: black, ...base }, ctx)).path);
    expect(br.q[3]).toBeGreaterThan(50);
    expect(br.q[0] + br.q[1] + br.q[2]).toBe(0);
    const tl = await quads((await call<R>(watermark, { image: black, ...base, position: 'top-left' }, ctx)).path);
    expect(tl.q[0]).toBeGreaterThan(50);
    expect(tl.q[1] + tl.q[2] + tl.q[3]).toBe(0);
    const tile = await quads((await call<R>(watermark, { image: black, ...base, tiled: true, size: 15, rotation: -30 }, ctx)).path);
    expect(tile.q.every((n) => n > 50)).toBe(true);
    const half = await quads((await call<R>(watermark, { image: black, ...base, opacity: 50 }, ctx)).path);
    expect(half.max).toBeGreaterThanOrEqual(120);
    expect(half.max).toBeLessThanOrEqual(135);
  });
  it('logo: a red square centred at 50% width', async () => {
    const black = b64(await solid(400, 300, '#000000'));
    const logo = b64(await solid(50, 50, '#ff0000'));
    const r = await call<R>(watermark, { image: black, ...base, logo, position: 'center', size: 50 }, ctx);
    expect((await px(r.path, 200, 150)).slice(0, 3)).toEqual([255, 0, 0]);
    expect((await px(r.path, 5, 5))[0]).toBe(0);
  });
  it('JPEG export keeps the size and gets the -watermarked name', async () => {
    const r = await call<R>(watermark, { image: b64(await solid(400, 300, '#000000')), ...base, format: 'jpeg', quality: 90 }, ctx);
    expect([r.width, r.height]).toEqual([400, 300]);
    expect(head(r.path, 2)).toEqual([0xff, 0xd8]);
    expect(r.path.endsWith('photo-watermarked.jpg')).toBe(true);
    expect((await meta(r.path)).width).toBe(400);
  });
});

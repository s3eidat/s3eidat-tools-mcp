import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import imageDiff from '../../src/tools/ai/image-diff.js';
import { call, tempCtx } from '../helpers.js';

const ctx = tempCtx();
type Out = { path: string; width: number; height: number; diffPixels: number; totalPixels: number; percent: number; identical: boolean; resized: boolean };

/** 40×20 white image with an optional black w×h square at (10, 5). */
async function img(name: string, square = 0, size: [number, number] = [40, 20]) {
  const composite = square ? [{ input: { create: { width: square, height: square, channels: 3 as const, background: '#000000' } }, left: 10, top: 5 }] : [];
  const buf = await sharp({ create: { width: size[0], height: size[1], channels: 3, background: '#ffffff' } }).composite(composite).png().toBuffer();
  const p = join(ctx.outDir, name);
  writeFileSync(p, buf);
  return p;
}

describe('ai_image_diff', () => {
  it('counts exactly the changed pixels and writes a diff PNG', async () => {
    const a = await img('a.png'), b = await img('b.png', 5);
    const r = await call<Out>(imageDiff, { a, b }, ctx);
    expect([r.width, r.height, r.totalPixels]).toEqual([40, 20, 800]);
    expect(r.diffPixels).toBe(25);
    expect(r.percent).toBe(3.125);
    expect(r.identical).toBe(false);
    expect(r.path).toMatch(/a-diff\.png$/);
    const { data, info } = await sharp(readFileSync(r.path)).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([40, 20]);
    const px = (x: number, y: number) => Array.from(data.subarray((y * 40 + x) * info.channels, (y * 40 + x) * info.channels + 3));
    expect(px(12, 7)).toEqual([255, 0, 0]); // changed: red
    expect(px(0, 0)).not.toEqual([255, 0, 0]);
  });

  it('identical images give zero', async () => {
    const a = await img('c.png', 3), b = await img('d.png', 3);
    expect(await call<Out>(imageDiff, { a, b }, ctx)).toMatchObject({ diffPixels: 0, identical: true, percent: 0 });
  });

  it('refuses different sizes unless resize is on', async () => {
    const a = await img('e.png'), b = await img('f.png', 0, [80, 40]);
    await expect(call(imageDiff, { a, b }, ctx)).rejects.toThrow(/differ in size \(40×20 vs 80×40\)/);
    expect(await call<Out>(imageDiff, { a, b, resize: true }, ctx)).toMatchObject({ resized: true, diffPixels: 0, width: 40 });
  });
});

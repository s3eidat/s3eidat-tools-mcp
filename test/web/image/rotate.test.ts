import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import rotate from '../../../src/tools/web/image/image-rotate.js';
import { b64, fromSvg, px } from './fixtures.js';

const ctx = tempCtx();
type R = { path: string; width: number; height: number; format: string; orientationApplied: number };
// 3×2 black with a red top-left pixel (the photo-filters self-test image).
const dot = () => fromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="#000"/><rect width="1" height="1" fill="#f00"/></svg>');

describe('image_rotate (photo-filters self-test)', () => {
  it('90° clockwise: source top-left lands top-right', async () => {
    const r = await call<R>(rotate, { image: b64(await dot()), angle: 90 }, ctx);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect((await px(r.path, 1, 0))[0]).toBe(255);
    expect((await px(r.path, 0, 0))[0]).toBe(0);
  });
  it('horizontal flip, and flip after rotation', async () => {
    const f = await call<R>(rotate, { image: b64(await dot()), angle: 0, flipHorizontal: true }, ctx);
    expect((await px(f.path, 2, 0))[0]).toBe(255);
    const rf = await call<R>(rotate, { image: b64(await dot()), angle: 90, flipHorizontal: true }, ctx);
    expect((await px(rf.path, 0, 0))[0]).toBe(255);
    const v = await call<R>(rotate, { image: b64(await dot()), angle: 180, flipVertical: true }, ctx);
    expect((await px(v.path, 2, 0))[0]).toBe(255);
  });
  it('any angle grows the canvas with a transparent background', async () => {
    const sq = await sharp({ create: { width: 100, height: 100, channels: 4, background: '#0000ff' } }).png().toBuffer();
    const r = await call<R>(rotate, { image: b64(sq), angle: 45 }, ctx);
    expect(r.width).toBeGreaterThanOrEqual(141);
    expect((await px(r.path, 0, 0))[3]).toBe(0);
    expect((await px(r.path, r.width >> 1, r.height >> 1)).slice(0, 3)).toEqual([0, 0, 255]);
  });
  it('applies EXIF orientation first', async () => {
    const jpg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#00f' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await call<R>(rotate, { image: b64(jpg), angle: 0 }, ctx);
    expect([r.width, r.height, r.orientationApplied, r.format]).toEqual([4, 8, 6, 'jpeg']);
    const raw = await call<R>(rotate, { image: b64(jpg), angle: 0, autoOrient: false }, ctx);
    expect([raw.width, raw.height]).toEqual([8, 4]);
    const both = await call<R>(rotate, { image: b64(jpg), angle: 90 }, ctx);
    expect([both.width, both.height]).toEqual([8, 4]);
  });
});

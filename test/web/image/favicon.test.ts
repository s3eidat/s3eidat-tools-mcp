import { readFileSync } from 'node:fs';
import { loadImage } from '@napi-rs/canvas';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import favicon from '../../../src/tools/web/image/favicon-forge.js';
import { b64, meta, px, solid } from './fixtures.js';

const ctx = tempCtx();
type R = { folder: string; files: { name: string; path: string; bytes: number }[]; snippet: string };
const base = { text: 'A', weight: '900', color: '#ffffff', background: '#ff0000', transparent: false, radius: 0, padding: 10, name: 'Test', shortName: 'T' };
const file = (r: R, n: string) => r.files.find((f) => f.name === n)!.path;

describe('image_favicon_set (favicon-forge self-test)', () => {
  it('writes the website file set with a valid PNG-in-ICO', async () => {
    const r = await call<R>(favicon, base, ctx);
    expect(r.files.map((f) => f.name).join()).toBe(
      'favicon.ico,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png,android-chrome-192x192.png,android-chrome-512x512.png,site.webmanifest,head-snippet.html',
    );
    const icoF = readFileSync(file(r, 'favicon.ico'));
    expect([icoF.readUInt16LE(0), icoF.readUInt16LE(2), icoF.readUInt16LE(4)]).toEqual([0, 1, 3]);
    [16, 32, 48].forEach((s, i) => {
      const e = 6 + 16 * i;
      const off = icoF.readUInt32LE(e + 12);
      const len = icoF.readUInt32LE(e + 8);
      expect([icoF[e], icoF[e + 1], icoF.readUInt16LE(e + 6)]).toEqual([s, s, 32]);
      expect(off + len).toBeLessThanOrEqual(icoF.length);
      expect([...icoF.subarray(off, off + 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });
    expect(icoF.readUInt32LE(6 + 12)).toBe(54);
    expect((await loadImage(icoF)).width).toBeGreaterThanOrEqual(16);
    expect(icoF.length).toBe(54 + [0, 1, 2].reduce((s, i) => s + icoF.readUInt32LE(6 + 16 * i + 8), 0));
    const man = JSON.parse(readFileSync(file(r, 'site.webmanifest'), 'utf8'));
    expect([man.icons[1].sizes, man.theme_color, man.name, man.short_name]).toEqual(['512x512', '#ff0000', 'Test', 'T']);
    expect(readFileSync(file(r, 'head-snippet.html'), 'utf8')).toBe(r.snippet + '\n');
    expect(r.snippet).toMatch(/<meta name="theme-color" content="#ff0000">$/);
    for (const [n, s] of [['favicon-16x16.png', 16], ['apple-touch-icon.png', 180], ['android-chrome-512x512.png', 512]] as const) expect((await meta(file(r, n))).width).toBe(s);
    // The white letter fills a good part of the 512 icon, inside the 10% padding.
    const { data } = await sharp(readFileSync(file(r, 'android-chrome-512x512.png'))).raw().toBuffer({ resolveWithObject: true });
    let white = 0;
    let edge = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 1] > 200) {
        white++;
        const p = i / 4;
        if (p % 512 < 40 || p % 512 > 472 || p < 512 * 40 || p > 512 * 472) edge++;
      }
    }
    expect(white / (512 * 512)).toBeGreaterThan(0.15);
    expect(edge).toBe(0);
  });
  it('square red corner; 50% radius makes the corner transparent but the Apple icon stays solid', async () => {
    const sq = await call<R>(favicon, base, ctx);
    expect(await px(file(sq, 'favicon-32x32.png'), 0, 0)).toEqual([255, 0, 0, 255]);
    const round = await call<R>(favicon, { ...base, radius: 50 }, ctx);
    expect((await px(file(round, 'favicon-32x32.png'), 0, 0))[3]).toBe(0);
    expect((await px(file(round, 'apple-touch-icon.png'), 0, 0))[3]).toBe(255);
  });
  it('image source, contain and cover', async () => {
    const logo = b64(await solid(200, 100, '#0000ff'));
    const c = await call<R>(favicon, { ...base, image: logo, transparent: true, padding: 0 }, ctx);
    const p512 = file(c, 'android-chrome-512x512.png');
    expect(await px(p512, 256, 256)).toEqual([0, 0, 255, 255]);
    expect((await px(p512, 256, 20))[3]).toBe(0);
    const cv = await call<R>(favicon, { ...base, image: logo, transparent: true, padding: 0, fit: 'cover' }, ctx);
    expect(await px(file(cv, 'android-chrome-512x512.png'), 256, 20)).toEqual([0, 0, 255, 255]);
  });
});

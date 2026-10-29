import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import svgToPng, { parse, pngName, target } from '../../../src/tools/web/image/svg-to-png.js';
import { sanitizeSvg } from '../../../src/tools/web/image/_img.js';
import { head, px } from './fixtures.js';

const ctx = tempCtx();
const NS = 'http://www.w3.org/2000/svg';
type R = { path: string; width: number; height: number; svgWidth: number; svgHeight: number };
const halves = `<svg xmlns="${NS}" viewBox="0 0 10 10"><rect width="5" height="10" fill="#ff0000"/><rect x="5" width="5" height="10" fill="#0000ff"/></svg>`;
const dot = `<svg xmlns="${NS}" width="40" height="40"><circle cx="20" cy="20" r="10" fill="#000"/></svg>`;

describe('image_svg_to_png (svg-to-png self-test)', () => {
  it('scripts and handlers are removed; it still draws', async () => {
    const evil = `<svg xmlns="${NS}" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><image href="file:///etc/passwd" width="10" height="10"/><rect width="10" height="10" fill="#00ff00"/></svg>`;
    const clean = sanitizeSvg(evil);
    expect(clean).not.toMatch(/script|onload|passwd/);
    const e = await call<R>(svgToPng, { svgText: evil, scale: 1 }, ctx);
    expect((await px(e.path, 5, 5))[1]).toBe(255);
  });
  it('8×: crisp halves, right size, PNG bytes, transparent corner; white background', async () => {
    const a = await call<R>(svgToPng, { svgText: halves, scale: 8 }, ctx);
    expect([a.width, a.height]).toEqual([80, 80]);
    const l = await px(a.path, 20, 40);
    const r = await px(a.path, 60, 40);
    expect([l[0], l[2], r[0], r[2]]).toEqual([255, 0, 0, 255]);
    expect(head(a.path, 2)).toEqual([0x89, 0x50]);
    expect(a.path.endsWith('image@8x.png')).toBe(true);
    const t = await call<R>(svgToPng, { svgText: dot, scale: 1 }, ctx);
    expect((await px(t.path, 1, 1))[3]).toBe(0);
    const w = await call<R>(svgToPng, { svgText: dot, scale: 1, transparent: false, background: '#ffffff' }, ctx);
    expect((await px(w.path, 1, 1))[0]).toBe(255);
    expect((await px(w.path, 20, 20))[0]).toBe(0);
  });
  it('sizes: units, width-only, exact; names; errors', async () => {
    const p1 = parse(`<svg xmlns="${NS}" width="1in" height="72pt"/>`);
    expect([p1.w, p1.h]).toEqual([96, 96]);
    const wOnly = await call<R>(svgToPng, { svgText: `<svg xmlns="${NS}" viewBox="0 0 100 50"/>`, mode: 'width', width: 200 }, ctx);
    expect([wOnly.width, wOnly.height, wOnly.svgWidth, wOnly.svgHeight]).toEqual([200, 100, 100, 50]);
    const ex = await call<R>(svgToPng, { svgText: halves, mode: 'exact', width: 30, height: 12 }, ctx);
    expect([ex.width, ex.height]).toEqual([30, 12]);
    expect((await px(ex.path, 2, 6))[0]).toBe(255);
    expect(pngName('icon.svg', { mode: 'scale', scale: 3 })).toBe('icon@3x.png');
    expect(pngName('a.svg', { mode: 'width' })).toBe('a.png');
    expect(() => parse('<html><body>nope</body></html>')).toThrow(/Not valid SVG/);
    expect(() => target(100, 100, { mode: 'width', w: 20000 })).toThrow(/too large/);
    const sized = await call<R>(svgToPng, { svg: 'data:image/svg+xml;base64,' + Buffer.from(`<?xml version="1.0"?>\n<!-- c --><svg xmlns="${NS}" width="1in" height="0.5in"><rect width="100%" height="100%" fill="red"/></svg>`).toString('base64'), scale: 1 }, ctx);
    expect([sized.width, sized.height]).toEqual([96, 48]);
  });
});

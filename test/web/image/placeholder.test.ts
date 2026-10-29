import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import placeholder, { clampDim, draw, normHex, ratio, svg, type PhSettings } from '../../../src/tools/web/image/placeholder-image.js';
import { meta, px } from './fixtures.js';

const ctx = tempCtx();
const DEF: PhSettings = { w: 1200, h: 630, bg: '#1f2937', fg: '#9ca3af', text: '', fs: 0, fw: '600' };

describe('image_placeholder (placeholder-image self-test)', () => {
  it('svg, drawing and helpers match the website', () => {
    const s = { ...DEF, w: 300, h: 150, bg: '#ff0000', fg: '#ffffff' };
    const a = svg(s);
    expect(a).toContain('width="300" height="150"');
    expect(a).toContain('300 × 150');
    expect(a).toContain('fill="#ff0000"');
    const b = svg({ ...s, text: '<b>&"x' });
    expect(b).toContain('&lt;b&gt;&amp;&quot;x');
    expect(b).not.toContain('<b>');
    expect(svg({ ...s, text: 'one\\ntwo' }).match(/<tspan/g)).toHaveLength(2);
    const c = draw({ ...s, w: 40, h: 20, fg: '#ff0000' }, 1);
    expect([...c.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const half = draw(s, 0.5);
    expect([half.width, half.height]).toEqual([150, 75]);
    expect([normHex('ABC'), normHex('#12345'), ratio(1920, 1080), ratio(1200, 630)]).toEqual(['#aabbcc', null, '16:9', '40:21']);
    expect([clampDim('9000'), clampDim('0'), clampDim('abc')]).toEqual([8000, null, null]);
  });
  it('writes PNG / JPEG / WebP / SVG files', async () => {
    type R = { path: string; width: number; height: number; aspectRatio: string; fontSize: number; dataUri?: string; imgTag?: string };
    const p = await call<R>(placeholder, { width: 300, height: 150, background: '#f00', color: '#fff' }, ctx);
    expect(p.path.endsWith('placeholder-300x150.png')).toBe(true);
    expect(await px(p.path, 2, 2)).toEqual([255, 0, 0, 255]);
    // Some text pixels are white in the middle row.
    let white = 0;
    for (let x = 0; x < 300; x += 2) if ((await px(p.path, x, 75))[1] > 200) white++;
    expect(white).toBeGreaterThan(5);
    expect(p.aspectRatio).toBe('2:1');
    const j = await call<R>(placeholder, { preset: 'leaderboard', format: 'jpeg' }, ctx);
    expect([(await meta(j.path)).format, j.width, j.height]).toEqual(['jpeg', 728, 90]);
    const w = await call<R>(placeholder, { width: 64, height: 64, format: 'webp', dataUri: true }, ctx);
    expect(w.dataUri).toMatch(/^data:image\/webp;base64,/);
    expect(w.imgTag).toMatch(/width="64" height="64" alt=""/);
    const s = await call<R>(placeholder, { width: 300, height: 150, text: 'Hero image\\n1200 × 630', format: 'svg' }, ctx);
    const text = readFileSync(s.path, 'utf8');
    expect(text.match(/<tspan/g)).toHaveLength(2);
    expect((await meta(s.path)).width).toBe(300);
  });
});

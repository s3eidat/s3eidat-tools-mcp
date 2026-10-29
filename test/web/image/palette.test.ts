import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import palette, { exportText, hex, kmeans, medianCut, pixels } from '../../../src/tools/web/image/palette-from-image.js';
import { b64, fromSvg, meta } from './fixtures.js';

const ctx = tempCtx();
// Four solid blocks: red 50%, blue 25%, green 15%, yellow 10% (the website's self-test image).
const blocks = () =>
  fromSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="50" height="100" fill="#ff0000"/><rect x="50" width="25" height="100" fill="#0000ff"/>' +
      '<rect x="75" width="15" height="100" fill="#00ff00"/><rect x="90" width="10" height="100" fill="#ffff00"/></svg>',
  );
const want = ['#ff0000', '#0000ff', '#00ff00', '#ffff00'];
const shares = [0.5, 0.25, 0.15, 0.1];

describe('image_palette (palette-from-image self-test)', () => {
  it('k-means and median cut find the four blocks with exact shares', async () => {
    type R = { colors: { hex: string; share: number; percent: string }[]; text: string; path?: string };
    for (const method of ['kmeans', 'median']) {
      const r = await call<R>(palette, { image: b64(await blocks()), count: 4, method }, ctx);
      expect(r.colors.map((c) => c.hex)).toEqual(want);
      r.colors.forEach((c, i) => expect(Math.abs(c.share - shares[i])).toBeLessThan(0.001));
      expect(r.colors[0].percent).toBe('50.0%');
    }
    const r = await call<R>(palette, { image: b64(await blocks()), count: 4, swatchPng: true }, ctx);
    expect(r.text).toBe(':root {\n  --color-1: #ff0000;\n  --color-2: #0000ff;\n  --color-3: #00ff00;\n  --color-4: #ffff00;\n}');
    expect((await meta(r.path!)).width).toBe(640);
  });
  it('transparent pixels are ignored; exports are well-formed', () => {
    expect(pixels(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0]), 10)).toHaveLength(1);
    expect(hex([15, 128, 255])).toBe('#0f80ff');
    const px = Array.from({ length: 100 }, (_, i) => (i < 75 ? [10, 20, 30] : [200, 100, 0]));
    const json = JSON.parse(exportText(kmeans(px, 2), 'json'));
    expect(json[1]).toEqual({ hex: '#c86400', rgb: [200, 100, 0], share: 0.25 });
    expect(medianCut(px, 2).map((p) => hex(p.rgb))).toEqual(['#0a141e', '#c86400']);
  });
});

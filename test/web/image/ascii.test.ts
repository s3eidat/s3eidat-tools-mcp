import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import tools, { adjust, banner, cellsToAscii, F57, glyph, gridSize, RAMPS, textGrid } from '../../../src/tools/web/image/ascii-art.js';
import { b64, gradient, meta } from './fixtures.js';

const [asciiArt, asciiBanner] = tools;
const ctx = tempCtx();
const FULL = '█';
const UP = '▀';
const LOW = '▄';
const L1 = '░';
const L2 = '▒';
const L3 = '▓';

describe('ascii-art self-test', () => {
  it('ramps, adjust and grid', () => {
    const lum = new Float32Array(10);
    for (let i = 0; i < 10; i++) lum[i] = Math.round((255 * i) / 9) / 255;
    expect(cellsToAscii(lum, 10, 1, RAMPS.standard)[0]).toBe('@%#*+=-:. ');
    expect(cellsToAscii(lum, 10, 1, RAMPS.standard, { invert: true })[0]).toBe(' .:-=+*#%@');
    expect(cellsToAscii(lum, 5, 2, RAMPS.blocks).join('|')).toBe(FULL + FULL + L3 + L3 + L2 + '|' + L2 + L1 + L1 + '  ');
    expect(adjust(0.5, 100, 0)).toBeCloseTo(0.5, 9);
    expect(adjust(0.6, 100, 0)).toBeCloseTo(0.9, 9);
    expect(adjust(0.2, 0, 50)).toBeCloseTo(0.7, 9);
    expect(adjust(0.9, 0, 50)).toBe(1);
    expect(adjust(0.25, -50, 0)).toBeCloseTo(0.375, 9);
    expect([gridSize(400, 200, 100).rows, gridSize(100, 100, 40).rows, Array.from(RAMPS.detailed).length, RAMPS.detailed[0]]).toEqual([25, 20, 70, ' ']);
  });
  it('banners: exact letters', () => {
    const hi = banner('HI', 'char', '#').split('\n');
    expect(hi.length).toBe(7);
    expect([hi[0], hi[1], hi[3], hi[6]]).toEqual(['##      ##  ######', '##      ##    ##', '##########    ##', '##      ##  ######']);
    expect(banner('hi', 'char', '#')).toBe(banner('HI', 'char', '#'));
    expect(banner('H', 'char', '@')[0]).toBe('@');
    expect(banner('HI', 'tiny').split('\n').join('|')).toBe(`${FULL} ${FULL} ${UP}${FULL}${UP}|${FULL}${UP}${FULL}  ${FULL}|${UP} ${UP} ${UP}${UP}${UP}`);
    expect(banner('I', 'small').split('\n')[0]).toBe(FULL.repeat(6));
    const sh = banner('I', 'shadow').split('\n');
    expect([sh.length, sh[0], sh[1], sh[7]]).toEqual([8, FULL.repeat(6), '  ' + FULL + FULL + L1.repeat(4), '  ' + L1.repeat(6)]);
    expect(banner('A\nB', 'block').split('\n').length).toBe(15);
    expect(banner('  \n ', 'block')).toBe('');
    expect(textGrid('~', F57).join('')).toBe(glyph(F57, '?').join(''));
    expect(banner('A', 'compact').split('\n').length).toBe(4);
    expect(banner('A', 'compact')).toContain(LOW);
  });
});

describe('image_ascii_art / image_ascii_banner', () => {
  it('a horizontal gradient gives non-decreasing light from left to right', async () => {
    const r = await call<{ text: string; columns: number; rows: number }>(asciiArt, { image: b64(await gradient(200, 40)), columns: 20 }, ctx);
    expect([r.columns, r.rows]).toEqual([20, 2]);
    const row = r.text.split('\n')[0].padEnd(20, ' '); // lines are right-trimmed, as the website copies them
    expect(row[0]).toBe('@');
    expect(row[19]).toBe(' ');
    for (let i = 1; i < 20; i++) expect(RAMPS.standard.indexOf(row[i])).toBeLessThanOrEqual(RAMPS.standard.indexOf(row[i - 1]));
  });
  it('renders PNGs', async () => {
    const a = await call<{ path: string }>(asciiArt, { image: b64(await gradient(200, 40)), columns: 20, format: 'png', color: true }, ctx);
    expect((await meta(a.path)).format).toBe('png');
    const b = await call<{ text: string; lines: number; path: string }>(asciiBanner, { text: 'S3EIDAT', style: 'shadow', format: 'png' }, ctx);
    expect(b.lines).toBe(8);
    expect(b.path.endsWith('banner.png')).toBe(true);
    expect((await meta(b.path)).width).toBeGreaterThan(100);
  });
});

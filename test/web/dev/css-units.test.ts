import { describe, expect, it } from 'vitest';
import tools, { convert, fluid, fmt } from '../../../src/tools/web/dev/css-units.js';
import { call } from '../../helpers.js';

const [units, clamp] = tools;
const c = { root: 16, parent: 20, vw: 1440, vh: 900 };
const css = (f: ReturnType<typeof fluid>) => ('css' in f ? f.css : f.error);

describe('css-units self-test', () => {
  it('converts', () => {
    expect(fmt(convert(24, 'px', 'rem', c))).toBe('1.5');
    expect(fmt(convert(12, 'pt', 'px', c))).toBe('16');
    expect(fmt(convert(1, 'vw', 'px', c))).toBe('14.4');
    expect(fmt(convert(1.5, 'em', 'px', c))).toBe('30');
    expect(fmt(convert(150, '%', 'px', c))).toBe('30');
    expect(fmt(convert(1, 'in', 'cm', c))).toBe('2.54');
    expect(fmt(convert(10, 'vmin', 'px', c))).toBe('90');
    expect(fmt(convert(1, 'rem', 'pt', c))).toBe('12');
  });
  it('clamp', () => {
    const f = fluid(16, 32, 320, 1280, 16, 'rem');
    expect(css(f)).toBe('clamp(1rem, 0.6667rem + 1.6667vw, 2rem)');
    if (!('at' in f)) throw new Error();
    expect(fmt(f.at!(800))).toBe('24');
    expect([f.at!(100), f.at!(5000)]).toEqual([16, 32]);
    expect(css(fluid(16, 32, 320, 1280, 16, 'px'))).toBe('clamp(16px, 10.6667px + 1.6667vw, 32px)');
    expect(css(fluid(10, 50, 600, 1000, 16, 'rem'))).toBe('clamp(0.625rem, 10vw - 3.125rem, 3.125rem)');
    expect(css(fluid(40, 20, 400, 1200, 16, 'rem'))).toBe('clamp(1.25rem, 3.125rem - 2.5vw, 2.5rem)');
    expect('error' in fluid(16, 32, 900, 300, 16, 'rem')).toBe(true);
  });
});

describe('css tools', () => {
  it('css_units', async () => {
    const r = await call<{ px: number; results: { unit: string; css: string }[] }>(units, { value: 1.5, unit: 'em', parentFontSize: 20 });
    expect(r.px).toBe(30);
    expect(r.results.find((x) => x.unit === 'rem')!.css).toBe('1.875rem');
    expect(r.results).toHaveLength(13);
  });
  it('css_clamp', async () => {
    const r = await call<Record<string, any>>(clamp, {});
    expect(r.css).toBe('clamp(1rem, 0.6667rem + 1.6667vw, 2rem)');
    expect(r.samples).toEqual([{ viewport: 320, sizePx: 16 }, { viewport: 768, sizePx: 23.47 }, { viewport: 1280, sizePx: 32 }, { viewport: 1920, sizePx: 32 }]);
    await expect(call(clamp, { minViewport: 900, maxViewport: 300 })).rejects.toThrow(/larger/);
  });
});

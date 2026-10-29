import { describe, expect, it } from 'vitest';
import tool, { evaluate, show, type Angle } from '../../../src/tools/web/calc/sci-calc.js';
import { fails, run } from './_run.js';

describe('calc_expression (sci-calc self-test)', () => {
  let ans = 0;
  const ev = (s: string, angle: Angle = 'rad') => evaluate(s, { ans }, { angle, percent: true });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
  const rejects = (s: string) => { try { ev(s); return false; } catch (e) { return (e as Error).name === 'ToolError'; } };
  it('matches the website known answers', () => {
    expect(ev('2^3^2')).toBe(512);
    expect([ev('-2^2'), ev('(-2)^2')]).toEqual([-4, 4]);
    expect(ev('2(3+4)')).toBe(14);
    expect(ev('sin(90)', 'deg')).toBe(1);
    expect(ev('sin(π/2)', 'rad')).toBe(1);
    expect(ev('sin(100)', 'grad')).toBe(1);
    expect([ev('cos(90)', 'deg'), ev('sin(180)', 'deg')]).toEqual([0, 0]);
    expect(ev('tan(90)', 'deg')).toBeNaN();
    expect(near(ev('asin(1)', 'deg'), 90) && near(ev('atan(1)', 'grad'), 50)).toBe(true);
    expect([ev('1+2×3'), ev('(1+2)×3'), ev('12÷4÷3'), ev('2−3−4')]).toEqual([7, 9, 1, -5]);
    expect([ev('5!'), ev('0!'), ev('3!^2')]).toEqual([120, 1, 36]);
    expect(near(ev('0.5!'), Math.sqrt(Math.PI) / 2)).toBe(true);
    expect([ev('nCr(10,3)'), ev('nPr(5,2)'), ev('nCr(52,5)')]).toEqual([120, 20, 2598960]);
    expect([ev('50%'), ev('200×15%')]).toEqual([0.5, 30]);
    expect([ev('log(1000)'), ev('log(8,2)')]).toEqual([3, 3]);
    expect(near(ev('ln(e^2)'), 2)).toBe(true);
    expect([ev('√16'), ev('root(27,3)'), ev('cbrt(-27)')]).toEqual([4, 3, -3]);
    expect(near(ev('(-8)^(1/3)'), -2)).toBe(true);
    expect([ev('1.5e3'), ev('2e-3')]).toEqual([1500, 0.002]);
    ans = 42; expect(ev('ans/2')).toBe(21); ans = 0;
    expect(show(ev('0.1+0.2'), 'norm')).toBe('0.3');
    expect([show(1e20, 'norm'), show(-1.5e-12, 'norm'), show(1234567, 'norm')]).toEqual(['1 × 10²⁰', '−1.5 × 10⁻¹²', '1,234,567']);
    expect(show(1234, 'sci')).toBe('1.234 × 10³');
    expect([show(NaN), show(1 / 0)]).toEqual(['Undefined', '∞']);
    for (const s of ['alert(1)', 'constructor', '__proto__', 'window', 'document.cookie', 'this', 'x', 'Math.PI', 'ev' + 'al(1)', '2 3', 'sin 30']) expect(rejects(s), s).toBe(true);
  });
  it('runs as a tool', async () => {
    expect(await run(tool, { expression: 'sin(30) + cos(60)' })).toEqual({ value: 1, display: '1', plain: '1', finite: true });
    expect((await run(tool, { expression: '2x^2 + r', variables: { x: 3, r: 1 } })).value).toBe(19);
    expect((await run(tool, { expression: 'ans × 2', ans: 21 })).value).toBe(42);
    expect((await run(tool, { expression: '6.02214076e23 × 2', format: 'sci' })).display).toBe('1.204428152 × 10²⁴');
    const u = await run(tool, { expression: 'tan(90)' });
    expect([u.value, u.display, u.finite]).toEqual([null, 'Undefined', false]);
    await fails(tool, { expression: 'constructor' }, /Unknown name/);
    await fails(tool, { expression: '2 3' }, /Missing operator/);
  });
});

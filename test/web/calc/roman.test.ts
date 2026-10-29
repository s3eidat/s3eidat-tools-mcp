import { describe, expect, it } from 'vitest';
import tool, { dateRoman, parseRoman, toRoman, vinculum } from '../../../src/tools/web/calc/roman-numerals.js';
import { fails, run } from './_run.js';

describe('calc_roman (roman-numerals self-test)', () => {
  const bad = (s: string) => !!parseRoman(s).err;
  it('matches the website known answers', () => {
    for (let n = 1; n <= 3999; n++) expect(parseRoman(toRoman(n).roman).value).toBe(n);
    expect([toRoman(1994).roman, toRoman(3999).roman, toRoman(4).roman, toRoman(2026).roman]).toEqual(['MCMXCIV', 'MMMCMXCIX', 'IV', 'MMXXVI']);
    expect(parseRoman('mcmxciv').value).toBe(1994);
    for (const s of ['IIII', 'IC', 'VV', 'MMMM', 'IXI', 'VX', 'ABC', 'XCX']) expect(bad(s), s).toBe(true);
    expect(parseRoman('IC').err!.indexOf('XCIX')).toBeGreaterThan(0);
    expect(vinculum(5000)).toBe('V\u0305');
    expect(vinculum(4321)).toBe('I\u0305V\u0305CCCXXI');
    expect(dateRoman(2026, 10, 26, 'dmy', '.')).toBe('XXVI.X.MMXXVI');
    expect(dateRoman(2026, 10, 26, 'mdy', ' · ')).toBe('X · XXVI · MMXXVI');
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { mode: 'to_roman', number: '1,994' });
    expect([r.roman, r.explanation]).toEqual(['MCMXCIV', 'M (1000) + CM (900) + XC (90) + IV (4) = 1,994']);
    const v = await run(tool, { mode: 'to_roman', number: 4321 });
    expect([v.roman, v.vinculum]).toEqual(['I\u0305V\u0305CCCXXI', true]);
    const f = await run(tool, { mode: 'from_roman', roman: 'xliv' });
    expect([f.valid, f.value, f.explanation]).toEqual([true, 44, '−10 + 50 − 1 + 5 = 44']);
    const e = await run(tool, { mode: 'from_roman', roman: 'IIX' });
    expect(e.valid).toBe(false);
    const n = await run(tool, { mode: 'from_roman', roman: 'XCX' });
    expect([n.valid, n.standardForm, n.value]).toEqual([false, 'C', 100]);
    const d = await run(tool, { mode: 'date', date: '2026-10-26', order: 'dmy', separator: '.' });
    expect([d.roman, d.plain]).toEqual(['XXVI.X.MMXXVI', '26.10.2026']);
    expect((await run(tool, { mode: 'to_roman', number: 0 })).valid).toBe(false);
    await fails(tool, { mode: 'to_roman', number: 4000000 }, /Too large/);
  });
});

import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import wheel, { parseNames } from '../../../src/tools/web/everyday/wheel-picker.js';
import { makeRandInt, seededU32, shuffle, uniformFrom } from '../../../src/tools/web/everyday/_random.js';

describe('fair random helpers (website uniformFrom)', () => {
  it('rejects the top slice and never biases', () => {
    const seq = [0xffffffff, 5];
    let calls = 0;
    expect(uniformFrom(3, () => { calls++; return seq.shift()!; })).toBe(2);
    expect(calls).toBe(2);
    expect(uniformFrom(1, () => 123456)).toBe(0);
    expect(uniformFrom(4, () => 0xffffffff)).toBe(3); // 2^32 divisible by 4: nothing rejected
    const counts = [0, 0, 0, 0, 0];
    const r = makeRandInt();
    for (let i = 0; i < 5000; i++) counts[r(5)]++;
    for (const k of counts) expect(k).toBeGreaterThan(880), expect(k).toBeLessThan(1120);
  });
  it('seeded streams are reproducible', () => {
    const a = seededU32('x'), b = seededU32('x'), c = seededU32('y');
    const va = Array.from({ length: 20 }, a), vb = Array.from({ length: 20 }, b), vc = Array.from({ length: 20 }, c);
    expect(va).toEqual(vb);
    expect(va).not.toEqual(vc);
    expect(shuffle([1, 2, 3, 4, 5, 6], makeRandInt()).sort().join()).toBe('1,2,3,4,5,6');
    expect(shuffle([1, 2, 3, 4, 5], (n) => n - 1).join()).toBe('1,2,3,4,5');
  });
});

describe('random_pick (wheel-picker self-test)', () => {
  it('parses entries like the website', () => {
    expect(parseNames(' Ali \n\nسارة\n  ').join('|')).toBe('Ali|سارة');
    expect(parseNames('x'.repeat(150))[0]).toHaveLength(100);
    expect(parseNames(Array.from({ length: 600 }, (_, i) => 'n' + i).join('\n'))).toHaveLength(500);
  });
  it('picks distinct winners, reproducible with a seed', async () => {
    const input = { items: ['Ali', 'Sara', 'Omar', 'Lina', 'Huda'], count: 3, seed: 's' };
    const a = await call<{ winners: { name: string; index: number }[]; remaining: string[] }>(wheel, input);
    const b = await call<typeof a>(wheel, input);
    expect(a).toEqual(b);
    expect(new Set(a.winners.map((w) => w.name)).size).toBe(3);
    expect(a.remaining).toHaveLength(2);
    for (const w of a.winners) expect(input.items[w.index]).toBe(w.name);
  });
  it('shuffles, sorts and validates', async () => {
    const s = await call<{ list: string[] }>(wheel, { text: 'b\na\nc', mode: 'sort' });
    expect(s.list).toEqual(['a', 'b', 'c']);
    const sh = await call<{ list: string[] }>(wheel, { text: 'b\na\nc', mode: 'shuffle' });
    expect(sh.list.slice().sort()).toEqual(['a', 'b', 'c']);
    await expect(call(wheel, { items: ['only'] })).rejects.toThrow(/at least two/);
    await expect(call(wheel, { items: ['a', 'b'], count: 3 })).rejects.toThrow(/Only 2/);
  });
});

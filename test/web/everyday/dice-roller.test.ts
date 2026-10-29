import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import dice, { canon, coinStep, genNumbers, parse, roll, type CoinState } from '../../../src/tools/web/everyday/dice-roller.js';
import { makeRandInt } from '../../../src/tools/web/everyday/_random.js';

// Known answers copied from dice-roller's S3_SELFTEST.
const seq = (vals: number[]) => () => vals.shift()! - 1;
const terms = (s: string) => parse(s).terms!;

describe('random_dice (dice-roller self-test)', () => {
  it('rolls notation with keep/drop', () => {
    const p1 = { terms: terms('4d6 drop lowest') }, r1 = roll(p1, seq([3, 1, 4, 6]));
    expect(r1.total).toBe(13);
    expect(r1.parts[0].rolls![1].kept).toBe(false);
    expect(canon(p1)).toBe('4d6dl1');
    expect(roll({ terms: terms('2d20kh1') }, seq([5, 17])).total).toBe(17);
    expect(roll({ terms: terms('2d20kl1') }, seq([5, 17])).total).toBe(5);
    expect(roll({ terms: terms('2d6+3') }, seq([2, 5])).total).toBe(10);
    expect(roll({ terms: terms('d20 - 1d4 - 2') }, seq([12, 3])).total).toBe(7);
    expect(terms('d%')[0].sides).toBe(100);
    expect(terms('D20')[0].n).toBe(1);
    expect(roll({ terms: terms('5d10dh2') }, seq([9, 2, 10, 4, 4])).total).toBe(10);
  });
  it('rejects bad notation', () => {
    for (const s of ['', '2d', '0d6', '101d6', '4d6dl4', '2d1', 'abc', '2d6+', '2d6 3', '1d1001']) expect(parse(s).error, s).toBeTruthy();
  });
  it('numbers and coins', () => {
    const r = makeRandInt();
    expect(genNumbers(1, 10, 10, true, r).nums!.slice().sort((x, y) => x - y).join()).toBe('1,2,3,4,5,6,7,8,9,10');
    const big = genNumbers(1, 1e9, 50, true, r).nums!;
    expect(new Set(big).size).toBe(50);
    expect(big.every((x) => x >= 1 && x <= 1e9)).toBe(true);
    expect(genNumbers(1, 5, 6, true, r).error).toBeTruthy();
    expect(genNumbers(5, 1, 3, false, r).nums!.every((x) => x >= 1 && x <= 5)).toBe(true);
    const st = coinStep(coinStep(coinStep({ h: 0, t: 0, streak: 0, side: null, best: 0, seq: [] } as CoinState, true), true), false);
    expect([st.h, st.t, st.streak, st.best, st.bestSide]).toEqual([2, 1, 1, 2, 'h']);
  });
  it('runs as a tool', async () => {
    const d = await call<{ notation: string; results: { total: number; breakdown: string }[] }>(dice, { notation: '3d6 + 2', rolls: 5, seed: 'a' });
    expect(d.notation).toBe('3d6+2');
    expect(d.results).toHaveLength(5);
    for (const x of d.results) expect(x.total).toBeGreaterThanOrEqual(5), expect(x.total).toBeLessThanOrEqual(20);
    expect(await call(dice, { notation: '3d6 + 2', rolls: 5, seed: 'a' })).toEqual(d);
    const c = await call<{ coins: { heads: number; tails: number; sequence: string } }>(dice, { mode: 'coin', flips: 100 });
    expect(c.coins.heads + c.coins.tails).toBe(100);
    expect(c.coins.sequence).toMatch(/^[HT]{100}$/);
    const n = await call<{ numbers: number[] }>(dice, { mode: 'numbers', min: 1, max: 49, count: 6, unique: true, sort: true });
    expect(n.numbers).toHaveLength(6);
    expect(n.numbers).toEqual(n.numbers.slice().sort((a, b) => a - b));
    await expect(call(dice, { notation: '4d6dl4' })).rejects.toThrow(/drop 4 of 4/);
  });
});

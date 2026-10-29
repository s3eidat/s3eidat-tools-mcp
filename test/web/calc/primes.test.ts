import { describe, expect, it } from 'vitest';
import tool, { divisorInfo, euclidSteps, factor, factorText, gcdLcm, isPrime, nextPrime, parseBig, prevPrime, primesInRange, rho } from '../../../src/tools/web/calc/prime-tools.js';
import { fails, run } from './_run.js';

describe('calc_primes (prime-tools self-test)', () => {
  const M61 = (1n << 61n) - 1n, TWO64 = 1n << 64n;
  it('primality and factoring match the website', () => {
    for (const p of [2n, 3n, 97n, 7919n, 1000003n, 1000000007n, 2147483647n, M61, 18446744073709551557n]) {
      const t = isPrime(p);
      expect(t.prime && (p < 1000000n || t.method === 'deterministic'), String(p)).toBe(true);
    }
    expect(isPrime(M61).method).toBe('deterministic');
    for (const c of [0n, 1n, 4n, 561n, 1105n, 1729n, 2465n, 2821n, 6601n, 8911n, 3215031751n, 3825123056546413051n, TWO64 - 1n, 1000000007n * 1000000009n]) expect(isPrime(c).prime, String(c)).toBe(false);
    const t89 = isPrime((1n << 89n) - 1n); expect([t89.prime, t89.method]).toEqual([true, 'probabilistic']);
    expect(isPrime((1n << 67n) - 1n).prime).toBe(false);
    const d = rho(600851475143n)!; expect(d > 1n && d < 600851475143n && 600851475143n % d === 0n).toBe(true);
    expect(factorText(factor(600851475143n), true)).toBe('71 * 839 * 1471 * 6857');
    expect(factorText(factor(1000000007n * 998244353n), true)).toBe('998244353 * 1000000007');
    expect(factorText(factor((1n << 67n) - 1n), true)).toBe('193707721 * 761838257287');
    expect(factorText(factor(3825123056546413051n), true)).toBe('149491 * 747451 * 34233211');
    expect(factorText(factor(360n), true)).toBe('2^3 * 3^2 * 5');
    const i360 = divisorInfo(factor(360n), 360n); expect([i360.count, i360.list!.length, i360.sigma, i360.phi]).toEqual([24n, 24, 1170n, 96n]);
    expect(divisorInfo(factor(28n), 28n).sigma).toBe(56n);
    expect(divisorInfo(factor(8128n), 8128n).sigma).toBe(16256n);
    expect(factorText(factor(1000003n * 1000003n), true)).toBe('1000003^2');
    expect([nextPrime(13n), prevPrime(13n), prevPrime(2n), nextPrime(1n), prevPrime(3n), nextPrime(M61 - 2n)]).toEqual([17n, 11n, null, 2n, 2n, M61]);
  });
  it('gcd, sieve and parser match the website', () => {
    const g = gcdLcm([12n, 18n, 30n]); expect([g.gcd, g.lcm]).toEqual([6n, 180n]);
    expect(gcdLcm([0n, 5n]).gcd).toBe(5n);
    expect(gcdLcm([84n, 126n, 210n]).gcd).toBe(42n);
    expect(euclidSteps(1071n, 462n).lines.join('|')).toBe('1071 = 2 × 462 + 147|462 = 3 × 147 + 21|147 = 7 × 21 + 0');
    expect(primesInRange(1, 100)).toHaveLength(25);
    expect(primesInRange(1, 1000000)).toHaveLength(78498);
    const lo = 1e12, seg = primesInRange(lo, lo + 2000), brute: number[] = [];
    for (let k = lo; k <= lo + 2000; k++) if (isPrime(BigInt(k)).prime) brute.push(k);
    expect(seg.length > 0 && seg.join() === brute.join()).toBe(true);
    expect([parseBig('2^61-1'), parseBig('1,000,003'), parseBig('1000003*1000033'), parseBig('5!'), parseBig('(2+3)^2')]).toEqual([M61, 1000003n, 1000003n * 1000033n, 120n, 25n]);
    expect(() => parseBig('2^x')).toThrow();
  });
  it('runs as a tool', async () => {
    const r = await run(tool, { number: '600851475143' });
    expect(r).toMatchObject({ isPrime: false, verdict: 'Composite', factorization: '71 × 839 × 1471 × 6857', divisorCount: '16', nextPrime: '600851475149' });
    const p = await run(tool, { number: 28 });
    expect([p.perfect, p.divisors]).toEqual([true, ['1', '2', '4', '7', '14', '28']]);
    const m = await run(tool, { number: '2^61-1' });
    expect([m.isPrime, m.verdict]).toEqual([true, 'Prime']);
    const g = await run(tool, { mode: 'gcd_lcm', numbers: [84, '126', 210] });
    expect([g.gcd, g.lcm]).toEqual(['42', '1260']);
    const rg = await run(tool, { mode: 'range', from: 1, to: 100, limit: 5 });
    expect(rg).toEqual({ mode: 'range', count: 25, primes: [2, 3, 5, 7, 11], truncated: true });
    const one = await run(tool, { number: 1 });
    expect(one.verdict).toMatch(/neither/);
    await fails(tool, { mode: 'range', from: 1, to: 2e7 }, /10,000,000/);
  });
});

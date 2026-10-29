/**
 * Fair randomness shared by the everyday tools, same as the website: uint32 values from the OS CSPRNG and
 * rejection sampling, so every outcome is equally likely (no modulo bias).
 *
 * An optional seed swaps the CSPRNG for a deterministic stream (SHA-256 of seed + block counter), so a draw can
 * be reproduced. Seeded results are only reproducible here; they are not secret and not for passwords.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export type U32Source = () => number;
/** Uniform integer in [0, n). */
export type RandInt = (n: number) => number;

/** Uniform integer in [0, n) from a uint32 source: reject the top slice of the 32-bit range (website `uniformFrom`). */
export function uniformFrom(n: number, next: U32Source): number {
  if (!(n >= 1 && n <= 0x100000000 && n === Math.floor(n))) throw new Error('bad range ' + n);
  const lim = Math.floor(0x100000000 / n) * n;
  let x: number;
  do x = next(); while (x >= lim);
  return x % n;
}

let pool = Buffer.alloc(0);
let at = 0;
/** One uint32 from the OS CSPRNG (buffered). */
export function cryptoU32(): number {
  if (at + 4 > pool.length) {
    pool = randomBytes(1024);
    at = 0;
  }
  const v = pool.readUInt32BE(at);
  at += 4;
  return v;
}

/** Deterministic uint32 stream: SHA-256(seed ‖ "/" ‖ block) gives 8 values per block. */
export function seededU32(seed: string): U32Source {
  let block = 0;
  let buf = Buffer.alloc(0);
  let i = 0;
  return () => {
    if (i + 4 > buf.length) {
      buf = createHash('sha256').update(seed, 'utf8').update('/' + block++).digest();
      i = 0;
    }
    const v = buf.readUInt32BE(i);
    i += 4;
    return v;
  };
}

/** Random integer function: crypto by default, deterministic when a seed is given. */
export function makeRandInt(seed?: string): RandInt {
  const next = seed != null && seed !== '' ? seededU32(seed) : cryptoU32;
  return (n: number) => uniformFrom(n, next);
}

/** Fisher-Yates shuffle in place (website `shuffle`). */
export function shuffle<T>(a: T[], rng: RandInt): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

export const seedSchema = () =>
  z
    .string()
    .max(200)
    .optional()
    .describe('Optional seed for a reproducible result (same seed + same input = same output). Omit for true crypto randomness.');

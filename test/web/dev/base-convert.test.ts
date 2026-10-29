import { describe, expect, it } from 'vitest';
import tools, { bitLength, decode, fmtBytes, group, parse, parseBytes, toBase, twos } from '../../../src/tools/web/dev/base-convert.js';
import { call } from '../../helpers.js';

const [bc, bytesTool] = tools;
const p = (s: string, b: number | 'auto') => {
  const r = parse(s, b);
  return r.ok ? r.value : r.error;
};

describe('base-convert self-test', () => {
  it('numbers', () => {
    const big = 2n ** 100n;
    expect([p('ff', 16), p('0x1F', 'auto'), p('-0b101', 'auto'), p('0o17', 'auto'), p('z', 36), p('1_000_000', 10)]).toEqual([255n, 31n, -5n, 15n, 35n, 1000000n]);
    expect(typeof p('12', 2)).toBe('string');
    expect(typeof p('1.5', 10)).toBe('string');
    expect(toBase(big, 10)).toBe('1267650600228229401496703205376');
    expect(p('1' + '0'.repeat(25), 16)).toBe(big);
    expect(toBase(-255n, 16)).toBe('-ff');
    expect(group('11111111', 4, ' ')).toBe('1111 1111');
    expect(group('-1234567', 3, ',')).toBe('-1,234,567');
  });
  it("two's complement and bytes", () => {
    const t1 = twos(-1n, 8), t2 = twos(200n, 8), t3 = twos(-1n, 64), t4 = twos(256n, 8), t5 = twos(-128n, 8);
    expect([t1.hex, t1.unsigned, t2.signed, t2.fits, t3.hex, t4.fits, t4.unsigned, t5.bin, t5.fits]).toEqual(['FF', 255n, -56n, true, 'FFFFFFFFFFFFFFFF', false, 0n, '10000000', true]);
    expect([bitLength(255n), bitLength(0n)]).toEqual([8, 0]);
    expect(fmtBytes(new TextEncoder().encode('Hi ☕'), 'hex', true)).toBe('48 69 20 E2 98 95');
    const back = parseBytes('01001000 01101001', 'bin');
    expect(back.ok && decode(back.bytes).text).toBe('Hi');
    const hx = parseBytes('0x48,0x69', 'hex');
    expect(hx.ok && hx.bytes.length).toBe(2);
    const ff = parseBytes('ff', 'hex');
    expect(ff.ok && decode(ff.bytes).valid).toBe(false);
    expect(parseBytes('abc', 'hex').ok).toBe(false);
    expect(parseBytes('256', 'dec').ok).toBe(false);
    const dec = parseBytes('72 105', 'dec');
    expect(dec.ok && decode(dec.bytes).text).toBe('Hi');
  });
});

describe('base_convert / bytes_convert tools', () => {
  it('runs', async () => {
    const r = await call<Record<string, any>>(bc, { value: '0xC0FFEE', group: true, uppercase: true, to: [2, 10, 16, 7] });
    expect(r.decimal).toBe('12648430');
    expect(r.results).toEqual([
      { base: 2, name: 'Binary', value: '1100 0000 1111 1111 1110 1110' },
      { base: 10, name: 'Decimal', value: '12,648,430' },
      { base: 16, name: 'Hex', value: 'C0 FFEE' },
      { base: 7, name: 'Base 7', value: '212336614' },
    ]);
    expect(r.bitLength).toBe(24);
    expect(r.twosComplement).toMatchObject({ width: 32, signed: '12648430', hex: '0x00C0 FFEE', fits: true });
    expect((await call<Record<string, any>>(bc, { value: '-1', width: 8 })).twosComplement).toMatchObject({ unsigned: '255', hex: '0xFF' });
    await expect(call(bc, { value: '12', from: 2 })).rejects.toThrow(/not a base-2 digit/);
  });
  it('bytes', async () => {
    expect(await call(bytesTool, { text: 'Hi ☕', uppercase: true })).toMatchObject({ bytes: '48 69 20 E2 98 95', byteCount: 6, characters: 4 });
    expect(await call(bytesTool, { bytes: '72 105', format: 'dec' })).toMatchObject({ text: 'Hi', validUtf8: true });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import barcode, { C128_PATTERNS, C39, L, c39mod43, code128, code128Values, code39, ean13, eanCheck, inv, upca, upcCheck } from '../../../src/tools/web/qr/barcode-gen.js';
import { call, tempCtx } from '../../helpers.js';

const ctx = tempCtx();

// Known answers from barcode-gen's S3_SELFTEST.
describe('barcode encoders (barcode-gen self-test)', () => {
  it('Code 128', () => {
    expect(C128_PATTERNS.every((p, i) => p.split('').reduce((a, b) => a + +b, 0) === (i === 106 ? 13 : 11))).toBe(true);
    expect(code128Values('Wikipedia').join(',')).toBe('104,55,73,75,73,80,69,68,73,65,88,106');
    expect(code128Values('123456').join(',')).toBe('105,12,34,56,44,106');
    expect(code128Values('AB1234567').join(',').indexOf('104,33,34,17,99,23,45,67,')).toBe(0);
    expect(code128('A').bits).toBe('11010010000' + '10100011000' + '10001011000' + '1100011101011');
    expect(() => code128Values('café')).toThrow(/printable ASCII/);
  });
  it('EAN-13 and UPC-A', () => {
    const e = ean13('400638133393'), eb = e.bits;
    expect(eanCheck('400638133393')).toBe(1);
    expect(e.digits).toBe('4006381333931');
    expect(e.note).toBe('Check digit 1 added');
    expect(eb.length).toBe(95);
    expect([eb.slice(0, 3), eb.slice(45, 50)]).toEqual(['101', '01010']);
    expect(eb.slice(3, 10)).toBe(L[0]);
    expect(eb.slice(10, 17)).toBe(inv(L[0]).split('').reverse().join(''));
    expect(eb.slice(50, 57)).toBe(inv(L[3]));
    expect(upcCheck('03600029145')).toBe(2);
    expect(upca('036000291452').digits).toBe('036000291452');
    expect(() => ean13('4006381333932')).toThrow(/should be 1/);
    expect(() => upca('123')).toThrow(/needs 11 or 12 digits \(you have 3\)/);
  });
  it('Code 39', () => {
    expect(Object.keys(C39).every((k) => C39[k].split('1').length - 1 === 3)).toBe(true);
    expect(c39mod43('CODE39')).toBe('W');
    expect(code39('A', false).bits.length).toBe(3 * 15 + 2);
    expect(new Set(Object.values(C39)).size).toBe(44);
    expect(code39('code39', true)).toMatchObject({ text: '*CODE39W*', note: 'Letters made uppercase' });
  });
});

describe('barcode_generate tool', () => {
  it('SVG bars reproduce the encoded bit pattern', async () => {
    const r = await call<{ path: string; text: string; note: string; width: number; modules: number }>(barcode, { value: '400638133393', symbology: 'ean13', barWidth: 1, showText: false }, ctx);
    expect(r.text).toBe('4006381333931');
    expect(r.width).toBe(11 + 95 + 7);
    const svg = readFileSync(r.path, 'utf8');
    const bits = Array(r.modules).fill('0');
    for (const m of svg.matchAll(/<rect x="(\d+)" y="\d+" width="(\d+)"/g)) for (let i = 0; i < +m[2]; i++) bits[+m[1] - 11 + i] = '1';
    expect(bits.join('')).toBe(ean13('400638133393').bits);
  });
  it('PNG output at scale, with digits', async () => {
    const { default: sharp } = await import('sharp');
    const r = await call<{ path: string; width: number; height: number }>(barcode, { value: '03600029145', symbology: 'upca', format: 'png', scale: 2 }, ctx);
    const meta = await sharp(r.path).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', r.width * 2, r.height * 2]);
  });
  it('batch with errors', async () => {
    const r = await call<{ files: { text: string }[]; errors: { line: number; error: string }[] }>(barcode, { values: ['590123412345', '400638133393', '12345', '400638133393'], symbology: 'ean13' }, ctx);
    expect(r.files.map((f) => f.text)).toEqual(['5901234123457', '4006381333931', '4006381333931']);
    expect(r.errors).toEqual([{ line: 3, value: '12345', error: 'EAN-13 needs 12 or 13 digits (you have 5)' }]);
  });
});

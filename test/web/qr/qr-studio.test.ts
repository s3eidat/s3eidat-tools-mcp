import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import qrGenerate from '../../../src/tools/web/qr/qr-studio.js';
import { makeQR } from '../../../src/tools/web/qr/_qrcode.js';
import { contrast, payload, wifiPayload } from '../../../src/tools/web/qr/_qr.js';
import { call, tempCtx } from '../../helpers.js';

const ctx = tempCtx();

// Known answers from qr-studio's and wifi-card's S3_SELFTEST.
describe('QR encoder (qr-studio self-test)', () => {
  it('versions, function patterns and capacity', () => {
    const url = 'https://s3eidat.github.io'; // 25 bytes
    const m = makeQR(url, 'M'), h = makeQR(url, 'H'), l = makeQR('HELLO', 'L');
    expect([l.moduleCount, m.moduleCount, h.moduleCount]).toEqual([21, 25, 33]);
    expect(m.isDark(0, 0) && m.isDark(0, 6) && !m.isDark(1, 1) && m.isDark(2, 2) && m.isDark(4, 4) && !m.isDark(7, 7)).toBe(true);
    for (let i = 8; i < m.moduleCount - 8; i++) expect(m.isDark(6, i)).toBe(i % 2 === 0);
    expect(h.isDark(4 * 4 + 9, 8)).toBe(true); // the dark module
    expect(() => makeQR(new Array(3000).join('x'), 'H')).toThrow(/overflow/);
    expect(makeQR('مرحبا', 'M').moduleCount).toBe(21); // 10 UTF-8 bytes -> version 1
    expect(makeQR('WIFI:T:WPA;S:Home;P:12345678;;', 'M').moduleCount).toBe(29); // wifi-card: 30 bytes -> version 3
  });

  it('matches the qr-scanner known matrix for "S3eidat QR test" (version 2-M)', () => {
    const KNOWN = ['1fd737f', '104ad41', '175375d', '174045d', '1748e5d', '1050241', '1fd557f', '00e700', '146fd25', '1cb0ca9', '17f63d5', '89094b',
      '1dc9adb', '6a5367', '18c9ef7', '11f60b', '1f6cffb', '014f1a', '1fd615d', '1044b1b', '1747bf8', '1741290', '175dd37', '104f588', '1fd8dd1'];
    const q = makeQR('S3eidat QR test', 'M');
    expect(q.moduleCount).toBe(25);
    const rows = q.modules.map((r) => parseInt(r.map((d) => (d ? '1' : '0')).join(''), 2).toString(16));
    expect(rows).toEqual(KNOWN.map((x) => parseInt(x, 16).toString(16)));
  });

  it('modes and fixed versions', () => {
    expect(makeQR('12345678901234567890', 'M', { mode: 'Numeric' }).moduleCount).toBe(21);
    expect(makeQR('HELLO WORLD', 'Q', { mode: 'Alphanumeric' }).version).toBe(1);
    expect(makeQR('hi', 'L', { version: 10 }).moduleCount).toBe(57);
    expect(() => makeQR('abc', 'M', { mode: 'Numeric' })).toThrow(/digits/);
  });
});

describe('QR payloads (qr-studio / wifi-card self-test)', () => {
  it('escapes like the website', () => {
    expect(payload('wifi', { ssid: 'My;Net"', pass: 'a:b\\c', sec: 'WPA', hidden: true })).toBe('WIFI:T:WPA;S:My\\;Net\\";P:a\\:b\\\\c;H:true;;');
    expect(String(payload('vcard', { first: 'Sara', last: 'Haddad, Jr', tel: '+1 555' })).indexOf('N:Haddad\\, Jr;Sara;;;')).toBeGreaterThan(0);
    expect(payload('geo', { lat: '91', lng: '0' })).toHaveProperty('error');
    expect(payload('url', { url: 'example.com' })).toBe('https://example.com');
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 2);
    expect(wifiPayload('My;Net"', 'p:ss\\w,1', 'WPA', true)).toBe('WIFI:T:WPA;S:My\\;Net\\";P:p\\:ss\\\\w\\,1;H:true;;');
    expect(wifiPayload('Guest', 'ignored', 'nopass', false)).toBe('WIFI:T:nopass;S:Guest;;');
    expect(payload('email', { to: 'a@b.co', subject: 'Hi there', body: 'x&y' })).toBe('mailto:a@b.co?subject=Hi%20there&body=x%26y');
    expect(payload('sms', { num: '+962 79-000', msg: 'hello' })).toBe('SMSTO:+96279000:hello');
    expect(payload('geo', { lat: '31.9539', lng: '35.9106', q: 'Our office' })).toBe('geo:31.9539,35.9106?q=Our%20office');
  });
});

describe('qr_generate tool', () => {
  it('writes an SVG with the payload and info', async () => {
    const r = await call<{ path: string; payload: string; version: number; modules: number; ecc: string; warnings: string[] }>(
      qrGenerate, { url: 'example.com', format: 'svg', size: 300 }, ctx);
    expect(r.payload).toBe('https://example.com');
    expect(r.modules).toBe(25);
    expect(r.ecc).toBe('M');
    const svg = readFileSync(r.path, 'utf8');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="300" height="300" viewBox="0 0 33 33" shape-rendering="crispEdges">/);
    expect(r.warnings).toEqual([]);
  });

  it('writes a PNG of the requested size and warns about low contrast', async () => {
    const { default: sharp } = await import('sharp');
    const r = await call<{ path: string; warnings: string[]; contrast: number }>(
      qrGenerate, { type: 'wifi', ssid: 'Home', password: '12345678', size: 256, foreground: '#999999', shape: 'dots' }, ctx);
    const meta = await sharp(r.path).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 256, 256]);
    expect(r.contrast).toBeLessThan(3);
    expect(r.warnings[0]).toMatch(/^Contrast is 2\.8:1/);
  });

  it('clear errors', async () => {
    await expect(call(qrGenerate, { type: 'vcard' }, ctx)).rejects.toThrow(/firstName/);
    await expect(call(qrGenerate, { type: 'geo', latitude: 91, longitude: 0 }, ctx)).rejects.toThrow(/Latitude/);
    await expect(call(qrGenerate, { text: 'x'.repeat(3000), ecc: 'H' }, ctx)).rejects.toThrow(/Too much data/);
    await expect(call(qrGenerate, { text: 'x', foreground: 'red' }, ctx)).rejects.toThrow(/hex colour/);
  });
});

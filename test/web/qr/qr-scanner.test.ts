import { describe, expect, it } from 'vitest';
import qrGenerate from '../../../src/tools/web/qr/qr-studio.js';
import qrRead, { analyzeUrl, classify } from '../../../src/tools/web/qr/qr-scanner.js';
import { call, tempCtx } from '../../helpers.js';

const ctx = tempCtx();
type Read = { text: string; type: string; fields: { label: string; value: string }[]; url?: { host: string; warnings: string[] }; version: number };

// The known QR from qr-scanner's S3_SELFTEST: "S3eidat QR test", version 2-M, rows as hex.
const KNOWN = ['1fd737f', '104ad41', '175375d', '174045d', '1748e5d', '1050241', '1fd557f', '00e700', '146fd25', '1cb0ca9', '17f63d5', '89094b', '1dc9adb',
  '6a5367', '18c9ef7', '11f60b', '1f6cffb', '014f1a', '1fd615d', '1044b1b', '1747bf8', '1741290', '175dd37', '104f588', '1fd8dd1'];
async function drawKnown(scale: number, invert = false) {
  const { default: sharp } = await import('sharp');
  const n = KNOWN.length, px = (n + 8) * scale, buf = Buffer.alloc(px * px, invert ? 0 : 255);
  KNOWN.forEach((hex, r) => {
    const v = parseInt(hex, 16);
    for (let c = 0; c < n; c++) if ((v >> (n - 1 - c)) & 1) {
      for (let y = 0; y < scale; y++) buf.fill(invert ? 255 : 0, ((r + 4) * scale + y) * px + (c + 4) * scale, ((r + 4) * scale + y) * px + (c + 5) * scale);
    }
  });
  return (await sharp(buf, { raw: { width: px, height: px, channels: 1 } }).png().toBuffer()).toString('base64');
}

describe('qr_read (qr-scanner self-test)', () => {
  it('decodes the known code, normal and inverted', async () => {
    expect((await call<Read>(qrRead, { image: 'base64:' + (await drawKnown(6)) }, ctx)).text).toBe('S3eidat QR test');
    const inv = await call<Read>(qrRead, { image: 'base64:' + (await drawKnown(4, true)) }, ctx);
    expect(inv.text).toBe('S3eidat QR test');
    expect(inv.version).toBe(2);
  });

  it('classifies content like the website', () => {
    const w = classify('WIFI:T:WPA;S:My\\;Net;P:pa\\:ss\\\\;H:true;;');
    expect(w.type).toBe('Wi-Fi');
    expect(w.rows!.map((r) => r[1])).toEqual(['My;Net', 'pa:ss\\', 'WPA', 'Yes']);
    const v = classify('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Haddad;Sara;;;\r\nTEL;TYPE=CELL:+1 555\r\nEND:VCARD');
    expect([v.type, v.rows![0][1], v.rows![1][1]]).toEqual(['Contact', 'Sara Haddad', '+1 555']);
    const u1 = classify('http:' + '//user@xn--pple-43d.com:8080/x'), u2 = classify('https://s3eidat.github.io/a?b=1');
    expect(u1.type).toBe('Link');
    expect(u1.url!.warn).toHaveLength(4);
    expect(u1.url!.host).toBe('xn--pple-43d.com');
    expect(u2.url!.warn).toHaveLength(0);
    expect(u2.url!.host).toBe('s3eidat.github.io');
    expect(analyzeUrl('data:text/html,hi')!.openable).toBe(false);
    const m = classify('mailto:a@b.co?subject=Hi%20there');
    expect([m.type, m.rows![1][1]]).toEqual(['Email', 'Hi there']);
    expect(classify('hello world').type).toBe('Text');
  });
});

describe('qr_generate → qr_read round trip', () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ url: 'example.com/page?x=1' }, 'https://example.com/page?x=1', 'Link'],
    [{ text: 'مرحبا بالعالم 👋 café' }, 'مرحبا بالعالم 👋 café', 'Text'],
    [{ type: 'wifi', ssid: 'S3eidat Café', password: 'coffee;is:free', shape: 'rounded' }, 'WIFI:T:WPA;S:S3eidat Café;P:coffee\\;is\\:free;;', 'Wi-Fi'],
    [{ type: 'vcard', firstName: 'Sara', lastName: 'Haddad', phone: '+962 7 9000 0000', email: 'sara@example.com', ecc: 'H', shape: 'dots' },
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Haddad;Sara;;;\r\nFN:Sara Haddad\r\nTEL;TYPE=CELL:+962 7 9000 0000\r\nEMAIL:sara@example.com\r\nEND:VCARD', 'Contact'],
    [{ type: 'geo', latitude: 31.9539, longitude: 35.9106 }, 'geo:31.9539,35.9106', 'Location'],
    [{ text: '0123456789012345678901234567890', mode: 'auto', ecc: 'Q' }, '0123456789012345678901234567890', 'Text'],
    [{ text: 'x'.repeat(1200), ecc: 'L', size: 1200, margin: 2 }, 'x'.repeat(1200), 'Text'],
    [{ text: 'Inverted', foreground: '#ffffff', background: '#102030' }, 'Inverted', 'Text'],
  ];
  it.each(cases.map((c, i) => [i, ...c] as const))('case %i', async (_i, input, want, type) => {
    const g = await call<{ path: string; payload: string }>(qrGenerate, { size: 600, ...input }, ctx);
    expect(g.payload).toBe(want);
    const r = await call<Read>(qrRead, { image: g.path }, ctx);
    expect(r.text).toBe(want);
    expect(r.type).toBe(type);
  });

  it('reads an SVG and a logo code', async () => {
    const { default: sharp } = await import('sharp');
    const logo = await sharp({ create: { width: 80, height: 80, channels: 4, background: '#e2604a' } }).png().toBuffer();
    const g = await call<{ path: string; ecc: string }>(qrGenerate, { url: 'https://s3eidat.github.io/qr-studio/', format: 'svg', logo: 'base64:' + logo.toString('base64') }, ctx);
    expect(g.ecc).toBe('H');
    expect((await call<Read>(qrRead, { image: g.path }, ctx)).text).toBe('https://s3eidat.github.io/qr-studio/');
  });

  it('says so when there is no code', async () => {
    const { default: sharp } = await import('sharp');
    const blank = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await expect(call(qrRead, { image: 'base64:' + blank.toString('base64') }, ctx)).rejects.toThrow(/No QR code found/);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import tools, { b64ToBytes, bytesToB64, decodeText, detect, encodeText, toUrlSafe, wrap76 } from '../../../src/tools/web/dev/base64.js';
import { call, tempCtx } from '../../helpers.js';

const [enc, dec] = tools;
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('base64-kit self-test', () => {
  it('RFC 4648 vectors', () => {
    const v: Record<string, string> = { '': '', f: 'Zg==', fo: 'Zm8=', foo: 'Zm9v', foob: 'Zm9vYg==', fooba: 'Zm9vYmE=', foobar: 'Zm9vYmFy' };
    for (const [k, b] of Object.entries(v)) {
      expect(encodeText(k)).toBe(b);
      expect(decodeText(b)).toBe(k);
    }
  });
  it('UTF-8, URL-safe, lenient decode, magic, wrap', () => {
    expect(encodeText('✓')).toBe('4pyT');
    const ar = 'مرحبا \u{1F44B}';
    expect(decodeText(encodeText(ar))).toBe(ar);
    expect(decodeText(encodeText(ar, true))).toBe(ar);
    expect(bytesToB64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
    expect(toUrlSafe('+/8=')).toBe('-_8');
    expect(b64ToBytes('-_8').bytes[1]).toBe(0xff);
    expect(decodeText('Zm9v\nYmFy')).toBe('foobar');
    expect(() => b64ToBytes('Zm9v!')).toThrow();
    expect(detect(b64ToBytes(PNG1).bytes).ext).toBe('png');
    expect(detect(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])).ext).toBe('pdf');
    expect(detect(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])).ext).toBe('zip');
    expect(b64ToBytes('data:text/plain;base64,aGk=').mime).toBe('text/plain');
    expect(wrap76('A'.repeat(80))).toBe('A'.repeat(76) + '\nAAAA');
  });
});

describe('base64_encode / base64_decode tools', () => {
  const ctx = tempCtx();
  it('encodes text and files', async () => {
    expect(await call(enc, { text: 'foobar' })).toMatchObject({ base64: 'Zm9vYmFy', inputBytes: 6 });
    const r = await call(enc, { file: 'base64:' + PNG1, dataUri: true }, ctx);
    expect(r).toMatchObject({ base64: 'data:image/png;base64,' + PNG1, detectedType: 'PNG image' });
  });
  it('decodes text inline and binary to a file', async () => {
    expect(await call(dec, { base64: 'Zm9vYmFy' })).toMatchObject({ text: 'foobar', isText: true });
    const r = await call<{ path: string; bytes: number }>(dec, { base64: PNG1 }, ctx);
    expect(r.path.endsWith('decoded.png')).toBe(true);
    expect(readFileSync(r.path).toString('base64')).toBe(PNG1);
  });
});

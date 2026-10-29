import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import tools, { PREFIX, decryptText, encryptText, fromB64 } from '../../../src/tools/web/everyday/text-encrypt.js';

const [encTool, decTool] = tools;
// The website's own fixed vector (text-encrypt S3_SELFTEST "KNOWN"): proves messages made on the site decrypt here.
const KNOWN = {
  pw: 's3eidat',
  text: 'Hello, مرحبا 👋',
  data: 'S3E1.AQEACSfAtcIyfKiQlnccWg4e2uFxBglGUizyF0IsTYNU0kSqKpIDX4xsscpbHaTSv0AGmLwAcP3l341prQNNoeukuzER22r7',
};
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const flip = (s: string, at: number) => { const r = fromB64(s.slice(5)); r[at] ^= 1; return PREFIX + b64(r); };
const ITER = 100000; // fastest the format allows, to keep tests quick

describe('crypto_text_encrypt / crypto_text_decrypt (text-encrypt self-test)', () => {
  it('decrypts the website vector', async () => {
    expect((await decryptText(KNOWN.data, KNOWN.pw)).text).toBe(KNOWN.text);
  });
  it('builds byte-identical output to an independent implementation of the format (fixed salt/iv)', async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i), iv = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
    const msg = 'Fixed vector ✓ عربي', pw = 'päss';
    const mine = await encryptText(msg, pw, ITER, { salt, iv });
    // Independent: node:crypto PBKDF2 + AES-256-GCM, header = 01 01 | u32 BE iterations | salt | iv, header as AAD.
    const header = Buffer.concat([Buffer.from([1, 1]), Buffer.from([0, 1, 0x86, 0xa0]), salt, iv]);
    const key = pbkdf2Sync(Buffer.from(pw.normalize('NFC'), 'utf8'), salt, ITER, 32, 'sha256');
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(header);
    const ct = Buffer.concat([c.update(Buffer.from(msg, 'utf8')), c.final(), c.getAuthTag()]);
    expect(mine).toBe('S3E1.' + Buffer.concat([header, ct]).toString('base64'));
    expect(mine).toBe('S3E1.AQEAAYagAAECAwQFBgcICQoLDA0OD6ChoqOkpaanqKmqq/4nOtgpZsNVHgkSc9OgcF79LzyHtaY11XewTBgt/gwInXQL6acPoKSk');
    expect((await decryptText(mine, pw)).text).toBe(msg);
  });
  it('round trips and rejects tampering', async () => {
    const msg = 'Round trip ✓ — عربي — 🔐\nline 2', pwd = 'pässwörd 🔑';
    const a = await encryptText(msg, pwd, ITER), b = await encryptText(msg, pwd, ITER);
    expect(a.slice(0, 5)).toBe(PREFIX);
    expect(a).not.toBe(b);
    const raw = fromB64(a.slice(5));
    expect(raw.length).toBe(34 + Buffer.byteLength(msg) + 16);
    expect([raw[0], raw[1], new DataView(raw.buffer).getUint32(2)]).toEqual([1, 1, ITER]);
    expect((await decryptText(a, pwd)).text).toBe(msg);
    expect((await decryptText(a, pwd.normalize('NFD'))).text).toBe(msg);
    await expect(decryptText(a, pwd + 'x')).rejects.toThrow(/Wrong password/);
    await expect(decryptText(flip(a, raw.length - 20), pwd)).rejects.toThrow(/Wrong password/);
    await expect(decryptText(flip(a, 8), pwd)).rejects.toThrow(/Wrong password/);
    await expect(decryptText(flip(a, 2 + 4 + 16 + 3), pwd)).rejects.toThrow(/Wrong password/);
    await expect(decryptText(PREFIX + b64(raw.subarray(0, raw.length - 1)), pwd)).rejects.toThrow(/Wrong password/);
    await expect(decryptText(PREFIX + b64(raw.subarray(0, 40)), pwd)).rejects.toThrow(/too short/);
    const big = fromB64(a.slice(5));
    new DataView(big.buffer).setUint32(2, 0xffffffff);
    await expect(decryptText(PREFIX + b64(big), pwd)).rejects.toThrow(/invalid header/);
    await expect(decryptText('hello', pwd)).rejects.toThrow(/doesn't look like/);
    await expect(decryptText('S3E2.abc', pwd)).rejects.toThrow(/newer version/);
    // base64url + line breaks are accepted
    const url = PREFIX + a.slice(5).replace(/\+/g, '-').replace(/\//g, '_').replace(/(.{20})/g, '$1\n');
    expect((await decryptText(url, pwd)).text).toBe(msg);
  });
  it('runs as tools', async () => {
    const ctx = tempCtx();
    const e = await call<{ encrypted: string; bytes: number; path: string }>(encTool, { text: 'hi there', password: 'pw', iterations: ITER, output: ctx.outDir + '/' }, ctx);
    expect(e.bytes).toBe(8);
    expect(readFileSync(e.path, 'utf8')).toBe(e.encrypted + '\n');
    const d = await call<{ text: string }>(decTool, { path: e.path, password: 'pw' }, ctx);
    expect(d.text).toBe('hi there');
    await expect(call(decTool, { encrypted: e.encrypted, password: 'nope' }, ctx)).rejects.toThrow(/Wrong password/);
  });
});

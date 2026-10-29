import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import tools, { buildPayload, capacity, embed, extract, open, rgba, toPng } from '../../../src/tools/web/everyday/stego-image.js';

const [hideTool, revealTool] = tools;
const W = 48, H = 40;
function cover() {
  const base = new Uint8Array(randomBytes(W * H * 4));
  for (let i = 3; i < base.length; i += 4) base[i] = 255;
  return base;
}
const msg = 'héllo 👋 مرحبا\nline two';
const te = new TextEncoder();

// Cases from stego-image's S3_SELFTEST.
describe('crypto_stego_hide / crypto_stego_reveal (stego-image self-test)', () => {
  it('plain round trip changes only RGB LSBs, with the website bit layout', async () => {
    const base = cover(), px = new Uint8Array(base);
    embed(px, W, H, await buildPayload(msg, ''));
    for (let i = 0; i < px.length; i++) {
      if (i % 4 === 3) expect(px[i]).toBe(base[i]);
      else expect(Math.abs(px[i] - base[i])).toBeLessThanOrEqual(1);
    }
    // "S3SG" = 0x53 = 01010011: bits go MSB-first into R,G,B of pixel 0, then R,G,B of pixel 1, then R,G of pixel 2.
    expect([px[0], px[1], px[2], px[4], px[5], px[6], px[8], px[9]].map((v) => v & 1)).toEqual([0, 1, 0, 1, 0, 0, 1, 1]);
    const r = extract(px, W, H) as { flags: number; head: Uint8Array; payload: Uint8Array };
    expect(r.flags).toBe(0);
    expect(await open(r, '')).toBe(msg);
    expect(extract(new Uint8Array(base), W, H)).toBeNull();
    expect(capacity(10, 10)).toBe(27);
    expect(() => embed(new Uint8Array(400), 10, 10, new Uint8Array(38))).toThrow(/too long/);
  });
  it('encrypted payload matches an independent build of the format and rejects wrong/missing passwords', async () => {
    const pw = 's3cret pässword', salt = Buffer.alloc(16, 7), iv = Buffer.alloc(12, 9);
    const mine = await buildPayload(msg, pw, { salt, iv });
    const plain = Buffer.from(msg, 'utf8'), len = 16 + 12 + plain.length + 16;
    const head = Buffer.from([0x53, 0x33, 0x53, 0x47, 1, 1, len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255]);
    const c = createCipheriv('aes-256-gcm', pbkdf2Sync(Buffer.from(pw.normalize('NFC')), salt, 600000, 32, 'sha256'), iv);
    c.setAAD(head.subarray(0, 6));
    expect(Buffer.from(mine).equals(Buffer.concat([head, salt, iv, c.update(plain), c.final(), c.getAuthTag()]))).toBe(true);
    const px = cover();
    embed(px, W, H, mine);
    const r = extract(px, W, H) as { flags: number; head: Uint8Array; payload: Uint8Array };
    expect(r.flags).toBe(1);
    expect(r.payload.length).toBe(te.encode(msg).length + 44);
    expect(await open(r, pw.normalize('NFD'))).toBe(msg);
    await expect(open(r, 'wrong')).rejects.toThrow(/Wrong password/);
    await expect(open(r, '')).rejects.toThrow(/encrypted/);
    const tam = { ...r, payload: r.payload.slice() };
    tam.payload[tam.payload.length - 20] ^= 1;
    await expect(open(tam, pw)).rejects.toThrow(/Wrong password/);
  });
  it('PNG round trip through sharp keeps every pixel', async () => {
    const px = cover();
    embed(px, W, H, await buildPayload(msg, ''));
    const back = await rgba(await toPng(px, W, H), false);
    expect(Buffer.from(back.px).equals(Buffer.from(px))).toBe(true);
  });
  it('runs as tools', async () => {
    const ctx = tempCtx();
    const jpg = await sharp(Buffer.from(cover()), { raw: { width: W, height: H, channels: 4 } }).jpeg().toBuffer();
    const h = await call<{ path: string; encrypted: boolean; verified: boolean; capacityBytes: number }>(
      hideTool, { image: 'base64:' + jpg.toString('base64'), message: 'meet at 7', password: 'pw' }, ctx);
    expect(h).toMatchObject({ encrypted: true, verified: true, capacityBytes: 710 });
    expect(h.path.endsWith('image-hidden.png')).toBe(true);
    const r = await call<{ found: boolean; message: string; encrypted: boolean }>(revealTool, { image: h.path, password: 'pw' }, ctx);
    expect(r).toMatchObject({ found: true, encrypted: true, message: 'meet at 7' });
    const none = await call<{ found: boolean; reason: string }>(revealTool, { image: 'base64:' + jpg.toString('base64') }, ctx);
    expect(none.found).toBe(false);
    expect(none.reason).toMatch(/JPEG/);
    // transparent cover is flattened onto white
    const t = await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    const ht = await call<{ path: string; flattened: boolean }>(hideTool, { image: 'base64:' + t.toString('base64'), message: 'x' }, ctx);
    expect(ht.flattened).toBe(true);
    expect((await call<{ message: string }>(revealTool, { image: 'base64:' + readFileSync(ht.path).toString('base64') }, ctx)).message).toBe('x');
    await expect(call(hideTool, { image: 'base64:' + t.toString('base64'), message: 'y'.repeat(400) }, ctx)).rejects.toThrow(/too long/);
  });
});

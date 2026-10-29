import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import tools, { decryptBytes, encryptBytes, isS3ef } from '../../../src/tools/web/everyday/file-encrypt.js';

const [encTool, decTool] = tools;
// The website's own fixed vector (file-encrypt S3_SELFTEST "KNOWN": hello.txt, password "s3eidat").
const KNOWN = 'UzNFRgEBAAAACSfAAEAAAB945B/Eu5hVUNiZeda5lanSjbx8FPCZSgAAAE+JIqS2mmeWXA/TLlgK4ytovkPZva+lj/xz7rXi1VkzRdFxVusaOs0+ZbsoqPzw7iXZmT9RqJ4JcxDCF0PQYI4t+R2YzlCUa6kbWhqacxYXAAAALfg9iM68jrqwY1DjcUToxENrsQN/J4BtsOgzMmxS3fE5VPVi08xgX0lsbU7MLg==';
const ITER = 100000, CH = 4096, pwd = 'pässwörd 🔑';
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const rd = (b: Uint8Array, at: number) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).readUInt32BE(at);

describe('crypto_file_encrypt / crypto_file_decrypt (file-encrypt self-test)', () => {
  it('decrypts the website vector', async () => {
    const dk = await decryptBytes(Buffer.from(KNOWN, 'base64'), 's3eidat');
    expect(dk.name).toBe('hello.txt');
    expect(dk.bytes.toString('utf8')).toBe('Hello from S3eidat Tools ✓\n');
  });
  it('builds byte-identical output to an independent implementation of the format (fixed salt/nonce)', async () => {
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), prefix = Buffer.from('a0a1a2a3a4a5a6a7', 'hex');
    const data = Buffer.from('x'.repeat(2500) + '✓'), name = 'v.txt';
    const mine = await encryptBytes(data, name, pwd, { chunkSize: 1024, iterations: ITER, type: 'text/plain', modified: 1700000000000, fixed: { salt, prefix } });
    // Independent: header, then [u32 len][ct+tag] records with IV = prefix‖u32(i), AAD = header‖u32(i)‖last.
    const header = Buffer.concat([Buffer.from('S3EF'), Buffer.from([1, 1, 0, 0]), u32(ITER), u32(1024), salt, prefix]);
    const key = pbkdf2Sync(Buffer.from(pwd.normalize('NFC'), 'utf8'), salt, ITER, 32, 'sha256');
    const meta = Buffer.from(JSON.stringify({ name, size: data.length, type: 'text/plain', modified: 1700000000000 }));
    const chunks = [meta, data.subarray(0, 1024), data.subarray(1024, 2048), data.subarray(2048)];
    const recs = chunks.map((plain, i) => {
      const c = createCipheriv('aes-256-gcm', key, Buffer.concat([prefix, u32(i)]));
      c.setAAD(Buffer.concat([header, u32(i), Buffer.from([i === chunks.length - 1 ? 1 : 0])]));
      const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
      return Buffer.concat([u32(ct.length), ct]);
    });
    expect(Buffer.from(mine).equals(Buffer.concat([header, ...recs]))).toBe(true);
    const back = await decryptBytes(mine, pwd);
    expect(back.bytes.equals(data)).toBe(true);
    expect([back.name, back.type, back.modified]).toEqual([name, 'text/plain', 1700000000000]);
  });
  it('round trips and detects every kind of damage', async () => {
    const data = randomBytes(10000);
    const raw = await encryptBytes(data, 'dåta/../x.bin', pwd, { chunkSize: CH, iterations: ITER, type: 'application/x-test' });
    expect(isS3ef(raw) && raw[4] === 1 && rd(raw, 8) === ITER && rd(raw, 12) === CH).toBe(true);
    const dataStart = 40 + 4 + rd(raw, 40);
    expect(raw.length).toBe(dataStart + 3 * 20 + 10000);
    const d1 = await decryptBytes(raw, pwd);
    expect(d1.bytes.equals(data)).toBe(true);
    expect(d1.type).toBe('application/x-test');
    expect(d1.name).toBe('dåta_.._x.bin');
    expect((await decryptBytes(raw, pwd.normalize('NFD'))).bytes.equals(data)).toBe(true);
    const raw2 = await encryptBytes(data, 'x', pwd, { chunkSize: CH, iterations: ITER });
    expect(Buffer.from(raw.slice(16, 40)).equals(Buffer.from(raw2.slice(16, 40)))).toBe(false);
    const even = randomBytes(2 * CH);
    expect((await decryptBytes(await encryptBytes(even, 'even', pwd, { chunkSize: CH, iterations: ITER }), pwd)).bytes.equals(even)).toBe(true);
    const dz = await decryptBytes(await encryptBytes(new Uint8Array(0), 'empty.txt', pwd, { chunkSize: CH, iterations: ITER }), pwd);
    expect([dz.size, dz.bytes.length, dz.name]).toEqual([0, 0, 'empty.txt']);
    await expect(decryptBytes(raw, pwd + '!')).rejects.toThrow(/Wrong password/);
    const flipped = raw.slice(); flipped[dataStart + 4 + 100] ^= 1;
    await expect(decryptBytes(flipped, pwd)).rejects.toThrow(/changed or reordered/);
    const hdr = raw.slice(); hdr[33] ^= 1;
    await expect(decryptBytes(hdr, pwd)).rejects.toThrow(/Wrong password/);
    const rec = 4 + CH + 16, r1 = dataStart, r2 = dataStart + rec;
    await expect(decryptBytes(raw.slice(0, r2 + rec), pwd)).rejects.toThrow(/incomplete/);
    await expect(decryptBytes(raw.slice(0, raw.length - 7), pwd)).rejects.toThrow(/incomplete/);
    await expect(decryptBytes(raw.slice(0, dataStart), pwd)).rejects.toThrow(); // metadata only
    const swapped = Buffer.concat([raw.slice(0, r1), raw.slice(r2, r2 + rec), raw.slice(r1, r2), raw.slice(r2 + rec)]);
    await expect(decryptBytes(swapped, pwd)).rejects.toThrow(/changed or reordered/);
    await expect(decryptBytes(Buffer.concat([raw, randomBytes(20)]), pwd)).rejects.toThrow();
    const badIter = raw.slice(); badIter.set(u32(0xffffffff), 8);
    await expect(decryptBytes(badIter, pwd)).rejects.toThrow(/header is damaged/);
    await expect(decryptBytes(Buffer.from('hello world, not encrypted at all, really not'), pwd)).rejects.toThrow(/isn't a File Encrypt/);
  });
  it('runs as tools (restores the stored name)', async () => {
    const ctx = tempCtx();
    const src = join(ctx.outDir, 'notes.txt');
    writeFileSync(src, 'secret notes\n');
    const e = await call<{ path: string; storedName: string; chunks: number }>(encTool, { file: src, password: 'pw', iterations: ITER }, ctx);
    expect(e.path.endsWith('notes.txt.s3enc')).toBe(true);
    expect([e.storedName, e.chunks]).toEqual(['notes.txt', 1]);
    const d = await call<{ path: string; name: string; type: string; modified: string }>(decTool, { file: e.path, password: 'pw', output: join(ctx.outDir, 'out') + '/' }, ctx);
    expect(d.path).toBe(join(ctx.outDir, 'out', 'notes.txt'));
    expect(d.type).toBe('text/plain');
    expect(d.modified).toMatch(/^\d{4}-/);
    expect(readFileSync(d.path, 'utf8')).toBe('secret notes\n');
    await expect(call(decTool, { file: e.path, password: 'nope' }, ctx)).rejects.toThrow(/Wrong password/);
  });
});

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import zip, { unsafeEntry } from '../../src/tools/ai/zip.js';
import { call, tempCtx } from '../helpers.js';

const ctx = tempCtx();
type Out = { action: string; path?: string; bytes?: number; files: number; totalSize: number; entries?: { name: string; size: number }[]; skipped?: { name: string; reason: string }[] };

function makeTree() {
  const root = join(ctx.outDir, 'src-' + Math.random().toString(36).slice(2));
  mkdirSync(join(root, 'site', 'css'), { recursive: true });
  mkdirSync(join(root, 'site', 'empty'));
  writeFileSync(join(root, 'site', 'index.html'), '<h1>Hello</h1>');
  writeFileSync(join(root, 'site', 'css', 'app.css'), 'body{margin:0}'.repeat(100));
  writeFileSync(join(root, 'notes.txt'), 'remember the milk');
  let link = false;
  try { symlinkSync(join(root, 'notes.txt'), join(root, 'site', 'link.txt'), 'file'); link = true; } catch { /* no symlink rights on this machine */ }
  return { root, link };
}

describe('unsafeEntry', () => {
  it('flags zip-slip and absolute names', () => {
    expect(unsafeEntry('a/b.txt')).toBeUndefined();
    expect(unsafeEntry('..\\x')).toMatch(/\.\./);
    expect(unsafeEntry('a/../../x')).toMatch(/\.\./);
    expect(unsafeEntry('/etc/passwd')).toMatch(/absolute/);
    expect(unsafeEntry('C:/Windows/x')).toMatch(/absolute/);
    expect(unsafeEntry('file.txt:stream')).toBeDefined();
  });
});

describe('ai_zip', () => {
  it('creates, lists and extracts a round trip', async () => {
    const { root, link } = makeTree();
    const zipPath = join(ctx.outDir, 'bundle.zip');
    const c = await call<Out>(zip, { action: 'create', files: [join(root, 'site'), join(root, 'notes.txt')], output: zipPath }, ctx);
    expect(c.path).toBe(zipPath);
    expect(c.files).toBe(3);
    expect(c.totalSize).toBe(14 + 1400 + 17);
    expect(readFileSync(zipPath).subarray(0, 2).toString()).toBe('PK');
    if (link) expect(c.skipped).toEqual([{ name: 'site/link.txt', reason: 'symlink' }]);

    const l = await call<Out>(zip, { action: 'list', zip: zipPath }, ctx);
    expect(l.files).toBe(3);
    expect(l.entries!.map((e) => e.name).sort()).toEqual(['notes.txt', 'site/css/app.css', 'site/empty/', 'site/index.html']);
    expect(l.entries!.find((e) => e.name === 'site/css/app.css')!.size).toBe(1400);

    const dest = join(ctx.outDir, 'unpacked');
    const x = await call<Out>(zip, { action: 'extract', zip: zipPath, output: dest }, ctx);
    expect(x.files).toBe(3);
    expect(readFileSync(join(dest, 'site', 'index.html'), 'utf8')).toBe('<h1>Hello</h1>');
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toBe('remember the milk');
    expect(existsSync(join(dest, 'site', 'empty'))).toBe(true);

    // Second extract keeps existing files unless overwrite is on.
    writeFileSync(join(dest, 'notes.txt'), 'changed');
    const again = await call<Out>(zip, { action: 'extract', zip: zipPath, output: dest }, ctx);
    expect(again.files).toBe(0);
    expect(again.skipped).toHaveLength(3);
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toBe('changed');
    await call(zip, { action: 'extract', zip: zipPath, output: dest, overwrite: true }, ctx);
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toBe('remember the milk');
  });

  it('refuses zip-slip entries and writes nothing', async () => {
    for (const bad of ['../evil.txt', 'ok/../../evil.txt', '/abs.txt', 'C:/evil.txt']) {
      const data = zipSync({ 'good.txt': strToU8('fine'), [bad]: strToU8('pwned') });
      const dest = join(ctx.outDir, 'slip-' + Math.random().toString(36).slice(2));
      await expect(call(zip, { action: 'extract', zip: 'base64:' + Buffer.from(data).toString('base64'), output: dest }, ctx)).rejects.toThrow(/unsafe path/);
      expect(existsSync(dest) ? readdirSync(dest) : []).toEqual([]);
    }
    expect(existsSync(join(ctx.outDir, '..', 'evil.txt'))).toBe(false);
  });

  it('enforces the size and file-count caps', async () => {
    const data = zipSync({ 'zeros.bin': new Uint8Array(3 * 1024 * 1024), 'a.txt': strToU8('a'), 'b.txt': strToU8('b') });
    const b64 = 'base64:' + Buffer.from(data).toString('base64');
    expect(data.length).toBeLessThan(20000);
    await expect(call(zip, { action: 'extract', zip: b64, maxTotalMB: 2 }, ctx)).rejects.toThrow(/limit is 2 MB/);
    await expect(call(zip, { action: 'extract', zip: b64, maxFiles: 2 }, ctx)).rejects.toThrow(/limit is 2/);
    const r = await call<Out>(zip, { action: 'list', zip: b64 }, ctx);
    expect([r.files, r.totalSize]).toEqual([3, 3 * 1024 * 1024 + 2]);
  });
});

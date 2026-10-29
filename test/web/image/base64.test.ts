import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import tools, { b64ToBytes, bytesToB64, parseInput, sizeWarning, sniff, svgDataUri } from '../../../src/tools/web/image/image-to-base64.js';
import { solid } from './fixtures.js';

const [toB64, fromB64] = tools;
const ctx = tempCtx();
const enc = new TextEncoder();
const dec = new TextDecoder();
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('image-to-base64 self-test', () => {
  it('base64 round trips and validation', () => {
    expect(bytesToB64(enc.encode('Man'))).toBe('TWFu');
    expect(bytesToB64(enc.encode('Ma'))).toBe('TWE=');
    expect(bytesToB64(new Uint8Array(0))).toBe('');
    expect(dec.decode(b64ToBytes('TWFu'))).toBe('Man');
    expect(dec.decode(b64ToBytes('TWE'))).toBe('Ma');
    expect(bytesToB64(b64ToBytes('-_8'))).toBe('+/8=');
    expect(bytesToB64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
    for (const bad of ['abc$', 'A', 'data:image/png;base64,***']) expect(() => parseInput(bad)).toThrow();
  });
  it('parses CSS, <img>, raw and URL-encoded SVG; sniffs types', () => {
    const css = parseInput('background: url("data:image/png;base64,' + PNG1 + '");')!;
    const tag = parseInput('<img src="data:image/png;base64,' + PNG1 + '" alt="">')!;
    const raw = parseInput(PNG1.replace(/(.{20})/g, '$1\n'))!;
    const svgp = parseInput("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%2F%3E")!;
    expect([css.mime, css.bytes.length, tag.bytes.length, raw.mime, raw.declared]).toEqual(['image/png', 70, 70, 'image/png', false]);
    expect(dec.decode(svgp.bytes).indexOf('<svg')).toBe(0);
    expect(sniff(svgp.bytes)).toBe('image/svg+xml');
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniff(enc.encode('GIF89a'))).toBe('image/gif');
    expect(sniff(enc.encode('<?xml version="1.0"?>\n<svg xmlns="x"/>'))).toBe('image/svg+xml');
    expect(sniff(enc.encode('hello'))).toBe('application/octet-stream');
    expect(svgDataUri('<svg a="1">\n  #é</svg>')).toBe('data:image/svg+xml,%3Csvg a=%221%22%3E %23%C3%A9%3C/svg%3E');
    expect(sizeWarning(20000).level).toBe('warn');
  });
});

describe('image_to_base64 / image_from_base64', () => {
  it('encodes a PNG as data URI, CSS and HTML', async () => {
    const png = await solid(4, 3, '#ff0000');
    const r = await call<{ text: string; mimeType: string; width: number; height: number; warning: { level: string }; overheadPercent: number }>(
      toB64,
      { image: 'base64:' + png.toString('base64') },
      ctx,
    );
    expect(r.text).toBe('data:image/png;base64,' + png.toString('base64'));
    expect([r.mimeType, r.width, r.height, r.warning.level]).toEqual(['image/png', 4, 3, 'ok']);
    expect(r.overheadPercent).toBeGreaterThan(30);
    const h = await call<{ text: string }>(toB64, { image: 'base64:' + png.toString('base64'), as: 'html' }, ctx);
    expect(h.text).toMatch(/^<img src="data:image\/png;base64,[^"]+" width="4" height="3" alt="image">$/);
    const big = await call<{ text?: string; path?: string }>(toB64, { image: 'base64:' + png.toString('base64'), as: 'css', maxChars: 100 }, ctx);
    expect(big.text).toBeUndefined();
    expect(readFileSync(big.path!, 'utf8')).toMatch(/^background-image: url\("data:image\/png;base64,/);
  });
  it('decodes a CSS rule to decoded.png (1×1, valid)', async () => {
    const r = await call<{ path: string; mimeType: string; width: number; height: number; status: string }>(fromB64, { text: `.x { background: url("data:image/png;base64,${PNG1}"); }` }, ctx);
    expect(r.path.endsWith('decoded.png')).toBe(true);
    expect([r.mimeType, r.width, r.height, r.status]).toEqual(['image/png', 1, 1, 'Valid image']);
    const w = await call<{ status: string; detectedMimeType: string }>(fromB64, { text: 'data:image/jpeg;base64,' + PNG1 }, ctx);
    expect(w.status).toBe('Decoded, but the bytes look like image/png');
  });
});

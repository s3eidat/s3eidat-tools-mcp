import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import identify, { guessEncoding } from '../../src/tools/ai/file-identify.js';
import { call, samplePdf, tempCtx } from '../helpers.js';

const ctx = tempCtx();
type Out = { name: string; size: number; sha256: string; extension: string | null; detected: { ext: string; mime: string; source: string } | null; isText: boolean; encoding: string | null; mismatch: boolean; note: string };

describe('guessEncoding', () => {
  it('knows BOMs, UTF-8, ASCII, UTF-16 and binary', () => {
    expect(guessEncoding(Buffer.from('hello\n'))).toBe('ascii');
    expect(guessEncoding(Buffer.from('مرحبا café'))).toBe('utf-8');
    expect(guessEncoding(Buffer.from('﻿hi'))).toBe('utf-8-bom');
    expect(guessEncoding(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]))).toBe('utf-16le-bom');
    expect(guessEncoding(Buffer.from('plain old text', 'utf16le'))).toBe('utf-16le');
    expect(guessEncoding(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]))).toMatch(/^8-bit/);
    expect(guessEncoding(Buffer.from([0, 1, 2, 3, 0, 0, 255, 254, 7, 0, 8]))).toBe('binary');
  });
});

describe('ai_file_identify', () => {
  it('spots a PDF renamed to .jpg, with size and sha256', async () => {
    const pdf = await samplePdf(1);
    const p = join(ctx.outDir, 'holiday.jpg');
    writeFileSync(p, pdf);
    const r = await call<Out>(identify, { file: p }, ctx);
    expect(r.detected).toEqual({ ext: 'pdf', mime: 'application/pdf', source: 'magic' });
    expect(r.extension).toBe('jpg');
    expect(r.mismatch).toBe(true);
    expect(r.size).toBe(pdf.length);
    expect(r.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(r.note).toContain('PDF');
  });

  it('matches equivalent extensions (jpeg vs jpg) and identifies PNG from base64', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const r = await call<Out>(identify, { file: 'base64:' + png, name: 'x.png' }, ctx);
    expect(r).toMatchObject({ detected: { ext: 'png', mime: 'image/png' }, mismatch: false, isText: false, encoding: null });
    const { default: sharp } = await import('sharp');
    const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } }).jpeg().toBuffer();
    const p = join(ctx.outDir, 'photo.jpeg');
    writeFileSync(p, jpg);
    expect(await call<Out>(identify, { file: p }, ctx)).toMatchObject({ detected: { ext: 'jpg' }, mismatch: false });
  });

  it('reports text files with encoding and kind', async () => {
    const p = join(ctx.outDir, 'data.json');
    writeFileSync(p, '{"name":"Zoë","n":[1,2]}');
    const r = await call<Out>(identify, { file: p }, ctx);
    expect(r).toMatchObject({ isText: true, encoding: 'utf-8', detected: { ext: 'json', source: 'text' }, mismatch: false });
    const fake = join(ctx.outDir, 'report.pdf');
    writeFileSync(fake, 'just some notes\r\n');
    expect(await call<Out>(identify, { file: fake }, ctx)).toMatchObject({ isText: true, encoding: 'ascii', mismatch: true });
    const svg = join(ctx.outDir, 'icon.svg');
    writeFileSync(svg, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await call<Out>(identify, { file: svg }, ctx)).toMatchObject({ detected: { ext: 'svg' }, mismatch: false });
  });
});

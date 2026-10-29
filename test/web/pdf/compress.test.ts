import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb, type PDFPage, type PDFDict, type PDFRawStream } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import compressTool, { scaleFor, verdict } from '../../../src/tools/web/pdf/pdf-compress.js';
import { closeJs, renderToCanvas } from '../../../src/tools/web/pdf/_common.js';
import { loadPdfJs } from '../../../src/util/pdf.js';
import { call, tempCtx } from '../../helpers.js';
import { b64, load } from './_pdf.js';
import { readFileSync } from 'node:fs';

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function xobj(page: PDFPage) { // first image XObject on a page: {filter, w, h}
  const xo = page.node.Resources()!.lookup(PDFName.of('XObject')) as PDFDict, key = xo.keys()[0], s = xo.lookup(key) as PDFRawStream;
  return { filter: String(s.dict.get(PDFName.of('Filter'))), w: (s.dict.get(PDFName.of('Width')) as PDFNumber).asNumber(), h: (s.dict.get(PDFName.of('Height')) as PDFNumber).asNumber() };
}

async function pixel(path: string, page: number, x: number, y: number) {
  const js = await loadPdfJs(readFileSync(path)), c = await renderToCanvas(await js.getPage(page), 1);
  const px = Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
  await closeJs(js);
  return px;
}

describe('pdf_compress (pdf-compress self-test)', () => {
  it('rebuilds pages as JPEGs at the chosen DPI', async () => {
    const ctx = tempCtx();
    const d = await PDFDocument.create(), noise = createCanvas(500, 500), nx = noise.getContext('2d'), im = nx.createImageData(500, 500), r = rng(1);
    for (let i = 0; i < im.data.length; i += 4) { im.data[i] = r() * 255; im.data[i + 1] = r() * 255; im.data[i + 2] = r() * 255; im.data[i + 3] = 255; }
    nx.putImageData(im, 0, 0);
    d.addPage([595.28, 841.89]).drawImage(await d.embedPng(await noise.encode('png')), { x: 0, y: 0, width: 595.28, height: 841.89 });
    d.addPage([300, 500]).drawRectangle({ x: 0, y: 0, width: 300, height: 500, color: rgb(1, 0, 0) });
    d.addPage([400, 300]).setRotation(degrees(90));
    const bytes = await d.save();

    const res = await call<{ path: string; before: number; after: number; verdict: string; pages: number }>(compressTool, { file: b64(bytes), dpi: 72, quality: 60 }, ctx);
    const o = await load(res.path), pages = o.getPages();
    expect(res.pages).toBe(3);
    expect(pages.map((p) => Math.round(p.getWidth()) + 'x' + Math.round(p.getHeight())).join()).toBe('595x842,300x500,300x400');
    expect(pages.every((p) => p.getRotation().angle === 0)).toBe(true);
    expect(xobj(pages[0])).toEqual({ filter: '/DCTDecode', w: 595, h: 842 });
    expect(xobj(pages[1])).toMatchObject({ w: 300, h: 500 });
    expect(res.after).toBeLessThan(bytes.length / 2);
    expect(res.verdict).toBe('smaller');
    const px = await pixel(res.path, 2, 150, 250);
    expect(px[0]).toBeGreaterThan(200);
    expect(px[1]).toBeLessThan(60);

    const hi = await call<{ path: string }>(compressTool, { file: b64(bytes), dpi: 150, quality: 80, grayscale: true }, ctx);
    expect(xobj((await load(hi.path)).getPage(1))).toMatchObject({ w: 625, h: 1042 });
    const gp = await pixel(hi.path, 2, 150, 250);
    expect(Math.abs(gp[0] - gp[1])).toBeLessThan(8);
    expect(Math.abs(gp[1] - gp[2])).toBeLessThan(8);
  });
  it('detects a bigger result, and keeps the pixel budget', async () => {
    const t = await PDFDocument.create();
    t.addPage([300, 300]).drawText('tiny', { x: 20, y: 20 });
    const res = await call<{ verdict: string }>(compressTool, { file: b64(await t.save()), preset: 'high' }, tempCtx());
    expect(res.verdict).toBe('bigger');
    expect([verdict(1000, 400), verdict(1000, 980)]).toEqual(['smaller', 'same']);
    expect(Math.abs(scaleFor({ width: 595, height: 842 }, 300) - 300 / 72)).toBeLessThan(1e-9);
    expect(scaleFor({ width: 5000, height: 5000 }, 300) * 5000).toBeLessThanOrEqual(5001);
  });
});

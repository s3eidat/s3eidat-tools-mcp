import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import orgTools, { initial, insertBlank, moveBy, moveTo, remove, rotate, saveDoc } from '../../../src/tools/web/pdf/pdf-organizer.js';
import { call, tempCtx } from '../../helpers.js';
import { b64, load, widthsPdf } from './_pdf.js';

const [organize, rotateTool] = orgTools;

describe('pdf_organize / pdf_rotate (pdf-organizer self-test)', () => {
  it('page model matches the website', async () => {
    const src = await PDFDocument.load(await widthsPdf([100, 200, 300], 400));
    let items = initial(src);
    items = moveTo(items, 3, 0);
    items = rotate(items, new Set([3]), 90);
    items = remove(items, new Set([2]));
    items = insertBlank(items, 3, 99);
    expect(moveBy(initial(src), new Set([1]), 1).map((x) => x.src).join()).toBe('1,0,2');
    const out = await PDFDocument.load(await (await saveDoc(src, items)).save());
    expect(out.getPages().map((p) => Math.round(p.getWidth())).join()).toBe('300,400,100');
    expect(out.getPages().map((p) => p.getRotation().angle).join()).toBe('90,0,0');
    expect(items.map((x) => x.src).join()).toBe('2,,0');
  });
  it('organizes from a page list', async () => {
    const ctx = tempCtx();
    const r = await call<{ path: string; order: unknown[] }>(organize, { file: b64(await widthsPdf([100, 200, 300], 400)), pages: '3, 1-2, blank, 2', rotate: [{ pages: '1', angle: 90 }] }, ctx);
    expect(r.order).toEqual([3, 1, 2, 'blank', 2]);
    const d = await load(r.path);
    expect(d.getPages().map((p) => Math.round(p.getWidth())).join()).toBe('300,100,200,200,200');
    expect(d.getPages().map((p) => p.getRotation().angle).join()).toBe('90,0,0,0,0');
  });
  it('rotates selected pages on top of existing rotation', async () => {
    const ctx = tempCtx();
    const d = await PDFDocument.create();
    d.addPage([100, 200]); d.addPage([100, 200]).setRotation(degrees(90)); d.addPage([100, 200]);
    const r = await call<{ path: string; rotations: number[] }>(rotateTool, { file: b64(await d.save()), angle: 90, pages: '2-3' }, ctx);
    expect(r.rotations).toEqual([0, 180, 90]);
    expect((await load(r.path)).getPages().map((p) => p.getRotation().angle)).toEqual([0, 180, 90]);
  });
});

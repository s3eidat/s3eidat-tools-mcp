import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import info, { paperName } from '../../../src/tools/web/pdf/pdf-info.js';
import { call, tempCtx } from '../../helpers.js';
import { b64 } from './_pdf.js';

describe('pdf_info', () => {
  it('summarises pages, sizes, rotation, forms and text layers', async () => {
    const d = await PDFDocument.create(), font = await d.embedFont(StandardFonts.Helvetica);
    d.setTitle('Report'); d.setAuthor('Sara');
    d.addPage([595.28, 841.89]).drawText('Hello', { x: 50, y: 700, font });
    d.addPage([595.28, 841.89]);
    d.addPage([612, 792]).setRotation(degrees(90));
    d.getForm().createTextField('name').addToPage(d.getPage(0), { x: 50, y: 600, width: 100, height: 20 });
    const r = await call<Record<string, unknown>>(info, { file: b64(await d.save()) }, tempCtx());
    expect(r).toMatchObject({
      pages: 3, encrypted: false, formFields: 1, title: 'Report', author: 'Sara', pagesWithoutText: [2, 3], textChecked: 3,
      rotatedPages: [{ page: 3, rotation: 90 }],
    });
    expect(r.sizes).toEqual([
      { width: 595.28, height: 841.89, widthMm: 210, heightMm: 297, paper: 'A4 portrait', pages: '1-2' },
      { width: 792, height: 612, widthMm: 279.4, heightMm: 215.9, paper: 'Letter landscape', pages: '3' },
    ]);
    expect(paperName(100, 100)).toBeNull();
  });
  it('reports encryption without failing', async () => {
    const d = await PDFDocument.create(); d.addPage([200, 200]);
    const s = Buffer.from(await d.save({ useObjectStreams: false })).toString('latin1').replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>');
    const r = await call<Record<string, unknown>>(info, { file: b64(Buffer.from(s, 'latin1')) }, tempCtx());
    expect(r).toMatchObject({ pages: 1, encrypted: true, pagesWithoutText: null });
  });
});

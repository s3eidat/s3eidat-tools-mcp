import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import metaTools, { infoDict, readMeta, tzOf } from '../../../src/tools/web/pdf/pdf-metadata.js';
import { call, tempCtx } from '../../helpers.js';
import { b64 } from './_pdf.js';

const [read, write] = metaTools;
const N = (k: string) => PDFName.of(k);

async function samplePdf(withOrphan: boolean) {
  const d = await PDFDocument.create({ updateMetadata: false });
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595.28, 841.89]).drawText('Q3 salary review', { x: 56, y: 760, size: 24, font: f });
  const info = infoDict(d);
  d.setTitle('Q3 salary review (DRAFT v4)'); d.setAuthor('Sara Haddad'); d.setSubject('Compensation');
  d.setCreator('Microsoft® Word for Microsoft 365'); d.setProducer('Microsoft® Word for Microsoft 365');
  info.set(N('CreationDate'), PDFString.of("D:20260314093012+03'00'")); info.set(N('ModDate'), PDFString.of("D:20260921171544+03'00'"));
  info.set(N('Company'), PDFHexString.fromText('Nour Studio LLC')); info.set(N('SourceModified'), PDFString.of('D:20260921171501'));
  const xml = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description><dc:creator><rdf:Seq><rdf:li>Sara Haddad</rdf:li></rdf:Seq></dc:creator>' +
    '<xmpMM:DocumentID>uuid:5f1c2a9e-0d1b-4a5e-9c61-2f7d3b8e4a10</xmpMM:DocumentID><xmpMM:History><rdf:Seq><rdf:li>saved 2026-09-21 by Sara Haddad</rdf:li></rdf:Seq></xmpMM:History>' +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  d.catalog.set(N('Metadata'), d.context.register(d.context.stream(xml, { Type: 'Metadata', Subtype: 'XML' })));
  if (withOrphan) d.context.register(PDFString.of('old revision by Sara Haddad'));
  d.context.trailerInfo.ID = d.context.obj([PDFHexString.of('5F1C2A9E0D1B4A5E'), PDFHexString.of('5F1C2A9E0D1B4A5E')]);
  return Buffer.from(await d.save({ useObjectStreams: false }));
}
const latin = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('pdf_metadata_read / pdf_metadata_write (pdf-metadata self-test)', () => {
  it('reads info fields, dates, custom fields, XMP and ID', async () => {
    const bytes = await samplePdf(true);
    const m = readMeta(await PDFDocument.load(bytes, { updateMetadata: false }));
    expect(m.fields.Author).toBe('Sara Haddad');
    expect(m.dates.CreationDate.iso).toBe('2026-03-14T06:30:12.000Z');
    expect(tzOf(m.dates.CreationDate.raw)).toBe('UTC+03:00');
    expect(m.custom).toEqual([['Company', 'Nour Studio LLC'], ['SourceModified', 'D:20260921171501']]);
    expect(m.xmp!.size).toBeGreaterThan(300);
    expect(latin(bytes)).toContain('Sara Haddad');
    const r = await call<{ fields: Record<string, string>; xmp: { creator: string; editHistory: boolean }; documentId: boolean; xml: string }>(read, { file: b64(bytes), includeXmp: true }, tempCtx());
    expect(r.fields.Creator).toContain('Word');
    expect(r.xmp).toMatchObject({ creator: 'Sara Haddad', editHistory: true });
    expect(r.documentId).toBe(true);
    expect(r.xml).toContain('xmpMM:History');
  });
  it('edits only what changed', async () => {
    const r = await call<{ path: string }>(write, { file: b64(await samplePdf(false)), title: 'Final review', custom: { SourceModified: null } }, tempCtx());
    const m = readMeta(await PDFDocument.load(readFileSync(r.path), { updateMetadata: false }));
    expect(m.fields.Title).toBe('Final review');
    expect(m.fields.Author).toBe('Sara Haddad');
    expect(m.custom.map((c) => c[0])).toEqual(['Company']);
    expect(m.dates.CreationDate.raw).toBe("D:20260314093012+03'00'");
    expect(m.xmp).toBeTruthy();
    expect(m.id).toBe(true);
  });
  it('strips every trace', async () => {
    const r = await call<{ path: string; removedObjects: number }>(write, { file: b64(await samplePdf(true)), strip: true }, tempCtx());
    expect(r.path).toMatch(/-clean\.pdf$/);
    expect(r.removedObjects).toBeGreaterThanOrEqual(2);
    const c = await PDFDocument.load(readFileSync(r.path), { updateMetadata: false });
    const s = latin(await c.save({ useObjectStreams: false }));
    for (const t of ['Sara Haddad', 'Nour Studio', 'Word', '5F1C2A9E', 'salary review (DRAFT']) expect(s).not.toContain(t);
    const m = readMeta(c);
    expect([m.fields.Author, m.fields.Title, m.fields.Producer, m.dates.CreationDate.date, m.custom.length, m.xmp, m.id]).toEqual(['', '', '', null, 0, null, false]);
    expect(m.pages).toBe(1);
    expect(c.getPage(0).getSize().width).toBe(595.28);
  });
});

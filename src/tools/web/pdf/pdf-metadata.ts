import { inflateSync } from 'node:zlib';
import { z } from 'zod';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, type PDFObject } from 'pdf-lib';
import { defineTool, webUrl } from '../../../registry.js';
import { baseName, fileInput, infoDict, openPdf, outputPath, pdfFileOutput, returnBase64, savePdf } from './_common.js';

// Ported from https://github.com/s3eidat/pdf-metadata (app.js): same fields, edit rules and "strip" clean-up
// (info dict, XMP, page-level PieceInfo, document ID, then drop every unreachable object).
const STD = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'] as const;
const DATES = ['CreationDate', 'ModDate'] as const;
const KNOWN: string[] = [...STD, ...DATES, 'Trapped'];
const N = (k: string) => PDFName.of(k);
export { infoDict };

function text(v: PDFObject | undefined): string {
  if (!v) return '';
  try { if ('decodeText' in v && typeof (v as PDFString).decodeText === 'function') return (v as PDFString).decodeText(); } catch { /* fall through */ }
  const s = String(v);
  return s.charAt(0) === '/' ? s.slice(1) : s;
}

/** "D:20240303140200+03'00'" -> "UTC+03:00" */
export function tzOf(raw: string) {
  const m = /^D?:?\d{14}([+\-Z])(\d{2})?'?(\d{2})?/.exec(String(raw || '').trim());
  if (!m) return '';
  if (m[1] === 'Z') return 'UTC';
  return 'UTC' + m[1] + (m[2] || '00') + ':' + (m[3] || '00');
}

export function readMeta(doc: PDFDocument) {
  const info = infoDict(doc);
  const fields = {} as Record<(typeof STD)[number], string>;
  STD.forEach((k) => { fields[k] = text(info.lookup(N(k))).trim(); });
  const dates = {} as Record<(typeof DATES)[number], { raw: string; date: Date | null; iso: string | null; timezone: string }>;
  DATES.forEach((k) => {
    const v = info.lookup(N(k)), raw = text(v);
    let d: Date | null = null;
    if (v) { try { d = (v as PDFString).decodeDate(); } catch { d = null; } }
    if (d && isNaN(+d)) d = null;
    dates[k] = { raw, date: d, iso: d ? d.toISOString() : null, timezone: tzOf(raw) };
  });
  const custom: [string, string][] = [];
  info.keys().forEach((k) => { const key = k.decodeText ? k.decodeText() : String(k).slice(1); if (!KNOWN.includes(key)) custom.push([key, text(info.lookup(k))]); });
  const x = doc.catalog.lookup(N('Metadata'));
  const xmp = x instanceof PDFStream ? { stream: x, size: x.getContents().length } : null;
  const pageXmp = doc.getPages().filter((p) => p.node.get(N('Metadata')) || p.node.get(N('PieceInfo'))).length + (doc.catalog.get(N('PieceInfo')) ? 1 : 0);
  return { fields, dates, custom, trapped: !!info.get(N('Trapped')), xmp, pageXmp, id: !!doc.context.trailerInfo.ID, pages: doc.getPageCount() };
}
export type Meta = ReturnType<typeof readMeta>;

/** Decoded XMP XML, or null when it uses a filter we can't undo. */
export function xmpText(stream: PDFStream): string | null {
  const raw = stream.getContents(), f = String(stream.dict.get(N('Filter')) ?? '');
  if (!f) return Buffer.from(raw).toString('utf8');
  if (/^\/?FlateDecode$/.test(f) || /^\[\s*\/FlateDecode\s*\]$/.test(f)) { try { return inflateSync(raw).toString('utf8'); } catch { return null; } }
  return null;
}

/** Keep only objects reachable from the trailer: drops orphaned old Info dicts, XMP streams, earlier revisions. */
export function gc(doc: PDFDocument) {
  const ctx = doc.context, seen = new Set<string>(), stack: unknown[] = [], t = ctx.trailerInfo;
  let removed = 0;
  [t.Root, t.Info, t.Encrypt].forEach((x) => { if (x) stack.push(x); });
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) { if (seen.has(o.tag)) continue; seen.add(o.tag); const v = ctx.lookup(o); if (v) stack.push(v); }
    else if (o instanceof PDFDict) o.entries().forEach((e) => stack.push(e[1]));
    else if (o instanceof PDFArray) o.asArray().forEach((e) => stack.push(e));
    else if (o instanceof PDFStream) stack.push(o.dict);
  }
  ctx.enumerateIndirectObjects().forEach((e) => { if (!seen.has(e[0].tag)) { ctx.delete(e[0]); removed++; } });
  return removed;
}

export interface MetaEdit {
  strip?: boolean;
  fields?: Partial<Record<(typeof STD)[number], string>>;
  dates?: Partial<Record<(typeof DATES)[number], string>>;
  custom?: Record<string, string | null>;
  rmXmp?: boolean;
  rmId?: boolean;
}

/** Apply edits; only what changed is touched, so untouched values keep their exact original bytes. */
export function apply(doc: PDFDocument, orig: Meta, next: MetaEdit) {
  const info = infoDict(doc), cat = doc.catalog;
  if (next.strip) {
    info.keys().forEach((k) => info.delete(k));
  } else {
    STD.forEach((k) => {
      const nv = next.fields?.[k];
      if (nv == null) return;
      const v = String(nv).trim();
      if (v === orig.fields[k]) return;
      if (v) info.set(N(k), PDFHexString.fromText(v)); else info.delete(N(k));
    });
    DATES.forEach((k) => {
      const v = next.dates?.[k];
      if (v == null) return;
      const d = new Date(v);
      if (v && !isNaN(+d)) info.set(N(k), PDFString.fromDate(d)); else info.delete(N(k));
    });
    Object.entries(next.custom ?? {}).forEach(([k, nv]) => {
      if (KNOWN.includes(k)) return;
      const cur = orig.custom.find((c) => c[0] === k);
      if (nv === null) info.delete(N(k));
      else if (!cur || nv !== cur[1]) info.set(N(k), PDFHexString.fromText(nv));
    });
  }
  if (next.strip || next.rmXmp) {
    ['Metadata', 'PieceInfo'].forEach((k) => { cat.delete(N(k)); doc.getPages().forEach((p) => p.node.delete(N(k))); });
  }
  if (next.strip || next.rmId) doc.context.trailerInfo.ID = undefined;
  return gc(doc);
}

function summary(m: Meta, bytes: Uint8Array, xml: string | null) {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  const who = xml ? /<dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]{1,80})</.exec(xml) : null;
  return {
    pages: m.pages,
    pdfVersion: (/%PDF-(\d\.\d)/.exec(head) || [])[1] || '?',
    fileBytes: bytes.length,
    fields: m.fields,
    dates: Object.fromEntries(DATES.map((k) => [k, { raw: m.dates[k].raw, iso: m.dates[k].iso, timezone: m.dates[k].timezone }])),
    custom: Object.fromEntries(m.custom),
    xmp: m.xmp ? { bytes: m.xmp.size, editHistory: !!xml && /History/.test(xml), versionIds: !!xml && /DocumentID|InstanceID/.test(xml), creator: who ? who[1] : null } : null,
    pageLevelMetadata: m.pageXmp,
    documentId: m.id,
  };
}

const stdField = (what: string) => z.string().optional().describe(`${what}. "" removes it; omit to keep it.`);
const readOut = z.object({
  pages: z.number(), pdfVersion: z.string(), fileBytes: z.number(),
  fields: z.record(z.string(), z.string()).describe('Title, Author, Subject, Keywords, Creator, Producer ("" when empty).'),
  dates: z.record(z.string(), z.object({ raw: z.string(), iso: z.string().nullable(), timezone: z.string() })).describe('CreationDate and ModDate.'),
  custom: z.record(z.string(), z.string()).describe('Non-standard info fields (Company, SourceModified…).'),
  xmp: z.object({ bytes: z.number(), editHistory: z.boolean(), versionIds: z.boolean(), creator: z.string().nullable() }).nullable(),
  pageLevelMetadata: z.number().describe('Pages (plus the catalog) carrying their own XMP/PieceInfo.'),
  documentId: z.boolean().describe('Whether the trailer has a document ID (a fingerprint linking copies).'),
  xml: z.string().nullable().optional(),
});

const read = defineTool({
  name: 'pdf_metadata_read',
  title: 'Read PDF metadata',
  webSlug: 'pdf-metadata',
  description:
    'Show what a PDF reveals about itself: Title, Author, Subject, Keywords, Creator, Producer, creation/modification dates ' +
    '(with time zone), custom info fields, XMP metadata (size, edit history, creator) and the document ID. Optionally ' +
    `returns the XMP XML. Web version: ${webUrl('pdf-metadata')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    includeXmp: z.boolean().optional().default(false).describe('Also return the decoded XMP XML.'),
  }),
  outputSchema: readOut,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'contract.pdf' } }],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    const m = readMeta(doc), xml = m.xmp ? xmpText(m.xmp.stream) : null;
    return { ...summary(m, f.bytes, xml), ...(input.includeXmp ? { xml } : {}) };
  },
});

const write = defineTool({
  name: 'pdf_metadata_write',
  title: 'Edit or strip PDF metadata',
  webSlug: 'pdf-metadata',
  description:
    'Change PDF info fields (title, author, subject, keywords, creator, producer, dates, custom fields) or strip all ' +
    'metadata: info fields, XMP, page-level data and the document ID, and drop unreachable leftovers from earlier edits so ' +
    `no trace stays in the bytes. Untouched values keep their exact original form. Web version: ${webUrl('pdf-metadata')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    strip: z.boolean().optional().default(false).describe('Remove ALL metadata (other edits are ignored).'),
    title: stdField('Title'),
    author: stdField('Author'),
    subject: stdField('Subject'),
    keywords: stdField('Keywords'),
    creator: stdField('Creator (the app that made it)'),
    producer: stdField('Producer (the PDF engine)'),
    creationDate: stdField('Creation date as ISO 8601, e.g. "2026-03-14T09:30:00+03:00"'),
    modDate: stdField('Modification date as ISO 8601'),
    custom: z.record(z.string(), z.string().nullable()).optional().describe('Custom info fields to set; null removes one. E.g. {"Company": null}.'),
    removeXmp: z.boolean().optional().default(false).describe('Remove the XMP metadata stream (and page-level XMP/PieceInfo).'),
    removeDocumentId: z.boolean().optional().default(false).describe('Remove the document ID from the trailer.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...pdfFileOutput, removedObjects: z.number().describe('Unreachable objects dropped.'), metadata: readOut }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'report.pdf', title: 'Final report', author: 'Sara Haddad' } },
    { input: { file: 'cv.pdf', strip: true }, note: 'writes cv-clean.pdf with no metadata' },
  ],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    const orig = readMeta(doc);
    const removed = apply(doc, orig, input.strip ? { strip: true } : {
      fields: { Title: input.title, Author: input.author, Subject: input.subject, Keywords: input.keywords, Creator: input.creator, Producer: input.producer },
      dates: { CreationDate: input.creationDate, ModDate: input.modDate },
      custom: input.custom, rmXmp: input.removeXmp, rmId: input.removeDocumentId,
    });
    const bytes = await doc.save();
    const w = await savePdf(bytes, { output: input.output, defaultName: baseName(f) + (input.strip ? '-clean.pdf' : '-edited.pdf'), returnBase64: input.returnBase64 }, ctx);
    const after = await PDFDocument.load(bytes, { updateMetadata: false }), m = readMeta(after);
    return { ...w, removedObjects: removed, metadata: summary(m, bytes, m.xmp ? xmpText(m.xmp.stream) : null) };
  },
});

export default [read, write];

import { z } from 'zod';
import { PDFDocument, degrees } from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { baseName, fileInput, norm, openPdf, outputPath, pagesSpec, parseRangeGroups, parseRangeSet, pdfFileOutput, returnBase64, savePdf } from './_common.js';

// Ported from https://github.com/s3eidat/pdf-organizer (app.js): the same page model and save step.
export interface Item { id: number; src: number | null; rot: number; srot: number; w: number; h: number }

export function initial(doc: PDFDocument): Item[] {
  return doc.getPages().map((p, i) => {
    const srot = norm(p.getRotation().angle), s = p.getSize(), side = srot % 180 !== 0;
    return { id: i + 1, src: i, rot: 0, srot, w: side ? s.height : s.width, h: side ? s.width : s.height };
  });
}
const clone = (items: Item[]) => items.map((x) => ({ ...x }));
export function rotate(items: Item[], ids: Set<number>, delta: number) {
  return items.map((x) => (ids.has(x.id) ? { ...x, rot: norm(x.rot + delta) } : { ...x }));
}
export function remove(items: Item[], ids: Set<number>) { return items.filter((x) => !ids.has(x.id)).map((x) => ({ ...x })); }
export function moveBy(items: Item[], ids: Set<number>, dir: -1 | 1) {
  const a = clone(items), idx = a.map((x, i) => (ids.has(x.id) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length || (dir < 0 && idx[0] === 0) || (dir > 0 && idx[idx.length - 1] === a.length - 1)) return a;
  (dir < 0 ? idx : idx.reverse()).forEach((i) => { const t = a[i]; a[i] = a[i + dir]; a[i + dir] = t; });
  return a;
}
export function moveTo(items: Item[], id: number, dest: number) {
  const a = clone(items), from = a.findIndex((x) => x.id === id);
  if (from < 0) return a;
  const [it] = a.splice(from, 1);
  a.splice(dest > from ? dest - 1 : dest, 0, it);
  return a;
}
export function insertBlank(items: Item[], afterId: number | null, newId: number) {
  const a = clone(items), at = afterId == null ? a.length - 1 : a.findIndex((x) => x.id === afterId);
  const ref = a[at] || a[0] || { w: 595.28, h: 841.89, rot: 0 };
  const flip = ref.rot % 180 !== 0; // match how the neighbour looks on screen
  a.splice(at + 1, 0, { id: newId, src: null, rot: 0, srot: 0, w: flip ? ref.h : ref.w, h: flip ? ref.w : ref.h });
  return a;
}
export async function saveDoc(src: PDFDocument, items: Item[]) {
  const out = await PDFDocument.create();
  const wanted = items.filter((x) => x.src !== null).map((x) => x.src as number), copied = await out.copyPages(src, wanted);
  let k = 0;
  items.forEach((x) => {
    if (x.src === null) { const p = out.addPage([x.w, x.h]); if (x.rot) p.setRotation(degrees(x.rot)); }
    else { const p = copied[k++]; p.setRotation(degrees((x.srot + x.rot) % 360)); out.addPage(p); }
  });
  out.setProducer('S3eidat Tools PDF Organizer');
  return out;
}

/**
 * The new page list for pdf_organize: "3, 1-2, blank, 2" → pages in that order; pages can repeat, pages not listed are
 * dropped, "blank" inserts an empty page shaped like the page before it.
 */
export function itemsFromList(base: Item[], spec: string) {
  let items: Item[] = [], nextId = base.length + 1;
  for (const raw of spec.split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    if (/^blank$/i.test(part)) {
      if (items.length) items = insertBlank(items, items[items.length - 1].id, nextId++);
      else { const ref = base[0] ?? { w: 595.28, h: 841.89 }; items.push({ id: nextId++, src: null, rot: 0, srot: 0, w: ref.w, h: ref.h }); }
      continue;
    }
    for (const g of parseRangeGroups(part, base.length)) for (const i of g.pages) items.push({ ...base[i], id: nextId++ });
  }
  if (!items.length) throw new ToolError('No pages selected');
  return items;
}

const organize = defineTool({
  name: 'pdf_organize',
  title: 'Organize PDF pages',
  webSlug: 'pdf-organizer',
  description:
    'Rebuild a PDF from a page list: reorder, delete (leave pages out), duplicate (list a page twice) and insert blank pages. ' +
    '"3, 1-2, blank, 5-" puts page 3 first, then 1-2, a blank page (same size as the page before it), then 5 to the end; ' +
    'page 4 is dropped. Optionally rotate pages of the result. Existing page rotation is kept. Web version: ' +
    webUrl('pdf-organizer'),
  inputSchema: z.object({
    file: fileInput('PDF'),
    pages: z.string().min(1).describe('New page order (1-based source pages): e.g. "3, 1-2, blank, 2, 5-". Pages not listed are removed; "blank" adds an empty page.'),
    rotate: z
      .array(z.object({ pages: z.string().describe('Pages of the NEW order, e.g. "1, 3-4".'), angle: z.union([z.literal(90), z.literal(180), z.literal(270), z.literal(-90)]).describe('Clockwise degrees.') }))
      .optional()
      .describe('Optional rotations applied to pages of the new order.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfFileOutput,
    pages: z.number().describe('Pages in the result.'),
    order: z.array(z.union([z.number(), z.literal('blank')])).describe('Source page (1-based) of each output page, or "blank".'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'scan.pdf', pages: '2, 1, 3-', rotate: [{ pages: '3', angle: 90 }] }, note: 'swap the first two pages, turn page 3' }],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    let items = itemsFromList(initial(doc), input.pages);
    for (const r of input.rotate ?? []) {
      const sel = parseRangeSet(r.pages, items.length), ids = new Set(items.filter((_, i) => sel.has(i)).map((x) => x.id));
      items = rotate(items, ids, r.angle);
    }
    const out = await saveDoc(doc, items);
    const w = await savePdf(out, { output: input.output, defaultName: baseName(f) + '-organized.pdf', returnBase64: input.returnBase64 }, ctx);
    return { ...w, pages: items.length, order: items.map((x) => (x.src === null ? ('blank' as const) : x.src + 1)) };
  },
});

const rotateTool = defineTool({
  name: 'pdf_rotate',
  title: 'Rotate PDF pages',
  webSlug: 'pdf-organizer',
  description:
    'Rotate selected pages of a PDF by 90, 180 or 270 degrees clockwise (-90 = counter-clockwise), on top of any rotation ' +
    `they already have. Other pages, links and form fields are left as they are. Web version: ${webUrl('pdf-organizer')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    angle: z.union([z.literal(90), z.literal(180), z.literal(270), z.literal(-90)]).describe('Clockwise degrees: 90, 180, 270, or -90.'),
    pages: pagesSpec('Pages to rotate'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfFileOutput,
    rotated: z.array(z.number()).describe('1-based pages that were rotated.'),
    rotations: z.array(z.number()).describe('Final /Rotate of every page, in degrees.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'scan.pdf', angle: 90, pages: 'even' } }],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    const pages = doc.getPages(), sel = parseRangeSet(input.pages, pages.length);
    for (const i of sel) pages[i].setRotation(degrees(norm(pages[i].getRotation().angle + input.angle)));
    const w = await savePdf(doc, { output: input.output, defaultName: baseName(f) + '-rotated.pdf', returnBase64: input.returnBase64 }, ctx);
    return { ...w, rotated: [...sel].map((i) => i + 1), rotations: pages.map((p) => norm(p.getRotation().angle)) };
  },
});

export default [organize, rotateTool];

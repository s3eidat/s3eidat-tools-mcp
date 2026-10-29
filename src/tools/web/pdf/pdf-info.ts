import { z } from 'zod';
import { PDFDocument, PDFName } from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { readInput } from '../../../util/files.js';
import { isPdf, loadPdfJs } from '../../../util/pdf.js';
import { closeJs, fileInput, infoDict, pageGeom, toRangeText } from './_common.js';

// Quick facts about a PDF so an agent can plan the next step (split? compress? OCR? fill?). Not a website tool.
const PAPERS: [string, number, number][] = [
  ['A3', 841.89, 1190.55], ['A4', 595.28, 841.89], ['A5', 419.53, 595.28], ['Letter', 612, 792], ['Legal', 612, 1008], ['Tabloid', 792, 1224],
];
export function paperName(w: number, h: number) {
  const a = Math.min(w, h), b = Math.max(w, h);
  const p = PAPERS.find(([, pw, ph]) => Math.abs(pw - a) < 2.5 && Math.abs(ph - b) < 2.5);
  return p ? `${p[0]} ${w > h ? 'landscape' : 'portrait'}` : null;
}
const mm = (pt: number) => Math.round((pt / 72) * 25.4 * 10) / 10;

export default defineTool({
  name: 'pdf_info',
  title: 'PDF info',
  description:
    'Quick facts about a PDF for planning the next step: page count, page sizes (points, mm, paper name such as "A4 ' +
    'portrait", grouped by size), rotated pages, encryption, PDF version, form field count, title/author, and which pages ' +
    'have no text layer (scans that would need OCR). Related web tool: ' + webUrl('pdf-metadata'),
  inputSchema: z.object({
    file: fileInput('PDF'),
    password: z.string().optional().describe('Password, for the text check on a protected PDF.'),
    textCheck: z.boolean().optional().default(true).describe('Check which pages have a text layer (reads up to 500 pages). Default true.'),
  }),
  outputSchema: z.object({
    pages: z.number(), fileBytes: z.number(), pdfVersion: z.string(), encrypted: z.boolean(),
    sizes: z.array(z.object({ width: z.number(), height: z.number(), widthMm: z.number(), heightMm: z.number(), paper: z.string().nullable(), pages: z.string() }))
      .describe('Shown page sizes in points (rotation applied), grouped; "pages" lists the 1-based pages with that size.'),
    rotatedPages: z.array(z.object({ page: z.number(), rotation: z.number() })),
    formFields: z.number(),
    title: z.string().nullable(), author: z.string().nullable(), producer: z.string().nullable(),
    pagesWithoutText: z.array(z.number()).nullable().describe('1-based pages with no text layer; null when not checked.'),
    textChecked: z.number().describe('How many pages the text check looked at.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'scan.pdf' }, note: '{ pages: 12, sizes: [{ paper: "A4 portrait", pages: "1-12" }], pagesWithoutText: [1, …] }' }],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, 'PDF');
    if (!isPdf(f.bytes)) throw new ToolError('This file is not a PDF.');
    let doc: PDFDocument;
    try { doc = await PDFDocument.load(f.bytes, { ignoreEncryption: true, updateMetadata: false }); }
    catch (e) { throw new ToolError(`This PDF could not be read: ${e instanceof Error ? e.message : String(e)}`); }
    const head = Buffer.from(f.bytes.subarray(0, 1024)).toString('latin1');
    const groups = new Map<string, { width: number; height: number; pages: number[] }>(), rotated: { page: number; rotation: number }[] = [];
    doc.getPages().forEach((pg, i) => {
      const { W, H, rot } = pageGeom(pg), width = Math.round(W * 100) / 100, height = Math.round(H * 100) / 100, key = `${width}x${height}`;
      if (!groups.has(key)) groups.set(key, { width, height, pages: [] });
      groups.get(key)!.pages.push(i);
      if (rot) rotated.push({ page: i + 1, rotation: rot });
    });
    const encrypted = doc.isEncrypted;
    const text = (k: string) => { if (encrypted) return null; try { const v = infoDict(doc).lookup(PDFName.of(k)); return v ? (v as unknown as { decodeText(): string }).decodeText().trim() || null : null; } catch { return null; } };
    let formFields = 0;
    try { formFields = doc.getForm().getFields().length; } catch { formFields = 0; }
    let pagesWithoutText: number[] | null = null, textChecked = 0;
    if (input.textCheck && (!encrypted || input.password != null)) {
      try {
        const js = await loadPdfJs(f.bytes, input.password);
        pagesWithoutText = [];
        try {
          for (let i = 1; i <= Math.min(js.numPages, 500); i++) {
            const page = await js.getPage(i), tc = await page.getTextContent();
            if (!(tc.items as { str?: string }[]).some((it) => it.str?.trim())) pagesWithoutText.push(i);
            page.cleanup();
            textChecked++;
          }
        } finally { await closeJs(js); }
      } catch { pagesWithoutText = null; }
    }
    return {
      pages: doc.getPageCount(), fileBytes: f.bytes.length, pdfVersion: (/%PDF-(\d\.\d)/.exec(head) || [])[1] || '?', encrypted,
      sizes: [...groups.values()].map((g) => ({ width: g.width, height: g.height, widthMm: mm(g.width), heightMm: mm(g.height), paper: paperName(g.width, g.height), pages: toRangeText(g.pages) })),
      rotatedPages: rotated, formFields, title: text('Title'), author: text('Author'), producer: text('Producer'), pagesWithoutText, textChecked,
    };
  },
});

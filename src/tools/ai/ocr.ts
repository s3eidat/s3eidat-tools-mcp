import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { ToolError } from '../../util/errors.js';
import { fileInput, readInput, withExt, writeOutput } from '../../util/files.js';
import { isPdf, loadPdfJs, parsePageRanges, renderPage } from '../../util/pdf.js';

const require = createRequire(import.meta.url);
const LANGS = ['eng', 'ara'] as const;
/** The LSTM-only "best_int" models: what tesseract.js itself would fetch for its default engine, but read from node_modules. */
const MODEL_DIR = '4.0.0_best_int';
const MAX_PAGES = 200;

/**
 * tesseract.js reads every language from one `langPath`, but each language ships in its own npm package. Copy the
 * gzipped models (once) into one temp folder and point tesseract there, so nothing is ever fetched from a CDN.
 */
async function langDir(): Promise<string> {
  const dir = join(tmpdir(), 's3eidat-tools-tessdata', MODEL_DIR);
  await mkdir(dir, { recursive: true });
  for (const lang of LANGS) {
    const src = join(dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), MODEL_DIR, `${lang}.traineddata.gz`);
    if (!existsSync(src)) throw new ToolError(`OCR language data for "${lang}" is missing (${src}). Reinstall the package.`);
    const dst = join(dir, `${lang}.traineddata.gz`);
    if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
    const tmp = `${dst}.${process.pid}.${Date.now()}.tmp`;
    await copyFile(src, tmp);
    await rename(tmp, dst).catch(async () => { if (!existsSync(dst)) throw new ToolError('Could not prepare OCR language data.'); });
  }
  return dir;
}

type Page = { page: number; png: Buffer; width: number; height: number };

/** Turn the input into PNG pages: rendered PDF pages, TIFF frames, or a single image. */
async function toPages(bytes: Buffer, opts: { pages?: string; dpi: number }): Promise<{ kind: 'pdf' | 'image'; total: number; pages: () => AsyncGenerator<Page> }> {
  if (isPdf(bytes)) {
    const doc = await loadPdfJs(bytes);
    const sel = parsePageRanges(opts.pages, doc.numPages);
    if (sel.length > MAX_PAGES) throw new ToolError(`That is ${sel.length} pages; OCR at most ${MAX_PAGES} per call (use "pages").`);
    return {
      kind: 'pdf', total: doc.numPages,
      pages: async function* () {
        try {
          for (const i of sel) {
            const r = await renderPage(doc, i + 1, { dpi: opts.dpi, format: 'png' });
            yield { page: i + 1, png: r.data, width: r.width, height: r.height };
          }
        } finally {
          await doc.loadingTask.destroy().catch(() => {});
        }
      },
    };
  }
  const sharp = (await import('sharp')).default;
  let meta;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new ToolError('Not a supported image or PDF (OCR reads PNG, JPEG, WebP, TIFF, GIF, AVIF, BMP-like formats sharp can decode, and PDFs).');
  }
  const frames = meta.format === 'tiff' ? meta.pages ?? 1 : 1;
  const sel = parsePageRanges(opts.pages, frames);
  if (sel.length > MAX_PAGES) throw new ToolError(`That is ${sel.length} pages; OCR at most ${MAX_PAGES} per call (use "pages").`);
  return {
    kind: 'image', total: frames,
    pages: async function* () {
      for (const i of sel) {
        let s = sharp(bytes, frames > 1 ? { page: i } : {}).rotate().flatten({ background: '#ffffff' });
        const m = await s.metadata();
        const w = m.autoOrient?.width ?? m.width ?? 0, h = m.autoOrient?.height ?? m.height ?? 0;
        // Very large scans gain nothing past ~40 MP and slow tesseract a lot.
        if (w * h > 40e6) { const k = Math.sqrt(40e6 / (w * h)); s = s.resize(Math.round(w * k), Math.round(h * k)); }
        const { data, info } = await s.png().toBuffer({ resolveWithObject: true });
        yield { page: i + 1, png: data, width: info.width, height: info.height };
      }
    },
  };
}

export default defineTool({
  name: 'ai_ocr',
  title: 'OCR (image or scanned PDF to text)',
  description:
    'Read the text in an image (PNG, JPEG, WebP, TIFF incl. multi-page, GIF, AVIF) or a scanned PDF with Tesseract (tesseract.js), ' +
    'fully offline: the English and Arabic models ship with the server and nothing is downloaded or uploaded. Languages: "eng", ' +
    '"ara" or "eng+ara" (default). PDF pages are rendered at 200 dpi by default. Returns the text per page and the mean ' +
    'word confidence (0-100); give "output" to also write a .txt file. Limits: up to 200 pages per call, roughly 1-5 s per page; ' +
    'printed text works well, handwriting and very small or skewed text poorly. For PDFs that already have a text layer, ' +
    'pdf_to_text is faster and exact. Give "file" as a local path or base64.',
  inputSchema: z.object({
    file: fileInput('image or PDF'),
    languages: z.enum(['eng', 'ara', 'eng+ara']).optional().default('eng+ara').describe('Languages to read. Default "eng+ara".'),
    pages: z.string().optional().describe('PDF pages / TIFF frames, e.g. "1-3, 5" (default all).'),
    dpi: z.number().int().min(72).max(400).optional().default(200).describe('Render resolution for PDF pages. Default 200.'),
    psm: z.enum(['auto', 'block', 'line', 'word', 'sparse']).optional().default('auto')
      .describe('Page layout: "auto" (default), "block" (one uniform block), "line", "word", or "sparse" (scattered text).'),
    perPage: z.boolean().optional().default(false).describe('Also return the text of each page separately in "pages". Default false (the joined "text" has page separators).'),
    output: z.string().optional().describe('Also write the text to this .txt file (or folder ending in "/").'),
    maxChars: z.number().int().min(1000).optional().default(200_000).describe('Cut the inline text after this many characters (the file is never cut).'),
  }),
  outputSchema: z.object({
    kind: z.enum(['pdf', 'image']),
    languages: z.string(),
    pageCount: z.number().describe('Pages/frames in the input.'),
    pages: z.array(z.object({ page: z.number(), text: z.string().optional(), confidence: z.number(), words: z.number(), width: z.number(), height: z.number() })),
    text: z.string(),
    meanConfidence: z.number().describe('Mean of the page confidences (0-100), pages with no text excluded.'),
    truncated: z.boolean().optional(),
    path: z.string().optional(),
    bytes: z.number().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'scan.png', languages: 'eng' } },
    { input: { file: 'scanned-contract.pdf', pages: '1-3', output: 'contract.txt' } },
  ],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, 'file');
    const src = await toPages(f.bytes, { pages: input.pages, dpi: input.dpi });
    const langPath = await langDir();
    const T = await import('tesseract.js');
    const createWorker = (T as unknown as { createWorker?: typeof import('tesseract.js').createWorker }).createWorker
      ?? (T as unknown as { default: typeof import('tesseract.js') }).default.createWorker;
    const worker = await createWorker(input.languages, 1 /* LSTM only */, {
      langPath,
      cachePath: langPath,
      cacheMethod: 'none', // read the models from langPath every time; never write or read a cache
      gzip: true,
      logger: () => {},
      errorHandler: () => {},
    });
    const results: { page: number; text: string; confidence: number; words: number; width: number; height: number }[] = [];
    try {
      const psm = { auto: '3', block: '6', line: '7', word: '8', sparse: '11' }[input.psm];
      await worker.setParameters({ tessedit_pageseg_mode: psm as never, preserve_interword_spaces: '1', user_defined_dpi: String(src.kind === 'pdf' ? input.dpi : 300) });
      for await (const p of src.pages()) {
        const { data } = await worker.recognize(p.png);
        const text = (data.text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        results.push({
          page: p.page, text, confidence: Math.round((data.confidence ?? 0) * 10) / 10,
          words: (text.match(/[\p{L}\p{N}]+/gu) || []).length, width: p.width, height: p.height,
        });
      }
    } finally {
      await worker.terminate().catch(() => {});
    }
    const withText = results.filter((r) => r.text);
    const meanConfidence = withText.length ? Math.round((withText.reduce((s, r) => s + r.confidence, 0) / withText.length) * 10) / 10 : 0;
    const full = results.length > 1 ? results.map((r) => `——— Page ${r.page} ———\n\n${r.text}`).join('\n\n') : results[0]?.text ?? '';
    const result: Record<string, unknown> = {
      kind: src.kind, languages: input.languages, pageCount: src.total,
      pages: input.perPage ? results : results.map(({ text: _t, ...r }) => r), text: full.length > input.maxChars ? full.slice(0, input.maxChars) : full, meanConfidence,
    };
    if (full.length > input.maxChars) result.truncated = true;
    if (input.output) {
      const w = await writeOutput(full + '\n', { output: input.output, defaultName: withExt(f.path ? f.name : 'ocr', '.txt'), mimeType: 'text/plain' }, ctx);
      result.path = w.path; result.bytes = w.bytes;
    }
    return result;
  },
});

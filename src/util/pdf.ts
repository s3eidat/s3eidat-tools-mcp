/**
 * PDF helpers: pdf-lib for editing (same library the website uses) and pdf.js (legacy build) for reading text
 * and rendering pages. pdf.js runs with eval disabled and no network.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { ToolError } from './errors.js';

const require = createRequire(import.meta.url);

/** Load a PDF with pdf-lib. Encrypted PDFs load with ignoreEncryption only when `allowEncrypted`. */
export async function loadPdfLib(bytes: Uint8Array, label = 'PDF', allowEncrypted = false) {
  if (!isPdf(bytes)) throw new ToolError(`${label} is not a PDF file.`);
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: allowEncrypted, updateMetadata: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/encrypt/i.test(msg)) throw new ToolError(`${label} is password-protected. Remove the password first.`);
    throw new ToolError(`${label} could not be read: ${msg}`);
  }
}

export function isPdf(bytes: Uint8Array) {
  // %PDF- within the first 1 KB (some files have junk before the header).
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsP: Promise<PdfJs> | undefined;

export function pdfjs(): Promise<PdfJs> {
  pdfjsP ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsP;
}

/** Open a PDF with pdf.js for text extraction / rendering. */
export async function loadPdfJs(bytes: Uint8Array, password?: string) {
  const lib = await pdfjs();
  const pkg = dirname(require.resolve('pdfjs-dist/package.json'));
  try {
    return await lib.getDocument({
      data: new Uint8Array(bytes), // pdf.js transfers/detaches the buffer: always give it a copy
      password,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
      standardFontDataUrl: join(pkg, 'standard_fonts') + '/',
      cMapUrl: join(pkg, 'cmaps') + '/',
      cMapPacked: true,
      wasmUrl: join(pkg, 'wasm') + '/',
    }).promise;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') throw new ToolError(password ? 'Wrong PDF password.' : 'The PDF is password-protected: give "password".');
    throw new ToolError(`PDF could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type PdfJsDoc = Awaited<ReturnType<typeof loadPdfJs>>;

/** Render one page (1-based) to PNG or JPEG bytes. `scale` 1 = 72 dpi. */
export async function renderPage(doc: PdfJsDoc, pageNumber: number, opts: { scale?: number; dpi?: number; format?: 'png' | 'jpeg'; quality?: number; background?: string } = {}) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const page = await doc.getPage(pageNumber);
  const scale = opts.dpi ? opts.dpi / 72 : opts.scale ?? 2;
  const vp = page.getViewport({ scale });
  const w = Math.max(1, Math.round(vp.width)), h = Math.max(1, Math.round(vp.height));
  if (w * h > 100e6) throw new ToolError(`Page ${pageNumber} at this scale would be ${w}×${h} px; use a lower dpi/scale.`);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = opts.background ?? '#ffffff';
  ctx.fillRect(0, 0, w, h);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({ canvas: canvas as any, canvasContext: ctx as any, viewport: vp }).promise;
  page.cleanup();
  const data = opts.format === 'jpeg' ? await canvas.encode('jpeg', Math.round((opts.quality ?? 0.85) * 100)) : await canvas.encode('png');
  return { data: Buffer.from(data), width: w, height: h };
}

/**
 * Parse a page selection like "1-3, 5, 8-" (1-based, inclusive) into 0-based indexes.
 * Supports "all", "odd", "even", "last", "-3" (first three) and "5-" (to the end). Order is kept, duplicates removed.
 */
export function parsePageRanges(spec: string | undefined, pageCount: number): number[] {
  if (!spec || /^\s*(all|\*)\s*$/i.test(spec)) return Array.from({ length: pageCount }, (_, i) => i);
  const out: number[] = [];
  const seen = new Set<number>();
  const push = (i: number) => { if (!seen.has(i)) { seen.add(i); out.push(i); } };
  for (const raw of spec.split(/[,;\s]+/).filter(Boolean)) {
    const part = raw.toLowerCase();
    if (part === 'odd') { for (let i = 0; i < pageCount; i += 2) push(i); continue; }
    if (part === 'even') { for (let i = 1; i < pageCount; i += 2) push(i); continue; }
    const num = (s: string) => (s === 'last' || s === 'end' ? pageCount : Number(s));
    const m = /^(\d+|last|end)?\s*-\s*(\d+|last|end)?$/.exec(part);
    let a: number, b: number;
    if (m && (m[1] || m[2])) { a = m[1] ? num(m[1]) : 1; b = m[2] ? num(m[2]) : pageCount; }
    else if (/^(\d+|last|end)$/.test(part)) { a = b = num(part); }
    else throw new ToolError(`Bad page range "${raw}". Use e.g. "1-3, 5, 8-".`);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a > pageCount || b > pageCount) {
      throw new ToolError(`Page range "${raw}" is outside 1-${pageCount}.`);
    }
    if (a <= b) for (let i = a; i <= b; i++) push(i - 1);
    else for (let i = a; i >= b; i--) push(i - 1);
  }
  return out;
}

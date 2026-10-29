import { readFileSync } from 'node:fs';
import { loadPdfJs, renderPage } from '../../../src/util/pdf.js';

/** Re-open a PDF with pdf.js: page count, per-page text (items joined by spaces) and page sizes in pt. */
export async function pdfInfo(path: string) {
  const doc = await loadPdfJs(readFileSync(path));
  const pages: string[] = [], sizes: [number, number][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    pages.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' '));
    const vp = p.getViewport({ scale: 1 });
    sizes.push([Math.round(vp.width * 10) / 10, Math.round(vp.height * 10) / 10]);
  }
  const meta = await doc.getMetadata();
  return { doc, pageCount: doc.numPages, pages, text: pages.join('\n'), sizes, title: (meta.info as { Title?: string }).Title };
}

/** Render one page to PNG and return raw RGB pixels for colour checks. */
export async function pagePixels(path: string, pageNo = 1, dpi = 72) {
  const { default: sharp } = await import('sharp');
  const doc = await loadPdfJs(readFileSync(path));
  const png = await renderPage(doc, pageNo, { dpi });
  const { data, info } = await sharp(png.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    png: png.data, width: info.width, height: info.height,
    at(x: number, y: number) { const i = (Math.round(y) * info.width + Math.round(x)) * 3; return '#' + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''); },
  };
}

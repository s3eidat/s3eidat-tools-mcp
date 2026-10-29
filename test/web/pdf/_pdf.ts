import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

/** A PDF whose page widths mark each page (the website self-tests use this trick). */
export async function widthsPdf(widths: number[], height = 300) {
  const d = await PDFDocument.create();
  widths.forEach((w) => d.addPage([w, height]));
  return Buffer.from(await d.save({ useObjectStreams: false }));
}

export const b64 = (b: Uint8Array) => 'base64:' + Buffer.from(b).toString('base64');

export async function load(path: string) {
  return PDFDocument.load(readFileSync(path));
}

export async function widthsOf(path: string) {
  return (await load(path)).getPages().map((p) => Math.round(p.getWidth())).join();
}

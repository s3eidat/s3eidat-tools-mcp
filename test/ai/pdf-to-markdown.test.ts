import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import tool, { bodySize, linesToMarkdown } from '../../src/tools/ai/pdf-to-markdown.js';
import { call, samplePdf, tempCtx } from '../helpers.js';

type R = { markdown?: string; pageCount: number; pagesConverted: number; pagesWithoutText: number[]; headings: number; bodyFontSize: number; words: number; path?: string };
const b64 = (b: Uint8Array) => 'base64:' + Buffer.from(b).toString('base64');

/** A two-page report: title 24 pt, section headings 16 pt, body 11 pt on 14 pt lines, a bullet list, a blank page. */
async function reportPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = (draw: [string, number, number, number?][]) => {
    const p = doc.addPage([595, 842]);
    for (const [t, size, y, x] of draw) p.drawText(t, { x: x ?? 72, y, size, font });
  };
  page([
    ['Annual Report', 24, 760],
    ['Overview', 16, 720],
    ['Our bakery sold more bread this year than ever', 11, 696],
    ['before, thanks to the new oven and longer hours', 11, 682],
    ['on weekends.', 11, 668],
    ['A second paragraph starts after a wider gap and', 11, 640],
    ['ends here.', 11, 626],
    ['Goals', 16, 590],
    ['• Open a second shop', 11, 566],
    ['• Train two new bakers in the spring and', 11, 552],
    ['keep them', 11, 538, 84],
    ['1. Lower costs', 11, 524],
  ]);
  page([
    ['Finances', 16, 760],
    ['Revenue rose by a fifth while costs stayed flat, a', 11, 736],
    ['well-earned result.', 11, 722],
  ]);
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

describe('ai_pdf_to_markdown', () => {
  it('rebuilds headings, paragraphs and lists from font sizes and spacing', async () => {
    const r = await call<R>(tool, { file: b64(await reportPdf()) }, tempCtx());
    expect(r.markdown).toBe(
      '# Annual Report\n\n## Overview\n\n' +
        'Our bakery sold more bread this year than ever before, thanks to the new oven and longer hours on weekends.\n\n' +
        'A second paragraph starts after a wider gap and ends here.\n\n## Goals\n\n' +
        '- Open a second shop\n- Train two new bakers in the spring and keep them\n1. Lower costs\n\n' +
        '## Finances\n\nRevenue rose by a fifth while costs stayed flat, a well-earned result.\n\n_(no text on this page)_\n',
    );
    expect(r).toMatchObject({ pageCount: 3, pagesConverted: 3, pagesWithoutText: [3], headings: 4, bodyFontSize: 11 });
  });

  it('honours page ranges and page markers, and writes files', async () => {
    const ctx = tempCtx();
    const r = await call<R>(tool, { file: b64(await reportPdf()), pages: '2-3', pageMarkers: true }, ctx);
    expect(r.pagesConverted).toBe(2);
    // Heading levels are relative to the pages converted: alone, the 16 pt heading is the top level.
    expect(r.markdown).toBe('<!-- Page 2 -->\n\n# Finances\n\nRevenue rose by a fifth while costs stayed flat, a well-earned result.\n\n---\n\n<!-- Page 3 -->\n\n_(no text on this page)_\n');
    const out = join(ctx.outDir, 'r.md');
    const w = await call<R>(tool, { file: b64(await samplePdf(2)), output: out }, ctx);
    expect(w.path).toBe(out);
    expect(readFileSync(out, 'utf8')).toBe('Page 1\n\nPage 2\n');
    await expect(call(tool, { file: b64(await samplePdf(2)), pages: '5' }, ctx)).rejects.toThrow(/outside 1-2/);
  });

  it('plain text with one size has no headings, and markdown-looking text is escaped', () => {
    const lines = [{ y: 10, size: 10, x: 0, text: '# not a heading' }, { y: 22, size: 10, x: 0, text: 'but text' }, { y: 52, size: 10, x: 0, text: 'plain' }];
    expect(bodySize([lines])).toBe(10);
    expect(linesToMarkdown([{ n: 1, lines }]).markdown).toBe('\\# not a heading but text\n\nplain\n');
  });
});

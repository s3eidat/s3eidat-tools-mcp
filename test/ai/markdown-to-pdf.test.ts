import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import md2pdf, { CharFilter } from '../../src/tools/ai/markdown-to-pdf.js';
import { call, tempCtx } from '../helpers.js';
import { pdfInfo } from '../web/docs/_helpers.js';

const ctx = tempCtx();
type Out = { path: string; bytes: number; pages: number; title: string; unsupportedChars?: string[] };

const SAMPLE = `# Project Report

Intro paragraph with **bold**, *italic*, ~~gone~~, \`inline code\` and a [link](https://example.com).

## Lists

- First item
- Second item
  - Nested item
1. One
2. Two
- [x] Done task
- [ ] Open task

> A wise quote
> on two lines.

\`\`\`js
function hello() {
  return 'world';
}
\`\`\`

---

| Name | Score | Notes |
|:-----|------:|:-----:|
| Sara | 12 | Top of the class with a long note that has to wrap inside its cell |
| Omar | 9 | Fine |
`;

describe('CharFilter', () => {
  it('keeps Latin-1, transliterates symbols, flags the rest', () => {
    const f = new CharFilter('replace');
    expect(f.clean('Café → done ✓ “quotes” 😀')).toBe('Café -> done v “quotes” ');
    expect(f.clean('مرحبا')).toBe('?????');
    expect([...f.unsupported]).toEqual(['😀', 'م', 'ر', 'ح', 'ب', 'ا']);
    expect(() => new CharFilter('error').clean('日本')).toThrow(/U\+65E5/);
  });
});

describe('ai_markdown_to_pdf', () => {
  it('renders every block type into a real PDF with the text in it', async () => {
    const r = await call<Out>(md2pdf, { markdown: SAMPLE }, ctx);
    expect(r.title).toBe('Project Report');
    expect(r.pages).toBe(1);
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBe(1);
    expect(info.title).toBe('Project Report');
    expect(info.sizes[0]).toEqual([595.3, 841.9]); // A4
    const text = info.text;
    for (const t of ['Project Report', 'Intro paragraph with', 'bold', 'italic', 'inline code', 'link', 'First item', 'Nested item', '1.', '2.', 'Done task',
      'A wise quote', "return 'world';", 'Name', 'Score', 'Sara', 'Omar', 'Top of the class', '1 / 1']) expect(text).toContain(t);
    // The link is clickable.
    const doc = await PDFDocument.load(await import('node:fs').then((fs) => fs.readFileSync(r.path)));
    const annots = doc.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);
  });

  it('paginates long documents, honours page breaks, Letter size and page numbers', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.`).join('\n\n');
    const r = await call<Out>(md2pdf, { markdown: `# Long\n\n${long}\n\n\\pagebreak\n\nLast page.\n\n<!-- pagebreak -->\n`, paper: 'Letter', margin: 15 }, ctx);
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBe(r.pages);
    expect(r.pages).toBeGreaterThan(3);
    expect(info.sizes[0]).toEqual([612, 792]);
    expect(info.pages.at(-1)).toContain('Last page.');
    expect(info.pages.at(-1)).not.toContain('Paragraph 120');
    expect(info.pages.at(-1)).toContain(`${r.pages} / ${r.pages}`);
    expect(info.text).toContain('Paragraph 120');
  });

  it('repeats the table header on a new page', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| ${i + 1} | Item ${i + 1} |`).join('\n');
    const r = await call<Out>(md2pdf, { markdown: `| No | Thing |\n|---|---|\n${rows}`, pageNumbers: false }, ctx);
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBeGreaterThan(1);
    expect(info.pages[1]).toContain('No Thing');
    expect(info.text).toContain('Item 80');
    expect(info.text).not.toContain('1 / ');
  });

  it('reads a .md file with a local image, and reports unsupported characters', async () => {
    const dir = ctx.outDir;
    writeFileSync(join(dir, 'pic.png'), await sharp({ create: { width: 200, height: 100, channels: 3, background: '#e11d48' } }).png().toBuffer());
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\n![A red box](pic.png)\n\nArabic: مرحبا 🙂\n\n![remote](https://example.com/x.png)\n');
    const r = await call<Out>(md2pdf, { path: join(dir, 'notes.md'), title: 'My notes' }, ctx);
    expect(r.title).toBe('My notes');
    expect(r.unsupportedChars).toContain('م');
    const info = await pdfInfo(r.path);
    expect(info.text).toContain('A red box'); // caption
    expect(info.text).toContain('[image: remote]'); // never fetched
    const ops = await info.doc.getPage(1).then((p) => p.getOperatorList());
    expect(ops.fnArray.length).toBeGreaterThan(0);
    const { PDFDocument: P } = await import('pdf-lib');
    const doc = await P.load((await import('node:fs')).readFileSync(r.path));
    const xobjects = doc.getPage(0).node.Resources()?.lookup((await import('pdf-lib')).PDFName.of('XObject'));
    expect(xobjects?.toString()).toMatch(/Image|\/I/);
    await expect(call(md2pdf, { markdown: 'مرحبا', onUnsupportedChar: 'error' }, ctx)).rejects.toThrow(/Latin text only/);
  });
});

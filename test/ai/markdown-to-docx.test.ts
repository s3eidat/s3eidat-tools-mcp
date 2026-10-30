import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import tool, { isRtlText } from '../../src/tools/ai/markdown-to-docx.js';
import { call, tempCtx } from '../helpers.js';

type R = { path: string; bytes: number; paragraphs: number };

const docXml = (p: string) => {
  const files = unzipSync(new Uint8Array(readFileSync(p)));
  return { doc: strFromU8(files['word/document.xml']), styles: strFromU8(files['word/styles.xml']), core: strFromU8(files['docProps/core.xml']), numbering: files['word/numbering.xml'] ? strFromU8(files['word/numbering.xml']) : '' };
};

const MD = `# Quarterly Report

Intro with **bold**, *italic*, \`code & <x>\` and a [link](https://s3eidat.github.io) &amp; more.

## Lists

- apple
  - nested pear
- banana

1. first
2. second

| Name | Qty |
|------|----:|
| Pen  | 3   |

> quoted words

\`\`\`js
const a = 1 < 2;
\`\`\`

---

\\newpage

مرحبا بالعالم، هذا نص عربي.
`;

describe('ai_markdown_to_docx', () => {
  it('writes a .docx with headings, inline styles, lists, tables, code and page breaks', async () => {
    const ctx = tempCtx();
    const r = await call<R>(tool, { markdown: MD, author: 'Omar' }, ctx);
    expect(basename(r.path)).toBe('Quarterly Report.docx');
    const { doc, styles, core, numbering } = docXml(r.path);
    expect(doc).toContain('Quarterly Report');
    expect(doc).toMatch(/<w:pStyle w:val="Heading1"\/>/);
    expect(doc).toMatch(/<w:pStyle w:val="Heading2"\/>/);
    expect(doc).toMatch(/<w:b\/>[\s\S]*?bold/);
    expect(doc).toContain('code &amp; &lt;x&gt;');
    expect(doc).toContain('Consolas');
    expect(doc).toContain('w:hyperlink');
    expect(doc).toContain(' &amp; more');
    expect(doc).toContain('nested pear');
    expect(doc).toMatch(/<w:ilvl w:val="1"\/>/);
    expect(doc).toContain('<w:tbl>');
    expect(doc).toContain('quoted words');
    expect(doc).toContain('const a = 1 &lt; 2;');
    expect(doc).toContain('<w:br w:type="page"/>');
    expect(doc).not.toContain('newpage');
    expect(doc).toContain('مرحبا بالعالم');
    expect(doc).toContain('<w:bidi/>');
    expect(styles).toContain('Calibri');
    expect(numbering).toContain('decimal');
    expect(core).toContain('Omar');
    expect(r.paragraphs).toBeGreaterThan(10);
  });

  it('detects RTL text and uses the title for the file name', async () => {
    expect(isRtlText('مرحبا world')).toBe(true);
    expect(isRtlText('Hello عمر and friends')).toBe(false);
    const ctx = tempCtx();
    const r = await call<R>(tool, { markdown: 'plain text', title: 'My Notes', font: 'Arial' }, ctx);
    expect(basename(r.path)).toBe('My Notes.docx');
    const { doc, styles, core } = docXml(r.path);
    expect(doc).toContain('plain text');
    expect(styles).toContain('Arial');
    expect(core).toContain('My Notes');
  });
});

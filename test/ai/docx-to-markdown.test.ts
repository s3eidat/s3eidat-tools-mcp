import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import { describe, expect, it } from 'vitest';
import tool from '../../src/tools/ai/docx-to-markdown.js';
import { call, tempCtx } from '../helpers.js';

type R = { markdown?: string; words: number; warnings: number; messages: string[]; images: number; path?: string };
const b64 = (b: Uint8Array) => 'base64:' + Buffer.from(b).toString('base64');

async function sampleDocx() {
  const cellP = (t: string) => new TableCell({ children: [new Paragraph(t)] });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Quarterly report', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun('Sales were '), new TextRun({ text: 'strong', bold: true }), new TextRun(' and '), new TextRun({ text: 'steady', italics: true }), new TextRun('.')] }),
        new Paragraph({ text: 'Highlights', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: 'New shop opened', bullet: { level: 0 } }),
        new Paragraph({ text: 'Costs fell', bullet: { level: 0 } }),
        new Paragraph({ children: [new TextRun('Details at '), new ExternalHyperlink({ link: 'https://example.com/q3', children: [new TextRun('our site')] }), new TextRun('.')] }),
        new Table({ rows: [new TableRow({ children: [cellP('Region'), cellP('Sales')] }), new TableRow({ children: [cellP('North'), cellP('120')] })] }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

describe('ai_docx_to_markdown', () => {
  it('converts headings, emphasis, lists, links and tables', async () => {
    const r = await call<R>(tool, { file: b64(await sampleDocx()) }, tempCtx());
    expect(r.markdown).toBe(
      '# Quarterly report\n\nSales were **strong** and _steady_.\n\n## Highlights\n\n- New shop opened\n- Costs fell\n\n' +
        'Details at [our site](https://example.com/q3).\n\n| Region | Sales |\n| --- | --- |\n| North | 120 |\n',
    );
    expect(r.words).toBe(21);
    expect(r.images).toBe(0);
    expect(typeof r.warnings).toBe('number');
  });

  it('writes to a file and rejects non-docx input', async () => {
    const ctx = tempCtx();
    const out = join(ctx.outDir, 'report.md');
    const r = await call<R>(tool, { file: b64(await sampleDocx()), output: out }, ctx);
    expect(r.path).toBe(out);
    expect(readFileSync(out, 'utf8')).toContain('# Quarterly report');
    await expect(call(tool, { file: b64(Buffer.from('just some text, not a zip')) }, ctx)).rejects.toThrow(/Not a \.docx/);
    await expect(call(tool, { file: b64(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])) }, ctx)).rejects.toThrow(/old binary \.doc/);
  });
});

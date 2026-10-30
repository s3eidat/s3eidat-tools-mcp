import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { call, samplePdf, tempCtx } from '../helpers.js';
import tool from '../../src/tools/ai/ocr.js';

type Out = { kind: string; pageCount: number; text: string; meanConfidence: number; pages: { page: number; text?: string; confidence: number }[]; path?: string };

async function textImage(text: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220"><rect width="100%" height="100%" fill="#fff"/>` +
    `<text x="40" y="140" font-family="Arial, Helvetica, sans-serif" font-size="96" font-weight="bold" fill="#000">${text}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('ai_ocr', () => {
  it('reads a rendered image offline (eng)', async () => {
    const png = await textImage('HELLO 123');
    const r = await call<Out>(tool, { file: 'data:image/png;base64,' + png.toString('base64'), languages: 'eng' });
    expect(r.kind).toBe('image');
    expect(r.text).toContain('HELLO');
    expect(r.text).toContain('123');
    expect(r.meanConfidence).toBeGreaterThan(50);
  }, 120_000);

  it('reads a PDF page with the default eng+ara models and writes .txt', async () => {
    const ctx = tempCtx();
    const pdf = await samplePdf(2);
    const r = await call<Out>(tool, { file: 'data:application/pdf;base64,' + pdf.toString('base64'), pages: '2', perPage: true, output: 'out.txt' }, { ...ctx, root: ctx.outDir });
    expect(r).toMatchObject({ kind: 'pdf', pageCount: 2 });
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].page).toBe(2);
    expect(r.pages[0].text).toMatch(/Page\s*2/);
    expect(readFileSync(r.path!, 'utf8')).toMatch(/Page\s*2/);
  }, 120_000);
});

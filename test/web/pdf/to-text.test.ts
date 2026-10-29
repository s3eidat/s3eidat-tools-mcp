import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import toText, { joinLine, reflowPara } from '../../../src/tools/web/pdf/pdf-to-text.js';
import { call, tempCtx } from '../../helpers.js';
import { b64 } from './_pdf.js';

// The website's tiny PDF writer: /F1 Helvetica, /F2 Courier (every Courier glyph is 0.6 em, so positions are exact).
function rawPdf(pages: { w: number; h: number; rot?: number; ops: string }[]) {
  const objs: string[] = [], add = (s: string) => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const kids = pages.map((p) => {
    const c = add('<< /Length ' + p.ops.length + ' >>\nstream\n' + p.ops + '\nendstream');
    return add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + p.w + ' ' + p.h + ']' + (p.rot ? ' /Rotate ' + p.rot : '') + ' /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + c + ' 0 R >>');
  });
  objs[1] = '<< /Type /Pages /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
  let s = '%PDF-1.4\n';
  const off: number[] = [];
  objs.forEach((o, i) => { off.push(s.length); s += i + 1 + ' 0 obj\n' + o + '\nendobj\n'; });
  const x = s.length;
  s += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  s += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF';
  return Buffer.from(s, 'latin1');
}
const pdfStr = (t: string) => '(' + t.replace(/[\\()]/g, '\\$&') + ')';
const tj = (font: string, size: number, x: number, y: number, t: string) => 'BT /' + font + ' ' + size + ' Tf ' + x + ' ' + y + ' Td ' + pdfStr(t) + ' Tj ET\n';

function testPdf() {
  let p1 = tj('F2', 12, 50, 700, 'Hello') + tj('F2', 12, 50 + 36 + 7.2, 700, 'World') + tj('F2', 12, 200, 700, 'Data') + tj('F2', 12, 228.8, 700, 'base');
  ['The quick brown fox', 'jumps over the lazy', 'dog.'].forEach((t, i) => { p1 += tj('F2', 12, 50, 650 - i * 14, t); });
  ['Second para-', 'graph here.'].forEach((t, i) => { p1 += tj('F2', 12, 50, 580 - i * 14, t); });
  return rawPdf([{ w: 600, h: 800, ops: p1 }, { w: 600, h: 800, ops: '0.5 g 50 50 200 200 re f' }, { w: 400, h: 600, rot: 90, ops: tj('F1', 14, 40, 300, 'Rotated page text') }]);
}

describe('pdf_to_text (pdf-to-text self-test)', () => {
  it('rebuilds words, lines and paragraphs', async () => {
    const r = await call<{ pages: { page: number; words: number; hasText: boolean; text: string }[]; pagesWithoutText: number[]; text: string }>(toText, { file: b64(testPdf()), perPage: true, separators: true, reflow: true }, tempCtx());
    expect(r.pages.map((p) => [p.words, p.hasText])).toEqual([[15, true], [0, false], [3, true]]);
    expect(r.pagesWithoutText).toEqual([2]);
    expect(r.pages[0].text).toBe('Hello World Database\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph here.');
    expect(r.pages[2].text).toBe('Rotated page text');
    expect(r.text.indexOf('——— Page 1 ———')).toBe(0);
    expect(r.text).toContain('The quick brown fox jumps over the lazy dog.');
  });
  it('keeps lines without reflow, writes markdown files, honours page ranges', async () => {
    const ctx = tempCtx();
    const plain = await call<{ text: string }>(toText, { file: b64(testPdf()), pages: '1', separators: false }, ctx);
    expect(plain.text).toContain('The quick brown fox\njumps over the lazy\ndog.');
    const md = await call<{ path: string }>(toText, { file: b64(testPdf()), format: 'markdown', output: ctx.outDir + '/out.md' }, ctx);
    const s = readFileSync(md.path, 'utf8');
    expect(s).toMatch(/## Page 2\n\n_\(no text on this page\)_/);
    expect(s).toContain('## Page 3');
  });
  it('orders right-to-left lines and mends hyphens', () => {
    expect(joinLine([{ str: 'بكم', x: 50, y: 0, w: 30, h: 12 }, { str: 'مرحبا', x: 100, y: 0, w: 40, h: 12 }])).toBe('مرحبا بكم');
    expect(reflowPara(['Second para-', 'graph here.'])).toBe('Second paragraph here.');
  });
});

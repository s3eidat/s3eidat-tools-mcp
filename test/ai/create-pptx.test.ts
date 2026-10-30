import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import pptx, { flattenBullets } from '../../src/tools/ai/create-pptx.js';
import { call, tempCtx } from '../helpers.js';

const ctx = tempCtx();
type Out = { path: string; bytes: number; slides: number; mimeType: string };

function unzipPptx(path: string) {
  const files = unzipSync(new Uint8Array(readFileSync(path)));
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  return { files, text, names: Object.keys(files) };
}

describe('flattenBullets', () => {
  it('turns the nested notation into levels', () => {
    expect(flattenBullets(['A', ['a1', ['a1x']], { text: 'B', level: 0 }, 'C'])).toEqual([
      { text: 'A', level: 0 }, { text: 'a1', level: 1 }, { text: 'a1x', level: 2 }, { text: 'B', level: 0 }, { text: 'C', level: 0 },
    ]);
  });
});

describe('ai_create_pptx', () => {
  it('writes a real pptx with title slide, bullets, notes, table, chart and image', async () => {
    const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#2563eb' } }).png().toBuffer();
    const r = await call<Out>(pptx, {
      title: 'Quarterly Review', subtitle: 'Sales team', theme: 'dark',
      slides: [
        { title: 'Highlights', text: 'A strong quarter.', bullets: ['Revenue up 12%', ['EMEA +20%', 'APAC +8%'], 'Two new clients'], notes: 'Open with the good news.' },
        { title: 'Revenue by month', chart: { type: 'bar', labels: ['Jul', 'Aug', 'Sep'], series: [{ name: 'Revenue', values: [120, 135, 150] }, { name: 'Cost', values: [80, 82, 90] }] } },
        { title: 'Team', table: [['Name', 'Deals'], ['Sara', 12], ['Omar', 9]], image: 'base64:' + png.toString('base64') },
        { title: 'مرحبا', bullets: ['نقطة أولى'] },
      ],
    }, ctx);
    expect(r.slides).toBe(5);
    expect(r.mimeType).toContain('presentationml');
    const buf = readFileSync(r.path);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const z = unzipPptx(r.path);
    expect(z.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(5);
    expect(z.text('ppt/slides/slide1.xml')).toContain('Quarterly Review');
    const s2 = z.text('ppt/slides/slide2.xml');
    for (const t of ['Highlights', 'A strong quarter.', 'Revenue up 12%', 'EMEA +20%', 'Two new clients']) expect(s2).toContain(t);
    expect(s2).toMatch(/lvl="1"/); // the sub-bullet is indented
    const notes = z.names.filter((n) => /notesSlides\/notesSlide\d+\.xml$/.test(n)).map(z.text).join('\n');
    expect(notes).toContain('Open with the good news.');
    const chart = z.names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).map(z.text).join('\n');
    expect(chart).toContain('<c:barChart>');
    for (const t of ['Revenue', 'Cost', 'Jul', 'Sep', '150']) expect(chart).toContain(t);
    const s4 = z.text('ppt/slides/slide4.xml');
    for (const t of ['Team', 'Name', 'Deals', 'Sara', '12', 'Omar']) expect(s4).toContain(t);
    expect(s4).toContain('<a:tbl>');
    expect(s4).toContain('<p:pic>');
    expect(z.names.some((n) => /^ppt\/media\//.test(n))).toBe(true);
    const s5 = z.text('ppt/slides/slide5.xml');
    expect(s5).toContain('مرحبا');
    expect(s5).toContain('rtl="1"');
  });

  it('continues a long table on extra slides and checks chart data', async () => {
    const rows = [['#', 'Item'], ...Array.from({ length: 60 }, (_, i) => [i + 1, `Row ${i + 1}`])];
    const r = await call<Out>(pptx, { slides: [{ title: 'Big table', table: rows }] }, ctx);
    expect(r.slides).toBeGreaterThan(1);
    const all = unzipPptx(r.path);
    const text = all.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map(all.text).join('\n').replace(/<[^>]+>/g, '');
    expect(text).toContain('Row 60'); // continuation slides split runs per word
    expect(r.slides).toBe(4);
    await expect(call(pptx, { slides: [{ title: 'x', chart: { type: 'line', labels: ['a', 'b'], series: [{ name: 's', values: [1] }] } }] }, ctx)).rejects.toThrow(/has 1 values but there are 2 labels/);
  });
});

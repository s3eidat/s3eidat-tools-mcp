import { describe, expect, it } from 'vitest';
import labelsTool, { PRESETS, blocks, fill, fits, labelsOf, parseCSV, pos, type Sheet } from '../../../src/tools/web/docs/label-maker.js';
import { call, tempCtx } from '../../helpers.js';
import { pdfInfo } from './_helpers.js';

const ctx = tempCtx();
type Out = { path: string; pages: number; labels: number; perSheet: number; shrunk: number };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// Known answers from label-maker's S3_SELFTEST.
describe('label logic (label-maker self-test)', () => {
  it('positions and presets', () => {
    const S = PRESETS[0] as Sheet;
    const p0 = pos(S, 0), p2 = pos(S, 2), p3 = pos(S, 3), p20 = pos(S, 20), p21 = pos(S, 21), pn = pos(S, 4, 0.5, -1);
    expect(near(p0.x, 7.21) && near(p0.y, 15.15) && near(p2.x, 139.29) && near(p2.y, 15.15) && near(p3.x, 7.21) && near(p3.y, 53.25)).toBe(true);
    expect(near(p20.x, 139.29) && near(p20.y, 243.75) && p20.page === 0 && p21.page === 1 && near(p21.y, 15.15) && near(pn.x, 73.75) && near(pn.y, 52.25)).toBe(true);
    for (const p of PRESETS) {
      const f = fits(p as Sheet);
      expect(f.right <= f.W + 0.01 && f.bottom <= f.H + 0.01 && Math.abs(f.W - f.right - p.left) < 0.6).toBe(true); // symmetric side margins
    }
  });
  it('text modes', () => {
    expect(blocks('A\nB\n\n\nC\n  \nD\n').join('|')).toBe('A\nB|C|D');
    const csv = parseCSV('Name,City\r\n"Nasser, Sara","Amman ""JO"""\nOmar,Irbid\n');
    expect(csv).toHaveLength(3);
    expect(csv[1]).toEqual(['Nasser, Sara', 'Amman "JO"']);
    expect(parseCSV('a\tb\nc\td')[1][1]).toBe('d');
    expect(fill('{name}\n{2} {Zip}', ['Name', 'City'], ['Lina', 'Amman'])).toBe('Lina\nAmman');
    expect(labelsOf({ mode: 'list', text: 'A\n\nB', copies: 3 }).join('')).toBe('AAABBB');
    expect(labelsOf({ mode: 'same', text: 'X', count: 5 })).toHaveLength(5);
  });
});

describe('doc_labels tool', () => {
  it('30 labels from position 5 on 21-up sheets -> 2 pages', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `Name ${i + 1}\nStreet ${i + 1}`).join('\n\n');
    const r = await call<Out>(labelsTool, { text, startAt: 5 }, ctx);
    expect([r.labels, r.perSheet, r.pages]).toEqual([30, 21, 2]);
    const info = await pdfInfo(r.path);
    expect(info.pages[0].match(/Name \d+/g)).toHaveLength(17);
    expect(info.pages[1]).toContain('Name 30');
  });
  it('CSV with a template on Letter 30-up, and shrink-to-fit', async () => {
    const r = await call<Out>(labelsTool, {
      mode: 'csv', preset: 'lt-30', text: 'Name,Street,City,Postcode\nLina Haddad,12 Rainbow Street,Amman,11181\n"Nasser, Sara","Flat 3, 21 Mecca Street",Amman,11185',
      template: '{Name}\n{Street}\n{City} {Postcode}', fontSize: 18,
    }, ctx);
    expect(r.labels).toBe(2);
    expect(r.shrunk).toBe(2); // 3 lines of 18 pt don't fit a 1 in label
    const info = await pdfInfo(r.path);
    expect(info.sizes[0]).toEqual([612, 792]);
    for (const t of ['Lina Haddad', '12 Rainbow Street', 'Amman 11181', 'Nasser, Sara', 'Flat 3, 21 Mecca Street']) expect(info.text).toContain(t);
  });
  it('errors', async () => {
    await expect(call(labelsTool, { text: '' }, ctx)).rejects.toThrow(/Add some label text/);
    await expect(call(labelsTool, { text: 'x', preset: 'custom', custom: { cols: 3, rows: 7, w: 80, h: 38 } }, ctx)).rejects.toThrow(/run off the page/);
    await expect(call(labelsTool, { text: 'Москва' }, ctx)).rejects.toThrow(/Only Latin text/);
  });
});

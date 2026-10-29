import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { diff, keyer, lines, unified, wordDiff } from '../../../src/tools/web/text/diff-view.js';

// Known answers from the website's S3_SELFTEST (diff-view/app.js).
describe('text_diff', () => {
  it('unified output', () => {
    const A = 'abcdefghij'.split(''), B = 'abcdEfghijk'.split('');
    expect(unified(A, B, diff(A, B))).toBe('--- original\n+++ changed\n@@ -2,9 +2,10 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n i\n j\n+k\n');
    const a2 = ['one', 'two', 'three'], b2 = ['zero', 'one', 'three'];
    expect(unified(a2, b2, diff(a2, b2))).toBe('--- original\n+++ changed\n@@ -1,3 +1,3 @@\n+zero\n one\n-two\n three\n');
  });
  it('Myers edit distance and edges', () => {
    expect(diff('ABCABBA'.split(''), 'CBABAC'.split('')).filter((o) => o.t !== '=')).toHaveLength(5);
    expect(diff([], ['x'])).toHaveLength(1);
    expect(diff(['x'], [])).toHaveLength(1);
    expect(unified(['x'], ['x'], diff(['x'], ['x']))).toBe('');
    const far: string[] = []; for (let i = 0; i < 20; i++) far.push('l' + i);
    const far2 = far.slice(); far2[1] = 'X'; far2[18] = 'Y';
    expect(unified(far, far2, diff(far, far2)).match(/^@@/gm)).toHaveLength(2);
  });
  it('options, words, lines', () => {
    expect(keyer({ ws: true, ic: true })('  Hello   World ')).toBe('hello world');
    const w = wordDiff('the quick fox', 'the slow fox', (s) => s)!;
    expect(w[0].filter((p) => p[1]).map((p) => p[0]).join('')).toBe('quick');
    expect(w[1].filter((p) => p[1])[0][0]).toBe('slow');
    expect(lines('a\nb\n')).toHaveLength(2);
    expect(lines('a\r\nb')).toHaveLength(2);
  });
  it('fuzz: ops rebuild both sides and are minimal', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let t = 0; t < 150; t++) {
      const ra: string[] = [], rb: string[] = [], na = (rnd() * 12) | 0, nb = (rnd() * 12) | 0;
      for (let x = 0; x < na; x++) ra.push('abc'[(rnd() * 3) | 0]);
      for (let y = 0; y < nb; y++) rb.push('abc'[(rnd() * 3) | 0]);
      const ga: string[] = [], gb: string[] = [];
      let edits = 0;
      for (const q of diff(ra, rb)) {
        if (q.t !== '+') ga.push(ra[q.a]);
        if (q.t !== '-') gb.push(rb[q.b]);
        if (q.t !== '=') edits++; else if (ra[q.a] !== rb[q.b]) edits = -999;
      }
      const L: number[][] = [];
      for (let p = 0; p <= na; p++) { L.push(new Array(nb + 1).fill(0)); for (let q2 = 1; q2 <= nb && p; q2++) L[p][q2] = ra[p - 1] === rb[q2 - 1] ? L[p - 1][q2 - 1] + 1 : Math.max(L[p - 1][q2], L[p][q2 - 1]); }
      expect(ga.join('')).toBe(ra.join(''));
      expect(gb.join('')).toBe(rb.join(''));
      expect(edits).toBe(na + nb - 2 * L[na][nb]);
    }
  });
  it('runs as a tool', async () => {
    for (const ex of tool.examples!) if (ex.output) expect(await call(tool, ex.input)).toEqual(ex.output);
    const r = await call<{ changes: { removed: { marked: string }[]; added: { marked: string }[] }[] }>(tool, {
      original: 'Milk: 2 litres', changed: 'Oat milk: 2 litres',
    });
    expect(r.changes[0].removed[0].marked).toBe('[-Milk-]: 2 litres');
    expect(r.changes[0].added[0].marked).toBe('{+Oat milk+}: 2 litres');
    const same = await call<{ identical: boolean; unified: string }>(tool, { original: 'A  b', changed: 'a b', ignoreCase: true, ignoreWhitespace: true });
    expect(same).toMatchObject({ identical: true, unified: '' });
  });
});

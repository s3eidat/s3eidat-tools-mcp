import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import santa, { allowedMatrix, draw, explain, feasible, parseNames, valid } from '../../../src/tools/web/everyday/secret-santa.js';
import { makeRandInt } from '../../../src/tools/web/everyday/_random.js';

// Known answers copied from secret-santa's S3_SELFTEST.
describe('secret_santa_draw (secret-santa self-test)', () => {
  const r = makeRandInt();
  it('draws valid, unbiased assignments', () => {
    const n = 7, pairs: [number, number][] = [[0, 1], [3, 4], [2, 6]], a = allowedMatrix(n, pairs), hits = new Set<string>();
    for (let t = 0; t < 300; t++) {
      const p = draw(a, r, 2000)!;
      expect(valid(a, p)).toBe(true);
      p.forEach((j, i) => hits.add(i + '>' + j));
    }
    let edges = 0;
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) if (a[x][y]) edges++;
    expect(hits.size).toBe(edges);
    const tight = allowedMatrix(4, [[0, 1], [2, 3]]), tp = draw(tight, r, 0);
    expect(tp && valid(tight, tp)).toBe(true);
  });
  it('detects impossible draws and explains them', () => {
    expect(feasible(allowedMatrix(1, []))).toBe(false);
    expect(draw(allowedMatrix(1, []), r, 10)).toBeNull();
    expect(feasible(allowedMatrix(2, [[0, 1]]))).toBe(false);
    expect(feasible(allowedMatrix(3, [[0, 1]]))).toBe(false);
    expect(feasible(allowedMatrix(4, [[0, 1], [0, 2], [0, 3]]))).toBe(false);
    expect(explain(['A', 'B', 'C'], [[0, 1]])).toContain('Removing A ↔ B');
    expect(explain(['A', 'B', 'C', 'D'], [[0, 1], [0, 2], [0, 3]]).indexOf("A can't draw anyone")).toBe(0);
    expect(feasible(allowedMatrix(2, []))).toBe(true);
    expect(feasible(allowedMatrix(4, [[0, 1], [2, 3]]))).toBe(true);
  });
  it('parses names like the website', () => {
    expect(parseNames(['A', 'a', ' B ', 'C, D،E']).names.join('|')).toBe('A|B|C|D|E');
  });
  it('runs as a tool', async () => {
    const input = { names: ['Omar', 'Sara', 'Lina', 'Yousef', 'Huda', 'Karim', 'Maya'], exclusions: [['omar', 'Sara'], ['Yousef', 'Huda']] as [string, string][], budget: '20 JD', seed: 'x' };
    const out = await call<{ assignments: { giver: string; receiver: string }[]; budget: string }>(santa, input);
    expect(out.assignments).toHaveLength(7);
    expect(new Set(out.assignments.map((x) => x.receiver)).size).toBe(7);
    for (const x of out.assignments) {
      expect(x.giver).not.toBe(x.receiver);
      expect([x.giver, x.receiver].sort().join()).not.toBe('Omar,Sara');
      expect([x.giver, x.receiver].sort().join()).not.toBe('Huda,Yousef');
    }
    expect(out.budget).toBe('20 JD');
    expect(await call(santa, input)).toEqual(out);
    await expect(call(santa, { names: ['A', 'B', 'C'], exclusions: [['A', 'B']] })).rejects.toThrow(/Removing A ↔ B/);
    await expect(call(santa, { names: ['A', 'B'], exclusions: [['A', 'Z']] })).rejects.toThrow(/Z is not in the list/);
  });
});

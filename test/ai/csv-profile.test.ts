import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tool, { type ColumnProfile } from '../../src/tools/ai/csv-profile.js';
import { xlsxBuffer } from '../../src/tools/ai/_table.js';
import { call, tempCtx } from '../helpers.js';

type R = { rows: number; columns: number; format: string; duplicateRows: number; profile: ColumnProfile[]; warnings: string[] };
const col = (r: R, n: string) => r.profile.find((p) => p.name === n)!;

describe('ai_csv_profile', () => {
  it('profiles numbers, dates, text and finds quality problems', async () => {
    const csv = [
      'name,score,joined,city,flag',
      'Ada,10,2026-01-05,Amman,true',
      'Bob ,20,2026-03-01,Amman,false',
      'Cy,30,2025-12-31,,true',
      'Ada,10,2026-01-05,Amman,true',
      'Dee,n/a,2026-02-10,Irbid,true',
    ].join('\n');
    const r = await call<R>(tool, { csv });
    expect(r).toMatchObject({ rows: 5, columns: 5, format: 'csv', duplicateRows: 1 });
    expect(r.warnings).toContain('1 duplicate row');

    const score = col(r, 'score');
    expect(score).toMatchObject({ type: 'integer', nonNull: 5, nulls: 0, min: 10, max: 30, mean: 17.5, median: 15 });
    expect(score.stddev).toBeCloseTo(9.574271, 5); // sample stddev of 10, 20, 30, 10
    expect(score.warnings[0]).toMatch(/mixed types: integer 4, string 1/);

    expect(col(r, 'joined')).toMatchObject({ type: 'date', min: '2025-12-31', max: '2026-03-01', unique: 4 });
    const name = col(r, 'name');
    expect(name).toMatchObject({ type: 'string', unique: 4, top: [{ value: 'Ada', count: 2 }, { value: 'Bob', count: 1 }, { value: 'Cy', count: 1 }, { value: 'Dee', count: 1 }] });
    expect(name.warnings).toContain('1 value with leading/trailing spaces');
    expect(col(r, 'city')).toMatchObject({ nulls: 1, nonNull: 4, unique: 2 });
    expect(col(r, 'flag')).toMatchObject({ type: 'boolean', top: [{ value: 'true', count: 4 }, { value: 'false', count: 1 }] });
  });

  it('reads xlsx and JSON input', async () => {
    const ctx = tempCtx();
    const p = join(ctx.outDir, 't.xlsx');
    writeFileSync(p, await xlsxBuffer(['x', 'y'], [{ x: 1.5, y: 'a' }, { x: 2.5, y: 'a' }]));
    const r = await call<R>(tool, { file: p }, ctx);
    expect(r).toMatchObject({ rows: 2, format: 'xlsx' });
    expect(col(r, 'x')).toMatchObject({ type: 'number', mean: 2, median: 2 });
    expect(col(r, 'y').warnings).toContain('constant: every value is the same');
    const j = await call<R>(tool, { json: [{ a: 1 }, { a: null }, { a: 3 }] });
    expect(col(j, 'a')).toMatchObject({ nulls: 1, min: 1, max: 3 });
  });
});

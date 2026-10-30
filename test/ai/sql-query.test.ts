import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tool from '../../src/tools/ai/sql-query.js';
import { xlsxBuffer } from '../../src/tools/ai/_table.js';
import { call, tempCtx } from '../helpers.js';

type R = { columns: string[]; rows: Record<string, unknown>[]; total: number; truncated: boolean; path?: string };
const sales = { name: 'sales', csv: 'region,amount,day,ok\nNorth,10,2026-01-05,true\nSouth,5,2026-02-01,false\nNorth,7.5,2026-03-09,true\n' };

describe('ai_sql_query', () => {
  it('groups, sums and sorts typed CSV', async () => {
    const r = await call<R>(tool, { query: 'SELECT region, SUM(amount) AS revenue, COUNT(*) AS n FROM sales GROUP BY region ORDER BY revenue DESC', tables: [sales] });
    expect(r.columns).toEqual(['region', 'revenue', 'n']);
    expect(r.rows).toEqual([{ region: 'North', revenue: 17.5, n: 2 }, { region: 'South', revenue: 5, n: 1 }]);
    expect(r.total).toBe(2);
  });

  it('filters on booleans and ISO dates, uses date functions', async () => {
    const r = await call<R>(tool, { query: "SELECT day, MONTH(day) AS m FROM sales WHERE ok = true AND day >= '2026-02-01'", tables: [sales] });
    expect(r.rows).toEqual([{ day: '2026-03-09', m: 3 }]);
  });

  it('joins JSON with CSV and reads JSONL / xlsx files', async () => {
    const ctx = tempCtx();
    const jl = join(ctx.outDir, 'people.jsonl');
    writeFileSync(jl, '{"id":1,"name":"Ada"}\n{"id":2,"name":"Omar"}\n');
    const x = join(ctx.outDir, 'pets.xlsx');
    writeFileSync(x, await xlsxBuffer(['owner', 'pet'], [{ owner: 2, pet: 'cat' }, { owner: 1, pet: 'dog' }, { owner: 2, pet: 'fish' }]));
    const r = await call<R>(tool, {
      query: 'SELECT p.name, COUNT(*) AS pets FROM people p JOIN pets ON pets.owner = p.id GROUP BY p.name ORDER BY pets DESC',
      tables: [{ name: 'people', file: jl }, { name: 'pets', file: x }],
    }, ctx);
    expect(r.rows).toEqual([{ name: 'Omar', pets: 2 }, { name: 'Ada', pets: 1 }]);
    const j = await call<R>(tool, { query: 'SELECT b FROM t WHERE a > 1', tables: [{ name: 't', json: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] }] });
    expect(j.rows).toEqual([{ b: 'y' }]);
  });

  it('caps rows and writes every row to a file', async () => {
    const ctx = tempCtx();
    const csv = 'n\n' + Array.from({ length: 30 }, (_, i) => i + 1).join('\n');
    const out = join(ctx.outDir, 'out.csv');
    const r = await call<R>(tool, { query: 'SELECT n, n * 2 AS d FROM t', tables: [{ name: 't', csv }], maxRows: 5, output: out }, ctx);
    expect(r.rows).toHaveLength(5);
    expect(r.total).toBe(30);
    expect(r.truncated).toBe(true);
    const text = readFileSync(r.path!, 'utf8');
    expect(text.split('\r\n')[0]).toBe('n,d');
    expect(text.split('\r\n')[30]).toBe('30,60');
  });

  it('refuses writes, file functions, JavaScript and unknown tables', async () => {
    const t = [sales];
    await expect(call(tool, { query: 'DELETE FROM sales', tables: t })).rejects.toThrow(/Only SELECT/);
    await expect(call(tool, { query: 'DROP TABLE sales', tables: t })).rejects.toThrow(/Only SELECT/);
    await expect(call(tool, { query: 'SELECT * FROM sales; DROP TABLE sales', tables: t })).rejects.toThrow(/exactly one/);
    await expect(call(tool, { query: 'SELECT * INTO CSV("x.csv") FROM sales', tables: t })).rejects.toThrow(/INTO is not allowed/);
    await expect(call(tool, { query: 'SELECT * FROM CSV("secret.csv")', tables: t })).rejects.toThrow(/file functions/);
    await expect(call(tool, { query: 'SELECT ``process.exit()`` FROM sales', tables: t })).rejects.toThrow(/JavaScript/);
    await expect(call(tool, { query: 'SELECT region->constructor FROM sales', tables: t })).rejects.toThrow(/->/);
    await expect(call(tool, { query: 'SELECT * FROM other', tables: t })).rejects.toThrow(/Unknown table "other"/);
    await expect(call(tool, { query: 'SELEKT 1', tables: t })).rejects.toThrow(/syntax/i);
    await expect(call(tool, { query: 'SELECT SUM(amount) AS total FROM sales', tables: t })).rejects.toThrow(/reserved word/);
  });

  it('supports WITH and subqueries', async () => {
    const w = await call<R>(tool, { query: 'WITH big AS (SELECT * FROM sales WHERE amount > 6) SELECT amount FROM big ORDER BY amount', tables: [sales] });
    expect(w.rows).toEqual([{ amount: 7.5 }, { amount: 10 }]);
    const s = await call<R>(tool, { query: 'SELECT region FROM sales WHERE amount = (SELECT MAX(amount) FROM sales)', tables: [sales] });
    expect(s.rows).toEqual([{ region: 'North' }]);
  });
});

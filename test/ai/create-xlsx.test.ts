import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import tool, { colLetter } from '../../src/tools/ai/create-xlsx.js';
import { call, tempCtx } from '../helpers.js';

type R = { path: string; bytes: number; sheets: { name: string; rows: number; columns: string[]; range: string; formulas: number }[] };

async function open(p: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(p) as unknown as ArrayBuffer);
  return wb;
}

describe('ai_create_xlsx', () => {
  it('writes headers, formulas, formats, dates, totals, frozen header and filter', async () => {
    const ctx = tempCtx();
    const r = await call<R>(tool, {
      title: 'Orders Q4',
      sheets: [{
        name: 'Orders',
        columns: [
          { header: 'Item', key: 'item' }, { header: 'Qty', key: 'qty', numFmt: 'integer' },
          { header: 'Price', key: 'price', numFmt: 'usd' }, { header: 'Total', key: 'total', numFmt: '#,##0.00' }, { header: 'Date', key: 'd' },
        ],
        rows: [
          { item: 'Pen', qty: 3, price: 1.5, total: '=B2*C2', d: '2026-10-30' },
          { item: '=literal?', qty: 1, price: 12, total: '=B3*C3', d: '2026-10-31' },
        ],
        totalsRow: { qty: 'sum', Total: 'sum' },
      }, {
        name: 'Raw/Data',
        rows: [['a', 'b'], [1, 'x'], [2, 'y']],
        freezeHeader: false,
        autoFilter: false,
      }],
    }, ctx);
    expect(basename(r.path)).toBe('Orders Q4.xlsx');
    expect(r.sheets).toEqual([
      { name: 'Orders', rows: 2, columns: ['Item', 'Qty', 'Price', 'Total', 'Date'], range: 'A1:E4', formulas: 5 },
      { name: 'Raw-Data', rows: 2, columns: ['a', 'b'], range: 'A1:B3', formulas: 0 },
    ]);

    const wb = await open(r.path);
    const ws = wb.getWorksheet('Orders')!;
    expect(ws.getCell('A1').value).toBe('Item');
    expect(ws.getCell('A1').font?.bold).toBe(true);
    expect(ws.getCell('D2').value).toMatchObject({ formula: 'B2*C2' });
    expect(ws.getCell('A3').value).toMatchObject({ formula: 'literal?' });
    expect(ws.getCell('C2').numFmt).toBe('"$"#,##0.00');
    expect(ws.getCell('B2').numFmt).toBe('#,##0');
    expect(ws.getCell('E2').value).toEqual(new Date('2026-10-30T00:00:00Z'));
    expect(ws.getCell('E2').numFmt).toBe('yyyy-mm-dd');
    expect(ws.getCell('A4').value).toBe('Total');
    expect(ws.getCell('B4').value).toMatchObject({ formula: 'SUM(B2:B3)' });
    expect(ws.getCell('D4').value).toMatchObject({ formula: 'SUM(D2:D3)' });
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.getColumn(1).width).toBeGreaterThanOrEqual(8);

    const raw = wb.getWorksheet('Raw-Data')!;
    expect(raw.getCell('A1').value).toBe('a');
    expect(raw.getCell('A3').value).toBe(2);
    expect(raw.getCell('B3').value).toBe('y');
  });

  it('keeps literal text with a leading apostrophe and infers columns from objects', async () => {
    const ctx = tempCtx();
    const r = await call<R>(tool, { sheets: [{ name: 'S', rows: [{ a: "'=not a formula", b: 2 }, { a: 'x', c: true }], totalsRow: true }] }, ctx);
    expect(r.sheets[0].columns).toEqual(['a', 'b', 'c']);
    const ws = (await open(r.path)).getWorksheet('S')!;
    expect(ws.getCell('A2').value).toBe('=not a formula');
    expect(ws.getCell('C3').value).toBe(true);
    expect(ws.getCell('B4').value).toMatchObject({ formula: 'SUM(B2:B3)' });
    expect(colLetter(28)).toBe('AB');
  });
});

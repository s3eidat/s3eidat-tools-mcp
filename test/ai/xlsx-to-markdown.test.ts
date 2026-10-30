import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import tool, { cellText, isoDate } from '../../src/tools/ai/xlsx-to-markdown.js';
import { call, tempCtx } from '../helpers.js';

type Sheet = { name: string; rows: number; columns: number; shownRows: number; omittedRows: number; hidden?: boolean };
type R = { markdown?: string; sheets: Sheet[]; sheetNames: string[]; words: number };
const b64 = (b: Uint8Array) => 'base64:' + Buffer.from(b).toString('base64');

async function sampleXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sales');
  ws.getCell('B2').value = 'Item';
  ws.getCell('C2').value = 'Qty';
  ws.getCell('D2').value = 'Double';
  ws.getCell('E2').value = 'When';
  ws.getCell('B3').value = 'Tea | green';
  ws.getCell('C3').value = 5;
  ws.getCell('D3').value = { formula: 'C3*2', result: 10 };
  ws.getCell('E3').value = new Date(Date.UTC(2026, 9, 30));
  ws.getCell('E3').numFmt = 'yyyy-mm-dd';
  ws.getCell('B4').value = { richText: [{ text: 'Cof' }, { text: 'fee', font: { bold: true } }] };
  ws.getCell('C4').value = 0.1 + 0.2;
  ws.getCell('D4').value = { formula: 'C4*2' } as ExcelJS.CellFormulaValue;
  ws.getCell('E4').value = new Date(Date.UTC(2026, 0, 2, 14, 5));
  ws.getCell('E4').numFmt = 'yyyy-mm-dd hh:mm';
  ws.getCell('B5').value = { text: 'Site', hyperlink: 'https://example.com' };
  ws.mergeCells('C5:D5');
  ws.getCell('C5').value = 'merged';
  const big = wb.addWorksheet('Big');
  big.addRow(['n']);
  for (let i = 1; i <= 30; i++) big.addRow([i]);
  wb.addWorksheet('Empty');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('ai_xlsx_to_markdown', () => {
  it('formats values, trims the used range, and caps rows', async () => {
    const r = await call<R>(tool, { file: b64(await sampleXlsx()), maxRows: 10 }, tempCtx());
    expect(r.sheetNames).toEqual(['Sales', 'Big', 'Empty']);
    const sales = r.markdown!.split('## Big')[0];
    expect(sales).toBe(
      '## Sales\n\n| Item | Qty | Double | When |\n| --- | --- | --- | --- |\n' +
        '| Tea \\| green | 5 | 10 | 2026-10-30 |\n| Coffee | 0.3 | =C4*2 | 2026-01-02T14:05:00 |\n| [Site](https://example.com) | merged |  |  |\n\n',
    );
    expect(r.sheets[0]).toMatchObject({ name: 'Sales', rows: 4, columns: 4, shownRows: 4, omittedRows: 0 });
    expect(r.sheets[1]).toMatchObject({ name: 'Big', rows: 31, shownRows: 11, omittedRows: 20 });
    expect(r.markdown).toContain('| 10 |\n\n_20 more rows not shown (maxRows 10)._');
    expect(r.markdown).not.toContain('| 11 |');
    expect(r.markdown).toContain('## Empty\n\n_(empty sheet)_');
  });

  it('picks one sheet by name or number', async () => {
    const ctx = tempCtx();
    const byName = await call<R>(tool, { file: b64(await sampleXlsx()), sheet: 'big', maxRows: 2 }, ctx);
    expect(byName.markdown).toBe('## Big\n\n| n |\n| --- |\n| 1 |\n| 2 |\n\n_28 more rows not shown (maxRows 2)._\n');
    const byNum = await call<R>(tool, { file: b64(await sampleXlsx()), sheet: '3' }, ctx);
    expect(byNum.sheets.map((s) => s.name)).toEqual(['Empty']);
    await expect(call(tool, { file: b64(await sampleXlsx()), sheet: 'Nope' }, ctx)).rejects.toThrow(/No sheet "Nope". Sheets: "Sales", "Big", "Empty"/);
  });

  it('reads CSV with the delimiter sniffed, values kept as written', async () => {
    const csv = 'name;born;score\n"Ali, Jr.";2001-02-03;007\nMona;1999-12-31;9.50\n';
    const r = await call<R>(tool, { file: b64(Buffer.from(csv)) }, tempCtx());
    expect(r.markdown).toBe('## Sheet1\n\n| name | born | score |\n| --- | --- | --- |\n| Ali, Jr. | 2001-02-03 | 007 |\n| Mona | 1999-12-31 | 9.50 |\n');
  });

  it('cell helpers', () => {
    expect(isoDate(new Date(Date.UTC(2020, 1, 29)))).toBe('2020-02-29');
    expect(cellText({ error: '#DIV/0!' })).toBe('#DIV/0!');
    expect(cellText(true)).toBe('TRUE');
    expect(cellText({ sharedFormula: 'A1', result: 3 })).toBe('3');
  });
});

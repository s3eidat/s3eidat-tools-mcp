import { describe, expect, it } from 'vitest';
import sheet, { columns, dow, layout, parseNames, toCSV } from '../../../src/tools/web/docs/attendance-sheet.js';
import { call, tempCtx } from '../../helpers.js';
import { pdfInfo } from './_helpers.js';

const ctx = tempCtx();
type Out = { path: string; pages: number; columns: number; columnChunks: number; rowsPerPage: number; csv: string };

// Known answers from attendance-sheet's S3_SELFTEST.
describe('attendance logic (attendance-sheet self-test)', () => {
  it('date columns', () => {
    const nov = columns({ mode: 'month', month: '2026-11', skip: [5, 6] });
    expect(nov).toHaveLength(22);
    expect([nov[0].key, nov[4].key, nov[5].key]).toEqual(['2026-11-01', '2026-11-05', '2026-11-08']);
    expect(nov.every((c) => dow(c.day!) !== 5 && dow(c.day!) !== 6)).toBe(true);
    expect(columns({ mode: 'month', month: '2028-02', skip: [] })).toHaveLength(29);
    expect(columns({ mode: 'sessions', start: '2026-11-05', count: 3, skip: [5, 6] }).map((c) => c.key).join()).toBe('2026-11-05,2026-11-08,2026-11-09');
    const we = columns({ mode: 'month', month: '2026-11', skip: [1, 2, 3, 4, 5] });
    expect([we.length, we[0].key]).toEqual([9, '2026-11-01']);
    expect(columns({ mode: 'month', month: '2026-11', skip: [0, 1, 2, 3, 4, 5, 6] })).toHaveLength(0);
    const blank = columns({ mode: 'blank', count: 4 });
    expect([blank.length, blank[3].key]).toEqual([4, 'c4']);
  });
  it('page layout, names and CSV', () => {
    const L = layout({ paper: 'A4', orient: 'landscape', rowH: 8, num: true, total: true, cell: 'box' }, 22, 40);
    expect([L.rowsPer, L.rowPages, L.chunks, L.pages]).toEqual([19, 3, 1, 3]);
    expect(Math.abs(L.numW + L.nameW + 22 * L.colW + L.totW - 277)).toBeLessThan(1e-9);
    const S = layout({ paper: 'A4', orient: 'landscape', rowH: 13, num: true, total: true, cell: 'sign' }, 22, 10);
    expect([S.chunks, S.per, S.pages]).toEqual([3, 8, 3]);
    expect(parseNames('1. Ahmad\n\n 2) Lina \nOmar\tx\n').join('|')).toBe('Ahmad|Lina|Omar');
    expect(toCSV(['A, B', 'Q"x'], [{ key: '2026-11-01', day: 1, n: 1 }], { 'A, B\u00012026-11-01': 'P' }, true))
      .toBe('Name,2026-11-01,Present,Absent,Late\r\n"A, B",P,1,0,0\r\n"Q""x",,0,0,0\r\n');
  });
});

describe('doc_attendance_sheet tool', () => {
  it('month sheet: one page, all names and day headers', async () => {
    const r = await call<Out>(sheet, { names: '1. Ahmad Khalil\n2. Lina Haddad\n3. Omar Saleh', group: 'Grade 7 B', teacher: 'Ms. Rana', month: '2026-11', skip: [5, 6] }, ctx);
    expect([r.pages, r.columns, r.columnChunks]).toEqual([1, 22, 1]);
    expect(r.csv.split('\r\n')[1]).toBe('Ahmad Khalil' + ','.repeat(22));
    const info = await pdfInfo(r.path);
    for (const t of ['Attendance', 'Grade 7 B', 'November 2026', 'Teacher: Ms. Rana', 'Ahmad Khalil', 'Omar Saleh', 'Sun 1', 'Thu 26', 'Total', 'present', 'Signature', 'Page 1 of 1']) {
      expect(info.text).toContain(t);
    }
  });
  it('signature cells split the dates over pages; 40 names take more pages', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `Student ${i + 1}`);
    const r = await call<Out>(sheet, { names, month: '2026-11', skip: [5, 6], cell: 'sign', extraRows: 0 }, ctx);
    expect([r.columnChunks, r.pages]).toEqual([3, 3]);
    const info = await pdfInfo(r.path);
    expect(info.pages[2]).toContain('Student 10');
    expect(info.pages[2]).toContain('Page 3 of 3');
    const big = await call<Out>(sheet, { names: Array.from({ length: 38 }, (_, i) => `N${i}`), mode: 'blank', count: 10, title: 'Club sign-in' }, ctx);
    expect(big.pages).toBe(3);
    expect((await pdfInfo(big.path)).text).toContain('Date: ____________');
  });
});

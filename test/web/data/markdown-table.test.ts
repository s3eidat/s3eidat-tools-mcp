import { describe, expect, it } from 'vitest';
import tools, { escCell, parseAny, parseCSV, parseMarkdown, toMarkdown } from '../../../src/tools/web/data/markdown-table.js';
import { call } from '../../helpers.js';

const [mdTool, parseTool] = tools;

// Known answers from the website's S3_SELFTEST.
describe('markdown-table self-test', () => {
  it('matches the website', () => {
    const md = toMarkdown([['Name', 'Qty'], ['Apple', '3']], ['left', 'right'], true);
    expect(md).toBe('| Name  | Qty |\n| :---- | --: |\n| Apple |   3 |');
    expect(toMarkdown([['a', 'b'], ['x', 'y']], ['center', 'none'], false)).toBe('| a | b |\n| :-: | --- |\n| x | y |');
    const esc = toMarkdown([['h'], ['a|b']], [], true);
    expect(esc).toBe('| h    |\n| ---- |\n| a\\|b |');
    expect(parseMarkdown(esc)!.rows[1][0]).toBe('a|b');
    expect(toMarkdown([['Title'], ['x']], ['center'], true)).toBe('| Title |\n| :---: |\n|   x   |');
    const back = parseMarkdown(md)!;
    expect(back.aligns).toEqual(['left', 'right']);
    expect(back.rows).toEqual([['Name', 'Qty'], ['Apple', '3']]);
    expect(parseCSV('a,"b,c"\n"d ""q""",e')).toEqual([['a', 'b,c'], ['d "q"', 'e']]);
    expect(parseCSV('x;y\n1;2')).toEqual([['x', 'y'], ['1', '2']]);
    expect(parseAny('n\tv\r\n1\t2\r\n').rows).toEqual([['n', 'v'], ['1', '2']]);
    expect(parseMarkdown('just text\nmore')).toBeNull();
    expect(escCell('line1\nline2')).toBe('line1<br>line2');
  });
});

describe('markdown_table / markdown_table_parse tools', () => {
  it('builds tables from CSV, JSON and rows', async () => {
    const r = await call<{ result: string; rows: number }>(mdTool, { text: 'Name,Qty\nApple,3', align: ['left', 'right'] });
    expect(r.result).toBe('| Name  | Qty |\n| :---- | --: |\n| Apple |   3 |');
    const j = await call<{ result: string }>(mdTool, { text: '[{"a":1,"b":"x|y"},{"a":2,"c":null}]', pretty: false });
    expect(j.result).toBe('| a | b | c |\n| --- | --- | --- |\n| 1 | x\\|y |  |\n| 2 |  |  |');
    const rows = await call<{ result: string }>(mdTool, { rows: [[1, 2], [3, 4]], header: false, align: 'center' });
    expect(rows.result).toBe('| Column 1 | Column 2 |\n| :------: | :------: |\n|    1     |    2     |\n|    3     |    4     |');
    const re = await call<{ result: string }>(mdTool, { text: '|a|b|\n|-|-:|\n|long cell|1|' });
    expect(re.result).toBe('| a         |   b |\n| --------- | --: |\n| long cell |   1 |');
  });
  it('parses a table back', async () => {
    const p = await call<{ data: unknown[]; aligns: string[] }>(parseTool, { text: '| Name | Qty |\n| :-- | --: |\n| Apple | 3 |\n| a\\|b | x<br>y |' });
    expect(p.aligns).toEqual(['left', 'right']);
    expect(p.data).toEqual([{ Name: 'Apple', Qty: '3' }, { Name: 'a|b', Qty: 'x\ny' }]);
    const c = await call<{ result: string }>(parseTool, { text: '| a | b |\n|---|---|\n| 1 | 2, 3 |', as: 'csv' });
    expect(c.result).toBe('a,b\r\n1,"2, 3"\r\n');
    await expect(call(parseTool, { text: 'no table' })).rejects.toThrow(/No Markdown table/);
  });
});

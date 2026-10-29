import { describe, expect, it } from 'vitest';
import tools, { csvToJson, detectDelimiter, headers, jsonToCsv, parseCSV } from '../../../src/tools/web/data/csv-json.js';
import { call } from '../../helpers.js';

const [c2j, j2c] = tools;

// Known answers from the website's S3_SELFTEST.
describe('csv-json self-test', () => {
  it('parses RFC 4180', () => {
    expect(JSON.stringify(parseCSV('a,b\r\n1,"x, y"\n2,"multi\nline ""q"""\n', ','))).toBe('[["a","b"],["1","x, y"],["2","multi\\nline \\"q\\""]]');
    expect(parseCSV('a,b\n', ',')).toHaveLength(1);
    expect(parseCSV('a,,\n,b', ',')).toEqual([['a', '', ''], ['', 'b']]);
    expect(() => parseCSV('a,"b\nc', ',')).toThrow(/line 1/);
  });
  it('detects delimiters, types and headers', () => {
    expect(detectDelimiter('a;b;c\n1;2,5;3\n4;5;6')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('x|y\n"1|2"|3')).toBe('|');
    const j = csvToJson('id,zip,ok,n\n1,007,true,\n2,10,false,3.5', { delim: 'auto', header: true, types: true, shape: 'objects' });
    expect(JSON.stringify(j.data)).toBe('[{"id":1,"zip":"007","ok":true,"n":null},{"id":2,"zip":10,"ok":false,"n":3.5}]');
    expect(headers(['a', 'a', ''])).toEqual(['a', 'a_2', 'column_3']);
  });
  it('writes CSV', () => {
    const c = jsonToCsv([{ a: { b: 1 }, t: [1, 2], s: 'say "hi", ok' }, { a: { b: 2 }, x: null }], { delim: ',', header: true, safe: true });
    expect(c.csv).toBe('a.b,t.0,t.1,s,x\r\n1,1,2,"say ""hi"", ok",\r\n2,,,,\r\n');
    expect(jsonToCsv([{ f: '=SUM(A1)', n: -5 }], { delim: ',', header: false, safe: true }).csv).toBe("'=SUM(A1),-5\r\n");
  });
  it('round trips', () => {
    const src = [{ name: 'Ada', note: 'a,b\n"c"' }, { name: 'عمر', note: '' }];
    const back = csvToJson(jsonToCsv(src, { delim: ';', header: true, safe: false }).csv, { delim: 'auto', header: true, types: false, shape: 'objects' }).data;
    expect(back).toEqual(src);
  });
});

describe('csv_to_json / json_to_csv tools', () => {
  it('converts both ways', async () => {
    const r = await call<{ rows: number; delimiter: string; result: string }>(c2j, { text: 'a\tb\n1\t2\n' });
    expect(r.delimiter).toBe('tab');
    expect(JSON.parse(r.result)).toEqual([{ a: 1, b: 2 }]);
    const arr = await call<{ result: string }>(c2j, { text: 'a,b\n1,2', shape: 'arrays', types: false });
    expect(JSON.parse(arr.result)).toEqual([['a', 'b'], ['1', '2']]);
    const back = await call<{ result: string; columns: string[] }>(j2c, { text: '[{"a":1,"b":"x"}]', delimiter: 'tab', bom: true });
    expect(back.result).toBe('﻿a\tb\r\n1\tx\r\n');
    await expect(call(j2c, { text: '42' })).rejects.toThrow(/array or object/);
  });
});

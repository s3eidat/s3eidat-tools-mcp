import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tools, { jsonQuery, locate, measure, sortDeep } from '../../../src/tools/web/data/json-studio.js';
import { call, tempCtx } from '../../helpers.js';

const [fmt, query] = tools;

describe('json-studio self-test', () => {
  it('matches the website', () => {
    expect(locate('Unexpected token } in JSON at position 9', '{"a":1,\n}')).toEqual({ line: 2, col: 2 });
    expect(locate("JSON.parse: expected ',' at line 3 column 5 of the JSON data", '')).toEqual({ line: 3, col: 5 });
    expect(JSON.stringify(sortDeep({ b: 1, a: { d: 1, c: 2 } }))).toBe('{"a":{"c":2,"d":1},"b":1}');
    const m = measure({ a: [1, 2, { b: 3 }] });
    expect([m.depth, m.keys]).toEqual([3, 2]);
  });
});

describe('json_format', () => {
  const ctx = tempCtx();
  it('formats, sorts and minifies', async () => {
    const r = await call<{ valid: boolean; result: string; stats: { keys: number } }>(fmt, { text: '{"b":1,"a":[1,2]}', sortKeys: true }, ctx);
    expect(r.result).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": 1\n}');
    expect(r.stats.keys).toBe(2);
    expect((await call<{ result: string }>(fmt, { text: '{ "a" : [ 1 ] }', mode: 'minify' }, ctx)).result).toBe('{"a":[1]}');
    expect((await call<{ result: string }>(fmt, { text: '{"a":{"b":1}}', indent: 'tab' }, ctx)).result).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}');
    expect((await call<{ result: string }>(fmt, { text: '[1]', indent: '4' }, ctx)).result).toBe('[\n    1\n]');
  });
  it('reports line and column', async () => {
    const v = await call(fmt, { text: '{"a":1,\n}', mode: 'validate' }, ctx);
    expect(v).toMatchObject({ valid: false, line: 2, column: 1 });
    const end = await call(fmt, { text: '{"a":\n  [1,', mode: 'validate' }, ctx);
    expect(end).toMatchObject({ valid: false, line: 2 });
    await expect(call(fmt, { text: '{"a" 1}' }, ctx)).rejects.toThrow(/line 1, column 6[\s\S]*\^/);
  });
  it('reads a path and writes an output file', async () => {
    const p = join(ctx.outDir, 'in.json');
    writeFileSync(p, '﻿{"x":true}');
    const r = await call<{ path: string }>(fmt, { path: p, mode: 'minify', output: join(ctx.outDir, 'out.json') }, ctx);
    expect(readFileSync(r.path, 'utf8')).toBe('{"x":true}');
  });
});

describe('json_query', () => {
  const store = {
    store: {
      book: [
        { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
        { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
        { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
        { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
      ],
      bicycle: { color: 'red', price: 19.95 },
      'odd key': 1,
    },
  };
  const q = (e: string) => jsonQuery(store, e).map((m) => m.value);
  it('evaluates the JSONPath subset', () => {
    expect(q('$.store.book[*].author')).toEqual(['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']);
    expect(q('$..author')).toHaveLength(4);
    expect(q('$.store.*')).toHaveLength(3);
    expect(q('$..price')).toEqual([8.95, 12.99, 8.99, 22.99, 19.95]);
    expect(q('$..book[2].title')).toEqual(['Moby Dick']);
    expect(q('$..book[-1].title')).toEqual(['The Lord of the Rings']);
    expect(q('$..book[0,1].price')).toEqual([8.95, 12.99]);
    expect(q('$..book[:2].price')).toEqual([8.95, 12.99]);
    expect(q('$..book[::-1].price')).toEqual([22.99, 8.99, 12.99, 8.95]);
    expect(q('$..book[1:-1].price')).toEqual([12.99, 8.99]);
    expect(q('$..book[?(@.price > 9 || @.isbn == "0-553-21311-3")].price')).toEqual([12.99, 8.99, 22.99]);
    expect(q('$..book[?(!@.isbn)].price')).toEqual([8.95, 12.99]);
    expect(q('$..book[?(@.isbn)].title')).toEqual(['Moby Dick', 'The Lord of the Rings']);
    expect(q('$..book[?(@.price < 10)].title')).toEqual(['Sayings of the Century', 'Moby Dick']);
    expect(q("$..book[?(@.category == 'fiction' && @.price > 20)].author")).toEqual(['J. R. R. Tolkien']);
    expect(q('$..book[?(@.author =~ /^h/i)].price')).toEqual([8.99]);
    expect(q("$.store['odd key']")).toEqual([1]);
    expect(q('store.bicycle.color')).toEqual(['red']);
    expect(q('$')).toEqual([store]);
    expect(jsonQuery(store, "$.store['odd key']")[0].path).toBe('$.store["odd key"]');
    expect(jsonQuery(store, '$..book[?(@.price > 20)]')[0].path).toBe('$.store.book[3]');
    expect(() => jsonQuery(store, '$.a[')).toThrow(/missing/);
  });
  it('runs as a tool', async () => {
    const r = await call<{ count: number; matches: { path: string; value: unknown }[] }>(query, {
      text: '{"store":{"book":[{"title":"A","price":8},{"title":"B","price":12}]}}',
      query: '$..book[?(@.price < 10)].title',
    });
    expect(r).toEqual({ count: 1, matches: [{ path: '$.store.book[0].title', value: 'A' }] });
  });
});

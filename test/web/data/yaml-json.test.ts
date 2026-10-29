import { describe, expect, it } from 'vitest';
import tools, { jsonToYaml, yamlError, yamlToJson } from '../../../src/tools/web/data/yaml-json.js';
import { locate } from '../../../src/tools/web/data/json-studio.js';
import { call } from '../../helpers.js';

const [y2j, j2y] = tools;
const o = { indent: 2 };
const throwsMsg = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as Error).message || String(e); } };

// Known answers from the website's S3_SELFTEST.
describe('yaml-json self-test', () => {
  it('anchors, merge keys and documents', () => {
    const anchors = yamlToJson('base: &b {x: 1, y: 2}\nchild:\n  <<: *b\n  y: 3\nlist: [*b]\n', o).value as Record<string, unknown[]>;
    expect(anchors.child).toEqual({ x: 1, y: 3 });
    expect(anchors.list[0]).toEqual({ x: 1, y: 2 });
    const multi = yamlToJson('a: 1\n---\nb: [1, two]\n---\n', o);
    expect(multi.value).toEqual([{ a: 1 }, { b: [1, 'two'] }, null]);
    expect(multi.docs).toBe(3);
    expect(yamlToJson('a: 1', { indent: 2, always: true }).value).toEqual([{ a: 1 }]);
  });
  it('is safe', () => {
    expect(throwsMsg(() => yamlToJson("f: !!js/function 'function () { return 1 }'\n", o))).toMatch(/unknown/i);
    expect(throwsMsg(() => yamlToJson("x: !!python/object/apply:os.system ['ls']", o))).toBeTruthy();
    expect(throwsMsg(() => yamlToJson('r: !!js/regexp /x/', o))).toBeTruthy();
    let err: unknown;
    try { yamlToJson('a: 1\nb: [1, 2\nc: 3\n', o); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(yamlError(err).at!.line).toBeGreaterThanOrEqual(2);
    const bomb = 'a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n' +
      'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\ne: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]\nf: &f [*e, *e, *e, *e, *e, *e, *e, *e, *e, *e]\ng: [*f, *f, *f, *f, *f, *f, *f, *f, *f, *f]\n';
    expect(throwsMsg(() => yamlToJson(bomb, o))).toMatch(/alias bomb/);
  });
  it('types', () => {
    expect(yamlToJson("a: yes\nb: 010\nc: 0x1F\nd: ~\ne: 1e3\nf: '1.10'", o).value).toEqual({ a: 'yes', b: 10, c: 31, d: null, e: 1000, f: '1.10' });
    expect((yamlToJson('d: 2026-10-26', o).value as { d: unknown }).d).toBeInstanceOf(Date);
    expect(yamlToJson('d: 2026-10-26', o).text).toBe('{\n  "d": "2026-10-26T00:00:00.000Z"\n}\n');
    expect((yamlToJson('s: |\n  line1\n  line2\n', o).value as { s: string }).s).toBe('line1\nline2\n');
    expect(yamlToJson('s: !!set {a, b}', o).value).toEqual({ s: { a: null, b: null } });
  });
  it('JSON → YAML', () => {
    const obj = { name: 'S3', list: [1, 'two', true, null, 2.5], nested: { 'a b': 'x: y', quote: 'it\'s "q"', num: '123', empty: '', multi: 'l1\nl2' } };
    const y = jsonToYaml(JSON.stringify(obj), o).text;
    expect(yamlToJson(y, o).value).toEqual(obj);
    expect(y).toMatch(/num: '123'/);
    expect(jsonToYaml('{"b":1,"a":{"d":1,"c":2}}', { indent: 2, sort: true }).text).toBe('a:\n  c: 2\n  d: 1\nb: 1\n');
    expect(jsonToYaml('[{"a":1},{"b":2}]', { indent: 2, multi: true }).text).toBe('---\na: 1\n---\nb: 2\n');
    expect(jsonToYaml('{"a":{"b":1}}', { indent: 4 }).text).toBe('a:\n    b: 1\n');
    expect(locate('Unexpected token } in JSON at position 9', '{"a":1,\n}')).toEqual({ line: 2, col: 2 });
  });
});

describe('yaml_to_json / json_to_yaml tools', () => {
  it('converts and reports errors with a line', async () => {
    const r = await call<{ result: string; documents: number }>(y2j, { text: 'a: 1\n---\nb: 2\n', indent: 4 });
    expect(r.documents).toBe(2);
    expect(r.result).toBe('[\n    {\n        "a": 1\n    },\n    {\n        "b": 2\n    }\n]\n');
    await expect(call(y2j, { text: 'a: 1\nb: [1, 2\nc: 3\n' })).rejects.toThrow(/YAML error at line \d+, column \d+/);
    const y = await call<{ result: string }>(j2y, { text: '{"k":[1,2]}' });
    expect(y.result).toBe('k:\n  - 1\n  - 2\n');
    await expect(call(j2y, { text: '{"a":1,\n}' })).rejects.toThrow(/line 2, column 1/);
  });
});

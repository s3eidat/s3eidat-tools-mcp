import { describe, expect, it } from 'vitest';
import tool, { BY, CODES, codeFromHash, filter } from '../../../src/tools/web/dev/http-status.js';
import { call } from '../../helpers.js';

describe('http-status self-test', () => {
  it('data and search', () => {
    const std = CODES.filter((c) => !c.unofficial);
    expect(Object.keys(BY)).toHaveLength(CODES.length);
    expect(std.every((c) => c.code >= 100 && c.code < 600)).toBe(true);
    expect(std).toHaveLength(62);
    expect([BY[404].name, BY[422].name, BY[308].name]).toEqual(['Not Found', 'Unprocessable Content', 'Permanent Redirect']);
    const teapot = filter('teapot', '', false);
    expect(teapot.map((c) => c.code)).toEqual([418]);
    const fifty = filter('50', '', false);
    expect(fifty).toHaveLength(9);
    expect(fifty.every((c) => String(c.code).startsWith('50'))).toBe(true);
    const five = filter('', '5', false);
    expect(five).toHaveLength(11);
    expect(five.every((c) => c.code >= 500 && c.code < 600)).toBe(true);
    expect(filter('too many', '', false).some((c) => c.code === 429)).toBe(true);
    expect(filter('524', '', false)).toHaveLength(0);
    expect(filter('524', '', true)).toHaveLength(1);
    expect([codeFromHash('#404'), codeFromHash('#999'), codeFromHash('#4044')]).toEqual([404, null, null]);
  });
});

describe('http_status tool', () => {
  it('runs', async () => {
    const r = await call<Record<string, any>>(tool, { query: '404' });
    expect(r.count).toBe(1);
    expect(r.results[0]).toMatchObject({ code: 404, name: 'Not Found', class: '4xx', className: 'Client error', spec: 'RFC 9110', nonStandard: false });
    expect((await call<Record<string, any>>(tool, { query: '499' })).results[0].nonStandard).toBe(true);
    expect((await call<Record<string, any>>(tool, { query: 'redirect', class: '3' })).results.every((x: { code: number }) => x.code >= 300 && x.code < 400)).toBe(true);
  });
});

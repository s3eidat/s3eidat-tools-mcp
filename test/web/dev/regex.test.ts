import { describe, expect, it } from 'vitest';
import tool, { captureNames, runRegex } from '../../../src/tools/web/dev/regex.js';
import { call } from '../../helpers.js';

describe('regex-playground self-test', () => {
  it('groups, replace, non-global, empty matches, unicode, errors', async () => {
    let r = await runRegex({ source: '(\\d+)-(?<w>[a-z]+)', flags: 'g', text: '1-ab 22-cd x', replace: '$<w>:$1' });
    expect(r.matches).toHaveLength(2);
    expect(r.matches![1].index).toBe(5);
    expect(r.matches![1].groups[0]).toBe('22');
    expect(r.matches![1].named!.w).toBe('cd');
    expect(r.replaced).toBe('ab:1 cd:22 x');
    r = await runRegex({ source: 'a', flags: '', text: 'aaa', replace: 'b' });
    expect([r.matches!.length, r.replaced]).toEqual([1, 'baa']);
    r = await runRegex({ source: '', flags: 'g', text: 'ab' });
    expect(r.matches).toHaveLength(3);
    r = await runRegex({ source: '\\p{L}+', flags: 'gu', text: 'مرحبا hi' });
    expect(r.matches!.map((m) => m.text)).toEqual(['مرحبا', 'hi']);
    r = await runRegex({ source: '(', flags: 'g', text: 'x' });
    expect(r.error).toBeTruthy();
  });
  it('kills catastrophic backtracking', async () => {
    const r = await runRegex({ source: '^(a+)+$', flags: '', text: 'a'.repeat(40) + '!' }, 300);
    expect(r.timeout).toBe(true);
    expect((await runRegex({ source: 'b', flags: 'g', text: 'abc' })).matches).toHaveLength(1);
  });
  it('captureNames', () => {
    expect(captureNames('(a)(?:b)(?<x>c)[(](?<=d)\\((e)')).toEqual([null, 'x', null]);
  });
});

describe('regex_test tool', () => {
  it('runs', async () => {
    const r = await call<Record<string, any>>(tool, { pattern: '(\\d+)-(?<w>[a-z]+)', text: '1-ab 22-cd x', replace: '$<w>:$1' });
    expect(r.count).toBe(2);
    expect(r.groupNames).toEqual([null, 'w']);
    expect(r.matches[1]).toEqual({ index: 5, length: 5, text: '22-cd', groups: ['22', 'cd'], named: { w: 'cd' } });
    expect(r.replaced).toBe('ab:1 cd:22 x');
    await expect(call(tool, { pattern: '(', text: 'x' })).rejects.toThrow(/Unterminated group/);
    await expect(call(tool, { pattern: '^(a+)+$', flags: '', text: 'a'.repeat(40) + '!', timeoutMs: 200 })).rejects.toThrow(/backtracking/);
  });
});

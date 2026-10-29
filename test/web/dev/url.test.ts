import { describe, expect, it } from 'vitest';
import tools, { buildQuery, decode, encode, parseQuery, stripTracking, toURL } from '../../../src/tools/web/dev/url.js';
import { call } from '../../helpers.js';

const [enc, dec, parse] = tools;
const SAMPLE =
  'https://s3eidat.github.io/shop/item?id=42&color=sky%20blue&utm_source=newsletter&utm_medium=email&utm_campaign=autumn_sale&fbclid=IwAR0xYz&q=caf%C3%A9#reviews';

describe('url-toolkit self-test', () => {
  it('encode/decode', () => {
    expect(encode('a b&c/d?é', 'component')).toBe('a%20b%26c%2Fd%3F%C3%A9');
    expect(encode('a b&c/d?é', 'full')).toBe('a%20b&c/d?%C3%A9');
    expect(decode('x+y%20%E2%9C%93', 'component', true)).toBe('x y ✓');
    expect(decode('x+y', 'component', false)).toBe('x+y');
    expect(() => decode('%E2%9C', 'component')).toThrow();
  });
  it('query parse/build, strip tracking, toURL', () => {
    expect(JSON.stringify(parseQuery('?a=1&b=x+y&flag&c=%E2%9C%93&a=2'))).toBe('[["a","1"],["b","x y"],["flag",null],["c","✓"],["a","2"]]');
    expect(buildQuery([['a', '1'], ['flag', null], ['sp ace', 'é&']])).toBe('a=1&flag&sp%20ace=%C3%A9%26');
    const r = stripTracking(SAMPLE)!;
    expect(r.removed).toBe(4);
    expect(r.href).toBe('https://s3eidat.github.io/shop/item?id=42&color=sky%20blue&q=caf%C3%A9#reviews');
    expect(stripTracking('https://s3eidat.github.io/?utm_source=x')!.href).toBe('https://s3eidat.github.io/');
    expect(stripTracking('https://s3eidat.github.io/?b=a+b')!.removed).toBe(0);
    expect(stripTracking('https://s3eidat.github.io/?b=a+b')!.href).toContain('a+b');
    expect(toURL('s3eidat.github.io/tools')?.protocol).toBe('https:');
    expect(toURL('not a url at all')).toBeNull();
  });
});

describe('url tools', () => {
  it('runs', async () => {
    expect(await call(enc, { text: 'a b' })).toEqual({ result: 'a%20b' });
    expect(await call(dec, { text: 'a+b', plusAsSpace: true })).toEqual({ result: 'a b' });
    await expect(call(dec, { text: '%E2%9C' })).rejects.toThrow(/Malformed/);
    const p = await call<{ parts: Record<string, unknown>; params: unknown[]; trackingCount: number; cleanUrl: string }>(parse, { url: SAMPLE, stripTracking: true });
    expect(p.parts).toMatchObject({ protocol: 'https', host: 's3eidat.github.io', path: '/shop/item', fragment: 'reviews', defaultPort: '443' });
    expect(p.params).toHaveLength(7);
    expect(p.trackingCount).toBe(4);
    expect(p.cleanUrl).toBe('https://s3eidat.github.io/shop/item?id=42&color=sky%20blue&q=caf%C3%A9#reviews');
  });
});

import { describe, expect, it } from 'vitest';
import tools, { ALPHA, inspect, nanoid, ulid, uuid4, uuid7 } from '../../../src/tools/web/dev/uuid.js';
import { call } from '../../helpers.js';

const [gen, insp] = tools;
const V = /^[0-9a-f]{8}-[0-9a-f]{4}-([47])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid-forge self-test', () => {
  it('v4 and v7 ordering', () => {
    const a = uuid4();
    expect(V.test(a) && a[14] === '4').toBe(true);
    const seen = new Set<string>();
    let prev = '';
    for (let i = 0; i < 2000; i++) {
      const u = uuid7(1645557742000);
      expect(V.test(u) && u[14] === '7' && u > prev && !seen.has(u)).toBe(true);
      seen.add(u);
      prev = u;
    }
    const ins = inspect(uuid7(1645557742000 + 99999));
    expect([ins.version, ins.ms]).toEqual([7, 1645557742000 + 99999]);
  });
  it('RFC 9562 vectors, ULID, NanoID, validator', () => {
    expect(inspect('017F22E2-79B0-7CC3-98C4-DC0C0C07398F').ms).toBe(1645557742000);
    expect(inspect('C232AB00-9414-11EC-B3C8-9F6BDECED846').ms).toBe(1645557742000);
    expect(inspect('1EC9414C-232A-6B00-B3C8-9F6BDECED846').ms).toBe(1645557742000);
    expect(inspect('{919108f7-52d1-4320-9bac-f847db4148a8}').version).toBe(4);
    expect(inspect('01ARZ3NDEKTSV4RRFFQ69G5FAV').ms).toBe(1469922850259);
    let prev = '';
    for (let j = 0; j < 500; j++) {
      const l = ulid(1469922850259);
      expect(l.length === 26 && l > prev && l.startsWith('01ARZ3NDEK')).toBe(true);
      prev = l;
    }
    expect(nanoid(21, ALPHA['A-Za-z0-9_-'])).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(nanoid(50, 'ab')).toMatch(/^[ab]{50}$/);
    expect(Array.from(nanoid(5, '\u{1F600}\u{1F603}'))).toHaveLength(5);
    expect(inspect('not-a-uuid').ok).toBe(false);
    expect(inspect('00000000-0000-0000-0000-000000000000').kind).toBe('Nil UUID');
  });
});

describe('id tools', () => {
  it('generates', async () => {
    const r = await call<{ ids: string[] }>(gen, { kind: 'v7', count: 50, noDashes: true, uppercase: true });
    expect(r.ids).toHaveLength(50);
    expect(r.ids.every((x) => /^[0-9A-F]{32}$/.test(x))).toBe(true);
    expect([...r.ids].sort()).toEqual(r.ids);
    const n = await call<{ ids: string[]; bitsOfRandomness: number }>(gen, { kind: 'nanoid', length: 10, alphabet: '0-9' });
    expect(n.ids[0]).toMatch(/^\d{10}$/);
    expect(n.bitsOfRandomness).toBe(33);
    expect((await call<{ ids: string[] }>(gen, { kind: 'ulid' })).ids[0]).toMatch(/^[0-9a-z]{26}$/);
    await expect(call(gen, { kind: 'nanoid', alphabet: 'aaa' })).rejects.toThrow(/2 different/);
  });
  it('inspects', async () => {
    expect(await call(insp, { id: '017F22E2-79B0-7CC3-98C4-DC0C0C07398F' })).toMatchObject({ valid: true, version: 7, createdAt: '2022-02-22T19:22:22.000Z' });
    expect(await call(insp, { id: 'nope' })).toEqual({ valid: false });
  });
});

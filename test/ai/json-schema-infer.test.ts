import { describe, expect, it } from 'vitest';
import tool from '../../src/tools/ai/json-schema-infer.js';
import validate from '../../src/tools/ai/json-schema-validate.js';
import { call } from '../helpers.js';

type R = { schema: Record<string, unknown>; samples: number };

describe('ai_json_schema_infer', () => {
  it('infers types, required keys, nullable and formats', async () => {
    const samples = [
      { id: 1, price: 2, email: 'a@b.co', at: '2026-10-30T09:00:00Z', day: '2026-10-30', site: 'https://s3eidat.github.io', uid: '123e4567-e89b-12d3-a456-426614174000', note: null, tags: ['x'] },
      { id: 2, price: 2.5, email: 'c@d.org', at: '2026-10-31T10:30:00+03:00', day: '2026-11-01', site: 'http://x.io/a', uid: '00000000-0000-4000-8000-000000000000', note: 'hi', tags: [], extra: true },
    ];
    const r = await call<R>(tool, { samples });
    expect(r.samples).toBe(2);
    expect(r.schema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        id: { type: 'integer' },
        price: { type: 'number' },
        email: { type: 'string', format: 'email' },
        at: { type: 'string', format: 'date-time' },
        day: { type: 'string', format: 'date' },
        site: { type: 'string', format: 'uri' },
        uid: { type: 'string', format: 'uuid' },
        note: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        extra: { type: 'boolean' },
      },
      required: ['id', 'price', 'email', 'at', 'day', 'site', 'uid', 'note', 'tags'],
    });
    // The samples validate against the inferred schema.
    for (const s of samples) expect((await call<{ valid: boolean }>(validate, { data: s, schema: r.schema })).valid).toBe(true);
  });

  it('merges array items, makes enums on request, strict objects', async () => {
    const r = await call<R>(tool, {
      text: '[{"status":"open","n":1},{"status":"closed"},{"status":"open","n":2.5}]',
      enums: true, additionalProperties: false, title: 'Orders',
    });
    expect(r.schema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Orders',
      type: 'array',
      items: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['closed', 'open'] }, n: { type: 'number' } },
        required: ['status'],
        additionalProperties: false,
      },
    });
  });

  it('reads JSONL as one sample per line and eachItem splits an array', async () => {
    const jl = await call<R>(tool, { text: '{"a":1}\n{"a":"x","b":2}' });
    expect(jl.samples).toBe(2);
    expect(jl.schema).toMatchObject({ type: 'object', properties: { a: { type: ['string', 'integer'] }, b: { type: 'integer' } }, required: ['a'] });
    const each = await call<R>(tool, { samples: [[{ a: 1 }, { a: 2 }]], eachItem: true });
    expect(each.samples).toBe(2);
    expect(each.schema.type).toBe('object');
  });
});

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tool from '../../src/tools/ai/json-schema-validate.js';
import { call, tempCtx } from '../helpers.js';

type R = { valid: boolean; errorCount: number; draft: string; errors: { instancePath: string; keyword: string; message: string; params: Record<string, unknown> }[]; ignoredFormats?: string[] };

const schema = {
  type: 'object',
  required: ['name', 'email'],
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0 },
    tags: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

describe('ai_json_schema_validate', () => {
  it('accepts valid data (draft-07 by default)', async () => {
    const r = await call<R>(tool, { data: { name: 'Omar', email: 'o@s3eidat.dev', age: 20, tags: ['a'] }, schema });
    expect(r).toMatchObject({ valid: true, errorCount: 0, errors: [], draft: 'draft-07' });
  });

  it('reports every error with instancePath, message and params', async () => {
    const r = await call<R>(tool, { dataText: '{"name":"","email":"nope","age":-1,"tags":[1],"x":true}', schema: JSON.stringify(schema) });
    expect(r.valid).toBe(false);
    const by = Object.fromEntries(r.errors.map((e) => [`${e.instancePath}:${e.keyword}`, e]));
    expect(Object.keys(by).sort()).toEqual([':additionalProperties', '/age:minimum', '/email:format', '/name:minLength', '/tags/0:type'].sort());
    expect(by[':additionalProperties'].params).toEqual({ additionalProperty: 'x' });
    expect(by['/age:minimum'].message).toBe('must be >= 0');
    const missing = await call<R>(tool, { data: {}, schema });
    expect(missing.errors.map((e) => e.params.missingProperty).sort()).toEqual(['email', 'name']);
  });

  it('uses draft 2020-12 when $schema says so (prefixItems)', async () => {
    const s = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', prefixItems: [{ type: 'number' }, { type: 'string' }], items: false };
    expect(await call<R>(tool, { data: [1, 'a'], schema: s })).toMatchObject({ valid: true, draft: '2020-12' });
    const bad = await call<R>(tool, { data: [1, 2, 3], schema: s });
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.instancePath)).toContain('/1');
  });

  it('reads data and schema files, checks formats, lists unknown ones', async () => {
    const ctx = tempCtx();
    const d = join(ctx.outDir, 'd.json'), s = join(ctx.outDir, 's.json');
    writeFileSync(d, JSON.stringify({ when: '2026-02-30', id: '123e4567-e89b-12d3-a456-426614174000', c: 'x' }));
    writeFileSync(s, JSON.stringify({ properties: { when: { format: 'date' }, id: { format: 'uuid' }, c: { format: 'color' } } }));
    const r = await call<R>(tool, { dataFile: d, schemaFile: s }, ctx);
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.instancePath)).toEqual(['/when']);
    expect(r.ignoredFormats).toEqual(['color']);
  });

  it('rejects a broken schema clearly', async () => {
    await expect(call(tool, { data: 1, schema: { type: 'nope' } })).rejects.toThrow(/schema is invalid/);
    await expect(call(tool, { data: 1 })).rejects.toThrow(/schema/);
  });
});

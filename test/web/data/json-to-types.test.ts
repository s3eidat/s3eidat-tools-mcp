import { describe, expect, it } from 'vitest';
import tool, { generate, goName, pySnake, singular } from '../../../src/tools/web/data/json-to-types.js';
import { call } from '../../helpers.js';

// Known answers from the website's S3_SELFTEST.
describe('json-to-types self-test', () => {
  const src = {
    id: 1, name: 'Ada', score: 9.5, 'first-name': 'A', tags: ['a'], address: { city: 'x', zip: null },
    users: [{ id: 1, email: 'a' }, { id: 2, email: null }, { id: 3.5 }], mixed: [1, 'a'], home: { city: 'y', zip: null },
  };
  const r = generate(src, { rootName: 'root', exportKw: true, tsType: false, goOmit: true });
  it('TypeScript', () => {
    expect(r.ts).toBe('export interface Root {\n  id: number;\n  name: string;\n  score: number;\n  "first-name": string;\n  tags: string[];\n  address: Address;\n  users: User[];\n  mixed: (number | string)[];\n  home: Address;\n}\n\n' +
      'export interface Address {\n  city: string;\n  zip: null;\n}\n\nexport interface User {\n  id: number;\n  email?: string | null;\n}\n');
  });
  it('Go', () => {
    expect(r.go).toMatch(/\tID\s+int64\s+`json:"id"`/);
    expect(r.go).toMatch(/\tFirstName\s+string\s+`json:"first-name"`/);
    expect(r.go).toMatch(/\tEmail\s+\*string\s+`json:"email,omitempty"`/);
    expect(r.go).toMatch(/\tID\s+float64\s+`json:"id"`/);
  });
  it('Python', () => {
    expect(r.py).toMatch(/class User:\n {4}id: float\n {4}email: Optional\[str\] = None\n/);
    expect(r.py).toMatch(/first_name: str {2}# "first-name"/);
    expect(r.py).toContain('from typing import Any, List, Optional');
    expect(r.py.indexOf('class Address')).toBeLessThan(r.py.indexOf('class Root'));
  });
  it('Zod', () => {
    expect(r.zod).toContain('email: z.string().nullable().optional(),');
    expect(r.zod).toContain('mixed: z.array(z.union([z.number().int(), z.string()])),');
    expect(r.zod.indexOf('UserSchema')).toBeLessThan(r.zod.indexOf('RootSchema'));
  });
  it('root arrays and names', () => {
    const arr = generate([{ a: 1 }, { b: true }], { rootName: 'Root', exportKw: false, goOmit: true });
    expect(arr.ts).toBe('type Root = RootItem[];\n\ninterface RootItem {\n  a?: number;\n  b?: boolean;\n}\n');
    expect(arr.go.indexOf('type Root []RootItem')).toBe(0);
    expect([singular('categories'), singular('addresses'), singular('status'), singular('roles')]).toEqual(['category', 'address', 'status', 'role']);
    expect([goName('avatar_url'), pySnake('userID'), pySnake('class')]).toEqual(['AvatarURL', 'user_id', 'class_']);
  });
});

describe('json_to_types tool', () => {
  it('generates one or all languages', async () => {
    const one = await call<{ result: string; types: number }>(tool, { text: '{"user_id":1}', language: 'go' });
    expect(one.result).toBe('type Root struct {\n\tUserID int64 `json:"user_id"`\n}\n');
    const all = await call<{ typescript: string; python: string; zod: string; go: string }>(tool, { text: '{"a":"x"}', language: 'all', tsTypeAlias: true });
    expect(all.typescript).toBe('export type Root = {\n  a: string;\n};\n');
    expect(all.python).toContain('class Root:\n    a: str\n');
  });
});

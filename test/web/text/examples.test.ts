import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadTools } from '../../../src/registry.js';
import { call, tempCtx } from '../../helpers.js';

// Every text tool: its documented examples run, match their stated output, and fit the declared outputSchema.
const dir = fileURLToPath(new URL('../../../src/tools/web/text/', import.meta.url));

describe('text tools: examples and output schemas', async () => {
  const tools = await loadTools(dir);
  it('loads the text tools', () => {
    expect(tools.length).toBeGreaterThanOrEqual(15);
    for (const t of tools) {
      expect(t.name, t.name).toMatch(/^text_/);
      expect(t.examples?.length, t.name).toBeGreaterThan(0);
      expect(t.description, t.name).toContain('Web version: https://s3eidat.github.io/');
    }
  });
  for (const t of tools) {
    it(`${t.name} examples`, async () => {
      for (const ex of t.examples ?? []) {
        const out = await call(t, ex.input, tempCtx());
        if (ex.output !== undefined) expect(out, JSON.stringify(ex.input)).toEqual(ex.output);
        if (t.outputSchema) expect(t.outputSchema.safeParse(out).success, `${t.name} output fits its schema`).toBe(true);
      }
    });
  }
});

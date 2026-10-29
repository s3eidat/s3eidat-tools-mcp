import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ToolModule } from '../../../src/registry.js';
import { call, tempCtx } from '../../helpers.js';

// Every documented example of the data-format tools must produce what it says (docs are generated from them).
const dir = fileURLToPath(new URL('../../../src/tools/web/data/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.startsWith('_'));

describe('data tool examples', async () => {
  const tools: ToolModule[] = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    tools.push(...(Array.isArray(mod.default) ? mod.default : [mod.default]));
  }
  const ctx = tempCtx();
  for (const t of tools) {
    it(`${t.name}: metadata`, () => {
      expect(t.name).toMatch(/^(json|csv|yaml|xml|sql|html|css|curl|markdown)_/);
      expect(t.description).toContain('Web version: https://s3eidat.github.io/');
      expect(t.examples?.length).toBeGreaterThan(0);
      for (const [k, v] of Object.entries(t.inputSchema.shape)) expect((v as { description?: string }).description, `${t.name}.${k}`).toBeTruthy();
    });
    for (const [i, ex] of (t.examples ?? []).entries()) {
      it(`${t.name}: example ${i + 1}`, async () => {
        const out = await call(t, ex.input, ctx);
        if (ex.output !== undefined) expect(out).toMatchObject(ex.output as object);
        if (t.outputSchema) expect(() => t.outputSchema!.parse(out)).not.toThrow();
      });
    }
  }
});

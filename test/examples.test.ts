import { describe, expect, it } from 'vitest';
import { loadTools } from '../src/registry.js';
import { call, tempCtx } from './helpers.js';

// Every tool (both lanes): documented examples run offline, match any stated output, and fit the outputSchema
// (the MCP server rejects structuredContent that doesn't). Network tools (openWorldHint) and examples that
// name files that don't exist are skipped.
describe('all tools: examples and output schemas', async () => {
  const tools = (await loadTools()).filter((t) => !t.annotations.openWorldHint);
  for (const t of tools) {
    it.skipIf(!t.examples?.length)(t.name, async () => {
      for (const ex of t.examples ?? []) {
        let out: unknown;
        try {
          out = await call(t, ex.input, tempCtx());
        } catch (e) {
          // Examples may name illustrative files ("report.pdf"); those can't run here.
          if (/not found|is a folder/i.test(String((e as Error).message))) continue;
          throw e;
        }
        if (ex.output !== undefined && t.annotations.idempotentHint !== false) expect(out, JSON.stringify(ex.input)).toEqual(ex.output);
        if (t.outputSchema && out && typeof out === 'object' && !Array.isArray((out as { content?: unknown }).content)) {
          const r = t.outputSchema.safeParse(out);
          expect(r.success, `${t.name}: ${r.error?.message}`).toBe(true);
        }
      }
    });
  }
});

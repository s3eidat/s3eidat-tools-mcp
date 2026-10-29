import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTools, runTool, webUrl } from '../../../src/registry.js';
import { tempCtx } from '../../helpers.js';

// Every developer tool: its examples are valid input, run, and give output that matches its outputSchema.
const tools = await loadTools(join(import.meta.dirname, '../../../src/tools/web/dev'));
const ctx = tempCtx();

describe('dev tools contract', () => {
  it('has the expected tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'base64_decode', 'base64_encode', 'base_convert', 'bytes_convert', 'chmod_calc', 'cron_explain', 'css_clamp', 'css_units',
      'gitignore_generate', 'hash_compute', 'http_status', 'id_generate', 'id_inspect', 'ip_in_range', 'jwt_decode',
      'meta_tags_generate', 'regex_test', 'subnet_calc', 'time_convert', 'url_decode', 'url_encode', 'url_parse', 'useragent_parse',
    ].sort());
  });
  for (const t of tools) {
    it(`${t.name}: metadata and examples`, async () => {
      expect(t.examples?.length).toBeGreaterThan(0);
      expect(t.annotations.openWorldHint).toBe(false);
      if (t.webSlug) expect(t.description).toContain(webUrl(t.webSlug));
      for (const ex of t.examples!) {
        const out = await runTool(t, ex.input, ctx);
        if (t.outputSchema) {
          const r = t.outputSchema.safeParse(out);
          expect(r.success, `${t.name} output: ${r.success ? '' : r.error.message}`).toBe(true);
        }
        if (ex.output && typeof ex.output === 'object') expect(out).toMatchObject(ex.output as object);
      }
    });
  }
});

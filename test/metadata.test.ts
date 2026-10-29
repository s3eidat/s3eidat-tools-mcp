import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadTools } from '../src/registry.js';

const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const server = JSON.parse(read('server.json'));

describe('release metadata', () => {
  it('server.json matches package.json', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});

describe('every tool', async () => {
  const tools = await loadTools();
  it('has a sane contract', () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.description.length, t.name).toBeGreaterThan(30);
      expect(t.annotations, t.name).toBeTruthy();
      if (t.webSlug) expect(t.description, t.name).toContain(`https://s3eidat.github.io/${t.webSlug}/`);
    }
  });
});

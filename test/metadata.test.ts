import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadErrors, loadTools } from '../src/registry.js';

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
  it('all modules load', () => {
    expect(loadErrors).toEqual([]);
  });
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

describe('skill', async () => {
  const tools = await loadTools();
  it('mentions only tools that exist', () => {
    const names = new Set(tools.map((t) => t.name));
    const skill = read('skills/s3eidat-tools/SKILL.md');
    const mentioned = [...skill.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]);
    const meta = new Set(['s3eidat_find_tools', 's3eidat_tool_info', 's3eidat_run_tool']);
    expect([...new Set(mentioned)].filter((n) => !names.has(n) && !meta.has(n))).toEqual([]);
  });
  it('mentions every website port', () => {
    const skill = read('skills/s3eidat-tools/SKILL.md');
    const missing = tools.filter((t) => t.group !== 'ai' && !skill.includes('`' + t.name + '`')).map((t) => t.name);
    expect(missing).toEqual([]);
  });
});

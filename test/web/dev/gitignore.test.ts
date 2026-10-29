import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import tool, { build, BY, resolve, T } from '../../../src/tools/web/dev/gitignore.js';
import { call, tempCtx } from '../../helpers.js';

describe('gitignore-gen self-test', () => {
  it('merges like the website', () => {
    const r = build(['node', 'nextjs'], { headers: true, dedupe: true, custom: 'secrets/\nnode_modules/\n' });
    const lines = r.text.split('\n');
    expect(lines.filter((l) => l === 'node_modules/')).toHaveLength(1);
    expect(r.dupes).toBeGreaterThanOrEqual(2);
    expect(r.text).toMatch(/^# Generated with Gitignore Gen/);
    expect(lines.indexOf('### Node.js ###')).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf('### Next.js ###')).toBeGreaterThan(lines.indexOf('### Node.js ###'));
    expect(lines.indexOf('secrets/')).toBeGreaterThan(lines.indexOf('### Custom ###'));
    expect(lines.indexOf('!.env.example')).toBeGreaterThan(lines.indexOf('.env.*'));
    expect(/# Dependencies\n\n/.test(r.text)).toBe(false);
    expect(/\n$/.test(r.text) && !/\n\n$/.test(r.text)).toBe(true);
    expect(/#/.test(build(['macos'], { headers: false }).text)).toBe(false);
    expect(Object.keys(BY)).toHaveLength(T.length);
    expect(build(['node', 'nextjs'], { dedupe: false }).text.split('\n').filter((l) => l === 'node_modules/')).toHaveLength(2);
    expect(build([], {}).text).toBe('');
    for (const t of T) expect(build([t[0]], { headers: true }).patterns).toBeGreaterThan(0);
  });
  it('resolves names and keywords', () => {
    expect([resolve('node'), resolve('Next.js'), resolve('javascript'), resolve('C#'), resolve('nope')]).toEqual(['node', 'nextjs', 'node', 'dotnet', null]);
  });
});

describe('gitignore_generate tool', () => {
  it('returns text or writes a file', async () => {
    const r = await call<Record<string, any>>(tool, { templates: ['python', 'VS Code'], headers: false });
    expect(r.templates).toEqual(['python', 'vscode']);
    expect(r.text).toContain('__pycache__/');
    const ctx = tempCtx();
    const w = await call<{ path: string }>(tool, { templates: ['macos'], output: ctx.outDir + '/proj/' }, ctx);
    expect(w.path.endsWith('/proj/.gitignore')).toBe(true);
    expect(readFileSync(w.path, 'utf8')).toContain('.DS_Store');
    expect((await call<{ available: unknown[] }>(tool, { list: true })).available).toHaveLength(T.length);
    await expect(call(tool, { templates: ['cobol-on-mars'] })).rejects.toThrow(/Unknown template/);
  });
});

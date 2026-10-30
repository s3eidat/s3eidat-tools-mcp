import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tool from '../../src/tools/ai/html-to-markdown.js';
import { call, tempCtx } from '../helpers.js';

type R = { markdown: string; title?: string; byline?: string; source: string; words: number; characters: number; truncated?: boolean; path?: string };

const ARTICLE = `<!doctype html><html lang="en"><head><title>Tea Guide | Leaf Blog</title><meta name="author" content="Mona Leaf"></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>How to brew green tea</h1>
${Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i + 1}: green tea tastes best brewed at about eighty degrees for two minutes, because boiling water burns the leaves and makes the cup bitter and dull.</p>`).join('\n')}
<p>See <a href="/steeping">the steeping chart</a>.</p></article>
<footer>Copyright Leaf Blog. <a href="/privacy">Privacy</a></footer><script>alert(1)</script></body></html>`;

describe('ai_html_to_markdown', () => {
  it('converts headings, inline styles, links, lists, code, tables and strikethrough', async () => {
    const html = `<h2>Shopping</h2><p>Buy <strong>milk</strong> and <em>eggs</em>, not <del>soda</del>.</p>
<ol><li>first</li><li>second<ul><li>nested</li></ul></li></ol>
<pre><code>let x = 1;</code></pre>
<table><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody><tr><td>Milk</td><td>1|2</td></tr><tr><td><b>Eggs</b></td><td>3</td></tr></tbody></table>
<script>bad()</script><style>p{}</style>`;
    const r = await call<R>(tool, { html }, tempCtx());
    expect(r.markdown).toBe(
      '## Shopping\n\nBuy **milk** and _eggs_, not ~~soda~~.\n\n1. first\n2. second\n   - nested\n\n```\nlet x = 1;\n```\n\n' +
        '| Item | Price |\n| --- | --- |\n| Milk | 1\\|2 |\n| **Eggs** | 3 |\n',
    );
    expect(r.source).toBe('body');
    expect(r.words).toBe(22); // list numbers, code and table cells count too
  });

  it('keeps only the article with readable, resolves links, and reads files', async () => {
    const ctx = tempCtx();
    const file = join(ctx.outDir, 'tea.html');
    writeFileSync(file, ARTICLE);
    const r = await call<R>(tool, { path: file, readable: true, baseUrl: 'https://leaf.example/blog/tea' }, ctx);
    expect(r.source).toBe('readability');
    expect(r.byline).toBe('Mona Leaf');
    expect(r.markdown).toContain('Paragraph 6: green tea');
    expect(r.markdown).toContain('[the steeping chart](https://leaf.example/steeping)');
    expect(r.markdown).not.toContain('Privacy');
    expect(r.markdown).not.toContain('alert');

    const whole = await call<R>(tool, { html: ARTICLE, includeLinks: false }, ctx);
    expect(whole.source).toBe('body');
    expect(whole.title).toBe('Tea Guide | Leaf Blog');
    expect(whole.markdown).toContain('Copyright Leaf Blog. Privacy');
    expect(whole.markdown).not.toContain('](');
  });

  it('honours a selector, truncates inline output, and writes files', async () => {
    const ctx = tempCtx();
    const sel = await call<R>(tool, { html: ARTICLE, selector: 'footer' }, ctx);
    expect(sel.source).toBe('selector');
    expect(sel.markdown).toBe('Copyright Leaf Blog. [Privacy](/privacy)\n');
    await expect(call(tool, { html: ARTICLE, selector: '.nope' }, ctx)).rejects.toThrow(/No element matches/);

    const big = '<p>' + 'word '.repeat(1000) + '</p>\n'.repeat(1) + '<p>' + 'more '.repeat(1000) + '</p>';
    const cut = await call<R>(tool, { html: big, maxChars: 1000 }, ctx);
    expect(cut.truncated).toBe(true);
    expect(cut.markdown).toMatch(/truncated: showing .* of 10,001 characters/);
    expect(cut.characters).toBe(10001);

    const out = join(ctx.outDir, 'big.md');
    const w = await call<R>(tool, { html: big, maxChars: 1000, output: out }, ctx);
    expect(w.path).toBe(out);
    expect(w.markdown).toBeUndefined();
    expect(readFileSync(out, 'utf8').length).toBe(10001);
  });

  it('needs html or path', async () => {
    await expect(call(tool, {}, tempCtx())).rejects.toThrow(/html.*path/);
  });
});

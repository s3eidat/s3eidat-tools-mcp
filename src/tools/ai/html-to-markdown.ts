import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { readInput } from '../../util/files.js';
import { ToolError } from '../../util/errors.js';
import { emitMarkdown, htmlToMarkdown, maxCharsInput, mdOutputInput, mdOutputShape, stemOf } from './_md.js';

export default defineTool({
  name: 'ai_html_to_markdown',
  title: 'HTML to Markdown',
  description:
    'Convert HTML to clean Markdown for reading or feeding to a model: headings, lists, links, images, code blocks, ' +
    'GitHub-style tables and strikethrough. Give the HTML inline ("html") or as a file ("path": local path or base64). ' +
    'Optional "readable" keeps only the main article (Mozilla Readability, falls back to the whole body), "selector" ' +
    'converts only matching elements, "baseUrl" makes relative links absolute, "includeLinks": false drops link URLs and ' +
    'images. Scripts, styles and forms are removed. Inline Markdown is cut at maxChars (default 200k) with a note; ' +
    'give "output" to save the whole thing to a .md file. Runs locally; nothing is uploaded.',
  inputSchema: z.object({
    html: z.string().optional().describe('The HTML text. Give this or "path".'),
    path: z.string().optional().describe('An .html file instead of "html": local path or base64.'),
    readable: z.boolean().optional().default(false).describe('Keep only the main content (article text), dropping navigation, ads and footers.'),
    selector: z.string().optional().describe('CSS selector: convert only the matching elements (e.g. "main", "article .post").'),
    baseUrl: z.string().url().optional().describe('URL the HTML came from, to make relative links and images absolute.'),
    includeLinks: z.boolean().optional().default(true).describe('Keep links and images. False turns links into plain text and drops images.'),
    maxChars: maxCharsInput(),
    output: mdOutputInput(),
  }),
  outputSchema: z.object({
    title: z.string().optional(),
    byline: z.string().optional(),
    source: z.enum(['selector', 'readability', 'body']).describe('What was converted: the selector matches, the Readability main content, or the whole body.'),
    ...mdOutputShape,
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: { html: '<h1>Notes</h1><p>Hello <b>world</b>, see <a href="/docs">docs</a>.</p><ul><li>one</li><li>two</li></ul>', baseUrl: 'https://example.com/' },
      output: { markdown: '# Notes\n\nHello **world**, see [docs](https://example.com/docs).\n\n- one\n- two\n' },
    },
    { input: { path: 'page.html', readable: true, output: 'page.md' } },
  ],
  async run(input, ctx) {
    if (input.html == null && !input.path) throw new ToolError('Give either "html" or "path".');
    let html = input.html;
    let name = 'page';
    if (html == null) {
      const f = await readInput(input.path!, ctx, 'path');
      html = f.bytes.toString('utf8').replace(/^﻿/, '');
      name = stemOf(f, 'page');
    }
    const r = await htmlToMarkdown(html, { readable: input.readable, selector: input.selector, baseUrl: input.baseUrl, includeLinks: input.includeLinks });
    const md = await emitMarkdown(r.markdown, { output: input.output, maxChars: input.maxChars, defaultName: name + '.md' }, ctx);
    const out: Record<string, unknown> = { source: r.source, ...md };
    if (r.title) out.title = r.title;
    if (r.byline) out.byline = r.byline;
    return out;
  },
});

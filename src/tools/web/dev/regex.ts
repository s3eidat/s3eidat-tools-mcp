import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/regex-playground (app.js + worker.js): the regex runs in a worker thread that
// is killed after a timeout, so catastrophic backtracking can't hang the server. Same match/replace logic as the site.
const MAX = 5000; // the site stops listing after 5000 matches and says "5000+"

const WORKER_SRC = `
const { parentPort, workerData: d } = require('node:worker_threads');
const MAX = ${MAX};
const out = { matches: [], more: false };
try {
  const re = new RegExp(d.source, d.flags);
  const take = (m) => out.matches.push({ index: m.index, text: m[0], groups: m.slice(1), named: m.groups ? Object.assign({}, m.groups) : null });
  if (re.global) {
    for (const m of d.text.matchAll(re)) { if (out.matches.length >= MAX) { out.more = true; break; } take(m); }
  } else {
    const one = re.exec(d.text);
    if (one) take(one);
  }
  if (d.replace != null) out.replaced = d.text.replace(re, d.replace);
} catch (err) {
  out.error = err.message;
}
parentPort.postMessage(out);
`;

export interface Match {
  index: number;
  text: string;
  groups: (string | undefined)[];
  named: Record<string, string | undefined> | null;
}
export interface RegexResult {
  matches?: Match[];
  more?: boolean;
  replaced?: string;
  error?: string;
  timeout?: boolean;
}

/** Run a regex job in a worker thread with a hard timeout (ms). */
export function runRegex(job: { source: string; flags: string; text: string; replace?: string }, timeoutMs = 1500): Promise<RegexResult> {
  return new Promise((resolve) => {
    const w = new Worker(WORKER_SRC, { eval: true, workerData: job });
    let done = false;
    const finish = (r: RegexResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
    w.once('message', (m: RegexResult) => finish(m));
    w.once('error', (e) => finish({ error: e.message || 'Worker error' }));
  });
}

/** Name (or null) of each capture group in order, so $1, $2… can be labelled <name>. */
export function captureNames(src: string): (string | null)[] {
  const names: (string | null)[] = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c !== '(') continue;
    if (src[i + 1] !== '?') {
      names.push(null);
      continue;
    }
    const m = /^\?<([A-Za-z_$][\w$]*)>/.exec(src.slice(i + 1));
    if (m) names.push(m[1]);
  }
  return names;
}

export default defineTool({
  name: 'regex_test',
  title: 'Regex test',
  webSlug: 'regex-playground',
  description:
    'Run a JavaScript regular expression against text: every match with its index, length, numbered and named capture ' +
    'groups, plus an optional replace preview ($1, $<name>, $&, $`, $\', $$). Flags g i m s u y (and d, v). Runs in an ' +
    'isolated worker with a timeout (default 1.5 s) so catastrophic backtracking is reported instead of hanging. Lists up ' +
    `to 5000 matches. Web version: ${webUrl('regex-playground')}`,
  inputSchema: z.object({
    pattern: z.string().min(1).describe('The regex source, without slashes, e.g. "(\\\\d+)-(?<w>[a-z]+)".'),
    flags: z.string().regex(/^[dgimsuvy]*$/, 'Flags are letters from d g i m s u v y').optional().default('g').describe('Regex flags, default "g".'),
    text: z.string().describe('The text to search.'),
    replace: z.string().optional().describe('Replacement string for a replace preview (JavaScript String.replace syntax).'),
    limit: z.number().int().min(0).max(MAX).optional().default(500).describe('Max matches to include in the result (count is still total). Default 500.'),
    timeoutMs: z.number().int().min(100).max(10000).optional().default(1500).describe('Kill the regex after this many ms. Default 1500.'),
  }),
  outputSchema: z.object({
    count: z.number().describe('Number of matches (capped at 5000; see "more").'),
    more: z.boolean().describe('True when there were more than 5000 matches.'),
    groupNames: z.array(z.string().nullable()).describe('Name of each capture group in order (null = unnamed).'),
    matches: z.array(
      z.object({ index: z.number(), length: z.number(), text: z.string(), groups: z.array(z.string().nullable()), named: z.record(z.string(), z.string().nullable()).nullable() }),
    ),
    replaced: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: { pattern: '(\\d+)-(?<w>[a-z]+)', flags: 'g', text: '1-ab 22-cd x', replace: '$<w>:$1' },
      note: '2 matches (index 0 and 5), replaced = "ab:1 cd:22 x"',
    },
  ],
  async run(input) {
    const r = await runRegex({ source: input.pattern, flags: input.flags, text: input.text, replace: input.replace }, input.timeoutMs);
    if (r.timeout) throw new ToolError(`Stopped after ${input.timeoutMs / 1000}s — likely catastrophic backtracking`);
    if (r.error) throw new ToolError(r.error.replace(/^Invalid regular expression: /, ''));
    const all = r.matches ?? [];
    const out: Record<string, unknown> = {
      count: all.length,
      more: !!r.more,
      groupNames: captureNames(input.pattern),
      matches: all.slice(0, input.limit).map((m) => ({
        index: m.index,
        length: m.text.length,
        text: m.text,
        groups: m.groups.map((g) => (g === undefined ? null : g)),
        named: m.named ? Object.fromEntries(Object.entries(m.named).map(([k, v]) => [k, v === undefined ? null : v])) : null,
      })),
    };
    if (r.replaced != null) out.replaced = r.replaced;
    return out;
  },
});

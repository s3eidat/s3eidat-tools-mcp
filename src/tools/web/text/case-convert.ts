import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/case-convert (app.js) so results match the website.
const SMALL = new Set('a an and as at but by en for from if in into nor of off on onto or over per the to up via vs vs. with'.split(' '));
const up = (s: string) => s.toLocaleUpperCase();
const low = (s: string) => s.toLocaleLowerCase();
const capFirst = (w: string) => { const c = Array.from(w); return c.length ? up(c[0]) + c.slice(1).join('') : w; };

function codeWords(line: string) {
  return line
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean);
}

function title(line: string) {
  const shouty = line === up(line) && line !== low(line);
  const parts = line.split(/(\s+)/), wordIdx: number[] = [];
  parts.forEach((p, i) => { if (/\S/.test(p)) wordIdx.push(i); });
  const first = wordIdx[0], last = wordIdx[wordIdx.length - 1];
  return parts.map((p, i) => {
    if (!/\S/.test(p)) return p;
    const prev = wordIdx[wordIdx.indexOf(i) - 1], afterColon = prev != null && /[:.!?—–]$/.test(parts[prev]);
    const w = shouty ? low(p) : p;
    const core = low(w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    if (i !== first && i !== last && !afterColon && SMALL.has(core)) return low(w);
    if (!shouty && /\p{L}\p{Lu}/u.test(w)) return w; // keep iPhone, McDonald, NASA
    return w.split('-').map((seg) => seg.replace(/^([^\p{L}\p{N}]*)(\p{L})(.*)$/u, (_m, pre, ch, rest) => pre + up(ch) + rest)).join('-');
  }).join('');
}

function sentence(line: string) {
  const s = low(line).replace(/(^\s*[^\p{L}\p{N}]*|[.!?؟]\s+[^\p{L}\p{N}]*)(\p{L})/gu, (_m, pre, ch) => pre + up(ch));
  return s.replace(/(^|[^\p{L}\p{N}'’])i(?=$|[^\p{L}\p{N}])/gu, '$1I');
}

function alternate(line: string) {
  let n = 0;
  return Array.from(line).map((c) => (low(c) === up(c) ? c : n++ % 2 ? up(c) : low(c))).join('');
}
const inverse = (line: string) => Array.from(line).map((c) => (c === up(c) ? low(c) : up(c))).join('');

const MODES = {
  upper: up,
  lower: low,
  title,
  sentence,
  camel: (l: string) => codeWords(l).map((w, i) => (i ? capFirst(low(w)) : low(w))).join(''),
  pascal: (l: string) => codeWords(l).map((w) => capFirst(low(w))).join(''),
  snake: (l: string) => codeWords(l).map(low).join('_'),
  kebab: (l: string) => codeWords(l).map(low).join('-'),
  constant: (l: string) => codeWords(l).map(up).join('_'),
  alternate,
  inverse,
} as const;

export type CaseMode = keyof typeof MODES;
export const CASE_MODES = Object.keys(MODES) as CaseMode[];

/** Convert line by line, exactly like the website. */
export function convertCase(text: string, mode: CaseMode) {
  return text.split('\n').map(MODES[mode]).join('\n');
}

export default defineTool({
  name: 'text_case',
  title: 'Case convert',
  webSlug: 'case-convert',
  description:
    'Convert text case: upper, lower, title (smart: keeps small words lower and iPhone/NASA as typed), sentence, camel, pascal, ' +
    'snake, kebab, constant, alternate, inverse. Works line by line and handles Unicode (Arabic, accents, ß). ' +
    `Web version: ${webUrl('case-convert')}`,
  inputSchema: z.object({
    text: z.string().describe('Text to convert.'),
    mode: z.enum(CASE_MODES as [CaseMode, ...CaseMode[]]).describe('Target case.'),
  }),
  outputSchema: z.object({ result: z.string() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'a tale OF two cities', mode: 'title' }, output: { result: 'A Tale of Two Cities' } },
    { input: { text: 'XMLParser handler', mode: 'snake' }, output: { result: 'xml_parser_handler' } },
  ],
  run: ({ text, mode }) => ({ result: convertCase(text, mode) }),
});

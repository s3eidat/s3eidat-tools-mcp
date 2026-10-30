import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { readTextInput } from '../../util/files.js';
import { words } from '../web/text/word-count.js';
import { encodingField, getEncoder, graphemeCount, pathField, textField } from './_text.js';

/** Common context window sizes (tokens). */
export const WINDOWS: { label: string; tokens: number }[] = [
  { label: '8k', tokens: 8_192 },
  { label: '32k', tokens: 32_768 },
  { label: '128k', tokens: 128_000 },
  { label: '200k', tokens: 200_000 },
  { label: '1M', tokens: 1_000_000 },
];

export function contextFit(tokens: number) {
  return WINDOWS.map((w) => ({
    window: w.label,
    windowTokens: w.tokens,
    fits: tokens <= w.tokens,
    percentUsed: Math.round((tokens / w.tokens) * 1000) / 10,
  }));
}

export default defineTool({
  name: 'ai_token_count',
  title: 'Count tokens',
  description:
    'Count LLM tokens in a text or text file with the OpenAI tiktoken tokenizers ("o200k_base", default, used by GPT-4o and ' +
    'the o-series; or "cl100k_base", used by GPT-4/3.5 and text-embedding-3). Also returns characters and words, and whether the ' +
    'text fits in common context windows (8k, 32k, 128k, 200k, 1M: e.g. "fits in 200k: yes"). Claude\'s tokenizer is not public, ' +
    'so for Claude the count is an estimate (typically within ~10-20%; Claude usually needs a little more), returned as a rough ' +
    'range. Runs locally, no API calls. Give "text" or "path" (file path or base64). Large texts (many MB) take a few seconds.',
  inputSchema: z.object({
    text: textField(),
    path: pathField(),
    encoding: encodingField(),
  }),
  outputSchema: z.object({
    tokens: z.number().describe('Exact token count for the chosen tiktoken encoding.'),
    encoding: z.string(),
    characters: z.number().describe('Characters (grapheme clusters, so an emoji counts once).'),
    words: z.number(),
    charsPerToken: z.number(),
    claudeEstimate: z.object({ low: z.number(), high: z.number(), note: z.string() }),
    contextFit: z.array(z.object({ window: z.string(), windowTokens: z.number(), fits: z.boolean(), percentUsed: z.number() })),
    summary: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'hello world' }, output: { tokens: 2, words: 2, characters: 11 } },
    { input: { path: 'notes.md', encoding: 'cl100k_base' } },
  ],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    const enc = await getEncoder(input.encoding);
    const tokens = enc.count(text);
    const chars = graphemeCount(text);
    const fit = contextFit(tokens);
    return {
      tokens,
      encoding: enc.name,
      characters: chars,
      words: words(text).length,
      charsPerToken: tokens ? Math.round((text.length / tokens) * 100) / 100 : 0,
      claudeEstimate: {
        low: Math.round(tokens * 0.9),
        high: Math.round(tokens * 1.2),
        note: "Claude's tokenizer is not public: this is a rough range around the tiktoken count, not an exact Claude count.",
      },
      contextFit: fit,
      summary: `${tokens.toLocaleString('en-US')} tokens (${enc.name}). ` + fit.map((f) => `fits in ${f.window}: ${f.fits ? 'yes' : 'no'}`).join(', ') + '.',
    };
  },
});

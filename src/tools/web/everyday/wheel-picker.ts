import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { makeRandInt, seedSchema, shuffle } from './_random.js';

// Ported from https://github.com/s3eidat/wheel-picker (app.js): same entry parsing and fair winner choice
// (crypto uint32 + rejection sampling, chosen before any animation).
export const MAX = 500;

/** One entry per line, trimmed, cut to 100 characters, blanks dropped, at most 500 (website `parseNames`). */
export function parseNames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, MAX);
}

export default defineTool({
  name: 'random_pick',
  title: 'Wheel picker (random pick)',
  webSlug: 'wheel-picker',
  description:
    'Pick a random winner (or several, without repeats, like spinning with "remove winner" on) from a list of names, ' +
    'or shuffle / sort the whole list. Fair: crypto random with rejection sampling. Entries are trimmed, cut to 100 ' +
    `characters, max 500; at least 2 needed. Optional seed for a reproducible draw. Web version: ${webUrl('wheel-picker')}`,
  inputSchema: z.object({
    items: z.array(z.string()).optional().describe('The entries, one per array item.'),
    text: z.string().optional().describe('Or: the entries as text, one per line.'),
    mode: z.enum(['pick', 'shuffle', 'sort']).optional().default('pick').describe('"pick" winners, "shuffle" the list, or "sort" it A→Z.'),
    count: z.number().int().min(1).max(MAX).optional().default(1).describe('How many winners to pick (each winner is removed before the next spin).'),
    seed: seedSchema(),
  }),
  outputSchema: z.object({
    entries: z.number().describe('Number of usable entries.'),
    winners: z.array(z.object({ name: z.string(), index: z.number().describe('0-based position in the original list.') })).optional(),
    remaining: z.array(z.string()).optional().describe('Entries left on the wheel after removing the winners.'),
    list: z.array(z.string()).optional().describe('The shuffled or sorted list.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  examples: [
    { input: { items: ['Ali', 'Sara', 'Omar', 'Lina'] }, note: 'One random winner, e.g. { winners: [{ name: "Omar", index: 2 }] }' },
    { input: { text: 'Ali\nSara\nOmar\nLina\nHuda', count: 3, seed: 'raffle-2026' }, note: 'Three distinct winners, reproducible' },
  ],
  run(input) {
    const raw = input.items ? input.items.join('\n') : input.text;
    if (raw == null) throw new ToolError('Give "items" (an array) or "text" (one entry per line).');
    const names = parseNames(raw);
    if (names.length < 2) throw new ToolError(names.length ? 'Add at least two entries.' : 'Add some entries first.');
    const rng = makeRandInt(input.seed);
    if (input.mode === 'shuffle') return { entries: names.length, list: shuffle(names.slice(), rng) };
    if (input.mode === 'sort') return { entries: names.length, list: names.slice().sort((a, b) => a.localeCompare(b)) };
    if (input.count > names.length) throw new ToolError(`Only ${names.length} entries for ${input.count} winners.`);
    const left = names.map((name, index) => ({ name, index }));
    const winners: { name: string; index: number }[] = [];
    for (let k = 0; k < input.count; k++) winners.push(left.splice(rng(left.length), 1)[0]);
    return { entries: names.length, winners, remaining: left.map((x) => x.name) };
  },
});

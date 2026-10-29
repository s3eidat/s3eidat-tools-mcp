import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { makeRandInt, seedSchema, type RandInt } from './_random.js';

// Ported from https://github.com/s3eidat/secret-santa (app.js): same exclusion matrix, exact feasibility check
// (bipartite matching), uniform rejection-sampled draw with a randomized backtracking fallback, and the same
// plain-language explanation when no draw is possible. No emails: the result is returned to the caller only.
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function shuffleWith<T>(a: T[], rng: RandInt) {
  for (let i = a.length - 1; i > 0; i--) { const j = rng(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/** allowed[i][j]: may giver i draw receiver j? Never yourself, never someone you're paired with (both ways). */
export function allowedMatrix(n: number, pairs: [number, number][]) {
  const a = range(n).map((i) => range(n).map((j) => i !== j));
  pairs.forEach((p) => { if (p[0] < n && p[1] < n) { a[p[0]][p[1]] = false; a[p[1]][p[0]] = false; } });
  return a;
}
/** A perfect giver → receiver matching exists (Kuhn's augmenting paths). */
export function feasible(a: boolean[][]) {
  const n = a.length, owner = range(n).map(() => -1);
  function augment(i: number, seen: boolean[]): boolean {
    for (let j = 0; j < n; j++) {
      if (!a[i][j] || seen[j]) continue;
      seen[j] = true;
      if (owner[j] < 0 || augment(owner[j], seen)) { owner[j] = i; return true; }
    }
    return false;
  }
  for (let i = 0; i < n; i++) if (!augment(i, [])) return false;
  return n > 1;
}
export function valid(a: boolean[][], p: number[]) {
  const used: Record<number, 1> = {};
  for (let i = 0; i < p.length; i++) { if (!a[i][p[i]] || used[p[i]]) return false; used[p[i]] = 1; }
  return p.length === a.length;
}
export function draw(a: boolean[][], rng: RandInt, tries = 20000): number[] | null {
  const n = a.length;
  if (!feasible(a)) return null;
  for (let t = 0; t < tries; t++) { const p = shuffleWith(range(n), rng); if (valid(a, p)) return p; }
  const res: number[] = new Array(n), used: Record<number, number> = {}, order = shuffleWith(range(n), rng);
  (function bt(k: number): boolean {
    if (k === n) return true;
    const i = order[k], cands = shuffleWith(range(n), rng);
    for (let c = 0; c < n; c++) {
      const j = cands[c];
      if (a[i][j] && !used[j]) { used[j] = 1; res[i] = j; if (bt(k + 1)) return true; used[j] = 0; }
    }
    return false;
  })(0);
  return res;
}
export function explain(names: string[], pairs: [number, number][]) {
  const n = names.length;
  if (n < 2) return 'Add at least two people.';
  const a = allowedMatrix(n, pairs);
  for (let i = 0; i < n; i++) if (!a[i].some(Boolean)) return names[i] + " can't draw anyone: everyone else is excluded for them.";
  let fix: [number, number] | null = null;
  pairs.some((p, k) => {
    const rest = pairs.filter((_, x) => x !== k);
    if (feasible(allowedMatrix(n, rest))) { fix = p; return true; }
    return false;
  });
  const f = fix as [number, number] | null;
  return 'No valid draw exists with these exclusions' + (f ? '. Removing ' + names[f[0]] + ' ↔ ' + names[f[1]] + ' would make it work.' : '. Remove some exclusions or add more people.');
}

/** Names as the website's input box takes them: split on newlines, commas, semicolons and the Arabic comma; trimmed, ≤ 40 chars, no case-insensitive duplicates, ≤ 200. */
export function parseNames(list: string[]) {
  const names: string[] = [], low = new Set<string>(), dupes: string[] = [];
  for (const raw of list.join('\n').split(/[\n,;،]+/)) {
    const n = raw.trim().slice(0, 40);
    if (!n) continue;
    if (low.has(n.toLowerCase())) { dupes.push(n); continue; }
    if (names.length >= 200) continue;
    low.add(n.toLowerCase());
    names.push(n);
  }
  return { names, dupes };
}

export default defineTool({
  name: 'secret_santa_draw',
  title: 'Secret Santa draw',
  webSlug: 'secret-santa',
  description:
    'Draw Secret Santa (gift exchange) pairs: everyone gives to exactly one other person and receives from one, never ' +
    'themselves. Exclusions (couples, housemates…) block a pair both ways. Checks exactly whether a draw is possible and ' +
    'explains why not (and which exclusion to drop). Crypto random and uniform; optional seed. Up to 200 people. Nothing ' +
    'is emailed: hand each giver only their own line. Optional budget, date and message are echoed for slips. ' +
    `Web version: ${webUrl('secret-santa')}`,
  inputSchema: z.object({
    names: z.array(z.string()).min(1).describe('Participants (an item may also hold several names separated by commas or new lines).'),
    exclusions: z.array(z.tuple([z.string(), z.string()])).optional().default([]).describe('Pairs of names who must not draw each other, e.g. [["Omar","Sara"]].'),
    budget: z.string().max(30).optional().describe('Optional gift budget, e.g. "20 JD".'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Optional exchange date, YYYY-MM-DD.'),
    message: z.string().max(300).optional().describe('Optional note for everyone.'),
    seed: seedSchema(),
  }),
  outputSchema: z.object({
    people: z.number(),
    assignments: z.array(z.object({ giver: z.string(), receiver: z.string() })),
    budget: z.string().optional(), date: z.string().optional(), message: z.string().optional(),
    note: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  examples: [
    { input: { names: ['Omar', 'Sara', 'Lina', 'Yousef', 'Huda'], exclusions: [['Omar', 'Sara']], budget: '20 JD' }, note: 'Omar and Sara never draw each other' },
  ],
  run(input) {
    const { names } = parseNames(input.names);
    if (names.length < 2) throw new ToolError('Add at least two people.');
    const idx = new Map(names.map((n, i) => [n.toLowerCase(), i]));
    const pairs: [number, number][] = [];
    for (const [x, y] of input.exclusions) {
      const a = idx.get(x.trim().slice(0, 40).toLowerCase()), b = idx.get(y.trim().slice(0, 40).toLowerCase());
      if (a === undefined || b === undefined) throw new ToolError(`Exclusion "${x}" ↔ "${y}": ${a === undefined ? x : y} is not in the list of names.`);
      if (a === b) throw new ToolError(`Exclusion "${x}" ↔ "${y}": pick two different people.`);
      if (!pairs.some((p) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a))) pairs.push([a, b]);
    }
    const a = allowedMatrix(names.length, pairs);
    const p = draw(a, makeRandInt(input.seed));
    if (!p) throw new ToolError(explain(names, pairs));
    const out: Record<string, unknown> = {
      people: names.length,
      assignments: names.map((n, i) => ({ giver: n, receiver: names[p[i]] })),
    };
    if (input.budget) out.budget = input.budget;
    if (input.date) out.date = input.date;
    if (input.message) out.message = input.message;
    if (names.length === 2) out.note = 'With two people, you simply swap.';
    return out;
  },
});

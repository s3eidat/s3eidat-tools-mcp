import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { makeRandInt, seedSchema, shuffle, type RandInt } from './_random.js';

// Ported from https://github.com/s3eidat/team-maker (app.js): same parsing ("Name, 4"), crypto Fisher-Yates
// shuffle, round-robin split, and greedy skill balancing (people without a skill count as the average).
const NAMES: Record<'colors' | 'animals', string[]> = {
  colors: ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Teal', 'Black', 'White', 'Silver', 'Gold'],
  animals: ['Lions', 'Falcons', 'Wolves', 'Eagles', 'Tigers', 'Sharks', 'Bears', 'Panthers', 'Foxes', 'Hawks', 'Cobras', 'Rhinos'],
};

export interface Person { name: string; skill: number | null }
export interface Team { name?: string; members: Person[]; total: number }

/** "Name", "Name, 4", "Name: 4", "Name;4", "Name<TAB>4" — at most 2000 people, names cut to 80 chars, skill ≤ 100. */
export function parsePeople(text: string): Person[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2000).map((l) => {
    const m = /^(.*?)\s*[,;:\t]\s*(\d+(?:\.\d+)?)$/.exec(l);
    if (m && m[1] && +m[2] <= 100) return { name: m[1].slice(0, 80), skill: +m[2] };
    return { name: l.slice(0, 80), skill: null };
  });
}
export function teamCount(mode: 'teams' | 'per', num: number, n: number) {
  return mode === 'per' ? Math.ceil(n / Math.max(1, num)) : num;
}
export function makeTeams(people: Person[], k: number, balance: boolean, rng: RandInt): Team[] {
  const arr = shuffle(people.slice(), rng), teams: Team[] = [];
  for (let i = 0; i < k; i++) teams.push({ members: [], total: 0 });
  const useSkill = balance && people.some((p) => p.skill != null);
  if (!useSkill) arr.forEach((p, i) => teams[i % k].members.push(p));
  else {
    const known = people.filter((p) => p.skill != null), avg = known.reduce((a, p) => a + p.skill!, 0) / known.length;
    const sk = (p: Person) => (p.skill != null ? p.skill : avg);
    arr.sort((a, b) => sk(b) - sk(a)); // stable: equal skills keep their shuffled order
    arr.forEach((p) => {
      const minC = Math.min(...teams.map((t) => t.members.length));
      const open = teams.filter((t) => t.members.length === minC);
      const minT = Math.min(...open.map((t) => t.total));
      const best = open.filter((t) => Math.abs(t.total - minT) < 1e-9);
      const t = best[rng(best.length)];
      t.members.push(p);
      t.total += sk(p);
    });
  }
  teams.forEach((t) => { t.total = t.members.reduce((a, p) => a + (p.skill || 0), 0); });
  return teams;
}
export function teamName(i: number, style: string, custom: string[]) {
  if (style === 'custom' && custom[i]) return custom[i];
  if (style === 'colors' || style === 'animals') {
    const l = NAMES[style];
    return (style === 'colors' ? 'Team ' : '') + l[i % l.length] + (i >= l.length ? ' ' + (Math.floor(i / l.length) + 1) : '');
  }
  if (style === 'letters') return 'Team ' + (i < 26 ? String.fromCharCode(65 + i) : i + 1);
  return 'Team ' + (i + 1);
}
export function asText(teams: { name?: string; members: { name: string }[] }[]) {
  return teams.map((t) => t.name + ' (' + t.members.length + ')\n' + t.members.map((p) => '- ' + p.name).join('\n')).join('\n\n') + '\n';
}

export default defineTool({
  name: 'random_teams',
  title: 'Team maker',
  webSlug: 'team-maker',
  description:
    'Split a list of people into fair random teams: choose the number of teams or people per team. Add a skill level ' +
    '("Ali, 5" / "Sara: 3") and teams are balanced by total skill (people without one count as the average). Team ' +
    'names: numbers, letters, colours, animals or your own. Crypto-random shuffle; optional seed for a reproducible ' +
    `split. Max 2000 people, 100 teams. Web version: ${webUrl('team-maker')}`,
  inputSchema: z.object({
    people: z.array(z.string()).optional().describe('People, one per item, optionally "Name, skill" (skill 0–100).'),
    text: z.string().optional().describe('Or: people as text, one per line.'),
    mode: z.enum(['teams', 'per']).optional().default('teams').describe('"teams": make `num` teams; "per": `num` people per team.'),
    num: z.number().int().min(1).max(2000).optional().default(2).describe('Number of teams (min 2) or people per team (min 1), see mode.'),
    balance: z.boolean().optional().default(true).describe('Balance teams by skill when skills are given.'),
    naming: z.enum(['num', 'letters', 'colors', 'animals', 'custom']).optional().default('num').describe('Team names: Team 1…, Team A…, colours, animals, or customNames.'),
    customNames: z.array(z.string()).optional().describe('naming=custom: team names in order (missing ones fall back to "Team N").'),
    seed: seedSchema(),
  }),
  outputSchema: z.object({
    people: z.number(),
    teams: z.array(z.object({
      name: z.string(), size: z.number(), totalSkill: z.number().optional(),
      members: z.array(z.object({ name: z.string(), skill: z.number().nullable() })),
    })),
    text: z.string().describe('Plain-text list, as the website copies it.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  examples: [
    { input: { people: ['Ali, 5', 'Sara, 4', 'Omar, 3', 'Lina, 5', 'Yousef, 2', 'Noor, 4'], num: 2, naming: 'animals' }, note: 'Two balanced teams (Lions, Falcons)' },
  ],
  run(input) {
    const raw = input.people ? input.people.join('\n') : input.text;
    if (raw == null) throw new ToolError('Give "people" (an array) or "text" (one per line).');
    const people = parsePeople(raw);
    if (people.length < 2) throw new ToolError('Add at least two people.');
    const num = input.num;
    if (!(num >= (input.mode === 'per' ? 1 : 2))) throw new ToolError(input.mode === 'per' ? 'People per team must be 1 or more.' : 'Make at least 2 teams.');
    const k = teamCount(input.mode, num, people.length);
    if (k > people.length) throw new ToolError('There are only ' + people.length + ' people for ' + k + ' teams.');
    if (k < 2) throw new ToolError('That makes only one team. Lower the people per team.');
    if (k > 100) throw new ToolError('Up to 100 teams.');
    const custom = (input.customNames ?? []).map((s) => s.trim().slice(0, 60)).filter(Boolean);
    const teams = makeTeams(people, k, input.balance, makeRandInt(input.seed));
    teams.forEach((t, i) => { t.name = teamName(i, input.naming, custom); });
    const skilled = teams.some((t) => t.members.some((p) => p.skill != null));
    return {
      people: people.length,
      teams: teams.map((t) => ({
        name: t.name!, size: t.members.length,
        ...(skilled ? { totalSkill: Math.round(t.total * 10) / 10 } : {}),
        members: t.members.map((p) => ({ name: p.name, skill: p.skill })),
      })),
      text: asText(teams),
    };
  },
});

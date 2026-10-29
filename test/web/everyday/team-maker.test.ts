import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import teams, { asText, makeTeams, parsePeople, teamCount, teamName } from '../../../src/tools/web/everyday/team-maker.js';
import { makeRandInt } from '../../../src/tools/web/everyday/_random.js';

// Known answers copied from team-maker's S3_SELFTEST.
describe('random_teams (team-maker self-test)', () => {
  const r = makeRandInt();
  it('parses people and skills', () => {
    const p = parsePeople('Ali, 4\nSara:2\n Omar \n\nLina 5\nPlayer;10\nNo, 500');
    expect(p).toHaveLength(6);
    expect([p[0].skill, p[1].name, p[1].skill, p[2].skill, p[3].name, p[4].skill, p[5].skill]).toEqual([4, 'Sara', 2, null, 'Lina 5', 10, null]);
  });
  it('splits and balances', () => {
    const ppl = 'ABCDEFGHIJ'.split('').map((c) => ({ name: c, skill: null }));
    const t = makeTeams(ppl, 3, false, r);
    expect(t.map((x) => x.members.length).sort().join()).toBe('3,3,4');
    expect(t.flatMap((x) => x.members.map((m) => m.name)).sort().join('')).toBe('ABCDEFGHIJ');
    expect(teamCount('per', 4, 10)).toBe(3);
    expect(teamCount('teams', 4, 10)).toBe(4);
    const skilled = [5, 5, 4, 4, 3, 3, 2, 2, 1, 1].map((s, i) => ({ name: 'p' + i, skill: s }));
    for (let k = 0; k < 20; k++) {
      const bt = makeTeams(skilled, 2, true, r);
      expect([bt[0].total, bt[1].total, bt[0].members.length]).toEqual([15, 15, 5]);
    }
  });
  it('names teams and formats text', () => {
    expect(teamName(0, 'colors', [])).toBe('Team Red');
    expect(teamName(1, 'letters', [])).toBe('Team B');
    expect(teamName(0, 'custom', ['Stars'])).toBe('Stars');
    expect(teamName(2, 'custom', ['Stars'])).toBe('Team 3');
    expect(teamName(13, 'animals', [])).toBe('Falcons 2');
    expect(asText([{ name: 'Team 1', members: [{ name: 'Ali' }, { name: 'Sara' }] }])).toBe('Team 1 (2)\n- Ali\n- Sara\n');
  });
  it('runs as a tool', async () => {
    const input = { people: ['Ali, 5', 'Sara, 4', 'Omar, 3', 'Lina, 5', 'Yousef, 2', 'Noor, 4', 'Kareem, 3', 'Huda, 2', 'Zaid, 1', 'Maya, 4', 'Rami, 3', 'Dana, 1'], num: 3, naming: 'animals', seed: 'demo' };
    const out = await call<{ teams: { name: string; size: number; totalSkill: number }[]; text: string }>(teams, input);
    expect(out.teams.map((t) => t.name)).toEqual(['Lions', 'Falcons', 'Wolves']);
    expect(out.teams.map((t) => t.size)).toEqual([4, 4, 4]);
    expect(out.teams.reduce((a, t) => a + t.totalSkill, 0)).toBe(37);
    expect(await call(teams, input)).toEqual(out);
    await expect(call(teams, { text: 'a\nb', mode: 'per', num: 2 })).rejects.toThrow(/only one team/);
  });
});

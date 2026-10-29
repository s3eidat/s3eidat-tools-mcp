import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, need, num, optNumLike } from './_common.js';

// Ported from https://github.com/s3eidat/gpa-calc (app.js): credit-weighted averages on the same grade scales.
export const SCALES: Record<string, [string, number][]> = {
  '4.0': [['A', 4], ['A-', 3.7], ['B+', 3.3], ['B', 3], ['B-', 2.7], ['C+', 2.3], ['C', 2], ['C-', 1.7], ['D+', 1.3], ['D', 1], ['D-', 0.7], ['F', 0]],
  '4.3': [['A+', 4.3], ['A', 4], ['A-', 3.7], ['B+', 3.3], ['B', 3], ['B-', 2.7], ['C+', 2.3], ['C', 2], ['C-', 1.7], ['D+', 1.3], ['D', 1], ['D-', 0.7], ['F', 0]],
  '5.0': [['A+', 5], ['A', 4.75], ['B+', 4.5], ['B', 4], ['C+', 3.5], ['C', 3], ['D+', 2.5], ['D', 2], ['F', 1]],
};

export function points(scale: string, letter: string) { const g = (SCALES[scale] || []).find((x) => x[0] === letter); return g ? g[1] : NaN; }
interface Scale { scale: string; pmin: number; pmax: number }
export function bounds(s: Scale): [number, number] { return s.scale === 'pct' ? [s.pmin, s.pmax] : [SCALES[s.scale][SCALES[s.scale].length - 1][1], SCALES[s.scale][0][1]]; }
export interface Sum { credits: number; pts: number; gpa: number }
export function weighted(rows: { credits: number; value: number }[]): Sum {
  let cr = 0, pts = 0;
  rows.forEach((r) => { if (r.credits > 0 && isFinite(r.value)) { cr += r.credits; pts += r.credits * r.value; } });
  return { credits: cr, pts, gpa: cr ? pts / cr : NaN };
}
export function cumulative(prevCr: number, prevGpa: number, sem: Sum): Sum {
  const ok = prevCr > 0 && isFinite(prevGpa);
  const cr = (ok ? prevCr : 0) + sem.credits, pts = (ok ? prevCr * prevGpa : 0) + sem.pts;
  return { credits: cr, pts, gpa: cr ? pts / cr : NaN };
}
export const needed = (cum: Sum, target: number, upcoming: number) => (upcoming > 0 ? (target * (cum.credits + upcoming) - cum.pts) / upcoming : NaN);
/** toPrecision first so 2.675 rounds to 2.68 (2.675 * 100 is 267.4999… in binary floating point). */
export function f2(v: number) { return isFinite(v) ? (Math.round(Number((v * 100).toPrecision(12))) / 100).toFixed(2) : '—'; }
const n2 = (v: number) => (isFinite(v) ? Number(f2(v)) : null);

export default defineTool({
  name: 'calc_gpa',
  title: 'GPA calculator',
  webSlug: 'gpa-calc',
  description:
    'Credit-weighted semester GPA, cumulative GPA (with previous credits and GPA) and the average you need over the remaining ' +
    'credits to reach a target. Scales: 4.0 (A…F, no A+), 4.3 (A+ = 4.3), 5.0 (A+ 5, A 4.75, B+ 4.5 … F 1) with letter grades, ' +
    'or "percent" with numeric marks between a minimum and maximum (default 35–100). Courses with no credits or an invalid ' +
    `grade are skipped (and listed). Up to 40 courses. Web version: ${webUrl('gpa-calc')}`,
  inputSchema: z.object({
    scale: z.enum(['4.0', '4.3', '5.0', 'percent']).optional().default('4.0').describe('Grading scale.'),
    percentMin: optNumLike('percent scale: lowest passing mark (default 35).'),
    percentMax: optNumLike('percent scale: highest mark (default 100).'),
    courses: z.array(z.object({
      name: z.string().optional().describe('Course name (optional).'),
      credits: z.union([z.number(), z.string()]).describe('Credit hours.'),
      grade: z.union([z.string(), z.number()]).describe('Letter grade (A, B+, …) on letter scales, or the mark on the percent scale.'),
    })).max(40).describe('This semester\'s courses.'),
    previousCredits: optNumLike('Credits completed before this semester.'),
    previousGpa: optNumLike('GPA before this semester.'),
    targetGpa: optNumLike('Target cumulative GPA.'),
    remainingCredits: optNumLike('Credits still to take after this semester (for the target).'),
  }),
  outputSchema: z.object({
    scale: z.string(),
    semester: z.object({ gpa: z.number().nullable(), display: z.string(), credits: z.number(), points: z.number() }),
    cumulative: z.object({ gpa: z.number().nullable(), display: z.string(), credits: z.number() }),
    target: z.object({ status: z.enum(['needed', 'not_reachable', 'already_safe']), neededAverage: z.number().nullable(), letter: z.string().optional(), message: z.string() }).optional(),
    skipped: z.array(z.object({ index: z.number(), name: z.string().optional(), reason: z.string() })),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { courses: [{ credits: 3, grade: 'A' }, { credits: 3, grade: 'B+' }, { credits: 4, grade: 'C' }], previousCredits: 30, previousGpa: 3.2, targetGpa: 3.3, remainingCredits: 15 },
    note: 'semester 2.99, cumulative 3.15, need 3.71 (about A-)' }],
  run(input) {
    const pct = input.scale === 'percent';
    const ss: Scale = { scale: pct ? 'pct' : input.scale, pmin: need(input.percentMin, 'percentMin', 35), pmax: need(input.percentMax, 'percentMax', 100) };
    const b = bounds(ss), unit = pct ? '%' : '';
    if (pct && !(ss.pmax > ss.pmin)) throw new ToolError('percentMax must be above percentMin.');
    const skipped: { index: number; name?: string; reason: string }[] = [];
    const rows = input.courses.map((c, i) => {
      const credits = num(c.credits);
      let value: number;
      if (pct) { const m = num(c.grade); value = m >= b[0] && m <= b[1] ? m : NaN; }
      else value = points(input.scale, String(c.grade).trim().toUpperCase());
      if (!(credits > 0)) skipped.push({ index: i, name: c.name, reason: 'credits must be above 0' });
      else if (!isFinite(value)) skipped.push({ index: i, name: c.name, reason: pct ? `mark must be ${b[0]}–${b[1]}` : `"${c.grade}" is not a grade on the ${input.scale} scale (${SCALES[input.scale].map((g) => g[0]).join(', ')})` });
      return { credits, value };
    });
    const sem = weighted(rows);
    const pcr = need(input.previousCredits, 'previousCredits', NaN), pg = need(input.previousGpa, 'previousGpa', NaN);
    const cum = cumulative(pcr, pg, sem);
    const out: Record<string, unknown> = {
      scale: input.scale,
      semester: { gpa: n2(sem.gpa), display: f2(sem.gpa) + (isFinite(sem.gpa) ? unit : ''), credits: sem.credits, points: Math.round(sem.pts * 100) / 100 },
      cumulative: { gpa: n2(cum.gpa), display: f2(cum.gpa) + (isFinite(cum.gpa) ? unit : ''), credits: cum.credits },
      skipped,
    };
    const tgt = need(input.targetGpa, 'targetGpa', NaN), rem = need(input.remainingCredits, 'remainingCredits', NaN);
    let needText = '';
    if (tgt > 0 && rem > 0 && cum.credits) {
      const n = needed(cum, tgt, rem);
      if (n > b[1] + 1e-9) {
        needText = 'Not reachable: you would need an average of ' + f2(n) + unit + ' over ' + rem + ' credits, above the maximum ' + b[1] + unit + '.';
        out.target = { status: 'not_reachable', neededAverage: n2(n), message: needText };
      } else if (n <= b[0]) {
        needText = 'Already safe: even the lowest grade keeps you at or above ' + f2(tgt) + unit + '.';
        out.target = { status: 'already_safe', neededAverage: n2(n), message: needText };
      } else {
        const letter = pct ? undefined : SCALES[input.scale].slice().reverse().find((g) => g[1] >= n - 1e-9);
        needText = 'You need an average of ' + f2(n) + unit + ' over the next ' + rem + ' credits' + (letter ? ' (about ' + letter[0] + ' or better)' : '') + ' to reach ' + f2(tgt) + unit + '.';
        out.target = { status: 'needed', neededAverage: n2(n), ...(letter ? { letter: letter[0] } : {}), message: needText };
      }
    }
    out.summary = 'Semester GPA: ' + f2(sem.gpa) + unit + ' (' + sem.credits + ' credits)\nCumulative GPA: ' + f2(cum.gpa) + unit + ' (' + cum.credits + ' credits)' + (needText ? '\n' + needText : '');
    return out;
  },
});

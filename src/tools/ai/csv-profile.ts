import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { cellType, loadTable, tableSourceFields, type CellType } from './_table.js';

const TOP = 5;
const SAMPLES = 5;

const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;
const show = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export interface ColumnProfile {
  name: string;
  type: string;
  nonNull: number;
  nulls: number;
  unique: number;
  top: { value: string; count: number }[];
  samples: string[];
  types?: Record<string, number>;
  min?: number | string;
  max?: number | string;
  mean?: number;
  median?: number;
  stddev?: number;
  minLength?: number;
  maxLength?: number;
  warnings: string[];
}

/** Profile one column of raw-ish values (CSV cells as strings; JSON/XLSX values as they are). */
export function profileColumn(name: string, values: unknown[]): ColumnProfile {
  const counts = new Map<string, number>();
  const typeCounts: Partial<Record<CellType, number>> = {};
  const nums: number[] = [];
  const dates: string[] = [];
  let nulls = 0, spaced = 0, minLen = Infinity, maxLen = 0;
  const samples: string[] = [];
  for (const v of values) {
    const t = cellType(v);
    if (t === 'null') { nulls++; continue; }
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    const s = show(v);
    if (typeof v === 'string') {
      if (s !== s.trim()) spaced++;
      minLen = Math.min(minLen, s.length);
      maxLen = Math.max(maxLen, s.length);
    }
    const key = typeof v === 'string' ? s.trim() : s;
    if (!counts.has(key) && samples.length < SAMPLES) samples.push(s);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (t === 'integer' || t === 'number') nums.push(typeof v === 'number' ? v : Number(String(v).trim()));
    if (t === 'date' || t === 'datetime') dates.push(v instanceof Date ? v.toISOString() : String(v).trim());
  }
  const nonNull = values.length - nulls;
  const warnings: string[] = [];

  // Dominant type: integer+number → number, date+datetime → datetime.
  const merged: Record<string, number> = {};
  for (const [t, c] of Object.entries(typeCounts)) {
    const k = t === 'integer' && typeCounts.number ? 'number' : t === 'date' && typeCounts.datetime ? 'datetime' : t;
    merged[k] = (merged[k] ?? 0) + c;
  }
  const ranked = Object.entries(merged).sort((a, b) => b[1] - a[1]);
  const type = ranked.length ? ranked[0][0] : 'empty';
  if (ranked.length > 1) warnings.push(`mixed types: ${ranked.map(([t, c]) => `${t} ${c}`).join(', ')}`);
  if (spaced) warnings.push(`${spaced} value${spaced === 1 ? '' : 's'} with leading/trailing spaces`);
  if (!nonNull && values.length) warnings.push('column is empty');
  else if (nulls && nulls / values.length >= 0.5) warnings.push(`${Math.round((nulls / values.length) * 100)}% missing`);
  if (nonNull > 1 && counts.size === 1) warnings.push('constant: every value is the same');

  const p: ColumnProfile = {
    name, type, nonNull, nulls, unique: counts.size,
    top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([value, count]) => ({ value, count })),
    samples, warnings,
  };
  if (ranked.length > 1) p.types = merged;
  if ((type === 'number' || type === 'integer') && nums.length) {
    const sorted = [...nums].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    Object.assign(p, {
      min: sorted[0], max: sorted[n - 1], mean: round(mean),
      median: n % 2 ? sorted[(n - 1) / 2] : round((sorted[n / 2 - 1] + sorted[n / 2]) / 2),
      stddev: round(Math.sqrt(variance)),
    });
  } else if ((type === 'date' || type === 'datetime') && dates.length) {
    const sorted = [...dates].sort();
    p.min = sorted[0];
    p.max = sorted[sorted.length - 1];
  } else if (type === 'string' && minLen !== Infinity) {
    p.minLength = minLen;
    p.maxLength = maxLen;
  }
  return p;
}

const colShape = z.object({
  name: z.string(),
  type: z.string().describe('Dominant type: integer, number, boolean, date, datetime, string, object, array or empty.'),
  nonNull: z.number(), nulls: z.number(), unique: z.number().describe('Distinct non-null values (trimmed).'),
  top: z.array(z.object({ value: z.string(), count: z.number() })),
  samples: z.array(z.string()),
  types: z.record(z.string(), z.number()).optional().describe('Count per type, when the column mixes types.'),
  min: z.union([z.number(), z.string()]).optional(), max: z.union([z.number(), z.string()]).optional(),
  mean: z.number().optional(), median: z.number().optional(), stddev: z.number().optional().describe('Sample standard deviation (n-1).'),
  minLength: z.number().optional(), maxLength: z.number().optional(),
  warnings: z.array(z.string()),
});

export default defineTool({
  name: 'ai_csv_profile',
  title: 'Profile a table (CSV, JSON, XLSX)',
  description:
    'Profile a table to understand and clean it before analysis: row and column counts, and per column the inferred type ' +
    '(integer, number, boolean, date, datetime, string), non-null and null counts, unique count, top 5 values, sample values, ' +
    'min/max/mean/median/stddev for numbers, min/max for ISO dates, min/max length for text, plus data-quality warnings ' +
    '(mixed types, leading/trailing spaces, mostly missing, constant columns, duplicate rows, ragged headers). Input: "file" ' +
    '(local path or base64 of CSV, TSV, JSON array, JSONL or .xlsx, first sheet or "sheet") or inline "csv" / "json". ' +
    'Empty cells, "null" and "NULL" count as missing. Runs locally; nothing is uploaded.',
  inputSchema: z.object({
    ...tableSourceFields,
    columns: z.array(z.string()).optional().describe('Only profile these columns (default: all).'),
  }),
  outputSchema: z.object({
    rows: z.number(),
    columns: z.number(),
    format: z.string(),
    sheet: z.string().optional(),
    duplicateRows: z.number().describe('Rows that exactly repeat an earlier row.'),
    profile: z.array(colShape),
    warnings: z.array(z.string()).describe('Table-level warnings.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: { csv: 'name,age\nAda,36\nBob ,41\nAda,36\n,' },
    output: { rows: 4, columns: 2, duplicateRows: 1 },
  }],
  async run(input, ctx) {
    const t = await loadTable(input, ctx, { types: false });
    const pick = input.columns?.length ? t.columns.filter((c) => input.columns!.includes(c)) : t.columns;
    const missing = (input.columns ?? []).filter((c) => !t.columns.includes(c));
    const seen = new Set<string>();
    let dup = 0;
    for (const r of t.rows) {
      const k = JSON.stringify(t.columns.map((c) => r[c]));
      if (seen.has(k)) dup++; else seen.add(k);
    }
    const warnings: string[] = [];
    if (dup) warnings.push(`${dup} duplicate row${dup === 1 ? '' : 's'}`);
    if (!t.rows.length) warnings.push('the table has no data rows');
    const auto = t.columns.filter((c) => /^column_\d+$/.test(c));
    if (auto.length) warnings.push(`unnamed columns: ${auto.join(', ')}`);
    const renamed = t.columns.filter((c) => /_\d+$/.test(c) && t.columns.includes(c.replace(/_\d+$/, '')));
    if (renamed.length) warnings.push(`duplicate header names renamed: ${renamed.join(', ')}`);
    if (missing.length) warnings.push(`columns not found: ${missing.join(', ')}`);
    const out: Record<string, unknown> = {
      rows: t.rows.length,
      columns: t.columns.length,
      format: t.format,
      duplicateRows: dup,
      profile: pick.map((c) => profileColumn(c, t.rows.map((r) => r[c]))),
      warnings,
    };
    if (t.sheet) out.sheet = t.sheet;
    return out;
  },
});

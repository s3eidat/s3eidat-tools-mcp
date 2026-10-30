import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import { outputPath } from '../../util/files.js';
import { loadTable, tableSourceFields, writeTable, type Row } from './_table.js';

// Functions a query may call. Everything else (file readers like CSV()/XLSX(), user JS) is refused.
const SAFE_FUNCS = new Set([
  'ABS', 'IIF', 'IFNULL', 'INSTR', 'LENGTH', 'LEN', 'LCASE', 'LOWER', 'LTRIM', 'RTRIM', 'GREATEST', 'MAX', 'LEAST', 'MIN',
  'MID', 'SUBSTR', 'SUBSTRING', 'NULLIF', 'ISNULL', 'POWER', 'CEILING', 'CEIL', 'FLOOR', 'ROWNUM', 'ROW_NUMBER',
  'GROUP_ROW_NUMBER', 'SQRT', 'TRIM', 'UCASE', 'UPPER', 'EXP', 'CONCAT', 'REGEXP_LIKE', 'ROUND', 'CONCAT_WS', 'REPLACE',
  'CONVERT', 'CHAR', 'ASCII', 'COALESCE', 'DATE', 'NOW', 'GETDATE', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURDATE',
  'SECOND', 'MINUTE', 'HOUR', 'WEEKDAY', 'DAYOFWEEK', 'DAYOFMONTH', 'DAY', 'MONTH', 'YEAR', 'DATEDIFF', 'DATEADD',
  'INTERVAL', 'ADDDATE', 'DATE_ADD', 'SUBDATE', 'DATE_SUB', 'TIMESTAMPDIFF', 'NUMBER', 'STRING', 'BOOLEAN',
]);
const SAFE_AGGR = new Set([
  'SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'FIRST', 'LAST', 'ARRAY', 'GROUP_CONCAT', 'MEDIAN', 'MODE', 'VAR', 'STDEV', 'VARP',
  'STDEVP', 'STDDEV', 'STD', 'QUART', 'QUART2', 'QUART3', 'TOTAL',
]);
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|TRUNCATE|MERGE|REQUIRE|SOURCE|USE|SET|DECLARE)\b/i;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Alasql = any;

/** Parse the SQL and refuse anything that isn't a single read-only SELECT over the given tables. */
export function checkQuery(alasql: Alasql, sql: string, tables: Set<string>) {
  let ast: any;
  try {
    ast = alasql.parse(sql);
  } catch (e) {
    const msg = (e as Error).message.split('\n').slice(0, 4).join('\n');
    const word = /got '([A-Z_]+)'/.exec(msg)?.[1];
    const hint = word && !['EOF', 'LITERAL', 'NUMBER', 'STRING'].includes(word)
      ? `\n${word} is a reserved word here; quote it as [${word.toLowerCase()}] or pick another name.` : '';
    throw new ToolError(`SQL syntax error: ${msg}${hint}`);
  }
  const yy = alasql.yy;
  const stmts: unknown[] = ast.statements ?? [];
  if (stmts.length !== 1) throw new ToolError('Give exactly one SELECT statement.');
  const top = stmts[0];
  if (!(top instanceof yy.Select) && !(top instanceof yy.WithSelect)) {
    const m = WRITE_WORDS.exec(sql);
    throw new ToolError(`Only SELECT queries are allowed${m ? ` (found ${m[1].toUpperCase()})` : ''}. The tables are read-only.`);
  }
  // CTE names count as tables.
  const known = new Set(tables);
  const seen = new Set<unknown>();
  const collect = (n: any) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (n instanceof yy.WithSelect) for (const w of n.withs ?? []) if (w?.name) known.add(String(w.name));
    for (const k of Object.keys(n)) collect(n[k]);
  };
  collect(top);
  seen.clear();
  const bad = (msg: string): never => { throw new ToolError(msg); };
  const walk = (n: any) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (n instanceof yy.JavaScript) bad('Inline JavaScript (``...``) is not allowed.');
    if (n instanceof yy.ParamValue) bad('Query parameters (?) are not supported; tables come only from "tables".');
    if (n instanceof yy.FromData) bad('Reading data from outside "tables" is not allowed.');
    if (n instanceof yy.VarValue) bad('Variables (@name) are not supported.');
    if (n instanceof yy.Search) bad('SEARCH statements are not supported; use SELECT.');
    if (n instanceof yy.Op && (n.op === '->' || n.op === '!')) bad('The -> and ! property operators are not allowed.');
    if (n.into) bad('SELECT ... INTO is not allowed: the query cannot write files or tables. Use "output" to save the result.');
    if (n instanceof yy.FuncValue) {
      const id = String(n.funcid ?? '').toUpperCase();
      if (/^(CSV|TSV|TAB|XLSX|XLS|JSON|TXT|FILE|HTML|XML|ODS|LOAD|REQUIRE|INFORMATION_SCHEMA)$/.test(id)) {
        bad(`${id}() file functions are not allowed: tables come only from "tables".`);
      }
      if (!SAFE_FUNCS.has(id)) bad(`Function ${n.funcid}() is not available. Allowed: ${[...SAFE_FUNCS].sort().join(', ')}.`);
    }
    if (n instanceof yy.AggrValue) {
      const id = String(n.aggregatorid ?? '').toUpperCase();
      if (!SAFE_AGGR.has(id)) bad(`Aggregate ${n.aggregatorid}() is not available.`);
    }
    if (n instanceof yy.Table) {
      if (n.databaseid) bad(`Table "${n.databaseid}.${n.tableid}": database prefixes are not allowed.`);
      if (!known.has(String(n.tableid))) {
        bad(`Unknown table "${n.tableid}". Tables: ${[...tables].join(', ')} (names are case-sensitive).`);
      }
    }
    for (const k of Object.keys(n)) if (typeof n[k] === 'object') walk(n[k]);
  };
  walk(top);
}

/** Normalise whatever alasql returned to columns + rows of objects. */
function normalise(res: unknown): { columns: string[]; rows: Row[] } {
  let rows: Row[];
  if (!Array.isArray(res)) rows = [{ value: res }];
  else if (res.length && res.every(Array.isArray)) {
    const w = Math.max(...(res as unknown[][]).map((r) => r.length));
    rows = (res as unknown[][]).map((r) => Object.fromEntries(Array.from({ length: w }, (_, i) => [`column_${i + 1}`, r[i] ?? null])));
  } else rows = (res as unknown[]).map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Row) : { value: r }));
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] === undefined ? null : r[c]]))) };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export default defineTool({
  name: 'ai_sql_query',
  title: 'SQL query over tables',
  description:
    'Run one read-only SQL SELECT (alasql dialect: JOIN, GROUP BY, HAVING, ORDER BY, LIMIT, UNION, WITH, subqueries, CASE, ' +
    'SUM/COUNT/AVG/MIN/MAX/MEDIAN/STDEV, string and date functions) over one or more tables. Each table is { name, file | csv | json }: ' +
    'a local path or base64 of a CSV, TSV, JSON array, JSONL or .xlsx (first sheet, or "sheet"), or inline CSV text / JSON rows. ' +
    'CSV cells are typed (numbers, true/false, empty → null; ISO dates stay ISO text, so they sort and compare correctly; ' +
    'YEAR()/MONTH() work on them). Only SELECT is allowed: INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/ATTACH, SELECT INTO, ' +
    'file readers like FROM CSV(...), inline JavaScript and the -> operator are refused. Table names are case-sensitive; quote ' +
    'odd column names and reserved words (total, value, count, date…) as [My Column]. Returns columns and up to maxRows rows (default 500) with the total count; set "output" ' +
    '(.csv, .tsv, .json, .jsonl or .xlsx) to save every row to a file. Runs locally; nothing is uploaded.',
  inputSchema: z.object({
    query: z.string().min(1).describe('One SELECT statement, e.g. SELECT region, SUM(amount) AS revenue FROM sales GROUP BY region ORDER BY revenue DESC'),
    tables: z.array(z.object({
      name: z.string().regex(NAME, 'Table names are letters, digits and _ (not starting with a digit).').describe('Table name used in the query.'),
      ...tableSourceFields,
    })).min(1).max(20).describe('The tables the query can read (1-20).'),
    types: z.boolean().optional().default(true).describe('Type CSV cells (numbers, booleans, null). Default true; false keeps every CSV cell as text.'),
    maxRows: z.number().int().min(0).max(100000).optional().default(500).describe('Rows to return inline (default 500). "total" always counts all rows.'),
    output: outputPath().describe('Optional: save ALL result rows to this file; the type comes from the extension (.csv, .tsv, .json, .jsonl, .xlsx; default .csv).'),
  }),
  outputSchema: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number().describe('Number of rows the query produced.'),
    truncated: z.boolean().describe('True when only the first maxRows rows are returned inline.'),
    tables: z.array(z.object({ name: z.string(), rows: z.number(), columns: z.array(z.string()), format: z.string() })),
    path: z.string().optional(),
    bytes: z.number().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: {
      query: 'SELECT region, SUM(amount) AS revenue FROM sales GROUP BY region ORDER BY revenue DESC',
      tables: [{ name: 'sales', csv: 'region,amount\nNorth,10\nSouth,5\nNorth,7.5' }],
    },
    output: { columns: ['region', 'revenue'], rows: [{ region: 'North', revenue: 17.5 }, { region: 'South', revenue: 5 }], total: 2, truncated: false },
  }],
  async run(input, ctx) {
    const names = input.tables.map((t) => t.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new ToolError(`Table name "${dup}" is used twice.`);
    const alasql: Alasql = (await import('alasql')).default;
    checkQuery(alasql, input.query, new Set(names));

    const loaded = [];
    for (const t of input.tables) loaded.push({ name: t.name, ...(await loadTable(t, ctx, { types: input.types, label: `table "${t.name}"` })) });

    const db = new alasql.Database();
    let res: unknown;
    try {
      for (const t of loaded) {
        // Give alasql its own copies so a query can never change the caller's objects.
        db.tables[t.name] = { data: t.rows.map((r) => ({ ...r })), columns: t.columns.map((c) => ({ columnid: c })) };
      }
      // WITH clauses resolve tables in alasql's current database, so switch to ours for this (synchronous) run.
      const prev = alasql.useid;
      alasql.use(db.databaseid);
      try {
        res = db.exec(input.query);
      } finally {
        alasql.use(prev);
      }
    } catch (e) {
      throw new ToolError(`Query failed: ${(e as Error).message}`);
    } finally {
      delete alasql.databases[db.databaseid];
    }

    const { columns, rows } = normalise(res);
    const out: Record<string, unknown> = {
      columns,
      rows: rows.slice(0, input.maxRows),
      total: rows.length,
      truncated: rows.length > input.maxRows,
      tables: loaded.map((t) => ({ name: t.name, rows: t.rows.length, columns: t.columns, format: t.format })),
    };
    if (input.output) {
      const w = await writeTable(columns, rows, input.output, ctx, 'query-result.csv');
      out.path = w.path;
      out.bytes = w.bytes;
    }
    return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
  },
});

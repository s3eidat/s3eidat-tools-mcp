import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { deliver, outputField, pathField, READ_ONLY, readText, resultShape, textField } from './_io.js';

// Ported from https://github.com/s3eidat/sql-format (app.js): own tokenizer + formatter. The SQL is only re-spaced.

function set(s: string) { const o: Record<string, boolean> = Object.create(null); for (const w of s.split(/\s+/)) if (w) o[w] = true; return o; }

const RESERVED = set(
  'SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET FETCH FIRST NEXT ROWS ROW ONLY UNION ALL DISTINCT INTERSECT EXCEPT MINUS ' +
  'INSERT INTO VALUES UPDATE SET DELETE RETURNING WITH RECURSIVE AS ON USING JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL APPLY LATERAL ' +
  'STRAIGHT_JOIN AND OR NOT NULL IS IN EXISTS BETWEEN LIKE ILIKE SIMILAR ESCAPE CASE WHEN THEN ELSE END ASC DESC NULLS LAST ' +
  'CREATE ALTER DROP TRUNCATE RENAME TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES CONSTRAINT CHECK DEFAULT COLUMN ADD ' +
  'IF REPLACE TEMPORARY TEMP CASCADE RESTRICT MATERIALIZED SCHEMA DATABASE SEQUENCE TRIGGER PROCEDURE FUNCTION RETURNS BEGIN COMMIT ' +
  'ROLLBACK TRANSACTION GRANT REVOKE TO OVER PARTITION WINDOW RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT FILTER WITHIN QUALIFY ' +
  'CONFLICT DO NOTHING DUPLICATE IGNORE TOP PERCENT TIES FOR SHARE NOWAIT SKIP LOCKED TRUE FALSE UNKNOWN COLLATE INTERVAL ' +
  'AUTO_INCREMENT IDENTITY GENERATED ALWAYS STORED VIRTUAL MERGE MATCHED EXPLAIN ANALYZE TIME ZONE YEAR MONTH DAY HOUR MINUTE SECOND ' +
  'INT INTEGER SMALLINT BIGINT TINYINT DECIMAL NUMERIC REAL FLOAT DOUBLE PRECISION SERIAL BIGSERIAL BOOLEAN BOOL CHAR VARCHAR NCHAR ' +
  'NVARCHAR TEXT BLOB CLOB BYTEA JSON JSONB UUID DATE DATETIME TIMESTAMP TIMESTAMPTZ VARYING');
const FUNCS = set(
  'COUNT SUM AVG MIN MAX COALESCE NULLIF CAST CONVERT TRY_CAST EXTRACT SUBSTRING SUBSTR TRIM LTRIM RTRIM UPPER LOWER LENGTH ' +
  'CHAR_LENGTH CONCAT CONCAT_WS ROUND FLOOR CEIL CEILING ABS MOD POWER SQRT NOW CURRENT_DATE CURRENT_TIMESTAMP DATE_TRUNC DATE_PART ' +
  'DATEADD DATEDIFF TO_CHAR TO_DATE STRING_AGG ARRAY_AGG GROUP_CONCAT JSON_AGG JSON_BUILD_OBJECT ROW_NUMBER RANK DENSE_RANK NTILE ' +
  'LAG LEAD FIRST_VALUE LAST_VALUE GREATEST LEAST IFNULL ISNULL NVL POSITION REPLACE LEFT RIGHT IF IIF FORMAT UNNEST GENERATE_SERIES');
// Multi-word keywords, longest first.
const PHRASES = [
  'INSERT IGNORE INTO', 'ON DUPLICATE KEY UPDATE', 'IS NOT DISTINCT FROM', 'CREATE OR REPLACE VIEW', 'CREATE OR REPLACE FUNCTION',
  'CREATE MATERIALIZED VIEW', 'CREATE UNIQUE INDEX', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'DO UPDATE SET',
  'IS DISTINCT FROM', 'WITH RECURSIVE', 'SELECT DISTINCT', 'SELECT ALL', 'GROUP BY', 'ORDER BY', 'PARTITION BY', 'UNION ALL',
  'UNION DISTINCT', 'INTERSECT ALL', 'EXCEPT ALL', 'INSERT INTO', 'REPLACE INTO', 'DELETE FROM', 'LEFT JOIN', 'RIGHT JOIN',
  'FULL JOIN', 'INNER JOIN', 'CROSS JOIN', 'NATURAL JOIN', 'CROSS APPLY', 'OUTER APPLY', 'ON CONFLICT', 'FOR UPDATE', 'FOR SHARE',
  'ON UPDATE', 'ON DELETE', 'CREATE TABLE', 'CREATE VIEW', 'CREATE INDEX', 'CREATE SCHEMA', 'CREATE FUNCTION', 'ALTER TABLE',
  'DROP TABLE', 'DROP VIEW', 'DROP INDEX', 'PRIMARY KEY', 'FOREIGN KEY', 'NOT NULL', 'IS NOT', 'NOT IN', 'NOT EXISTS',
  'NOT LIKE', 'NOT BETWEEN',
].map((p) => p.split(' ')).sort((a, b) => b.length - a.length);

const CLAUSE = set('SELECT|SELECT_DISTINCT|SELECT_ALL|FROM|WHERE|GROUP_BY|HAVING|ORDER_BY|LIMIT|OFFSET|FETCH|INSERT_INTO|REPLACE_INTO|INSERT_IGNORE_INTO|VALUES|DELETE_FROM|RETURNING|WINDOW|QUALIFY|DO_UPDATE_SET|ON_DUPLICATE_KEY_UPDATE'.split('|').join(' '));
const SETOP = set('UNION UNION_ALL UNION_DISTINCT INTERSECT INTERSECT_ALL EXCEPT EXCEPT_ALL MINUS');
const JOINS = set('JOIN LEFT_JOIN RIGHT_JOIN FULL_JOIN INNER_JOIN CROSS_JOIN NATURAL_JOIN LEFT_OUTER_JOIN RIGHT_OUTER_JOIN FULL_OUTER_JOIN CROSS_APPLY OUTER_APPLY STRAIGHT_JOIN');
// Words written like functions: keep "VARCHAR(100)" tight, as typed.
const TIGHT = set('INT INTEGER SMALLINT BIGINT TINYINT DECIMAL NUMERIC REAL FLOAT DOUBLE CHAR VARCHAR NCHAR NVARCHAR TEXT BLOB ' +
  'TIMESTAMP TIMESTAMPTZ TIME DATETIME VARYING FILTER IDENTITY CHECK KEY UNIQUE');
const OPS = ['->>', '#>>', '<=>', '!=', '<>', '<=', '>=', '||', '::', '->', '#>', '@>', '<@', '&&', ':=', '=>', '**', '!~', '~*'];

export interface Tok { type: string; v: string; ws: string; nl: boolean; bad?: boolean; U?: string; words?: string[]; unary?: boolean }

// ---------------- tokenizer ----------------
function scanQuoted(s: string, i: number, q: string, allowBackslash: boolean) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (allowBackslash && c === '\\') { j += 2; continue; }
    if (c === q) { if (s[j + 1] === q) { j += 2; continue; } return j + 1; }
    j++;
  }
  return -1;
}

export function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, ws = '', m: RegExpExecArray | string[] | null, bad = false;
  const n = s.length;
  function push(type: string, v: string) { toks.push({ type, v, ws, nl: /\n/.test(ws), bad }); ws = ''; bad = false; }
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) { m = /^\s+/.exec(s.slice(i, i + 4096))!; ws += m[0]; i += m[0].length; continue; }
    if (c === '-' && s[i + 1] === '-') { let e = s.indexOf('\n', i); if (e < 0) e = n; push('com', s.slice(i, e).replace(/\s+$/, '')); i = e; continue; }
    if (c === '/' && s[i + 1] === '*') { let e2 = s.indexOf('*/', i + 2); if (e2 < 0) bad = true; e2 = e2 < 0 ? n : e2 + 2; push('bcom', s.slice(i, e2)); i = e2; continue; }
    // strings, with optional N/E/X/B prefix
    let pre = 0;
    if (/[NnEeXxBb]/.test(c) && s[i + 1] === "'" && !/[\w$]/.test(s[i - 1] || '')) pre = 1;
    if (c === "'" || pre) {
      const q0 = i + pre;
      let end = scanQuoted(s, q0, "'", true);
      if (end < 0) end = scanQuoted(s, q0, "'", false);
      if (end < 0) { end = n; bad = true; }
      push('str', s.slice(i, end)); i = end; continue;
    }
    if (c === '$') {
      m = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i, i + 64));
      if (m) {
        const close = s.indexOf(m[0], i + m[0].length), e3 = close < 0 ? n : close + m[0].length;
        if (close < 0) bad = true;
        push('str', s.slice(i, e3)); i = e3; continue;
      }
      m = /^\$\d+/.exec(s.slice(i, i + 12));
      if (m) { push('var', m[0]); i += m[0].length; continue; }
    }
    if (c === '"' || c === '`') { let e4 = scanQuoted(s, i, c, false); if (e4 < 0) { e4 = n; bad = true; } push('qid', s.slice(i, e4)); i = e4; continue; }
    if (c === '[' && !/[\w)\]"]/.test(s[i - 1] || '')) {
      const e5 = s.indexOf(']', i);
      if (e5 > 0 && !/[\n[]/.test(s.slice(i + 1, e5))) { push('qid', s.slice(i, e5 + 1)); i = e5 + 1; continue; }
    }
    const rest = s.slice(i, i + 256);
    m = /^(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(rest);
    if (m && !(c === '.' && /[\w"`\])]/.test(s[i - 1] || ''))) { push('num', m[0]); i += m[0].length; continue; }
    m = /^[A-Za-z_@#\u{C0}-\u{FFFF}][\w$@#\u{C0}-\u{FFFF}]*/u.exec(rest);
    if (m) { push('word', m[0]); i += m[0].length; continue; }
    if ((c === ':' && s[i + 1] !== ':' && s[i - 1] !== ':' && /[A-Za-z_]/.test(s[i + 1] || '')) || c === '?') {
      m = c === '?' ? ['?'] : /^:[A-Za-z_]\w*/.exec(rest)!;
      push('var', m[0]); i += m[0].length; continue;
    }
    if (c === '(') { push('open', c); i++; continue; }
    if (c === ')') { push('close', c); i++; continue; }
    if (c === ',') { push('comma', c); i++; continue; }
    if (c === ';') { push('semi', c); i++; continue; }
    if (c === '.') { push('dot', c); i++; continue; }
    let op: string | null = null;
    for (const o of OPS) if (s.substr(i, o.length) === o) { op = o; break; }
    op = op || c;
    push('op', op); i += op.length;
  }
  return classify(toks);
}

function isCom(t: Tok | null | undefined) { return !!t && (t.type === 'com' || t.type === 'bcom'); }
function nextSig(toks: Tok[], i: number) { for (let j = i + 1; j < toks.length; j++) if (!isCom(toks[j])) return toks[j]; return null; }

// words → keyword / function / identifier; merge multi-word keywords
function classify(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  let prevSig: Tok | null = null;
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i];
    if (t.type === 'word') {
      const U = t.v.toUpperCase(), nx = toks[i + 1];
      if (prevSig && prevSig.type === 'dot') { t.type = 'word'; }
      else if (nx && nx.type === 'open' && !nx.ws && (FUNCS[U] || !RESERVED[U])) { t.type = 'fn'; t.U = U; }
      else if (RESERVED[U]) {
        t.type = 'kw'; t.U = U;
        for (const ph of PHRASES) {
          let ok = ph[0] === U;
          for (let k = 1; ok && k < ph.length; k++) {
            const w = toks[i + k];
            ok = !!w && w.type === 'word' && w.v.toUpperCase() === ph[k];
          }
          if (ok) {
            const words = [t.v];
            for (let k = 1; k < ph.length; k++) words.push(toks[i + k].v);
            t = { type: 'kw', v: words.join(' '), U: ph.join(' '), ws: t.ws, nl: t.nl, words };
            i += ph.length - 1; break;
          }
        }
      }
    }
    out.push(t);
    if (!isCom(t)) prevSig = t;
  }
  return out;
}

export type KeywordCase = 'upper' | 'lower' | 'preserve';

function applyCase(t: Tok, mode: KeywordCase) {
  if (mode === 'preserve') return t.v;
  if (t.type === 'kw' || (t.type === 'fn' && FUNCS[t.U!])) return mode === 'upper' ? t.v.toUpperCase() : t.v.toLowerCase();
  return t.v;
}

// ---------------- formatter ----------------
interface Frame { kind: string; base?: number; stmt?: string; clause?: string | null; verb?: string; between?: boolean; inline?: boolean; level?: number; open?: number; blockDone?: boolean }

export interface FormatOpts { indent?: string | number; kwcase?: KeywordCase; commas?: 'trailing' | 'leading' }

export function format(sql: string, opt: FormatOpts = {}): string {
  const unit = opt.indent === 'tab' ? '\t' : ' '.repeat(+(opt.indent ?? 2) || 2), kcase = opt.kwcase || 'upper', leading = opt.commas === 'leading';
  const toks = tokenize(sql), parts: string[] = [];
  let lineIndent = 0, pending: number | null = null, blank = false, prev: Tok | null = null;
  let frames: Frame[] = [{ kind: 'root', base: 0 }];
  const top = () => frames[frames.length - 1];
  const nl = (level: number) => { pending = level; };
  function emit(text: string, space: boolean) {
    if (parts.length && pending !== null) { parts.push('\n' + (blank ? '\n' : '') + unit.repeat(pending)); lineIndent = pending; }
    else if (parts.length && space) parts.push(' ');
    else if (!parts.length && pending !== null) lineIndent = pending;
    if (!parts.length && pending) parts.push(unit.repeat(pending));
    pending = null; blank = false;
    parts.push(text);
  }
  function needSpace(p: Tok | null, t: Tok) {
    if (!p) return false;
    if (/^(comma|semi|close|dot)$/.test(t.type) || p.type === 'open' || p.type === 'dot') return false;
    if (t.v === '::' || p.v === '::') return false;
    if (p.unary) return false;
    if (t.type === 'open') {
      if (p.type === 'fn') return false;
      if (p.type === 'kw') return TIGHT[p.U!] ? !!t.ws : true;
      if (p.type === 'word' || p.type === 'qid') return !!t.ws;
      if (p.type === 'close' || p.type === 'open') return !!t.ws;
    }
    return true;
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], f = top(), U = t.U || '', key = U.replace(/ /g, '_');
    if (isCom(t)) {
      if (!t.nl && parts.length) {
        const saved: number | null = pending; pending = null;
        emit(t.v, true);
        pending = saved !== null ? saved : t.type === 'com' ? lineIndent : null;
      } else {
        const lvl: number = pending !== null ? pending : lineIndent;
        if (parts.length) pending = lvl;
        emit(t.v, false);
        const nx = toks[i + 1];
        pending = t.type === 'com' || (nx && nx.nl) ? lvl : null;
      }
      continue;
    }
    const text = applyCase(t, kcase), stmtScope = f.kind === 'root' || f.kind === 'sub';
    if (t.type === 'op' && (t.v === '-' || t.v === '+') && (!prev || /^(op|open|comma|kw)$/.test(prev.type))) t.unary = true;

    if (t.type === 'semi') {
      emit(text, false);
      frames = [{ kind: 'root', base: 0 }]; pending = 0; blank = true; prev = t; continue;
    }
    if (t.type === 'kw' && stmtScope) {
      const atStart = !f.stmt, base = f.base!;
      if (SETOP[key]) { nl(base); emit(text, true); nl(base); f.clause = null; prev = t; continue; }
      const isClause = CLAUSE[key] ||
        (key === 'UPDATE' && (atStart || f.stmt === 'WITH')) ||
        (key === 'SET' && f.verb === 'UPDATE') ||
        (key === 'WITH' && atStart) || (key === 'WITH_RECURSIVE' && atStart);
      if (isClause) {
        nl(base); emit(text, true); nl(base + 1);
        f.clause = key; if (!f.stmt) f.stmt = key;
        if (key === 'UPDATE') f.verb = 'UPDATE';
        prev = t; continue;
      }
      if (key === 'ON_CONFLICT' || key === 'FOR_UPDATE' || key === 'FOR_SHARE') { nl(base); emit(text, true); f.clause = key; prev = t; continue; }
      if (JOINS[key]) { nl(base + 1); emit(text, true); f.clause = 'JOIN'; prev = t; continue; }
      if (atStart && /^(CREATE|ALTER|DROP|TRUNCATE|SET|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|EXPLAIN|MERGE)/.test(key)) {
        if (parts.length) nl(base);
        emit(text, true); f.stmt = key; f.clause = key; prev = t; continue;
      }
      if ((key === 'AND' || key === 'OR') && !f.between) {
        if (f.clause === 'WHERE' || f.clause === 'HAVING' || f.clause === 'QUALIFY') nl(base + 1);
        else if (f.clause === 'JOIN') nl(base + 2);
      }
      if (key === 'AND' && f.between) f.between = false;
      if (key === 'BETWEEN' || key === 'NOT_BETWEEN') f.between = true;
    }
    if (t.type === 'kw' && key === 'CASE') {
      emit(text, needSpace(prev, t));
      frames.push({ kind: 'case', inline: f.kind === 'inline' || (f.kind === 'case' && f.inline), level: lineIndent + 1 });
      prev = t; continue;
    }
    if (t.type === 'kw' && f.kind === 'case' && (key === 'WHEN' || key === 'ELSE' || key === 'END')) {
      if (!f.inline) nl(key === 'END' ? f.level! - 1 : f.level!);
      emit(text, true);
      if (key === 'END') frames.pop();
      prev = t; continue;
    }
    if (t.type === 'open') {
      const ns = nextSig(toks, i), nU = (ns && ns.U) || '';
      const kind = /^(SELECT|WITH)/.test(nU) ? 'sub'
        : f.kind === 'root' && /^CREATE.*TABLE/.test(f.stmt || '') && !f.blockDone ? 'block' : 'inline';
      emit(text, needSpace(prev, t));
      if (kind === 'sub') { frames.push({ kind: 'sub', base: lineIndent + 1, open: lineIndent }); nl(lineIndent + 1); }
      else if (kind === 'block') { f.blockDone = true; frames.push({ kind: 'block', level: lineIndent + 1, open: lineIndent }); nl(lineIndent + 1); }
      else frames.push({ kind: 'inline' });
      prev = t; continue;
    }
    if (t.type === 'close') {
      while (frames.length > 1 && top().kind === 'case') frames.pop();
      const fr = frames.length > 1 ? frames.pop()! : { kind: 'inline' } as Frame;
      if (fr.kind === 'sub' || fr.kind === 'block') nl(fr.open!);
      emit(text, false);
      prev = t; continue;
    }
    if (t.type === 'comma') {
      const level = f.kind === 'block' ? f.level! : stmtScope ? f.base! + 1 : null;
      if (level === null) emit(text, false);
      else if (leading) { nl(level); emit(text, false); }
      else { emit(text, false); nl(level); }
      prev = t; continue;
    }
    emit(text, needSpace(prev, t));
    prev = t;
  }
  return parts.join('');
}

export function minify(sql: string, keepComments: boolean): string {
  const toks = tokenize(sql), out: string[] = [];
  let prev: Tok | null = null;
  const wordish = (t: Tok) => /^(word|kw|fn|num|str|qid|var|bcom)$/.test(t.type);
  for (let t of toks) {
    let v = t.v;
    if (isCom(t)) {
      const hint = /^\/\*[+!]/.test(v);
      if (!keepComments && !hint) continue;
      if (t.type === 'com') { const body = v.slice(2).trim(); if (body.indexOf('*/') >= 0) continue; v = '/* ' + body + ' */'; }
      t = { type: 'bcom', v, ws: '', nl: false };
    }
    if (prev) {
      const a: Tok = prev, b = t;
      let tight =
        a.type === 'open' || a.type === 'dot' || a.type === 'comma' || a.type === 'semi' ||
        /^(close|comma|semi|dot|open)$/.test(b.type) ||
        (a.type === 'op' && wordish(b) && b.type !== 'kw' && b.type !== 'bcom') ||
        (b.type === 'op' && wordish(a) && a.type !== 'kw' && a.type !== 'bcom' && (a.type as string) !== 'close');
      if (a.type === 'close' && b.type === 'op') tight = true;
      if (b.type === 'open' && a.type === 'op') tight = false;
      if (a.type === 'op' && b.type === 'op') tight = tokenize(a.v + b.v).length === 2;
      if (a.type === 'semi') out.push('\n');
      else if (!tight) out.push(' ');
    }
    out.push(v); prev = t;
  }
  return out.join('');
}

/** Token signature ignoring comments and keyword case: used to prove formatting kept every token. */
export function sig(toks: Tok[]) {
  return toks.filter((t) => !isCom(t)).map((t) => (/^(kw|fn|word)$/.test(t.type) ? t.v.toUpperCase().split(/\s+/).join(' ') : t.v)).join('\u0001');
}

export default defineTool({
  name: 'sql_format',
  title: 'SQL format / minify',
  webSlug: 'sql-format',
  description:
    'Format SQL (one clause per line, indented sub-queries, CASE blocks, JOIN … ON with AND/OR, CREATE TABLE column lists) or ' +
    'minify it to one line per statement. Options: keyword case (UPPER, lower, keep), indent (2, 4, tab), trailing or leading ' +
    'commas, keep/drop comments when minifying. Dialect-neutral tokenizer: understands -- and /* */ comments, \'\' and E\'\\\'\' ' +
    'strings, "x", `x` and [x] identifiers, $$ dollar quotes, ::casts, JSON operators, :name/$1/? parameters. Only re-spaces; ' +
    `never runs anything. Give "text" or a file "path". Web version: ${webUrl('sql-format')}`,
  inputSchema: z.object({
    text: textField('SQL'),
    path: pathField('.sql'),
    mode: z.enum(['format', 'minify']).optional().default('format').describe('"format" (default) or "minify".'),
    keywordCase: z.enum(['upper', 'lower', 'preserve']).optional().default('upper').describe('Keyword and built-in function case.'),
    indent: z.union([z.enum(['2', '4', 'tab']), z.literal(2), z.literal(4)]).optional().default('2').describe('Indentation: 2, 4 or "tab".'),
    commas: z.enum(['trailing', 'leading']).optional().default('trailing').describe('Put list commas at line ends (trailing) or starts (leading).'),
    keepComments: z.boolean().optional().default(true).describe('Minify only: keep comments (as /* */). Optimizer hints /*+ */ and /*! */ are always kept.'),
    output: outputField(),
  }),
  outputSchema: z.object({
    statements: z.number(), lines: z.number(),
    warning: z.string().optional().describe('Set when a quote or comment is never closed.'),
    ...resultShape,
  }),
  annotations: READ_ONLY,
  examples: [{ input: { text: 'select a, b from t where x = 1 and y = 2' }, output: { statements: 1, lines: 8, result: 'SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1\n  AND y = 2' } }],
  async run(input, ctx) {
    const src = await readText(input, ctx);
    if (!src.trim()) throw new ToolError('The SQL is empty.');
    const out = input.mode === 'minify'
      ? minify(src, input.keepComments)
      : format(src, { indent: input.indent, kwcase: input.keywordCase, commas: input.commas });
    const toks = tokenize(src);
    const unclosed = toks.some((t) => t.bad);
    const semis = toks.filter((t) => t.type === 'semi').length;
    const lastSig = [...toks].reverse().find((t) => !isCom(t));
    return {
      statements: semis + (lastSig && lastSig.type !== 'semi' ? 1 : 0),
      lines: out.split('\n').length,
      ...(unclosed ? { warning: 'Unclosed quote or comment' } : {}),
      ...(await deliver(out, { output: input.output, defaultName: 'query.sql', mimeType: 'application/sql' }, ctx)),
    };
  },
});

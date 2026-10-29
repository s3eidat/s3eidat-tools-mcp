import { describe, expect, it } from 'vitest';
import tool, { format, minify, sig, tokenize, type FormatOpts } from '../../../src/tools/web/data/sql-format.js';
import { call } from '../../helpers.js';

const F = (s: string, o: FormatOpts = {}) => format(s, o);
const SAMPLE = "-- monthly revenue per active customer\nwith recent as (select customer_id, sum(total) as revenue, count(*) orders from orders o where o.created_at >= date '2026-01-01' and o.status in ('paid','shipped') group by customer_id having count(*) > 1)\n" +
  "select c.id, c.name, r.revenue, case when r.revenue > 1000 then 'gold' when r.revenue > 250 then 'silver' else 'bronze' end as tier, " +
  '(select max(created_at) from orders x where x.customer_id = c.id) last_order from customers c inner join recent r on r.customer_id = c.id ' +
  "left join regions g on g.id = c.region_id and g.active = true where c.deleted_at is null and c.name not like 'Test%' order by r.revenue desc limit 50;\n" +
  "update customers set tier = 'gold', updated_at = now() where id in (1, 2, 3);";

// Known answers from the website's S3_SELFTEST.
describe('sql-format self-test', () => {
  it('formats', () => {
    expect(F('select a, b from t where x = 1 and y = 2')).toBe('SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1\n  AND y = 2');
    expect(F('select a,b from t', { commas: 'leading' })).toBe('SELECT\n  a\n  , b\nFROM\n  t');
    expect(F('SELECT a FROM t', { kwcase: 'lower', indent: '4' })).toBe('select\n    a\nfrom\n    t');
    expect(F('select a from t where a between 1 and 5 and b = 2')).toBe('SELECT\n  a\nFROM\n  t\nWHERE\n  a BETWEEN 1 AND 5\n  AND b = 2');
    expect(F('select * from t where id in (select id from u)')).toBe('SELECT\n  *\nFROM\n  t\nWHERE\n  id IN (\n    SELECT\n      id\n    FROM\n      u\n  )');
    expect(F("select case when a=1 then 'x' else 'y' end as c from t")).toBe("SELECT\n  CASE\n    WHEN a = 1 THEN 'x'\n    ELSE 'y'\n  END AS c\nFROM\n  t");
    expect(F('select count(*), extract(year from d) from t')).toBe('SELECT\n  COUNT(*),\n  EXTRACT(YEAR FROM d)\nFROM\n  t');
    expect(F('select * from a left join b on a.id=b.id and b.x=1')).toBe('SELECT\n  *\nFROM\n  a\n  LEFT JOIN b ON a.id = b.id\n    AND b.x = 1');
    expect(F('create table u (id int primary key, name varchar(100) not null);')).toBe('CREATE TABLE u (\n  id INT PRIMARY KEY,\n  name VARCHAR(100) NOT NULL\n);');
    expect(F("insert into t (a, b) values (1, 'x'), (2, 'y')")).toBe("INSERT INTO\n  t (a, b)\nVALUES\n  (1, 'x'),\n  (2, 'y')");
    expect(F('select a::text, -1, b - 2 from t')).toBe('SELECT\n  a::TEXT,\n  -1,\n  b - 2\nFROM\n  t');
  });
  const tricky = "select 'it''s -- not a comment', \"weird \"\" col\", `x y`, $$a;b$$, E'a\\'b' /* c1 */ from t -- tail\nwhere s = '/* nope */';";
  it('tokenizes tricky input', () => {
    const tt = tokenize(tricky).map((t) => t.type + ':' + t.v);
    expect(tt[1]).toBe("str:'it''s -- not a comment'");
    expect(tt[3]).toBe('qid:"weird "" col"');
    expect(tt[5]).toBe('qid:`x y`');
    expect(tt[7]).toBe('str:$$a;b$$');
    expect(tt[9]).toBe("str:E'a\\'b'");
    expect(tt[10]).toBe('bcom:/* c1 */');
    expect(tt[13]).toBe('com:-- tail');
  });
  it('is idempotent and keeps every token', () => {
    const samples = [SAMPLE, tricky, 'select a from t union all select b from u order by 1', 'WITH x AS (SELECT 1) SELECT * FROM x;\n\nDELETE FROM t WHERE a = 1;',
      'insert into t (a) values (1) on conflict (a) do update set a = excluded.a returning *', 'select a -- one\n, b /* two */ from t', 'select x from t where a is distinct from b for update'];
    samples.forEach((s) => {
      for (const o of [{}, { commas: 'leading', indent: 'tab' }, { kwcase: 'preserve' }] as FormatOpts[]) {
        const once = F(s, o);
        expect(F(once, o)).toBe(once);
        expect(sig(tokenize(once))).toBe(sig(tokenize(s)));
      }
      expect(minify(F(s, { kwcase: 'preserve' }), true)).toBe(minify(s, true));
      expect(sig(tokenize(minify(s, false)))).toBe(sig(tokenize(s)));
    });
  });
  it('minifies', () => {
    expect(minify('select a , b\nfrom t -- c\nwhere x = - 1;', false)).toBe('select a,b from t where x=-1;');
    expect(minify('select 1 - -1', false)).toBe('select 1- -1');
  });
});

describe('sql_format tool', () => {
  it('formats and minifies', async () => {
    const r = await call<{ result: string; statements: number }>(tool, { text: SAMPLE });
    expect(r.statements).toBe(2);
    expect(r.result.startsWith('-- monthly revenue per active customer\nWITH\n  recent AS (\n    SELECT')).toBe(true);
    const m = await call<{ result: string; warning?: string }>(tool, { text: "select 'x", mode: 'minify' });
    expect(m.warning).toMatch(/Unclosed/);
  });
});

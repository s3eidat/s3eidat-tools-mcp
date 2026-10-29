import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { checkTz, isoInZone, LOCAL_TZ, parts, utcOf, wallToEpoch } from './_tz.js';

// Ported from https://github.com/s3eidat/cron-explain (app.js): standard 5-field (Vixie) cron, same parser, error
// messages, English description and next-run search (day-of-month OR day-of-week when both are restricted).
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
interface FieldDef {
  key: 'minute' | 'hour' | 'dom' | 'month' | 'dow';
  label: string;
  min: number;
  max: number;
  hint: string;
  names?: string[];
  base?: number;
}
const FIELDS: FieldDef[] = [
  { key: 'minute', label: 'Minute', min: 0, max: 59, hint: '0–59' },
  { key: 'hour', label: 'Hour', min: 0, max: 23, hint: '0–23' },
  { key: 'dom', label: 'Day of month', min: 1, max: 31, hint: '1–31' },
  { key: 'month', label: 'Month', min: 1, max: 12, hint: '1–12 or JAN–DEC', names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], base: 1 },
  { key: 'dow', label: 'Day of week', min: 0, max: 7, hint: '0–7 or SUN–SAT (0, 7 = Sun)', names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], base: 0 },
];
const MACROS: Record<string, string> = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };

interface Item {
  a: number;
  b: number;
  star: boolean;
  open?: boolean;
  step: number;
}
export interface Field {
  raw: string;
  items: Item[];
  set: Record<number, boolean>;
  values: number[];
  restricted: boolean;
}
export interface Parsed {
  ok: boolean;
  errors: Record<string, string>;
  fields: Record<FieldDef['key'], Field> | null;
  empty?: boolean;
  reboot?: boolean;
  macro?: string;
  error?: string;
  expanded?: string;
}

// ---------- parsing ----------
function num(tok: string, f: FieldDef) {
  const up = tok.toUpperCase();
  if (f.names && f.names.indexOf(up) >= 0) return f.names.indexOf(up) + f.base!;
  if (!/^\d+$/.test(tok)) throw new Error('“' + tok + '” is not a number' + (f.names ? ' or a name like ' + f.names[1] : ''));
  const n = +tok;
  if (n < f.min || n > f.max) throw new Error(n + ' is out of range (' + f.hint + ')');
  return n;
}
function parseField(str: string, f: FieldDef): Field {
  if (!str) throw new Error('missing');
  if (str === '?' && (f.key === 'dom' || f.key === 'dow')) str = '*';
  const items = str.split(',').map((part) => {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) {
      if (/[LW#]/i.test(part)) throw new Error('“' + part + '” uses L, W or # — those are Quartz extensions, not standard cron');
      throw new Error("can't read “" + part + '”');
    }
    const step = m[2] ? +m[2] : 1;
    let it: Item;
    if (m[2] && (step < 1 || step > f.max)) throw new Error('step /' + m[2] + ' is out of range');
    if (m[1] === '*') it = { a: f.min, b: f.max, star: true, step };
    else {
      const r = m[1].split('-'), a = num(r[0], f), b = r.length > 1 ? num(r[1], f) : m[2] ? f.max : a;
      if (a > b) throw new Error('range ' + m[1] + ' must go from low to high');
      it = { a, b, star: false, open: !!m[2] && r.length === 1, step };
    }
    return it;
  });
  const set: Record<number, boolean> = {}, values: number[] = [];
  items.forEach((it) => {
    for (let v = it.a; v <= it.b; v += it.step) {
      const x = f.key === 'dow' && v === 7 ? 0 : v;
      if (!set[x]) {
        set[x] = true;
        values.push(x);
      }
    }
  });
  values.sort((x, y) => x - y);
  return { raw: str, items, set, values, restricted: str.charAt(0) !== '*' };
}
export function parse(expr: string): Parsed {
  let s = String(expr).trim().replace(/\s+/g, ' ');
  const res: Parsed = { ok: false, errors: {}, fields: null };
  if (!s) {
    res.empty = true;
    return res;
  }
  const low = s.toLowerCase();
  if (low === '@reboot') {
    res.ok = true;
    res.reboot = true;
    return res;
  }
  if (low.charAt(0) === '@') {
    if (!MACROS[low]) {
      res.error = 'Unknown macro ' + s + '. Try @hourly, @daily, @weekly, @monthly or @yearly';
      return res;
    }
    res.macro = low;
    s = MACROS[low];
  }
  const p = s.split(' ');
  if (p.length === 6 || p.length === 7) {
    res.error = 'This has ' + p.length + ' fields — it looks like a Quartz/Spring cron with seconds. Standard cron has 5: minute hour day-of-month month day-of-week';
    return res;
  }
  if (p.length !== 5) {
    res.error = 'A cron expression needs 5 fields, found ' + p.length;
    return res;
  }
  res.expanded = s;
  const fields = {} as Record<FieldDef['key'], Field>;
  FIELDS.forEach((f, i) => {
    try {
      fields[f.key] = parseField(p[i], f);
    } catch (e) {
      res.errors[f.key] = (e as Error).message;
    }
  });
  res.fields = fields;
  res.ok = !Object.keys(res.errors).length;
  return res;
}

// ---------- description ----------
function ord(n: number) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function list(a: string[]) {
  return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
function pad(n: number) {
  return (n < 10 ? '0' : '') + n;
}
const isAll = (f: Field) => f.items.length === 1 && f.items[0].star && f.items[0].step === 1;
const starStep = (f: Field) => (f.items.length === 1 && f.items[0].star && f.items[0].step > 1 ? f.items[0].step : 0);
const singles = (f: Field) => f.items.every((i) => !i.star && i.a === i.b);
function items(f: Field, fmt: (n: number) => string, unit: string) {
  return list(
    f.items.map((i) => {
      if (i.star) return 'every ' + ord(i.step) + ' ' + unit;
      if (i.open) return 'every ' + ord(i.step) + ' ' + unit + ' from ' + fmt(i.a);
      if (i.a === i.b) return fmt(i.a);
      return fmt(i.a) + ' through ' + fmt(i.b) + (i.step > 1 ? ' (every ' + ord(i.step) + ')' : '');
    }),
  );
}

export function describe(p: Parsed, h12 = false): string {
  if (p.reboot) return 'Once, when the cron daemon starts (at boot)';
  const time = (h: number, m: number) => (!h12 ? pad(h) + ':' + pad(m) : (h % 12 || 12) + ':' + pad(m) + ' ' + (h < 12 ? 'AM' : 'PM'));
  const F = p.fields!, m = F.minute, h = F.hour;
  let out: string;
  const hourName = (x: number) => time(x, 0);
  if (isAll(m) && isAll(h)) out = 'Every minute';
  else if (starStep(m) && isAll(h)) out = 'Every ' + starStep(m) + ' minutes';
  else if (singles(m) && singles(h) && m.values.length * h.values.length <= 12) {
    const times: string[] = [];
    h.values.forEach((hh) => m.values.forEach((mm) => times.push(time(hh, mm))));
    out = 'At ' + list(times);
  } else {
    const at = !isAll(m) && !starStep(m);
    out = isAll(m) ? 'Every minute' : starStep(m) ? 'Every ' + starStep(m) + ' minutes'
      : singles(m) ? 'At minute' + (m.values.length > 1 ? 's ' : ' ') + list(m.values.map(String)) : 'At minutes ' + items(m, String, 'minute');
    if (isAll(h)) out += at ? ' past every hour' : '';
    else if (starStep(h)) out += (at ? ' past' : ',') + ' every ' + ord(starStep(h)) + ' hour';
    else if (h.items.length === 1 && !h.items[0].star && h.items[0].step === 1 && h.items[0].a < h.items[0].b) out += ', between ' + time(h.items[0].a, 0) + ' and ' + time(h.items[0].b, 59);
    else if (singles(h)) out += ', during the ' + list(h.values.map(hourName)) + ' hour' + (h.values.length > 1 ? 's' : '');
    else out += ', hours ' + items(h, hourName, 'hour');
  }
  const dom = F.dom, dow = F.dow, mon = F.month;
  let day = '';
  const domT = starStep(dom) ? 'every ' + ord(starStep(dom)) + ' day of the month'
    : singles(dom) ? 'on day' + (dom.values.length > 1 ? 's ' : ' ') + list(dom.values.map(String)) + ' of the month' : 'on days ' + items(dom, String, 'day') + ' of the month';
  const dowT = starStep(dow) ? 'every ' + ord(starStep(dow)) + ' day of the week' : 'on ' + items(dow, (d) => DAYS[d], 'day');
  const domOn = !isAll(dom), dowOn = !isAll(dow);
  if (domOn && dowOn) day = dom.restricted && dow.restricted ? domT + ' or ' + dowT : domT + ' and ' + dowT;
  else if (domOn) day = domT;
  else if (dowOn) day = dowT;
  if (day) out += ', ' + day;
  if (!isAll(mon)) out += ', ' + (starStep(mon) ? 'every ' + ord(starStep(mon)) + ' month' : 'in ' + items(mon, (x) => MONTHS[x], 'month'));
  return out;
}

// ---------- next runs ----------
// The website walks a local Date; here the walk happens on wall-clock time (a UTC Date used as a plain calendar) and
// each hit is mapped to a real instant in the chosen timezone.
function dayOk(F: Record<string, Field>, d: Date) {
  const a = F.dom.set[d.getUTCDate()], b = F.dow.set[d.getUTCDay()];
  return F.dom.restricted && F.dow.restricted ? a || b : a && b;
}
/** Next `count` run times (epoch ms) strictly after `fromMs`, searching up to 30 years ahead. */
export function nextRuns(p: Parsed, fromMs: number, count: number, tz = 'UTC'): number[] {
  const F = p.fields!, out: number[] = [];
  const w = parts(fromMs, tz);
  const d = new Date(utcOf(w.y, w.mo, w.d, w.h, w.mi, w.s));
  const stopYear = d.getUTCFullYear() + 30;
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  while (out.length < count && d.getUTCFullYear() <= stopYear) {
    if (!F.month.set[d.getUTCMonth() + 1]) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayOk(F, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!F.hour.set[d.getUTCHours()]) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!F.minute.set[d.getUTCMinutes()]) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    const t = wallToEpoch(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), 0, tz);
    if (t > fromMs && (!out.length || t > out[out.length - 1])) out.push(t);
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return out;
}
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function rel(ms: number) {
  const s = ms / 1000;
  const U: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, n] of U) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u);
  return 'in less than a minute';
}

export default defineTool({
  name: 'cron_explain',
  title: 'Cron explain',
  webSlug: 'cron-explain',
  description:
    'Explain a standard 5-field cron expression (minute hour day-of-month month day-of-week; names like MON/JAN, ranges, ' +
    'lists, steps, ? and the @hourly/@daily/@weekly/@monthly/@yearly/@reboot macros) in plain English and list the next ' +
    'run times in an IANA timezone. Follows Vixie cron: when both day fields are restricted a day matches either one. ' +
    'Quartz 6/7-field and L/W/# syntax are rejected with a clear message; per-field errors are reported. ' +
    `Web version: ${webUrl('cron-explain')}`,
  inputSchema: z.object({
    expression: z.string().describe('The cron expression, e.g. "*/30 9-17 * * 1-5" or "@daily".'),
    count: z.number().int().min(0).max(100).optional().default(10).describe('How many upcoming run times to list (0–100). Default 10.'),
    timezone: z.string().optional().describe(`IANA timezone the cron daemon runs in. Default: the server's (${LOCAL_TZ}).`),
    from: z.string().optional().describe('Start searching after this instant (ISO 8601). Default: now.'),
    hour12: z.boolean().optional().default(false).describe('Describe times on a 12-hour clock (9:00 AM) instead of 24-hour (09:00).'),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    description: z.string().optional(),
    expanded: z.string().optional().describe('The 5 fields after expanding a macro.'),
    macro: z.string().optional(),
    errors: z.record(z.string(), z.string()).optional().describe('Per-field error messages (minute, hour, dom, month, dow).'),
    error: z.string().optional(),
    timezone: z.string(),
    nextRuns: z.array(z.object({ iso: z.string(), utc: z.string(), local: z.string(), relative: z.string() })),
    note: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { expression: '0 9 * * 1-5', count: 3, timezone: 'Europe/London' }, note: 'description: "At 09:00, on Monday through Friday"' },
    { input: { expression: '0 0 13 * 5' }, note: 'description: "At 00:00, on day 13 of the month or on Friday"' },
  ],
  run(input) {
    const tz = checkTz(input.timezone || LOCAL_TZ);
    const p = parse(input.expression);
    if (p.empty) throw new ToolError('Give a cron expression, e.g. "*/5 * * * *".');
    if (!p.ok) {
      const errors: Record<string, string> = {};
      for (const f of FIELDS) if (p.errors[f.key]) errors[f.key] = f.label + ': ' + p.errors[f.key];
      return JSON.parse(JSON.stringify({ valid: false, error: p.error, errors: p.error ? undefined : errors, timezone: tz, nextRuns: [] }));
    }
    const out: Record<string, unknown> = { valid: true, description: describe(p, input.hour12) + '.', timezone: tz };
    if (p.expanded) out.expanded = p.expanded;
    if (p.macro) out.macro = p.macro;
    if (p.reboot) {
      out.nextRuns = [];
      out.note = 'Runs once at system start-up, not on a clock.';
      return out;
    }
    let from = Date.now();
    if (input.from) {
      from = Date.parse(input.from);
      if (isNaN(from)) throw new ToolError('"from" must be an ISO 8601 date-time, e.g. 2026-10-26T09:00:00Z');
    }
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: input.hour12 });
    const runs = nextRuns(p, from, input.count, tz);
    out.nextRuns = runs.map((t) => ({ iso: isoInZone(t, tz), utc: new Date(t).toISOString(), local: fmt.format(t), relative: rel(t - from) }));
    if (!runs.length && input.count) out.note = 'This schedule never runs (for example 31 February).';
    return out;
  },
});

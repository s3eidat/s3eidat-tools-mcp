import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS, num } from './_common.js';
import { CATS as RAW, NOTES, type Factor } from './_units.js';

// Ported from https://github.com/s3eidat/unit-convert (app.js): every unit maps to its category's base unit.
export interface Unit { sym: string; name: string; f: Factor; words: string; cat: Cat }
export interface Cat { id: string; name: string; base: string; def: [string, string]; units: Unit[] }

export const CATS: Cat[] = RAW.map((c) => {
  const cat: Cat = { id: c.id, name: c.name, base: c.base, def: c.def, units: [] };
  cat.units = c.units.map((u) => ({ sym: u[0], name: u[1], f: u[2], words: (u[0] + ' ' + u[1] + ' ' + (u[3] || '')).toLowerCase(), cat }));
  return cat;
});
export const cat = (id: string) => CATS.find((c) => c.id === id);
export const unit = (c: Cat, sym: string) => c.units.find((u) => u.sym === sym);

const toBase = (u: Unit, v: number) => (typeof u.f === 'number' ? v * u.f : u.f.to(v));
const fromBase = (u: Unit, b: number) => (typeof u.f === 'number' ? b / u.f : u.f.from(b));
export const convert = (v: number, a: Unit, b: Unit) => fromBase(b, toBase(a, v));

/** 10 significant digits for display. */
export function fmt(v: number) {
  if (!isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-6) return v.toPrecision(7).replace(/\.?0+e/, 'e');
  return Number(v.toPrecision(10)).toLocaleString('en-US', { maximumFractionDigits: 12 });
}
/** Plain value (12 significant digits, no grouping). */
export const raw = (v: number) => (isFinite(v) ? Number(v.toPrecision(12)) : null);

/** Units matching a word: exact symbol first (° optional, any case), else a search word or the (plural) name. */
export function find(word: string, c?: Cat): Unit[] {
  word = word.toLowerCase().replace(/^°/, '');
  const pool = c ? c.units : CATS.flatMap((x) => x.units);
  const exact = pool.filter((u) => u.sym.toLowerCase().replace(/^°/, '') === word);
  if (exact.length) return exact;
  return pool.filter((u) => u.words.split(/\s+/).indexOf(word) >= 0 || u.name.toLowerCase() === word || u.name.toLowerCase() + 's' === word);
}
/** "5 km to mi", "72 f in c", "3 cups = mL". */
export function parseQuery(q: string) {
  const m = /^\s*([-+−]?[\d.,\u0660-\u0669]+(?:e[-+]?\d+)?)\s*(.+?)\s+(?:to|in|into|as|=|->|→)\s+(.+?)\s*$/i.exec(q);
  if (!m || isNaN(num(m[1]))) return null;
  const froms = find(m[2]);
  for (const f of froms) {
    const tos = find(m[3], f.cat);
    if (tos.length) return { v: num(m[1]), a: f, b: tos[0] };
  }
  return null;
}

const unitInfo = z.object({ symbol: z.string(), name: z.string() });

export default defineTool({
  name: 'calc_unit_convert',
  title: 'Unit converter',
  webSlug: 'unit-convert',
  description:
    'Convert between units in 14 categories, the same table as the website: length, mass, temperature, volume, area (incl. dunam), ' +
    'speed, time, data (kB/MB vs KiB/MiB, bits), pressure, energy, power, angle, fuel economy (L/100km, km/L, mpg US/UK) and ' +
    'cooking (tsp, tbsp, cups, metric spoons). Give value + from + to (symbols like "km", "°F", "GiB" or names like "miles"; ' +
    'ASCII forms like "m2", "um" work), or a query like "5 km to mi". Set all=true for the value in every unit of the category, ' +
    `or list=true to see every category and unit. Web version: ${webUrl('unit-convert')}`,
  inputSchema: z.object({
    query: z.string().optional().describe('A whole question, e.g. "5 km to mi" or "72 f in c".'),
    value: z.union([z.number(), z.string()]).optional().describe('The number to convert.'),
    from: z.string().optional().describe('Unit to convert from (symbol or name).'),
    to: z.string().optional().describe('Unit to convert to (symbol or name). Optional when all=true.'),
    category: z.enum(['length', 'mass', 'temp', 'volume', 'area', 'speed', 'time', 'data', 'pressure', 'energy', 'power', 'angle', 'fuel', 'cooking']).optional()
      .describe('Category, to pick the right unit when a symbol exists in two (e.g. "pt" in volume and cooking).'),
    all: z.boolean().optional().default(false).describe('Also return the value in every unit of the category.'),
    list: z.boolean().optional().default(false).describe('Just list every category and its units.'),
  }),
  outputSchema: z.object({
    category: z.string().optional(), from: unitInfo.optional(), to: unitInfo.optional(),
    value: z.number().optional(), result: z.number().nullable().optional(), formatted: z.string().optional(), formula: z.string().optional(),
    oneUnit: z.string().optional(), note: z.string().optional(),
    all: z.array(z.object({ symbol: z.string(), name: z.string(), value: z.number().nullable(), formatted: z.string() })).optional(),
    categories: z.array(z.object({ id: z.string(), name: z.string(), base: z.string(), units: z.array(unitInfo) })).optional(),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { query: '5 km to mi' }, note: '3.106855961 mi' },
    { input: { value: 100, from: '°C', to: '°F' }, output: { result: 212 } },
  ],
  run(input) {
    if (input.list) return { categories: CATS.map((c) => ({ id: c.id, name: c.name, base: c.base, units: c.units.map((u) => ({ symbol: u.sym, name: u.name })) })) };
    let v: number, a: Unit | undefined, b: Unit | undefined;
    const c0 = input.category ? cat(input.category) : undefined;
    if (input.query) {
      const p = parseQuery(input.query);
      if (!p) throw new ToolError(`Could not read "${input.query}". Write it like "5 km to mi".`);
      ({ v, a, b } = p);
    } else {
      if (input.value === undefined || !input.from) throw new ToolError('Give "query", or "value" and "from" (and "to").');
      v = num(input.value);
      if (isNaN(v)) throw new ToolError(`"value" is not a number: ${JSON.stringify(input.value)}`);
      const froms = find(input.from.trim(), c0);
      if (!froms.length) throw new ToolError(`Unknown unit "${input.from}"${c0 ? ' in ' + c0.name : ''}. Use list=true to see the units.`);
      if (input.to) {
        for (const f of froms) { const tos = find(input.to.trim(), f.cat); if (tos.length) { a = f; b = tos[0]; break; } }
        if (!a) throw new ToolError(`No unit "${input.to}" in the same category as "${input.from}" (${[...new Set(froms.map((f) => f.cat.name))].join(', ')}).`);
      } else {
        if (!input.all) throw new ToolError('Give "to", or set all=true.');
        a = froms[0];
      }
    }
    const c = a!.cat, out: Record<string, unknown> = { category: c.id, from: { symbol: a!.sym, name: a!.name }, value: v };
    if (b) {
      const r = convert(v, a!, b);
      out.to = { symbol: b.sym, name: b.name };
      out.result = raw(r);
      out.formatted = fmt(r) + ' ' + b.sym;
      out.formula = fmt(v) + ' ' + a!.sym + ' = ' + fmt(r) + ' ' + b.sym;
      if (typeof a!.f === 'number' && typeof b.f === 'number') out.oneUnit = '1 ' + a!.sym + ' = ' + fmt(convert(1, a!, b)) + ' ' + b.sym;
    }
    if (NOTES[c.id]) out.note = NOTES[c.id];
    if (input.all) out.all = c.units.map((u) => { const x = convert(v, a!, u); return { symbol: u.sym, name: u.name, value: raw(x), formatted: fmt(x) }; });
    return out;
  },
});

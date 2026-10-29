import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';

// Ported from https://github.com/s3eidat/roman-numerals (app.js): standard subtractive notation, vinculum above 3,999.
const TABLE: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const VAL: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const PAIRS = ['IV', 'IX', 'XL', 'XC', 'CD', 'CM'];
const OVERLINE = '\u0305'; // combining overline

export function toRoman(n: number) {
  const parts: [number, string][] = [];
  TABLE.forEach((t) => { while (n >= t[0]) { parts.push(t); n -= t[0]; } });
  return { roman: parts.map((p) => p[1]).join(''), parts };
}
/** Above 3999: a bar (combining overline) over the thousands multiplies them by 1000. */
export function vinculum(n: number) {
  const th = Math.floor(n / 1000), rest = n % 1000;
  return toRoman(th).roman.split('').map((c) => c + OVERLINE).join('') + toRoman(rest).roman;
}
export function parseRoman(input: string): { empty?: true; err?: string; near?: number; value?: number; steps?: { sym: string; v: number }[] } {
  const s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  let m: RegExpExecArray | null;
  if (!s) return { empty: true };
  if ((m = /[^IVXLCDM]/.exec(s))) return { err: '"' + m[0] + '" is not a Roman numeral symbol. Use only I, V, X, L, C, D and M.' };
  if ((m = /V{2,}|L{2,}|D{2,}/.exec(s))) return { err: m[0][0] + ' never repeats: ' + m[0][0] + m[0][0] + ' is written ' + toRoman(VAL[m[0][0]] * 2).roman + '.' };
  if ((m = /I{4,}|X{4,}|C{4,}|M{4,}/.exec(s))) {
    const ch = m[0][0];
    return { err: ch + ' appears ' + m[0].length + ' times in a row; the most is 3.' + (ch === 'M' ? ' Numbers above 3,999 need a vinculum (bar), see the rules.' : ' ' + ch.repeat(4) + ' is written ' + toRoman(VAL[ch] * 4).roman + '.') };
  }
  for (let i = 0; i < s.length - 1; i++) {
    if (VAL[s[i]] < VAL[s[i + 1]] && PAIRS.indexOf(s[i] + s[i + 1]) < 0) {
      const d = VAL[s[i + 1]] - VAL[s[i]];
      return { err: '"' + s[i] + s[i + 1] + '" is not a valid subtraction. Only IV, IX, XL, XC, CD and CM are allowed' + (d <= 3999 ? ' (' + d + ' is ' + toRoman(d).roman + ').' : '.') };
    }
  }
  let total = 0;
  const steps: { sym: string; v: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    const v = VAL[s[i]], neg = i + 1 < s.length && v < VAL[s[i + 1]];
    total += neg ? -v : v; steps.push({ sym: s[i], v: neg ? -v : v });
  }
  const canon = toRoman(total).roman;
  if (canon !== s) return { err: 'Not in standard form. The symbols add up to ' + total + ', which is written ' + canon + '.', near: total };
  return { value: total, steps };
}
export function dateRoman(y: number, m: number, d: number, order: string, sep: string) {
  const p: Record<string, string> = { d: toRoman(d).roman, m: toRoman(m).roman, y: toRoman(y).roman };
  return order.split('').map((k) => p[k]).join(sep);
}

export default defineTool({
  name: 'calc_roman',
  title: 'Roman numerals',
  webSlug: 'roman-numerals',
  description:
    'Convert numbers to Roman numerals (1–3,999 in standard form; up to 3,999,999 with a vinculum bar, which multiplies by ' +
    '1,000) and Roman numerals back to numbers with strict validation that explains mistakes (IIII, IC, VV, non-standard ' +
    'forms like IIX…) and the symbol-by-symbol working. Also writes a date in Roman numerals (day/month/year order and ' +
    `separator of your choice, years 1–3999). Web version: ${webUrl('roman-numerals')}`,
  inputSchema: z.object({
    mode: z.enum(['to_roman', 'from_roman', 'date']).describe('to_roman (number → Roman), from_roman (Roman → number) or date.'),
    number: z.union([z.number(), z.string()]).optional().describe('to_roman: a whole number 1–3,999,999.'),
    roman: z.string().optional().describe('from_roman: the numeral, e.g. "MCMXCIV" (any case).'),
    date: z.string().optional().describe('date: YYYY-MM-DD.'),
    order: z.enum(['dmy', 'mdy', 'ymd']).optional().default('dmy').describe('date: order of day, month, year.'),
    separator: z.string().max(5).optional().default(' · ').describe('date: separator, e.g. " · ", ".", " - ", " / ".'),
  }),
  outputSchema: z.object({
    mode: z.string(), valid: z.boolean(),
    roman: z.string().optional(), value: z.number().optional(), vinculum: z.boolean().optional(),
    steps: z.array(z.object({ symbol: z.string(), value: z.number() })).optional(),
    error: z.string().optional(), standardForm: z.string().optional(), explanation: z.string().optional(), plain: z.string().optional(),
  }),
  annotations: ANNOTATIONS,
  examples: [
    { input: { mode: 'to_roman', number: 1994 }, output: { roman: 'MCMXCIV' } },
    { input: { mode: 'from_roman', roman: 'IC' }, note: 'invalid: write 99 as XCIX' },
  ],
  run(input) {
    if (input.mode === 'to_roman') {
      const raw = String(input.number ?? '').replace(/[,\s_]/g, '').replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660));
      if (!raw) throw new ToolError('Give "number".');
      if (!/^\d+$/.test(raw)) throw new ToolError('Whole numbers only.');
      const n = parseInt(raw, 10);
      if (n === 0) return { mode: input.mode, valid: false, error: 'No zero in Roman numerals', explanation: 'The Romans had no numeral for zero; medieval writers used the word nulla (N).' };
      if (n > 3999999) throw new ToolError('Too large, even with a vinculum (max 3,999,999).');
      if (n > 3999) {
        const th = Math.floor(n / 1000) * 1000, steps = [{ symbol: vinculum(th), value: th }].concat(n % 1000 ? [{ symbol: toRoman(n % 1000).roman, value: n % 1000 }] : []);
        return { mode: input.mode, valid: true, roman: vinculum(n), value: n, vinculum: true, steps,
          explanation: 'Above 3,999: a bar over a numeral multiplies it by 1,000. It is historical notation, not part of the modern standard (1–3,999).' };
      }
      const r = toRoman(n);
      return { mode: input.mode, valid: true, roman: r.roman, value: n, vinculum: false, steps: r.parts.map((p) => ({ symbol: p[1], value: p[0] })),
        explanation: r.parts.map((p) => p[1] + ' (' + p[0] + ')').join(' + ') + ' = ' + n.toLocaleString('en-US') };
    }
    if (input.mode === 'from_roman') {
      const r = parseRoman(input.roman ?? '');
      if (r.empty) throw new ToolError('Give "roman".');
      if (r.err) return { mode: input.mode, valid: false, error: r.err, ...(r.near !== undefined ? { standardForm: toRoman(r.near).roman, value: r.near } : {}) };
      return { mode: input.mode, valid: true, value: r.value!, roman: input.roman!.trim().toUpperCase(), steps: r.steps!.map((s) => ({ symbol: s.sym, value: s.v })),
        explanation: r.steps!.map((s, i) => (i ? (s.v < 0 ? ' − ' : ' + ') : s.v < 0 ? '−' : '') + Math.abs(s.v)).join('') + ' = ' + r.value!.toLocaleString('en-US') };
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date ?? '');
    if (!m) throw new ToolError('Give "date" as YYYY-MM-DD.');
    if (+m[1] < 1 || +m[1] > 3999) throw new ToolError('Years 1 to 3999 only.');
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new ToolError('Give a real date.');
    const plain: Record<string, number> = { d, m: mo, y };
    return { mode: 'date', valid: true, roman: dateRoman(y, mo, d, input.order, input.separator), plain: input.order.split('').map((k) => plain[k]).join(input.separator) };
  },
});

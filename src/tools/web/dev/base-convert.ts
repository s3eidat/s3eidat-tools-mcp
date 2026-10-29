import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/base-convert (app.js): BigInt base conversion (2–36, any size, whole numbers),
// digit grouping, two's complement views and UTF-8 text ⇄ bytes.
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** base: 2..36 or "auto" (0x / 0b / 0o prefixes, otherwise decimal). */
export function parse(str: string, base: number | 'auto'): { ok: true; value: bigint } | { ok: false; error: string } {
  let s = String(str).trim().replace(/[\s_,']/g, '').toLowerCase();
  if (!s) return { ok: false, error: 'empty' };
  let neg = false;
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  const pre = ({ '0x': 16, '0b': 2, '0o': 8 } as Record<string, number>)[s.slice(0, 2)];
  if (base === 'auto') base = pre || 10;
  if (pre && pre === +base) s = s.slice(2);
  const b = +base;
  if (!s) return { ok: false, error: 'no digits' };
  if (s.indexOf('.') >= 0) return { ok: false, error: 'whole numbers only' };
  let v = 0n;
  const B = BigInt(b);
  for (let i = 0; i < s.length; i++) {
    const d = DIGITS.indexOf(s[i]);
    if (d < 0 || d >= b) return { ok: false, error: '“' + s[i] + '” is not a base-' + b + ' digit' };
    v = v * B + BigInt(d);
  }
  return { ok: true, value: neg ? -v : v };
}
export function toBase(v: bigint, base: number) {
  return v < 0n ? '-' + (-v).toString(base) : v.toString(base);
}
export function group(str: string, size: number, sep: string) {
  const neg = str[0] === '-', s = neg ? str.slice(1) : str;
  let out = '';
  for (let i = s.length; i > 0; i -= size) out = s.slice(Math.max(0, i - size), i) + (out ? sep + out : '');
  return (neg ? '-' : '') + out;
}
export function twos(v: bigint, w: number) {
  const u = BigInt.asUintN(w, v), max = (1n << BigInt(w)) - 1n, min = -(1n << BigInt(w - 1));
  return {
    unsigned: u, signed: BigInt.asIntN(w, v), fits: v >= min && v <= max,
    hex: u.toString(16).toUpperCase().padStart(w / 4, '0'), bin: u.toString(2).padStart(w, '0'),
  };
}
export function bitLength(v: bigint) {
  if (v < 0n) v = -v;
  return v === 0n ? 0 : v.toString(2).length;
}

export type ByteFmt = 'hex' | 'bin' | 'dec';
export function fmtBytes(bytes: Uint8Array, fmt: ByteFmt, upper = false) {
  return Array.from(bytes, (b) => {
    if (fmt === 'bin') return b.toString(2).padStart(8, '0');
    if (fmt === 'dec') return String(b);
    const x = b.toString(16).padStart(2, '0');
    return upper ? x.toUpperCase() : x;
  }).join(' ');
}
/** Accepts "48 65", "4865", "0x48,0x65", "01001000 01100101", "72 101". */
export function parseBytes(str: string, fmt: ByteFmt): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  let s = String(str).trim();
  if (!s) return { ok: true, bytes: new Uint8Array(0) };
  let parts: number[];
  if (fmt === 'hex') {
    s = s.replace(/0x/gi, '').replace(/[\s,:;-]/g, '');
    if (!/^[0-9a-f]*$/i.test(s)) return { ok: false, error: 'Hex bytes use 0–9 and A–F' };
    if (s.length % 2) return { ok: false, error: 'Odd number of hex digits' };
    parts = (s.match(/../g) || []).map((p) => parseInt(p, 16));
  } else if (fmt === 'bin') {
    s = s.replace(/[\s,]/g, '');
    if (!/^[01]*$/.test(s)) return { ok: false, error: 'Binary bytes use only 0 and 1' };
    if (s.length % 8) return { ok: false, error: 'Binary needs whole bytes (multiples of 8 bits)' };
    parts = (s.match(/.{8}/g) || []).map((p) => parseInt(p, 2));
  } else {
    parts = s.split(/[\s,]+/).map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return { ok: false, error: 'Decimal bytes are 0–255' };
  }
  return { ok: true, bytes: new Uint8Array(parts) };
}
export function decode(bytes: Uint8Array) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), valid: true };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), valid: false };
  }
}

// The website's rows: [base, name, group size, separator]
const ROWS: Record<number, [string, number, string]> = { 2: ['Binary', 4, ' '], 8: ['Octal', 3, ' '], 10: ['Decimal', 3, ','], 16: ['Hex', 4, ' '], 36: ['Base 36', 0, ''] };

const baseConvert = defineTool({
  name: 'base_convert',
  title: 'Number base convert',
  webSlug: 'base-convert',
  description:
    'Convert a whole number of any size (BigInt) between bases 2–36: binary, octal, decimal, hex, base 36 or any other. ' +
    'Input base can be auto-detected from 0x / 0b / 0o prefixes; spaces, _ and , separators are ignored; negatives OK. ' +
    "Also shows bit length and the two's complement view (signed/unsigned value, hex, bits) at 8/16/32/64 bits, and " +
    `whether it fits. Fractions are not supported (same as the website). Web version: ${webUrl('base-convert')}`,
  inputSchema: z.object({
    value: z.string().describe('The number, e.g. "0xC0FFEE", "-0b101", "1_000_000", "zz" (with from=36).'),
    from: z.union([z.literal('auto'), z.number().int().min(2).max(36)]).optional().default('auto').describe('Input base 2–36, or "auto" (prefix, else decimal).'),
    to: z.array(z.number().int().min(2).max(36)).optional().default([2, 8, 10, 16, 36]).describe('Output bases. Default [2, 8, 10, 16, 36].'),
    group: z.boolean().optional().default(false).describe('Group digits like the website (binary/hex by 4, octal by 3, decimal with commas).'),
    uppercase: z.boolean().optional().default(false).describe('Upper-case letters for bases above 10.'),
    width: z.union([z.literal(8), z.literal(16), z.literal(32), z.literal(64)]).optional().default(32).describe("Bit width for the two's complement view."),
  }),
  outputSchema: z.object({
    decimal: z.string(),
    results: z.array(z.object({ base: z.number(), name: z.string(), value: z.string() })),
    bitLength: z.number(),
    bytes: z.number(),
    twosComplement: z.object({ width: z.number(), signed: z.string(), unsigned: z.string(), hex: z.string(), binary: z.string(), fits: z.boolean(), note: z.string() }),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { value: '0xC0FFEE' }, note: 'decimal 12648430, binary 110000001111111111101110' }, { input: { value: '-1', width: 8 }, note: 'two’s complement hex FF' }],
  run(input) {
    const r = parse(input.value, input.from);
    if (!r.ok) throw new ToolError(r.error === 'empty' ? 'Type a number' : r.error);
    const v = r.value;
    const results = input.to.map((b) => {
      let s = toBase(v, b);
      if (input.uppercase && b > 10) s = s.toUpperCase();
      const row = ROWS[b];
      if (input.group && row && row[1]) s = group(s, row[1], row[2]);
      return { base: b, name: row ? row[0] : 'Base ' + b, value: s };
    });
    const w = input.width, t = twos(v, w), bl = bitLength(v);
    const note = t.fits
      ? 'Fits in ' + w + ' bits. Signed range ' + -(1n << BigInt(w - 1)) + ' to ' + ((1n << BigInt(w - 1)) - 1n) + '.'
      : 'Does not fit in ' + w + ' bits: it wraps around, keeping only the low ' + w + ' bits.';
    return {
      decimal: v.toString(),
      results,
      bitLength: bl,
      bytes: Math.ceil(bl / 8 || 0),
      twosComplement: { width: w, signed: t.signed.toString(), unsigned: t.unsigned.toString(), hex: '0x' + group(t.hex, 4, ' '), binary: t.bin, fits: t.fits, note },
    };
  },
});

const bytesConvert = defineTool({
  name: 'bytes_convert',
  title: 'Text ⇄ UTF-8 bytes',
  webSlug: 'base-convert',
  description:
    'Turn text into its UTF-8 bytes (hex, binary or decimal), or bytes back into text. Byte input is lenient: "48 65", ' +
    '"4865", "0x48,0x69", "01001000 01101001", "72 105". Invalid UTF-8 is reported and shown with � replacements. ' +
    `Web version: ${webUrl('base-convert')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('Text to turn into bytes.'),
    bytes: z.string().optional().describe('Or: bytes to turn into text, in the chosen format.'),
    format: z.enum(['hex', 'bin', 'dec']).optional().default('hex').describe('Byte format. Default hex.'),
    uppercase: z.boolean().optional().default(false).describe('Upper-case hex digits.'),
  }),
  outputSchema: z.object({ text: z.string(), bytes: z.string(), byteCount: z.number(), characters: z.number(), validUtf8: z.boolean() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { text: 'Hi ☕', uppercase: true }, output: { text: 'Hi ☕', bytes: '48 69 20 E2 98 95', byteCount: 6, characters: 4, validUtf8: true } }],
  run(input) {
    if (input.text != null) {
      const b = new TextEncoder().encode(input.text);
      return { text: input.text, bytes: fmtBytes(b, input.format, input.uppercase), byteCount: b.length, characters: Array.from(input.text).length, validUtf8: true };
    }
    if (input.bytes == null) throw new ToolError('Give "text" or "bytes".');
    const r = parseBytes(input.bytes, input.format);
    if (!r.ok) throw new ToolError(r.error);
    const d = decode(r.bytes);
    return { text: d.text, bytes: fmtBytes(r.bytes, input.format, input.uppercase), byteCount: r.bytes.length, characters: Array.from(d.text).length, validUtf8: d.valid };
  },
});

export default [baseConvert, bytesConvert];

import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputDir, outputPath, returnBase64, writeOutput } from '../../../util/files.js';
import { normHex } from './_qr.js';

// Port of https://github.com/s3eidat/barcode-gen (app.js): the site's own encoders for Code 128 (auto B/C),
// EAN-13, UPC-A and Code 39, the same check digits, layout (quiet zones, guard bars, digits) and SVG.

// ---------- Code 128 ----------
const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112').split(' ');
export const C128_PATTERNS = C128;
function digitRun(s: string, i: number) { let j = i; while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++; return j - i; }
export function code128Values(s: string) {
  for (let k = 0; k < s.length; k++) { const cc = s.charCodeAt(k); if (cc < 32 || cc > 126) throw new ToolError('Code 128 here supports printable ASCII only (no “' + s[k] + '”)'); }
  if (!s.length) throw new ToolError('Enter a value');
  const out: number[] = [];
  let set: string | null = null, i = 0;
  const n = s.length;
  while (i < n) {
    const d = digitRun(s, i);
    let useC = (d === n && d % 2 === 0) || (d >= 4 && (i === 0 || i + d === n)) || d >= 6;
    if (useC && d % 2 && i > 0) useC = false; // odd run mid-string: one digit in B first, the even rest goes to C
    if (useC) {
      if (set !== 'C') { out.push(set ? 99 : 105); set = 'C'; }
      const take = d - (d % 2);
      for (let e = 0; e < take; e += 2) out.push(+s.substr(i + e, 2));
      i += take;
    } else {
      if (set !== 'B') { out.push(set ? 100 : 104); set = 'B'; }
      out.push(s.charCodeAt(i) - 32); i++;
    }
  }
  let sum = out[0];
  for (let j = 1; j < out.length; j++) sum += out[j] * j;
  out.push(sum % 103, 106);
  return out;
}
function widthsToBits(w: string) { let b = ''; for (let i = 0; i < w.length; i++) b += (i % 2 ? '0' : '1').repeat(+w[i]); return b; }

export interface Encoded { bits: string; quiet: number; quietR?: number; text: string; digits?: string; kind?: 'ean' | 'upc'; note?: string }
export function code128(s: string): Encoded { return { bits: code128Values(s).map((v) => widthsToBits(C128[v])).join(''), quiet: 10, text: s }; }

// ---------- EAN-13 / UPC-A ----------
export const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
export function inv(b: string) { return b.replace(/./g, (c) => (c === '1' ? '0' : '1')); }
export function eanCheck(d12: string) { let s = 0; for (let i = 0; i < 12; i++) s += +d12[i] * (i % 2 ? 3 : 1); return (10 - (s % 10)) % 10; }
export function upcCheck(d11: string) { let s = 0; for (let i = 0; i < 11; i++) s += +d11[i] * (i % 2 ? 1 : 3); return (10 - (s % 10)) % 10; }
function eanBits(d13: string) {
  const p = PARITY[+d13[0]];
  let b = '101';
  for (let i = 1; i <= 6; i++) { const l = L[+d13[i]]; b += p[i - 1] === 'L' ? l : inv(l).split('').reverse().join(''); }
  b += '01010';
  for (let i = 7; i <= 12; i++) b += inv(L[+d13[i]]);
  return b + '101';
}
function digitsOnly(v: string, okLens: number[], name: string) {
  const d = v.replace(/[\s-]/g, '');
  if (!/^\d*$/.test(d)) throw new ToolError(name + ' uses digits only');
  if (okLens.indexOf(d.length) < 0) throw new ToolError(name + ' needs ' + okLens.join(' or ') + ' digits (you have ' + d.length + ')');
  return d;
}
export function ean13(v: string): Encoded {
  let d = digitsOnly(v, [12, 13], 'EAN-13');
  const c = eanCheck(d.slice(0, 12));
  if (d.length === 13 && +d[12] !== c) throw new ToolError('Check digit should be ' + c + ', not ' + d[12] + ' (' + d.slice(0, 12) + c + ')');
  const note = d.length === 12 ? 'Check digit ' + c + ' added' : 'Check digit ' + c + ' is valid';
  d = d.slice(0, 12) + c;
  return { bits: eanBits(d), quiet: 11, quietR: 7, digits: d, kind: 'ean', note, text: d };
}
export function upca(v: string): Encoded {
  let d = digitsOnly(v, [11, 12], 'UPC-A');
  const c = upcCheck(d.slice(0, 11));
  if (d.length === 12 && +d[11] !== c) throw new ToolError('Check digit should be ' + c + ', not ' + d[11] + ' (' + d.slice(0, 11) + c + ')');
  const note = d.length === 11 ? 'Check digit ' + c + ' added' : 'Check digit ' + c + ' is valid';
  d = d.slice(0, 11) + c;
  return { bits: eanBits('0' + d), quiet: 9, quietR: 9, digits: d, kind: 'upc', note, text: d };
}

// ---------- Code 39 (wide:narrow = 3:1) ----------
const C39CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
export const C39: Record<string, string> = {
  0: '000110100', 1: '100100001', 2: '001100001', 3: '101100000', 4: '000110001', 5: '100110000', 6: '001110000', 7: '000100101',
  8: '100100100', 9: '001100100', A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000', F: '001011000',
  G: '000001101', H: '100001100', I: '001001100', J: '000011100', K: '100000011', L: '001000011', M: '101000010', N: '000010011',
  O: '100010010', P: '001010010', Q: '000000111', R: '100000110', S: '001000110', T: '000010110', U: '110000001', V: '011000001',
  W: '111000000', X: '010010001', Y: '110010000', Z: '011010000', '-': '010000101', '.': '110000100', ' ': '011000100', '*': '010010100',
  $: '010101000', '/': '010100010', '+': '010001010', '%': '000101010',
};
export function c39mod43(s: string) { let t = 0; for (let i = 0; i < s.length; i++) t += C39CH.indexOf(s[i]); return C39CH[t % 43]; }
export function code39(v: string, withCheck: boolean): Encoded {
  let s = v.toUpperCase();
  if (!s.length) throw new ToolError('Enter a value');
  for (let i = 0; i < s.length; i++) if (C39CH.indexOf(s[i]) < 0) throw new ToolError('Code 39 can\'t encode “' + s[i] + '”. Use A–Z, 0–9, space and - . $ / + %');
  if (withCheck) s += c39mod43(s);
  const full = '*' + s + '*';
  let bits = '';
  for (let i = 0; i < full.length; i++) {
    const p = C39[full[i]];
    for (let k = 0; k < 9; k++) bits += (k % 2 ? '0' : '1').repeat(p[k] === '1' ? 3 : 1);
    if (i < full.length - 1) bits += '0';
  }
  return { bits, quiet: 10, text: '*' + s + '*', note: v !== v.toUpperCase() ? 'Letters made uppercase' : withCheck ? 'Check character ' + s[s.length - 1] + ' added' : '' };
}

export type Format = 'code128' | 'ean13' | 'upca' | 'code39';
export function encode(fmt: Format, v: string, o: { c39check?: boolean } = {}): Encoded {
  if (fmt === 'ean13') return ean13(v);
  if (fmt === 'upca') return upca(v);
  if (fmt === 'code39') return code39(v, !!o.c39check);
  return code128(v);
}

// ---------- layout (px), shared by SVG and PNG ----------
interface LayoutOpts { mod: number; height: number; text: boolean }
export function layout(enc: Encoded, o: LayoutOpts) {
  const m = o.mod, qL = enc.quiet, qR = enc.quietR || enc.quiet, bits = enc.bits, H = o.height, pad = Math.max(6, m * 4);
  const retail = !!enc.kind, fs = o.text ? (retail ? Math.max(11, m * 9) : Math.max(12, Math.round(m * 7 + 5))) : 0;
  const longEnd = H + (retail && o.text ? fs * 0.55 : 0);
  const isLong = (i: number) => {
    if (!retail || !o.text) return false;
    if (i < 3 || (i >= 45 && i < 50) || i >= 92) return true;
    return enc.kind === 'upc' && ((i >= 3 && i < 10) || (i >= 85 && i < 92));
  };
  const bars: { x: number; w: number; h: number }[] = [];
  let i = 0;
  while (i < bits.length) {
    if (bits[i] !== '1') { i++; continue; }
    let j = i;
    const lg = isLong(i);
    while (j < bits.length && bits[j] === '1' && isLong(j) === lg) j++;
    bars.push({ x: (qL + i) * m, w: (j - i) * m, h: lg ? longEnd : H });
    i = j;
  }
  const texts: { x: number; t: string; small?: boolean }[] = [], W = (qL + bits.length + qR) * m, textY = pad + H + (retail ? fs * 0.95 : fs * 1.15);
  if (o.text) {
    const X = (mod: number) => (qL + mod) * m, d = enc.digits ?? '';
    if (enc.kind === 'ean') {
      texts.push({ x: X(-4), t: d[0] });
      for (let k = 0; k < 6; k++) texts.push({ x: X(3 + 7 * k + 3.5), t: d[1 + k] });
      for (let k = 0; k < 6; k++) texts.push({ x: X(50 + 7 * k + 3.5), t: d[7 + k] });
    } else if (enc.kind === 'upc') {
      texts.push({ x: X(-4), t: d[0], small: true });
      for (let k = 0; k < 5; k++) texts.push({ x: X(10 + 7 * k + 3.5), t: d[1 + k] });
      for (let k = 0; k < 5; k++) texts.push({ x: X(50 + 7 * k + 3.5), t: d[6 + k] });
      texts.push({ x: X(bits.length + 4), t: d[11], small: true });
    } else texts.push({ x: W / 2, t: enc.text });
  }
  const Ht = pad * 2 + Math.max(longEnd, o.text ? textY - pad + fs * 0.25 : H);
  return { W, H: Math.ceil(Ht), pad, bars, texts, fs, textY };
}
const FONT = "'OCR B','OCRB',Consolas,'DejaVu Sans Mono','Courier New',monospace";
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function toSvg(lay: ReturnType<typeof layout>, o: { fg: string; bg: string }) {
  let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + lay.W + '" height="' + lay.H + '" viewBox="0 0 ' + lay.W + ' ' + lay.H + '">' +
    '<rect width="100%" height="100%" fill="' + o.bg + '"/><g fill="' + o.fg + '" shape-rendering="crispEdges">';
  lay.bars.forEach((b) => { s += '<rect x="' + b.x + '" y="' + lay.pad + '" width="' + b.w + '" height="' + b.h + '"/>'; });
  s += '</g>';
  if (lay.texts.length) {
    s += '<g fill="' + o.fg + '" font-family="' + FONT.replace(/"/g, '') + '" font-size="' + lay.fs + '">';
    lay.texts.forEach((t) => { s += '<text x="' + t.x + '" y="' + lay.textY + '" text-anchor="middle"' + (t.small ? ' font-size="' + Math.round(lay.fs * 0.75) + '"' : '') + '>' + esc(t.t) + '</text>'; });
    s += '</g>';
  }
  return s + '</svg>';
}

async function render(enc: Encoded, o: { mod: number; height: number; text: boolean; fg: string; bg: string; format: 'svg' | 'png'; scale: number }) {
  const lay = layout(enc, o);
  const svg = toSvg(lay, o);
  if (o.format === 'svg') return { data: svg as string | Buffer, lay };
  const { default: sharp } = await import('sharp');
  const png = await sharp(Buffer.from(svg), { density: 72 * o.scale }).png({ compressionLevel: 9 }).toBuffer();
  return { data: png as string | Buffer, lay };
}
const fileBase = (enc: Encoded, v: string) => (enc.digits || v).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'barcode';

export default defineTool({
  name: 'barcode_generate',
  title: 'Barcode generator',
  webSlug: 'barcode-gen',
  description:
    'Make 1D barcodes as SVG or PNG: Code 128 (any printable ASCII; digit runs packed with subset C automatically), EAN-13 ' +
    '(12 digits, check digit added; or 13, check digit verified), UPC-A (11 or 12 digits, same) and Code 39 (A-Z, 0-9, ' +
    'space, - . $ / + %, optional mod-43 check). Same encoders, quiet zones, guard bars and human-readable digits as the ' +
    'website. Give "value" for one barcode, or "values" (up to 1000) to write one file per value into a folder; invalid ' +
    'values are reported, not fatal. PNG text uses the system monospace font. ' +
    `Web version: ${webUrl('barcode-gen')}`,
  inputSchema: z.object({
    value: z.string().optional().describe('The value to encode (one barcode).'),
    values: z.array(z.string()).max(1000).optional().describe('Or: many values; each becomes its own file in the output folder.'),
    symbology: z.enum(['code128', 'ean13', 'upca', 'code39']).optional().default('code128').describe('Barcode type (default code128).'),
    code39Check: z.boolean().optional().default(false).describe('Code 39 only: append the mod-43 check character.'),
    format: z.enum(['svg', 'png']).optional().default('svg').describe('Output format (default svg).'),
    barWidth: z.number().int().min(1).max(6).optional().default(2).describe('Narrow bar (module) width in px, 1-6 (default 2).'),
    height: z.number().int().min(30).max(220).optional().default(80).describe('Bar height in px, 30-220 (default 80).'),
    showText: z.boolean().optional().default(true).describe('Print the human-readable text/digits under the bars.'),
    foreground: z.string().optional().default('#000000').describe('Bar colour, hex.'),
    background: z.string().optional().default('#ffffff').describe('Background colour, hex.'),
    scale: z.number().int().min(1).max(8).optional().default(2).describe('PNG only: pixel scale (1×, 2× default, 4×…).'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    path: z.string().optional().describe('The written file (single value).'),
    bytes: z.number().optional(),
    mimeType: z.string().optional(),
    base64: z.string().optional(),
    text: z.string().optional().describe('Encoded text (with check digit / check character).'),
    note: z.string().optional().describe('e.g. "Check digit 1 added".'),
    width: z.number().optional().describe('SVG width in px (PNG is width × scale).'),
    height: z.number().optional(),
    modules: z.number().optional().describe('Barcode width in modules (without quiet zones).'),
    folder: z.string().optional().describe('Batch: folder with one file per value.'),
    files: z.array(z.object({ value: z.string(), path: z.string(), text: z.string() })).optional(),
    errors: z.array(z.object({ line: z.number(), value: z.string(), error: z.string() })).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { value: '400638133393', symbology: 'ean13' }, output: { text: '4006381333931', note: 'Check digit 1 added' } },
    { input: { value: 'S3EIDAT-2026' }, note: 'Code 128 SVG' },
    { input: { values: ['590123412345', '400638133393', '12345'], symbology: 'ean13', format: 'png' }, note: 'Two files, one error (12345 is too short).' },
  ],
  async run(input, ctx) {
    const o = {
      mod: input.barWidth, height: input.height, text: input.showText, fg: normHex(input.foreground), bg: normHex(input.background),
      format: input.format, scale: input.scale,
    };
    const ext = input.format, mime = ext === 'svg' ? 'image/svg+xml' : 'image/png';
    if (input.values) {
      const dir = await outputDir(input.output, `barcodes-${input.symbology}`, ctx);
      const files: { value: string; path: string; text: string }[] = [], errors: { line: number; value: string; error: string }[] = [];
      const used = new Set<string>();
      for (const [i, raw] of input.values.entries()) {
        const v = raw.trim();
        if (!v) continue;
        let enc: Encoded;
        try { enc = encode(input.symbology, v, { c39check: input.code39Check }); } catch (e) { errors.push({ line: i + 1, value: v, error: (e as Error).message }); continue; }
        const base = fileBase(enc, v);
        let name = base;
        for (let n = 2; used.has(name); n++) name = base + '-' + n;
        used.add(name);
        const { data } = await render(enc, o);
        const out = await writeOutput(data, { output: join(dir, `${name}.${ext}`), defaultName: `${name}.${ext}` }, ctx);
        files.push({ value: v, path: out.path, text: enc.text });
      }
      if (!files.length) throw new ToolError(`No valid values. First problem: ${errors[0] ? `"${errors[0].value}": ${errors[0].error}` : 'all values were empty'}.`);
      return { folder: dir, files, errors };
    }
    if (input.value == null) throw new ToolError('Give "value" (or "values" for a batch).');
    const enc = encode(input.symbology, input.value, { c39check: input.code39Check });
    const { data, lay } = await render(enc, o);
    const out = await writeOutput(data, { output: input.output, defaultName: `${fileBase(enc, input.value)}.${ext}`, mimeType: mime, base64: input.returnBase64 }, ctx);
    return { ...out, text: enc.text, ...(enc.note ? { note: enc.note } : {}), width: lay.W, height: lay.H, modules: enc.bits.length };
  },
});

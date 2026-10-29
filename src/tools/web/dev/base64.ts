import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, readInput, writeOutput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/base64-kit (app.js): same lenient decoder, URL-safe form,
// 76-column wrap and magic-byte detection, so results match the website.

export function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
export function toUrlSafe(b64: string) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function wrap76(s: string) {
  return s.replace(/(.{76})(?=.)/g, '$1\n');
}

/** Accepts standard, URL-safe, missing padding, whitespace/newlines and "data:…;base64," prefixes. */
export function b64ToBytes(input: string): { bytes: Uint8Array; mime: string } {
  let s = String(input).trim(), mime = '';
  const m = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(s);
  if (m) {
    mime = m[1];
    s = s.slice(m[0].length);
  }
  s = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/=]/.test(s)) throw new ToolError('Contains characters that are not Base64');
  s = s.replace(/=+$/, '');
  if (s.includes('=')) throw new ToolError('Invalid Base64: "=" padding in the middle');
  if (s.length % 4 === 1) throw new ToolError('Wrong length — a character is missing or extra');
  s += '==='.slice(0, (4 - (s.length % 4)) % 4);
  return { bytes: new Uint8Array(Buffer.from(s, 'base64')), mime };
}

export function encodeText(text: string, urlSafe = false) {
  const b = bytesToB64(new TextEncoder().encode(text));
  return urlSafe ? toUrlSafe(b) : b;
}
export function decodeText(b64: string) {
  return new TextDecoder('utf-8', { fatal: true }).decode(b64ToBytes(b64).bytes);
}

interface Magic {
  sig?: number[];
  type: string;
  mime: string;
  ext: string;
}
const MAGIC: Magic[] = [
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: 'PNG image', mime: 'image/png', ext: 'png' },
  { sig: [0xff, 0xd8, 0xff], type: 'JPEG image', mime: 'image/jpeg', ext: 'jpg' },
  { sig: [0x47, 0x49, 0x46, 0x38], type: 'GIF image', mime: 'image/gif', ext: 'gif' },
  { sig: [0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x45, 0x42, 0x50], type: 'WebP image', mime: 'image/webp', ext: 'webp' },
  { sig: [0x42, 0x4d], type: 'BMP image', mime: 'image/bmp', ext: 'bmp' },
  { sig: [0x25, 0x50, 0x44, 0x46, 0x2d], type: 'PDF document', mime: 'application/pdf', ext: 'pdf' },
  { sig: [0x50, 0x4b, 0x03, 0x04], type: 'ZIP archive (also docx/xlsx/apk)', mime: 'application/zip', ext: 'zip' },
  { sig: [0x1f, 0x8b], type: 'Gzip archive', mime: 'application/gzip', ext: 'gz' },
  { sig: [0x49, 0x44, 0x33], type: 'MP3 audio', mime: 'audio/mpeg', ext: 'mp3' },
  { sig: [0x4f, 0x67, 0x67, 0x53], type: 'Ogg media', mime: 'audio/ogg', ext: 'ogg' },
  { sig: [0x00, 0x00, 0x00, -1, 0x66, 0x74, 0x79, 0x70], type: 'MP4 / MOV video', mime: 'video/mp4', ext: 'mp4' },
  { sig: [0x77, 0x4f, 0x46, 0x32], type: 'WOFF2 font', mime: 'font/woff2', ext: 'woff2' },
];

/** File type from magic bytes (same table as the website). */
export function detect(bytes: Uint8Array): Magic {
  for (const mg of MAGIC) {
    const s = mg.sig!;
    let ok = bytes.length >= s.length;
    for (let j = 0; ok && j < s.length; j++) if (s[j] !== -1 && bytes[j] !== s[j]) ok = false;
    if (ok) return mg;
  }
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 4096));
    if (/^\s*<svg[\s>]|^\s*<\?xml[^>]*>\s*<svg/i.test(t)) return { type: 'SVG image', mime: 'image/svg+xml', ext: 'svg' };
    if (/^\s*[{[]/.test(t)) return { type: 'JSON / text', mime: 'application/json', ext: 'json' };
    return { type: 'Text', mime: 'text/plain', ext: 'txt' };
  } catch {
    return { type: 'Binary data', mime: 'application/octet-stream', ext: 'bin' };
  }
}

const INLINE_MAX = 1024 * 1024; // larger results go to a file instead of the reply

const encode = defineTool({
  name: 'base64_encode',
  title: 'Base64 encode',
  webSlug: 'base64-kit',
  description:
    'Encode text (as UTF-8) or a file (path or base64) to Base64. Options: URL-safe alphabet (- and _, no padding), wrap at 76 ' +
    'columns (MIME), or a data: URI for files (MIME type detected from magic bytes). Results over 1 MB, or when "output" is ' +
    `given, are written to a text file instead of returned inline. Web version: ${webUrl('base64-kit')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('Text to encode (UTF-8).'),
    file: z.string().optional().describe('Or: a file to encode: local path or base64 data.'),
    urlSafe: z.boolean().optional().default(false).describe('Use the URL-safe alphabet (- and _) and drop "=" padding.'),
    wrap: z.boolean().optional().default(false).describe('Insert a line break every 76 characters (MIME style).'),
    dataUri: z.boolean().optional().default(false).describe('Return a data: URI (data:<mime>;base64,…) instead of bare Base64.'),
    output: outputPath(),
  }),
  outputSchema: z.object({
    base64: z.string().optional().describe('The encoded text (absent when written to a file).'),
    path: z.string().optional().describe('File holding the encoded text, when written to disk.'),
    inputBytes: z.number(),
    characters: z.number(),
    detectedType: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'foobar' }, output: { base64: 'Zm9vYmFy', inputBytes: 6, characters: 8 } },
    { input: { text: 'ûÿ', urlSafe: true }, note: 'URL-safe output without padding' },
  ],
  async run(input, ctx) {
    let bytes: Uint8Array, name = 'text', mime = 'text/plain', type: string | undefined;
    if (input.text != null) bytes = new TextEncoder().encode(input.text);
    else if (input.file) {
      const f = await readInput(input.file, ctx, 'file');
      bytes = f.bytes;
      name = f.name;
      const d = detect(bytes);
      type = d.type;
      mime = f.mimeType || d.mime;
    } else throw new ToolError('Give "text" or "file".');
    let b = bytesToB64(bytes);
    if (input.dataUri) b = 'data:' + mime + ';base64,' + b;
    else {
      if (input.urlSafe) b = toUrlSafe(b);
      if (input.wrap) b = wrap76(b);
    }
    const out: { base64?: string; path?: string; inputBytes: number; characters: number; detectedType?: string; mimeType?: string } = {
      inputBytes: bytes.length,
      characters: b.length,
    };
    if (type) {
      out.detectedType = type;
      out.mimeType = mime;
    }
    if (input.output || b.length > INLINE_MAX) out.path = (await writeOutput(b, { output: input.output, defaultName: name + '.b64.txt' }, ctx)).path;
    else out.base64 = b;
    return out;
  },
});

const decode = defineTool({
  name: 'base64_decode',
  title: 'Base64 decode',
  webSlug: 'base64-kit',
  description:
    'Decode Base64 (standard or URL-safe, padding optional, whitespace and data: URI prefix allowed). Valid UTF-8 text is ' +
    'returned inline; binary data (or anything when "output" is given) is written to a file whose extension comes from the ' +
    `detected type (PNG, JPEG, GIF, WebP, BMP, PDF, ZIP, gzip, MP3, Ogg, MP4, WOFF2, SVG, JSON). Web version: ${webUrl('base64-kit')}`,
  inputSchema: z.object({
    base64: z.string().describe('The Base64 text to decode (may be a data: URI).'),
    output: outputPath(),
    fileName: z.string().optional().describe('Base name for the written file (extension follows the detected type). Default "decoded".'),
  }),
  outputSchema: z.object({
    text: z.string().optional().describe('Decoded UTF-8 text (when the bytes are text and no output path was given).'),
    path: z.string().optional().describe('Written file, for binary data or when "output" was given.'),
    bytes: z.number(),
    isText: z.boolean(),
    detectedType: z.string(),
    mimeType: z.string(),
    dataUriMime: z.string().optional().describe('MIME type the data: URI declared, if any.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { base64: 'Zm9vYmFy' }, output: { text: 'foobar', bytes: 6, isText: true, detectedType: 'Text', mimeType: 'text/plain' } },
    { input: { base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }, note: 'Writes decoded.png' },
  ],
  async run(input, ctx) {
    const r = b64ToBytes(input.base64);
    const d = detect(r.bytes);
    let text: string | undefined;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(r.bytes);
    } catch {
      text = undefined;
    }
    const mime = d.mime === 'application/octet-stream' && r.mime ? r.mime : d.mime;
    const out: { text?: string; path?: string; bytes: number; isText: boolean; detectedType: string; mimeType: string; dataUriMime?: string } = {
      bytes: r.bytes.length,
      isText: text != null,
      detectedType: d.type,
      mimeType: mime,
    };
    if (r.mime) out.dataUriMime = r.mime;
    if (text != null && !input.output) out.text = text;
    else {
      const base = (input.fileName || 'decoded').replace(/\.[A-Za-z0-9]+$/, '');
      out.path = (await writeOutput(r.bytes, { output: input.output, defaultName: base + '.' + d.ext, mimeType: mime }, ctx)).path;
    }
    return out;
  },
});

export default [encode, decode];

import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { fileInput, readInput } from '../../util/files.js';

/** Extensions that name the same format. */
const SAME: string[][] = [
  ['jpg', 'jpeg', 'jpe', 'jfif'], ['tif', 'tiff'], ['htm', 'html', 'xhtml'], ['mp4', 'm4v', 'm4a', 'm4b', 'm4p', 'f4v', 'mov', 'qt'],
  ['mpg', 'mpeg', 'mpe'], ['mkv', 'mka', 'mks', 'webm'], ['ogg', 'oga', 'ogv', 'ogx', 'opus', 'spx'], ['heic', 'heif', 'avif'], ['xml', 'svg', 'xsl', 'xslt', 'rss', 'atom', 'kml', 'plist', 'xliff'],
  ['ico', 'cur'], ['yml', 'yaml'], ['aif', 'aiff', 'aifc'], ['gz', 'tgz'], ['zip', 'jar', 'apk', 'ipa', 'xpi', 'epub', 'whl', 'nupkg', 'vsix', 'crx', 'kmz', 'ora', 'sketch', 'odt', 'ods', 'odp', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'dotx', 'xltx', 'potx', '3mf'],
  ['exe', 'dll', 'sys', 'scr', 'ocx', 'cpl', 'efi'], ['doc', 'xls', 'ppt', 'msg', 'msi', 'cfb', 'dot', 'xlt', 'pot'], ['ttf', 'ttc'], ['wav', 'wave'], ['mid', 'midi'], ['ps', 'eps'], ['ai', 'pdf'],
  ['ts', 'mts', 'm2ts'], ['txt', 'text', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'mjs', 'cjs', 'ts', 'css', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml', 'xml', 'html', 'htm', 'svg', 'sql', 'py', 'sh', 'bat', 'ps1', 'rtf', 'srt', 'vtt', 'env'],
];
/** Extensions of binary formats: a text file wearing one of these is a mismatch. */
const BINARY_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'zip', 'rar', '7z', 'gz', 'exe', 'dll', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'heic', 'avif', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'psd', 'sqlite', 'db', 'iso', 'dmg', 'apk', 'jar', 'class', 'wasm']);

function sameFormat(a: string, b: string) {
  if (a === b) return true;
  return SAME.some((g) => g.includes(a) && g.includes(b));
}

export type Encoding = 'utf-8' | 'utf-8-bom' | 'ascii' | 'utf-16le-bom' | 'utf-16be-bom' | 'utf-16le' | 'utf-16be' | 'utf-32le-bom' | 'utf-32be-bom' | '8-bit (not UTF-8, e.g. Windows-1252 / Latin-1)' | 'binary';

/** Guess whether bytes are text and in what encoding (BOMs, UTF-8 validity, NUL patterns). */
export function guessEncoding(b: Uint8Array): Encoding {
  if (b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0) return 'utf-32le-bom';
  if (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) return 'utf-32be-bom';
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8-bom';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le-bom';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be-bom';
  const s = b.subarray(0, 65536);
  if (!s.length) return 'ascii';
  let nul = 0, nulEven = 0, nulOdd = 0, ctrl = 0, high = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === 0) { nul++; if (i % 2) nulOdd++; else nulEven++; } else if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) ctrl++;
    else if (c >= 0x80) high++;
  }
  if (nul) {
    // Mostly-ASCII UTF-16 without a BOM has a NUL in every other byte.
    const half = s.length / 2;
    if (nulOdd > half * 0.6 && nulEven < half * 0.05) return 'utf-16le';
    if (nulEven > half * 0.6 && nulOdd < half * 0.05) return 'utf-16be';
    return 'binary';
  }
  if (ctrl > s.length * 0.02) return 'binary';
  if (!high) return 'ascii';
  // Validate UTF-8; allow a sequence cut off at the 64 KB sample edge.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(s.length < b.length ? trimPartial(s) : s);
    return 'utf-8';
  } catch {
    return high > s.length * 0.3 ? 'binary' : '8-bit (not UTF-8, e.g. Windows-1252 / Latin-1)';
  }
}
function trimPartial(s: Uint8Array) {
  let end = s.length;
  for (let k = 1; k <= 3 && end - k >= 0; k++) {
    const c = s[end - k];
    if ((c & 0xc0) === 0xc0) return s.subarray(0, end - k); // lead byte of a cut sequence
    if ((c & 0xc0) !== 0x80) break;
  }
  return s;
}

/** For text: a closer guess at what kind of text it is. */
function textKind(b: Uint8Array, enc: Encoding): { ext: string; mime: string } | undefined {
  let t: string;
  try {
    const sample = b.subarray(0, 65536);
    t = enc.startsWith('utf-16') ? new TextDecoder(enc.startsWith('utf-16be') ? 'utf-16be' : 'utf-16le').decode(sample) : Buffer.from(sample).toString('utf8');
  } catch { return undefined; }
  t = t.replace(/^﻿/, '').trimStart();
  const head = t.slice(0, 1024).toLowerCase();
  if (/^<svg[\s>]/.test(head) || (/^<\?xml/.test(head) && /<svg[\s>]/.test(head))) return { ext: 'svg', mime: 'image/svg+xml' };
  if (/^<!doctype html|^<html[\s>]/.test(head)) return { ext: 'html', mime: 'text/html' };
  if (/^<\?xml/.test(head)) return { ext: 'xml', mime: 'application/xml' };
  if (/^\{\\rtf/.test(head)) return { ext: 'rtf', mime: 'application/rtf' };
  if (/^%!ps/.test(head)) return { ext: 'ps', mime: 'application/postscript' };
  if (/^#!/.test(head)) return { ext: 'sh', mime: 'text/x-shellscript' };
  if (/^[{[]/.test(t) && b.length <= 65536) { try { JSON.parse(t); return { ext: 'json', mime: 'application/json' }; } catch { /* not json */ } }
  return { ext: 'txt', mime: 'text/plain' };
}

export default defineTool({
  name: 'ai_file_identify',
  title: 'Identify a file type',
  description:
    'Find out what a file really is from its content (magic bytes, via file-type: images, video, audio, archives, Office, PDF, fonts, executables… ~150 formats), ' +
    'not its name. Reports the detected type and MIME, whether the extension disagrees with the content, size, SHA-256, and for text files an encoding guess ' +
    '(UTF-8, UTF-8/16/32 with BOM, UTF-16 without BOM, ASCII, 8-bit legacy) plus a text kind (JSON, XML, SVG, HTML…). Accepts a file path or base64. Nothing is executed.',
  inputSchema: z.object({
    file: fileInput('file to identify'),
    name: z.string().optional().describe('File name to compare the extension against (handy for base64 input). Default: the path\'s own name.'),
  }),
  outputSchema: z.object({
    name: z.string(),
    size: z.number().describe('Size in bytes.'),
    sha256: z.string(),
    extension: z.string().nullable().describe('Extension of the file name (lower case, no dot), or null.'),
    detected: z.object({ ext: z.string(), mime: z.string(), source: z.enum(['magic', 'text']) }).nullable().describe('What the content is; null when unknown binary.'),
    isText: z.boolean(),
    encoding: z.string().nullable().describe('Text encoding guess, or null for binary formats.'),
    mismatch: z.boolean().describe('True when the extension does not match the detected content.'),
    note: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'base64:iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', name: 'photo.jpg' }, output: { detected: { ext: 'png', mime: 'image/png' }, mismatch: true } },
  ],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, 'file');
    const name = input.name ?? f.name;
    const e = extname(name).slice(1).toLowerCase();
    const extension = e || null;
    const sha256 = createHash('sha256').update(f.bytes).digest('hex');
    const { fileTypeFromBuffer } = await import('file-type');
    const ft = await fileTypeFromBuffer(new Uint8Array(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength)).catch(() => undefined);
    let detected: { ext: string; mime: string; source: 'magic' | 'text' } | null = null;
    let encoding: string | null = null;
    let isText = false;
    if (ft && !['xml', 'svg', 'html'].includes(ft.ext)) {
      detected = { ext: ft.ext, mime: ft.mime, source: 'magic' };
    } else {
      const enc = guessEncoding(f.bytes);
      if (enc !== 'binary') {
        isText = true; encoding = enc;
        const k = textKind(f.bytes, enc);
        detected = k ? { ...k, source: 'text' } : null;
      } else if (ft) detected = { ext: ft.ext, mime: ft.mime, source: 'magic' };
    }
    let mismatch = false;
    let note: string;
    if (!detected) {
      note = 'Unknown binary format: no known signature.';
      mismatch = !!extension && ['txt', 'csv', 'json', 'md', 'xml', 'html', 'svg'].includes(extension);
    } else if (isText) {
      mismatch = !!extension && BINARY_EXT.has(extension);
      note = mismatch ? `The name says .${extension}, but the content is plain text (${detected.ext}).` : `Text file (${encoding}).`;
    } else {
      mismatch = !!extension && !sameFormat(extension, detected.ext);
      note = mismatch ? `The name says .${extension}, but the content is ${detected.ext.toUpperCase()} (${detected.mime}).` : `${detected.ext.toUpperCase()} file (${detected.mime}).`;
    }
    if (!extension && detected) note += ' The name has no extension.';
    return { name, size: f.bytes.length, sha256, extension, detected, isText, encoding, mismatch, note };
  },
});

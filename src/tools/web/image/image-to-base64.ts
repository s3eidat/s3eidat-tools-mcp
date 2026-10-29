import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, outputPath, readInput, readTextInput, writeOutput } from '../../../util/files.js';
import { esc, fmtBytes, sharp } from './_img.js';

// Port of https://github.com/s3eidat/image-to-base64 (app.js): encode a file as a data URI (+ CSS / HTML / Markdown
// snippets), or decode a data URI / CSS url() / <img src> / raw Base64 back into a file.

export function b64ToBytes(b64: string): Uint8Array {
  let t = String(b64).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 === 1) throw new ToolError('Not valid Base64');
  while (t.length % 4) t += '=';
  return new Uint8Array(Buffer.from(t, 'base64'));
}
export const bytesToB64 = (u8: Uint8Array) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');

export function sniff(u8: Uint8Array): string {
  const at = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) if (u8[off + i] !== str.charCodeAt(i)) return false;
    return true;
  };
  if (u8[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(4, 'ftypavif') || at(4, 'ftypavis')) return 'image/avif';
  if (at(4, 'ftypheic') || at(4, 'ftypheix') || at(4, 'ftypmif1')) return 'image/heic';
  if (at(0, 'BM')) return 'image/bmp';
  if (u8[0] === 0 && u8[1] === 0 && u8[2] === 1 && u8[3] === 0) return 'image/x-icon';
  if (at(0, 'II*\0') || at(0, 'MM\0*')) return 'image/tiff';
  if (at(0, '%PDF')) return 'application/pdf';
  const head = new TextDecoder().decode(u8.subarray(0, 1024)).replace(/^﻿/, '').trim();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** Accepts a bare data URI, CSS url("…"), <img src="…">, or raw Base64. */
export function parseInput(text: string): { mime: string; declared: boolean; bytes: Uint8Array } | null {
  text = String(text).trim();
  if (!text) return null;
  const m = /data:([\w.+-]+\/[\w.+-]+)?((?:;[\w.+-]+(?:=[\w.+-]+)?)*),([^"')]*)/i.exec(text);
  if (m) {
    const isB64 = /;base64/i.test(m[2]);
    const mime = (m[1] || 'text/plain').toLowerCase();
    let bytes: Uint8Array;
    if (isB64) bytes = b64ToBytes(m[3]);
    else {
      let raw: string;
      try {
        raw = decodeURIComponent(m[3]);
      } catch {
        throw new ToolError('The URL-encoded data is broken');
      }
      bytes = new TextEncoder().encode(raw);
    }
    return { mime, declared: true, bytes };
  }
  const u8 = b64ToBytes(text);
  if (!u8.length) throw new ToolError('Not valid Base64');
  return { mime: sniff(u8), declared: false, bytes: u8 };
}

/** SVG is text, so a URL-encoded data URI is usually ~30% smaller than Base64. */
export function svgDataUri(svg: string) {
  return (
    'data:image/svg+xml,' +
    svg
      .trim()
      .replace(/\s*[\r\n]+\s*/g, ' ')
      .replace(/[%#<>"{}|\\^`]/g, encodeURIComponent)
      .replace(/[^\x20-\x7E]/gu, encodeURIComponent)
  );
}

export const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic',
  'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tif', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'txt',
};

/** The website's size warning for an inlined data URI. */
export function sizeWarning(uriLength: number) {
  if (uriLength > 1048576) return { level: 'bad', text: 'Very large: use a normal file' };
  if (uriLength > 10240) return { level: 'warn', text: 'Over 10 KB: inlining may slow pages' };
  return { level: 'ok', text: 'Small enough to inline' };
}

async function dims(bytes: Uint8Array) {
  try {
    const m = await sharp(bytes).metadata();
    return { width: m.autoOrient?.width ?? m.width, height: m.autoOrient?.height ?? m.height };
  } catch {
    return {};
  }
}

const SNIPPETS = ['dataUri', 'base64', 'css', 'html', 'markdown', 'svgUri'] as const;

const toBase64 = defineTool({
  name: 'image_to_base64',
  title: 'Image to Base64 / data URI',
  webSlug: 'image-to-base64',
  description:
    'Encode an image (or any file) as Base64: a data URI, bare Base64, a CSS background-image rule, an HTML <img> tag (with width/height), ' +
    'Markdown, or for SVG a URL-encoded data URI (usually ~30% smaller). Detects the type from the bytes and warns when the result is ' +
    'too big to inline (over 10 KB: slows pages; over 1 MB: use a normal file). Results longer than maxChars are written to a .txt file ' +
    `instead of being returned. Web version: ${webUrl('image-to-base64')}`,
  inputSchema: z.object({
    image: fileInput('image'),
    as: z.enum(SNIPPETS).optional().default('dataUri').describe('What to return: dataUri (default), base64, css, html, markdown, or svgUri (SVG only).'),
    mimeType: z.string().optional().describe('Override the detected MIME type (e.g. image/svg+xml).'),
    maxChars: z.number().int().min(100).optional().default(200000).describe('Longest text returned inline; longer results go to a file. Default 200000.'),
    output: outputPath(),
  }),
  outputSchema: z.object({
    text: z.string().optional().describe('The requested snippet (omitted when written to a file).'),
    path: z.string().optional().describe('Text file holding the snippet, when written to a file.'),
    mimeType: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    fileBytes: z.number().describe('Size of the original file.'),
    dataUriLength: z.number().describe('Length of the Base64 data URI in characters.'),
    overheadPercent: z.number().describe('How much bigger the data URI is than the file, in %.'),
    textLength: z.number(),
    warning: z.object({ level: z.enum(['ok', 'warn', 'bad']), text: z.string() }),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/site/icons/logo.png', as: 'css' }, note: 'background-image: url("data:image/png;base64,…");' },
    { input: { image: '/site/icons/arrow.svg', as: 'svgUri' } },
  ],
  async run(input, ctx) {
    const f = await readInput(input.image, ctx, 'image');
    const u8 = new Uint8Array(f.bytes);
    let mime = input.mimeType || f.mimeType || sniff(u8);
    if (mime === 'application/octet-stream') mime = sniff(u8);
    const b64 = bytesToB64(u8);
    const uri = 'data:' + mime + ';base64,' + b64;
    const d = await dims(u8);
    const name = f.path ? f.name : 'image';
    const alt = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    let text: string;
    switch (input.as) {
      case 'base64':
        text = b64;
        break;
      case 'css':
        text = 'background-image: url("' + uri + '");';
        break;
      case 'html':
        text = '<img src="' + uri + '"' + (d.width ? ' width="' + d.width + '" height="' + d.height + '"' : '') + ' alt="' + esc(alt) + '">';
        break;
      case 'markdown':
        text = '![' + alt.replace(/[[\]]/g, '') + '](' + uri + ')';
        break;
      case 'svgUri':
        if (mime !== 'image/svg+xml') throw new ToolError('svgUri works for SVG files only (this is ' + mime + ').');
        text = svgDataUri(new TextDecoder().decode(u8));
        break;
      default:
        text = uri;
    }
    const res: Record<string, unknown> = {
      mimeType: mime,
      ...d,
      fileBytes: u8.length,
      dataUriLength: uri.length,
      overheadPercent: Math.round((uri.length / Math.max(1, u8.length) - 1) * 100),
      textLength: text.length,
      warning: sizeWarning(uri.length),
    };
    if (input.output || text.length > input.maxChars) {
      const out = await writeOutput(text, { output: input.output, defaultName: alt.replace(/\s+/g, '-') + '.base64.txt', mimeType: 'text/plain' }, ctx);
      res.path = out.path;
    } else res.text = text;
    return res;
  },
});

const fromBase64 = defineTool({
  name: 'image_from_base64',
  title: 'Base64 / data URI to image file',
  webSlug: 'image-to-base64',
  description:
    'Decode Base64 back into a file: accepts a data URI, a CSS url("data:…") rule, an <img src="data:…"> tag, URL-encoded SVG data URIs, ' +
    'or raw Base64 (standard or URL-safe, line breaks allowed). Detects the real type from the bytes, warns when it differs from the declared ' +
    `one, and writes decoded.<ext>. Give the text inline or as a path to a text file. Web version: ${webUrl('image-to-base64')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('The data URI / CSS / <img> tag / raw Base64.'),
    path: z.string().optional().describe('Or: a text file containing it.'),
    output: outputPath(),
  }),
  outputSchema: z.object({
    path: z.string(),
    bytes: z.number(),
    mimeType: z.string(),
    declaredMimeType: z.string().optional().describe('Type named in the data URI, if any.'),
    detectedMimeType: z.string().describe('Type detected from the bytes.'),
    isImage: z.boolean(),
    width: z.number().optional(),
    height: z.number().optional(),
    status: z.string().describe('Same message as the website: "Valid image", or a warning.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { text: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }, note: 'Writes decoded.png (1×1).' }],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    const r = parseInput(text);
    if (!r) throw new ToolError('The input is empty.');
    const sniffed = sniff(r.bytes);
    let mime = r.mime;
    if (!r.declared || mime === 'application/octet-stream') mime = sniffed;
    const mismatch = r.declared && sniffed !== 'application/octet-stream' && sniffed !== mime && !(sniffed === 'image/x-icon' && /icon/.test(mime));
    const out = await writeOutput(r.bytes, { output: input.output, defaultName: 'decoded.' + (EXT[mime] || 'bin'), mimeType: mime }, ctx);
    const isImage = /^image\//.test(mime);
    const d = isImage ? await dims(r.bytes) : {};
    const status = !isImage
      ? "Decoded, but it's not an image (" + mime + ')'
      : !d.width && mime !== 'image/x-icon' && mime !== 'image/bmp'
        ? 'Decoded ' + fmtBytes(r.bytes.length) + ", but it can't be read as an image"
        : mismatch
          ? 'Decoded, but the bytes look like ' + sniffed
          : 'Valid image';
    return { ...out, mimeType: mime, ...(r.declared ? { declaredMimeType: r.mime } : {}), detectedMimeType: sniffed, isImage, ...d, status };
  },
});

export default [toBase64, fromBase64];

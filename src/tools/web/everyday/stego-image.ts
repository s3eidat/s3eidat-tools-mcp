import sharp from 'sharp';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, fileOutputShape, outputPath, readInput, returnBase64, withExt, writeOutput } from '../../../util/files.js';
import { concat, deriveKey, gcmDecrypt, gcmEncrypt, randomBytes } from './_aes.js';

// Ported from https://github.com/s3eidat/stego-image (app.js): LSB steganography in the R, G, B channels of a lossless
// PNG, bit-for-bit the website's layout, so images made here reveal on the site and vice versa.
//   hidden bytes: "S3SG" | version 1 | flags (bit0 = encrypted) | length u32 BE | payload, written MSB-first, bit k into
//   the lowest bit of byte (k/3|0)*4 + k%3 of the RGBA pixel array (alpha untouched).
//   encrypted payload: salt 16 | iv 12 | AES-256-GCM ciphertext + tag; AAD = first 6 header bytes; PBKDF2-SHA256 600,000.
const MAGIC = [0x53, 0x33, 0x53, 0x47], VERSION = 1, HEAD = 10, ITER = 600000, SALT = 16, IV = 12, TAG = 16;
const MAX_PIXELS = 50e6;
const te = new TextEncoder(), td = new TextDecoder('utf-8', { fatal: true });

export function capacity(w: number, h: number) { return Math.max(0, Math.floor((w * h * 3) / 8) - HEAD); }
export function overhead(encrypted: boolean) { return encrypted ? SALT + IV + TAG : 0; }
function header(flags: number, len: number) {
  const h = new Uint8Array(HEAD);
  h.set(MAGIC); h[4] = VERSION; h[5] = flags;
  h[6] = (len >>> 24) & 255; h[7] = (len >>> 16) & 255; h[8] = (len >>> 8) & 255; h[9] = len & 255;
  return h;
}
/** text (+ password) → bytes to hide. */
export async function buildPayload(text: string, pw: string, fixed?: { salt: Uint8Array; iv: Uint8Array }) {
  const plain = te.encode(text);
  if (!pw) return concat([header(0, plain.length), plain]);
  const salt = fixed?.salt ?? randomBytes(SALT), iv = fixed?.iv ?? randomBytes(IV);
  const h = header(1, SALT + IV + plain.length + TAG);
  const ct = await gcmEncrypt(await deriveKey(pw, salt, ITER), iv, h.subarray(0, 6), plain);
  return concat([h, salt, iv, ct]);
}
/** Write bytes MSB-first into the lowest bit of R, G, B (alpha untouched). */
export function embed(px: Uint8Array, w: number, h: number, bytes: Uint8Array) {
  if (bytes.length - HEAD > capacity(w, h)) throw new ToolError('The message is too long for this image');
  for (let k = 0, bits = bytes.length * 8; k < bits; k++) {
    const bit = (bytes[k >> 3] >> (7 - (k & 7))) & 1, idx = ((k / 3) | 0) * 4 + (k % 3);
    px[idx] = (px[idx] & 0xfe) | bit;
  }
  return px;
}
function readBytes(px: Uint8Array, start: number, n: number) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) { const k = (start + i) * 8 + b; v = (v << 1) | (px[((k / 3) | 0) * 4 + (k % 3)] & 1); }
    out[i] = v;
  }
  return out;
}
export type Extracted = { flags: number; head: Uint8Array; payload: Uint8Array; error?: undefined } | { error: string };
/** → the hidden record, an { error } for a newer format, or null when no message is present. */
export function extract(px: Uint8Array, w: number, h: number): Extracted | null {
  if (w * h * 3 < HEAD * 8) return null;
  const hd = readBytes(px, 0, HEAD);
  for (let i = 0; i < 4; i++) if (hd[i] !== MAGIC[i]) return null;
  if (hd[4] !== VERSION) return { error: 'This image was made by a newer version of the tool' };
  const len = ((hd[6] << 24) | (hd[7] << 16) | (hd[8] << 8) | hd[9]) >>> 0;
  if (len > capacity(w, h)) return null;
  return { flags: hd[5], head: hd, payload: readBytes(px, HEAD, len) };
}
export async function open(r: { flags: number; head: Uint8Array; payload: Uint8Array }, pw: string): Promise<string> {
  if (!(r.flags & 1)) {
    try { return td.decode(r.payload); } catch { throw new ToolError('The hidden data is damaged'); }
  }
  if (!pw) throw new ToolError('This message is encrypted. Give the password.');
  if (r.payload.length < SALT + IV + TAG) throw new ToolError('The hidden data is damaged');
  const salt = r.payload.slice(0, SALT), iv = r.payload.slice(SALT, SALT + IV), ct = r.payload.slice(SALT + IV);
  let pt: Uint8Array;
  try {
    pt = await gcmDecrypt(await deriveKey(pw, salt, ITER), iv, r.head.subarray(0, 6), ct);
  } catch {
    throw new ToolError('Wrong password, or the image was changed after hiding');
  }
  try { return td.decode(pt); } catch { throw new ToolError('The hidden data is damaged'); }
}

/** Decode any image to exact 8-bit RGBA pixels (no resampling). `flatten` fills transparency with white like the site. */
export async function rgba(bytes: Uint8Array, flatten: boolean) {
  let meta;
  try { meta = await sharp(bytes).metadata(); } catch { throw new ToolError("Couldn't read that image"); }
  if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_PIXELS) throw new ToolError('That image is too large (over 50 megapixels)');
  let img = sharp(bytes, { limitInputPixels: false });
  if (flatten) img = img.flatten({ background: '#ffffff' });
  const { data, info } = await img.ensureAlpha().toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new ToolError("Couldn't read that image as RGBA");
  return { px: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, format: meta.format };
}
function hasAlpha(px: Uint8Array) { for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return true; return false; }
export async function toPng(px: Uint8Array, width: number, height: number) {
  return sharp(Buffer.from(px.buffer, px.byteOffset, px.byteLength), { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
}

export default [
  defineTool({
    name: 'crypto_stego_hide',
    title: 'Hide a message in an image',
    webSlug: 'stego-image',
    description:
      'Hide a text message inside an image (LSB steganography in R, G, B; the picture looks the same) and save it as a ' +
      'lossless PNG, optionally encrypted with a password (AES-256-GCM, PBKDF2-SHA256 600,000). Same bit layout as the ' +
      `website, so the PNG reveals at ${webUrl('stego-image')} or with crypto_stego_reveal. Capacity ≈ width×height×3/8 − 10 ` +
      'bytes (−44 more when encrypted). Transparency is filled with white. The result is read back and checked before ' +
      `returning. Sending it through apps that recompress images (JPEG, chat apps) destroys the message. Web version: ${webUrl('stego-image')}`,
    inputSchema: z.object({
      image: fileInput('cover image (PNG, JPEG, WebP…)'),
      message: z.string().min(1).describe('The text to hide (UTF-8).'),
      password: z.string().optional().describe('Optional password to encrypt the message.'),
      output: outputPath(),
      returnBase64: returnBase64(),
    }),
    outputSchema: z.object({
      ...fileOutputShape, width: z.number(), height: z.number(), capacityBytes: z.number(), usedBytes: z.number(),
      encrypted: z.boolean(), flattened: z.boolean().describe('True if transparency was filled with white.'), verified: z.boolean(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    examples: [{ input: { image: '/path/to/photo.jpg', message: 'Meet at the old library at 7.', password: 'correct horse battery staple' }, note: 'Writes photo-hidden.png' }],
    async run(input, ctx) {
      const f = await readInput(input.image, ctx, 'image');
      let img = await rgba(f.bytes, false), flattened = false;
      if (hasAlpha(img.px)) { img = await rgba(f.bytes, true); flattened = true; }
      const pw = input.password ?? '';
      const cap = capacity(img.width, img.height), used = te.encode(input.message).length + overhead(!!pw);
      if (used > cap) throw new ToolError(`The message is too long for this image: ${used} bytes needed, ${cap} available (${img.width}×${img.height}).`);
      const bytes = await buildPayload(input.message, pw);
      const px = new Uint8Array(img.px);
      embed(px, img.width, img.height, bytes);
      const png = await toPng(px, img.width, img.height);
      // Read our own PNG back the same way a receiver would, and make sure the message survives.
      const back = await rgba(png, false), r = extract(back.px, back.width, back.height);
      if (!r || r.error !== undefined || (await open(r, pw)) !== input.message) throw new ToolError('Verification failed: the message did not read back from the PNG.');
      const stem = (f.path ? f.name : 'image').replace(/\.[^.]+$/, '');
      const w = await writeOutput(png, { output: input.output, defaultName: withExt(stem + '-hidden', '.png'), mimeType: 'image/png', base64: input.returnBase64 }, ctx);
      return { ...w, width: img.width, height: img.height, capacityBytes: cap, usedBytes: used, encrypted: !!pw, flattened, verified: true };
    },
  }),
  defineTool({
    name: 'crypto_stego_reveal',
    title: 'Reveal a hidden message',
    webSlug: 'stego-image',
    description:
      'Read a message hidden in a PNG by the S3eidat Stego Image website or crypto_stego_hide (decrypting it if a password ' +
      'was used). Reports when there is no message, e.g. because the image was recompressed (JPEG), resized or edited. ' +
      `Web version: ${webUrl('stego-image')}`,
    inputSchema: z.object({
      image: fileInput('image with a hidden message (PNG)'),
      password: z.string().optional().describe('Password, if the message is encrypted.'),
    }),
    outputSchema: z.object({
      found: z.boolean(), encrypted: z.boolean().optional(), message: z.string().optional(),
      characters: z.number().optional(), reason: z.string().optional(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    examples: [{ input: { image: '/path/to/photo-hidden.png', password: 'correct horse battery staple' } }],
    async run(input, ctx) {
      const f = await readInput(input.image, ctx, 'image');
      const img = await rgba(f.bytes, false), r = extract(img.px, img.width, img.height);
      if (!r) {
        return {
          found: false,
          reason: img.format === 'jpeg' ? 'No message found. This is a JPEG: JPEG compression destroys hidden data.'
            : 'No hidden message found (or the image was recompressed, resized or edited).',
        };
      }
      if (r.error !== undefined) throw new ToolError(r.error);
      const message = await open(r, input.password ?? '');
      return { found: true, encrypted: !!(r.flags & 1), message, characters: message.length };
    },
  }),
];

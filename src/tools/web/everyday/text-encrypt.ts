import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, readInput, readTextInput, writeOutput } from '../../../util/files.js';
import { deriveKey, gcmDecrypt, gcmEncrypt, randomBytes } from './_aes.js';

// Ported from https://github.com/s3eidat/text-encrypt (app.js). Byte-compatible wire format:
//   "S3E1." + base64( version 1 | kdf 1 (PBKDF2-SHA256) | iterations u32 BE | salt 16 | iv 12 | ciphertext + 16-byte tag )
// The 34 header bytes are the AES-256-GCM additional data. Key = PBKDF2-SHA256(NFC(password), salt, iterations).
export const PREFIX = 'S3E1.';
const VERSION = 1, KDF_PBKDF2_SHA256 = 1;
export const ITER = 600000, MIN_ITER = 100000, MAX_ITER = 10000000;
const SALT_LEN = 16, IV_LEN = 12, HEADER_LEN = 2 + 4 + SALT_LEN + IV_LEN, TAG_LEN = 16;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });

/** Standard base64; the decoder also accepts base64url and stray whitespace (website `fromB64`). */
export function fromB64(str: string) {
  let s = str.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1) throw new Error('not base64');
  while (s.length % 4) s += '=';
  return new Uint8Array(Buffer.from(s, 'base64'));
}
const toB64 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');

export async function encryptText(plain: string, password: string, iterations = ITER, fixed?: { salt: Uint8Array; iv: Uint8Array }) {
  const salt = fixed?.salt ?? randomBytes(SALT_LEN), iv = fixed?.iv ?? randomBytes(IV_LEN);
  const header = new Uint8Array(HEADER_LEN), dv = new DataView(header.buffer);
  header[0] = VERSION; header[1] = KDF_PBKDF2_SHA256; dv.setUint32(2, iterations, false);
  header.set(salt, 6); header.set(iv, 6 + SALT_LEN);
  const ct = await gcmEncrypt(await deriveKey(password, salt, iterations), iv, header, enc.encode(plain));
  const all = new Uint8Array(HEADER_LEN + ct.length);
  all.set(header, 0); all.set(ct, HEADER_LEN);
  return PREFIX + toB64(all);
}

function parse(text: string) {
  const t = String(text).trim();
  if (t.slice(0, 3) === 'S3E' && t.slice(0, PREFIX.length) !== PREFIX) throw new ToolError('This was made by a newer version of Text Encrypt. Open the latest version to decrypt it.');
  if (t.slice(0, PREFIX.length) !== PREFIX) throw new ToolError("This doesn't look like Text Encrypt output (it should start with " + PREFIX + ').');
  let bytes: Uint8Array;
  try { bytes = fromB64(t.slice(PREFIX.length)); } catch { throw new ToolError('The encrypted text is damaged (not valid base64). Make sure you copied all of it.'); }
  if (bytes.length < HEADER_LEN + TAG_LEN) throw new ToolError('The encrypted text is too short. It was probably cut off when copying.');
  if (bytes[0] !== VERSION) throw new ToolError('Unsupported format version ' + bytes[0] + '.');
  if (bytes[1] !== KDF_PBKDF2_SHA256) throw new ToolError('Unsupported key derivation method.');
  const iterations = new DataView(bytes.buffer, bytes.byteOffset).getUint32(2, false);
  if (iterations < MIN_ITER || iterations > MAX_ITER) throw new ToolError('The encrypted text has an invalid header.');
  return {
    header: bytes.subarray(0, HEADER_LEN), iterations,
    salt: bytes.slice(6, 6 + SALT_LEN), iv: bytes.slice(6 + SALT_LEN, HEADER_LEN), ct: bytes.subarray(HEADER_LEN),
  };
}

export async function decryptText(text: string, password: string) {
  const p = parse(text);
  let buf: Uint8Array;
  try {
    buf = await gcmDecrypt(await deriveKey(password, p.salt, p.iterations), p.iv, p.header, p.ct);
  } catch {
    throw new ToolError('Wrong password, or the encrypted text was changed or cut off.');
  }
  try { return { text: dec.decode(buf), iterations: p.iterations }; } catch { throw new ToolError("Decrypted, but the result isn't valid text."); }
}

const password = () => z.string().min(1).describe('The password. Normalised to Unicode NFC first, like the website.');

export default [
  defineTool({
    name: 'crypto_text_encrypt',
    title: 'Encrypt text (AES-256-GCM)',
    webSlug: 'text-encrypt',
    description:
      'Encrypt a message with a password: AES-256-GCM, key from PBKDF2-SHA256 (600,000 rounds, random 16-byte salt, ' +
      '12-byte IV), output as one "S3E1.…" base64 line. Exactly the website\'s format, so the result can be decrypted at ' +
      `${webUrl('text-encrypt')} or with crypto_text_decrypt. Each run gives a different output. Web version: ${webUrl('text-encrypt')}`,
    inputSchema: z.object({
      text: z.string().optional().describe('The message to encrypt.'),
      path: z.string().optional().describe('Or: a UTF-8 text file to encrypt.'),
      password: password(),
      iterations: z.number().int().min(MIN_ITER).max(MAX_ITER).optional().default(ITER).describe('PBKDF2 rounds (website: 600,000).'),
      output: outputPath().describe('Optional: also save the encrypted line to this file (website "Save" gives encrypted.txt).'),
    }),
    outputSchema: z.object({ encrypted: z.string(), bytes: z.number().describe('Plaintext size in UTF-8 bytes.'), path: z.string().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    examples: [{ input: { text: 'Meet at the old library, 7 pm.', password: 'correct horse battery staple' }, note: '→ "S3E1.AQEACSfA…"' }],
    async run(input, ctx) {
      const text = await readTextInput(input.text, input.path, ctx);
      if (!text.trim()) throw new ToolError('Type a message first.');
      const encrypted = await encryptText(text, input.password, input.iterations);
      const out: { encrypted: string; bytes: number; path?: string } = { encrypted, bytes: enc.encode(text).length };
      if (input.output) out.path = (await writeOutput(encrypted + '\n', { output: input.output, defaultName: 'encrypted.txt' }, ctx)).path;
      return out;
    },
  }),
  defineTool({
    name: 'crypto_text_decrypt',
    title: 'Decrypt text (AES-256-GCM)',
    webSlug: 'text-encrypt',
    description:
      'Decrypt an "S3E1.…" message made by the S3eidat Text Encrypt website or crypto_text_encrypt, with its password. ' +
      'Verifies integrity: a wrong password or any change to the text is reported, never garbage output. Accepts base64url ' +
      `and line breaks. Web version: ${webUrl('text-encrypt')}`,
    inputSchema: z.object({
      encrypted: z.string().optional().describe('The encrypted text, starting with S3E1.'),
      path: z.string().optional().describe('Or: a file containing it (e.g. encrypted.txt).'),
      password: password(),
      output: outputPath().describe('Optional: also save the decrypted message to this file.'),
    }),
    outputSchema: z.object({ text: z.string(), iterations: z.number(), path: z.string().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    examples: [{ input: { encrypted: 'S3E1.AQEACSfAtcIyfKiQlnccWg4e2uFxBglGUizyF0IsTYNU0kSqKpIDX4xsscpbHaTSv0AGmLwAcP3l341prQNNoeukuzER22r7', password: 's3eidat' }, output: { text: 'Hello, \u0645\u0631\u062d\u0628\u0627 \ud83d\udc4b', iterations: 600000 } }],
    async run(input, ctx) {
      let data = input.encrypted;
      if (data == null && input.path) data = (await readInput(input.path, ctx, 'path')).bytes.toString('utf8');
      if (data == null || !data.trim()) throw new ToolError('Paste the encrypted text first (or give a path).');
      const r = await decryptText(data, input.password);
      const out: { text: string; iterations: number; path?: string } = { ...r };
      if (input.output) out.path = (await writeOutput(r.text, { output: input.output, defaultName: 'decrypted.txt' }, ctx)).path;
      return out;
    },
  }),
];

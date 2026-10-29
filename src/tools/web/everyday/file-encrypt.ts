import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, fileOutputShape, outputPath, readInput, returnBase64, writeOutput } from '../../../util/files.js';
import { deriveKey, gcmDecrypt, gcmEncrypt, randomBytes, type Bytes } from './_aes.js';

// Ported from https://github.com/s3eidat/file-encrypt (app.js). Byte-compatible "S3EF" v1 (.s3enc) format:
//   header (40 B): "S3EF" | version 1 | kdf 1 | reserved 0x0000 | iterations u32 | chunkSize u32 | salt 16 | noncePrefix 8
//   records: [u32 length][AES-256-GCM ciphertext+tag] … record 0 = JSON metadata {name,size,type,modified}, then data chunks
//   record i: IV = noncePrefix ‖ u32(i); AAD = header ‖ u32(i) ‖ u8(isLastRecord). All integers big-endian.
// Key = PBKDF2-SHA256(NFC(password), salt, iterations). Reordering, dropping, truncating or extending is detected.
const MAGIC = [0x53, 0x33, 0x45, 0x46], VERSION = 1, KDF = 1, HEADER_LEN = 40, TAG = 16;
export const ITER = 600000, MIN_ITER = 100000, MAX_ITER = 10000000;
export const CHUNK = 4 * 1024 * 1024, MIN_CHUNK = 1024, MAX_CHUNK = 64 * 1024 * 1024;
const MAX_META = 65536;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });

function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; }
function readU32(b: Uint8Array, at = 0) { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, false); }
function ivFor(prefix: Uint8Array, i: number) { const iv = new Uint8Array(12); iv.set(prefix, 0); iv.set(u32(i), 8); return iv; }
function aadFor(header: Uint8Array, i: number, last: boolean) { const a = new Uint8Array(HEADER_LEN + 5); a.set(header, 0); a.set(u32(i), HEADER_LEN); a[HEADER_LEN + 4] = last ? 1 : 0; return a; }
export function safeName(n: string) {
  n = String(n || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200);
  return n || 'decrypted-file';
}
function safeType(t: string) { return /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/.test(t || '') ? t : 'application/octet-stream'; }
export function isS3ef(head: Uint8Array) { return head.length >= 4 && MAGIC.every((m, i) => head[i] === m); }

// What a browser would put in File.type for common extensions ("" when it doesn't know).
const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.xml': 'text/xml', '.md': 'text/markdown', '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface EncryptOpts { chunkSize?: number; iterations?: number; type?: string; modified?: number; fixed?: { salt: Uint8Array; prefix: Uint8Array } }

export async function encryptBytes(data: Uint8Array, name: string, password: string, opts: EncryptOpts = {}): Promise<Bytes> {
  const chunk = opts.chunkSize || CHUNK, iterations = opts.iterations || ITER;
  const nData = Math.ceil(data.length / chunk);
  if (nData + 1 > 0xffffffff) throw new ToolError('This file is too large for the format.');
  const salt = opts.fixed?.salt ?? randomBytes(16), prefix = opts.fixed?.prefix ?? randomBytes(8), header = new Uint8Array(HEADER_LEN);
  header.set(MAGIC, 0); header[4] = VERSION; header[5] = KDF; // bytes 6-7 reserved = 0
  header.set(u32(iterations), 8); header.set(u32(chunk), 12); header.set(salt, 16); header.set(prefix, 32);
  const key = await deriveKey(password, salt, iterations);
  const parts: Uint8Array[] = [header];
  const seal = async (i: number, plain: Uint8Array, last: boolean) => {
    const ct = await gcmEncrypt(key, ivFor(prefix, i), aadFor(header, i, last), plain);
    parts.push(u32(ct.length), ct);
  };
  const meta = enc.encode(JSON.stringify({ name: String(name || 'file'), size: data.length, type: opts.type || '', modified: opts.modified || 0 }));
  if (meta.length > MAX_META) throw new ToolError('The file name is too long.');
  await seal(0, meta, nData === 0);
  for (let k = 1; k <= nData; k++) await seal(k, data.subarray((k - 1) * chunk, Math.min(k * chunk, data.length)), k === nData);
  return new Uint8Array(Buffer.concat(parts));
}

export async function decryptBytes(blob: Uint8Array, password: string) {
  if (blob.length < HEADER_LEN) throw new ToolError("This isn't an encrypted .s3enc file (it's too small).");
  const header = blob.slice(0, HEADER_LEN);
  if (!isS3ef(header)) throw new ToolError("This isn't a File Encrypt (.s3enc) file.");
  if (header[4] !== VERSION) throw new ToolError('This file uses format version ' + header[4] + '. Open the latest File Encrypt to decrypt it.');
  if (header[5] !== KDF || header[6] || header[7]) throw new ToolError('Unsupported or damaged file header.');
  const iterations = readU32(header, 8), chunk = readU32(header, 12);
  if (iterations < MIN_ITER || iterations > MAX_ITER || chunk < MIN_CHUNK || chunk > MAX_CHUNK) throw new ToolError('The file header is damaged.');
  const key = await deriveKey(password, header.slice(16, 32), iterations), prefix = header.slice(32, 40);
  let off = HEADER_LEN, i = 0, expected = 0, written = 0;
  let meta: { name?: unknown; size: number; type?: unknown; modified?: unknown } | null = null;
  const out: Uint8Array[] = [];
  for (;;) {
    if (off + 4 > blob.length) throw new ToolError('The file is incomplete: it was cut off.');
    const len = readU32(blob, off);
    if (len < TAG || len > (i === 0 ? MAX_META : chunk) + TAG) throw new ToolError('The file is damaged (bad chunk ' + i + ').');
    const end = off + 4 + len;
    if (end > blob.length) throw new ToolError('The file is incomplete: it was cut off.');
    const last = end === blob.length;
    let plain: Uint8Array;
    try {
      plain = await gcmDecrypt(key, ivFor(prefix, i), aadFor(header, i, last), blob.subarray(off + 4, end));
    } catch {
      if (i === 0) throw new ToolError('Wrong password, or the file is damaged.');
      if (last) throw new ToolError('The file is incomplete or was changed (chunk ' + i + ' failed its integrity check).');
      throw new ToolError('The file was changed or reordered (chunk ' + i + ' failed its integrity check).');
    }
    if (i === 0) {
      try { meta = JSON.parse(dec.decode(plain)); } catch { throw new ToolError("The file's metadata is damaged."); }
      if (!meta || typeof meta.size !== 'number' || meta.size < 0 || meta.size !== Math.floor(meta.size)) throw new ToolError("The file's metadata is damaged.");
      expected = Math.ceil(meta.size / chunk);
      if (last && expected) throw new ToolError('The file is incomplete: it was cut off.');
    } else {
      const want = i < expected ? chunk : meta!.size - (expected - 1) * chunk;
      if (i > expected || plain.length !== want) throw new ToolError('The file is damaged (chunk ' + i + ' has the wrong size).');
      if (last !== (i === expected)) throw new ToolError('The file is incomplete: it was cut off.');
      out.push(plain);
      written += plain.length;
    }
    off = end;
    i++;
    if (last) break;
  }
  if (written !== meta!.size) throw new ToolError('The file is incomplete: it was cut off.');
  const modified = typeof meta!.modified === 'number' ? meta!.modified : 0;
  return { bytes: Buffer.concat(out), name: safeName(String(meta!.name ?? '')), type: safeType(String(meta!.type ?? '')), size: meta!.size, modified, iterations, chunkSize: chunk };
}

const password = () => z.string().min(1).describe('The password. Normalised to Unicode NFC first, like the website.');

export default [
  defineTool({
    name: 'crypto_file_encrypt',
    title: 'Encrypt a file (.s3enc)',
    webSlug: 'file-encrypt',
    description:
      'Encrypt any file with a password into the website\'s .s3enc format: chunked AES-256-GCM, key from PBKDF2-SHA256 ' +
      '(600,000 rounds, random salt), original name/type/size stored encrypted inside, tamper/truncation/reorder-proof. ' +
      `Files made here open at ${webUrl('file-encrypt')} and vice versa (crypto_file_decrypt). Whole file is processed in ` +
      `memory (size limit = server --max-mb). Web version: ${webUrl('file-encrypt')}`,
    inputSchema: z.object({
      file: fileInput('file to encrypt'),
      password: password(),
      name: z.string().max(1000).optional().describe('File name to store inside (restored on decrypt). Default: the input file name.'),
      mimeType: z.string().optional().describe('MIME type to store. Default: guessed from the extension like a browser would ("" if unknown).'),
      chunkSize: z.number().int().min(MIN_CHUNK).max(MAX_CHUNK).optional().default(CHUNK).describe('Chunk size in bytes (website: 4 MiB).'),
      iterations: z.number().int().min(MIN_ITER).max(MAX_ITER).optional().default(ITER).describe('PBKDF2 rounds (website: 600,000).'),
      output: outputPath(),
      returnBase64: returnBase64(),
    }),
    outputSchema: z.object({ ...fileOutputShape, storedName: z.string(), originalBytes: z.number(), chunks: z.number() }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    examples: [{ input: { file: '/path/to/report.pdf', password: 'correct horse battery staple' }, note: 'Writes report.pdf.s3enc' }],
    async run(input, ctx) {
      const f = await readInput(input.file, ctx, 'file');
      const name = input.name ?? f.name;
      let modified = 0;
      if (f.path) modified = Math.floor((await stat(f.path)).mtimeMs);
      const type = input.mimeType ?? f.mimeType ?? MIME[extname(name).toLowerCase()] ?? '';
      const out = await encryptBytes(f.bytes, name, input.password, { chunkSize: input.chunkSize, iterations: input.iterations, type, modified });
      const w = await writeOutput(out, { output: input.output, defaultName: name + '.s3enc', mimeType: 'application/octet-stream', base64: input.returnBase64 }, ctx);
      return { ...w, storedName: name, originalBytes: f.bytes.length, chunks: Math.ceil(f.bytes.length / input.chunkSize) };
    },
  }),
  defineTool({
    name: 'crypto_file_decrypt',
    title: 'Decrypt a file (.s3enc)',
    webSlug: 'file-encrypt',
    description:
      'Decrypt an .s3enc file made by the S3eidat File Encrypt website or crypto_file_encrypt, verify every chunk, and ' +
      'write the original file back under its stored (sanitised) name. A wrong password, damage, truncation or reordering ' +
      `is reported and nothing is written. Web version: ${webUrl('file-encrypt')}`,
    inputSchema: z.object({
      file: fileInput('.s3enc file'),
      password: password(),
      output: outputPath().describe('Where to write the decrypted file: a file path, or a folder ending in "/" (keeps the stored name). Default: the server output folder.'),
      returnBase64: returnBase64(),
    }),
    outputSchema: z.object({ ...fileOutputShape, name: z.string(), type: z.string(), modified: z.string().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    examples: [{ input: { file: '/path/to/report.pdf.s3enc', password: 'correct horse battery staple' }, note: 'Writes report.pdf' }],
    async run(input, ctx) {
      const f = await readInput(input.file, ctx, 'file');
      const r = await decryptBytes(f.bytes, input.password);
      const w = await writeOutput(r.bytes, { output: input.output, defaultName: r.name, mimeType: r.type, base64: input.returnBase64 }, ctx);
      return { ...w, name: r.name, type: r.type, ...(r.modified > 0 && r.modified < 8.64e15 ? { modified: new Date(r.modified).toISOString() } : {}) };
    },
  }),
];

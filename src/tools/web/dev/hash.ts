import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { readInput } from '../../../util/files.js';

// Same algorithms and compare logic as https://github.com/s3eidat/hash-lab (app.js).
const ALGS = ['MD5', 'SHA-1', 'SHA-256', 'SHA-512'] as const;
const NODE: Record<string, string> = { MD5: 'md5', 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };

/** Normalises "SHA256 (file) = ABC…", "ab:cd:ef", spaces, and Base64 (same as the website). */
export function cleanExpected(s: string): { hex?: string; b64?: string } {
  s = String(s).trim();
  const m = /([A-Fa-f0-9:\s]{32,})$/.exec(s);
  const hx = (m ? m[1] : s).replace(/[\s:]/g, '');
  if (/^[A-Fa-f0-9]+$/.test(hx) && hx.length % 2 === 0) return { hex: hx.toLowerCase() };
  return { b64: s.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') };
}

function fmt(b: Buffer, f: 'hex' | 'HEX' | 'base64') {
  return f === 'base64' ? b.toString('base64') : f === 'HEX' ? b.toString('hex').toUpperCase() : b.toString('hex');
}

/** Which result (if any) matches an expected checksum. */
export function findMatch(expected: string, results: { name: string; bytes: Buffer }[]) {
  const e = cleanExpected(expected);
  for (const r of results) {
    if (e.hex && r.bytes.toString('hex') === e.hex) return r.name;
    if (e.b64 && r.bytes.toString('base64').replace(/=+$/, '') === e.b64) return r.name;
  }
  return null;
}

export function hashAll(bytes: Buffer, key?: string, hmacAlg = 'SHA-256') {
  const out = ALGS.map((a) => ({ name: a as string, bytes: createHash(NODE[a]).update(bytes).digest() }));
  if (key) out.push({ name: 'HMAC-' + hmacAlg.replace('-', ''), bytes: createHmac(NODE[hmacAlg], key).update(bytes).digest() });
  return out;
}

export default defineTool({
  name: 'hash_compute',
  title: 'Hash (MD5 / SHA)',
  webSlug: 'hash-lab',
  description:
    'Compute MD5, SHA-1, SHA-256 and SHA-512 of text or a file (path or base64), optionally an HMAC with a key, and check ' +
    'against an expected checksum (hex in any case/spacing, "SHA256 (file) = …" lines, or base64). ' +
    `Web version: ${webUrl('hash-lab')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('Text to hash (UTF-8).'),
    file: z.string().optional().describe('Or: a file to hash: local path or base64.'),
    hmacKey: z.string().optional().describe('If set, also compute HMAC with this key.'),
    hmacAlgorithm: z.enum(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']).optional().default('SHA-256'),
    format: z.enum(['hex', 'HEX', 'base64']).optional().default('hex').describe('Output encoding.'),
    expected: z.string().optional().describe('A checksum to compare against; the result says which algorithm matched.'),
  }),
  outputSchema: z.object({
    bytes: z.number(),
    hashes: z.record(z.string(), z.string()),
    match: z.string().nullable().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { text: 'abc' }, note: 'SHA-256 = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }],
  async run(input, ctx) {
    let bytes: Buffer;
    if (input.text != null) bytes = Buffer.from(input.text, 'utf8');
    else if (input.file) bytes = (await readInput(input.file, ctx, 'file')).bytes;
    else throw new ToolError('Give "text" or "file".');
    const res = hashAll(bytes, input.hmacKey, input.hmacAlgorithm);
    const hashes: Record<string, string> = {};
    for (const r of res) hashes[r.name] = fmt(r.bytes, input.format);
    const out: { bytes: number; hashes: Record<string, string>; match?: string | null } = { bytes: bytes.length, hashes };
    if (input.expected) out.match = findMatch(input.expected, res);
    return out;
  },
});

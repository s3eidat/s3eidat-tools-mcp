import { randomFillSync, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/uuid-forge (app.js): UUID v4, v7 (12-bit counter, strictly ordered in bulk),
// monotonic ULID, unbiased NanoID, and the same UUID/ULID inspector.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ALPHA: Record<string, string> = {
  'A-Za-z0-9_-': 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict', // nanoid's default URL-safe set
  'A-Za-z0-9': '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  '0-9a-f': '0123456789abcdef',
  '0-9': '0123456789',
  nolook: '346789ABCDEFGHJKLMNPQRTUVWXYabcdefghijkmnpqrtwxyz',
};

function rnd(n: number) {
  return randomFillSync(new Uint8Array(n));
}
function hexOf(b: Uint8Array) {
  return Buffer.from(b).toString('hex');
}
function dash(h: string) {
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

export function uuid4() {
  return randomUUID();
}

// UUID v7 with a 12-bit counter in rand_a (RFC 9562 §6.2 method 1) so bulk output is strictly ordered.
const v7s = { ms: -1, seq: 0 };
export function uuid7(nowMs?: number) {
  let ms = nowMs == null ? Date.now() : nowMs;
  if (ms <= v7s.ms) {
    v7s.seq++;
    ms = v7s.ms;
    if (v7s.seq > 0xfff) {
      ms = ++v7s.ms;
      v7s.seq = 0;
    }
  } else {
    v7s.ms = ms;
    v7s.seq = rnd(2)[0] & 0x7f; // start low so a burst rarely overflows
  }
  const b = rnd(16);
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = 0x70 | ((v7s.seq >> 8) & 0x0f);
  b[7] = v7s.seq & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  return dash(hexOf(b));
}

// ULID, monotonic within the same millisecond (spec: increment the random part).
const us: { ms: number; r: number[] | null } = { ms: -1, r: null };
export function ulid(nowMs?: number) {
  let ms = nowMs == null ? Date.now() : nowMs;
  if (ms <= us.ms && us.r) {
    ms = us.ms;
    for (let i = 15; i >= 0; i--) {
      if (us.r[i] < 31) {
        us.r[i]++;
        break;
      }
      us.r[i] = 0;
    }
  } else {
    us.ms = ms;
    us.r = Array.from(rnd(16), (x) => x & 31);
  }
  let t = '', m = ms;
  for (let k = 0; k < 10; k++) {
    t = CROCKFORD[m % 32] + t;
    m = Math.floor(m / 32);
  }
  return t + us.r!.map((x) => CROCKFORD[x]).join('');
}

/** Unbiased NanoID: rejection sampling against the largest multiple of the alphabet size. */
export function nanoid(len: number, alphabet: string) {
  const chars = Array.from(alphabet), n = chars.length, lim = 256 - (256 % n);
  let out = '', got = 0;
  while (got < len) {
    const b = rnd(len * 2);
    for (let i = 0; i < b.length && got < len; i++)
      if (b[i] < lim) {
        out += chars[b[i] % n];
        got++;
      }
  }
  return out;
}

export interface Inspection {
  ok: boolean;
  kind?: string;
  version?: number;
  variant?: string;
  canonical?: string;
  createdAt?: string;
  ms?: number | null;
  rows?: [string, string][];
}
export function inspect(input: string): Inspection {
  const s = String(input).trim();
  if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(s)) {
    let t = 0;
    for (let i = 0; i < 10; i++) t = t * 32 + CROCKFORD.indexOf(s[i].toUpperCase());
    return {
      kind: 'ULID', ok: true, ms: t, createdAt: new Date(t).toISOString(), canonical: s.toUpperCase(),
      rows: [['Type', 'ULID'], ['Created', new Date(t).toISOString()], ['Timestamp (ms)', String(t)], ['Random part', s.slice(10).toUpperCase()]],
    };
  }
  let h = s.replace(/^urn:uuid:/i, '').replace(/^\{|\}$/g, '');
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(h)) return { ok: false };
  h = h.replace(/-/g, '').toLowerCase();
  if (h === '00000000000000000000000000000000') return { ok: true, kind: 'Nil UUID', version: 0, canonical: dash(h), rows: [['Type', 'Nil UUID (all zeros)']] };
  if (h === 'ffffffffffffffffffffffffffffffff') return { ok: true, kind: 'Max UUID', version: 15, canonical: dash(h), rows: [['Type', 'Max UUID (all ones)']] };
  const ver = parseInt(h[12], 16), vn = parseInt(h[16], 16);
  const variant = vn < 8 ? 'NCS (reserved)' : vn < 12 ? 'RFC 9562 / 4122' : vn < 14 ? 'Microsoft (reserved)' : 'Future (reserved)';
  const names: Record<number, string> = { 1: 'time-based (MAC)', 2: 'DCE security', 3: 'name-based MD5', 4: 'random', 5: 'name-based SHA-1', 6: 'reordered time', 7: 'Unix-time ordered', 8: 'custom' };
  const rows: [string, string][] = [['Type', 'UUID version ' + ver + (names[ver] ? ' — ' + names[ver] : ' (unknown)')], ['Variant', variant], ['Canonical', dash(h)]];
  let ms: number | null = null;
  if (ver === 7) ms = parseInt(h.slice(0, 12), 16);
  if (ver === 1 || ver === 6) {
    const ts = ver === 1 ? BigInt('0x' + h.slice(13, 16) + h.slice(8, 12) + h.slice(0, 8)) : BigInt('0x' + h.slice(0, 12) + h.slice(13, 16));
    ms = Number((ts - 122192928000000000n) / 10000n);
  }
  const out: Inspection = { ok: true, kind: 'UUID', version: ver, variant, canonical: dash(h), rows, ms };
  if (ms != null) {
    out.createdAt = new Date(ms).toISOString();
    rows.push(['Created', out.createdAt], ['Timestamp (ms)', String(ms)]);
  }
  return out;
}

const generate = defineTool({
  name: 'id_generate',
  title: 'Generate IDs (UUID / ULID / NanoID)',
  webSlug: 'uuid-forge',
  description:
    'Generate 1–1000 unique IDs with a cryptographic RNG: UUID v4 (random), UUID v7 (time-ordered, RFC 9562, strictly ' +
    'increasing within a batch), ULID (26 Crockford Base32 chars, monotonic) or NanoID (custom length 2–128 and alphabet: ' +
    'URL-safe default, alphanumeric, hex, digits, no look-alikes, or your own). Options: uppercase, no dashes. ' +
    `Web version: ${webUrl('uuid-forge')}`,
  inputSchema: z.object({
    kind: z.enum(['v4', 'v7', 'ulid', 'nanoid']).optional().default('v4').describe('Which ID type.'),
    count: z.number().int().min(1).max(1000).optional().default(1).describe('How many IDs (1–1000).'),
    uppercase: z.boolean().optional().default(false).describe('Upper-case output (UUID hex digits, ULID letters). Default false = lower case, like the website.'),
    noDashes: z.boolean().optional().default(false).describe('UUIDs only: drop the dashes (32 hex chars).'),
    length: z.number().int().min(2).max(128).optional().default(21).describe('NanoID length (2–128). 21 URL-safe chars ≈ UUID v4 collision safety.'),
    alphabet: z
      .string()
      .optional()
      .default('A-Za-z0-9_-')
      .describe('NanoID alphabet: a preset ("A-Za-z0-9_-", "A-Za-z0-9", "0-9a-f", "0-9", "nolook") or your own characters (2–256 distinct; duplicates ignored).'),
  }),
  outputSchema: z.object({ ids: z.array(z.string()), kind: z.string(), bitsOfRandomness: z.number().optional() }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  examples: [
    { input: { kind: 'v7', count: 3 }, note: 'Three time-ordered UUIDs, e.g. 019a2f3c-8d41-7a0b-9c2e-5f1d3b7a4c10' },
    { input: { kind: 'nanoid', length: 12, alphabet: 'nolook' } },
  ],
  run(input) {
    const k = input.kind;
    let alpha = '';
    if (k === 'nanoid') {
      alpha = Array.from(new Set(Array.from(ALPHA[input.alphabet] ?? input.alphabet))).join('');
      const n = Array.from(alpha).length;
      if (n < 2) throw new ToolError('The alphabet needs at least 2 different characters');
      if (n > 256) throw new ToolError('Use 256 characters or fewer');
    }
    const one = () => {
      if (k === 'nanoid') return nanoid(input.length, alpha);
      let id = k === 'v4' ? uuid4() : k === 'v7' ? uuid7() : ulid();
      if (k !== 'ulid' && input.noDashes) id = id.replace(/-/g, '');
      if (k === 'ulid') return input.uppercase ? id : id.toLowerCase();
      return input.uppercase ? id.toUpperCase() : id;
    };
    const ids = Array.from({ length: input.count }, one);
    const out: { ids: string[]; kind: string; bitsOfRandomness?: number } = { ids, kind: k };
    if (k === 'nanoid') out.bitsOfRandomness = Math.floor(input.length * Math.log2(Array.from(alpha).length));
    return out;
  },
});

const inspectTool = defineTool({
  name: 'id_inspect',
  title: 'Inspect a UUID / ULID',
  webSlug: 'uuid-forge',
  description:
    'Check whether a string is a valid UUID (any version; braces, urn:uuid: and missing dashes accepted) or ULID, and report ' +
    'its version, variant and canonical form. For UUID v1, v6, v7 and ULID also returns the embedded creation time. ' +
    `Web version: ${webUrl('uuid-forge')}`,
  inputSchema: z.object({ id: z.string().describe('The UUID or ULID to inspect.') }),
  outputSchema: z.object({
    valid: z.boolean(),
    kind: z.string().optional(),
    version: z.number().optional(),
    variant: z.string().optional(),
    canonical: z.string().optional(),
    createdAt: z.string().optional(),
    timestampMs: z.number().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { id: '017F22E2-79B0-7CC3-98C4-DC0C0C07398F' }, output: { valid: true, kind: 'UUID', version: 7, variant: 'RFC 9562 / 4122', canonical: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f', createdAt: '2022-02-22T19:22:22.000Z', timestampMs: 1645557742000 } }],
  run(input) {
    const r = inspect(input.id);
    if (!r.ok) return { valid: false };
    return JSON.parse(
      JSON.stringify({ valid: true, kind: r.kind, version: r.version, variant: r.variant, canonical: r.canonical, createdAt: r.createdAt, timestampMs: r.ms ?? undefined }),
    );
  },
});

export default [generate, inspectTool];

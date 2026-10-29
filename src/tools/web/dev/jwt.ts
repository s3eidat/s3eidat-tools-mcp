import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/jwt-inspector (app.js): Base64URL + JSON decode, the same validity rules
// and relative-time wording, and HMAC (HS256/384/512) signature verification. Other algorithms are not verified.
const HS: Record<string, string> = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
const CLAIMS: Record<string, string> = {
  iss: 'Issuer', sub: 'Subject', aud: 'Audience', jti: 'Token ID', azp: 'Authorized party', scope: 'Scope',
  nonce: 'Nonce', sid: 'Session ID', email: 'Email', name: 'Name', roles: 'Roles', typ: 'Type',
};
const TIMES: [string, string][] = [['iat', 'Issued at'], ['nbf', 'Not before'], ['exp', 'Expires'], ['auth_time', 'Authenticated at']];

export function b64urlToBytes(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('not Base64URL');
  s = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length % 4 === 1) throw new Error('bad Base64URL length');
  return Buffer.from(s, 'base64');
}
export function bytesToB64url(b: Uint8Array) {
  return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function partJSON(seg: string, label: string): Record<string, unknown> {
  let txt: string;
  try {
    txt = new TextDecoder('utf-8', { fatal: true }).decode(b64urlToBytes(seg));
  } catch {
    throw new ToolError(label + ' is not valid Base64URL');
  }
  try {
    return JSON.parse(txt);
  } catch {
    throw new ToolError(label + ' is not valid JSON');
  }
}
export interface Decoded {
  raw: string;
  parts: string[];
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}
export function decode(token: string): Decoded {
  const t = String(token).trim().replace(/^Bearer\s+/i, '').replace(/\s+/g, '');
  const parts = t.split('.');
  if (parts.length === 5) throw new ToolError('This is an encrypted JWE (5 parts). Its payload can only be read with the decryption key');
  if (parts.length !== 3) throw new ToolError('A JWT has 3 parts separated by dots — found ' + parts.length);
  return { raw: t, parts, header: partJSON(parts[0], 'Header'), payload: partJSON(parts[1], 'Payload') };
}
function keyBytes(secret: string, isB64: boolean): Buffer {
  if (!isB64) return Buffer.from(secret, 'utf8');
  try {
    return b64urlToBytes(secret.trim().replace(/\+/g, '-').replace(/\//g, '_'));
  } catch {
    throw new ToolError('Secret is not valid Base64');
  }
}
export function hsSign(alg: string, key: Uint8Array, data: string) {
  return bytesToB64url(createHmac(HS[alg], key).update(data, 'utf8').digest());
}
/** true/false for HS* tokens, null when the algorithm can't be verified with a shared secret. */
export function verify(dec: Decoded, secret: string, isB64: boolean): boolean | null {
  const alg = String(dec.header.alg);
  if (!HS[alg]) return null;
  return hsSign(alg, keyBytes(secret, isB64), dec.parts[0] + '.' + dec.parts[1]) === dec.parts[2];
}
export function makeToken(header: Record<string, unknown>, payload: Record<string, unknown>, secret: string) {
  const enc = (o: unknown) => bytesToB64url(Buffer.from(JSON.stringify(o), 'utf8'));
  const data = enc(header) + '.' + enc(payload);
  return data + '.' + hsSign(String(header.alg), Buffer.from(secret, 'utf8'), data);
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function rel(sec: number, nowSec: number): string {
  const d = sec - nowSec, a = Math.abs(d);
  const U: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  for (let i = 0; i < U.length; i++) if (a >= U[i][1] || i === U.length - 1) return rtf.format(Math.round(d / U[i][1]), U[i][0]);
  return '';
}
/** Times are seconds since epoch (RFC 7519 NumericDate). */
export function validity(p: Record<string, unknown>, nowSec: number): { cls: 'ok' | 'warn' | 'bad'; text: string } {
  const exp = p.exp, nbf = p.nbf;
  if (typeof exp === 'number' && exp <= nowSec) return { cls: 'bad', text: 'Expired ' + rel(exp, nowSec) };
  if (typeof nbf === 'number' && nbf > nowSec) return { cls: 'warn', text: 'Not valid yet — starts ' + rel(nbf, nowSec) };
  if (typeof exp === 'number') return { cls: 'ok', text: 'Valid · expires ' + rel(exp, nowSec) };
  return { cls: 'warn', text: 'No expiry (exp) claim' };
}

export default defineTool({
  name: 'jwt_decode',
  title: 'JWT decode',
  webSlug: 'jwt-inspector',
  description:
    'Decode a JSON Web Token (a leading "Bearer " is fine): header, payload, iat/nbf/exp/auth_time as ISO dates with relative ' +
    'time, expired / not-yet-valid status, and named standard claims. If "secret" is given, verifies HS256/HS384/HS512 ' +
    'signatures (secret as text or Base64URL). RS/ES/PS tokens are decoded but not verified (needs a public key). ' +
    `Encrypted JWE tokens can't be read. Web version: ${webUrl('jwt-inspector')}`,
  inputSchema: z.object({
    token: z.string().describe('The JWT (header.payload.signature).'),
    secret: z.string().optional().describe('HMAC secret to verify an HS256/384/512 signature.'),
    secretIsBase64: z.boolean().optional().default(false).describe('The secret is Base64/Base64URL-encoded bytes, not text.'),
    now: z.number().optional().describe('Unix time in seconds to judge expiry against. Default: now.'),
  }),
  outputSchema: z.object({
    header: z.record(z.string(), z.unknown()),
    payload: z.record(z.string(), z.unknown()),
    algorithm: z.string(),
    unsigned: z.boolean(),
    status: z.enum(['ok', 'warn', 'bad']),
    statusText: z.string(),
    expired: z.boolean(),
    times: z.array(z.object({ claim: z.string(), label: z.string(), value: z.unknown(), iso: z.string().optional(), relative: z.string().optional(), note: z.string().optional() })),
    claims: z.array(z.object({ claim: z.string(), label: z.string(), value: z.string() })),
    signature: z.object({ verified: z.boolean().nullable(), message: z.string() }),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        secret: 'your-256-bit-secret',
      },
      note: 'payload.name = "John Doe", signature.verified = true, status "No expiry (exp) claim"',
    },
  ],
  run(input) {
    const d = decode(input.token);
    const now = input.now ?? Date.now() / 1000;
    const p = d.payload;
    const alg = String(d.header.alg ?? '?');
    const times = TIMES.filter(([k]) => k in p).map(([k, label]) => {
      const n = p[k];
      if (typeof n !== 'number') return { claim: k, label, value: n, note: 'Not a number — should be seconds since 1970' };
      const ok = Math.abs(n * 1000) <= 8.64e15;
      return {
        claim: k, label, value: n,
        iso: ok ? new Date(n * 1000).toISOString() : undefined,
        relative: rel(n, now),
        note: n > 1e11 ? 'Looks like milliseconds; JWT times are in seconds' : undefined,
      };
    });
    const claims = Object.keys(p).filter((k) => CLAIMS[k]).map((k) => ({ claim: k, label: CLAIMS[k], value: typeof p[k] === 'string' ? (p[k] as string) : JSON.stringify(p[k]) }));
    const v = validity(p, now);
    let signature: { verified: boolean | null; message: string };
    if (!HS[alg]) signature = { verified: null, message: alg.toLowerCase() === 'none' ? 'No signature to verify' : alg + ' needs a public key — not verified here' };
    else if (!input.secret) signature = { verified: null, message: 'Give "secret" to verify' };
    else {
      const ok = verify(d, input.secret, input.secretIsBase64);
      signature = { verified: ok, message: ok ? 'Signature verified' : 'Invalid signature' };
    }
    return {
      header: d.header, payload: p, algorithm: alg, unsigned: alg.toLowerCase() === 'none',
      status: v.cls, statusText: v.text, expired: typeof p.exp === 'number' && p.exp <= now,
      times: JSON.parse(JSON.stringify(times)), claims, signature,
    };
  },
});

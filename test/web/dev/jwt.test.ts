import { describe, expect, it } from 'vitest';
import tool, { decode, makeToken, rel, validity, verify } from '../../../src/tools/web/dev/jwt.js';
import { call } from '../../helpers.js';

const SAMPLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('jwt-inspector self-test', () => {
  it('decodes and verifies', () => {
    const d = decode('Bearer ' + SAMPLE);
    expect([d.header.alg, d.payload.name, d.payload.iat]).toEqual(['HS256', 'John Doe', 1516239022]);
    expect(verify(d, 'your-256-bit-secret', false)).toBe(true);
    expect(verify(d, 'wrong', false)).toBe(false);
    // RFC 7515 A.1: HS256 with a Base64URL key
    const rfc = decode(
      'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
    expect(verify(rfc, 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow', true)).toBe(true);
    expect(rfc.payload.exp).toBe(1300819380);
    const t = makeToken({ alg: 'HS512' }, { a: 'مرحبا' }, 'k');
    expect(verify(decode(t), 'k', false)).toBe(true);
    expect(decode(t).payload.a).toBe('مرحبا');
  });
  it('validity, relative time, errors', () => {
    expect(validity({ exp: 100 }, 200).cls).toBe('bad');
    expect(validity({ nbf: 300, exp: 400 }, 200).cls).toBe('warn');
    expect(validity({ exp: 400 }, 200).cls).toBe('ok');
    expect(rel(200 - 3 * 3600, 200)).toBe('3 hours ago');
    expect(rel(200 + 120, 200)).toBe('in 2 minutes');
    expect(() => decode('a.b')).toThrow();
    expect(() => decode('a.b.c.d.e')).toThrow(/JWE/);
  });
});

describe('jwt_decode tool', () => {
  it('runs', async () => {
    const r = await call<Record<string, any>>(tool, { token: SAMPLE, secret: 'your-256-bit-secret', now: 1516239022 + 7200 });
    expect(r.signature.verified).toBe(true);
    expect(r.statusText).toBe('No expiry (exp) claim');
    expect(r.times[0]).toMatchObject({ claim: 'iat', iso: '2018-01-18T01:30:22.000Z', relative: '2 hours ago' });
    expect(r.claims).toContainEqual({ claim: 'name', label: 'Name', value: 'John Doe' });
    const exp = makeToken({ alg: 'HS256' }, { exp: 1000 }, 's');
    expect(await call(tool, { token: exp, now: 2000 })).toMatchObject({ expired: true, status: 'bad' });
  });
});

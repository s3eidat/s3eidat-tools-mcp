import { describe, expect, it } from 'vitest';
import tool, { GEN, genFetch, genGo, genPython, goStr, headerList, parseCurl, phpStr, type Parsed } from '../../../src/tools/web/data/curl-convert.js';
import { call } from '../../helpers.js';

const SAMPLE = "curl 'https://s3eidat.github.io/api/v1/orders?status=open&limit=20' \\\n" +
  '  -X POST \\\n' +
  "  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.demo-token.signature' \\\n" +
  '  -H "Content-Type: application/json" \\\n' +
  "  -H 'X-Note: it'\\''s \"quoted\"' \\\n" +
  "  -b 'session=abc123; theme=dark' \\\n" +
  "  --data-raw '{\"customer\":\"Omar\",\"items\":[{\"sku\":\"A-1\",\"qty\":2}],\"gift\":true}' \\\n" +
  '  --compressed -L --max-time 30';
const hdr = (r: Parsed, n: string) => r.headers.filter((x) => x[0].toLowerCase() === n.toLowerCase())[0]?.[1];
const errOf = (c: string) => { try { parseCurl(c); return null; } catch (e) { return (e as Error).message; } };

// Known answers from the website's S3_SELFTEST.
describe('curl-convert self-test', () => {
  it('parses quoting and options', () => {
    const a = parseCurl("curl 'https://s3eidat.github.io/api?a=1&b=2' -H 'Authorization: Bearer abc' -H \"X-Quote: it's \\\"q\\\"\" --data-raw '{\"name\":\"O'\\''Brien\"}'");
    expect(a.method).toBe('POST');
    expect(a.url).toBe('https://s3eidat.github.io/api?a=1&b=2');
    expect(hdr(a, 'X-Quote')).toBe('it\'s "q"');
    expect(a.body).toBe('{"name":"O\'Brien"}');
    expect(hdr(a, 'Content-Type')).toBe('application/x-www-form-urlencoded');
    const b = parseCurl("curl -X PUT \\\n  https://s3eidat.github.io/x \\\n  -d a=1 -d 'b=2 3'");
    expect([b.method, b.url, b.body]).toEqual(['PUT', 'https://s3eidat.github.io/x', 'a=1&b=2 3']);
    expect(parseCurl("curl s3eidat.github.io --data-binary $'line1\\nline2\\x41 \\'q\\' \\u00e9 \\xc3\\xa9'").body).toBe("line1\nline2A 'q' \u00e9 \u00e9");
    expect(parseCurl('curl s3eidat.github.io/p').url).toBe('http://s3eidat.github.io/p');
    expect(parseCurl("curl -u 'user:pa:ss' https://s3eidat.github.io").user).toEqual({ user: 'user', pass: 'pa:ss' });
    expect(headerList(parseCurl('curl -u user:pass https://s3eidat.github.io'), true)[0][1]).toBe('Basic dXNlcjpwYXNz');
    const j = parseCurl("curl --json '{\"a\":1}' https://s3eidat.github.io");
    expect([j.method, hdr(j, 'content-type'), hdr(j, 'accept'), j.jsonBody]).toEqual(['POST', 'application/json', 'application/json', { a: 1 }]);
    const f = parseCurl("curl -sSLk -XPOST -H'X-A: 1' --max-time=5 https://s3eidat.github.io");
    expect([f.follow, f.insecure, f.method, hdr(f, 'X-A'), f.timeout]).toEqual([true, true, 'POST', '1', 5]);
    expect(parseCurl("curl --data-urlencode 'q=hello world&x' --data-urlencode '=a/b' https://s3eidat.github.io").body).toBe('q=hello%20world%26x&a%2Fb');
    const g = parseCurl('curl -G -d q=1 -d page=2 https://s3eidat.github.io/s?x=0');
    expect([g.method, g.url, g.body]).toEqual(['GET', 'https://s3eidat.github.io/s?x=0&q=1&page=2', null]);
    const fm = parseCurl("curl -F 'file=@photo.jpg;type=image/jpeg' -F name=Omar https://s3eidat.github.io/up");
    expect([fm.method, fm.form[0].file, fm.form[0].type, fm.form[1].value]).toEqual(['POST', 'photo.jpg', 'image/jpeg', 'Omar']);
    expect(hdr(parseCurl("curl -b 'a=1; b=2' https://s3eidat.github.io"), 'Cookie')).toBe('a=1; b=2');
    expect(parseCurl('curl -I https://s3eidat.github.io').method).toBe('HEAD');
    expect(parseCurl('curl https://s3eidat.github.io | jq .').warnings).toHaveLength(1);
    expect(errOf("curl 'https://s3eidat.github.io")).toBe('Unclosed single quote');
    expect(errOf('wget https://s3eidat.github.io')).toBeTruthy();
  });
  it('generates code', () => {
    const p = parseCurl(SAMPLE);
    expect((p.jsonBody as { items: { qty: number }[] }).items[0].qty).toBe(2);
    expect(genPython(p)).toContain('"gift": True');
    expect(phpStr("it's a \\ test")).toBe("'it\\'s a \\\\ test'");
    expect(goStr('a"b')).toBe('`a"b`');
    expect(goStr('a`b')).toBe('"a`b"');
    expect(genFetch(p)).toContain('body: JSON.stringify(');
    expect(genGo(p)).toMatch(/"strings"/);
    expect(genGo(p)).toMatch(/"net\/http"/);
    for (const k of Object.keys(GEN) as (keyof typeof GEN)[]) {
      for (const c of [SAMPLE, 'curl https://s3eidat.github.io', 'curl -F a=@x.png -F b=c -u u:p -k https://s3eidat.github.io/up', 'curl -T f.bin -x proxy:3128 --connect-timeout 3 -m 9 s3eidat.github.io']) {
        expect(GEN[k](parseCurl(c))).toContain('s3eidat.github.io');
      }
    }
  });
});

describe('curl_to_code tool', () => {
  it('returns code and a masked summary', async () => {
    const r = await call<{ code: string; method: string; headers: { name: string; value: string }[]; basicAuth: { password: string } }>(tool, {
      command: "curl -u user:pass -H 'Authorization: Bearer abc' https://s3eidat.github.io", language: 'python',
    });
    expect(r.method).toBe('GET');
    expect(r.headers[0].value).toBe('Bearer ••••••••');
    expect(r.basicAuth.password).toBe('••••••••');
    expect(r.code).toContain('auth=("user", "pass")');
    const all = await call<{ codes: Record<string, string> }>(tool, { command: 'curl https://s3eidat.github.io', language: 'all' });
    expect(Object.keys(all.codes)).toEqual(['fetch', 'axios', 'python', 'php', 'go', 'node']);
    await expect(call(tool, { command: 'wget x' })).rejects.toThrow(/curl/);
  });
});

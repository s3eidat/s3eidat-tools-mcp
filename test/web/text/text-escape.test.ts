import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, {
  run, jsonEsc, jsUnesc, jsEsc, htmlEsc, htmlUnesc, xmlEsc, urlEsc, urlUnesc, sqlEsc, csvEsc, reEsc, shEsc, shUnesc, cEsc, cUnesc,
  javaEsc, javaUnesc, uniEsc, type EscOpts,
} from '../../../src/tools/web/text/text-escape.js';

const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);

// The website's S3_SELFTEST (text-escape/app.js), copied verbatim: round trips of a nasty string through every
// target and option, plus known answers.
describe('text_escape', () => {
  it('matches the website self-test', () => {
    var fails: string[] = [], F = String.fromCharCode;
    function eq(name: string, a: unknown, b: unknown) { if (a !== b) fails.push(name + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
    var NASTY = 'He said "hi" & <b>\'yo\'</b>\\ \n\t\r tab ' + String.fromCodePoint(0x1D11E) + " " + F(233) + " " + F(252) + " " + String.fromCodePoint(0x1F600) +
      " " + LS + PS + " " + F(0) + "1 " + F(7) + F(27) + F(127) + " $(rm -rf) `x` ${y} %20 a+b, c;\"d\" [x]* ^$ | ? ' '' \\' " + F(1605, 1585, 1581, 1576, 1575) + " &amp; &#169; U+0041 \\u0041 ";
    var variants: Record<string, EscOpts[]> = { json: [{}, { ascii: true }], js: [{}, { ascii: true }], html: [{}, { ascii: true }, { ascii: true, named: true }], xml: [{}],
      url: [{}, { form: true }], sql: [{}, { wrap: true }, { wrap: true, mysql: true }], csv: [{}, { always: true }, { delim: ";" }], regex: [{}], shell: [{}],
      c: [{}, { ascii: true }], java: [{}, { ascii: true }], unicode: [{ format: "u4" }, { format: "u4", all: true }, { format: "ubrace" }, { format: "u8" }, { format: "html" }, { format: "uplus" }] };
    Object.keys(variants).forEach(function (id) {
      variants[id].forEach(function (o, k) {
        try { eq("round trip " + id + " #" + k, run(id, "unesc", run(id, "esc", NASTY, o), o), NASTY); }
        catch (e) { fails.push("round trip " + id + " #" + k + " threw " + (e as Error).message); }
      });
    });
    eq("json", jsonEsc('a"b\\c\n', {}), 'a\\"b\\\\c\\n');
    eq("json ascii", jsonEsc(F(233), { ascii: true }), "\\u00E9");
    eq("js unicode brace", jsUnesc("\\u{1F600}"), String.fromCodePoint(0x1F600));
    eq("js nul before digit", jsEsc(F(0) + "1", {}), "\\x001");
    eq("js template", jsEsc("`${x}`", {}), "\\`\\${x}\\`");
    eq("html", htmlEsc("<a href='x'>&", {}), "&lt;a href=&#39;x&#39;&gt;&amp;");
    eq("html unescape", htmlUnesc("&copy; &#169; &#xA9; &amp;lt; &zzq; &#0;"), F(169) + " " + F(169) + " " + F(169) + " &lt; &zzq; " + F(0xfffd));
    eq("html named", htmlEsc(F(169) + F(8364), { ascii: true, named: true }), "&copy;&euro;");
    eq("xml", xmlEsc("<a b=\"c\">'&'</a>"), "&lt;a b=&quot;c&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
    eq("url", urlEsc("a b&c/d", {}), "a%20b%26c%2Fd"); eq("url form", urlEsc("a b", { form: true }), "a+b");
    var bad: string | null = null; try { urlUnesc("%E0%A4%A", {}); } catch (e) { bad = (e as Error).message; } eq("url malformed", !!bad, true);
    eq("sql", sqlEsc("O'Brien", { wrap: true }), "'O''Brien'");
    eq("csv", csvEsc('a,"b"', {}), '"a,""b"""'); eq("csv plain", csvEsc("abc", {}), "abc");
    eq("regex", reEsc("a.b*c(d)/e"), "a\\.b\\*c\\(d\\)\\/e");
    eq("shell", shEsc("it's"), "'it'\\''s'"); eq("shell unescape mixed", shUnesc("'a'\"b c\"\\ d"), "ab c d");
    eq("c", cEsc("\"\n" + F(7) + F(0) + "1", {}), "\\\"\\n\\a\\0001");
    eq("c utf8 octal", cEsc(F(233), { ascii: true }), "\\303\\251"); eq("c hex", cUnesc("\\x41\\101\\u00e9"), "AA" + F(233));
    eq("java control", javaEsc(F(10) + F(1), {}), "\\n\\001"); eq("java uuu", javaUnesc("\\uuu0041"), "A");
    eq("unicode u4 pair", uniEsc(String.fromCodePoint(0x1F600), {}), "\\uD83D\\uDE00");
    eq("unicode uplus", uniEsc("Hi", { format: "uplus" }), "U+0048 U+0069");
    expect(fails).toEqual([]);
  });

  it('decodes named HTML entities like a browser', () => {
    expect(htmlUnesc('&notit; &not &amp &AMP; &hellip;&zzq')).toBe('¬it; ¬ & & …&zzq');
  });

  it('runs as a tool', async () => {
    for (const ex of tool.examples!) expect(await call(tool, ex.input)).toEqual(ex.output);
    const all = await call<{ allTargets: { target: string; result: string }[] }>(tool, { text: 'a"b', target: 'json', allTargets: true });
    expect(all.allTargets).toHaveLength(12);
    expect(all.allTargets.find((x) => x.target === 'html')!.result).toBe('a&quot;b');
    await expect(call(tool, { text: '%E0%A4%A', target: 'url', direction: 'unescape' })).rejects.toThrow(/Malformed/);
  });
});

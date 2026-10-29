import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { HTTPS, graphemes, hashtags, links, mentions, sms, toGsm, xLen } from '../../../src/tools/web/text/social-counter.js';

// The website's S3_SELFTEST (social-counter/app.js), copied verbatim.
describe('text_social_count', () => {
  it('matches the website self-test', () => {
    var f: string[] = [];
    function eq(n: string, got: unknown, want: unknown) { if (got !== want) f.push(n + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); }
    function rep(c: string, n: number) { return new Array(n + 1).join(c); }
    // X weighted length
    eq("x latin 280", xLen(rep("a", 280)), 280);
    eq("x arabic", xLen(rep("ب", 280)), 280);
    eq("x cjk", xLen("中文"), 4);
    eq("x url", xLen(HTTPS + "example.com/" + rep("a", 60)), 23);
    eq("x bare url", xLen("Go to www.example.com now"), 6 + 23 + 4);
    eq("x domain", xLen("see example.com."), 4 + 23 + 1);
    eq("x family emoji", xLen("👨‍👩‍👧"), 2);
    eq("x flag", xLen("🇯🇴"), 2);
    eq("x skin tone", xLen("👍🏽!"), 3);
    eq("x nfc", xLen("é"), 1);
    eq("x email not link", links("mail me@example.com").length, 0);
    // SMS
    function seg2(t: string) { var s = sms(t); return (s.gsm ? "G" : "U") + s.segments; }
    eq("gsm 160", seg2(rep("a", 160)), "G1");
    eq("gsm 161", seg2(rep("a", 161)), "G2");
    eq("gsm 306", seg2(rep("a", 306)), "G2");
    eq("gsm 307", seg2(rep("a", 307)), "G3");
    eq("ucs 70", seg2(rep("ب", 70)), "U1");
    eq("ucs 71", seg2(rep("ب", 71)), "U2");
    eq("ucs 134", seg2(rep("ب", 134)), "U2");
    eq("ucs 135", seg2(rep("ب", 135)), "U3");
    eq("ext 80", seg2(rep("{", 80)), "G1");
    eq("ext 81", seg2(rep("{", 81)), "G2");
    eq("euro units", sms("€").total, 2);
    eq("ext not split", sms(rep("a", 152) + "{" + rep("a", 152)).segments, 3); // 152 | 2+151 | 1
    eq("emoji ucs units", sms("😀").total, 2);
    eq("emoji not split", sms(rep("ب", 66) + "😀" + rep("ب", 10)).segments, 2);
    eq("lookalike", sms(toGsm("“Hi” – it’s fine…")).gsm, true);
    // counts
    eq("graphemes", graphemes("👍🏽é").length, 2);
    eq("hashtags", hashtags("#one #two x#no #3 #تجربة"), 3);
    eq("mentions", mentions("@a hi @b_c and a@b.com"), 2);
    expect(f).toEqual([]);
  });

  it('runs as a tool', async () => {
    const r = await call<{
      xWeightedLength: number; characters: number; hashtags: number; links: number;
      platforms: { id: string; status: string; remaining: number }[]; sms: { encoding: string; parts: number };
    }>(tool, { text: 'Read it here: https://example.com/blog/code-reviews 🚀 #coding', platforms: ['x', 'yt'] });
    expect(r.xWeightedLength).toBe(14 + 23 + 1 + 2 + 8);
    expect(r).toMatchObject({ hashtags: 1, links: 1 });
    expect(r.platforms.map((p) => p.id)).toEqual(['x', 'yt']);
    expect(r.platforms[0]).toMatchObject({ status: 'ok', remaining: 280 - r.xWeightedLength });
    expect(r.sms).toMatchObject({ encoding: 'UCS-2', parts: 1 });
    const g = await call<{ gsmText: string; sms: { nonGsmCharacters: { char: string }[] } }>(tool, { text: '“Hi” – it’s fine…', gsmLookalikes: true });
    expect(g.gsmText).toBe('"Hi" - it\'s fine...');
    expect(g.sms.nonGsmCharacters.length).toBeGreaterThan(0);
  });
});

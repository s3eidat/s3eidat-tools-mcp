import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { convert, detect, SHADDA } from '../../../src/tools/web/text/layout-fixer.js';

// The website's S3_SELFTEST (layout-fixer/app.js), copied verbatim.
describe('text_layout_fix', () => {
  it('matches the website self-test', () => {
    function A(s: string, o?: { lower?: boolean }) { return convert(s, "ar", o).text; }
    function E(s: string) { return convert(s, "en").text; }
    function auto(s: string) { return convert(s, "auto").text; }
    var NL = String.fromCharCode(10);
    var cases = [
      // the basics (note: "عليكم" needs the ك key, so it is "ugd;l"; plain "ugdl" is "عليم")
      [A("hgsghl ugd;l"), "السلام عليكم"], [A("ugdl"), "عليم"], [E("اثممخ"), "hello"], [A("b"), "لا"],
      [auto("hgsghl ugd;l"), "السلام عليكم"], [auto("اثممخ"), "hello"],
      // shift layer
      [A("Hkh"), "أنا"], [A("Ylhl"), "إمام"], [A("lvpfhW"), "مرحباً"], [A("hgNk"), "الآن"], [A("G"), "لأ"], [A("T"), "لإ"],
      [A("B"), "لآ"], [A("p~"), "ح" + SHADDA], [A(";dt phg;?"), "كيف حالك؟"], [E("أثممخ"), "Hello"], [E("الآن"), "hBk"], [E("ﻻ"), "b"],
      // lam-alef: B key or G+H
      [E("مهلاف"), "light"], [E("شلاخعف"), "about"], [E("اهلا"), "high"], [E("فاخعلا"), "though"],
      // mixed text: only the mistyped words change
      [auto("مرحبا hgsghl"), "مرحبا السلام"], [auto("صباح الخير ;dt phg;?"), "صباح الخير كيف حالك؟"],
      [auto("عندي meeting بكرة"), "عندي meeting بكرة"], [auto("رايح meeting hgfdj"), "رايح meeting البيت"],
      [auto("ok, اثممخ صخقمي"), "ok, hello world"], [E("Hi اثممخ"), "Hi hello"], [A("hgsghl 2026 ugd;l"), "السلام 2026 عليكم"],
      [A("hgsghl ugd;l ?"), "السلام عليكم ؟"], [E("ok ؟"), "ok ?"],
      // caps lock, whitespace, nothing to do
      [A("HGSGHL", { lower: true }), "السلام"], [A("hgsghl" + NL + "  ugd;l"), "السلام" + NL + "  عليكم"], [String(detect("123 !!")), "null"], [auto(""), ""]
    ];
    var fails: string[] = [];
    cases.forEach(function (c, i) { if (c[0] !== c[1]) fails.push("case " + i + ": got " + c[0]); });
    // Round trips: Arabic -> keys -> Arabic is exact; English -> Arabic -> English for text without g-before-h or b.
    ["السلام عليكم ورحمة الله", "كيف حالك؟ أنا بخير، الحمد لله", "إلى اللقاء غداً", "مرحباً بالعالم الآن", "طائرة مؤجلة"]
      .forEach(function (t) { if (A(E(t)) !== t) fails.push("ar trip: " + t); });
    ["hello world", "the quick brown fox jumps over the lazy dog", "type, check; done.", "a/b [x] `q`", "about time"]
      .forEach(function (t) { if (E(A(t)) !== t) fails.push("en trip: " + t); });
    var keys = "`qwertyuiop[]asdfjkl;'zxcvnm,./ ", seed = 7;
    for (var t = 0; t < 300; t++) {
      var s = "";
      for (var c = 0; c < 12; c++) { seed = (seed * 1103515245 + 12345) % 2147483648; s += keys[seed % keys.length]; }
      s = s.replace(/\s+/g, " ").trim();
      if (!/[a-z]/.test(s)) continue;
      if (E(A(s)) !== s) fails.push("random trip: " + s);
    }
    expect(fails).toEqual([]);
  });

  it('runs as a tool', async () => {
    const r = await call<{ text: string; direction: string; wordsChanged: number }>(tool, { text: 'hgsghl ugd;l', direction: 'ar' });
    expect(r.text).toBe(convert('hgsghl ugd;l', 'ar').text);
    expect(r.direction).toBe('ar');
    expect(r.wordsChanged).toBe(2);
    const caps = await call<{ text: string; capsLockIgnored: boolean }>(tool, { text: 'HGSGHL' });
    expect(caps.capsLockIgnored).toBe(true);
    expect(caps.text).toBe(convert('hgsghl', 'ar').text);
    const none = await call<{ direction: null; text: string }>(tool, { text: '123 !!' });
    expect(none).toMatchObject({ direction: null, text: '123 !!' });
  });
});

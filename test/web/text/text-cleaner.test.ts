import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, tempCtx } from '../../helpers.js';
import tool, { clean, seeded, DEFAULTS } from '../../../src/tools/web/text/text-cleaner.js';

// Known answers copied verbatim from the website's S3_SELFTEST (text-cleaner/app.js).
describe('text_clean', () => {
  it('matches the website self-test', () => {
    var base = Object.assign({}, DEFAULTS);
    var t = [
      [clean("  a  \n\n b   c \n", base).text, "a\nb c"],
      [clean("x\nX\nx", Object.assign({}, base, { dupes: true })).text, "x\nX"],
      [clean("x\nX\nx", Object.assign({}, base, { dupes: true, ignoreCase: true })).text, "x"],
      [clean("item 10\nitem 2\nitem 1", Object.assign({}, base, { sort: "natural" })).text, "item 1\nitem 2\nitem 10"],
      [clean("b\nC\na", Object.assign({}, base, { sort: "za" })).text, "C\nb\na"],
      [clean("ccc\na\nbb", Object.assign({}, base, { sort: "length" })).text, "a\nbb\nccc"],
      [clean("1\n2\n3", Object.assign({}, base, { reverse: true })).text, "3\n2\n1"],
      [clean("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk", Object.assign({}, base, { number: true })).text.split("\n")[0], " 1. a"],
      [clean("<p>Hi &amp; <b>bye</b></p><script>alert(1)</script><p>x&#x41;&lt;</p>", Object.assign({}, base, { html: true })).text, "Hi & bye\nxA<"],
      [clean("ok 👍🏽 go 👨‍👩‍👧 © 2026 🇯🇴!", Object.assign({}, base, { emoji: true })).text, "ok go © 2026 !"],
      [clean("a\r\nb\r\n", base).text, "a\nb"]
    ];
    var sh = clean("1\n2\n3\n4\n5\n6", Object.assign({}, base, { shuffle: true }), seeded(1)).text.split("\n");
    var shOk = sh.length === 6 && sh.slice().sort().join("") === "123456";
    var st = clean("a\na\n\nb", Object.assign({}, base, { dupes: true })).stats;
    t.forEach((p) => expect(p[0]).toBe(p[1]));
    expect(shOk).toBe(true);
    expect(st).toEqual({ dupes: 1, empty: 1 });
  });

  it('runs as a tool with stats, seeded shuffle and file output', async () => {
    const r = await call<Record<string, unknown>>(tool, { text: 'item 10\nitem 2\nitem 2\n\nitem 1', removeDuplicates: true, sort: 'natural' });
    expect(r).toEqual({ text: 'item 1\nitem 2\nitem 10', linesIn: 5, linesOut: 3, duplicatesRemoved: 1, emptyLinesRemoved: 1, charactersOut: 21 });
    const a = await call<{ text: string; seed: number }>(tool, { text: '1\n2\n3\n4\n5\n6', shuffle: true, seed: 42 });
    const b = await call<{ text: string }>(tool, { text: '1\n2\n3\n4\n5\n6', shuffle: true, seed: 42 });
    expect(a.text).toBe(b.text);
    expect(a.seed).toBe(42);
    const ctx = tempCtx();
    const f = await call<{ path: string; text?: string }>(tool, { text: ' a \n\n b ', output: join(ctx.outDir, 'out.txt') }, ctx);
    expect(f.text).toBeUndefined();
    expect(readFileSync(f.path, 'utf8')).toBe('a\nb\n');
  });
});

import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { slugify, type SlugOptions } from '../../../src/tools/web/text/slugify.js';

// Known answers copied verbatim from the website's S3_SELFTEST (slugify/app.js).
describe('text_slugify', () => {
  const d: SlugOptions = { sep: '-', lower: true, accents: true, stop: false, arabic: 'latin', max: 0 };
  const w = (x: Partial<SlugOptions>): SlugOptions => Object.assign({}, d, x);
  const t: [string, string][] = [
    [slugify("Hello, World!", d), "hello-world"],
    [slugify("  Crème Brûlée à la carte ", d), "creme-brulee-a-la-carte"],
    [slugify("The Lord of the Rings", w({ stop: true })), "lord-rings"],
    [slugify("The Of", w({ stop: true })), "the-of"],
    [slugify("Don't stop", d), "dont-stop"],
    [slugify("Straße & Co.", d), "strasse-and-co"],
    [slugify("Hello World", w({ sep: "_" })), "hello_world"],
    [slugify("Hello World", w({ lower: false })), "Hello-World"],
    [slugify("hello wonderful world", w({ max: 10 })), "hello"],
    [slugify("hello wonderful world", w({ max: 15 })), "hello-wonderful"],
    [slugify("supercalifragilistic", w({ max: 5 })), "super"],
    [slugify("مدينة نور", d), "mdina-nur"],
    [slugify("البيت", d), "al-bit"],
    [slugify("١٢٣ عنوان", d), "123-anuan"],
    [slugify("مَرْحَباً بالعالم!", w({ arabic: "keep" })), "مرحبا-بالعالم"],
    [slugify("أهلاً وسهلاً", w({ arabic: "keep" })), "أهلا-وسهلا"],
    [slugify("café", w({ accents: false })), "café"],
    [slugify("!!!", d), ""]
  ];
  it.each(t.map((p, i) => [i, ...p]))('case %i', (_i, got, want) => expect(got).toBe(want));

  it('runs as a tool, one slug per non-empty line', async () => {
    const r = await call<{ slugs: { slug: string; length: number }[] }>(tool, { text: 'Hello, World!\n\n  Crème Brûlée à la carte ' });
    expect(r.slugs.map((s) => s.slug)).toEqual(['hello-world', 'creme-brulee-a-la-carte']);
    const u = await call<{ slugs: { slug: string }[] }>(tool, { text: 'Hello World', separator: '_', lowercase: false });
    expect(u.slugs[0].slug).toBe('Hello_World');
  });
});

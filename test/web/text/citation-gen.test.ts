import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, {
  AUTH, DOI_BASE, HTTPS, format, inText, initials, mlaPages, person, titleCase, toHtml, type Person,
} from '../../../src/tools/web/text/citation-gen.js';

// Samples and S3_SELFTEST copied verbatim from the website (citation-gen/app.js).
const SAMPLES = {
  book: { type: "book", authors: [{ first: "Harold", last: "Abelson" }, { first: "Gerald Jay", last: "Sussman" }], title: "Structure and interpretation of computer programs", edition: "2", year: "1996", publisher: "MIT Press", place: "Cambridge, MA, USA" },
  website: { type: "website", authors: [{ first: "Linda", last: "Martinez" }], title: "Climate change and coffee farming", container: "Coffee Research Institute", year: "2021", month: "3", day: "15", url: HTTPS + "example.org/coffee", accessed: "2024-05-02" },
  journal: { type: "journal", authors: [{ first: "Amira", last: "Haddad" }, { first: "Omar", last: "Khalil" }, { first: "Sara", last: "Nasser" }], title: "Reading on screens: Effects on comprehension and recall", container: "Journal of Educational Psychology", volume: "112", issue: "4", pages: "715-731", year: "2020", month: "5", doi: "10.1037/edu0000398" },
  chapter: { type: "chapter", authors: [{ first: "Maya", last: "Rahman" }], title: "Designing for slow readers", container: "Handbook of reading research", editors: "Peter Lee; Hana Aziz", pages: "127-153", year: "2019", publisher: "Routledge", place: "New York, NY, USA" },
  video: { type: "video", authors: [{ first: "", last: "Khan Academy", org: true }], title: "Introduction to limits", container: "YouTube", year: "2017", month: "8", day: "10", url: HTTPS + "www.youtube.com/watch?v=riXcZT2ICjA", accessed: "2024-05-02" }
};

describe('text_citation', () => {
  it('matches the website self-test', () => {
    var fails: string[] = [];
    function eq(name: string, got: unknown, want: unknown) { if (got !== want) fails.push(name + ": got «" + got + "» want «" + want + "»"); }
    function txt(src: object, st: string) { return format(Object.assign({ autoCase: true }, src), st).text().trim(); }
    function its(src: object, st: string) { return format(Object.assign({ autoCase: true }, src), st).runs().filter(function (r) { return r.i; }).map(function (r) { return r.t; }).join("|"); }
    var B = SAMPLES.book, W = SAMPLES.website, U = HTTPS + "example.org/coffee";
    eq("apa book", txt(B, "apa"), "Abelson, H., & Sussman, G. J. (1996). Structure and interpretation of computer programs (2nd ed.). MIT Press.");
    eq("apa book italic", its(B, "apa"), "Structure and interpretation of computer programs");
    eq("mla book", txt(B, "mla"), "Abelson, Harold, and Gerald Jay Sussman. Structure and Interpretation of Computer Programs. 2nd ed., MIT Press, 1996.");
    eq("chicago book", txt(B, "chicago"), "Abelson, Harold, and Gerald Jay Sussman. 1996. Structure and Interpretation of Computer Programs. 2nd ed. Cambridge, MA, USA: MIT Press.");
    eq("harvard book", txt(B, "harvard"), "Abelson, H. and Sussman, G.J. (1996) Structure and interpretation of computer programs. 2nd edn. Cambridge, MA, USA: MIT Press.");
    eq("ieee book", txt(B, "ieee"), "H. Abelson and G. J. Sussman, Structure and Interpretation of Computer Programs, 2nd ed. Cambridge, MA, USA: MIT Press, 1996.");
    eq("ieee book italic", its(B, "ieee"), "Structure and Interpretation of Computer Programs");
    eq("apa web", txt(W, "apa"), "Martinez, L. (2021, March 15). Climate change and coffee farming. Coffee Research Institute. " + U);
    eq("mla web", txt(W, "mla"), "Martinez, Linda. “Climate Change and Coffee Farming.” Coffee Research Institute, 15 Mar. 2021, example.org/coffee.");
    eq("mla web italic", its(W, "mla"), "Coffee Research Institute");
    eq("chicago web", txt(W, "chicago"), "Martinez, Linda. 2021. “Climate Change and Coffee Farming.” Coffee Research Institute. March 15, 2021. " + U + ".");
    eq("harvard web", txt(W, "harvard"), "Martinez, L. (2021) Climate change and coffee farming. Available at: " + U + " (Accessed: 2 May 2024).");
    eq("ieee web", txt(W, "ieee"), "L. Martinez. “Climate change and coffee farming.” Coffee Research Institute. " + U + " (accessed May 2, 2024).");
    // Journal with DOI
    var J = SAMPLES.journal;
    eq("apa journal", txt(J, "apa"), "Haddad, A., Khalil, O., & Nasser, S. (2020). Reading on screens: Effects on comprehension and recall. Journal of Educational Psychology, 112(4), 715–731. " + DOI_BASE + "10.1037/edu0000398");
    eq("apa journal italic", its(J, "apa"), "Journal of Educational Psychology, 112");
    eq("mla journal", txt(J, "mla"), "Haddad, Amira, et al. “Reading on Screens: Effects on Comprehension and Recall.” Journal of Educational Psychology, vol. 112, no. 4, May 2020, pp. 715-31, " + DOI_BASE + "10.1037/edu0000398.");
    eq("ieee journal", txt(J, "ieee"), "A. Haddad, O. Khalil, and S. Nasser, “Reading on screens: Effects on comprehension and recall,” Journal of Educational Psychology, vol. 112, no. 4, pp. 715–731, May 2020, doi: 10.1037/edu0000398.");
    // Author-count rules
    function people(n: number) { var a: Person[] = []; for (var i = 0; i < n; i++) a.push(person({ first: "Ann", last: "L" + i })); return a; }
    eq("apa 21", AUTH.apa(people(21)).slice(-22), "L18, A., . . . L20, A.");
    eq("mla 3", AUTH.mla(people(3)), "L0, Ann, et al.");
    eq("chicago 11", AUTH.chicago(people(11)), "L0, Ann, Ann L1, Ann L2, Ann L3, Ann L4, Ann L5, Ann L6, et al.");
    eq("harvard 3", AUTH.harvard(people(3)), "L0, A., L1, A. and L2, A.");
    eq("harvard 4", AUTH.harvard(people(4)), "L0, A. et al.");
    eq("ieee 6", AUTH.ieee(people(6)), "A. L0, A. L1, A. L2, A. L3, A. L4, and A. L5");
    eq("ieee 7", AUTH.ieee(people(7)), "A. L0 et al.");
    eq("initials", initials("Jean-Paul K.", true), "J.-P. K.");
    eq("mla pages", [mlaPages("127-153"), mlaPages("395-401"), mlaPages("1608-1774"), mlaPages("96-101"), mlaPages("103-104")].join(" "), "127-53 395-401 1608-774 96-101 103-04");
    eq("title case", titleCase("the lord of the rings: the return of the king"), "The Lord of the Rings: The Return of the King");
    eq("intext", [inText(B, "apa"), inText(B, "mla"), inText(B, "chicago"), inText(J, "harvard"), inText(B, "ieee", 3)].join(" "), "(Abelson & Sussman, 1996) (Abelson and Sussman) (Abelson and Sussman 1996) (Haddad, Khalil and Nasser, 2020) [3]");
    eq("escape", toHtml([{ t: "<b>&", i: true }]), "<i>&lt;b&gt;&amp;</i>");
    expect(fails).toEqual([]);
  });

  it('runs as a tool with a sorted bibliography', async () => {
    const r = await call<{ citations: { text: string; inText: string; missing: string[] }[]; bibliography: string; bibliographyTitle: string }>(tool, {
      style: 'apa', sources: [SAMPLES.website, SAMPLES.book],
    });
    expect(r.citations[1].text).toBe('Abelson, H., & Sussman, G. J. (1996). Structure and interpretation of computer programs (2nd ed.). MIT Press.');
    expect(r.citations[1].inText).toBe('(Abelson & Sussman, 1996)');
    expect(r.citations[0].missing).toEqual([]);
    expect(r.bibliographyTitle).toBe('References');
    expect(r.bibliography.startsWith('Abelson')).toBe(true);
    const ieee = await call<{ bibliography: string; citations: { inText: string }[] }>(tool, { style: 'ieee', sources: [SAMPLES.website, SAMPLES.book] });
    expect(ieee.bibliography.startsWith('[1] L. Martinez')).toBe(true);
    expect(ieee.citations[1].inText).toBe('[2]');
    const miss = await call<{ citations: { missing: string[] }[] }>(tool, { style: 'mla', sources: [{ type: 'journal', title: 'X' }] });
    expect(miss.citations[0].missing).toEqual(['year', 'journal name']);
  });
});

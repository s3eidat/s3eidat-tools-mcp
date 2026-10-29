import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, * as NW from '../../../src/tools/web/text/number-words.js';

// Loosely typed wrappers so the website's self-test runs unchanged.
const { CUR, MAX_INT, arInt, enInt, enOrdinal, ordSuffix, money } = NW;
const parse = (x: string) => NW.parse(x) as NW.Num & NW.Parsed;
const arMoney = (p: NW.Num, c: NW.Currency, o: object) => NW.arMoney(p, c, o as Partial<NW.Opts>);
const enCheque = (p: NW.Num, c: NW.Currency, o: object) => NW.enCheque(p, c, o as Partial<NW.Opts>);
const enCardinal = (p: NW.Num) => NW.enCardinal(p);
const arCardinal = (p: NW.Num, o: object) => NW.arCardinal(p, o as Partial<NW.Opts>);

describe('text_number_to_words', () => {
  it('matches the website self-test (copied verbatim)', () => {
    var fails: string[] = [];
    function eq(got: unknown, want: unknown, why: string) { if (got !== want) fails.push(why + ": got “" + got + "”"); }
    var JOD = CUR.JOD, SAR = CUR.SAR, USD = CUR.USD, opt = { only: false, brit: false, subStyle: "words" };
    function ar(x: string, c?: NW.Currency) { return arMoney(parse(x), c || JOD, opt); }
    eq(ar("1"), "دينار واحد", "1");
    eq(ar("2"), "ديناران", "2");
    eq(ar("3"), "ثلاثة دنانير", "3");
    eq(ar("10"), "عشرة دنانير", "10");
    eq(ar("11"), "أحد عشر ديناراً", "11");
    eq(ar("12"), "اثنا عشر ديناراً", "12");
    eq(ar("21"), "واحد وعشرون ديناراً", "21");
    eq(ar("100"), "مائة دينار", "100");
    eq(ar("103"), "مائة وثلاثة دنانير", "103");
    eq(ar("200"), "مائتا دينار", "200");
    eq(ar("1000"), "ألف دينار", "1000");
    eq(ar("2000"), "ألفا دينار", "2000");
    eq(ar("3000"), "ثلاثة آلاف دينار", "3000");
    eq(ar("1500.250"), "ألف وخمسمائة دينار ومائتان وخمسون فلساً", "1500.250");
    eq(ar("0.250"), "مائتان وخمسون فلساً", "0.250 only fils");
    eq(ar("1.001"), "دينار واحد وفلس واحد", "1 fils");
    eq(ar("5.002"), "خمسة دنانير وفلسان", "2 fils");
    eq(ar("1.0005"), "دينار واحد وفلس واحد", "rounding half up");
    eq(ar("0.03", SAR), "ثلاث هللات", "feminine 3");
    eq(ar("0.11", SAR), "إحدى عشرة هللة", "feminine 11");
    eq(ar("1.01", SAR), "ريال واحد وهللة واحدة", "feminine 1");
    eq(arMoney(parse("1500.25"), JOD, { only: true }), "فقط ألف وخمسمائة دينار ومائتان وخمسون فلساً لا غير", "only");
    eq(arInt(2000000n), "مليونان", "2 million");
    eq(arInt(11000n), "أحد عشر ألفاً", "11 thousand");
    eq(arInt(200000n), "مائتا ألف", "200 thousand");
    eq(arInt(150000n), "مائة وخمسون ألفاً", "150 thousand");
    eq(arInt(1234567n), "مليون ومائتان وأربعة وثلاثون ألفاً وخمسمائة وسبعة وستون", "1234567");
    eq(arInt(1000000000n), "مليار", "billion");
    eq(arCardinal(parse("3.05"), {}), "ثلاثة فاصلة صفر خمسة", "arabic decimal");
    eq(arMoney(parse("200"), JOD, { mia: true }), "مئتا دينار", "مئة spelling");
    eq(enInt(0n), "zero", "en 0");
    eq(enInt(21n), "twenty-one", "en 21");
    eq(enInt(105n), "one hundred five", "en 105");
    eq(enInt(105n, true), "one hundred and five", "en 105 british");
    eq(enInt(1005n, true), "one thousand and five", "en 1005 british");
    eq(enInt(1500n), "one thousand five hundred", "en 1500");
    eq(enInt(MAX_INT), "nine hundred ninety-nine trillion nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine", "en max");
    eq(enOrdinal("twenty-one"), "twenty-first", "ord 21");
    eq(enOrdinal(enInt(12n)), "twelfth", "ord 12");
    eq(enOrdinal(enInt(40n)), "fortieth", "ord 40");
    eq(enOrdinal(enInt(100n)), "one hundredth", "ord 100");
    eq(ordSuffix(11n) + ordSuffix(22n) + ordSuffix(103n), "thndrd", "suffixes");
    eq(enCheque(parse("1500.25"), USD, opt), "One thousand five hundred dollars and twenty-five cents", "cheque");
    eq(enCheque(parse("1"), USD, opt), "One dollar", "cheque 1");
    eq(enCheque(parse("0.5"), USD, opt), "Fifty cents", "cheque cents only");
    eq(enCheque(parse("2.999"), USD, opt), "Three dollars", "cheque rounding");
    eq(enCheque(parse("1500.25"), USD, { subStyle: "fraction" }), "One thousand five hundred and 25/100 dollars", "cheque fraction");
    eq(enCheque(parse("1500.250"), JOD, { only: true }), "One thousand five hundred dinars and two hundred fifty fils only", "cheque JOD");
    eq(enCardinal(parse("-12.05")), "minus twelve point zero five", "cardinal decimal");
    eq(parse("١٬٥٠٠٫٢٥").int + "|" + parse("١٬٥٠٠٫٢٥").frac, "1500|25", "Arabic-Indic digits");
    if (!parse("1e5").error || !parse("1000000000000000").error) fails.push("invalid input accepted");
    if (!(money(parse("999999999999999.999"), 100).main > MAX_INT)) fails.push("rounding overflow not detectable");
    expect(fails).toEqual([]);
  });

  it('runs as a tool', async () => {
    const r = await call<Record<string, string>>(tool, { number: '1500.25', currency: 'USD' });
    expect(r.englishAmount).toBe('One thousand five hundred dollars and twenty-five cents');
    expect(r.english).toBe('one thousand five hundred point two five');
    expect(r.arabicAmount).toBe(arMoney(parse('1500.25'), CUR.USD, {}));
    expect(r.ordinal).toBeUndefined();
    const o = await call<Record<string, string>>(tool, { number: 1021, british: true });
    expect(o).toMatchObject({ digits: '1,021', english: 'one thousand and twenty-one', ordinal: 'one thousand and twenty-first', ordinalShort: '1,021st' });
    await expect(call(tool, { number: '-5', currency: 'JOD' })).rejects.toThrow(/negative/);
    await expect(call(tool, { number: '1e5' })).rejects.toThrow(/isn't a number/);
  });
});

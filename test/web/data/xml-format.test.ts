import { describe, expect, it } from 'vitest';
import tools, { minify, namespaces, nodeText, pathOf, pretty, xmlToJson, xpath } from '../../../src/tools/web/data/xml-format.js';
import { parseXml, serialize, type XNode } from '../../../src/tools/web/data/_xml.js';
import { evaluate } from '../../../src/tools/web/data/_xpath.js';
import { call } from '../../helpers.js';

const [fmt, query] = tools;
const SAMPLE = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- a small book catalog -->\n<catalog xmlns="https://s3eidat.github.io/ns/catalog" xmlns:x="https://s3eidat.github.io/ns/extra" updated="2026-10-26">' +
  '<book id="b1" lang="en"><title>The Pragmatic Programmer</title><author>David Thomas</author><author>Andrew Hunt</author><price currency="USD">42.50</price></book>' +
  '<book id="b2" lang="ar"><title>كليلة ودمنة</title><author>ابن المقفع</author><price currency="JOD">12</price><x:note>Classic &amp; timeless</x:note></book>' +
  '<book id="b3"><title>Clean Code</title><author>Robert Martin</author><price currency="USD">35</price><summary><![CDATA[Use <b>small</b> functions & clear names]]></summary></book>' +
  '<blurb>Prices are <em>estimates</em> only.</blurb></catalog>';

function doc(s: string): XNode {
  const r = parseXml(s);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const byTag = (d: XNode, local: string): XNode[] => {
  const out: XNode[] = [];
  (function walk(n: XNode) { for (const c of n.children) { if (c.type === 1 && c.localName === local) out.push(c); walk(c); } })(d);
  return out;
};

// Known answers from the website's S3_SELFTEST.
describe('xml-format self-test', () => {
  it('validates', () => {
    expect(parseXml('<a><b/></a>').ok).toBe(true);
    const bad = parseXml('<a>\n  <b></a>');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.line).toBe(2);
    expect(parseXml('<a/><b/>').ok).toBe(false);
    expect(parseXml('<a>&nope;</a>').ok).toBe(false);
  });
  it('formats and minifies', () => {
    const src = "<r><a>1</a><b x='1'  y=\"2\"><c/><!--c--></b><d>t <i>x</i> y</d><e><![CDATA[ <not> & tag ]]></e><p xml:space=\"preserve\">  <q> s </q> </p></r>";
    const want = "<r>\n  <a>1</a>\n  <b x='1' y=\"2\">\n    <c/>\n    <!--c-->\n  </b>\n  <d>t <i>x</i> y</d>\n  <e><![CDATA[ <not> & tag ]]></e>\n  <p xml:space=\"preserve\">  <q> s </q> </p>\n</r>";
    expect(pretty(src, '  ', false)).toBe(want);
    expect(pretty(want, '  ', false)).toBe(want);
    expect(minify(want, false)).toBe("<r><a>1</a><b x='1' y=\"2\"><c/><!--c--></b><d>t <i>x</i> y</d><e><![CDATA[ <not> & tag ]]></e><p xml:space=\"preserve\">  <q> s </q> </p></r>");
    expect(minify(pretty(SAMPLE, '\t', false), false)).toBe(minify(SAMPLE, false));
    expect(pretty(pretty(SAMPLE, '  ', true), '  ', true)).toBe(pretty(SAMPLE, '  ', true));
    expect(minify('<a><!-- x --><b/></a>', true)).toBe('<a><b/></a>');
    const summary = (s: string) => serialize(byTag(doc(s), 'summary')[0]);
    expect(summary(pretty(SAMPLE, '  ', false))).toBe(summary(SAMPLE));
  });
  it('XPath, JSON and paths', () => {
    const d = doc(SAMPLE);
    expect(xpath(d, 'count(//d:book)')).toEqual({ kind: 'number', value: 3 });
    const f = xpath(d, '//d:book[d:price > 30]/d:title');
    expect(f.kind === 'nodes' && f.nodes.map((n) => n.children.map((c) => c.value).join(''))).toEqual(['The Pragmatic Programmer', 'Clean Code']);
    expect(xpath(d, 'string(//x:note)')).toEqual({ kind: 'string', value: 'Classic & timeless' });
    const at = xpath(d, '//d:book[2]/@lang');
    expect(at.kind === 'nodes' && nodeText(at.nodes[0])).toBe('lang="ar"');
    expect(xmlToJson(doc('<r a="1"><i>x</i><i>y</i><n/><t k="v">txt</t></r>'))).toEqual({ r: { '@a': '1', i: ['x', 'y'], n: '', t: { '@k': 'v', '#text': 'txt' } } });
    expect(pathOf(byTag(d, 'title')[1], namespaces(d))).toBe('/d:catalog/d:book[2]/d:title');
  });
});

describe('XML parser (DOMParser stand-in)', () => {
  const err = (s: string) => { const r = parseXml(s); return r.ok ? null : `${r.line}:${r.col} ${r.error}`; };
  it('reports well-formedness errors like libxml2', () => {
    expect(err('<a>\n  <b></a>')).toBe('2:6 Opening and ending tag mismatch: b line 2 and a');
    expect(err('<a/><b/>')).toMatch(/Extra content at the end of the document/);
    expect(err('<a>&nope;</a>')).toMatch(/Entity 'nope' not defined/);
    expect(err('<a b="1" b="2"/>')).toMatch(/Attribute b redefined/);
    expect(err('<a b=1/>')).toMatch(/" or ' expected/);
    expect(err('<a b="<"/>')).toMatch(/Unescaped '<'/);
    expect(err('<x:a/>')).toMatch(/Namespace prefix x on a is not defined/);
    expect(err('<a><!-- a -- b --></a>')).toMatch(/Double hyphen/);
    expect(err('<a>x ]]> y</a>')).toMatch(/\]\]>/);
    expect(err('<a>')).toMatch(/Premature end of data in tag a line 1/);
    expect(err('')).toMatch(/empty/i);
    expect(err('hello')).toMatch(/Start tag expected/);
    expect(err('<a>&#0;</a>')).toMatch(/invalid xmlChar/);
    expect(err('<a>\u0001</a>')).toMatch(/invalid Char value 1/);
    expect(err(' <?xml version="1.0"?><a/>')).toMatch(/XML declaration allowed only at the start/);
    expect(err('<a><![CDATA[x</a>')).toMatch(/CData section not finished/);
  });
  it('expands internal entities and stops bombs', () => {
    const d = doc('<!DOCTYPE r [<!ENTITY co "S3eidat &amp; co"><!ENTITY w "<b>bold</b>">]><r t="&co;">&co; &w;</r>');
    expect(serialize(d.children[0])).toBe('<r t="S3eidat &amp; co">S3eidat &amp; co <b>bold</b></r>');
    const lol = '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">' +
      '<!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;"><!ENTITY g "&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;"><!ENTITY h "&g;&g;&g;&g;&g;&g;&g;&g;&g;&g;">]><l>&h;</l>';
    expect(err(lol)).toMatch(/amplification/);
    expect(err('<!DOCTYPE l [<!ENTITY a "&b;"><!ENTITY b "&a;">]><l>&a;</l>')).toMatch(/loop/);
    expect(parseXml('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html>&nbsp;</html>').ok).toBe(true);
  });
  it('serializes like XMLSerializer (namespace declarations added)', () => {
    const d = doc(SAMPLE);
    expect(serialize(byTag(d, 'title')[0])).toBe('<title xmlns="https://s3eidat.github.io/ns/catalog">The Pragmatic Programmer</title>');
    expect(serialize(byTag(d, 'note')[0])).toBe('<x:note xmlns:x="https://s3eidat.github.io/ns/extra">Classic &amp; timeless</x:note>');
  });
});

describe('XPath 1.0', () => {
  const d = doc('<lib><b id="1" y="2001"><t>A</t><p>10</p></b><b id="2" y="1999"><t>B</t><p>5.5</p></b><!--c--><?pi data?><b id="3"><t>C</t><p>x</p></b></lib>');
  const v = (e: string) => evaluate(e, d, {});
  const names = (e: string) => (v(e) as XNode[]).map((n) => nodeText(n));
  it('paths, axes and predicates', () => {
    expect(names('/lib/b[2]/t')).toEqual(['<t>B</t>']);
    expect(names('//b[last()]/@id')).toEqual(['id="3"']);
    expect(names('//t[. = "B"]/following::t')).toEqual(['<t>C</t>']);
    expect(names('//t[. = "B"]/preceding::t')).toEqual(['<t>A</t>']);
    expect(names('(//t)[position() < 3]')).toEqual(['<t>A</t>', '<t>B</t>']);
    expect(names('//b[3]/ancestor-or-self::*[1]/@id')).toEqual(['id="3"']);
    expect(names('//b[3]/preceding-sibling::b[1]/@id')).toEqual(['id="2"']);
    expect(names('//t[1]/parent::b/@id | //b[@y < 2000]/@id')).toEqual(['id="1"', 'id="2"', 'id="3"']);
    expect(names('/lib/comment()')).toEqual(['<!--c-->']);
    expect(names("/lib/processing-instruction('pi')")).toEqual(['<?pi data?>']);
    expect(names('//b[not(@y)]/t/text()')).toEqual(['C']);
    expect(names('//@*[name() = "y"]')).toEqual(['y="2001"', 'y="1999"']);
  });
  it('operators and functions', () => {
    expect(v('sum(//p[number(.) = number(.)])')).toBe(15.5);
    expect(v('count(//b) * 2 + 1')).toBe(7);
    expect(v('7 mod 3 = 1 and 6 div 4 = 1.5')).toBe(true);
    expect(v('-(//p)[2]')).toBe(-5.5);
    expect(v('-//p[2]')).toBeNaN();
    expect(v('//p = 5.5')).toBe(true);
    expect(v('//p != 10')).toBe(true);
    expect(v('concat(substring("abcdef", 2, 3), "-", substring-after("a=b", "="), translate("abc", "abc", "AB"))')).toBe('bcd-bAB');
    expect(v('normalize-space("  a   b ")')).toBe('a b');
    expect(v('string-length("كليلة")')).toBe(5);
    expect(v('round(2.5) + floor(-1.5) + ceiling(1.2)')).toBe(3);
    expect(v('string(1 div 0)')).toBe('Infinity');
    expect(v('string(0 div 0)')).toBe('NaN');
    expect(v('string(1.50)')).toBe('1.5');
    expect(v('local-name(/*)')).toBe('lib');
    expect(v('boolean(//nothing)')).toBe(false);
    expect(v("starts-with(//t, 'A') and contains('xyz', 'y')")).toBe(true);
    expect(() => v('//b[')).toThrow();
    expect(() => v('//x:b')).toThrow(/prefix/);
    expect(() => v('foo()')).toThrow(/Unknown function/);
  });
});

describe('xml_format / xml_query tools', () => {
  it('formats, converts and validates', async () => {
    const f = await call<{ result: string; elements: number; depth: number }>(fmt, { text: '<a><b>1</b></a>', indent: 'tab' });
    expect(f).toMatchObject({ result: '<a>\n\t<b>1</b>\n</a>', elements: 2, depth: 2 });
    const j = await call<{ result: string }>(fmt, { text: '<r a="1"><i>x</i></r>', mode: 'json' });
    expect(JSON.parse(j.result)).toEqual({ r: { '@a': '1', i: 'x' } });
    const v = await call(fmt, { text: '<a>\n  <b></a>', mode: 'validate' });
    expect(v).toMatchObject({ valid: false, line: 2 });
    await expect(call(fmt, { text: '<a>\n  <b></a>' })).rejects.toThrow(/Invalid XML at line 2[\s\S]*\^/);
  });
  it('queries', async () => {
    const q = await call<{ kind: string; count: number; nodes: { location: string; text: string }[] }>(query, { text: SAMPLE, xpath: '//d:book[d:price > 30]/d:title' });
    expect(q.count).toBe(2);
    expect(q.nodes[1].location).toBe('/d:catalog/d:book[3]/d:title');
    const n = await call<{ hint: string }>(query, { text: SAMPLE, xpath: '//book' });
    expect(n.hint).toMatch(/d:/);
    expect(await call(query, { text: SAMPLE, xpath: 'count(//c:book)', namespaces: { c: 'https://s3eidat.github.io/ns/catalog' } })).toMatchObject({ kind: 'number', value: 3 });
    await expect(call(query, { text: SAMPLE, xpath: '//d:book[' })).rejects.toThrow(/Invalid XPath/);
  });
});

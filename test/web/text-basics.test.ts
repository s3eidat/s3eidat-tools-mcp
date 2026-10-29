import { describe, expect, it } from 'vitest';
import { runTool } from '../../src/registry.js';
import wordCount, { analyze, keywords, words } from '../../src/tools/web/text/word-count.js';
import caseTool, { convertCase } from '../../src/tools/web/text/case-convert.js';
import hashTool from '../../src/tools/web/dev/hash.js';

// Known answers copied from each website tool's S3_SELFTEST.
describe('text_word_count (word-count self-test)', () => {
  it('matches the website', () => {
    const a = analyze('Hello world. This is a test! Is it?\n\nNew paragraph here.');
    expect([a.words, a.sentences, a.paragraphs, a.lines]).toEqual([11, 4, 2, 3]);
    const b = analyze('مَرْحَبًا بِالعالم. كيف حالك؟ جيد');
    expect([b.words, b.sentences]).toEqual([5, 3]);
    expect(words("don't stop well-known 3.14 1,000 end.Next")).toHaveLength(7);
    expect(analyze('a b').chars).toBe(3);
    expect(analyze('a b').charsNoSpaces).toBe(2);
    expect(analyze('').words).toBe(0);
    expect(analyze('👍🏽é').chars).toBe(2);
    const k = keywords('The cat and the cat and the dog', false);
    expect(k[0]).toMatchObject({ word: 'cat', count: 2 });
    expect(k[0].density).toBeCloseTo(25);
    expect(k.some((x) => x.word === 'the')).toBe(false);
    const ka = keywords('مَرْحَبًا مرحبا في البيت', false);
    expect(ka[0]).toMatchObject({ word: 'مرحبا', count: 2 });
    expect(analyze(new Array(239).join('word ')).readSec).toBe(60);
  });
  it('runs as a tool', async () => {
    const r = (await runTool(wordCount, { text: 'one two three' })) as { words: number };
    expect(r.words).toBe(3);
  });
});

describe('text_case (case-convert self-test)', () => {
  const t: [string, Parameters<typeof convertCase>[1], string][] = [
    ['the lord of the rings: the return of the king', 'title', 'The Lord of the Rings: The Return of the King'],
    ['a tale OF two cities', 'title', 'A Tale of Two Cities'],
    ['HOW TO WIN FRIENDS', 'title', 'How to Win Friends'],
    ['my iPhone and self-driving cars', 'title', 'My iPhone and Self-Driving Cars'],
    ["hello WORLD. how are you? i'm fine", 'sentence', "Hello world. How are you? I'm fine"],
    ['user account ID', 'camel', 'userAccountId'],
    ['XMLParser handler', 'snake', 'xml_parser_handler'],
    ['someVariableName', 'kebab', 'some-variable-name'],
    ['max retry-count', 'constant', 'MAX_RETRY_COUNT'],
    ['hello_world 2nd try', 'pascal', 'HelloWorld2ndTry'],
    ['Hello, World!', 'alternate', 'hElLo, WoRlD!'],
    ['Hello World', 'inverse', 'hELLO wORLD'],
    ['line one\nline two', 'upper', 'LINE ONE\nLINE TWO'],
    ['Straße', 'upper', 'STRASSE'],
    ['café menu', 'camel', 'caféMenu'],
    ['مرحبا بالعالم', 'snake', 'مرحبا_بالعالم'],
    ['', 'title', ''],
  ];
  it.each(t)('%s → %s', (input, mode, want) => expect(convertCase(input, mode)).toBe(want));
  it('runs as a tool', async () => {
    expect(await runTool(caseTool, { text: 'hello world', mode: 'kebab' })).toEqual({ result: 'hello-world' });
  });
});

describe('hash_compute (hash-lab self-test)', () => {
  const run = (input: object) => runTool(hashTool, input) as Promise<{ hashes: Record<string, string>; match?: string | null }>;
  it('MD5 vectors (RFC 1321)', async () => {
    const md: Record<string, string> = {
      '': 'd41d8cd98f00b204e9800998ecf8427e',
      abc: '900150983cd24fb0d6963f7d28e17f72',
      'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
      'The quick brown fox jumps over the lazy dog': '9e107d9d372bb6826bd81d3542a419d6',
    };
    for (const [k, v] of Object.entries(md)) expect((await run({ text: k })).hashes.MD5).toBe(v);
  });
  it('SHA vectors (FIPS 180) and HMAC (RFC 4231 #2)', async () => {
    const r = await run({ text: 'abc' });
    expect(r.hashes['SHA-1']).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(r.hashes['SHA-256']).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const h = await run({ text: 'what do ya want for nothing?', hmacKey: 'Jefe' });
    expect(h.hashes['HMAC-SHA256']).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
  it('compare', async () => {
    expect((await run({ text: 'abc', expected: 'SHA256 (x.iso) = BA7816BF 8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD' })).match).toBe('SHA-256');
    expect((await run({ text: 'abc', expected: Buffer.from('900150983cd24fb0d6963f7d28e17f72', 'hex').toString('base64') })).match).toBe('MD5');
    expect((await run({ text: 'abc', expected: 'deadbeef' })).match).toBeNull();
  });
  it('hashes a base64 file input', async () => {
    const r = await run({ file: 'base64:' + Buffer.from('abc').toString('base64') });
    expect(r.hashes.MD5).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});

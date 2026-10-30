/**
 * Shared bits for the AI-helper tools: text input fields and a cached tiktoken encoder.
 */
import { z } from 'zod';

export const ENCODINGS = ['o200k_base', 'cl100k_base'] as const;
export type EncodingName = (typeof ENCODINGS)[number];

export const textField = () => z.string().optional().describe('The text (inline).');
export const pathField = () =>
  z.string().optional().describe('Or: a UTF-8 text/markdown file, as a local path or base64 (raw or a data: URI).');
export const encodingField = () =>
  z.enum(ENCODINGS).optional().default('o200k_base')
    .describe('Tokenizer: "o200k_base" (GPT-4o / o-series, default) or "cl100k_base" (GPT-4 / GPT-3.5 / text-embedding-3).');

export interface Encoder {
  name: EncodingName;
  /** Token ids. Special-token strings like "<|endoftext|>" are counted as plain text. */
  encode(text: string): number[];
  count(text: string): number;
}

const cache = new Map<EncodingName, Promise<Encoder>>();

/** Load a tokenizer once per process (the rank tables are a few MB, so they load lazily). */
export function getEncoder(name: EncodingName = 'o200k_base'): Promise<Encoder> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const { Tiktoken } = await import('js-tiktoken/lite');
      const ranks = name === 'cl100k_base'
        ? (await import('js-tiktoken/ranks/cl100k_base')).default
        : (await import('js-tiktoken/ranks/o200k_base')).default;
      const enc = new Tiktoken(ranks);
      const encode = (text: string) => (text ? enc.encode(text, [], []) : []);
      return { name, encode, count: (text: string) => encode(text).length };
    })();
    cache.set(name, p);
    p.catch(() => cache.delete(name));
  }
  return p;
}

const graphemer = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Characters as people count them (grapheme clusters: an emoji or a letter with marks counts once). Intl.Segmenter slows
 * down badly on very long strings, so the text is segmented in pieces cut after a space or newline.
 */
export function graphemeCount(text: string): number {
  let n = 0;
  for (let a = 0; a < text.length; ) {
    let b = Math.min(text.length, a + 4096);
    if (b < text.length) {
      let k = b;
      while (k > a + 1024 && !(/[ \n]/.test(text[k - 1]) && !/[\p{M}‍️]/u.test(text[k]))) k--;
      if (k > a + 1024) b = k;
      else if (midSurrogate(text, b)) b--;
    }
    for (const _ of graphemer.segment(text.slice(a, b))) n++;
    a = b;
  }
  return n;
}

/** True when index i sits between the two halves of a surrogate pair (never cut there). */
export function midSurrogate(s: string, i: number) {
  if (i <= 0 || i >= s.length) return false;
  const a = s.charCodeAt(i - 1), b = s.charCodeAt(i);
  return a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff;
}

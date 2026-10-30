import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { readInput, readTextInput, writeOutput, withExt } from '../../util/files.js';
import { ToolError } from '../../util/errors.js';
import { encodingField, getEncoder, midSurrogate, pathField, textField, type Encoder } from './_text.js';

/** A span of the source text: [start, end) in JavaScript string indices. */
interface Span { start: number; end: number }
interface Unit extends Span { tokens: number }
interface Section extends Span { headings: string[]; bodyEmpty: boolean }

export interface Chunk {
  index: number;
  text: string;
  tokens: number;
  startChar: number;
  endChar: number;
  headings: string[];
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Lines with their offsets (line end excludes the newline). */
function lines(text: string) {
  const out: { start: number; end: number; s: string }[] = [];
  let i = 0;
  while (i <= text.length) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = text.length;
    const end = j > i && text[j - 1] === '\r' ? j - 1 : j;
    out.push({ start: i, end, s: text.slice(i, end) });
    i = j + 1;
  }
  return out;
}

/** Split into sections at ATX markdown headings (outside code fences), tracking the heading path. */
export function sections(text: string, markdown: boolean): Section[] {
  if (!markdown) return [{ start: 0, end: text.length, headings: [], bodyEmpty: !text.trim() }];
  const ls = lines(text);
  const out: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let cur: Section = { start: 0, end: 0, headings: [], bodyEmpty: true };
  let fence: string | null = null;
  for (const l of ls) {
    const f = FENCE.exec(l.s);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.s.slice(f[0].length).trim()) fence = null;
      cur.bodyEmpty = false;
      continue;
    }
    if (f) { fence = f[1]; cur.bodyEmpty = false; continue; }
    const h = HEADING.exec(l.s);
    if (h) {
      cur.end = l.start;
      if (cur.end > cur.start) out.push(cur);
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: h[2].trim() });
      cur = { start: l.start, end: 0, headings: stack.map((x) => x.title), bodyEmpty: true };
      continue;
    }
    if (l.s.trim()) cur.bodyEmpty = false;
  }
  cur.end = text.length;
  if (cur.end > cur.start) out.push(cur);
  // A heading with no body of its own ("# Guide" right before "## Install") joins the next section.
  const merged: Section[] = [];
  for (let k = 0; k < out.length; k++) {
    const s = out[k];
    const next = out[k + 1];
    if (s.bodyEmpty && s.headings.length && next && next.headings.length > s.headings.length) {
      next.start = s.start;
      continue;
    }
    merged.push(s);
  }
  return merged.filter((s) => text.slice(s.start, s.end).trim());
}

/** Paragraph blocks (blank-line separated; a fenced code block stays one block). Trimmed spans. */
function blocks(text: string, sec: Span): (Span & { code: boolean })[] {
  const ls = lines(text.slice(sec.start, sec.end)).map((l) => ({ ...l, start: l.start + sec.start, end: l.end + sec.start }));
  const out: (Span & { code: boolean })[] = [];
  let cur: (Span & { code: boolean }) | null = null;
  let fence: string | null = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const l of ls) {
    const f = FENCE.exec(l.s);
    if (fence) {
      cur!.end = l.end;
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.s.slice(f[0].length).trim()) { fence = null; flush(); }
      continue;
    }
    if (f) { flush(); fence = f[1]; cur = { start: l.start, end: l.end, code: true }; continue; }
    if (!l.s.trim()) { flush(); continue; }
    if (HEADING.test(l.s)) { flush(); out.push({ start: l.start + (l.s.length - l.s.trimStart().length), end: l.end, code: false }); continue; }
    if (!cur) cur = { start: l.start + (l.s.length - l.s.trimStart().length), end: l.end, code: false };
    else cur.end = l.end;
  }
  flush();
  return out.map((b) => {
    let e = b.end;
    while (e > b.start && /\s/.test(text[e - 1])) e--;
    return { ...b, end: e };
  }).filter((b) => b.end > b.start);
}

const SENT_END = /[.!?؟。！？…]+["'”’)\]]*(?=\s)|\n/g;

/** Sentence spans inside a block (or lines, for code). */
function sentences(text: string, b: Span, byLine: boolean): Span[] {
  const s = text.slice(b.start, b.end);
  const re = byLine ? /\n/g : SENT_END;
  re.lastIndex = 0;
  const out: Span[] = [];
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    const end = m.index + m[0].length;
    if (end > last) out.push({ start: last, end });
    last = end;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < s.length) out.push({ start: last, end: s.length });
  return out.map((x) => {
    let a = x.start, e = x.end;
    while (a < e && /\s/.test(s[a])) a++;
    while (e > a && /\s/.test(s[e - 1])) e--;
    return { start: a + b.start, end: e + b.start };
  }).filter((x) => x.end > x.start);
}

/** Largest end in (start, limit] whose slice has at most `max` tokens, cut at whitespace when possible. */
function hardCut(text: string, start: number, limit: number, max: number, enc: Encoder): number {
  let lo = start + 1, hi = limit, best = start + 1;
  // Start from an estimate so long texts don't tokenise everything at every step.
  hi = Math.min(limit, start + Math.max(16, max * 12));
  while (enc.count(text.slice(start, hi)) <= max && hi < limit) hi = Math.min(limit, start + (hi - start) * 2);
  if (enc.count(text.slice(start, hi)) <= max) return hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (enc.count(text.slice(start, mid)) <= max) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (midSurrogate(text, best)) best--;
  if (best <= start) best = Math.min(limit, start + (midSurrogate(text, start + 1) ? 2 : 1));
  // Prefer a whitespace boundary in the last fifth of the piece.
  const minCut = start + Math.floor((best - start) * 0.8);
  for (let k = best; k > minCut; k--) if (/\s/.test(text[k - 1] ?? '')) return k;
  return best;
}

function hardSplit(text: string, sp: Span, max: number, enc: Encoder): Unit[] {
  const out: Unit[] = [];
  let a = sp.start;
  while (a < sp.end) {
    while (a < sp.end && /\s/.test(text[a])) a++;
    if (a >= sp.end) break;
    const e = hardCut(text, a, sp.end, max, enc);
    let t = e;
    while (t > a && /\s/.test(text[t - 1])) t--;
    out.push({ start: a, end: t, tokens: enc.count(text.slice(a, t)) });
    a = e;
  }
  return out;
}

/** Units no bigger than `max` tokens: paragraphs, else sentences (lines for code), else hard token splits. */
function units(text: string, sec: Section, max: number, enc: Encoder): Unit[] {
  const out: Unit[] = [];
  for (const b of blocks(text, sec)) {
    const t = enc.count(text.slice(b.start, b.end));
    if (t <= max) { out.push({ ...b, tokens: t }); continue; }
    for (const s of sentences(text, b, b.code)) {
      const st = enc.count(text.slice(s.start, s.end));
      if (st <= max) out.push({ ...s, tokens: st });
      else out.push(...hardSplit(text, s, max, enc));
    }
  }
  return out;
}

/** Start of the overlap: the latest point in [start, end) whose tail has at most `want` tokens, snapped to a word start. */
function overlapStart(text: string, start: number, end: number, want: number, enc: Encoder): number | null {
  if (want <= 0) return null;
  let lo = start, hi = end, best = end;
  // Bound the search window: ~12 chars per token is generous for any script.
  lo = Math.max(start, end - want * 12);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (enc.count(text.slice(mid, end)) <= want) { best = mid; hi = mid; } else lo = mid + 1;
  }
  // Snap forward to the next word start (whitespace boundary) so the overlap doesn't open mid-word.
  let k = best;
  if (k > start && !/\s/.test(text[k - 1])) {
    while (k < end && !/\s/.test(text[k])) k++;
  }
  while (k < end && /\s/.test(text[k])) k++;
  if (midSurrogate(text, k)) k++;
  return k < end ? k : null;
}

export async function chunkText(
  text: string,
  opts: { maxTokens: number; overlapTokens: number; markdown: boolean; enc: Encoder },
): Promise<Chunk[]> {
  const { maxTokens: max, overlapTokens: overlap, enc } = opts;
  const chunks: Chunk[] = [];
  for (const sec of sections(text, opts.markdown)) {
    const us = units(text, sec, max, enc);
    let i = 0;
    let carry: number | null = null;
    while (i < us.length) {
      let start: number = carry ?? us[i].start;
      let used = carry != null ? enc.count(text.slice(carry, us[i].start)) : 0;
      if (carry != null && used + us[i].tokens > max) { start = us[i].start; used = 0; }
      let j = i;
      let approx = used;
      while (j < us.length) {
        const add = us[j].tokens + (j > i || carry != null ? 1 : 0);
        if (j > i && approx + add > max) break;
        approx += add;
        j++;
      }
      // Verify the exact count of the joined slice; drop units from the end if separators pushed it over.
      let end = us[j - 1].end;
      let tokens = enc.count(text.slice(start, end));
      while (tokens > max && j - 1 > i) {
        j--;
        end = us[j - 1].end;
        tokens = enc.count(text.slice(start, end));
      }
      if (tokens > max && start !== us[i].start) {
        start = us[i].start;
        tokens = enc.count(text.slice(start, end));
      }
      chunks.push({ index: chunks.length, text: text.slice(start, end), tokens, startChar: start, endChar: end, headings: sec.headings });
      i = j;
      carry = i < us.length ? overlapStart(text, start, end, Math.min(overlap, max - 1), enc) : null;
      if (carry != null && carry <= start) carry = null;
    }
  }
  return chunks;
}

export default defineTool({
  name: 'ai_chunk_text',
  title: 'Chunk text for RAG',
  description:
    'Split text, markdown or a text file into token-sized chunks for retrieval (RAG) and embeddings. Splits at markdown ' +
    'headings (ATX "#" headings, never inside code fences) and paragraphs first, then sentences (lines inside code blocks), ' +
    'and only cuts mid-sentence when a single sentence is longer than maxTokens. Consecutive chunks of the same section share ' +
    'about overlapTokens of text. Each chunk returns index, text, tokens, startChar/endChar (JavaScript string offsets, end ' +
    'exclusive, so text === source.slice(startChar, endChar) once CRLF line endings are normalised to \\n) and the heading path it sits under. Tokens are counted with ' +
    'tiktoken (o200k_base by default; for Claude treat counts as estimates). Give "text" or "path" (file path or base64); ' +
    'give "output" to also write the chunks as JSONL (one JSON object per line).',
  inputSchema: z.object({
    text: textField(),
    path: pathField(),
    maxTokens: z.number().int().min(16).max(32_000).optional().default(500).describe('Largest chunk, in tokens. Default 500.'),
    overlapTokens: z.number().int().min(0).max(8_000).optional().default(50).describe('Tokens repeated from the end of the previous chunk (same section only). Default 50. Must be below maxTokens.'),
    markdown: z.boolean().optional().default(true).describe('Treat "#" lines as section headings (default true). Set false for plain text.'),
    encoding: encodingField(),
    output: z.string().optional().describe('Also write the chunks as JSONL to this file (or folder ending in "/").'),
    includeText: z.boolean().optional().describe('Return each chunk\'s text inline. Default: true, or false when "output" is given.'),
    maxChunks: z.number().int().min(1).optional().default(2000).describe('Most chunks to return inline (the JSONL file always has all). Default 2000.'),
  }),
  outputSchema: z.object({
    chunkCount: z.number(),
    totalTokens: z.number().describe('Tokens in the whole source text.'),
    encoding: z.string(),
    maxTokens: z.number(),
    overlapTokens: z.number(),
    chunks: z.array(z.object({
      index: z.number(), text: z.string().optional(), tokens: z.number(), startChar: z.number(), endChar: z.number(), headings: z.array(z.string()),
    })),
    truncated: z.boolean().optional(),
    path: z.string().optional(),
    bytes: z.number().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: '# Guide\n\n## Install\n\nRun npm install.\n\n## Use\n\nCall the tool.', maxTokens: 100, overlapTokens: 0 }, note: 'Two chunks, headings ["Guide","Install"] and ["Guide","Use"].' },
    { input: { path: 'handbook.md', maxTokens: 400, overlapTokens: 40, output: 'chunks.jsonl' } },
  ],
  async run(input, ctx) {
    if (input.overlapTokens >= input.maxTokens) throw new ToolError('overlapTokens must be smaller than maxTokens.');
    let raw: string;
    let base = 'chunks.jsonl';
    if (input.text == null && input.path) {
      const f = await readInput(input.path, ctx, 'path');
      raw = f.bytes.toString('utf8').replace(/^﻿/, '');
      if (f.path) base = withExt(f.name, '.chunks.jsonl');
    } else raw = await readTextInput(input.text, input.path, ctx);
    const text = raw.replace(/\r\n?/g, '\n');
    const enc = await getEncoder(input.encoding);
    const chunks = await chunkText(text, { maxTokens: input.maxTokens, overlapTokens: input.overlapTokens, markdown: input.markdown, enc });
    const result: Record<string, unknown> = {
      chunkCount: chunks.length,
      totalTokens: enc.count(text),
      encoding: enc.name,
      maxTokens: input.maxTokens,
      overlapTokens: input.overlapTokens,
    };
    if (input.output) {
      const jsonl = chunks.map((c) => JSON.stringify(c)).join('\n') + (chunks.length ? '\n' : '');
      const w = await writeOutput(jsonl, { output: input.output, defaultName: base, mimeType: 'application/jsonl' }, ctx);
      result.path = w.path;
      result.bytes = w.bytes;
    }
    const withText = input.includeText ?? !input.output;
    result.chunks = chunks.slice(0, input.maxChunks).map(({ text: t, ...rest }) => (withText ? { ...rest, text: t } : rest));
    if (chunks.length > input.maxChunks) result.truncated = true;
    return result;
  },
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { readTextInput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/diff-view (app.js): Myers O(ND) diff on lines, then again on words
// inside changed line pairs; unified output with 3 lines of context, exactly like the website.
const CONTEXT = 3;

export type Op = { t: '='; a: number; b: number } | { t: '-'; a: number } | { t: '+'; b: number };

/** Myers diff. Returns ops in order; a/b are indexes into the inputs. */
export function diff(A: readonly string[], B: readonly string[], maxD = Infinity): Op[] {
  let pre = 0, ea = A.length, eb = B.length;
  while (pre < ea && pre < eb && A[pre] === B[pre]) pre++;
  while (ea > pre && eb > pre && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a = A.slice(pre, ea), b = B.slice(pre, eb), n = a.length, m = b.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
  let D = 0;
  outer: for (let d = 0; d <= max; d++) {
    if (d > maxD) throw new ToolError(`The texts differ in more than ${maxD.toLocaleString('en')} lines; too many changes to diff.`);
    trace.push(v.slice(off - d, off + d + 1)); // snapshot covering k ∈ [-d, d]
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { D = d; break outer; }
    }
  }
  const mid: Op[] = [];
  let cx = n, cy = m;
  for (let dd = D; dd >= 0; dd--) {
    const tv = trace[dd], kk = cx - cy, at = (k: number) => tv[k + dd];
    const pk = (kk === -dd || (kk !== dd && at(kk - 1) < at(kk + 1))) ? kk + 1 : kk - 1;
    const px = dd === 0 ? 0 : at(pk), py = dd === 0 ? 0 : px - pk;
    while (cx > px && cy > py) { cx--; cy--; mid.push({ t: '=', a: cx + pre, b: cy + pre }); }
    if (dd > 0) { if (cx === px) mid.push({ t: '+', b: py + pre }); else mid.push({ t: '-', a: px + pre }); }
    cx = px; cy = py;
  }
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: '=', a: i, b: i });
  for (let j = mid.length - 1; j >= 0; j--) ops.push(mid[j]);
  for (let s = 0; s < A.length - ea; s++) ops.push({ t: '=', a: ea + s, b: eb + s });
  return ops;
}

export function lines(t: string) { if (!t) return []; const l = t.split(/\r?\n/); if (l[l.length - 1] === '') l.pop(); return l; }
export function keyer(o: { ws?: boolean; ic?: boolean }) {
  return (s: string) => { if (o.ws) s = s.replace(/\s+/g, ' ').trim(); if (o.ic) s = s.toLowerCase(); return s; };
}

export function unified(aL: readonly string[], bL: readonly string[], ops: Op[], nameA?: string, nameB?: string) {
  const out = ['--- ' + (nameA || 'original'), '+++ ' + (nameB || 'changed')], posA: number[] = [], posB: number[] = [];
  let i = 0, pa = 0, pb = 0;
  ops.forEach((o, k) => { posA[k] = pa; posB[k] = pb; if (o.t !== '+') pa++; if (o.t !== '-') pb++; });
  while (i < ops.length) {
    while (i < ops.length && ops[i].t === '=') i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    for (;;) { // extend through changes closer than 2*CONTEXT equal lines apart
      while (end < ops.length && ops[end].t !== '=') end++;
      let e = end; while (e < ops.length && ops[e].t === '=' && e - end < 2 * CONTEXT + 1) e++;
      if (e < ops.length && ops[e].t !== '=' && e - end <= 2 * CONTEXT) { end = e; continue; }
      end = Math.min(ops.length, end + CONTEXT); break;
    }
    let ca = 0, cb = 0;
    const body: string[] = [];
    for (let k = start; k < end; k++) {
      const o = ops[k];
      if (o.t === '=') { body.push(' ' + aL[o.a]); ca++; cb++; }
      else if (o.t === '-') { body.push('-' + aL[o.a]); ca++; }
      else { body.push('+' + bL[o.b]); cb++; }
    }
    const sa = ca ? posA[start] + 1 : posA[start], sb = cb ? posB[start] + 1 : posB[start];
    out.push('@@ -' + (ca === 1 ? sa : sa + ',' + ca) + ' +' + (cb === 1 ? sb : sb + ',' + cb) + ' @@');
    out.push(...body);
    i = end;
  }
  return out.length > 2 ? out.join('\n') + '\n' : '';
}

// ---------- word-level highlight ----------
type Part = [string, 0 | 1];
function tokens(s: string) { return s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || []; }
export function wordDiff(l: string, r: string, key: (s: string) => string): [Part[], Part[]] | null {
  const ta = tokens(l), tb = tokens(r);
  if (ta.length * tb.length > 4e6) return null; // very long lines: line-level only
  const ops = diff(ta.map(key), tb.map(key)), L: Part[] = [], R: Part[] = [];
  ops.forEach((o) => {
    if (o.t === '=') { L.push([ta[o.a], 0]); R.push([tb[o.b], 0]); }
    else if (o.t === '-') L.push([ta[o.a], 1]); else R.push([tb[o.b], 1]);
  });
  return [L, R];
}
/** Merge neighbours so "Oat milk" is one highlight (as the website does), then mark changed runs. */
function mark(parts: Part[], open: string, close: string) {
  const merged = parts.reduce<Part[]>((acc, p) => {
    const l = acc[acc.length - 1];
    if (l && l[1] === p[1]) l[0] += p[0]; else acc.push([p[0], p[1]]);
    return acc;
  }, []);
  return merged.map((p) => (p[1] ? open + p[0] + close : p[0])).join('');
}

interface ChangeLine { line: number; text: string; marked?: string }
interface ChangeBlock { removed: ChangeLine[]; added: ChangeLine[] }

/** Change blocks pair the i-th removed line with the i-th added line (like the website's rows). */
function changeBlocks(aL: string[], bL: string[], ops: Op[], key: (s: string) => string, words: boolean): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === '=') { i++; continue; }
    const del: number[] = [], ins: number[] = [];
    while (i < ops.length && ops[i].t !== '=') { const o = ops[i]; if (o.t === '-') del.push(o.a); else if (o.t === '+') ins.push(o.b); i++; }
    const block: ChangeBlock = { removed: del.map((a) => ({ line: a + 1, text: aL[a] })), added: ins.map((b) => ({ line: b + 1, text: bL[b] })) };
    if (words) {
      for (let p = 0; p < Math.min(del.length, ins.length); p++) {
        const w = wordDiff(aL[del[p]], bL[ins[p]], key);
        if (w) { block.removed[p].marked = mark(w[0], '[-', '-]'); block.added[p].marked = mark(w[1], '{+', '+}'); }
      }
    }
    blocks.push(block);
  }
  return blocks;
}

export function compare(aText: string, bText: string, o: { ws?: boolean; ic?: boolean; nameA?: string; nameB?: string; words?: boolean; maxD?: number } = {}) {
  const key = keyer(o), aL = lines(aText), bL = lines(bText);
  const ops = diff(aL.map(key), bL.map(key), o.maxD);
  let added = 0, removed = 0, unchanged = 0;
  ops.forEach((op) => { if (op.t === '+') added++; else if (op.t === '-') removed++; else unchanged++; });
  return {
    identical: !added && !removed, added, removed, unchanged,
    unified: unified(aL, bL, ops, o.nameA, o.nameB),
    changes: changeBlocks(aL, bL, ops, key, o.words !== false),
  };
}

const MAX_LINES = 50_000;
const MAX_EDITS = 10_000; // Myers keeps O(D²) memory: cap the edit distance

const lineSchema = z.object({ line: z.number(), text: z.string(), marked: z.string().optional() });

export default defineTool({
  name: 'text_diff',
  title: 'Diff two texts',
  webSlug: 'diff-view',
  description:
    'Compare two texts line by line (Myers diff) and return a unified diff (3 lines of context, like `diff -u`), counts of ' +
    'added/removed/unchanged lines, and change blocks where each removed line is paired with the added line that replaced it ' +
    'and the changed words are marked [-old-] / {+new+}. Can ignore whitespace and case. Works with any language (Arabic ' +
    `included). Up to ${MAX_LINES.toLocaleString('en')} lines per side. Web version: ${webUrl('diff-view')}`,
  inputSchema: z.object({
    original: z.string().optional().describe('The original text ("before").'),
    originalPath: z.string().optional().describe('Or: path to the original text file.'),
    changed: z.string().optional().describe('The changed text ("after").'),
    changedPath: z.string().optional().describe('Or: path to the changed text file.'),
    ignoreWhitespace: z.boolean().optional().default(false).describe('Treat lines that differ only in spacing as equal.'),
    ignoreCase: z.boolean().optional().default(false).describe('Treat lines that differ only in letter case as equal.'),
    wordDiff: z.boolean().optional().default(true).describe('Mark the changed words inside paired lines (default true).'),
    nameA: z.string().optional().describe('Label for the "---" header (default "original").'),
    nameB: z.string().optional().describe('Label for the "+++" header (default "changed").'),
  }),
  outputSchema: z.object({
    identical: z.boolean().describe('True when there is no difference (with the ignore options applied).'),
    added: z.number(), removed: z.number(), unchanged: z.number(),
    unified: z.string().describe('Unified diff text (empty when identical).'),
    changes: z.array(z.object({ removed: z.array(lineSchema), added: z.array(lineSchema) })).describe('Change blocks; line numbers are 1-based.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: { original: 'one\ntwo\nthree', changed: 'zero\none\nthree' },
      output: {
        identical: false, added: 1, removed: 1, unchanged: 2,
        unified: '--- original\n+++ changed\n@@ -1,3 +1,3 @@\n+zero\n one\n-two\n three\n',
        changes: [{ removed: [], added: [{ line: 1, text: 'zero' }] }, { removed: [{ line: 2, text: 'two' }], added: [] }],
      },
    },
    { input: { original: 'the quick fox', changed: 'the slow fox' }, note: 'changes[0]: removed marked "the [-quick-] fox", added marked "the {+slow+} fox"' },
  ],
  async run(input, ctx) {
    if (input.original == null && !input.originalPath) throw new ToolError('Give "original" or "originalPath".');
    if (input.changed == null && !input.changedPath) throw new ToolError('Give "changed" or "changedPath".');
    const a = await readTextInput(input.original, input.originalPath, ctx);
    const b = await readTextInput(input.changed, input.changedPath, ctx);
    const na = lines(a).length, nb = lines(b).length;
    if (na > MAX_LINES || nb > MAX_LINES) throw new ToolError(`Too many lines (${Math.max(na, nb)}); the limit is ${MAX_LINES} per side.`);
    return compare(a, b, { ws: input.ignoreWhitespace, ic: input.ignoreCase, nameA: input.nameA, nameB: input.nameB, words: input.wordDiff, maxD: MAX_EDITS });
  },
});

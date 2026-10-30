/**
 * Shared helpers for the `ai_*_to_markdown` tools: HTML parsing (linkedom), main-content extraction (Readability),
 * HTML -> Markdown (turndown with GFM tables and strikethrough), word counts, and the inline-or-file output step.
 * Heavy libraries load lazily so server startup stays fast.
 */
import { z } from 'zod';
import { writeOutput } from '../../util/files.js';
import { ToolError } from '../../util/errors.js';
import type { ToolContext } from '../../util/context.js';
import { words } from '../web/text/word-count.js';

export const DEFAULT_MAX_CHARS = 200_000;

export const maxCharsInput = () =>
  z.number().int().min(1000).optional().default(DEFAULT_MAX_CHARS)
    .describe(`Cut the inline Markdown after this many characters, with a note (a file written with "output" is never cut). Default ${DEFAULT_MAX_CHARS}.`);

export const mdOutputInput = () =>
  z.string().optional().describe('Write the Markdown to this file (or folder ending in "/") and return its path instead of the inline text.');

/** Fields every *_to_markdown tool returns for the Markdown itself. */
export const mdOutputShape = {
  markdown: z.string().optional().describe('The Markdown (absent when written to "output").'),
  truncated: z.boolean().optional().describe('True when the inline Markdown was cut at maxChars.'),
  characters: z.number().describe('Length of the full Markdown in characters.'),
  words: z.number().describe('Words in the text (link URLs not counted).'),
  path: z.string().optional().describe('Written file, when "output" was given.'),
  bytes: z.number().optional(),
};

/** Words in Markdown, ignoring link/image targets and markup. */
export function countMdWords(md: string) {
  const plain = md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, ']')
    .replace(/<[^>]+>/g, ' ');
  return words(plain).length;
}

/** Return the Markdown inline (cut at maxChars with a note) or write it to `output`. */
export async function emitMarkdown(md: string, opts: { output?: string; maxChars: number; defaultName: string }, ctx: ToolContext) {
  const out: { markdown?: string; truncated?: boolean; characters: number; words: number; path?: string; bytes?: number } = {
    characters: md.length,
    words: countMdWords(md),
  };
  if (opts.output) {
    const w = await writeOutput(md, { output: opts.output, defaultName: opts.defaultName, mimeType: 'text/markdown' }, ctx);
    out.path = w.path;
    out.bytes = w.bytes;
  } else if (md.length > opts.maxChars) {
    // Cut at a line break near the limit when there is one, so tables and paragraphs stay whole.
    let cut = md.lastIndexOf('\n', opts.maxChars);
    if (cut < opts.maxChars * 0.8) cut = opts.maxChars;
    out.markdown = md.slice(0, cut).trimEnd() +
      `\n\n[... truncated: showing ${cut.toLocaleString('en')} of ${md.length.toLocaleString('en')} characters. Give "output" to save the whole Markdown to a file.]\n`;
    out.truncated = true;
  } else {
    out.markdown = md;
    out.truncated = false;
  }
  return out;
}

/** File name without extension (for default output names); `fallback` for base64 input, which has no name. */
export function stemOf(f: { name: string; path?: string }, fallback: string) {
  if (!f.path) return fallback;
  return f.name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || fallback;
}

/** Tidy Markdown: no runs of blank lines, no trailing spaces, one final newline. */
export function tidyMd(md: string) {
  return md.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Escape a cell for a GFM table. */
export function cell(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

/** A GFM table from rows of plain cell strings (first row is the header). */
export function mdTable(rows: string[][]) {
  if (!rows.length) return '';
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '');
  const line = (r: string[]) => '| ' + pad(r).join(' | ') + ' |';
  return [line(rows[0]), '|' + ' --- |'.repeat(cols), ...rows.slice(1).map(line)].join('\n');
}

// ---------- HTML ----------

// Only the DOM bits used here (the project compiles without the DOM lib).
interface LEl {
  getAttribute(n: string): string | null; setAttribute(n: string, v: string): void; remove(): void;
  contains(o: LEl): boolean; outerHTML: string; innerHTML: string; textContent: string | null;
}
interface LDoc {
  querySelector(s: string): LEl | null; querySelectorAll(s: string): ArrayLike<LEl>;
  documentElement: LEl | null; body: LEl | null; toString(): string;
}

/** Parse HTML with linkedom (fragments are wrapped in a document). */
export async function parseHtml(html: string): Promise<LDoc> {
  const { parseHTML } = await import('linkedom');
  const full = /<html[\s>]/i.test(html) || /<body[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  return parseHTML(full).document as unknown as LDoc;
}

const JUNK = 'script,style,noscript,template,iframe,object,embed,canvas,svg,link,meta';

/** Make link and image URLs absolute against `base`. */
function absolutize(doc: LDoc, base?: string) {
  if (!base) return;
  for (const [sel, attr] of [['a[href]', 'href'], ['img[src]', 'src']] as const) {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      const v = el.getAttribute(attr);
      if (!v || /^(#|javascript:|data:|mailto:|tel:)/i.test(v)) continue;
      try { el.setAttribute(attr, new URL(v, base).href); } catch { /* leave as is */ }
    }
  }
}

export interface ExtractOptions {
  /** CSS selector: convert only the matching elements (all matches, in order). */
  selector?: string;
  /** Keep only the main content (Readability), falling back to the whole body. */
  readable?: boolean;
  /** Base URL to resolve relative links and images. */
  baseUrl?: string;
  /** Keep links and images (default true). When false, links become plain text and images are dropped. */
  includeLinks?: boolean;
}

export interface Extracted {
  title?: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
  lang?: string;
  publishedTime?: string;
  /** How the content was picked: 'selector', 'readability' or 'body'. */
  source: 'selector' | 'readability' | 'body';
  markdown: string;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim() || undefined;

/** HTML -> Markdown with optional main-content extraction. */
export async function htmlToMarkdown(html: string, opts: ExtractOptions = {}): Promise<Extracted> {
  const doc = await parseHtml(html);
  absolutize(doc, opts.baseUrl);
  const docTitle = clean(doc.querySelector('title')?.textContent) ?? clean(doc.querySelector('h1')?.textContent);
  const meta = (n: string) => clean(doc.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.getAttribute('content'));
  const lang = clean(doc.documentElement?.getAttribute('lang'));
  let body: string | undefined;
  let source: Extracted['source'] = 'body';
  let info: Partial<Extracted> = {};

  if (opts.selector) {
    let found: LEl[];
    try {
      found = Array.from(doc.querySelectorAll(opts.selector));
    } catch {
      throw new ToolError(`Bad CSS selector "${opts.selector}".`);
    }
    if (!found.length) throw new ToolError(`No element matches the selector "${opts.selector}".`);
    // Skip matches nested inside another match so nothing is converted twice.
    body = found.filter((el) => !found.some((o) => o !== el && o.contains(el))).map((el) => el.outerHTML).join('\n');
    source = 'selector';
  } else if (opts.readable) {
    const { Readability } = await import('@mozilla/readability');
    const copy = await parseHtml(doc.toString());
    let art: ReturnType<InstanceType<typeof Readability<string>>['parse']> = null;
    try {
      art = new Readability<string>(copy as never, { charThreshold: 200 }).parse();
    } catch {
      art = null;
    }
    if (art?.content && (art.textContent ?? '').trim().length >= 50) {
      body = art.content;
      source = 'readability';
      info = {
        title: clean(art.title) ?? docTitle, byline: clean(art.byline), excerpt: clean(art.excerpt),
        siteName: clean(art.siteName), lang: clean(art.lang) ?? lang, publishedTime: clean(art.publishedTime),
      };
    }
  }
  if (body == null) {
    for (const el of Array.from(doc.querySelectorAll(JUNK))) el.remove();
    body = doc.body?.innerHTML ?? doc.toString();
  }
  const markdown = await turndownHtml(body ?? '', opts.includeLinks !== false);
  return {
    title: docTitle, byline: meta('author'), excerpt: meta('description') ?? meta('og:description'),
    siteName: meta('og:site_name'), lang, ...stripUndef(info), source, markdown,
  };
}

function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// turndown runs on domino nodes; only the bits used here are typed.
interface TNode { nodeName: string; nodeType: number; childNodes: ArrayLike<TNode>; innerHTML: string; textContent: string | null; getAttribute(n: string): string | null }
type TService = import('turndown');
let svc: Promise<{ withLinks: TService; noLinks: TService }> | undefined;

async function services() {
  svc ??= (async () => {
    const { default: Turndown } = await import('turndown');
    const make = (links: boolean) => {
      const t = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '_', hr: '---' });
      t.remove(JUNK.split(',').concat(['button', 'select', 'input', 'textarea', 'form']) as never);
      t.addRule('strike', {
        filter: ['del', 's', 'strike'],
        replacement: (c) => (c.trim() ? `~~${c}~~` : ''),
      });
      // "- item" / "1. item" with one space (turndown's default pads markers to 4 columns).
      t.addRule('listItem', {
        filter: 'li',
        replacement: (content, node) => {
          const n = node as unknown as TNode & { parentNode: TNode & { children: ArrayLike<unknown> }; nextSibling: unknown };
          const parent = n.parentNode;
          let prefix = '- ';
          if (parent && parent.nodeName.toUpperCase() === 'OL') {
            const start = Number(parent.getAttribute('start') ?? '1') || 1;
            prefix = start + Array.prototype.indexOf.call(parent.children, node) + '. ';
          }
          const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n' + ' '.repeat(prefix.length));
          return prefix + body + (n.nextSibling && !/\n$/.test(body) ? '\n' : '');
        },
      });
      t.addRule('table', {
        filter: 'table',
        replacement: (_c, node) => '\n\n' + tableToMd(node as unknown as TNode, t) + '\n\n',
      });
      if (!links) {
        t.addRule('plainLinks', { filter: 'a', replacement: (c) => c });
        t.addRule('noImages', { filter: 'img', replacement: () => '' });
      }
      return t;
    };
    return { withLinks: make(true), noLinks: make(false) };
  })();
  return svc;
}

const kids = (n: TNode) => Array.from(n.childNodes).filter((c) => c.nodeType === 1);

function tableToMd(table: TNode, t: TService) {
  const rows: TNode[] = [];
  for (const c of kids(table)) {
    const name = c.nodeName.toUpperCase();
    if (name === 'TR') rows.push(c);
    else if (name === 'THEAD' || name === 'TBODY' || name === 'TFOOT') {
      const trs = kids(c).filter((r) => r.nodeName.toUpperCase() === 'TR');
      rows.push(...trs);
    }
  }
  if (!rows.length) return '';
  const grid = rows.map((r) => kids(r).filter((x) => /^(TD|TH)$/i.test(x.nodeName)).map((x) => cell(t.turndown(x.innerHTML).replace(/\n+/g, ' '))));
  // GFM needs a header row: the first row serves as one even without <thead>/<th>.
  return mdTable(grid.filter((r) => r.length));
}

/** Convert an HTML string to tidy Markdown. */
export async function turndownHtml(html: string, includeLinks = true) {
  const s = await services();
  return tidyMd((includeLinks ? s.withLinks : s.noLinks).turndown(html || ''));
}

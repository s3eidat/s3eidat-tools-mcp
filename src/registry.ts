/**
 * Tool registry: the contract every tool module follows, and auto-discovery.
 *
 * One file per tool under `src/tools/<group>/.../<slug>.ts`. Each file has a default export made with
 * `defineTool({...})` (or an array of them, for a family of tiny tools that share code). Nothing else
 * needs editing: `loadTools()` walks the `tools/` folder at startup and picks up every module.
 *
 *   import { z } from 'zod';
 *   import { defineTool } from '../../../registry.js';
 *
 *   export default defineTool({
 *     name: 'text_word_count',                 // snake_case, group prefix
 *     title: 'Word count',
 *     description: 'Counts words… Web version: https://s3eidat.github.io/word-count/',
 *     webSlug: 'word-count',                   // optional, links the human web tool
 *     inputSchema: z.object({ text: z.string() }),
 *     outputSchema: z.object({ words: z.number() }),   // optional, enables structuredContent
 *     annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
 *     examples: [{ input: { text: 'hi there' }, output: { words: 2 } }], // optional, used in docs
 *     run: async (input, ctx) => ({ words: 2 }),
 *   });
 *
 * `run` returns either a plain object (sent as JSON text, and as structuredContent when `outputSchema`
 * is set), a string (sent as text), or a full MCP `CallToolResult` (anything with a `content` array).
 * Throw `ToolError` (or any Error) for a clean `isError: true` result.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { z } from 'zod';
import type { ToolContext } from './util/context.js';

export type { ToolContext } from './util/context.js';

export interface ToolAnnotations {
  /** The tool does not change anything outside the output files it is asked to write. */
  readOnlyHint?: boolean;
  /** The tool may overwrite or delete user data. */
  destructiveHint?: boolean;
  /** Calling it twice with the same input gives the same result. */
  idempotentHint?: boolean;
  /** The tool talks to the outside world (network). Website ports are always false. */
  openWorldHint?: boolean;
}

export interface ToolExample {
  input: Record<string, unknown>;
  output?: unknown;
  note?: string;
}

/** A content block as MCP sends it (text, image, audio, resource, resource_link). */
export type ContentBlock = { type: string; [key: string]: unknown };

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ZodObjectAny = z.ZodObject<z.ZodRawShape>;

export interface ToolModule<I extends ZodObjectAny = ZodObjectAny, O extends ZodObjectAny = ZodObjectAny> {
  /** snake_case with a group prefix: `pdf_merge`, `image_resize`, `text_case`… */
  name: string;
  /** Short human title. */
  title: string;
  /** What it does, its limits, and the matching web tool URL for humans. */
  description: string;
  /** Slug of the matching tool on https://s3eidat.github.io/<slug>/ (if any). */
  webSlug?: string;
  /** Docs grouping (e.g. "pdf", "image", "ai"). Filled in from the folder by loadTools() when not set. */
  group?: string;
  inputSchema: I;
  outputSchema?: O;
  annotations: ToolAnnotations;
  examples?: ToolExample[];
  run: (input: z.infer<I>, ctx: ToolContext) => Promise<unknown> | unknown;
}

export { ToolError } from './util/errors.js';

/** Identity helper that gives `run` typed input. */
export function defineTool<I extends ZodObjectAny, O extends ZodObjectAny = ZodObjectAny>(
  tool: ToolModule<I, O>,
): ToolModule<I, O> {
  return tool;
}

export const WEB_BASE = 'https://s3eidat.github.io';
export const webUrl = (slug: string) => `${WEB_BASE}/${slug}/`;

const NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function isToolModule(x: unknown): x is ToolModule {
  const t = x as ToolModule;
  return !!t && typeof t === 'object' && typeof t.name === 'string' && typeof t.run === 'function' && !!t.inputSchema;
}

const here = dirname(fileURLToPath(import.meta.url));
const MODULE_RE = /\.(js|ts|mjs)$/;
const SKIP_RE = /\.(d\.ts|test\.ts|spec\.ts|map)$/;

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (MODULE_RE.test(e.name) && !SKIP_RE.test(e.name) && !e.name.startsWith('_')) out.push(p);
  }
  return out;
}

let cache: Promise<ToolModule[]> | undefined;

/**
 * Discover and load every tool module under `tools/` (next to this file, so it works from `src/` in
 * tests and from `dist/` when installed). Files starting with `_` are treated as shared helpers.
 */
export function loadTools(toolsDir = join(here, 'tools')): Promise<ToolModule[]> {
  if (toolsDir === join(here, 'tools') && cache) return cache;
  const p = (async () => {
    const files = await walk(toolsDir);
    const tools: ToolModule[] = [];
    const seen = new Map<string, string>();
    for (const file of files) {
      const mod = await import(pathToFileURL(file).href);
      const exp = mod.default ?? mod.tools ?? mod.tool;
      const list = Array.isArray(exp) ? exp : exp ? [exp] : [];
      for (const t of list) {
        if (!isToolModule(t)) throw new Error(`${file}: default export is not a tool (use defineTool)`);
        if (!NAME_RE.test(t.name)) throw new Error(`${file}: tool name "${t.name}" must be snake_case with a group prefix`);
        if (seen.has(t.name)) throw new Error(`Duplicate tool name "${t.name}" in ${file} and ${seen.get(t.name)}`);
        seen.set(t.name, file);
        if (!t.group) {
          const parts = relative(toolsDir, dirname(file)).split(sep);
          t.group = (parts[0] === 'web' ? parts[1] : parts[0]) || 'misc';
        }
        tools.push(t);
      }
    }
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  })();
  if (toolsDir === join(here, 'tools')) cache = p;
  return p;
}

/** Turn whatever `run` returned into an MCP CallToolResult. */
export function toCallToolResult(tool: ToolModule, value: unknown): CallToolResult {
  if (value && typeof value === 'object' && Array.isArray((value as CallToolResult).content)) {
    return value as CallToolResult;
  }
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const result: CallToolResult = { content: [{ type: 'text', text }] };
  if (tool.outputSchema && value && typeof value === 'object' && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

/** Run a tool by hand (validates input with its schema). Handy in tests and scripts. */
export async function runTool(tool: ToolModule, input: unknown, ctx?: Partial<ToolContext>) {
  const { defaultContext } = await import('./util/context.js');
  const parsed = tool.inputSchema.parse(input);
  return tool.run(parsed, { ...defaultContext(), ...ctx });
}

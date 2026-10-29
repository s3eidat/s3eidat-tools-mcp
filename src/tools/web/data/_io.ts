/**
 * Shared bits for the data-format tools: inline-or-file text input, optional output file, error context.
 */
import { z } from 'zod';
import { ToolError, type ToolContext } from '../../../registry.js';
import { outputPath, readTextInput, writeOutput } from '../../../util/files.js';

/** Results longer than this are written to a file even when no "output" is given. */
export const INLINE_MAX = 1_000_000;

export const textField = (what: string) => z.string().optional().describe(`The ${what} as inline text.`);
export const pathField = (what: string) => z.string().optional().describe(`Or: a path to a ${what} file (UTF-8; use this for big inputs).`);
export const outputField = () => outputPath().describe(
  'Optional: also write the result to this file path (or folder ending in "/"). The result text is then left out of the reply. ' +
  `Results over ${INLINE_MAX.toLocaleString('en-US')} characters are always written to a file.`,
);

export const resultShape = {
  result: z.string().optional().describe('The converted / formatted text (left out when written to a file).'),
  path: z.string().optional().describe('Absolute path of the written file, when "output" was given or the result was too big to inline.'),
  bytes: z.number().optional().describe('Size of the written file in bytes.'),
};

/** Read "text" or "path" (strips a UTF-8 BOM). */
export async function readText(input: { text?: string; path?: string }, ctx: ToolContext): Promise<string> {
  const t = await readTextInput(input.text, input.path, ctx);
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/** Inline the result, or write it to a file when asked (or when it is too big). */
export async function deliver(
  text: string,
  opts: { output?: string; defaultName: string; mimeType?: string },
  ctx: ToolContext,
): Promise<{ result?: string; path?: string; bytes?: number }> {
  if (!opts.output && text.length <= INLINE_MAX) return { result: text };
  const w = await writeOutput(text, { output: opts.output, defaultName: opts.defaultName, mimeType: opts.mimeType }, ctx);
  return { path: w.path, bytes: w.bytes };
}

/** A few lines around line:col with a caret, like the website's error view. */
export function errorContext(text: string, line: number, col: number): string {
  const lines = text.split('\n');
  const from = Math.max(0, line - 4), to = Math.min(lines.length, line + 2);
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    out.push(String(i + 1).padStart(4) + ' │ ' + lines[i]);
    if (i + 1 === line) out.push(' '.repeat(Math.max(0, 6 + col)) + '^');
  }
  return out.join('\n');
}

/** Throw a ToolError with "what error at line L, column C: msg" plus the context lines. */
export function failAt(what: string, msg: string, text: string, at: { line: number; col: number } | null): never {
  if (!at) throw new ToolError(`${what}: ${msg}`);
  throw new ToolError(`${what} at line ${at.line}, column ${at.col}: ${msg}\n\n${errorContext(text, at.line, at.col)}`);
}

/** Indent option shared by the formatters: a number of spaces or "tab". */
export const indentField = (def: '2' | '4' | 'tab' = '2') =>
  z.union([z.enum(['2', '4', 'tab']), z.number().int().min(0).max(8)]).optional().default(def)
    .describe('Indentation: 2, 4, "tab" (or any number of spaces 0-8).');

export function indentUnit(v: string | number): string {
  return v === 'tab' ? '\t' : ' '.repeat(+v);
}

export const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

/**
 * File in / file out helpers shared by every tool that touches files.
 *
 * Inputs accept a local path or base64 (raw or a `data:` URI). Outputs are written to the path the caller
 * gives (a file path, or a folder ending in `/`) or to the server's output folder, and tools return the
 * path plus small metadata, never big base64 blobs unless the caller asks for them.
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ToolError } from './errors.js';
import type { ToolContext } from './context.js';

/** Zod schema for a file input: local path or base64. */
export const fileInput = (what = 'file') =>
  z
    .string()
    .min(1)
    .describe(`The ${what}: a local file path (absolute, or relative to the server's --root) or base64 data (raw or a data: URI).`);

/** Zod schema for an optional output path. */
export const outputPath = () =>
  z
    .string()
    .optional()
    .describe('Where to write the result: a file path, or a folder ending in "/". Default: the server output folder (a temp folder unless --out-dir is set).');

export const returnBase64 = () =>
  z.boolean().optional().default(false).describe('Also return the output as base64 in the result (only for small files). Default false.');

/** Shape that tools writing one file return. */
export const fileOutputShape = {
  path: z.string().describe('Absolute path of the written file.'),
  bytes: z.number().describe('Size of the written file in bytes.'),
  mimeType: z.string().optional(),
  base64: z.string().optional(),
};

export interface InputFile {
  bytes: Buffer;
  /** File name (from the path, or a placeholder for base64 input). */
  name: string;
  /** Absolute path when the input was a path. */
  path?: string;
  mimeType?: string;
}

function expandHome(p: string) {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

function inside(root: string, p: string) {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolve a user path, enforcing `--root` (no escaping it via `..` or symlinks). */
export async function resolvePath(p: string, ctx: ToolContext, forWrite = false): Promise<string> {
  const raw = expandHome(p.trim());
  const abs = ctx.root ? resolve(ctx.root, raw) : resolve(raw);
  if (ctx.root) {
    const root = await realpath(ctx.root).catch(() => resolve(ctx.root!));
    if (!inside(resolve(ctx.root), abs) && !inside(root, abs)) {
      throw new ToolError(`Path "${p}" is outside the allowed folder (${ctx.root}).`);
    }
    // Follow symlinks for the part that exists.
    let probe = abs;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const real = await realpath(probe).catch(() => probe);
    if (!inside(root, real) && !inside(resolve(ctx.root), real)) {
      throw new ToolError(`Path "${p}" resolves outside the allowed folder (${ctx.root}).`);
    }
  }
  if (forWrite) return abs;
  return abs;
}

const DATA_URI = /^data:([^;,]*)?(;[^,]*)?,(.*)$/s;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Read a file input (path or base64). */
export async function readInput(value: string, ctx: ToolContext, label = 'input'): Promise<InputFile> {
  const v = value.trim();
  const m = DATA_URI.exec(v);
  if (m) {
    const isB64 = (m[2] ?? '').includes(';base64');
    const bytes = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    checkSize(bytes.length, ctx, label);
    return { bytes, name: label, mimeType: m[1] || undefined };
  }
  if (v.startsWith('base64:')) {
    const bytes = Buffer.from(v.slice(7).replace(/\s+/g, ''), 'base64');
    checkSize(bytes.length, ctx, label);
    return { bytes, name: label };
  }
  // Short strings that look like paths are paths. Long single-token strings are base64.
  const looksB64 = v.length >= 64 && B64.test(v.replace(/\s+/g, ''));
  if (!looksB64 || v.length < 4096) {
    const abs = await resolvePath(v, ctx).catch((e) => {
      if (looksB64) return undefined;
      throw e;
    });
    if (abs && existsSync(abs)) {
      const st = statSync(abs);
      if (st.isDirectory()) throw new ToolError(`${label}: "${v}" is a folder, not a file.`);
      checkSize(st.size, ctx, label);
      return { bytes: await readFile(abs), name: basename(abs), path: abs };
    }
    if (!looksB64) throw new ToolError(`${label}: file not found: ${abs ?? v}`);
  }
  const bytes = Buffer.from(v.replace(/\s+/g, ''), 'base64');
  if (!bytes.length) throw new ToolError(`${label}: not a file path and not valid base64.`);
  checkSize(bytes.length, ctx, label);
  return { bytes, name: label };
}

/** Read a text input that may be given inline or as a file path. */
export async function readTextInput(text: string | undefined, path: string | undefined, ctx: ToolContext): Promise<string> {
  if (text != null) return text;
  if (path) return (await readInput(path, ctx, 'path')).bytes.toString('utf8');
  throw new ToolError('Give either "text" or "path".');
}

function checkSize(n: number, ctx: ToolContext, label: string) {
  if (n > ctx.maxBytes) {
    throw new ToolError(`${label} is ${(n / 1048576).toFixed(1)} MB; the limit is ${(ctx.maxBytes / 1048576).toFixed(0)} MB (--max-mb).`);
  }
}

function uniqueName(dir: string, name: string) {
  let candidate = join(dir, name);
  if (!existsSync(candidate)) return candidate;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** Safe file name from any string. */
export function safeName(s: string, fallback = 'output') {
  const clean = s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 120);
  return clean || fallback;
}

/** Replace the extension of a file name. */
export function withExt(name: string, ext: string) {
  const e = extname(name);
  return (e ? name.slice(0, -e.length) : name) + (ext.startsWith('.') ? ext : '.' + ext);
}

/**
 * Write bytes to `output` (file path, or folder ending in "/") or to the output folder with `defaultName`.
 * Without an explicit path, never overwrites: adds -2, -3… instead.
 */
export async function writeOutput(
  data: Uint8Array | string,
  opts: { output?: string; defaultName: string; mimeType?: string; base64?: boolean },
  ctx: ToolContext,
) {
  let target: string;
  const name = safeName(opts.defaultName);
  if (opts.output) {
    const abs = await resolvePath(opts.output, ctx, true);
    const isDir = /[\\/]$/.test(opts.output) || (existsSync(abs) && (await stat(abs)).isDirectory());
    if (isDir) {
      await mkdir(abs, { recursive: true });
      target = join(abs, name);
    } else {
      await mkdir(dirname(abs), { recursive: true });
      target = abs;
    }
  } else {
    await mkdir(ctx.outDir, { recursive: true });
    target = uniqueName(ctx.outDir, name);
  }
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await writeFile(target, buf);
  const out: { path: string; bytes: number; mimeType?: string; base64?: string } = { path: target, bytes: buf.length };
  if (opts.mimeType) out.mimeType = opts.mimeType;
  if (opts.base64) out.base64 = buf.toString('base64');
  return out;
}

/** Folder for a multi-file output (e.g. split PDF pages). */
export async function outputDir(output: string | undefined, defaultName: string, ctx: ToolContext) {
  let dir: string;
  if (output) dir = await resolvePath(output, ctx, true);
  else dir = uniqueName(ctx.outDir, safeName(defaultName));
  await mkdir(dir, { recursive: true });
  return dir.endsWith(sep) ? dir : dir + sep;
}

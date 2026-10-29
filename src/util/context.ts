import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Per-server settings every tool receives as its second argument. */
export interface ToolContext {
  /** When set, every input and output path must stay inside this folder (`--root`). */
  root?: string;
  /** Where outputs go when the caller gives no path (`--out-dir`, default: a temp folder). */
  outDir: string;
  /** Largest input file accepted, in bytes (`--max-mb`, default 200 MB). */
  maxBytes: number;
  /** Version of this package, for tools that stamp metadata. */
  version: string;
}

export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

let current: ToolContext | undefined;

export function defaultContext(): ToolContext {
  return current ?? {
    outDir: join(tmpdir(), 's3eidat-tools'),
    maxBytes: DEFAULT_MAX_BYTES,
    version: '0.0.0',
  };
}

export function setContext(ctx: Partial<ToolContext>): ToolContext {
  const base = defaultContext();
  const root = ctx.root ? resolve(ctx.root) : base.root;
  current = {
    ...base,
    ...ctx,
    root,
    outDir: ctx.outDir ? resolve(root ?? '.', ctx.outDir) : root ? join(root, 's3eidat-out') : base.outDir,
  };
  return current;
}

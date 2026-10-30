import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import { fileInput, outputDir, readInput, resolvePath, writeOutput } from '../../util/files.js';

const MB = 1024 * 1024;
const LIST_LIMIT = 5000;

/** Why an entry name is unsafe to extract (zip-slip, absolute path, device/stream names), or undefined when fine. */
export function unsafeEntry(name: string): string | undefined {
  const n = name.replace(/\\/g, '/');
  if (!n || n.includes('\0')) return 'empty name or NUL byte';
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return 'absolute path';
  if (n.split('/').some((s) => s === '..')) return '".." path segment';
  if (/[:*?"<>|]/.test(n)) return 'character not allowed in file names';
  return undefined;
}

interface Entry { name: string; size: number; compressedSize: number; isDirectory: boolean }

async function listEntries(data: Uint8Array): Promise<Entry[]> {
  const { unzipSync } = await import('fflate');
  const out: Entry[] = [];
  try {
    unzipSync(data, { filter: (f) => { out.push({ name: f.name, size: f.originalSize, compressedSize: f.size, isDirectory: f.name.endsWith('/') }); return false; } });
  } catch (e) {
    throw new ToolError(`Not a readable ZIP file (${e instanceof Error ? e.message : String(e)}).`);
  }
  return out;
}

export default defineTool({
  name: 'ai_zip',
  title: 'ZIP create / extract / list',
  description:
    'Work with ZIP archives locally. action "create": zip files and folders (given as paths; folders keep their own name as the top folder, symlinks are skipped) into one .zip. ' +
    'action "extract": unpack a .zip (path or base64) into the "output" folder; entries with "..", absolute paths or drive letters are refused (zip-slip protection), ' +
    'existing files are kept unless overwrite is true. action "list": entry names with sizes, no extraction. ' +
    'Limits: total uncompressed size 500 MB and 10000 files by default (maxTotalMB / maxFiles). Encrypted ZIPs are not supported.',
  inputSchema: z.object({
    action: z.enum(['create', 'extract', 'list']),
    files: z.array(z.string().min(1)).min(1).max(1000).optional().describe('create: files and folders to add (local paths).'),
    zip: fileInput('ZIP archive').optional().describe('extract / list: the ZIP archive, a local path or base64.'),
    output: z.string().optional().describe('create: the .zip path (or a folder ending in "/"). extract: the folder to extract into. Default: the server output folder.'),
    level: z.number().int().min(0).max(9).optional().default(6).describe('create: compression level 0 (store) to 9 (smallest). Default 6.'),
    overwrite: z.boolean().optional().default(false).describe('extract: replace files that already exist in the output folder. Default false (they are skipped).'),
    maxTotalMB: z.number().min(1).max(4000).optional().default(500).describe('Cap on the total uncompressed size, MB. Default 500.'),
    maxFiles: z.number().int().min(1).max(100000).optional().default(10000).describe('Cap on the number of entries. Default 10000.'),
  }),
  outputSchema: z.object({
    action: z.string(),
    path: z.string().optional().describe('create: the written .zip. extract: the output folder.'),
    bytes: z.number().optional().describe('create: size of the .zip.'),
    files: z.number().describe('Number of file entries (created, extracted, or listed).'),
    totalSize: z.number().describe('Total uncompressed size of the files, bytes.'),
    compressedSize: z.number().optional(),
    entries: z.array(z.object({ name: z.string(), size: z.number(), compressedSize: z.number().optional(), isDirectory: z.boolean().optional() })).optional(),
    truncated: z.boolean().optional().describe('list: true when only the first 5000 entries are shown.'),
    skipped: z.array(z.object({ name: z.string(), reason: z.string() })).optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  examples: [
    { input: { action: 'create', files: ['/projects/site', '/notes/readme.txt'], output: '/backups/site.zip' } },
    { input: { action: 'list', zip: '/downloads/archive.zip' } },
    { input: { action: 'extract', zip: '/downloads/archive.zip', output: '/downloads/archive/' } },
  ],
  async run(input, ctx) {
    const maxTotal = input.maxTotalMB * MB;
    if (input.action === 'create') {
      if (!input.files?.length) throw new ToolError('create: give the "files" to add.');
      const { zipSync } = await import('fflate');
      const outAbs = input.output && !/[\\/]$/.test(input.output) ? await resolvePath(input.output, ctx, true) : undefined;
      const items: Record<string, [Uint8Array, { mtime: Date }]> = {};
      const skipped: { name: string; reason: string }[] = [];
      let count = 0, total = 0;
      const addName = (name: string) => {
        let n = name, k = 2;
        while (items[n]) { const m = /^(.*?)(\.[^./]*)?$/.exec(name)!; n = `${m[1]}-${k++}${m[2] ?? ''}`; }
        return n;
      };
      const addFile = async (abs: string, name: string, mtime: Date, size: number) => {
        if (outAbs && resolve(abs) === resolve(outAbs)) { skipped.push({ name, reason: 'the output zip itself' }); return; }
        if (++count > input.maxFiles) throw new ToolError(`More than ${input.maxFiles} files; raise maxFiles or zip less.`);
        total += size;
        if (total > maxTotal) throw new ToolError(`The files add up to more than ${input.maxTotalMB} MB; raise maxTotalMB or zip less.`);
        items[addName(name)] = [new Uint8Array(await readFile(abs)), { mtime }];
      };
      const walk = async (dir: string, prefix: string) => {
        const list = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        if (!list.length) items[addName(prefix + '/')] = [new Uint8Array(0), { mtime: new Date() }];
        for (const e of list) {
          const p = join(dir, e.name), name = `${prefix}/${e.name}`;
          const st = await lstat(p);
          if (st.isSymbolicLink()) { skipped.push({ name, reason: 'symlink' }); continue; }
          if (st.isDirectory()) await walk(p, name);
          else if (st.isFile()) await addFile(p, name, st.mtime, st.size);
          else skipped.push({ name, reason: 'not a regular file' });
        }
      };
      for (const f of input.files) {
        const abs = await resolvePath(f, ctx);
        if (!existsSync(abs)) throw new ToolError(`Not found: ${abs}`);
        const st = await lstat(abs);
        const name = basename(abs) || 'root';
        if (st.isSymbolicLink()) { skipped.push({ name, reason: 'symlink' }); continue; }
        if (st.isDirectory()) await walk(abs, name);
        else if (st.isFile()) await addFile(abs, name, st.mtime, st.size);
        else skipped.push({ name, reason: 'not a regular file' });
      }
      if (!Object.keys(items).length) throw new ToolError('Nothing to zip (only symlinks or empty input).');
      const data = zipSync(items, { level: input.level as 0 });
      const defaultName = input.files.length === 1 ? `${basename(input.files[0].replace(/[\\/]+$/, '')) || 'archive'}.zip` : 'archive.zip';
      const out = await writeOutput(data, { output: input.output, defaultName, mimeType: 'application/zip' }, ctx);
      return { action: 'create', path: out.path, bytes: out.bytes, files: count, totalSize: total, ...(skipped.length ? { skipped } : {}) };
    }

    if (!input.zip) throw new ToolError(`${input.action}: give the "zip" archive (path or base64).`);
    const zf = await readInput(input.zip, ctx, 'zip');
    const data = new Uint8Array(zf.bytes.buffer, zf.bytes.byteOffset, zf.bytes.byteLength);
    const entries = await listEntries(data);
    const fileEntries = entries.filter((e) => !e.isDirectory);
    const totalSize = fileEntries.reduce((s, e) => s + e.size, 0);
    const compressedSize = fileEntries.reduce((s, e) => s + e.compressedSize, 0);

    if (input.action === 'list') {
      return {
        action: 'list', files: fileEntries.length, totalSize, compressedSize,
        entries: entries.slice(0, LIST_LIMIT), ...(entries.length > LIST_LIMIT ? { truncated: true } : {}),
      };
    }

    // extract: validate everything before writing anything.
    for (const e of entries) {
      const why = unsafeEntry(e.name);
      if (why) throw new ToolError(`Refusing to extract: entry "${e.name}" has an unsafe path (${why}). Nothing was written.`);
    }
    if (entries.length > input.maxFiles) throw new ToolError(`The archive has ${entries.length} entries; the limit is ${input.maxFiles} (maxFiles).`);
    if (totalSize > maxTotal) throw new ToolError(`The archive unpacks to ${(totalSize / MB).toFixed(1)} MB; the limit is ${input.maxTotalMB} MB (maxTotalMB).`);
    const stem = zf.path ? zf.name.replace(/\.[^.]*$/, '') : 'archive';
    const dir = resolve(await outputDir(input.output, stem, ctx));
    const { unzipSync } = await import('fflate');
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(data, { filter: (f) => !f.name.endsWith('/') });
    } catch (e) {
      throw new ToolError(`Couldn't extract the archive (${e instanceof Error ? e.message : String(e)}). Encrypted ZIPs are not supported.`);
    }
    let real = 0;
    const declaredSize = new Map(entries.map((e) => [e.name, e.size]));
    for (const [name, buf] of Object.entries(files)) {
      real += buf.length;
      const declared = declaredSize.get(name) ?? 0;
      if (buf.length > declared || real > maxTotal) throw new ToolError(`Entry "${name}" unpacks larger than declared; refusing (possible zip bomb). Nothing was written.`);
    }
    const skipped: { name: string; reason: string }[] = [];
    let written = 0, bytes = 0;
    for (const e of entries) {
      const target = resolve(dir, e.name.replace(/\\/g, '/'));
      const rel = relative(dir, target);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolError(`Entry "${e.name}" points outside the output folder.`);
      if (e.isDirectory) { await mkdir(target, { recursive: true }); continue; }
      if (existsSync(target)) {
        const st = await lstat(target);
        if (st.isDirectory() || st.isSymbolicLink()) { skipped.push({ name: e.name, reason: st.isDirectory() ? 'a folder with that name exists' : 'existing symlink' }); continue; }
        if (!input.overwrite) { skipped.push({ name: e.name, reason: 'exists (overwrite is false)' }); continue; }
      }
      await mkdir(dirname(target), { recursive: true });
      // Don't follow a symlinked parent folder out of the output folder.
      const parentReal = await lstat(dirname(target));
      if (parentReal.isSymbolicLink()) { skipped.push({ name: e.name, reason: 'parent folder is a symlink' }); continue; }
      const buf = files[e.name] ?? new Uint8Array(0);
      await writeFile(target, buf);
      written++; bytes += buf.length;
    }
    return {
      action: 'extract', path: dir, files: written, totalSize: bytes,
      entries: entries.filter((e) => !e.isDirectory).slice(0, LIST_LIMIT).map((e) => ({ name: e.name, size: e.size })),
      ...(skipped.length ? { skipped } : {}),
    };
  },
});

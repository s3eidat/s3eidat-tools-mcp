#!/usr/bin/env node
// Builds a Claude Desktop extension (.mcpb) for THIS machine's platform: native modules (sharp, @napi-rs/canvas)
// are platform-specific, so CI builds one bundle per OS (see .github/workflows/mcpb.yml).
// Usage: npm run build && node scripts/build-mcpb.mjs   → mcpb/out/s3eidat-tools-<version>-<platform>-<arch>.mcpb
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = join(root, 'mcpb', 'stage');
const outDir = join(root, 'mcpb', 'out');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(outDir, { recursive: true });

for (const f of ['dist', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) cpSync(join(root, f), join(stage, f), { recursive: true });
cpSync(join(root, 'mcpb', 'icon.png'), join(stage, 'icon.png'));
const manifest = JSON.parse(readFileSync(join(root, 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
manifest.compatibility = { ...manifest.compatibility, platforms: [process.platform] };
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Leave out what the server never loads: source maps, typings, browser/ESM-only builds, the sharp WASM fallback
// and musl (Alpine) binaries, which Claude Desktop never runs on.
writeFileSync(join(stage, '.mcpbignore'), [
  '*.map', '*.d.ts', '*.d.mts', '*.d.cts', '*.md', '!README.md',
  'node_modules/pdfjs-dist/build/', 'node_modules/pdfjs-dist/web/', 'node_modules/pdfjs-dist/types/',
  'node_modules/pdfjs-dist/legacy/web/', 'node_modules/pdfjs-dist/legacy/build/*.min.mjs',
  'node_modules/pdf-lib/dist/', 'node_modules/pdf-lib/src/', 'node_modules/pdf-lib/ts3.4/', 'node_modules/pdf-lib/es/',
  'node_modules/@img/sharp-wasm32/', 'node_modules/@img/*musl*/', 'node_modules/@napi-rs/*musl*/',
  'node_modules/zod/src/', 'node_modules/zod/v4-mini/', 'node_modules/hono/dist/types/', 'node_modules/js-yaml/dist/browser/',
].join('\n') + '\n');

const run = (cmd, cwd = stage) => { console.log('$ ' + cmd); execSync(cmd, { cwd, stdio: 'inherit' }); };
run('npm ci --omit=dev --no-audit --no-fund');
const out = join(outDir, `s3eidat-tools-${pkg.version}-${process.platform}-${process.arch}.mcpb`);
run(`npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json`);
run(`npx -y @anthropic-ai/mcpb@2.1.2 pack . "${out}"`);
console.log('built ' + out);

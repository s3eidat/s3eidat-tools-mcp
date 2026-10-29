#!/usr/bin/env node
// Smoke test of the built server over real MCP stdio: list tools, then exercise text, PDF (pdf-lib + pdf.js),
// image (sharp), canvas rendering and QR round trip. Used in CI on every supported Node version.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 's3eidat-smoke-'));
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, '--root', dir], stderr: 'inherit' }));

let failed = 0;
async function check(name, args, test) {
  const r = await client.callTool({ name, arguments: args });
  const ok = !r.isError && test(r.structuredContent ?? {}, r);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(r).slice(0, 400)}`);
  if (!ok) failed++;
  return r.structuredContent ?? {};
}

const { tools } = await client.listTools();
console.log(`${tools.length} tools on Node ${process.version}`);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) doc.addPage([300, 300]).drawText(`Smoke page ${i}`, { x: 20, y: 150, size: 18, font });
writeFileSync(join(dir, 'in.pdf'), await doc.save());

await check('text_case', { text: 'smoke test', mode: 'pascal' }, (s) => s.result === 'SmokeTest');
await check('pdf_info', { file: 'in.pdf' }, (s) => s.pages === 3);
await check('pdf_to_text', { file: 'in.pdf', pages: '2' }, (s, r) => JSON.stringify(r).includes('Smoke page 2'));
await check('pdf_to_images', { file: 'in.pdf', pages: '1', dpi: 72, output: 'imgs/' }, (s) => JSON.stringify(s).includes('.png'));
await check('pdf_compress', { file: 'in.pdf', output: 'small.pdf' }, (s) => typeof s.path === 'string');
await check('image_placeholder', { width: 120, height: 80, format: 'png', output: 'ph.png' }, (s) => typeof s.path === 'string');
await check('image_convert', { image: 'ph.png', format: 'jpeg', output: 'ph.jpg' }, (s) => typeof s.path === 'string');
await check('pdf_from_images', { images: ['ph.jpg', 'ph.png'], output: 'imgs.pdf' }, (s) => typeof s.path === 'string');
await check('qr_generate', { text: 'https://s3eidat.github.io/', format: 'png', output: 'qr.png' }, (s) => typeof s.path === 'string');
await check('qr_read', { image: 'qr.png' }, (s, r) => JSON.stringify(r).includes('https://s3eidat.github.io/'));

await client.close();
if (failed) {
  console.error(`${failed} smoke check(s) failed`);
  process.exit(1);
}
console.log('smoke ok');

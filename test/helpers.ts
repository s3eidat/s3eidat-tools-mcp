import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { runTool, type ToolModule } from '../src/registry.js';
import { DEFAULT_MAX_BYTES, type ToolContext } from '../src/util/context.js';

/** A fresh temp folder used as output dir for one test file. */
export function tempCtx(extra: Partial<ToolContext> = {}): ToolContext {
  const outDir = mkdtempSync(join(tmpdir(), 's3eidat-test-'));
  return { outDir, maxBytes: DEFAULT_MAX_BYTES, version: 'test', ...extra };
}

/** Run a tool with schema validation and a typed result. */
export async function call<T = Record<string, unknown>>(tool: ToolModule, input: unknown, ctx?: ToolContext): Promise<T> {
  return (await runTool(tool, input, ctx)) as T;
}

/** Build a small PDF whose page N shows the text "Page N" (sizes default to A4 portrait). */
export async function samplePdf(pages = 3, size: [number, number] = [595.28, 841.89]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage(size);
    p.drawText(`Page ${i}`, { x: 72, y: size[1] - 100, size: 24, font });
  }
  return Buffer.from(await doc.save());
}

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadTools, type ToolModule } from '../../../src/registry.js';
import { call, tempCtx } from '../../helpers.js';
import { b64, solid } from './fixtures.js';

// Every image tool's result must match its outputSchema exactly (MCP clients validate structuredContent).
const ctx = tempCtx();

describe('image tools: contract', async () => {
  const tools = (await loadTools()).filter((t) => t.name.startsWith('image_'));
  const png = b64(await solid(64, 48, '#336699'));
  const inputs: Record<string, Record<string, unknown>> = {
    image_convert: { image: png, format: 'webp' },
    image_resize: { image: png, width: 32 },
    image_crop: { image: png, ratio: '1:1' },
    image_compress: { image: png, format: 'jpeg', targetBytes: 2000 },
    image_rotate: { image: png },
    image_watermark: { image: png, text: 'hi' },
    image_exif_read: { image: png },
    image_exif_strip: { image: png },
    image_to_base64: { image: png },
    image_from_base64: { text: png.slice(7) },
    image_palette: { image: png, swatchPng: true },
    image_favicon_set: { text: 'S' },
    image_placeholder: { width: 50, height: 20, dataUri: true },
    image_ascii_art: { image: png, columns: 10 },
    image_ascii_banner: { text: 'OK' },
    image_svg_to_png: { svgText: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' },
  };
  it('ships the expected tools (and no image_compare)', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(inputs).sort());
  });
  it.each(Object.keys(inputs))('%s: metadata and strict output schema', async (name) => {
    const tool = tools.find((t) => t.name === name) as ToolModule;
    expect(tool.description).toContain('Web version: https://s3eidat.github.io/');
    expect(tool.examples?.length).toBeGreaterThan(0);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    for (const [k, f] of Object.entries(tool.inputSchema.shape)) expect((f as z.ZodType).description, `${name}.${k}`).toBeTruthy();
    const out = await call(tool, inputs[name], ctx);
    expect(() => (tool.outputSchema as z.ZodObject<z.ZodRawShape>).strict().parse(out)).not.toThrow();
  });
});

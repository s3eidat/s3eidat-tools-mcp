import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { fileInput, readInput } from '../../util/files.js';
import { ToolError } from '../../util/errors.js';
import { emitMarkdown, maxCharsInput, mdOutputInput, mdOutputShape, stemOf, turndownHtml } from './_md.js';

export default defineTool({
  name: 'ai_docx_to_markdown',
  title: 'Word (.docx) to Markdown',
  description:
    'Convert a Word .docx document to Markdown: headings (from Heading styles), bold/italic, lists, links, tables, ' +
    'footnotes. Images become placeholders like ![](image-1.png) unless embedImages is true (then data: URIs, which can be ' +
    'very large). Returns the number of conversion warnings (unrecognised styles and the like) and the first few messages. ' +
    'Old binary .doc files are not supported. Accepts a local path or base64. Inline Markdown is cut at maxChars ' +
    '(default 200k); "output" saves it to a file. Runs locally; nothing is uploaded.',
  inputSchema: z.object({
    file: fileInput('.docx document'),
    embedImages: z.boolean().optional().default(false).describe('Embed images as base64 data: URIs instead of placeholders. Default false.'),
    maxChars: maxCharsInput(),
    output: mdOutputInput(),
  }),
  outputSchema: z.object({
    images: z.number().describe('Images found in the document.'),
    warnings: z.number().describe('Conversion warnings and errors reported by the converter.'),
    messages: z.array(z.string()).describe('Up to 10 of those messages.'),
    ...mdOutputShape,
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'report.docx' } }, { input: { file: 'thesis.docx', output: 'thesis.md' } }],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, '.docx document');
    if (f.bytes[0] !== 0x50 || f.bytes[1] !== 0x4b) {
      throw new ToolError(f.bytes[0] === 0xd0 && f.bytes[1] === 0xcf
        ? 'This is an old binary .doc file; only .docx is supported. Save it as .docx first.'
        : 'Not a .docx file (it is not a ZIP package).');
    }
    const { default: mammoth } = await import('mammoth');
    let images = 0;
    const convertImage = mammoth.images.imgElement(async (img) => {
      images++;
      if (input.embedImages) return { src: `data:${img.contentType};base64,${await img.readAsBase64String()}` };
      const ext = (img.contentType.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
      return { src: `image-${images}.${ext}` };
    });
    let res;
    try {
      res = await mammoth.convertToHtml({ buffer: f.bytes }, { convertImage, externalFileAccess: false });
    } catch (e) {
      throw new ToolError(`The .docx could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const md = await turndownHtml(res.value);
    const out = await emitMarkdown(md, { output: input.output, maxChars: input.maxChars, defaultName: stemOf(f, 'document') + '.md' }, ctx);
    return {
      images,
      warnings: res.messages.length,
      messages: res.messages.slice(0, 10).map((m) => `${m.type}: ${m.message}`),
      ...out,
    };
  },
});

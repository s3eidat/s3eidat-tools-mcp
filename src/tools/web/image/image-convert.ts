import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { fileInput, outputPath, returnBase64, writeOutput } from '../../../util/files.js';
import { color, encode, fit, imageOutputShape, loadImg, MIME, OUT_FORMATS, outName, pipe, qualitySchema } from './_img.js';

// Port of https://github.com/s3eidat/image-convert (app.js): decode, optionally flatten onto a background, re-encode.
export default defineTool({
  name: 'image_convert',
  title: 'Convert image format',
  webSlug: 'image-convert',
  description:
    'Convert an image to PNG, JPEG, WebP, AVIF, GIF or TIFF. Reads JPEG, PNG, WebP, AVIF/HEIF, GIF (first frame), TIFF, SVG, BMP and ICO. ' +
    'Transparent areas are filled with `background` when writing JPEG (or always with `flatten`). EXIF rotation is applied. ' +
    'SVGs are rasterised at their own size (width/height or viewBox; 1024×1024 if neither), scripts never run. ' +
    `Images larger than 16384 px a side or 100 MP are scaled down to fit. Web version: ${webUrl('image-convert')}`,
  inputSchema: z.object({
    image: fileInput('image'),
    format: z.enum(OUT_FORMATS).optional().default('png').describe('Output format. Default png (as on the website).'),
    quality: qualitySchema(92),
    background: z.string().optional().default('#ffffff').describe('Colour used for transparent areas when writing JPEG or when flatten is on. Default #ffffff.'),
    flatten: z.boolean().optional().default(false).describe('Fill transparency with the background for every format, not only JPEG.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...imageOutputShape,
    inputFormat: z.string().describe('Detected input format.'),
    scaled: z.boolean().describe('True when the image was scaled down to fit the size limit.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/photos/logo.png', format: 'jpeg', quality: 90, background: '#ffffff' }, note: 'Writes logo.jpg with transparency on white.' },
    { input: { image: '/icons/icon.svg', format: 'webp' } },
  ],
  async run(input, ctx) {
    const img = await loadImg(input.image, ctx);
    const f = fit(img.width, img.height);
    let s = pipe(img);
    if (f.scaled) s = s.resize(f.w, f.h, { fit: 'fill' });
    const bg = color(input.background, 'background');
    const buf = await encode(s, input.format, input.quality, { bg, flatten: input.flatten }).toBuffer();
    const out = await writeOutput(buf, { output: input.output, defaultName: outName(img.name, input.format), mimeType: MIME[input.format], base64: input.returnBase64 }, ctx);
    return { ...out, width: f.w, height: f.h, format: input.format, inputFormat: img.format, scaled: f.scaled };
  },
});

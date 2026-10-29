import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { fileInput, outputPath, returnBase64, writeOutput } from '../../../util/files.js';
import { color, encode, EXT, fromRaw, imageOutputShape, keepFormat, loadImg, MIME, pipe, qualitySchema, sharp, stem, toRaw, type OutFormat } from './_img.js';

// Rotation/flip as in https://github.com/s3eidat/photo-filters (oriented()): rotation is clockwise and flips are
// screen-relative, applied after rotating. Inputs are auto-oriented from EXIF first, like a browser does.

export default defineTool({
  name: 'image_rotate',
  title: 'Rotate / flip image',
  webSlug: 'photo-filters',
  description:
    'Rotate an image clockwise by 90, 180, 270 or any angle (the canvas grows to fit; new corners get `background`), and/or flip it ' +
    'horizontally (mirror) or vertically. Flips apply after the rotation, as seen on screen. EXIF orientation is applied first ' +
    '(autoOrient, default on), so with angle 0 this simply "fixes" sideways phone photos. Output JPEG/PNG/WebP/AVIF ' +
    `("keep" = same as input), name <name>-rotated.<ext>. Web version: ${webUrl('photo-filters')}`,
  inputSchema: z.object({
    image: fileInput('image'),
    angle: z.number().min(-360).max(360).optional().default(90).describe('Clockwise rotation in degrees (negative = counter-clockwise). Default 90.'),
    flipHorizontal: z.boolean().optional().default(false).describe('Mirror left-right (after rotating).'),
    flipVertical: z.boolean().optional().default(false).describe('Mirror top-bottom (after rotating).'),
    autoOrient: z.boolean().optional().default(true).describe('Apply the EXIF Orientation tag first (what browsers show). Default true.'),
    background: z
      .string()
      .optional()
      .default('#00000000')
      .describe('Fill for the corners uncovered by a non-right-angle rotation. Default transparent (white in JPEG).'),
    format: z.enum(['keep', 'jpeg', 'png', 'webp', 'avif']).optional().default('keep').describe('Output format. Default keep (JPEG/PNG/WebP stay, others become PNG).'),
    quality: qualitySchema(92),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...imageOutputShape, orientationApplied: z.number().describe('EXIF orientation that was applied (1 = none).') }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/photos/scan.jpg', angle: 90 } },
    { input: { image: '/photos/selfie.jpg', angle: 0, flipHorizontal: true }, note: 'Un-mirror a selfie.' },
    { input: { image: '/photos/IMG_1234.jpg', angle: 0 }, note: 'Bake the EXIF rotation into the pixels.' },
  ],
  async run(input, ctx) {
    const img = await loadImg(input.image, ctx);
    const bg = color(input.background, 'background');
    let s = input.autoOrient ? pipe(img) : img.raw || img.svg ? pipe(img) : sharp(img.bytes);
    const a = ((input.angle % 360) + 360) % 360;
    if (a) s = s.rotate(a, { background: bg });
    // Flip after rotating (screen-relative, as on the website): sharp would flip first, so rotate to pixels first.
    if (a && (input.flipHorizontal || input.flipVertical)) s = fromRaw(await toRaw(s));
    if (input.flipHorizontal) s = s.flop();
    if (input.flipVertical) s = s.flip();
    const fmt: OutFormat = input.format === 'keep' ? keepFormat(img) : input.format;
    const { data, info } = await encode(s, fmt, input.quality, { bg: '#ffffff' }).toBuffer({ resolveWithObject: true });
    const out = await writeOutput(data, { output: input.output, defaultName: `${stem(img.name)}-rotated.${EXT[fmt]}`, mimeType: MIME[fmt], base64: input.returnBase64 }, ctx);
    return { ...out, width: info.width, height: info.height, format: fmt, orientationApplied: input.autoOrient ? img.orientation : 1 };
  },
});

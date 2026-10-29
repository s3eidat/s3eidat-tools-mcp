import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileInput, outputPath, readInput, returnBase64, writeOutput } from '../../../util/files.js';
import { clean, cleanName, inspect, isJpeg, isPng, parseTiff, type Field, type Gps } from './_exif.js';
import { encode, keepFormat, MIME, sharp, type OutFormat } from './_img.js';

// Port of https://github.com/s3eidat/exif-cleaner (app.js). JPEG and PNG use the website's own parsers and lossless
// cleaning; other formats (WebP, AVIF/HEIC, TIFF) are read through sharp and cleaned by re-encoding.

const fieldShape = z.object({ label: z.string(), value: z.string(), sensitive: z.boolean().optional() });
const gpsShape = z.object({ lat: z.number(), lon: z.number(), alt: z.number().optional(), coordinates: z.string().describe('"lat, lon" with 6 decimals.') });

function gpsOut(g: Gps | null) {
  return g ? { ...g, coordinates: g.lat.toFixed(6) + ', ' + g.lon.toFixed(6) } : null;
}

async function read(bytes: Buffer) {
  let m: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>> | undefined;
  try {
    m = await sharp(bytes).metadata();
  } catch {
    /* the website's parser may still read it */
  }
  if (isJpeg(bytes) || isPng(bytes)) {
    let info;
    try {
      info = inspect(bytes);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    return { format: info.type, width: m?.width, height: m?.height, ...info.meta, blocks: info.blocks };
  }
  if (!m) throw new ToolError("Can't read this image (supported: JPEG, PNG, WebP, AVIF/HEIC, TIFF).");
  const fields: Field[] = [];
  let gps: Gps | null = null;
  let orientation = m.orientation ?? 1;
  const blocks: [string, number][] = [];
  if (m.exif) {
    blocks.push(['EXIF', m.exif.length]);
    try {
      const r = parseTiff(m.exif.subarray(m.exif.indexOf('Exif\0\0') === 0 ? 6 : 0));
      fields.push(...r.fields);
      gps = r.gps;
      orientation = r.orientation;
    } catch {
      fields.push({ label: 'EXIF', value: 'present but damaged' });
    }
  }
  if (m.xmp) {
    blocks.push(['XMP', m.xmp.length]);
    const xmp = m.xmp.toString('utf8');
    const tool = /CreatorTool[=>"]+([^"<]{1,120})/.exec(xmp);
    if (tool) fields.push({ label: 'Edited with', value: tool[1] });
    if (/GPSLatitude/.test(xmp)) fields.push({ label: 'GPS (XMP)', value: 'present', sensitive: true });
  }
  if (m.iptc) blocks.push(['IPTC / Photoshop', m.iptc.length]);
  if (m.icc) blocks.push(['ICC color profile', m.icc.length]);
  const format = m.format === 'heif' && m.compression === 'av1' ? 'avif' : m.format;
  return { format, width: m.width, height: m.height, fields, gps, orientation, blocks };
}

const exifRead = defineTool({
  name: 'image_exif_read',
  title: 'Read photo metadata (EXIF)',
  webSlug: 'exif-cleaner',
  description:
    'Show the hidden metadata in a photo: camera make/model, lens, date taken, exposure, ISO, software, author/copyright, serial ' +
    'numbers, comments, PNG text chunks, and GPS coordinates (where the photo was taken). Lists every metadata block (EXIF, XMP, ' +
    'ICC, IPTC, embedded previews) with its size and flags privacy-sensitive fields. JPEG and PNG fully; WebP/AVIF/HEIC/TIFF EXIF via sharp. ' +
    `Web version: ${webUrl('exif-cleaner')}`,
  inputSchema: z.object({ image: fileInput('photo') }),
  outputSchema: z.object({
    format: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    fields: z.array(fieldShape).describe('Readable metadata fields in the website order.'),
    gps: gpsShape.nullable().describe('Location the photo reveals, if any.'),
    orientation: z.number().describe('EXIF orientation (1 = normal, 6 = rotate 90° clockwise, …).'),
    blocks: z.array(z.object({ name: z.string(), bytes: z.number() })).describe('Metadata blocks found in the file.'),
    hasMetadata: z.boolean(),
    revealsLocation: z.boolean(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { image: '/photos/IMG_20261021_184205.jpg' }, note: 'Camera Google Pixel 9, Date taken 2026:10:21 18:42:05, GPS 31.953900, 35.910600.' }],
  async run(input, ctx) {
    const f = await readInput(input.image, ctx, 'photo');
    const r = await read(f.bytes);
    return {
      format: r.format,
      ...(r.width ? { width: r.width, height: r.height } : {}),
      fields: r.fields,
      gps: gpsOut(r.gps),
      orientation: r.orientation,
      blocks: r.blocks.map(([name, bytes]) => ({ name, bytes })),
      hasMetadata: r.blocks.length > 0,
      revealsLocation: !!r.gps || r.fields.some((x) => /GPS/.test(x.label)),
    };
  },
});

const exifStrip = defineTool({
  name: 'image_exif_strip',
  title: 'Remove photo metadata (EXIF)',
  webSlug: 'exif-cleaner',
  description:
    'Remove EXIF, GPS location, XMP, IPTC, comments, PNG text chunks and embedded previews from a photo before sharing it. ' +
    'JPEG and PNG are cleaned losslessly (image data copied byte for byte, like the website); by default the rotation is kept as a tiny ' +
    'orientation-only EXIF and the ICC colour profile is kept. applyOrientation re-encodes JPEGs with the rotation baked into the pixels. ' +
    'WebP/AVIF/HEIC/TIFF are re-encoded without metadata. Output name <name>-clean.<ext>. ' +
    `Web version: ${webUrl('exif-cleaner')}`,
  inputSchema: z.object({
    image: fileInput('photo'),
    keepOrientation: z.boolean().optional().default(true).describe('Keep only the Orientation tag so the photo still shows the right way up. Default true.'),
    keepIcc: z.boolean().optional().default(true).describe('Keep the ICC colour profile (no personal data; keeps colours right). Default true.'),
    applyOrientation: z
      .boolean()
      .optional()
      .default(false)
      .describe('Instead of keeping the Orientation tag, rotate the pixels (re-encodes JPEG at `quality`; PNG is unaffected). Default false.'),
    quality: z.number().int().min(1).max(100).optional().default(92).describe('JPEG/WebP/AVIF quality when re-encoding is needed. Default 92.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    path: z.string(),
    bytes: z.number(),
    mimeType: z.string().optional(),
    base64: z.string().optional(),
    inputBytes: z.number(),
    format: z.string(),
    removed: z.array(z.object({ name: z.string(), bytes: z.number() })).describe('Metadata blocks that were removed.'),
    hadLocation: z.boolean().describe('True when the original revealed a GPS location.'),
    orientation: z.number().describe('Orientation of the input (1 = normal).'),
    reencoded: z.boolean().describe('True when the pixels were re-encoded (non-JPEG/PNG input or applyOrientation).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { image: '/photos/IMG_1234.jpg' }, note: 'Writes IMG_1234-clean.jpg: no GPS, camera or date; same pixels.' },
    { input: { image: '/photos/IMG_1234.jpg', applyOrientation: true } },
  ],
  async run(input, ctx) {
    const f = await readInput(input.image, ctx, 'photo');
    const b = f.bytes;
    const info = await read(b);
    const name = f.path ? f.name : 'photo.' + (info.format === 'jpeg' ? 'jpg' : info.format);
    let out: Uint8Array;
    let reencoded = false;
    let fmt = info.format;
    const lossless = (isJpeg(b) || isPng(b)) && !(input.applyOrientation && isJpeg(b) && info.orientation > 1);
    if (lossless) {
      out = clean(b, { keepIcc: input.keepIcc, keepOri: input.keepOrientation && !input.applyOrientation });
    } else {
      // Re-encode without metadata; sharp drops EXIF/XMP/IPTC unless asked to keep them.
      const of: OutFormat = keepFormat({ format: info.format }, ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif']);
      let s = sharp(b, { autoOrient: true });
      if (input.keepIcc) s = s.keepIccProfile();
      out = await encode(s, of, input.quality, { best: true }).toBuffer();
      reencoded = true;
      fmt = of;
    }
    const mime = MIME[fmt as OutFormat] ?? 'application/octet-stream';
    const res = await writeOutput(out, { output: input.output, defaultName: cleanName(name), mimeType: mime, base64: input.returnBase64 }, ctx);
    const kept = (n: string) => /ICC/.test(n) && input.keepIcc;
    return {
      ...res,
      inputBytes: b.length,
      format: fmt,
      removed: info.blocks.filter(([n]) => !kept(n)).map(([name, bytes]) => ({ name, bytes })),
      hadLocation: !!info.gps || info.fields.some((x) => /GPS/.test(x.label)),
      orientation: info.orientation,
      reencoded,
    };
  },
});

export default [exifRead, exifStrip];

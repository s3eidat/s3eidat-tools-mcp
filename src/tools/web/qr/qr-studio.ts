import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { fileOutputShape, outputPath, readInput, returnBase64, writeOutput } from '../../../util/files.js';
import { bestMode, utf8Bytes, type EccLevel, type QrMode } from './_qrcode.js';
import { normHex, payload, qrOrThrow, qrSvg, styleWarnings, svgToPng, type PayloadType, type PayloadValues } from './_qr.js';

// Port of https://github.com/s3eidat/qr-studio: same QR encoder (qrcode.js), payload formats, drawing and warnings.
const TYPES = ['url', 'text', 'wifi', 'vcard', 'email', 'sms', 'tel', 'geo'] as const;
const REQUIRED: Record<PayloadType, string> = {
  url: '"url"', text: '"text"', wifi: '"ssid"', vcard: 'at least one of "firstName", "lastName", "phone", "email" or "company"',
  email: '"to"', sms: '"phone"', tel: '"phone"', geo: '"latitude" and "longitude"',
};

export default defineTool({
  name: 'qr_generate',
  title: 'QR code generator',
  webSlug: 'qr-studio',
  description:
    'Make a QR code as SVG or PNG for a link, plain text, Wi-Fi login, contact card (vCard 3.0), email, SMS, phone call or map ' +
    'location. Same encoder as the website (qrcode.js: versions 1-40, error correction L/M/Q/H, smallest version that fits, ' +
    'best mask), UTF-8 so Arabic/emoji work. Options: size in px, quiet-zone margin, colours, square/rounded/dots modules, ' +
    'and an optional centre logo (forces level H). Returns the file path, the exact encoded text, version, module count and ' +
    `contrast warnings. Max about 2.9 KB of data at level L. Web version: ${webUrl('qr-studio')}`,
  inputSchema: z.object({
    type: z.enum(TYPES).optional().describe('What the code holds. Default: "url" if url is given, else "text".'),
    text: z.string().max(8000).optional().describe('text: any text (encoded exactly as given).'),
    url: z.string().max(4000).optional().describe('url: web address; "https://" is added when no scheme is given.'),
    ssid: z.string().optional().describe('wifi: network name.'),
    password: z.string().optional().describe('wifi: password (ignored for open networks).'),
    security: z.enum(['WPA', 'WEP', 'nopass']).optional().describe('wifi: WPA (WPA/WPA2/WPA3, default), WEP, or nopass (open).'),
    hidden: z.boolean().optional().describe('wifi: the network is hidden.'),
    firstName: z.string().optional().describe('vcard: first name.'),
    lastName: z.string().optional().describe('vcard: last name.'),
    phone: z.string().optional().describe('vcard/sms/tel: phone number.'),
    email: z.string().optional().describe('vcard: email address.'),
    company: z.string().optional().describe('vcard: company.'),
    jobTitle: z.string().optional().describe('vcard: job title.'),
    website: z.string().optional().describe('vcard: website.'),
    address: z.string().optional().describe('vcard: address.'),
    to: z.string().optional().describe('email: recipient address.'),
    subject: z.string().optional().describe('email: subject.'),
    body: z.string().optional().describe('email: message body.'),
    message: z.string().optional().describe('sms: message text.'),
    latitude: z.union([z.number(), z.string()]).optional().describe('geo: latitude, -90..90.'),
    longitude: z.union([z.number(), z.string()]).optional().describe('geo: longitude, -180..180.'),
    label: z.string().optional().describe('geo: optional place label (?q=).'),
    ecc: z.enum(['L', 'M', 'Q', 'H']).optional().default('M').describe('Error correction: L 7%, M 15% (default), Q 25%, H 30%. A logo forces H.'),
    mode: z.enum(['byte', 'auto', 'numeric', 'alphanumeric']).optional().default('byte')
      .describe('Encoding mode. "byte" (UTF-8, what the website uses), "auto" (numeric/alphanumeric when the text allows, smaller codes), or force one.'),
    version: z.number().int().min(0).max(40).optional().default(0).describe('QR version 1-40 (size), or 0 = smallest that fits (default).'),
    format: z.enum(['svg', 'png']).optional().default('png').describe('Output format.'),
    size: z.number().int().min(64).max(4096).optional().default(1024).describe('Image width/height in px (default 1024).'),
    margin: z.number().int().min(0).max(16).optional().default(4).describe('Quiet zone in modules (default 4; under 2 may not scan).'),
    foreground: z.string().optional().default('#0d0f12').describe('Module colour, hex (default #0d0f12).'),
    background: z.string().optional().default('#ffffff').describe('Background colour, hex (default #ffffff).'),
    shape: z.enum(['square', 'rounded', 'dots']).optional().default('square').describe('Module shape. Rounded/dots also round the three finder squares.'),
    logo: z.string().optional().describe('Optional centre logo image (path or base64, max 5 MB). Covers ~22% of the code; error correction becomes H.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...fileOutputShape,
    payload: z.string().describe('The exact text encoded in the QR code.'),
    version: z.number(), modules: z.number().describe('Modules per side (version × 4 + 17).'),
    ecc: z.string(), mode: z.string(), mask: z.number(), dataBytes: z.number().describe('Encoded length (UTF-8 bytes in byte mode).'),
    contrast: z.number().describe('Foreground/background contrast ratio (21 = black on white).'),
    warnings: z.array(z.string()),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { url: 'example.com' }, note: 'Encodes "https://example.com" as a 1024 px PNG.' },
    { input: { type: 'wifi', ssid: 'Home', password: '12345678', format: 'svg' }, note: 'payload WIFI:T:WPA;S:Home;P:12345678;;' },
    { input: { type: 'vcard', firstName: 'Sara', lastName: 'Haddad', phone: '+962 7 9000 0000', shape: 'rounded' } },
  ],
  async run(input, ctx) {
    const type: PayloadType = input.type ?? (input.url != null ? 'url' : 'text');
    const values: PayloadValues = {
      url: input.url, text: input.text, ssid: input.ssid, pass: input.password, sec: input.security, hidden: input.hidden,
      first: input.firstName, last: input.lastName, tel: input.phone, email: input.email, org: input.company, title: input.jobTitle,
      web: input.website, adr: input.address, to: input.to, subject: input.subject, body: input.body,
      num: input.phone, msg: input.message, lat: input.latitude == null ? undefined : String(input.latitude),
      lng: input.longitude == null ? undefined : String(input.longitude), q: input.label,
    };
    const p = payload(type, values);
    if (typeof p !== 'string') throw new ToolError(p.error);
    if (!p) throw new ToolError(`Nothing to encode: for type "${type}" give ${REQUIRED[type]}.`);

    const fg = normHex(input.foreground), bg = normHex(input.background);
    let logoUrl: string | undefined;
    if (input.logo) {
      const file = await readInput(input.logo, ctx, 'logo');
      if (file.bytes.length > 5 * 1024 * 1024) throw new ToolError('Logo is over 5 MB, pick a smaller image.');
      const { default: sharp } = await import('sharp');
      const png = await sharp(file.bytes, { density: 300 }).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
        .catch(() => { throw new ToolError("Couldn't read that logo image."); });
      logoUrl = 'data:image/png;base64,' + png.toString('base64');
    }
    const ecc: EccLevel = logoUrl ? 'H' : input.ecc;
    const mode: QrMode = input.mode === 'auto' ? bestMode(p) : input.mode === 'numeric' ? 'Numeric' : input.mode === 'alphanumeric' ? 'Alphanumeric' : 'Byte';
    const qr = qrOrThrow(p, ecc, { mode, version: input.version || 0 });
    const svg = qrSvg(qr, input.size, { fg, bg, shape: input.shape, margin: input.margin, logoUrl });
    const data = input.format === 'svg' ? svg : await svgToPng(svg);
    const out = await writeOutput(data, {
      output: input.output, defaultName: `qr-${type}.${input.format}`, mimeType: input.format === 'svg' ? 'image/svg+xml' : 'image/png', base64: input.returnBase64,
    }, ctx);
    const style = styleWarnings(fg, bg, input.margin);
    return {
      ...out, payload: p, version: qr.version, modules: qr.moduleCount, ecc, mode: qr.mode, mask: qr.mask,
      dataBytes: mode === 'Byte' ? utf8Bytes(p).length : p.length, contrast: style.contrast, warnings: style.warnings,
    };
  },
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, returnBase64, writeOutput } from '../../../util/files.js';
import { Draw, MM, PAPER, newDoc, pdfSafe, savePdf, userText } from '../docs/_pdf.js';
import type { QrMatrix } from './_qrcode.js';
import { modulesPath, qrOrThrow, qrSvg, svgToPng, wifiPayload } from './_qr.js';

// Port of https://github.com/s3eidat/wifi-card (app.js). The site draws the card on a 1240 × 1754 px canvas and prints
// it on A6/A4 sheets; here the same drawing (same coordinates, sizes and colours) is made as vector PDF.
const THEMES = {
  teal: { a: '#0e9f9a', ink: '#ffffff', line: false },
  ink: { a: '#1d2530', ink: '#ffffff', line: false },
  coral: { a: '#e2604a', ink: '#ffffff', line: false },
  violet: { a: '#6650c8', ink: '#ffffff', line: false },
  saver: { a: '#ffffff', ink: '#111111', line: true }, // ink saver (outline)
};
const T = { title: 'Wi-Fi', scan: 'Scan to join', net: 'Network', pass: 'Password', open: 'Open network, no password', foot: 'Point your phone camera at the code' };
const LAYOUTS = {
  a6: { page: 'A6', n: 1, cols: 1, w: 105, h: 148 },
  a4: { page: 'A4', n: 1, cols: 1, w: 190, h: 269 },
  a4x4: { page: 'A4', n: 4, cols: 2, w: 100, h: 141.4 },
  a4x9: { page: 'A4', n: 9, cols: 3, w: 66, h: 93.3 },
};
const CW = 1240, CH = 1754;

export interface CardData { ssid: string; pass: string; sec: string; theme: keyof typeof THEMES; title: string; showPass: boolean; qr: QrMatrix }

/** drawCard() from the website, in card pixels (1240 × 1754), English labels. */
export function drawCard(g: Draw, d: CardData) {
  const W = CW, H = CH, th = THEMES[d.theme], maxW = W * 0.86, dark = '#14181d', grey = '#6b7380';
  const { fonts } = g;
  const line = (text: string, y: number, weight: number, size: number, color: string) =>
    g.text(text, W / 2, y, { size, font: weight >= 600 ? fonts.bold : fonts.sans, color, align: 'center', maxW, minScale: 18 / size });
  g.rect(0, 0, W, H, { fill: '#ffffff' });
  const band = H * 0.205;
  g.rect(0, 0, W, band, { fill: th.a });
  if (th.line) { g.rect(0, band - 6, W, 6, { fill: '#111111' }); g.rect(4, 4, W - 8, H - 8, { stroke: '#111111', lineWidth: 8 }); }
  wifiIcon(g, W / 2, band * 0.54, band * 0.36, th.ink);
  line(d.title || T.title, band * 0.87, 800, 96, th.ink);
  line(T.scan, band + 150, 800, 74, dark);
  const qs = W * 0.5, qx = (W - qs) / 2, qy = band + 266, box = 26;
  g.roundRect(qx - box, qy - box, qs + 2 * box, qs + 2 * box, 36, { fill: '#ffffff', stroke: th.line ? '#111111' : th.a, lineWidth: 6 });
  const n = d.qr.moduleCount, m = 2, cell = qs / (n + 2 * m);
  g.sub(qx, qy, cell).path(modulesPath(d.qr, m), { fill: '#000000' });
  let y = qy + qs + box + 78;
  line(T.net, y, 600, 38, grey);
  y += 70; line(d.ssid || '—', y, 800, 64, dark);
  y += 80;
  if (d.sec === 'nopass') line(T.open, y + 24, 600, 40, grey);
  else if (d.showPass) {
    line(T.pass, y, 600, 38, grey);
    y += 70; line(d.pass || '—', y, 800, 60, dark);
  }
  g.rect(W * 0.4, H - 112, W * 0.2, 6, { fill: th.line ? '#111111' : th.a });
  line(T.foot, H - 56, 500, 32, grey);
}

function wifiIcon(g: Draw, cx: number, cy: number, r: number, color: string) {
  const a1 = Math.PI * 1.25, a2 = Math.PI * 1.75;
  for (const k of [1, 0.68, 0.36]) {
    const R = r * k;
    g.path(`M${cx + R * Math.cos(a1)} ${cy + R * Math.sin(a1)}A${R} ${R} 0 0 1 ${cx + R * Math.cos(a2)} ${cy + R * Math.sin(a2)}`, { stroke: color, lineWidth: r * 0.16 });
  }
  const d = r * 0.1;
  g.path(`M${cx - d} ${cy}a${d} ${d} 0 1 0 ${2 * d} 0a${d} ${d} 0 1 0 ${-2 * d} 0z`, { fill: color });
}

export default defineTool({
  name: 'qr_wifi',
  title: 'Wi-Fi QR code and card',
  webSlug: 'wifi-card',
  description:
    'Make a Wi-Fi QR code that phones join by scanning (WPA/WPA2/WPA3, WEP or open; hidden networks), as PNG or SVG, or a ' +
    'printable PDF card like the website\'s: coloured header with the Wi-Fi symbol, "Scan to join", the QR code, network ' +
    'name and (optionally) the password, on an A6 card, an A4 poster, or A4 sheets of 4 or 9 cards to cut. Special ' +
    'characters (; , : " \\) are escaped. The PDF card uses English labels and Latin text only for now. ' +
    `Web version: ${webUrl('wifi-card')}`,
  inputSchema: z.object({
    ssid: z.string().min(1).max(200).describe('Network name (SSID).'),
    password: z.string().max(200).optional().default('').describe('Wi-Fi password (ignored for open networks).'),
    security: z.enum(['WPA', 'WEP', 'nopass']).optional().default('WPA').describe('WPA (WPA/WPA2/WPA3, default), WEP, or nopass (open network).'),
    hidden: z.boolean().optional().default(false).describe('The network is hidden (not broadcast).'),
    format: z.enum(['png', 'svg', 'pdf']).optional().default('pdf').describe('pdf = printable card sheet (default); png/svg = just the QR code.'),
    layout: z.enum(['a6', 'a4', 'a4x4', 'a4x9']).optional().default('a4x4')
      .describe('PDF: a6 = one A6 card; a4 = one A4 poster; a4x4 = A4 sheet of 4 cards (default); a4x9 = A4 sheet of 9 small cards.'),
    theme: z.enum(['teal', 'ink', 'coral', 'violet', 'saver']).optional().default('teal').describe('PDF: card colour; "saver" is an ink-saving outline.'),
    title: z.string().max(60).optional().default('').describe('PDF: heading on the card (default "Wi-Fi").'),
    showPassword: z.boolean().optional().default(true).describe('PDF: print the password under the code.'),
    size: z.number().int().min(64).max(4096).optional().default(1024).describe('PNG/SVG: image size in px.'),
    margin: z.number().int().min(0).max(16).optional().default(4).describe('PNG/SVG: quiet zone in modules.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    path: z.string(), bytes: z.number(), mimeType: z.string().optional(), base64: z.string().optional(),
    pages: z.number().optional(),
    payload: z.string().describe('The exact text in the QR code.'),
    version: z.number(), modules: z.number(),
    warnings: z.array(z.string()),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { ssid: 'S3eidat Café', password: 'coffee-is-free' }, note: 'A4 sheet with 4 cards; payload WIFI:T:WPA;S:S3eidat Café;P:coffee-is-free;;' },
    { input: { ssid: 'Guest', security: 'nopass', format: 'png' }, note: 'payload WIFI:T:nopass;S:Guest;;' },
  ],
  async run(input, ctx) {
    if (!input.ssid.trim()) throw new ToolError('Enter the network name (ssid).');
    const p = wifiPayload(input.ssid, input.password, input.security, input.hidden);
    const qr = qrOrThrow(p, 'M');
    const warnings: string[] = [];
    if (input.security === 'WPA' && input.password && input.password.length < 8) warnings.push('WPA passwords are at least 8 characters');
    else if (input.security !== 'nopass' && !input.password) warnings.push('Password is empty');
    const info = { payload: p, version: qr.version, modules: qr.moduleCount, warnings };

    if (input.format !== 'pdf') {
      const svg = qrSvg(qr, input.size, { fg: '#000000', bg: '#ffffff', shape: 'square', margin: input.margin });
      const data = input.format === 'svg' ? svg : await svgToPng(svg);
      const out = await writeOutput(data, { output: input.output, defaultName: `wifi-qr.${input.format}`, mimeType: input.format === 'svg' ? 'image/svg+xml' : 'image/png', base64: input.returnBase64 }, ctx);
      return { ...out, ...info };
    }

    const ssid = userText(input.ssid, 'ssid'), title = userText(input.title, 'title');
    const pass = input.security === 'nopass' || !input.showPassword ? '' : userText(input.password, 'password');
    const L = LAYOUTS[input.layout];
    const [PW, PH] = PAPER[L.page];
    const { doc, fonts } = await newDoc(pdfSafe(`Wi-Fi card: ${ssid}`), ctx);
    const page = doc.addPage([PW * MM, PH * MM]);
    const rows = Math.ceil(L.n / L.cols), gx = (PW - L.cols * L.w) / 2, gy = (PH - rows * L.h) / 2;
    for (let i = 0; i < L.n; i++) {
      const x = gx + (i % L.cols) * L.w, y = gy + Math.floor(i / L.cols) * L.h;
      const k = Math.min(L.w / CW, L.h / CH); // mm per card px
      const cx = x + (L.w - CW * k) / 2, cy = y + (L.h - CH * k) / 2;
      const g = new Draw(page, fonts, MM).sub(cx, cy, k);
      drawCard(g, { ssid, pass, sec: input.security, theme: input.theme, title, showPass: input.showPassword, qr });
    }
    const out = await savePdf(doc, { output: input.output, defaultName: 'wifi-card.pdf', base64: input.returnBase64 }, ctx);
    return { ...out, mimeType: 'application/pdf', ...info };
  },
});

import { z } from 'zod';
import { StandardFonts, degrees, type PDFImage } from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { readInput } from '../../../util/files.js';
import {
  SANS, baseName, canvasLib, colorSchema, cssHex, encodable, fileInput, hexRgb, openPdf, outputPath, pageGeom, parseRangeSet,
  pdfFileOutput, returnBase64, savePdf, toUser,
} from './_common.js';

// Ported from https://github.com/s3eidat/pdf-sign (app.js): placement in shown-page points (y down from the top),
// upright on rotated pages, the "remove light background" knock-out for scanned signatures, and text marks. The
// website's drawing pad and handwriting fonts need a person, so this tool takes a ready signature image instead.
const LH = 1.2, BASE = 0.947; // line height of text marks, and where the baseline sits in that line (Helvetica/Arial)
const isRtl = (s: string) => /^[^A-Za-zÀ-ɏ]*[֐-ࣿיִ-ﻼ]/.test(s);

/** Remove a light background: alpha fades out above the threshold, then trim to the ink (website `knockOut` + `trim`). */
export async function knockOut(bytes: Buffer, thr: number | null) {
  const sharp = (await import('sharp')).default;
  let raw;
  try {
    raw = await sharp(bytes, { failOn: 'none' }).autoOrient().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw new ToolError(`The signature image couldn't be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { data: d, info } = raw, W = info.width, H = info.height, soft = 40;
  if (thr != null) {
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum >= thr) d[i + 3] = 0; else if (lum > thr - soft) d[i + 3] = Math.round((d[i + 3] * (thr - lum)) / soft);
    }
  }
  let l = W, t = H, r = -1, b = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 8) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  }
  if (r < 0) throw new ToolError('The signature image is empty after removing its background. Use a darker signature or set removeBackground to false.');
  const pad = 4;
  l = Math.max(0, l - pad); t = Math.max(0, t - pad); r = Math.min(W - 1, r + pad); b = Math.min(H - 1, b + pad);
  const png = await sharp(d, { raw: { width: W, height: H, channels: 4 } }).extract({ left: l, top: t, width: r - l + 1, height: b - t + 1 }).png().toBuffer();
  return { png, w: r - l + 1, h: b - t + 1 };
}

/** Text the standard font can't encode (Arabic, CJK…) is drawn to an image instead, so it still shows. */
async function textPng(lines: string[], pt: number, color: string) {
  const { createCanvas } = await canvasLib();
  const k = 4, font = `${pt * k}px ${SANS}`, probe = createCanvas(4, 4).getContext('2d');
  probe.font = font;
  const w = Math.max(1, ...lines.map((l) => probe.measureText(l).width)) + 2;
  const c = createCanvas(Math.ceil(w), Math.ceil(lines.length * LH * pt * k)), x = c.getContext('2d');
  x.font = font; x.fillStyle = color; x.textBaseline = 'alphabetic';
  lines.forEach((l, i) => {
    const rtl = isRtl(l);
    x.direction = rtl ? 'rtl' : 'ltr'; x.textAlign = rtl ? 'right' : 'left';
    x.fillText(l, rtl ? c.width - 1 : 1, (i * LH + BASE) * pt * k);
  });
  return { png: Buffer.from(await c.encode('png')), w: c.width / k, h: c.height / k };
}

export type SignItem =
  | { page: number; kind: 'image'; png: Uint8Array; x: number; y: number; w: number; h: number }
  | { page: number; kind: 'text'; text: string; x: number; y: number; pt: number; color: string };

/** items in shown-page points, y down from the top (website `buildSigned`). */
export async function buildSigned(doc: Awaited<ReturnType<typeof openPdf>>['doc'], items: SignItem[]) {
  const pages = doc.getPages(), cache = new Map<Uint8Array, PDFImage>();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = async (png: Uint8Array) => { if (!cache.has(png)) cache.set(png, await doc.embedPng(png)); return cache.get(png)!; };
  for (const it of items) {
    const pg = pages[it.page];
    if (!pg) continue;
    const { box, rot: r, H } = pageGeom(pg);
    const corner = (x: number, yTop: number, hh: number) => toUser(box, r, x, H - yTop - hh); // bottom-left of a box, in user space
    if (it.kind === 'image') {
      const [x, y] = corner(it.x, it.y, it.h);
      pg.drawImage(await img(it.png), { x, y, width: it.w, height: it.h, rotate: degrees(r) });
    } else {
      const lines = String(it.text).split('\n');
      if (lines.every((l) => encodable(font, l))) {
        lines.forEach((l, k) => {
          if (!l) return;
          const [x, y] = toUser(box, r, it.x, H - (it.y + (k * LH + BASE) * it.pt));
          pg.drawText(l, { x, y, size: it.pt, font, color: hexRgb(it.color), rotate: degrees(r) });
        });
      } else {
        const t = await textPng(lines, it.pt, cssHex(it.color)), [x, y] = corner(it.x, it.y, t.h);
        pg.drawImage(await doc.embedPng(t.png), { x, y, width: t.w, height: t.h, rotate: degrees(r) });
      }
    }
  }
}

export default defineTool({
  name: 'pdf_sign_image',
  title: 'Sign PDF with an image',
  webSlug: 'pdf-sign',
  description:
    'Place a signature (or initials, stamp, logo) image on PDF pages at x/y/width in points, measured from the top-left of ' +
    'the page as it is shown (rotated pages are handled). A light paper background is removed by default so scanned ' +
    'signatures sit cleanly on the page. Optional text marks (name, date…) can be added too. This is a visual signature, ' +
    'not a cryptographic digital signature. To draw a signature by hand, use the web version: ' + webUrl('pdf-sign'),
  inputSchema: z.object({
    file: fileInput('PDF'),
    signature: z.string().optional().describe('Signature image: local path or base64 (PNG, JPEG, WebP…).'),
    pages: z.string().optional().default('last').describe('Pages to sign: "last" (default), "1", "all", "1-3"…'),
    x: z.number().optional().default(72).describe('Left edge in points from the left of the page (72 pt = 1 inch). Default 72.'),
    y: z.number().optional().describe('Top edge in points from the TOP of the page. Default: 72 pt above the bottom margin.'),
    width: z.number().positive().optional().default(150).describe('Width in points. Default 150 (about 5.3 cm).'),
    height: z.number().positive().optional().describe('Height in points. Default: keeps the image aspect ratio.'),
    removeBackground: z.boolean().optional().default(true).describe('Make light (paper) pixels transparent and trim to the ink. Default true.'),
    threshold: z.number().int().min(100).max(255).optional().default(210).describe('Brightness (0-255) above which pixels become transparent. Default 210.'),
    texts: z
      .array(z.object({
        text: z.string().min(1).describe('Text; "\\n" starts a new line.'),
        page: z.number().int().min(1).optional().describe('1-based page; default: every signed page.'),
        x: z.number().describe('Left edge in points.'),
        y: z.number().describe('Top edge in points from the top of the page.'),
        size: z.number().min(4).max(96).optional().default(12).describe('Font size in points. Default 12.'),
        color: colorSchema('#111111'),
      }))
      .optional()
      .describe('Optional text marks, e.g. the printed name or the date.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfFileOutput,
    signedPages: z.array(z.number()),
    signature: z.object({ width: z.number(), height: z.number() }).nullable().describe('Placed size in points.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { file: 'contract.pdf', signature: 'signature.png', pages: 'last', x: 360, y: 700, width: 160 } },
    { input: { file: 'form.pdf', signature: 'sig.jpg', pages: '2', x: 80, y: 620, texts: [{ text: '29/10/2026', page: 2, x: 300, y: 640 }] } },
  ],
  async run(input, ctx) {
    if (!input.signature && !input.texts?.length) throw new ToolError('Give a "signature" image and/or "texts".');
    const { input: f, doc } = await openPdf(input.file, ctx);
    const n = doc.getPageCount(), sel = [...parseRangeSet(input.pages, n)];
    const items: SignItem[] = [];
    let size: { width: number; height: number } | null = null;
    if (input.signature) {
      const s = await knockOut((await readInput(input.signature, ctx, 'signature')).bytes, input.removeBackground ? input.threshold : null);
      const w = input.width, hh = input.height ?? (w * s.h) / s.w;
      size = { width: w, height: hh };
      for (const p of sel) {
        const { H } = pageGeom(doc.getPage(p));
        items.push({ page: p, kind: 'image', png: s.png, x: input.x, y: input.y ?? H - 72 - hh, w, h: hh });
      }
    }
    for (const t of input.texts ?? []) {
      if (t.page != null && t.page > n) throw new ToolError(`Page ${t.page} doesn't exist (the file has ${n})`);
      for (const p of t.page != null ? [t.page - 1] : sel) items.push({ page: p, kind: 'text', text: t.text, x: t.x, y: t.y, pt: t.size, color: t.color });
    }
    await buildSigned(doc, items);
    const w = await savePdf(doc, { output: input.output, defaultName: baseName(f) + '-signed.pdf', returnBase64: input.returnBase64 }, ctx);
    return { ...w, signedPages: [...new Set(items.map((i) => i.page + 1))].sort((a, b) => a - b), signature: size };
  },
});

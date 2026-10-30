import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import type { ToolContext } from '../../util/context.js';
import { fileInput, outputPath, readInput, returnBase64, writeOutput } from '../../util/files.js';

const MAX_SLIDES = 300;
const W = 13.333, H = 7.5, MX = 0.6;
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const THEMES = {
  light: { bg: 'FFFFFF', title: '111827', text: '374151', muted: '6B7280', accent: '2563EB', head: '2563EB', headText: 'FFFFFF', alt: 'F3F4F6', grid: 'D1D5DB', titleBg: '1E3A8A', titleFg: 'FFFFFF', titleSub: 'BFDBFE' },
  dark: { bg: '111827', title: 'F9FAFB', text: 'E5E7EB', muted: '9CA3AF', accent: '60A5FA', head: '1D4ED8', headText: 'FFFFFF', alt: '1F2937', grid: '374151', titleBg: '0B1220', titleFg: 'F9FAFB', titleSub: '93C5FD' },
} as const;
const CHART_COLORS = ['2563EB', 'F59E0B', '10B981', 'EF4444', '8B5CF6', '06B6D4', 'EC4899', '84CC16'];
const FONT = 'Calibri';

type PptxClass = typeof import('pptxgenjs').default;

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

const bulletItem = z.union([
  z.string(),
  z.object({ text: z.string(), level: z.number().int().min(0).max(4).optional().default(0) }),
  z.array(z.union([z.string(), z.array(z.string())])).describe('Sub-bullets of the previous item (a nested array goes one level deeper).'),
]);

const slideSchema = z.object({
  title: z.string().max(300).describe('Slide title.'),
  bullets: z.array(bulletItem).max(60).optional().describe('Bullet points. Strings, {text, level}, or an array right after an item for its sub-bullets: ["Point", ["sub a", "sub b"], "Point 2"].'),
  text: z.string().max(5000).optional().describe('A paragraph shown above the bullets (or alone).'),
  notes: z.string().max(20000).optional().describe('Speaker notes.'),
  image: fileInput('image (PNG, JPEG, GIF, WebP, SVG…)').optional(),
  table: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1).max(200).optional().describe('Table rows; the first row is the header.'),
  chart: z.object({
    type: z.enum(['bar', 'line', 'pie']),
    labels: z.array(z.union([z.string(), z.number()])).min(1).max(500),
    series: z.array(z.object({ name: z.string(), values: z.array(z.number()).min(1).max(500) })).min(1).max(12),
    title: z.string().optional(),
  }).optional(),
});

type Slide = z.infer<typeof slideSchema>;

/** Flatten the bullet notation into (text, level) pairs. */
export function flattenBullets(items: Slide['bullets']): { text: string; level: number }[] {
  const out: { text: string; level: number }[] = [];
  for (const it of items ?? []) {
    if (typeof it === 'string') out.push({ text: it, level: 0 });
    else if (Array.isArray(it)) {
      for (const sub of it) {
        if (typeof sub === 'string') out.push({ text: sub, level: 1 });
        else for (const s of sub) out.push({ text: s, level: 2 });
      }
    } else out.push({ text: it.text, level: it.level ?? 0 });
  }
  return out;
}

async function imageData(value: string, ctx: ToolContext, label: string) {
  const f = await readInput(value, ctx, label);
  const { default: sharp } = await import('sharp');
  try {
    const meta = await sharp(f.bytes, { density: 150 }).metadata();
    let bytes = f.bytes, mime = meta.format === 'jpeg' ? 'image/jpeg' : meta.format === 'png' ? 'image/png' : meta.format === 'gif' ? 'image/gif' : '';
    let w = meta.width ?? 1, h = meta.height ?? 1;
    if ((meta.orientation ?? 1) > 1 || !mime || Math.max(w, h) > 3000) {
      const r = await sharp(f.bytes, { density: 150 }).rotate().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
      bytes = r.data; mime = 'image/png'; w = r.info.width; h = r.info.height;
    }
    return { data: `${mime};base64,${bytes.toString('base64')}`, w, h };
  } catch (e) {
    throw new ToolError(`${label}: can't read this image (${e instanceof Error ? e.message : String(e)}).`);
  }
}

export default defineTool({
  name: 'ai_create_pptx',
  title: 'Create a PowerPoint deck',
  description:
    'Build a 16:9 PowerPoint (.pptx) deck from a simple outline: an optional title slide, then slides with a title plus any of bullets (nested), a paragraph, ' +
    'an image (file path or base64), a table (first row = header; long tables continue on extra slides), a native editable chart (bar, line, pie) and speaker notes. ' +
    'Light or dark theme with clean, readable defaults; text plus a visual are laid out side by side. Arabic/Hebrew text is set right-to-left. ' +
    `Up to ${MAX_SLIDES} slides. Opens in PowerPoint, Keynote, Google Slides and LibreOffice.`,
  inputSchema: z.object({
    title: z.string().max(300).optional().describe('Deck title: adds a title slide and sets the file title.'),
    subtitle: z.string().max(500).optional().describe('Subtitle on the title slide.'),
    author: z.string().max(200).optional(),
    theme: z.enum(['light', 'dark']).optional().default('light'),
    slides: z.array(slideSchema).min(1).max(MAX_SLIDES),
    slideNumbers: z.boolean().optional().default(true).describe('Show slide numbers on content slides. Default true.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    path: z.string(), bytes: z.number(), mimeType: z.string().optional(), base64: z.string().optional(),
    slides: z.number().describe('Slides in the deck (title slide and table continuation slides included).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: {
        title: 'Q3 Review', subtitle: 'Sales team', theme: 'light',
        slides: [
          { title: 'Highlights', bullets: ['Revenue up 12%', ['EMEA +20%', 'APAC +8%'], 'Two new clients'], notes: 'Start with the good news.' },
          { title: 'Revenue by month', chart: { type: 'bar', labels: ['Jul', 'Aug', 'Sep'], series: [{ name: 'Revenue', values: [120, 135, 150] }] } },
          { title: 'Team', table: [['Name', 'Deals'], ['Sara', 12], ['Omar', 9]] },
        ],
      },
      output: { slides: 4 },
    },
  ],
  async run(input, ctx) {
    // pptxgenjs ships CJS-style typings; at runtime Node loads its ESM build. Accept either shape.
    const mod = (await import('pptxgenjs')) as unknown as { default: PptxClass & { default?: PptxClass } };
    const PptxGenJS: PptxClass = mod.default.default ?? mod.default;
    const T = THEMES[input.theme];
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.title = input.title ?? input.slides[0].title;
    pptx.author = input.author ?? 'S3eidat Tools';
    pptx.company = 'S3eidat Tools';
    pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
    const rtl = (s: string) => (RTL.test(s) ? { rtlMode: true, align: 'right' as const } : {});

    if (input.title) {
      const s = pptx.addSlide();
      s.background = { color: T.titleBg };
      s.addShape('rect', { x: MX, y: 3.05, w: 1.2, h: 0.08, fill: { color: T.accent }, line: { color: T.accent, width: 0 } });
      s.addText(input.title, { x: MX, y: 1.4, w: W - 2 * MX, h: 1.6, fontFace: FONT, fontSize: 44, bold: true, color: T.titleFg, valign: 'bottom', fit: 'shrink', ...rtl(input.title) });
      if (input.subtitle) s.addText(input.subtitle, { x: MX, y: 3.3, w: W - 2 * MX, h: 1.0, fontFace: FONT, fontSize: 22, color: T.titleSub, valign: 'top', ...rtl(input.subtitle) });
      if (input.author) s.addText(input.author, { x: MX, y: H - 1.1, w: W - 2 * MX, h: 0.5, fontFace: FONT, fontSize: 14, color: T.titleSub, ...rtl(input.author) });
    }

    for (const [i, sd] of input.slides.entries()) {
      const s = pptx.addSlide();
      s.background = { color: T.bg };
      s.addText(sd.title, { x: MX, y: 0.35, w: W - 2 * MX, h: 0.95, fontFace: FONT, fontSize: 30, bold: true, color: T.title, valign: 'middle', fit: 'shrink', ...rtl(sd.title) });
      s.addShape('rect', { x: MX, y: 1.32, w: 0.9, h: 0.06, fill: { color: T.accent }, line: { color: T.accent, width: 0 } });
      if (input.slideNumbers) s.slideNumber = { x: W - 1.1, y: H - 0.55, w: 0.6, h: 0.35, fontFace: FONT, fontSize: 11, color: T.muted, align: 'right' };
      if (sd.notes) s.addNotes(sd.notes);

      const bullets = flattenBullets(sd.bullets);
      const hasText = !!sd.text || bullets.length > 0;
      const visuals = [sd.chart ? 'chart' : '', sd.table ? 'table' : '', sd.image ? 'image' : ''].filter(Boolean);
      const top = 1.6, bottom = H - 0.7, bodyH = bottom - top;
      const textBox = { x: MX, y: top, w: visuals.length ? 5.6 : W - 2 * MX, h: bodyH };
      const visX = visuals.length && hasText ? MX + 5.6 + 0.4 : MX, visW = W - MX - visX;

      if (hasText) {
        const lines = bullets.length + (sd.text ? Math.ceil(sd.text.length / (visuals.length ? 45 : 90)) : 0);
        const size = lines <= 6 ? 22 : lines <= 9 ? 19 : lines <= 13 ? 16 : 14;
        const runs: { text: string; options: Record<string, unknown> }[] = [];
        if (sd.text) runs.push({ text: sd.text, options: { fontSize: size, color: T.text, breakLine: true, paraSpaceAfter: 10, ...rtl(sd.text) } });
        for (const b of bullets) {
          runs.push({
            text: b.text,
            options: { bullet: b.level ? { characterCode: '2013' } : true, indentLevel: b.level, fontSize: Math.max(12, size - b.level * 2), color: b.level ? T.muted : T.text, breakLine: true, paraSpaceAfter: 6, ...rtl(b.text) },
          });
        }
        s.addText(runs as never, { ...textBox, fontFace: FONT, valign: 'top', fit: 'shrink', margin: 4 });
      }

      const slot = visuals.length ? (bodyH - 0.2 * (visuals.length - 1)) / visuals.length : 0;
      let vy = top;
      for (const v of visuals) {
        const box = { x: visX, y: vy, w: visW, h: slot };
        vy += slot + 0.2;
        if (v === 'chart') {
          const c = sd.chart!;
          for (const se of c.series) if (se.values.length !== c.labels.length) throw new ToolError(`Slide ${i + 1}: chart series "${se.name}" has ${se.values.length} values but there are ${c.labels.length} labels.`);
          const data = c.series.map((se) => ({ name: se.name, labels: c.labels.map(String), values: se.values }));
          const pie = c.type === 'pie';
          s.addChart(c.type as never, pie ? data.slice(0, 1) : data, {
            ...box, chartColors: CHART_COLORS, fontFace: FONT,
            showLegend: pie || c.series.length > 1, legendPos: 'b', legendColor: T.text, legendFontSize: 12,
            showTitle: !!c.title, title: c.title, titleColor: T.title, titleFontSize: 16,
            catAxisLabelColor: T.text, valAxisLabelColor: T.text, catAxisLabelFontSize: 12, valAxisLabelFontSize: 11,
            valGridLine: { color: T.grid, style: 'solid', size: 0.5 }, catGridLine: { style: 'none' },
            ...(pie ? { showPercent: true, dataLabelColor: 'FFFFFF', dataLabelFontSize: 12 } : {}),
            ...(c.type === 'bar' ? { barDir: 'col', barGapWidthPct: 60 } : {}),
            ...(c.type === 'line' ? { lineSize: 3, lineDataSymbol: 'circle', lineDataSymbolSize: 8 } : {}),
          } as never);
        } else if (v === 'table') {
          const rows = sd.table!;
          const cols = Math.max(...rows.map((r) => r.length));
          const fontSize = rows.length <= 7 ? 14 : rows.length <= 12 ? 12 : 10;
          const tableRows = rows.map((r, ri) =>
            Array.from({ length: cols }, (_, ci) => {
              const val = r[ci] ?? '';
              const text = val === null ? '' : String(val);
              return {
                text,
                options: {
                  bold: ri === 0, color: ri === 0 ? T.headText : T.text,
                  fill: { color: ri === 0 ? T.head : ri % 2 === 0 ? T.alt : T.bg },
                  align: typeof val === 'number' ? 'right' : RTL.test(text) ? 'right' : 'left',
                  ...(RTL.test(text) ? { rtlMode: true } : {}),
                },
              };
            }),
          );
          s.addTable(tableRows as never, {
            x: box.x, y: box.y, w: box.w, colW: Array(cols).fill(box.w / cols), fontFace: FONT, fontSize, valign: 'middle',
            border: { type: 'solid', pt: 0.75, color: T.grid }, margin: 0.06,
            autoPage: true, autoPageRepeatHeader: true, autoPageHeaderRows: 1, autoPageSlideStartY: top, autoPageCharWeight: 0, autoPageLineWeight: 0,
            h: undefined,
          } as never);
        } else {
          const img = await imageData(sd.image!, ctx, `slides[${i}].image`);
          const k = Math.min(box.w / img.w, box.h / img.h);
          const w = img.w * k, h = img.h * k;
          s.addImage({ data: img.data, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h });
        }
      }
    }

    const buf = (await pptx.write({ outputType: 'nodebuffer', compression: true })) as Buffer;
    // Count the slides actually written (long tables add continuation slides).
    const { unzipSync } = await import('fflate');
    let count = 0;
    unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { filter: (f) => { if (/^ppt\/slides\/slide\d+\.xml$/.test(f.name)) count++; return false; } });
    const name = (input.title ?? input.slides[0].title).slice(0, 80) || 'presentation';
    const out = await writeOutput(new Uint8Array(buf), { output: input.output, defaultName: `${name}.pptx`, mimeType: PPTX_MIME, base64: input.returnBase64 }, ctx);
    return { ...out, slides: count };
  },
});

import { posix } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { fileInput, readInput } from '../../util/files.js';
import { ToolError } from '../../util/errors.js';
import { parsePageRanges } from '../../util/pdf.js';
import { cell, emitMarkdown, maxCharsInput, mdOutputInput, mdOutputShape, mdTable, stemOf, tidyMd } from './_md.js';

// PowerPoint XML is read with small regexes: shapes (<p:sp>) never nest inside each other, and text lives in
// <a:p> paragraphs of <a:r>/<a:fld> runs (<a:t>) and <a:br/> breaks.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function xmlText(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m);
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

interface Para { text: string; level: number; bullet: boolean; numbered: boolean }

/** Paragraphs of one text body. `bodyDefault`: paragraphs are bullets unless told otherwise (body placeholders). */
function paragraphs(xml: string, bodyDefault: boolean): Para[] {
  const out: Para[] = [];
  for (const m of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\s[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const inner = m[1] ?? m[2] ?? '';
    let text = '';
    for (const r of inner.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:t\s[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) {
      text += r[0].startsWith('<a:br') ? '\n' : xmlText(r[1] ?? r[2] ?? '');
    }
    text = text.replace(/[ \t ]+/g, ' ').trim();
    if (!text) continue;
    const pPr = /<a:pPr\b[^>]*(\/>|>[\s\S]*?<\/a:pPr>)/.exec(inner)?.[0] ?? '';
    const level = Number(attr(pPr, 'lvl') ?? 0) || 0;
    const none = /<a:buNone\b/.test(pPr);
    const numbered = /<a:buAutoNum\b/.test(pPr);
    const bullet = !none && (numbered || /<a:buChar\b/.test(pPr) || bodyDefault);
    out.push({ text, level, bullet, numbered });
  }
  return out;
}

function paraMd(ps: Para[]) {
  const lines: string[] = [];
  let num = 0;
  ps.forEach((p, i) => {
    if (p.bullet) {
      num = p.numbered ? (ps[i - 1]?.numbered && ps[i - 1].level === p.level ? num + 1 : 1) : 0;
      const marker = p.numbered ? `${num}. ` : '- ';
      const indent = '  '.repeat(p.level);
      lines.push(indent + marker + p.text.replace(/\n/g, '\n' + indent + ' '.repeat(marker.length)));
    } else {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(p.text.replace(/\n/g, '  \n'));
      lines.push('');
    }
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function placeholderType(sp: string) {
  const ph = /<p:ph\b[^>]*>/.exec(sp)?.[0];
  if (!ph) return undefined;
  return attr(ph, 'type') ?? 'body'; // a placeholder without a type is a body placeholder
}

function tableMd(frame: string) {
  const rows: string[][] = [];
  for (const tr of frame.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
    const cells: string[] = [];
    for (const tc of tr[1].matchAll(/<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>|<a:tc\b[^>]*\/>/g)) {
      if (/\b(hMerge|vMerge)="(1|true)"/.test(tc[1] ?? '')) { cells.push(''); continue; }
      cells.push(cell(paragraphs(tc[2] ?? '', false).map((p) => p.text).join('\n')));
    }
    rows.push(cells);
  }
  return mdTable(rows);
}

export interface SlideOut { slide: number; title?: string; notes?: string; markdown: string }

/** Title + body Markdown of one slide's XML. */
export function slideToMd(xml: string): { title?: string; body: string } {
  const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)].map((m) => m[0]);
  let title: string | undefined;
  const blocks: string[] = [];
  const texts: { kind: string | undefined; paras: Para[] }[] = [];
  for (const sp of shapes) {
    if (sp.startsWith('<p:graphicFrame')) {
      if (/<a:tbl\b/.test(sp)) blocks.push(tableMd(sp));
      continue;
    }
    const kind = placeholderType(sp);
    if (kind === 'sldNum' || kind === 'dt' || kind === 'ftr' || kind === 'hdr') continue;
    const body = /<p:txBody\b[\s\S]*?<\/p:txBody>/.exec(sp)?.[0];
    if (!body) continue;
    const paras = paragraphs(body, kind === 'body' || kind === 'obj');
    if (!paras.length) continue;
    if (title === undefined && (kind === 'title' || kind === 'ctrTitle')) {
      title = paras.map((p) => p.text).join(' ').replace(/\s+/g, ' ');
      continue;
    }
    texts.push({ kind, paras });
    blocks.push(paraMd(paras));
  }
  // No title placeholder (e.g. decks built in code): a first text box with one short line serves as the title.
  if (title === undefined && texts[0] && !texts[0].kind && texts[0].paras.length === 1 && texts[0].paras[0].text.length <= 120 && !texts[0].paras[0].text.includes('\n')) {
    title = texts[0].paras[0].text;
    blocks.splice(blocks.indexOf(paraMd(texts[0].paras)), 1);
  }
  return { title, body: blocks.filter(Boolean).join('\n\n') };
}

/** Speaker notes: the body placeholder of a notes slide. */
export function notesText(xml: string) {
  const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).filter((sp) => placeholderType(sp) === 'body');
  return shapes.map((sp) => paraMd(paragraphs(sp, false))).filter(Boolean).join('\n\n');
}

function relsMap(xml: string | undefined, baseDir: string) {
  const map = new Map<string, { target: string; type: string }>();
  for (const m of (xml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target'), type = attr(m[0], 'Type') ?? '';
    if (id && target) map.set(id, { target: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(baseDir, target)), type });
  }
  return map;
}

export default defineTool({
  name: 'ai_pptx_to_markdown',
  title: 'PowerPoint (.pptx) to Markdown',
  description:
    'Extract the text of a PowerPoint .pptx deck as Markdown: one "## Slide N: title" section per slide in presentation ' +
    'order, text boxes as paragraphs and bullet lists (with indent levels), tables as Markdown tables, and speaker notes ' +
    'as a quote under each slide. Images, charts and SmartArt text are not extracted. Old binary .ppt is not supported. ' +
    'Optional "slides" range (e.g. "1-5, 8"). Accepts a local path or base64. Inline Markdown is cut at maxChars ' +
    '(default 200k); "output" saves it to a file. Runs locally; nothing is uploaded.',
  inputSchema: z.object({
    file: fileInput('.pptx presentation'),
    slides: z.string().optional().describe('Slides to include, e.g. "1-3, 7" or "5-" (1-based). Default: all.'),
    notes: z.boolean().optional().default(true).describe('Include speaker notes. Default true.'),
    maxChars: maxCharsInput(),
    output: mdOutputInput(),
  }),
  outputSchema: z.object({
    slideCount: z.number().describe('Slides in the deck.'),
    slides: z.array(z.object({ slide: z.number(), title: z.string().optional(), hasNotes: z.boolean() })),
    ...mdOutputShape,
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'pitch.pptx' } }, { input: { file: 'lecture.pptx', slides: '1-10', notes: false } }],
  async run(input, ctx) {
    const f = await readInput(input.file, ctx, '.pptx presentation');
    if (f.bytes[0] === 0xd0 && f.bytes[1] === 0xcf) throw new ToolError('This is an old binary .ppt file; only .pptx is supported. Save it as .pptx first.');
    if (f.bytes[0] !== 0x50 || f.bytes[1] !== 0x4b) throw new ToolError('Not a .pptx file (it is not a ZIP package).');
    const { unzipSync, strFromU8 } = await import('fflate');
    let files: Record<string, Uint8Array>;
    try {
      // Only the XML parts are needed; skip media so big decks stay cheap.
      files = unzipSync(new Uint8Array(f.bytes), { filter: (e) => e.name.endsWith('.xml') || e.name.endsWith('.rels') });
    } catch (e) {
      throw new ToolError(`The .pptx could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const read = (p: string) => (files[p] ? strFromU8(files[p]) : undefined);
    const pres = read('ppt/presentation.xml');
    if (!pres) throw new ToolError('Not a PowerPoint file: ppt/presentation.xml is missing.');

    // Slide order: <p:sldIdLst> in presentation.xml via its rels; fall back to slideN numbering.
    const presRels = relsMap(read('ppt/_rels/presentation.xml.rels'), 'ppt');
    let order = [...pres.matchAll(/<p:sldId\b[^>]*>/g)]
      .map((m) => presRels.get(attr(m[0], 'r:id') ?? '')?.target)
      .filter((p): p is string => !!p && !!files[p]);
    if (!order.length) {
      order = Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
    }
    if (!order.length) throw new ToolError('The presentation has no slides.');

    const picked = parsePageRanges(input.slides, order.length);
    const parts: string[] = [];
    const slides: { slide: number; title?: string; hasNotes: boolean }[] = [];
    for (const i of picked) {
      const path = order[i];
      const { title, body } = slideToMd(read(path) ?? '');
      let notes = '';
      if (input.notes) {
        const rels = relsMap(read(posix.join(posix.dirname(path), '_rels', posix.basename(path) + '.rels')), posix.dirname(path));
        const notesPath = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
        if (notesPath) notes = notesText(read(notesPath) ?? '');
      }
      const n = i + 1;
      let sec = `## Slide ${n}${title ? ': ' + title.replace(/\n/g, ' ') : ''}\n\n${body || '_(no text)_'}`;
      if (notes) sec += '\n\n**Notes:**\n\n' + notes.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
      parts.push(sec);
      slides.push({ slide: n, ...(title ? { title } : {}), hasNotes: !!notes });
    }
    const markdown = tidyMd(parts.join('\n\n'));
    const out = await emitMarkdown(markdown, { output: input.output, maxChars: input.maxChars, defaultName: stemOf(f, 'presentation') + '.md' }, ctx);
    return { slideCount: order.length, slides, ...out };
  },
});

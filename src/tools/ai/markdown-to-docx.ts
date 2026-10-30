import { z } from 'zod';
import type { Token, Tokens } from 'marked';
import { defineTool, ToolError } from '../../registry.js';
import { fileOutputShape, outputPath, readTextInput, returnBase64, writeOutput } from '../../util/files.js';

type Docx = typeof import('docx');
type Inline = InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']>;
type Block = InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>;

interface RunStyle { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean; link?: boolean }

const ARABIC = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
const LATIN = /[A-Za-zÀ-ɏ]/g;

/** True when the text is mostly Arabic/Hebrew letters. */
export function isRtlText(s: string) {
  const r = s.match(ARABIC)?.length ?? 0;
  const l = s.match(LATIN)?.length ?? 0;
  return r > 0 && r >= l;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text of a token tree (for RTL detection). */
function plain(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens.map((t) => {
    const tt = t as Tokens.Generic;
    if (Array.isArray(tt.tokens)) return plain(tt.tokens as Token[]);
    return typeof tt.text === 'string' ? tt.text : '';
  }).join('');
}

const PAGE_BREAK = /^\\newpage\s*$/;

class Builder {
  blocks: Block[] = [];
  private olInstance = 0;
  constructor(private d: Docx, private o: { font: string; mono: string; rtl: 'auto' | 'on' | 'off' }) {}

  private rtl(text: string) {
    return this.o.rtl === 'on' || (this.o.rtl === 'auto' && isRtlText(text));
  }

  private run(text: string, st: RunStyle, rtl: boolean) {
    return new this.d.TextRun({
      text,
      bold: st.bold || undefined,
      italics: st.italics || undefined,
      strike: st.strike || undefined,
      font: st.code ? this.o.mono : undefined,
      shading: st.code ? { type: this.d.ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } : undefined,
      style: st.link ? 'Hyperlink' : undefined,
      rightToLeft: rtl || undefined,
    });
  }

  inline(tokens: Token[] | undefined, st: RunStyle, rtl: boolean): Inline[] {
    const out: Inline[] = [];
    for (const t of tokens ?? []) {
      const tk = t as Tokens.Generic;
      switch (t.type) {
        case 'text':
        case 'escape':
          if (Array.isArray(tk.tokens) && tk.tokens.length) out.push(...this.inline(tk.tokens as Token[], st, rtl));
          else out.push(this.run(decode(String(tk.text ?? '')), st, rtl));
          break;
        case 'strong': out.push(...this.inline(tk.tokens as Token[], { ...st, bold: true }, rtl)); break;
        case 'em': out.push(...this.inline(tk.tokens as Token[], { ...st, italics: true }, rtl)); break;
        case 'del': out.push(...this.inline(tk.tokens as Token[], { ...st, strike: true }, rtl)); break;
        case 'codespan': out.push(this.run(String(tk.text ?? ''), { ...st, code: true }, false)); break;
        case 'br': out.push(new this.d.TextRun({ text: '', break: 1 })); break;
        case 'link': {
          const href = String(tk.href ?? '');
          const kids = this.inline(tk.tokens as Token[], { ...st, link: true }, rtl).filter((k): k is InstanceType<Docx['TextRun']> => k instanceof this.d.TextRun);
          if (/^(https?:|mailto:|ftp:)/i.test(href)) out.push(new this.d.ExternalHyperlink({ link: href, children: kids }));
          else out.push(...kids);
          break;
        }
        case 'image': out.push(this.run(`[${tk.text || 'image'}]`, { ...st, italics: true }, rtl)); break;
        case 'checkbox': out.push(this.run(tk.checked ? '☑ ' : '☐ ', st, rtl)); break;
        case 'html': {
          const txt = String(tk.text ?? '');
          if (/^<br\s*\/?>$/i.test(txt.trim())) out.push(new this.d.TextRun({ text: '', break: 1 }));
          else if (!/^<\/?[a-z][^>]*>$/i.test(txt.trim())) out.push(this.run(decode(txt), st, rtl));
          break;
        }
        default:
          if (typeof tk.text === 'string') out.push(this.run(decode(tk.text), st, rtl));
      }
    }
    return out;
  }

  private para(tokens: Token[] | undefined, extra: Record<string, unknown> = {}, st: RunStyle = {}) {
    const rtl = this.rtl(plain(tokens));
    return new this.d.Paragraph({ children: this.inline(tokens, st, rtl), bidirectional: rtl || undefined, ...extra });
  }

  block(tokens: Token[], ctx: { quote?: number; list?: { level: number } } = {}) {
    // Blockquotes get a left rule; continuation paragraphs inside a list item line up with its text.
    const left = 360 * (ctx.quote ?? 0) + (ctx.list ? 720 * (ctx.list.level + 1) : 0);
    const quoteProps = {
      ...(left ? { indent: { left } } : {}),
      ...(ctx.quote ? { border: { left: { style: this.d.BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 } } } : {}),
    };
    for (const t of tokens) {
      const tk = t as Tokens.Generic;
      switch (t.type) {
        case 'space': break;
        case 'heading': {
          const H = this.d.HeadingLevel;
          const level = [H.HEADING_1, H.HEADING_2, H.HEADING_3, H.HEADING_4, H.HEADING_5, H.HEADING_6][Math.min(6, Math.max(1, tk.depth)) - 1];
          this.blocks.push(this.para(tk.tokens as Token[], { heading: level, ...quoteProps }));
          break;
        }
        case 'paragraph':
          if (PAGE_BREAK.test(String(tk.raw ?? '').trim())) { this.blocks.push(new this.d.Paragraph({ children: [new this.d.PageBreak()] })); break; }
          this.blocks.push(this.para(tk.tokens as Token[], { ...quoteProps, spacing: { after: 120 } }, ctx.quote ? { italics: true } : {}));
          break;
        case 'text':
          // Block-level text appears inside tight list items.
          this.blocks.push(this.para(tk.tokens as Token[] ?? [{ type: 'text', raw: tk.raw, text: tk.text } as Token], quoteProps));
          break;
        case 'blockquote': this.block(tk.tokens as Token[], { ...ctx, quote: (ctx.quote ?? 0) + 1 }); break;
        case 'list': this.list(t as Tokens.List, ctx.list ? ctx.list.level + 1 : 0, ctx.quote); break;
        case 'code': {
          const lines = String(tk.text ?? '').split('\n');
          this.blocks.push(new this.d.Paragraph({
            children: lines.map((l, i) => new this.d.TextRun({ text: l, font: this.o.mono, size: 20, break: i ? 1 : undefined })),
            shading: { type: this.d.ShadingType.CLEAR, fill: 'F5F5F5', color: 'auto' },
            border: { left: { style: this.d.BorderStyle.SINGLE, size: 12, color: 'D0D0D0', space: 6 } },
            spacing: { before: 60, after: 120 },
            ...(ctx.quote ? { indent: { left: 360 * ctx.quote } } : {}),
          }));
          break;
        }
        case 'hr':
          this.blocks.push(new this.d.Paragraph({ children: [], border: { bottom: { style: this.d.BorderStyle.SINGLE, size: 6, color: 'A6A6A6', space: 1 } } }));
          break;
        case 'table': this.table(t as Tokens.Table); break;
        case 'html': {
          const text = String(tk.text ?? '').replace(/<[^>]+>/g, '').trim();
          if (text) this.blocks.push(new this.d.Paragraph({ children: [this.run(decode(text), {}, this.rtl(text))], bidirectional: this.rtl(text) || undefined }));
          break;
        }
        case 'def': break;
        default:
          if (typeof tk.text === 'string' && tk.text.trim()) this.blocks.push(new this.d.Paragraph({ children: [this.run(decode(tk.text), {}, false)] }));
      }
    }
  }

  private list(l: Tokens.List, level: number, quote?: number) {
    const lvl = Math.min(level, 8);
    const instance = l.ordered ? ++this.olInstance : 0;
    for (const item of l.items) {
      // The item's first paragraph (and its checkbox) carries the bullet; nested blocks follow it.
      const inl: Token[] = [];
      const rest: Token[] = [];
      let taken = false;
      for (const t of item.tokens) {
        if (!taken && t.type === 'checkbox') inl.push(t);
        else if (!taken && (t.type === 'text' || t.type === 'paragraph')) {
          const tk = t as Tokens.Generic;
          inl.push(...(Array.isArray(tk.tokens) ? (tk.tokens as Token[]) : [{ type: 'text', raw: tk.raw, text: tk.text } as Token]));
          taken = true;
        } else rest.push(t);
      }
      const rtl = this.rtl(plain(inl));
      const numbering = l.ordered
        ? { numbering: { reference: 'md-numbers', level: lvl, instance } }
        : { bullet: { level: lvl } };
      this.blocks.push(new this.d.Paragraph({
        children: this.inline(inl, {}, rtl), bidirectional: rtl || undefined, ...numbering,
        ...(quote ? { indent: { left: 360 * quote + 720 * (lvl + 1), hanging: 360 } } : {}),
      }));
      this.block(rest, { quote, list: { level: lvl } });
    }
  }

  private table(t: Tokens.Table) {
    const d = this.d;
    const align = (a: string | null) => (a === 'center' ? d.AlignmentType.CENTER : a === 'right' ? d.AlignmentType.RIGHT : undefined);
    const cell = (c: Tokens.TableCell, head: boolean, i: number) => {
      const rtl = this.rtl(plain(c.tokens));
      return new d.TableCell({
        children: [new d.Paragraph({ children: this.inline(c.tokens, { bold: head || undefined }, rtl), alignment: align(t.align[i]), bidirectional: rtl || undefined })],
        shading: head ? { type: d.ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
      });
    };
    const rows = [
      new d.TableRow({ children: t.header.map((c, i) => cell(c, true, i)), tableHeader: true }),
      ...t.rows.map((r) => new d.TableRow({ children: t.header.map((_, i) => cell(r[i] ?? { text: '', tokens: [], header: false, align: null }, false, i)) })),
    ];
    const rtlTable = this.rtl(t.header.map((c) => c.text).join(' '));
    this.blocks.push(new d.Table({ rows, width: { size: 100, type: d.WidthType.PERCENTAGE }, visuallyRightToLeft: rtlTable || undefined }));
    this.blocks.push(new d.Paragraph({ children: [] }));
  }
}

function firstHeading(tokens: Token[]) {
  const h = tokens.find((t) => t.type === 'heading') as Tokens.Heading | undefined;
  return h ? h.text.replace(/[*_`~[\]]/g, '').trim() : undefined;
}

export default defineTool({
  name: 'ai_markdown_to_docx',
  title: 'Markdown to Word (.docx)',
  description:
    'Convert Markdown (GitHub flavoured) to a real Word .docx: headings H1-H6 (Word heading styles, so the navigation pane and ' +
    'table of contents work), paragraphs with bold, italic, strikethrough, inline code and clickable links, bullet and numbered ' +
    'lists (nested, numbering restarts per list, task-list checkboxes), tables (header row shaded, column alignment kept), ' +
    'blockquotes, fenced code blocks in a monospace font, horizontal rules, and a page break wherever a line says \\newpage. ' +
    'Arabic/Hebrew paragraphs are laid out right-to-left automatically (rtl: "auto"). Images are not embedded (their alt text ' +
    'is shown); raw HTML tags are dropped. Options: title and author (document properties), font (default Calibri), fontSize. ' +
    'Give "markdown" inline or "path" to a .md file. Writes the .docx to "output" (default name from the title or first heading).',
  inputSchema: z.object({
    markdown: z.string().optional().describe('The Markdown text inline.'),
    path: z.string().optional().describe('Or: a Markdown file (local path or base64).'),
    title: z.string().optional().describe('Document title (file properties, and the default file name).'),
    author: z.string().optional().describe('Author shown in the file properties.'),
    font: z.string().optional().default('Calibri').describe('Body font (default Calibri).'),
    fontSize: z.number().min(6).max(36).optional().default(11).describe('Body font size in points (default 11).'),
    rtl: z.enum(['auto', 'on', 'off']).optional().default('auto').describe('Right-to-left paragraphs: "auto" (detect Arabic/Hebrew per paragraph), "on" or "off".'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...fileOutputShape, paragraphs: z.number().describe('Paragraphs and tables written.') }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { markdown: '# Report\n\nHello **world**.\n\n- one\n- two', title: 'Report' } }],
  async run(input, ctx) {
    const md = await readTextInput(input.markdown, input.path, ctx);
    if (!md.trim()) throw new ToolError('The Markdown is empty.');
    const [{ marked }, d] = await Promise.all([import('marked'), import('docx')]);
    const tokens = marked.lexer(md.replace(/\r\n?/g, '\n'), { gfm: true });
    const b = new Builder(d, { font: input.font, mono: 'Consolas', rtl: input.rtl });
    b.block(tokens);
    if (!b.blocks.length) b.blocks.push(new d.Paragraph({ children: [] }));

    const half = Math.round(input.fontSize * 2);
    const heading = (pt: number, color = '1F3864') => ({ run: { font: input.font, size: pt * 2, bold: true, color }, paragraph: { spacing: { before: 240, after: 120 } } });
    const levels = Array.from({ length: 9 }, (_, i) => ({
      level: i,
      format: [d.LevelFormat.DECIMAL, d.LevelFormat.LOWER_LETTER, d.LevelFormat.LOWER_ROMAN][i % 3],
      text: `%${i + 1}.`,
      alignment: d.AlignmentType.START,
      style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
    }));
    const title = input.title ?? firstHeading(tokens);
    const doc = new d.Document({
      title: title ?? undefined,
      creator: input.author ?? 'S3eidat Tools',
      lastModifiedBy: input.author ?? 'S3eidat Tools',
      styles: {
        default: {
          document: { run: { font: input.font, size: half } },
          heading1: heading(20), heading2: heading(16), heading3: heading(14), heading4: heading(12, '2F5496'),
          heading5: heading(11, '2F5496'), heading6: heading(11, '595959'),
          hyperlink: { run: { color: '0563C1', underline: { type: d.UnderlineType.SINGLE } } },
        },
      },
      numbering: { config: [{ reference: 'md-numbers', levels }] },
      sections: [{ children: b.blocks }],
    });
    const buf = await d.Packer.toBuffer(doc);
    const w = await writeOutput(buf, {
      output: input.output,
      defaultName: (title ? title.slice(0, 80) : 'document') + '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: input.returnBase64,
    }, ctx);
    return { ...w, paragraphs: b.blocks.length };
  },
});

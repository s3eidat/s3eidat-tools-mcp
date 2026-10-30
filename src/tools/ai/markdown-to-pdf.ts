import { dirname, isAbsolute, join } from 'node:path';
import { PDFName, PDFString, StandardFonts, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Token, Tokens } from 'marked';
import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import type { ToolContext } from '../../util/context.js';
import { outputPath, readInput, returnBase64 } from '../../util/files.js';
import { color, embedImage, isWinAnsi, MM, newDoc, PAPER, pdfOutputShape, pdfSafe, savePdf } from '../web/docs/_pdf.js';

// ---------- characters ----------
/** Common non-Latin-1 symbols mapped to something the standard PDF fonts can show. */
const REPLACE: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=', '⟶': '->', '↑': '^', '↓': 'v', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~',
  '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '★': '*', '☆': '*', '▶': '>', '►': '>', '◀': '<', '▪': '•', '■': '•', '□': '[ ]', '☐': '[ ]', '☑': '[x]', '☒': '[x]',
  '─': '-', '━': '-', '│': '|', '┃': '|', '┌': '+', '┐': '+', '└': '+', '┘': '+', '├': '+', '┤': '+', '┬': '+', '┴': '+', '┼': '+',
  '′': "'", '″': '"', '‚': ',', '∶': ':', '∙': '·', '⋅': '·', '−': '-', '∗': '*', '‐': '-', '‑': '-', '⁄': '/', '∕': '/',
};
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{FE0E}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/u;

export class CharFilter {
  unsupported = new Set<string>();
  constructor(private mode: 'replace' | 'error') {}
  clean(s: string): string {
    s = pdfSafe(s).replace(/\t/g, '    ');
    let out = '';
    for (const ch of s) {
      if (ch === '\n' || isWinAnsi(ch)) { out += ch; continue; }
      const r = REPLACE[ch];
      if (r !== undefined) { out += r; continue; }
      if (EMOJI.test(ch)) { if (!/[\u{FE0F}\u{FE0E}\u{200D}\u{1F3FB}-\u{1F3FF}]/u.test(ch)) this.unsupported.add(ch); continue; }
      if (this.mode === 'error') {
        const code = 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
        throw new ToolError(`The text contains "${ch}" (${code}), which the built-in PDF fonts can't show (Latin text only; Arabic, CJK and other scripts are not supported yet). Use onUnsupportedChar: "replace" to print "?" instead.`);
      }
      this.unsupported.add(ch);
      out += '?';
    }
    return out;
  }
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', deg: '°', times: '×', divide: '÷', middot: '·', bull: '•' };
function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

// ---------- inline runs ----------
interface Style { bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; link?: string; color?: string; size: number }
type Run = { text: string; style: Style } | { br: true };

interface FontSet { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont; mono: PDFFont; monoBold: PDFFont }

const LINK = '#1d4ed8', CODE_BG = '#f1f3f5', MUTED = '#555e6b', INK = '#1a1d21', RULE = '#d0d5dc', QUOTE_BAR = '#c5ccd6', HEAD_BG = '#eef1f5', ZEBRA = '#f8f9fb';

const PAGEBREAK = /^\s*(\\pagebreak|\\newpage|<!--\s*(page-?break|new-?page)\s*-->|<div[^>]*page-break-(after|before)\s*:\s*always[^>]*>\s*<\/div>|<div[^>]*break-(after|before)\s*:\s*page[^>]*>\s*<\/div>)\s*$/i;

class Inline {
  constructor(public chars: CharFilter) {}
  runs(tokens: Token[] | undefined, style: Style, out: Run[] = []): Run[] {
    for (const t of tokens ?? []) {
      switch (t.type) {
        case 'text': {
          const tt = t as Tokens.Text;
          if (tt.tokens?.length) this.runs(tt.tokens, style, out);
          else out.push({ text: this.chars.clean(decodeEntities(tt.text)), style });
          break;
        }
        case 'escape': out.push({ text: this.chars.clean((t as Tokens.Escape).text), style }); break;
        case 'strong': this.runs((t as Tokens.Strong).tokens, { ...style, bold: true }, out); break;
        case 'em': this.runs((t as Tokens.Em).tokens, { ...style, italic: true }, out); break;
        case 'del': this.runs((t as Tokens.Del).tokens, { ...style, strike: true }, out); break;
        case 'codespan': out.push({ text: this.chars.clean(decodeEntities((t as Tokens.Codespan).text)), style: { ...style, code: true } }); break;
        case 'br': out.push({ br: true }); break;
        case 'link': {
          const l = t as Tokens.Link;
          this.runs(l.tokens, { ...style, link: l.href, color: LINK }, out);
          break;
        }
        case 'image': {
          const im = t as Tokens.Image;
          out.push({ text: this.chars.clean(`[image: ${im.text || im.href}]`), style: { ...style, italic: true, color: MUTED } });
          break;
        }
        case 'html': {
          const h = (t as Tokens.HTML).text;
          if (/^<br\s*\/?>$/i.test(h.trim())) out.push({ br: true });
          break; // other inline tags are dropped (their text content arrives as text tokens)
        }
        case 'checkbox': break;
        default: {
          const any = t as { text?: string; tokens?: Token[] };
          if (any.tokens) this.runs(any.tokens, style, out);
          else if (any.text) out.push({ text: this.chars.clean(any.text), style });
        }
      }
    }
    return out;
  }
}

// ---------- line layout ----------
interface Piece { text: string; style: Style; font: PDFFont; size: number; w: number }
interface Word { pieces: Piece[]; space: boolean; w: number; br?: boolean }
interface Line { items: { word: Word; gap: number }[]; w: number; size: number }

class Typesetter {
  constructor(public f: FontSet) {}
  font(s: Style) {
    if (s.code) return s.bold ? this.f.monoBold : this.f.mono;
    return s.bold ? (s.italic ? this.f.boldItalic : this.f.bold) : s.italic ? this.f.italic : this.f.regular;
  }
  piece(text: string, style: Style): Piece {
    const font = this.font(style), size = style.code ? style.size * 0.9 : style.size;
    return { text, style, font, size, w: font.widthOfTextAtSize(text, size) };
  }
  words(runs: Run[]): Word[] {
    const words: Word[] = [];
    let cur: Piece[] = [], space = false;
    const flush = () => { if (cur.length) { words.push({ pieces: cur, space, w: cur.reduce((a, p) => a + p.w, 0) }); cur = []; space = false; } };
    for (const r of runs) {
      if ('br' in r) { flush(); words.push({ pieces: [], space: false, w: 0, br: true }); continue; }
      for (const part of r.text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part) && !/^ +$/.test(part)) { flush(); space = true; } else cur.push(this.piece(part, r.style));
      }
    }
    flush();
    return words;
  }
  spaceW(w: Word) { const p = w.pieces[0]; return p ? p.font.widthOfTextAtSize(' ', p.size) : 0; }
  /** Split a word wider than maxW into chunks by character. */
  split(word: Word, maxW: number): Word[] {
    const out: Word[] = [];
    let cur: Piece[] = [], w = 0;
    for (const p of word.pieces) {
      let buf = '';
      for (const ch of p.text) {
        const cw = p.font.widthOfTextAtSize(ch, p.size);
        if (w + cw > maxW && (cur.length || buf)) {
          if (buf) cur.push(this.piece(buf, p.style));
          out.push({ pieces: cur, space: out.length ? false : word.space, w: cur.reduce((a, x) => a + x.w, 0) });
          cur = []; buf = ''; w = 0;
        }
        buf += ch; w += cw;
      }
      if (buf) cur.push(this.piece(buf, p.style));
    }
    if (cur.length) out.push({ pieces: cur, space: out.length ? false : word.space, w: cur.reduce((a, x) => a + x.w, 0) });
    return out;
  }
  wrap(runs: Run[], maxW: number, baseSize: number): Line[] {
    const lines: Line[] = [];
    let line: Line = { items: [], w: 0, size: 0 };
    const push = () => { if (!line.size) line.size = baseSize; lines.push(line); line = { items: [], w: 0, size: 0 }; };
    const add = (word: Word) => {
      let gap = line.items.length && word.space ? this.spaceW(word) : 0;
      if (line.items.length && line.w + gap + word.w > maxW) { push(); gap = 0; }
      line.items.push({ word, gap });
      line.w += gap + word.w;
      for (const p of word.pieces) line.size = Math.max(line.size, p.style.size);
    };
    for (const word of this.words(runs)) {
      if (word.br) { push(); continue; }
      if (word.w > maxW) for (const w of this.split(word, maxW)) add(w);
      else add(word);
    }
    if (line.items.length || !lines.length) push();
    return lines;
  }
  /** Width of the longest unbreakable word and of the whole text on one line. */
  measure(runs: Run[]) {
    let min = 0, total = 0;
    for (const w of this.words(runs)) { min = Math.max(min, w.w); total += w.w + (w.space ? this.spaceW(w) : 0); }
    return { min, total };
  }
}

// ---------- page flow ----------
interface Opts { size: number; lineHeight: number }

class Flow {
  page!: PDFPage;
  y = 0;
  bars: number[] = [];
  pendingMarker?: (baseline: number, lineSize: number) => void;
  constructor(public doc: PDFDocument, public ts: Typesetter, public pw: number, public ph: number, public m: { t: number; r: number; b: number; l: number }, public o: Opts) { this.newPage(); }
  get top() { return this.m.t; }
  get bottom() { return this.ph - this.m.b; }
  atTop() { return this.y <= this.m.t + 0.01; }
  newPage() { this.page = this.doc.addPage([this.pw, this.ph]); this.y = this.m.t; }
  ensure(h: number) { if (this.y + h > this.bottom + 0.01 && !this.atTop()) this.newPage(); }
  Y(y: number) { return this.ph - y; }
  /** Move down by h, drawing blockquote bars alongside. */
  advance(h: number) {
    for (const x of this.bars) this.page.drawRectangle({ x, y: this.Y(this.y + h), width: 2.5, height: h, color: color(QUOTE_BAR) });
    this.y += h;
  }
  gap(h: number) {
    if (this.atTop()) return;
    if (this.y + h > this.bottom) { this.newPage(); return; }
    this.advance(h);
  }
  rect(x: number, y: number, w: number, h: number, fill?: string, stroke?: string, width = 0.6) {
    this.page.drawRectangle({ x, y: this.Y(y + h), width: w, height: h, color: fill ? color(fill) : undefined, borderColor: stroke ? color(stroke) : undefined, borderWidth: stroke ? width : 0 });
  }
  hline(x1: number, x2: number, y: number, c: string, t = 0.6) {
    this.page.drawLine({ start: { x: x1, y: this.Y(y) }, end: { x: x2, y: this.Y(y) }, thickness: t, color: color(c) });
  }
  link(url: string, x: number, y: number, w: number, h: number) {
    if (!/^(https?:|mailto:)/i.test(url)) return;
    const ctx = this.doc.context;
    const annot = ctx.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [x, this.Y(y + h), x + w, this.Y(y)], Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    });
    this.page.node.addAnnot(ctx.register(annot));
  }
  /** Draw one laid-out line with its baseline at `base` (top-down). */
  drawLine(line: Line, x: number, maxW: number, base: number, align: 'left' | 'center' | 'right' | null = 'left', defaultColor = INK) {
    let cx = x + (align === 'center' ? (maxW - line.w) / 2 : align === 'right' ? maxW - line.w : 0);
    // Merge neighbouring pieces with the same look into one text run (fewer operators, natural spacing and copy/paste).
    type Seg = { text: string; style: Style; font: PDFFont; size: number; x: number; w: number };
    const segs: Seg[] = [];
    const same = (a: Seg, p: Piece) => a.font === p.font && a.size === p.size && a.style.color === p.style.color && a.style.link === p.style.link && !!a.style.strike === !!p.style.strike && !!a.style.code === !!p.style.code;
    for (const { word, gap } of line.items) {
      cx += gap;
      word.pieces.forEach((p, i) => {
        const last = segs.at(-1);
        const sep = i === 0 && gap ? ' ' : '';
        if (last && same(last, p) && (!sep || Math.abs(gap - p.font.widthOfTextAtSize(' ', p.size)) < 0.01) && Math.abs(last.x + last.w + (sep ? gap : 0) - cx) < 0.01) {
          last.text += sep + p.text; last.w = cx + p.w - last.x;
        } else segs.push({ text: p.text, style: p.style, font: p.font, size: p.size, x: cx, w: p.w });
        cx += p.w;
      });
    }
    for (const s of segs) {
      if (s.style.code) this.rect(s.x - 1, base - s.size * 0.85, s.w + 2, s.size * 1.15, CODE_BG);
      this.page.drawText(s.text, { x: s.x, y: this.Y(base), size: s.size, font: s.font, color: color(s.style.color ?? defaultColor) });
      if (s.style.link) { this.hline(s.x, s.x + s.w, base + 1.2, s.style.color ?? LINK, 0.5); this.link(s.style.link, s.x, base - s.size * 0.85, s.w, s.size * 1.1); }
      if (s.style.strike) this.hline(s.x, s.x + s.w, base - s.size * 0.3, s.style.color ?? defaultColor, 0.6);
    }
  }
  /** Flow a paragraph of runs. */
  paragraph(runs: Run[], x: number, w: number, size = this.o.size, align: 'left' | 'center' | 'right' = 'left', lh = this.o.lineHeight, defaultColor = INK) {
    for (const line of this.ts.wrap(runs, w, size)) {
      const h = line.size * lh;
      this.ensure(h);
      const base = this.y + (h - line.size) / 2 + line.size * 0.8;
      this.advance(h);
      if (this.pendingMarker) { this.pendingMarker(base, line.size); this.pendingMarker = undefined; }
      this.drawLine(line, x, w, base, align, defaultColor);
    }
  }
}

// ---------- blocks ----------
const HEAD_SCALE = [2.0, 1.6, 1.3, 1.15, 1.0, 0.9];
const BULLETS = ['•', '–', '·'];

class Renderer {
  inline: Inline;
  title?: string;
  constructor(public flow: Flow, chars: CharFilter, private ctx: ToolContext, private baseDir?: string) { this.inline = new Inline(chars); }
  get o() { return this.flow.o; }

  async blocks(tokens: Token[], x: number, w: number, depth = 0, tight = false) {
    for (const t of tokens) await this.block(t, x, w, depth, tight);
  }

  async block(t: Token, x: number, w: number, depth: number, tight: boolean) {
    const f = this.flow, S = this.o.size;
    switch (t.type) {
      case 'space': case 'def': case 'checkbox': return;
      case 'heading': {
        const h = t as Tokens.Heading;
        const size = S * (HEAD_SCALE[h.depth - 1] ?? 1);
        if (!this.title && h.depth <= 2) this.title = h.text.replace(/[*_`~]/g, '');
        f.gap(size * (h.depth <= 2 ? 0.9 : 0.7));
        f.ensure(size * 1.3 + S * this.o.lineHeight * 2); // keep the heading with what follows
        f.paragraph(this.inline.runs(h.tokens, { size, bold: true }), x, w, size, 'left', 1.25, h.depth >= 5 ? MUTED : INK);
        if (h.depth <= 2) { f.advance(3); f.hline(x, x + w, f.y, RULE, h.depth === 1 ? 1 : 0.6); f.advance(2); }
        f.gap(size * 0.35);
        return;
      }
      case 'paragraph': {
        const p = t as Tokens.Paragraph;
        if (PAGEBREAK.test(p.text)) { if (!f.atTop()) f.newPage(); return; }
        const only = (p.tokens ?? []).filter((x) => !(x.type === 'text' && !(x as Tokens.Text).text.trim()));
        if (only.length === 1 && only[0].type === 'image' && (await this.image(only[0] as Tokens.Image, x, w))) return;
        f.paragraph(this.inline.runs(p.tokens, { size: S }), x, w);
        f.gap(tight ? S * 0.15 : S * 0.6);
        return;
      }
      case 'text': {
        const tt = t as Tokens.Text;
        f.paragraph(this.inline.runs(tt.tokens ?? [{ type: 'text', raw: tt.text, text: tt.text } as Tokens.Text], { size: S }), x, w);
        if (!tight) f.gap(S * 0.6);
        return;
      }
      case 'list': return this.list(t as Tokens.List, x, w, depth);
      case 'blockquote': {
        const q = t as Tokens.Blockquote;
        f.gap(S * 0.2);
        f.bars.push(x + 2);
        await this.blocks(q.tokens, x + 14, w - 14, depth, false);
        f.bars.pop();
        f.gap(S * 0.4);
        return;
      }
      case 'code': return this.code(t as Tokens.Code, x, w);
      case 'hr': f.gap(S * 0.4); f.ensure(S); f.hline(x, x + w, f.y + S * 0.5, RULE, 0.8); f.advance(S); f.gap(S * 0.4); return;
      case 'table': return this.table(t as Tokens.Table, x, w);
      case 'html': {
        const h = (t as Tokens.HTML).text;
        if (PAGEBREAK.test(h)) { if (!f.atTop()) f.newPage(); return; }
        const text = decodeEntities(h.replace(/<br\s*\/?>/gi, '\n').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')).trim();
        if (text) { f.paragraph([{ text: this.inline.chars.clean(text), style: { size: S } }], x, w); f.gap(S * 0.6); }
        return;
      }
      default: {
        const any = t as { tokens?: Token[]; text?: string };
        if (any.tokens) await this.blocks(any.tokens, x, w, depth, tight);
        else if (any.text) f.paragraph(this.inline.runs([{ type: 'text', raw: any.text, text: any.text } as Tokens.Text], { size: S }), x, w);
      }
    }
  }

  async list(l: Tokens.List, x: number, w: number, depth: number) {
    const f = this.flow, S = this.o.size;
    const start = typeof l.start === 'number' ? l.start : 1;
    const maxNum = l.ordered ? `${start + l.items.length - 1}.` : '';
    const indent = Math.max(S * 1.4, l.ordered ? this.flow.ts.f.regular.widthOfTextAtSize(maxNum, S) + S * 0.6 : 0);
    for (const [i, item] of l.items.entries()) {
      const mx = x;
      if (item.task) {
        f.pendingMarker = (base, size) => {
          const b = size * 0.72, top = base - b;
          f.rect(mx + 1, top, b, b, undefined, MUTED, 0.7);
          if (item.checked) {
            f.page.drawLine({ start: { x: mx + 1 + b * 0.2, y: f.Y(top + b * 0.55) }, end: { x: mx + 1 + b * 0.42, y: f.Y(top + b * 0.8) }, thickness: 1.1, color: color(INK) });
            f.page.drawLine({ start: { x: mx + 1 + b * 0.42, y: f.Y(top + b * 0.8) }, end: { x: mx + 1 + b * 0.85, y: f.Y(top + b * 0.18) }, thickness: 1.1, color: color(INK) });
          }
        };
      } else {
        const marker = l.ordered ? `${start + i}.` : BULLETS[depth % BULLETS.length];
        f.pendingMarker = (base) => {
          const font = this.flow.ts.f.regular, mw = font.widthOfTextAtSize(marker, S);
          const mxx = l.ordered ? mx + indent - S * 0.45 - mw : mx + S * 0.2;
          f.page.drawText(marker, { x: mxx, y: f.Y(base), size: S, font, color: color(l.ordered ? INK : MUTED) });
        };
      }
      await this.blocks(item.tokens, x + indent, w - indent, depth + 1, !l.loose);
      if (f.pendingMarker) { f.pendingMarker = undefined; } // empty item
      if (l.loose) f.gap(S * 0.2);
    }
    f.gap(depth ? S * 0.1 : S * 0.6);
  }

  async code(c: Tokens.Code, x: number, w: number) {
    const f = this.flow, size = this.o.size * 0.85, lh = size * 1.4, pad = 7;
    const font = f.ts.f.mono, cw = font.widthOfTextAtSize('M', size);
    const perLine = Math.max(8, Math.floor((w - 2 * pad) / cw));
    const src = this.inline.chars.clean(c.text.replace(/\r\n?/g, '\n'));
    const lines: string[] = [];
    for (const l of src.split('\n')) {
      const chars = Array.from(l);
      if (!chars.length) lines.push('');
      for (let i = 0; i < chars.length; i += perLine) lines.push(chars.slice(i, i + perLine).join(''));
    }
    f.gap(this.o.size * 0.2);
    f.ensure(pad + lh * Math.min(3, lines.length) + pad);
    f.rect(x, f.y, w, pad, CODE_BG); f.advance(pad);
    for (const l of lines) {
      if (f.y + lh > f.bottom) { f.newPage(); }
      f.rect(x, f.y, w, lh, CODE_BG);
      const base = f.y + (lh - size) / 2 + size * 0.8;
      if (l) f.page.drawText(l, { x: x + pad, y: f.Y(base), size, font, color: color(INK) });
      f.advance(lh);
    }
    if (f.y + pad > f.bottom) f.newPage();
    f.rect(x, f.y, w, pad, CODE_BG); f.advance(pad);
    f.gap(this.o.size * 0.7);
  }

  async table(t: Tokens.Table, x: number, w: number) {
    const f = this.flow, S = this.o.size * 0.92, padX = 5, padY = 3.5, lh = 1.3;
    const cols = t.header.length;
    const rows = [t.header, ...t.rows].map((r, ri) => Array.from({ length: cols }, (_, c) => this.inline.runs(r[c]?.tokens ?? [], { size: S, bold: ri === 0 })));
    // Column widths: natural widths, squeezed proportionally (never below the longest word, when possible).
    const nat = Array(cols).fill(0), min = Array(cols).fill(0);
    for (const r of rows) r.forEach((runs, c) => { const m = f.ts.measure(runs); nat[c] = Math.max(nat[c], m.total + 2 * padX); min[c] = Math.max(min[c], Math.min(m.min, w / cols) + 2 * padX); });
    const sumNat = nat.reduce((a, b) => a + b, 0);
    let widths: number[];
    if (sumNat <= w) widths = nat.map((n) => n + ((w - sumNat) * n) / sumNat);
    else {
      const sumMin = min.reduce((a, b) => a + b, 0);
      if (sumMin >= w) widths = min.map((m) => (m * w) / sumMin);
      else { const spare = w - sumMin, extra = nat.map((n, c) => n - min[c]), se = extra.reduce((a, b) => a + b, 0) || 1; widths = min.map((m, c) => m + (spare * extra[c]) / se); }
    }
    const layout = rows.map((r) => r.map((runs, c) => f.ts.wrap(runs, Math.max(4, widths[c] - 2 * padX), S)));
    const heights = layout.map((r) => Math.max(...r.map((lines) => lines.reduce((a, l) => a + l.size * lh, 0))) + 2 * padY);
    const drawRow = (ri: number) => {
      const h = heights[ri], y0 = f.y;
      let cx = x;
      for (let c = 0; c < cols; c++) {
        const fill = ri === 0 ? HEAD_BG : ri % 2 === 0 ? ZEBRA : undefined;
        f.rect(cx, y0, widths[c], h, fill, RULE, 0.6);
        let ly = y0 + padY;
        for (const line of layout[ri][c]) {
          const lhh = line.size * lh, base = ly + (lhh - line.size) / 2 + line.size * 0.8;
          f.drawLine(line, cx + padX, widths[c] - 2 * padX, base, t.align[c] ?? 'left');
          ly += lhh;
        }
        cx += widths[c];
      }
      f.advance(h);
    };
    f.gap(this.o.size * 0.2);
    f.ensure(heights[0] + (heights[1] ?? 0));
    drawRow(0);
    for (let ri = 1; ri < rows.length; ri++) {
      if (f.y + heights[ri] > f.bottom && !f.atTop()) { f.newPage(); drawRow(0); }
      drawRow(ri);
    }
    f.gap(this.o.size * 0.8);
  }

  /** A paragraph that is only a local image: draw it scaled to fit. Remote images are never fetched. */
  async image(im: Tokens.Image, x: number, w: number): Promise<boolean> {
    const href = decodeURI(im.href || '');
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^data:image\//i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return false;
    const src = /^data:/i.test(href) || isAbsolute(href) || !this.baseDir ? href : join(this.baseDir, href);
    let img;
    try { img = await embedImage(this.flow.doc, src, this.ctx, `image "${im.text || href}"`, 2000); } catch { return false; }
    if (!img) return false;
    const f = this.flow;
    const maxH = (f.bottom - f.top) * 0.8;
    const k = Math.min(1, w / img.width, maxH / img.height, 0.75 /* 96 dpi px -> pt */);
    const iw = img.width * k, ih = img.height * k;
    f.ensure(ih);
    f.page.drawImage(img, { x: x + (w - iw) / 2, y: f.Y(f.y + ih), width: iw, height: ih });
    f.advance(ih);
    if (im.text) { f.gap(3); f.paragraph([{ text: this.inline.chars.clean(im.text), style: { size: this.o.size * 0.85, italic: true, color: MUTED } }], x, w, this.o.size * 0.85, 'center'); }
    f.gap(this.o.size * 0.6);
    return true;
  }
}

const MAX_CHARS = 2_000_000;

export default defineTool({
  name: 'ai_markdown_to_pdf',
  title: 'Markdown to PDF',
  description:
    'Turn Markdown (GitHub-flavoured) into a clean, paginated A4/Letter/A5 PDF: headings, paragraphs with word wrap, bold/italic/strikethrough, inline code, ' +
    'links (clickable), bullet / numbered / task lists (nested), tables (wrapped cells, header repeated on new pages), blockquotes, code blocks, horizontal rules, ' +
    'local images (relative to the Markdown file; remote images are never fetched and show as alt text), page breaks (\\pagebreak, \\newpage or <!-- pagebreak -->), ' +
    'page numbers, margins and title metadata. Text uses the built-in PDF fonts: Latin text only (English and Western European). Arabic, CJK and other scripts ' +
    'are not supported yet: such characters are replaced with "?" (or rejected with onUnsupportedChar: "error"); emoji are dropped; arrows and common symbols are transliterated. ' +
    'Give "markdown" inline or "path" to a .md file.',
  inputSchema: z.object({
    markdown: z.string().max(MAX_CHARS).optional().describe('Markdown text. Use this or "path".'),
    path: z.string().optional().describe('A .md file: local path or base64. Relative image links resolve against its folder.'),
    title: z.string().max(300).optional().describe('PDF title metadata. Default: the first # / ## heading.'),
    author: z.string().max(200).optional(),
    paper: z.enum(['A4', 'Letter', 'A5']).optional().default('A4'),
    landscape: z.boolean().optional().default(false),
    margin: z.number().min(5).max(50).optional().default(20).describe('Page margin in mm. Default 20.'),
    fontSize: z.number().min(7).max(16).optional().default(10.5).describe('Body font size in pt. Default 10.5.'),
    font: z.enum(['sans', 'serif']).optional().default('sans').describe('Body font: sans (Helvetica) or serif (Times). Code is always Courier.'),
    pageNumbers: z.boolean().optional().default(true).describe('Print "n / total" at the bottom of each page. Default true.'),
    onUnsupportedChar: z.enum(['replace', 'error']).optional().default('replace').describe('What to do with characters the PDF fonts can\'t show: replace with "?" (default) or fail.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfOutputShape,
    title: z.string(),
    unsupportedChars: z.array(z.string()).optional().describe('Characters that could not be shown (replaced with "?" or dropped).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { markdown: '# Report\n\nHello **world**.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |', paper: 'A4' }, output: { pages: 1, title: 'Report' } },
    { input: { path: 'notes.md', paper: 'Letter', margin: 15 }, note: 'Converts a Markdown file; images next to it are embedded.' },
  ],
  async run(input, ctx) {
    let md: string, baseDir: string | undefined, srcName = 'document';
    if (input.markdown != null) md = input.markdown;
    else if (input.path) {
      const f = await readInput(input.path, ctx, 'path');
      md = f.bytes.toString('utf8').replace(/^﻿/, '');
      if (f.path) { baseDir = dirname(f.path); srcName = f.name.replace(/\.[^.]*$/, ''); }
    } else throw new ToolError('Give either "markdown" or "path".');
    if (md.length > MAX_CHARS) throw new ToolError(`The Markdown is longer than ${MAX_CHARS.toLocaleString('en')} characters.`);
    const { marked } = await import('marked');
    const tokens = marked.lexer(md.replace(/\r\n?/g, '\n'), { gfm: true });

    const chars = new CharFilter(input.onUnsupportedChar);
    const { doc } = await newDoc('Document', ctx);
    const serif = input.font === 'serif';
    const [regular, bold, italic, boldItalic, mono, monoBold] = await Promise.all([
      doc.embedFont(serif ? StandardFonts.TimesRoman : StandardFonts.Helvetica),
      doc.embedFont(serif ? StandardFonts.TimesRomanBold : StandardFonts.HelveticaBold),
      doc.embedFont(serif ? StandardFonts.TimesRomanItalic : StandardFonts.HelveticaOblique),
      doc.embedFont(serif ? StandardFonts.TimesRomanBoldItalic : StandardFonts.HelveticaBoldOblique),
      doc.embedFont(StandardFonts.Courier),
      doc.embedFont(StandardFonts.CourierBold),
    ]);
    const ts = new Typesetter({ regular, bold, italic, boldItalic, mono, monoBold });
    let [pw, ph] = PAPER[input.paper].map((v) => v * MM);
    if (input.landscape) [pw, ph] = [ph, pw];
    const m = input.margin * MM;
    const flow = new Flow(doc, ts, pw, ph, { t: m, r: m, b: m, l: m }, { size: input.fontSize, lineHeight: 1.45 });
    const r = new Renderer(flow, chars, ctx, baseDir);
    await r.blocks(tokens, m, pw - 2 * m);

    // Drop a trailing empty page (e.g. a page break at the very end).
    if (doc.getPageCount() > 1 && flow.atTop()) doc.removePage(doc.getPageCount() - 1);
    const n = doc.getPageCount();
    if (input.pageNumbers) {
      doc.getPages().forEach((p, i) => {
        const s = `${i + 1} / ${n}`, size = 8.5, tw = regular.widthOfTextAtSize(s, size);
        p.drawText(s, { x: (pw - tw) / 2, y: Math.max(12, m / 2 - size / 2), size, font: regular, color: color('#8a929e') });
      });
    }
    const title = chars.clean(input.title ?? r.title ?? (srcName !== 'document' ? srcName : 'Document'));
    doc.setTitle(title, { showInWindowTitleBar: true });
    doc.setSubject('Converted from Markdown');
    if (input.author) doc.setAuthor(chars.clean(input.author));
    doc.catalog.set(PDFName.of('Lang'), PDFString.of('en'));
    const out = await savePdf(doc, { output: input.output, defaultName: `${title.slice(0, 80) || 'document'}.pdf`, base64: input.returnBase64 }, ctx);
    return { ...out, title, ...(chars.unsupported.size ? { unsupportedChars: [...chars.unsupported].slice(0, 50) } : {}) };
  },
});

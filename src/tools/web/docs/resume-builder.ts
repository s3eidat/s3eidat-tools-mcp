import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, returnBase64 } from '../../../util/files.js';
import { Draw, mixHex, newDoc, pdfOutputShape, savePdf, userText, wrap, type Fonts } from './_pdf.js';
import type { PDFDocument, PDFFont } from 'pdf-lib';

// Port of https://github.com/s3eidat/resume-builder (app.js): same sections, order, bullet parsing, skills splitting and
// the three print templates (classic, modern sidebar, compact) on A4. English section headings (the site's Arabic RTL
// mode needs an Arabic font, not available here yet).
const SECTIONS = { summary: 'Summary', experience: 'Experience', education: 'Education', skills: 'Skills', projects: 'Projects', languages: 'Languages' } as const;
type Key = keyof typeof SECTIONS;
const KEYS = Object.keys(SECTIONS) as Key[];

export function cleanOrder(o: unknown): Key[] {
  const seen: Record<string, number> = {};
  const out = (Array.isArray(o) ? o : []).filter((k) => { const ok = KEYS.indexOf(k) >= 0 && !seen[k]; seen[k] = 1; return ok; }) as Key[];
  KEYS.forEach((k) => { if (!seen[k]) out.push(k); });
  return out;
}
/** "- did X\n• did Y\nplain" → [{bullet:true,text}, …] */
export function parseLines(t: string) {
  return String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^([-•*–])\s*(.*)$/.exec(l);
    return m ? { bullet: true, text: m[2] } : { bullet: false, text: l };
  });
}
export function tags(t: string) { return String(t || '').split(/[,،\n]/).map((s) => s.trim()).filter(Boolean); }
export function span(a: string, b: string) { return a && b ? a + ' – ' + b : a || b; }

interface Entry { [k: string]: string }
interface Cv {
  template: 'classic' | 'modern' | 'compact'; accent: string; order: Key[];
  contact: { name: string; title: string; email: string; phone: string; location: string; website: string };
  summary: string; skills: string; experience: Entry[]; education: Entry[]; projects: Entry[]; languages: Entry[];
}
const filled = (e: Entry) => Object.keys(e).some((f) => e[f].trim());

// ---------- layout ----------
const A4: [number, number] = [595.28, 841.89];
class Flow {
  g: Draw; y: number; pageNo = 0;
  constructor(public doc: PDFDocument, public fonts: Fonts, public x: number, public w: number, public top: number, public bottom: number,
    public pages: Draw[], public onNewPage: (g: Draw) => void, startPage = 0) {
    this.pageNo = startPage;
    this.g = this.page(startPage);
    this.y = top;
  }
  page(i: number) {
    while (this.pages.length <= i) {
      const g = new Draw(this.doc.addPage(A4), this.fonts);
      this.pages.push(g);
      this.onNewPage(g);
    }
    return this.pages[i];
  }
  ensure(h: number) {
    if (this.y + h <= A4[1] - this.bottom || this.y <= this.top + 1) return;
    this.pageNo++;
    this.g = this.page(this.pageNo);
    this.y = this.top;
  }
}

function drawResume(doc: PDFDocument, fonts: Fonts, cv: Cv) {
  const t = cv.template, compact = t === 'compact', modern = t === 'modern';
  const em = compact ? 8.9 : 9.5, [W] = A4, ink = cv.accent;
  const c = cv.contact, bits = [c.email, c.phone, c.location, c.website].filter(Boolean);
  const pages: Draw[] = [];
  const sideW = W * 0.31;
  const onNewPage = (g: Draw) => { if (modern) g.rect(0, 0, sideW, A4[1], { fill: ink }); };
  const lh = em * 1.45;
  const mw = (g: Draw, s: string, size: number, f: PDFFont) => g.width(s, size, f);

  // main column geometry
  const main = modern
    ? new Flow(doc, fonts, sideW + 3.4 * em, W - sideW - 6.8 * em, 4.4 * em, 3 * em, pages, onNewPage)
    : compact ? new Flow(doc, fonts, 4 * em, W - 8 * em, 3.6 * em, 3.6 * em, pages, onNewPage)
      : new Flow(doc, fonts, 4.4 * em, W - 8.8 * em, 4.4 * em, 4.4 * em, pages, onNewPage);
  const side = modern ? new Flow(doc, fonts, 2 * em, sideW - 4 * em, 4.4 * em, 3 * em, pages, onNewPage) : null;

  // text block helper: wraps and flows
  const para = (f: Flow, text: string, o: { size?: number; font?: PDFFont; color?: string; x?: number; w?: number; lineH?: number; align?: 'left' | 'center' }) => {
    const size = o.size ?? em, font = o.font ?? fonts.sans, x = o.x ?? f.x, w = o.w ?? f.w, L = o.lineH ?? size * 1.45;
    for (const l of wrap((s) => mw(f.g, s, size, font), text, w)) {
      f.ensure(L);
      f.g.text(l, o.align === 'center' ? x + w / 2 : x, f.y + L / 2 + size * 0.35, { size, font, color: o.color ?? '#23272e', align: o.align ?? 'left' });
      f.y += L;
    }
  };

  // ---- header
  const name = c.name || 'Your Name';
  const nameSize = (compact ? 2.2 : 2.5) * em;
  if (t === 'classic') {
    para(main, name, { size: nameSize, font: fonts.bold, color: '#111111', lineH: nameSize * 1.1, align: 'center' });
    if (c.title) { main.y += 0.2 * em; para(main, c.title, { size: 1.2 * em, font: fonts.bold, color: ink, align: 'center' }); }
    if (bits.length) { main.y += 0.7 * em; para(main, bits.join('     '), { color: '#5a626e', align: 'center' }); }
    main.y += 1.2 * em;
    main.g.rect(main.x, main.y, main.w, 0.2 * em, { fill: ink });
    main.y += 0.2 * em + 1.6 * em;
  } else if (compact) {
    const y0 = main.y, x = main.x + 1.45 * em, w = main.w - 1.45 * em;
    para(main, name, { size: nameSize, font: fonts.bold, color: '#111111', lineH: nameSize * 1.1, x, w });
    if (c.title) { main.y += 0.2 * em; para(main, c.title, { size: 1.2 * em, font: fonts.bold, color: ink, x, w }); }
    if (bits.length) { main.y += 0.7 * em; para(main, bits.join('     '), { color: '#5a626e', x, w }); }
    main.g.rect(main.x, y0, 0.45 * em, main.y - y0, { fill: ink });
    main.y += 1 * em;
  } else {
    para(main, name, { size: nameSize, font: fonts.bold, color: '#111111', lineH: nameSize * 1.1 });
    if (c.title) { main.y += 0.2 * em; para(main, c.title, { size: 1.2 * em, font: fonts.bold, color: ink }); }
    main.y += 1.6 * em;
  }

  // ---- sections
  const heading = (f: Flow, k: string, onSide: boolean) => {
    const size = 0.86 * em;
    if (compact) return;
    f.ensure(size * 1.45 + 0.35 * em + 2 * lh);
    f.g.text(k.toUpperCase(), f.x, f.y + size, { size, font: fonts.bold, color: onSide ? '#ffffff' : ink });
    f.y += size * 1.3 + 0.35 * em;
    f.g.rect(f.x, f.y, f.w, 0.12 * em, { fill: onSide ? mixHex(ink, '#ffffff', 0.35) : mixHex(ink, '#ffffff', 0.7) });
    f.y += 0.12 * em + 0.7 * em;
  };
  const chips = (f: Flow, items: string[], x: number, w: number) => {
    const size = em, ph = 0.75 * em, pv = 0.2 * em, h = size * 1.45 + 2 * pv, gap = 0.45 * em;
    let cx = x;
    f.ensure(h);
    for (const it of items) {
      const tw = Math.min(mw(f.g, it, size, fonts.sans), w - 2 * ph), cw = tw + 2 * ph;
      if (cx > x && cx + cw > x + w) { cx = x; f.y += h + gap; f.ensure(h); }
      f.g.roundRect(cx, f.y, cw, h, h / 2, { fill: mixHex(ink, '#ffffff', 0.89) });
      f.g.text(it, cx + ph, f.y + h / 2 + size * 0.35, { size, color: '#23272e', maxW: w - 2 * ph });
      cx += cw + gap;
    }
    f.y += h;
  };
  const list = (f: Flow, items: { t: string; lvl?: string }[], onSide: boolean, x: number, w: number) => {
    items.forEach((it, i) => {
      if (i) f.y += 0.4 * em;
      const full = it.lvl ? it.t + ' · ' + it.lvl : it.t;
      for (const l of wrap((s) => mw(f.g, s, em, fonts.sans), full, w)) {
        f.ensure(lh);
        const by = f.y + lh / 2 + em * 0.35;
        const k = it.lvl ? l.lastIndexOf(' · ' + it.lvl) : -1;
        if (k >= 0) {
          const a = l.slice(0, k);
          const aw = f.g.text(a, x, by, { size: em, color: onSide ? '#ffffff' : '#23272e' });
          f.g.text(' · ' + it.lvl, x + aw, by, { size: em, color: onSide ? mixHex('#ffffff', ink, 0.3) : '#7a828e' });
        } else f.g.text(l, x, by, { size: em, color: onSide ? '#ffffff' : '#23272e' });
        f.y += lh;
      }
    });
  };
  const desc = (f: Flow, text: string, x: number, w: number) => {
    let prevBullet: boolean | null = null;
    for (const l of parseLines(text)) {
      f.y += l.bullet ? (prevBullet ? 0.15 * em : 0.3 * em) : 0.25 * em;
      if (l.bullet) {
        const bx = x + 1.2 * em;
        let first = true;
        for (const s of wrap((q) => mw(f.g, q, em, fonts.sans), l.text, w - 1.2 * em)) {
          f.ensure(lh);
          if (first) f.g.path(`M${x + 0.45 * em} ${f.y + lh / 2}a${0.17 * em} ${0.17 * em} 0 1 0 ${0.34 * em} 0a${0.17 * em} ${0.17 * em} 0 1 0 ${-0.34 * em} 0z`, { fill: ink });
          f.g.text(s, bx, f.y + lh / 2 + em * 0.35, { size: em, color: '#23272e' });
          f.y += lh; first = false;
        }
      } else para(f, l.text, { x, w });
      prevBullet = l.bullet;
    }
  };
  const section = (k: Key, f: Flow, onSide: boolean) => {
    const items = (k === 'experience' || k === 'education' || k === 'projects' || k === 'languages') ? cv[k].filter(filled) : [];
    if (k === 'summary' && !cv.summary.trim()) return;
    if (k === 'skills' && !tags(cv.skills).length) return;
    if (k !== 'summary' && k !== 'skills' && !items.length) return;
    f.y += compact ? 1.1 * em : 1.5 * em;
    let x = f.x, w = f.w;
    if (compact) { // heading column 9em + content
      f.ensure(2 * lh);
      f.g.text(SECTIONS[k].toUpperCase(), f.x, f.y + lh / 2 + 0.86 * em * 0.35, { size: 0.86 * em, font: fonts.bold, color: ink, maxW: 9 * em });
      x = f.x + 10.2 * em; w = f.w - 10.2 * em;
    } else heading(f, SECTIONS[k], onSide);
    if (k === 'summary') { desc(f, cv.summary, x, w); return; }
    if (k === 'skills') {
      const ts = tags(cv.skills);
      if (onSide) list(f, ts.map((s) => ({ t: s })), true, x, w); else chips(f, ts, x, w);
      return;
    }
    if (k === 'languages') {
      if (onSide) list(f, items.map((e) => ({ t: e.name, lvl: e.level })), true, x, w);
      else chips(f, items.map((e) => (e.level ? e.name + ' · ' + e.level : e.name)), x, w);
      return;
    }
    items.forEach((e, i) => {
      if (i) f.y += compact ? 0.7 * em : 1 * em;
      const title = k === 'experience' ? e.role : k === 'education' ? e.degree : e.name;
      const sub = (k === 'experience' ? [e.org, e.place] : k === 'education' ? [e.school, e.place] : [e.link]).filter(Boolean);
      const when = k === 'projects' ? '' : span(e.start, e.end);
      const tsz = 1.08 * em, ww = when ? mw(f.g, when, em, fonts.sans) + em : 0;
      const tl = wrap((s) => mw(f.g, s, tsz, fonts.bold), title || '', w - ww);
      f.ensure(tl.length * tsz * 1.45 + (sub.length ? lh : 0) + lh);
      tl.forEach((l, li) => {
        const by = f.y + tsz * 1.45 / 2 + tsz * 0.35;
        f.g.text(l, x, by, { size: tsz, font: fonts.bold, color: '#111111' });
        if (li === 0 && when) f.g.text(when, x + w, by, { size: em, color: '#7a828e', align: 'right' });
        f.y += tsz * 1.45;
      });
      if (sub.length) para(f, sub.join(' · '), { x, w, color: '#5a626e', font: fonts.bold, size: em });
      if (e.desc) desc(f, e.desc, x, w);
    });
  };

  if (side && bits.length) {
    heading(side, 'Contact', true);
    list(side, bits.map((b) => ({ t: b })), true, side.x, side.w);
  }
  for (const k of cv.order) {
    const toSide = modern && (k === 'skills' || k === 'languages');
    section(k, toSide && side ? side : main, toSide);
  }
  return pages.length;
}

const entry = <T extends Record<string, z.ZodTypeAny>>(shape: T) => z.object(shape);
const s = (d: string, max = 160) => z.string().max(max).optional().default('').describe(d);

export default defineTool({
  name: 'doc_resume',
  title: 'Resume / CV PDF',
  webSlug: 'resume-builder',
  description:
    'Turn structured CV fields into a clean A4 resume PDF: contact header, summary, experience, education, skills, projects ' +
    'and languages, in any section order, with three templates like the website: "classic" (centred header and accent ' +
    'rule), "modern" (coloured sidebar with contact, skills and languages) and "compact" (denser, headings in a left ' +
    'column). Description lines starting with "-", "•", "*" or "–" become bullet points; skills are comma-separated. ' +
    'Aims for one page; longer CVs continue on a second page. English headings, Latin text only for now. ' +
    `Web version: ${webUrl('resume-builder')}`,
  inputSchema: z.object({
    template: z.enum(['classic', 'modern', 'compact']).optional().default('classic'),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#0e7c86').describe('Accent colour (hex).'),
    order: z.array(z.enum(['summary', 'experience', 'education', 'skills', 'projects', 'languages'])).optional()
      .describe('Section order; missing sections are appended in the default order.'),
    contact: z.object({
      name: s('Full name.', 100), title: s('Headline / job title.', 120), email: s('Email.', 120), phone: s('Phone.', 60),
      location: s('City, country.', 100), website: s('Website or LinkedIn.', 160),
    }).optional().default({ name: '', title: '', email: '', phone: '', location: '', website: '' }),
    summary: z.string().max(2000).optional().default('').describe('Two or three lines about you.'),
    experience: z.array(entry({ role: s('Job title'), org: s('Company'), place: s('Location'), start: s('Start, e.g. 2021'), end: s('End, e.g. Present'), desc: s('Highlights, one per line ("- " for bullets)', 3000) })).max(40).optional().default([]),
    education: z.array(entry({ degree: s('Degree'), school: s('School'), place: s('Location'), start: s('Start'), end: s('End'), desc: s('Details', 3000) })).max(40).optional().default([]),
    skills: z.union([z.string().max(2000), z.array(z.string())]).optional().default('').describe('Skills: comma-separated text or a list.'),
    projects: z.array(entry({ name: s('Project'), link: s('Link'), desc: s('What it is / what you did', 3000) })).max(40).optional().default([]),
    languages: z.array(entry({ name: s('Language'), level: s('Level, e.g. Native, B2') })).max(40).optional().default([]),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({ ...pdfOutputShape }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: {
      template: 'modern', contact: { name: 'Layla Haddad', title: 'Senior Product Designer', email: 'layla@example.com', location: 'Amman, Jordan' },
      summary: 'Product designer with 8 years of experience.',
      experience: [{ role: 'Senior Product Designer', org: 'Mosaic Health', start: '2022', end: 'Present', desc: '- Redesigned patient booking; completion up 31%\n- Built a design system' }],
      skills: 'Figma, Prototyping, User research', languages: [{ name: 'Arabic', level: 'Native' }, { name: 'English', level: 'Fluent' }],
    },
  }],
  async run(input, ctx) {
    const chk = (e: Entry, k: string, i: number) => Object.fromEntries(Object.entries(e).map(([f, v]) => [f, userText(String(v), `${k}[${i}].${f}`)]));
    const cv: Cv = {
      template: input.template, accent: input.accent.toLowerCase(), order: cleanOrder(input.order),
      contact: Object.fromEntries(Object.entries(input.contact).map(([k, v]) => [k, userText(v, `contact.${k}`)])) as Cv['contact'],
      summary: userText(input.summary, 'summary'),
      skills: userText(Array.isArray(input.skills) ? input.skills.join(', ') : input.skills, 'skills'),
      experience: input.experience.map((e, i) => chk(e, 'experience', i)), education: input.education.map((e, i) => chk(e, 'education', i)),
      projects: input.projects.map((e, i) => chk(e, 'projects', i)), languages: input.languages.map((e, i) => chk(e, 'languages', i)),
    };
    if (!cv.contact.name && !cv.summary && !cv.experience.some(filled) && !cv.education.some(filled)) {
      throw new ToolError('Give at least a contact name and some content (summary, experience or education).');
    }
    const { doc, fonts } = await newDoc(cv.contact.name ? `${cv.contact.name} - Resume` : 'Resume', ctx);
    if (cv.contact.name) doc.setAuthor(cv.contact.name);
    drawResume(doc, fonts, cv);
    const base = (cv.contact.name || 'resume').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'resume';
    const out = await savePdf(doc, { output: input.output, defaultName: `${base}.pdf`, base64: input.returnBase64 }, ctx);
    return { ...out, mimeType: 'application/pdf' };
  },
});

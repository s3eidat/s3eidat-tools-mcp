import { z } from 'zod';
import {
  PDFBool, PDFCheckBox, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFSignature, PDFString, PDFTextField, StandardFonts,
  type PDFDocument, type PDFField, type PDFPage,
} from 'pdf-lib';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { baseName, fileInput, openPdf, outputPath, pdfFileOutput, returnBase64, savePdf } from './_common.js';

// Ported from https://github.com/s3eidat/pdf-fill (app.js): same field analysis (kinds, labels, visual order) and the
// same fill rules (only changed fields get new appearances; Arabic etc. falls back to NeedAppearances; flatten).
type Kind = 'text' | 'check' | 'radio' | 'dropdown' | 'list' | 'signature' | 'button';
type Value = string | boolean | string[] | null;

function kindOf(f: PDFField): Kind {
  if (f instanceof PDFTextField) return 'text';
  if (f instanceof PDFCheckBox) return 'check';
  if (f instanceof PDFRadioGroup) return 'radio';
  if (f instanceof PDFDropdown) return 'dropdown';
  if (f instanceof PDFOptionList) return 'list';
  if (f instanceof PDFSignature) return 'signature';
  return 'button';
}
const safe = <T>(fn: () => T, d: T): T => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };

/** "applicant.dateOfBirth" -> "Date of birth" */
export function humanize(name: string) {
  const last = String(name).split('.').pop()!.replace(/\[\d+\]$/, '');
  const words = last.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean).map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()));
  return words.join(' ').replace(/^./, (c) => c.toUpperCase()) || name;
}

function readValue(f: PDFField, kind: Kind): Value {
  if (kind === 'text') return safe(() => (f as PDFTextField).getText(), '') || '';
  if (kind === 'check') return safe(() => (f as PDFCheckBox).isChecked(), false);
  if (kind === 'radio') return safe(() => (f as PDFRadioGroup).getSelected(), '') || '';
  if (kind === 'dropdown' || kind === 'list') return safe(() => (f as PDFDropdown).getSelected(), [] as string[]) || [];
  return null;
}

export interface FieldInfo {
  name: string; kind: Kind; page: number; rects: { page: number; x: number; y: number; w: number; h: number; opt: string | null }[];
  options: string[]; orig: Value; label: string; tip: string; fillable: boolean; readOnly: boolean; required: boolean;
  multiline: boolean; maxLen?: number; editable: boolean; multi: boolean; sortY: number; sortX: number;
}

export function analyse(doc: PDFDocument): FieldInfo[] {
  const form = doc.getForm(), pages = doc.getPages(), out: FieldInfo[] = [];
  // pdf-lib keeps findWidgetPage() private in its typings; the website calls it directly.
  const widgetPage = (w: unknown) => (form as unknown as { findWidgetPage(w: unknown): PDFPage }).findWidgetPage(w);
  form.getFields().forEach((f) => {
    const kind = kindOf(f), name = f.getName(), ws = safe(() => f.acroField.getWidgets(), []);
    const options = ['radio', 'dropdown', 'list'].includes(kind) ? safe(() => (f as PDFDropdown).getOptions(), [] as string[]) : [];
    const rects = ws.map((w, i) => {
      const pg = safe(() => pages.indexOf(widgetPage(w)), -1), r = safe(() => w.getRectangle(), { x: 0, y: 0, width: 0, height: 0 });
      let opt: string | null = null;
      if (kind === 'radio') opt = options.length === ws.length ? options[i] : safe(() => w.getOnValue()!.decodeText(), null);
      return { page: pg, x: r.x, y: r.y, w: r.width, h: r.height, opt };
    });
    const onPages = rects.filter((r) => r.page >= 0), page = onPages.length ? Math.min(...onPages.map((r) => r.page)) : -1, first = onPages.find((r) => r.page === page) || rects[0];
    const tu = safe(() => (f.acroField.dict.lookup(PDFName.of('TU')) as PDFString).decodeText(), '');
    out.push({
      name, kind, page, rects, options, orig: readValue(f, kind), label: tu || humanize(name), tip: tu ? name : '',
      fillable: !['button', 'signature'].includes(kind) && !safe(() => f.isReadOnly(), false),
      readOnly: safe(() => f.isReadOnly(), false), required: safe(() => f.isRequired(), false),
      multiline: kind === 'text' && safe(() => (f as PDFTextField).isMultiline(), false),
      maxLen: kind === 'text' ? safe(() => (f as PDFTextField).getMaxLength(), undefined) : undefined,
      editable: kind === 'dropdown' && safe(() => (f as PDFDropdown).isEditable(), false),
      multi: (kind === 'dropdown' || kind === 'list') && safe(() => (f as PDFDropdown).isMultiselect(), false),
      sortY: first ? -(first.y + first.h) : 0, sortX: first ? first.x : 0,
    });
  });
  out.sort((a, b) => (a.page < 0 ? 1e9 : a.page) - (b.page < 0 ? 1e9 : b.page) || Math.round(a.sortY / 4) - Math.round(b.sortY / 4) || a.sortX - b.sortX);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** vals: Map(name -> value). Only changed fields get new appearances, so untouched ones keep the file's own look. */
export async function fill(doc: PDFDocument, fields: FieldInfo[], vals: Map<string, Value>, opts: { flatten?: boolean } = {}) {
  const form = doc.getForm(), font = await doc.embedFont(StandardFonts.Helvetica), noAp: string[] = [];
  if (safe(() => form.hasXFA(), false)) form.deleteXFA();
  for (const fd of fields) {
    if (!fd.fillable) continue;
    const v = vals.has(fd.name) ? vals.get(fd.name)! : fd.orig, changed = !same(v, fd.orig);
    let f: PDFField;
    try { f = form.getField(fd.name); } catch { continue; }
    const noAppearance = () => safe(() => f.acroField.getWidgets().some((w) => { const ap = w.getAppearances(); return !ap || !ap.normal; }), false);
    if (!changed && !(opts.flatten && noAppearance())) continue;
    if (changed) {
      if (fd.kind === 'text') (f as PDFTextField).setText(v ? String(v) : undefined);
      else if (fd.kind === 'check') { if (v) (f as PDFCheckBox).check(); else (f as PDFCheckBox).uncheck(); }
      else if (fd.kind === 'radio') { if (v) (f as PDFRadioGroup).select(String(v)); else (f as PDFRadioGroup).clear(); }
      else if (fd.kind === 'dropdown') { const a = v as string[]; if (!a.length) (f as PDFDropdown).clear(); else (f as PDFDropdown).select(fd.multi ? a : a[0]); }
      else if (fd.kind === 'list') { const a = v as string[]; if (!a.length) (f as PDFOptionList).clear(); else (f as PDFOptionList).select(a); }
    }
    try {
      if (['text', 'dropdown', 'list'].includes(fd.kind)) (f as PDFTextField).updateAppearances(font);
      else (f as PDFCheckBox).updateAppearances();
    } catch { noAp.push(fd.label); }
  }
  if (noAp.length && opts.flatten) {
    throw new ToolError(`Can't flatten: ${noAp.join(', ')}${noAp.length > 1 ? ' contain' : ' contains'} characters the standard PDF font can't draw (Arabic, for example). Fill without flatten to keep the form fillable; most viewers will then show the text.`);
  }
  if (noAp.length) form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  if (opts.flatten) form.flatten({ updateFieldAppearances: false });
  return { bytes: await doc.save({ updateFieldAppearances: false }), noAp };
}

/** Turn a caller's value into the shape the field kind needs, with clear errors. */
export function coerce(fd: FieldInfo, raw: unknown): Value {
  const opts = fd.options;
  if (fd.kind === 'text') {
    if (raw == null) return '';
    const s = Array.isArray(raw) ? raw.join(', ') : String(raw);
    if (fd.maxLen != null && s.length > fd.maxLen) throw new ToolError(`"${fd.name}" takes at most ${fd.maxLen} characters.`);
    return s;
  }
  if (fd.kind === 'check') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw ?? '').trim().toLowerCase();
    if (['true', 'yes', 'on', '1', 'x', 'checked', 'ticked'].includes(s)) return true;
    if (['false', 'no', 'off', '0', '', 'unchecked'].includes(s)) return false;
    throw new ToolError(`"${fd.name}" is a checkbox: give true or false.`);
  }
  const pick = (s: string) => {
    const hit = opts.find((o) => o === s) ?? opts.find((o) => o.toLowerCase() === s.toLowerCase());
    if (hit != null) return hit;
    if (fd.editable) return s;
    throw new ToolError(`"${s}" is not an option of "${fd.name}". Options: ${opts.map((o) => JSON.stringify(o)).join(', ')}.`);
  };
  if (fd.kind === 'radio') {
    const s = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
    return s ? pick(s) : '';
  }
  const list = (Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]).map((x) => pick(String(x)));
  if (list.length > 1 && !fd.multi) throw new ToolError(`"${fd.name}" allows only one choice.`);
  return list;
}

const fieldOut = z.object({
  name: z.string().describe('Full field name: use it as the key in pdf_form_fill.'),
  label: z.string().describe('Tooltip, or a readable label made from the name.'),
  type: z.enum(['text', 'checkbox', 'radio', 'dropdown', 'list', 'signature', 'button']),
  page: z.number().nullable().describe('1-based page of its first widget.'),
  value: z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]).describe('Current value.'),
  options: z.array(z.string()).optional(),
  fillable: z.boolean(), required: z.boolean(), readOnly: z.boolean(),
  multiline: z.boolean().optional(), maxLength: z.number().optional(), multiselect: z.boolean().optional(), editable: z.boolean().optional(),
});
const TYPE: Record<Kind, z.infer<typeof fieldOut>['type']> = { text: 'text', check: 'checkbox', radio: 'radio', dropdown: 'dropdown', list: 'list', signature: 'signature', button: 'button' };

function describeField(d: FieldInfo): z.infer<typeof fieldOut> {
  return {
    name: d.name, label: d.label, type: TYPE[d.kind], page: d.page < 0 ? null : d.page + 1, value: d.orig,
    ...(d.options.length || ['radio', 'dropdown', 'list'].includes(d.kind) ? { options: d.options.length ? d.options : [...new Set(d.rects.map((r) => r.opt).filter((o): o is string => !!o))] } : {}),
    fillable: d.fillable, required: d.required, readOnly: d.readOnly,
    ...(d.kind === 'text' ? { multiline: d.multiline, ...(d.maxLen != null ? { maxLength: d.maxLen } : {}) } : {}),
    ...(d.kind === 'dropdown' || d.kind === 'list' ? { multiselect: d.multi } : {}),
    ...(d.kind === 'dropdown' ? { editable: d.editable } : {}),
  };
}

const fieldsTool = defineTool({
  name: 'pdf_form_fields',
  title: 'List PDF form fields',
  webSlug: 'pdf-fill',
  description:
    'List the fillable fields of a PDF form in reading order: name, readable label, type (text, checkbox, radio, dropdown, ' +
    'list, signature, button), page, current value, options, and whether it is required / read-only / multi-line. Use the ' +
    `names with pdf_form_fill. Web version: ${webUrl('pdf-fill')}`,
  inputSchema: z.object({ file: fileInput('PDF') }),
  outputSchema: z.object({ count: z.number(), xfa: z.boolean().describe('The form also has an XFA (LiveCycle) layer; filling removes it.'), fields: z.array(fieldOut) }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'application.pdf' } }],
  async run(input, ctx) {
    const { doc } = await openPdf(input.file, ctx);
    const fields = analyse(doc);
    return { count: fields.length, xfa: safe(() => doc.getForm().hasXFA(), false), fields: fields.map(describeField) };
  },
});

const fillTool = defineTool({
  name: 'pdf_form_fill',
  title: 'Fill a PDF form',
  webSlug: 'pdf-fill',
  description:
    'Fill PDF form fields by name (get names from pdf_form_fields): text as strings, checkboxes as true/false, radio groups ' +
    'and dropdowns by option text, lists as arrays. Optionally flatten (bake the answers into the page, no longer editable). ' +
    'Only changed fields are redrawn. Text the standard font cannot draw (Arabic…) is kept and viewers are asked to draw it, ' +
    `but cannot be flattened. Web version: ${webUrl('pdf-fill')}`,
  inputSchema: z.object({
    file: fileInput('PDF'),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])).describe('Field name -> value, e.g. {"name": "Sara", "agree": true, "plan": "pro", "langs": ["Arabic"]}.'),
    flatten: z.boolean().optional().default(false).describe('Flatten the form after filling (fields become plain page content).'),
    ignoreUnknown: z.boolean().optional().default(false).describe('Skip names that are not in the form instead of failing.'),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    ...pdfFileOutput,
    filled: z.array(z.string()).describe('Fields whose value was set.'),
    unknown: z.array(z.string()).describe('Names not found in the form (only with ignoreUnknown).'),
    needAppearances: z.array(z.string()).describe('Fields whose text the standard font cannot draw; the viewer draws them.'),
    flattened: z.boolean(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'application.pdf', values: { name: 'Sara Haddad', agree: true, plan: 'pro', country: 'Egypt' }, flatten: true } }],
  async run(input, ctx) {
    const { input: f, doc } = await openPdf(input.file, ctx);
    const fields = analyse(doc);
    if (!fields.length) throw new ToolError('This PDF has no form fields. To write on it, use pdf_sign_image text marks.');
    const by = new Map(fields.map((d) => [d.name, d])), vals = new Map<string, Value>(), unknown: string[] = [];
    for (const [name, raw] of Object.entries(input.values)) {
      const d = by.get(name);
      if (!d) { unknown.push(name); continue; }
      if (!d.fillable) throw new ToolError(`"${name}" can't be filled (${d.readOnly ? 'read-only' : d.kind}).`);
      vals.set(name, coerce(d, raw));
    }
    if (unknown.length && !input.ignoreUnknown) {
      throw new ToolError(`No field named ${unknown.map((u) => JSON.stringify(u)).join(', ')}. Fields: ${fields.filter((d) => d.fillable).map((d) => JSON.stringify(d.name)).join(', ')}.`);
    }
    const r = await fill(doc, fields, vals, { flatten: input.flatten });
    const w = await savePdf(r.bytes, { output: input.output, defaultName: baseName(f) + (input.flatten ? '-filled-flat.pdf' : '-filled.pdf'), returnBase64: input.returnBase64 }, ctx);
    return { ...w, filled: [...vals.keys()], unknown, needAppearances: r.noAp, flattened: input.flatten };
  },
});

export default [fieldsTool, fillTool];

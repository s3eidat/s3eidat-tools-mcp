import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFBool, PDFDocument, PDFName } from 'pdf-lib';
import fillTools, { humanize } from '../../../src/tools/web/pdf/pdf-fill.js';
import { closeJs } from '../../../src/tools/web/pdf/_common.js';
import { loadPdfJs } from '../../../src/util/pdf.js';
import { call, tempCtx } from '../../helpers.js';
import { b64, load } from './_pdf.js';

const [fieldsTool, fillTool] = fillTools;

async function formPdf() {
  const d = await PDFDocument.create(), form = d.getForm(), p1 = d.addPage([600, 800]), p2 = d.addPage([600, 800]);
  form.createTextField('name').addToPage(p1, { x: 50, y: 700, width: 220, height: 22 });
  const notes = form.createTextField('notes'); notes.enableMultiline(); notes.addToPage(p1, { x: 50, y: 600, width: 300, height: 60 });
  form.createCheckBox('agree').addToPage(p1, { x: 50, y: 560, width: 14, height: 14 });
  const r = form.createRadioGroup('plan'); r.addOptionToPage('basic', p1, { x: 50, y: 520, width: 14, height: 14 }); r.addOptionToPage('pro', p1, { x: 90, y: 520, width: 14, height: 14 });
  const dd = form.createDropdown('country'); dd.addOptions(['Jordan', 'Egypt', 'UAE']); dd.addToPage(p2, { x: 50, y: 700, width: 150, height: 22 });
  const ol = form.createOptionList('langs'); ol.addOptions(['Arabic', 'English', 'French']); ol.enableMultiselect(); ol.addToPage(p2, { x: 50, y: 600, width: 150, height: 60 });
  form.createButton('go').addToPage('Go', p2, { x: 300, y: 600, width: 60, height: 22 });
  return b64(await d.save());
}
type F = { name: string; type: string; page: number; options?: string[]; fillable: boolean; multiline?: boolean; multiselect?: boolean };
const vals = { name: 'Sara Haddad', notes: 'Line one\nLine two', agree: true, plan: 'pro', country: ['Egypt'], langs: ['Arabic', 'English'] };

describe('pdf_form_fields / pdf_form_fill (pdf-fill self-test)', () => {
  it('lists fields with kinds, pages, options and visual order', async () => {
    const r = await call<{ count: number; fields: F[] }>(fieldsTool, { file: await formPdf() }, tempCtx());
    const by = (n: string) => r.fields.find((x) => x.name === n)!;
    expect(r.count).toBe(7);
    expect(r.fields.map((f) => f.type)).toEqual(['text', 'text', 'checkbox', 'radio', 'dropdown', 'list', 'button']);
    expect(by('notes').multiline && by('langs').multiselect && !by('go').fillable).toBe(true);
    expect([by('name').page, by('plan').page, by('country').page, by('langs').page]).toEqual([1, 1, 2, 2]);
    expect(by('plan').options).toEqual(['basic', 'pro']);
    expect(by('country').options).toEqual(['Jordan', 'Egypt', 'UAE']);
    expect(r.fields.slice(0, 4).map((x) => x.name)).toEqual(['name', 'notes', 'agree', 'plan']);
    const plain = await PDFDocument.create(); plain.addPage();
    expect((await call<{ count: number }>(fieldsTool, { file: b64(await plain.save()) }, tempCtx())).count).toBe(0);
    expect([humanize('applicant.dateOfBirth'), humanize('passportID'), humanize('first_name')]).toEqual(['Date of birth', 'Passport ID', 'First name']);
  });
  it('fills, keeps fillable, or flattens', async () => {
    const ctx = tempCtx(), file = await formPdf();
    const r1 = await call<{ path: string }>(fillTool, { file, values: vals }, ctx);
    const f1 = (await load(r1.path)).getForm();
    expect(f1.getTextField('name').getText()).toBe('Sara Haddad');
    expect(f1.getTextField('notes').getText()).toBe('Line one\nLine two');
    expect(f1.getCheckBox('agree').isChecked()).toBe(true);
    expect(f1.getRadioGroup('plan').getSelected()).toBe('pro');
    expect(f1.getDropdown('country').getSelected()).toEqual(['Egypt']);
    expect(f1.getOptionList('langs').getSelected()).toEqual(['Arabic', 'English']);
    expect(f1.getFields()).toHaveLength(7);
    const r2 = await call<{ path: string }>(fillTool, { file, values: { ...vals, country: 'egypt', agree: 'yes' }, flatten: true }, ctx);
    const d2 = await load(r2.path);
    expect(d2.getForm().getFields()).toHaveLength(0);
    expect(d2.getPageCount()).toBe(2);
    const js = await loadPdfJs(readFileSync(r2.path));
    const text = async (n: number) => ((await (await js.getPage(n)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(' ');
    expect(await text(1)).toContain('Sara Haddad');
    expect(await text(2)).toContain('Egypt');
    await closeJs(js);
  });
  it('keeps Arabic values for the viewer to draw, and explains why it cannot flatten them', async () => {
    const ctx = tempCtx(), file = await formPdf(), ar = { ...vals, name: 'سارة حداد' };
    const r3 = await call<{ path: string; needAppearances: string[] }>(fillTool, { file, values: ar }, ctx);
    const d3 = await load(r3.path);
    expect(d3.getForm().getTextField('name').getText()).toBe(ar.name);
    expect(r3.needAppearances).toHaveLength(1);
    expect(d3.getForm().acroForm.dict.get(PDFName.of('NeedAppearances'))).toBe(PDFBool.True);
    await expect(call(fillTool, { file, values: ar, flatten: true }, ctx)).rejects.toThrow(/Can't flatten/);
    await expect(call(fillTool, { file, values: { nope: 'x' } }, ctx)).rejects.toThrow(/No field named "nope"/);
    await expect(call(fillTool, { file, values: { plan: 'gold' } }, ctx)).rejects.toThrow(/not an option/);
  });
});

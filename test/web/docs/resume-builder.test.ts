import { describe, expect, it } from 'vitest';
import resume, { cleanOrder, parseLines, span, tags } from '../../../src/tools/web/docs/resume-builder.js';
import { call, tempCtx } from '../../helpers.js';
import { pagePixels, pdfInfo } from './_helpers.js';

const ctx = tempCtx();
type Out = { path: string; pages: number };

const CV = {
  contact: { name: 'Layla Haddad', title: 'Senior Product Designer', email: 'layla@example.com', phone: '+962 7 9000 0000', location: 'Amman, Jordan' },
  summary: 'Product designer with 8 years of experience.',
  experience: [{ role: 'Senior Product Designer', org: 'Mosaic Health', place: 'Amman', start: '2022', end: 'Present', desc: '- Redesigned patient booking\n• Built a design system\nplain line' }],
  education: [{ degree: 'BSc Computer Science', school: 'University of Jordan', start: '2013', end: '2017' }],
  skills: 'Figma, Prototyping, User research',
  projects: [{ name: 'Open Wayfinding', link: 'example.com/wayfinding', desc: 'Signage kit.' }],
  languages: [{ name: 'Arabic', level: 'Native' }, { name: 'English', level: 'C2' }],
};

// Known answers from resume-builder's S3_SELFTEST.
describe('resume logic (resume-builder self-test)', () => {
  it('section order, bullets, tags and date spans', () => {
    expect(cleanOrder(['skills', 'summary']).join()).toBe('skills,summary,experience,education,projects,languages');
    const bad = cleanOrder(['evil', 'skills', 'skills']);
    expect([bad.length, bad[0]]).toEqual([6, 'skills']);
    const p = parseLines('- one\n• two\n\nplain\n* three');
    expect(p).toHaveLength(4);
    expect([p[0].bullet, p[1].text, p[2].bullet, p[3].text]).toEqual([true, 'two', false, 'three']);
    expect(tags('a, b،c\n d ,,').join('|')).toBe('a|b|c|d');
    expect(span('2020', '')).toBe('2020');
    expect(span('2020', 'Now')).toBe('2020 – Now');
  });
});

describe('doc_resume tool', () => {
  it.each(['classic', 'modern', 'compact'])('%s template: one page with every section', async (template) => {
    const r = await call<Out>(resume, { ...CV, template }, ctx);
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBe(1);
    expect(info.title).toBe('Layla Haddad - Resume');
    for (const t of ['Layla Haddad', 'Senior Product Designer', 'SUMMARY', 'EXPERIENCE', 'Mosaic Health · Amman', '2022 – Present', 'Redesigned patient booking',
      'plain line', 'EDUCATION', 'University of Jordan', 'SKILLS', 'Prototyping', 'PROJECTS', 'Open Wayfinding', 'LANGUAGES', 'Arabic', 'Native', 'layla@example.com']) {
      expect(info.text).toContain(t);
    }
  });
  it('modern sidebar uses the accent colour; section order is respected', async () => {
    const r = await call<Out>(resume, { ...CV, template: 'modern', accent: '#e2604a', order: ['education', 'experience'] }, ctx);
    expect((await pagePixels(r.path)).at(20, 400)).toBe('#e2604a');
    const text = (await pdfInfo(r.path)).text;
    expect(text.indexOf('EDUCATION')).toBeLessThan(text.indexOf('EXPERIENCE'));
  });
  it('long CVs continue on more pages; Latin text only', async () => {
    const experience = Array.from({ length: 14 }, (_, i) => ({ role: `Role ${i + 1}`, org: 'Org', start: '2000', end: '2001', desc: '- one thing\n- another thing\n- a third thing' }));
    const r = await call<Out>(resume, { ...CV, experience }, ctx);
    expect(r.pages).toBeGreaterThan(1);
    const info = await pdfInfo(r.path);
    expect(info.pages[0]).not.toContain('Role 14');
    expect(info.text).toContain('Role 14');
    expect(info.pages[info.pageCount - 1]).toContain('LANGUAGES');
    await expect(call(resume, { contact: { name: 'سارة' } }, ctx)).rejects.toThrow(/contact\.name.*Only Latin text/);
  });
});

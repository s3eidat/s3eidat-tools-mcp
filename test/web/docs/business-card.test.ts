import { describe, expect, it } from 'vitest';
import cards, { px, sheetLayout, vcard, vesc } from '../../../src/tools/web/docs/business-card.js';
import { makeQR } from '../../../src/tools/web/qr/_qrcode.js';
import qrRead from '../../../src/tools/web/qr/qr-scanner.js';
import { call, tempCtx } from '../../helpers.js';
import { pagePixels, pdfInfo } from './_helpers.js';

const ctx = tempCtx();
type Out = { path: string; pages: number; cardsPerSheet: number; vcard: string; qrVersion: number | null };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// Known answers from business-card's S3_SELFTEST.
describe('business card logic (business-card self-test)', () => {
  it('300 DPI sizes and sheet grids', () => {
    expect([px(85), px(55), px(88.9), px(50.8)]).toEqual([1004, 650, 1050, 600]);
    const A = sheetLayout('A4', 'eu', 0), U = sheetLayout('Letter', 'us', 0), G = sheetLayout('A4', 'eu', 4);
    expect([A.n, A.cols, A.rows]).toEqual([10, 2, 5]);
    expect(near(A.pos[0].x, 20) && near(A.pos[0].y, 11) && near(A.pos[1].x, 105) && near(A.pos[9].x, 105) && near(A.pos[9].y, 231)).toBe(true);
    expect(A.xs.join()).toBe('20,105,190');
    expect(A.ys).toHaveLength(6);
    expect(U.n).toBe(10);
    expect(near(U.pos[0].x, 19.05) && near(U.pos[0].y, 12.7)).toBe(true);
    expect([G.n, G.rows]).toEqual([8, 4]);
  });
  it('vCard and QR', () => {
    expect(vesc('Smith, Jr; Co\\x\nY')).toBe('Smith\\, Jr\\; Co\\\\x\\nY');
    const v = vcard({ name: 'Lina Al Haddad', company: 'Acme, Inc.', title: 'R&D; Lead', phone: '+962 79', email: 'a@b.co', website: 'b.co', address: 'Street 1, Amman' });
    expect(v).toBe(['BEGIN:VCARD', 'VERSION:3.0', 'N:Haddad;Lina Al;;;', 'FN:Lina Al Haddad', 'ORG:Acme\\, Inc.', 'TITLE:R&D\\; Lead',
      'TEL;TYPE=CELL:+962 79', 'EMAIL;TYPE=INTERNET:a@b.co', 'URL:b.co', 'ADR;TYPE=WORK:;;Street 1\\, Amman;;;;', 'END:VCARD'].join('\r\n'));
    const q = makeQR(v, 'M'), n = q.moduleCount;
    expect((n - 17) % 4 === 0 && n >= 41 && q.isDark(0, 0) && q.isDark(6, 6) && !q.isDark(1, 1) && q.isDark(2, 2) && q.isDark(0, n - 1) && q.isDark(n - 1, 0)).toBe(true);
    expect(makeQR(vcard({ name: 'لينا حداد' }), 'M').moduleCount).toBeGreaterThanOrEqual(21);
  });
});

describe('doc_business_cards tool', () => {
  it('classic front in coral: accent bar on the right edge, white paper, texts', async () => {
    const r = await call<Out>(cards, { name: 'T', company: 'Acme', phone: '+1 555 0100', back: 'none', accent: '#e2604a', paperColor: '#ffffff', ink: '#111111' }, ctx);
    expect([r.pages, r.cardsPerSheet]).toEqual([1, 10]);
    const info = await pdfInfo(r.path);
    expect(info.pages[0].match(/\+1 555 0100/g)).toHaveLength(10);
    const k = 72 / 25.4, p = await pagePixels(r.path, 1, 72);
    expect(p.at(104 * k, 31 * k)).toBe('#e2604a');
    expect(p.at(23 * k, 14 * k)).toBe('#ffffff');
  });
  it('QR back page is mirrored and scans back to the vCard', async () => {
    const r = await call<Out>(cards, { name: 'Lina Haddad', title: 'Optometrist', company: 'Lumen Eye Clinic', email: 'lina@lumen.example', back: 'qr', tagline: 'Clear vision' }, ctx);
    expect(r.pages).toBe(2);
    const info = await pdfInfo(r.path);
    expect(info.pages[0]).toContain('Lina Haddad');
    expect(info.pages[1]).toContain('Scan to save my contact');
    const { default: sharp } = await import('sharp');
    const dpi = 120, k = dpi / 25.4, p = await pagePixels(r.path, 2, dpi);
    const crop = await sharp(p.png).extract({ left: Math.round(105 * k), top: Math.round(11 * k), width: Math.round(85 * k), height: Math.round(55 * k) }).png().toBuffer();
    const read = await call<{ text: string; type: string }>(qrRead, { image: 'base64:' + crop.toString('base64') }, ctx);
    expect(read.text).toBe(r.vcard);
    expect(read.type).toBe('Contact');
  });
  it('needs a name, Latin text only', async () => {
    await expect(call(cards, { name: '  ' }, ctx)).rejects.toThrow(/Add your name/);
    await expect(call(cards, { name: 'لينا حداد' }, ctx)).rejects.toThrow(/Only Latin text/);
  });
});

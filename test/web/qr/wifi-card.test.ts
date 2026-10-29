import { describe, expect, it } from 'vitest';
import wifi from '../../../src/tools/web/qr/wifi-card.js';
import qrRead from '../../../src/tools/web/qr/qr-scanner.js';
import { MM } from '../../../src/tools/web/docs/_pdf.js';
import { call, tempCtx } from '../../helpers.js';
import { pagePixels, pdfInfo } from '../docs/_helpers.js';

const ctx = tempCtx();
type Out = { path: string; payload: string; version: number; modules: number; warnings: string[]; pages?: number };

// Known answers from wifi-card's S3_SELFTEST.
describe('qr_wifi (wifi-card self-test)', () => {
  it('payload escaping and open networks', async () => {
    const r = await call<Out>(wifi, { ssid: 'My;Net"', password: 'p:ss\\w,1', hidden: true, format: 'svg' }, ctx);
    expect(r.payload).toBe('WIFI:T:WPA;S:My\\;Net\\";P:p\\:ss\\\\w\\,1;H:true;;');
    const o = await call<Out>(wifi, { ssid: 'Guest', password: 'ignored', security: 'nopass', format: 'png' }, ctx);
    expect(o.payload).toBe('WIFI:T:nopass;S:Guest;;');
    expect((await call<Out>(wifi, { ssid: 'Home', password: '1234', format: 'svg' }, ctx)).warnings).toEqual(['WPA passwords are at least 8 characters']);
  });

  it('A6 card: coral header band, version 3 code, texts, and the QR reads back', async () => {
    const r = await call<Out>(wifi, { ssid: 'Home', password: '12345678', layout: 'a6', theme: 'coral' }, ctx);
    expect([r.version, r.modules]).toEqual([3, 29]);
    const info = await pdfInfo(r.path);
    expect(info.pageCount).toBe(1);
    expect(info.sizes[0]).toEqual([Math.round(105 * MM * 10) / 10, Math.round(148 * MM * 10) / 10]);
    for (const t of ['Wi-Fi', 'Scan to join', 'Network', 'Home', 'Password', '12345678', 'Point your phone camera at the code']) expect(info.text).toContain(t);
    const px = await pagePixels(r.path, 1, 150);
    expect(px.at(10, 10)).toBe('#e2604a'); // header band is the theme colour
    const read = await call<{ text: string; type: string }>(qrRead, { image: 'base64:' + px.png.toString('base64') }, ctx);
    expect(read.text).toBe('WIFI:T:WPA;S:Home;P:12345678;;');
  });

  it('A4 sheet of 9, open network, Latin-only check', async () => {
    const r = await call<Out>(wifi, { ssid: 'Guest', security: 'nopass', layout: 'a4x9', theme: 'saver' }, ctx);
    const info = await pdfInfo(r.path);
    expect(info.pages[0].match(/Scan to join/g)).toHaveLength(9);
    expect(info.text).toContain('Open network, no password');
    await expect(call(wifi, { ssid: 'مقهى', password: '12345678' }, ctx)).rejects.toThrow(/only Latin text/i);
    // The QR alone can hold any text:
    expect((await call<Out>(wifi, { ssid: 'مقهى', password: '12345678', format: 'png' }, ctx)).payload).toBe('WIFI:T:WPA;S:مقهى;P:12345678;;');
  });
});

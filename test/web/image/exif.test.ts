import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { call, tempCtx } from '../../helpers.js';
import tools from '../../../src/tools/web/image/exif-cleaner.js';
import { app1, buildExif, cleanJpeg, cleanName, cleanPng, concat, inspect, jpegSegments, parseTiff, pngChunks } from '../../../src/tools/web/image/_exif.js';
import { b64, meta } from './fixtures.js';

const [exifRead, exifStrip] = tools;
const ctx = tempCtx();
const enc = new TextEncoder();

// ---------- the website's sample photos, built in memory ----------
const SAMPLE_EXIF = (le: boolean, ori?: number) =>
  buildExif(
    {
      ifd0: [[0x010f, 2, 'Google'], [0x0110, 2, 'Pixel 9'], [0x0131, 2, 'HDR+ 1.0'], [0x0112, 3, ori || 6], [0x0132, 2, '2026:10:21 18:42:05']],
      exif: [[0x9003, 2, '2026:10:21 18:42:05'], [0x829d, 5, [[18, 10]]], [0x829a, 5, [[1, 250]]], [0x8827, 3, 64], [0x920a, 5, [[69, 10]]], [0xa431, 2, 'PX9-48213377']],
      gps: [[1, 2, 'N'], [2, 5, [[31, 1], [57, 1], [1404, 100]]], [3, 2, 'E'], [4, 5, [[35, 1], [54, 1], [3816, 100]]], [5, 1 + 2, 0], [6, 5, [[812, 1]]]],
    },
    le,
  );
const seg = (marker: number, payload: Uint8Array) => {
  const s = new Uint8Array(4 + payload.length);
  s[0] = 0xff;
  s[1] = marker;
  s[2] = (payload.length + 2) >> 8;
  s[3] = (payload.length + 2) & 0xff;
  s.set(payload, 4);
  return s;
};
const scene = (w: number, h: number) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#f4845f"/><rect x="${w / 4}" y="${h / 2}" width="${w / 8}" height="${h / 2}" fill="#2d1e2f"/></svg>`));
async function sampleJpeg(le: boolean, ori?: number) {
  const base = new Uint8Array(await scene(640, 420).jpeg({ quality: 85 }).toBuffer());
  return concat([base.subarray(0, 2), app1(SAMPLE_EXIF(le, ori)), seg(0xfe, enc.encode('Holiday at the lake')), seg(0xed, enc.encode('Photoshop 3.0\0 8BIM fake IPTC block')), base.subarray(2)]);
}
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type: string, data: Uint8Array) {
  const c = new Uint8Array(12 + data.length);
  const v = new DataView(c.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
  c.set(data, 8);
  v.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
  return c;
}
const insertPngChunk = (png: Uint8Array, chunk: Uint8Array) => concat([png.subarray(0, 33), chunk, png.subarray(33)]);
async function samplePng() {
  const base = new Uint8Array(await scene(400, 300).png().toBuffer());
  let p = insertPngChunk(base, pngChunk('tEXt', enc.encode('Author\0Jane Doe')));
  p = insertPngChunk(p, pngChunk('eXIf', SAMPLE_EXIF(false).subarray(6)));
  return p;
}
const has = (b: Uint8Array, m: number) => jpegSegments(b).segs.some((s) => s.m === m);
const B = (u: Uint8Array) => 'base64:' + Buffer.from(u).toString('base64');

describe('exif-cleaner self-test (parsers)', () => {
  it('parses little-endian EXIF + GPS, comment and APP13', async () => {
    const j = await sampleJpeg(true);
    const mm = inspect(j).meta;
    const f = (k: string) => mm.fields.find((x) => x.label === k)?.value;
    expect([f('Camera make'), f('Camera model'), f('Date taken'), f('Aperture'), f('Exposure'), f('ISO'), f('Camera serial number'), f('Comment')]).toEqual([
      'Google', 'Pixel 9', '2026:10:21 18:42:05', 'f/1.8', '1/250 s', '64', 'PX9-48213377', 'Holiday at the lake',
    ]);
    expect(mm.orientation).toBe(6);
    expect(mm.gps!.lat).toBeCloseTo(31.9539, 4);
    expect(mm.gps!.lon).toBeCloseTo(35.9106, 4);
    expect(mm.gps!.alt).toBe(812);
  });
  it('strips everything losslessly; keeps an orientation-only APP1; drops trailing data', async () => {
    const j = await sampleJpeg(true);
    const c0 = cleanJpeg(j, { keepIcc: true, keepOri: false });
    const sosA = jpegSegments(j).segs.find((s) => s.m === 0xda)!;
    const sosB = jpegSegments(c0).segs.find((s) => s.m === 0xda)!;
    expect(Buffer.from(j.subarray(sosA.start)).equals(Buffer.from(c0.subarray(sosB.start)))).toBe(true);
    expect(has(c0, 0xe1) || has(c0, 0xed) || has(c0, 0xfe)).toBe(false);
    expect(c0.length).toBeLessThan(j.length);
    expect((await sharp(c0).metadata()).width).toBe(640);
    const c1 = cleanJpeg(j, { keepIcc: true, keepOri: true });
    const ap = jpegSegments(c1).segs.filter((s) => s.m === 0xe1);
    const r1 = parseTiff(c1.subarray(ap[0].start + 10, ap[0].end));
    expect(ap.length).toBe(1);
    expect(ap[0].end - ap[0].start).toBeLessThan(40);
    expect([r1.orientation, r1.gps, r1.fields.length]).toEqual([6, null, 0]);
    expect(cleanJpeg(concat([c0, new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])]), { keepIcc: true, keepOri: false }).length).toBe(c0.length);
  });
  it('PNG: big-endian eXIf + tEXt are read, then removed', async () => {
    const p = await samplePng();
    const pi = inspect(p);
    expect(pi.meta.gps!.lat).toBeCloseTo(31.9539, 4);
    expect(pi.meta.fields).toContainEqual({ label: 'Author', value: 'Jane Doe' });
    const types = pngChunks(cleanPng(p, { keepIcc: true })).chunks.map((c) => c.type);
    expect(types).not.toContain('tEXt');
    expect(types).not.toContain('eXIf');
    expect([types[0], types[types.length - 1]]).toEqual(['IHDR', 'IEND']);
    expect((await sharp(cleanPng(p, { keepIcc: true })).metadata()).width).toBe(400);
  });
  it('rejects garbage and truncated files', () => {
    expect(() => inspect(new Uint8Array([1, 2, 3, 4]))).toThrow();
    expect(() => jpegSegments(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]))).toThrow();
    expect(cleanName('IMG_1.jpg')).toBe('IMG_1-clean.jpg');
  });
});

describe('image_exif_read / image_exif_strip', () => {
  it('reads and strips a JPEG written by sharp .withExif()', async () => {
    const jpg = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#3366cc' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Make: 'Canon', Model: 'EOS R5', Artist: 'Jane Doe', Software: 'Lightroom' },
        IFD2: { DateTimeOriginal: '2026:05:01 10:20:30', ISOSpeedRatings: '200' },
        IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 52/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 36/1' },
      })
      .toBuffer();
    type Read = { fields: { label: string; value: string; sensitive?: boolean }[]; gps: { lat: number; lon: number; coordinates: string } | null; orientation: number; revealsLocation: boolean; format: string; width: number };
    const r = await call<Read>(exifRead, { image: b64(jpg) }, ctx);
    const f = (k: string) => r.fields.find((x) => x.label === k);
    expect(f('Camera make')?.value).toBe('Canon');
    expect(f('Camera model')?.value).toBe('EOS R5');
    expect(f('Artist')).toMatchObject({ value: 'Jane Doe', sensitive: true });
    expect(f('Date taken')?.value).toBe('2026:05:01 10:20:30');
    expect(f('ISO')?.value).toBe('200');
    expect(r.orientation).toBe(6);
    expect(r.gps!.lat).toBeCloseTo(-33.8667, 4);
    expect(r.gps!.lon).toBeCloseTo(151.21, 4);
    expect(r.gps!.coordinates).toBe('-33.866667, 151.210000');
    expect([r.revealsLocation, r.format, r.width]).toEqual([true, 'jpeg', 64]);

    type Strip = { path: string; bytes: number; inputBytes: number; removed: { name: string }[]; hadLocation: boolean; reencoded: boolean };
    const s = await call<Strip>(exifStrip, { image: b64(jpg) }, ctx);
    expect(s.path.endsWith('photo-clean.jpg')).toBe(true);
    expect([s.hadLocation, s.reencoded]).toEqual([true, false]);
    expect(s.removed.map((x) => x.name)).toContain('EXIF');
    const after = await call<Read>(exifRead, { image: s.path }, ctx);
    expect([after.fields.length, after.gps, after.orientation]).toEqual([0, null, 6]);
    // Bake the rotation into the pixels instead: no EXIF at all, 32×64.
    const a = await call<Strip>(exifStrip, { image: b64(jpg), applyOrientation: true }, ctx);
    const m = await meta(a.path);
    expect([a.reencoded, m.width, m.height, m.exif, m.orientation]).toEqual([true, 32, 64, undefined, undefined]);
  });
  it('WebP metadata is read via sharp and removed by re-encoding', async () => {
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).webp().withExif({ IFD0: { Make: 'Sony' } }).toBuffer();
    const r = await call<{ fields: { label: string; value: string }[]; format: string }>(exifRead, { image: b64(webp) }, ctx);
    expect(r.format).toBe('webp');
    expect(r.fields.find((x) => x.label === 'Camera make')?.value).toBe('Sony');
    const s = await call<{ path: string; reencoded: boolean }>(exifStrip, { image: b64(webp) }, ctx);
    expect(s.reencoded).toBe(true);
    expect((await sharp(readFileSync(s.path)).metadata()).exif).toBeUndefined();
  });
  it('the website sample through the tools', async () => {
    const r = await call<{ gps: { coordinates: string }; blocks: { name: string }[] }>(exifRead, { image: B(await sampleJpeg(false)) }, ctx);
    expect(r.gps.coordinates).toBe('31.953900, 35.910600');
    expect(r.blocks.map((b) => b.name)).toEqual(['EXIF', 'Comment', 'IPTC / Photoshop']);
  });
});

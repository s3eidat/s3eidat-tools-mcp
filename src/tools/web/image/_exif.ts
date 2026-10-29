/**
 * Port of https://github.com/s3eidat/exif-cleaner (app.js): its own JPEG / PNG / TIFF-EXIF parsers.
 * Cleaning drops metadata segments and copies the image data byte for byte (no re-encoding).
 */
import { inflateSync } from 'node:zlib';

export interface Field {
  label: string;
  value: string;
  sensitive?: boolean;
}
export interface Gps {
  lat: number;
  lon: number;
  alt?: number;
}
export interface Meta {
  fields: Field[];
  gps: Gps | null;
  orientation: number;
}

const ascii = (b: Uint8Array, s: number, n: number) => {
  let r = '';
  for (let i = s; i < s + n && i < b.length; i++) r += String.fromCharCode(b[i]);
  return r;
};
export const concat = (parts: Uint8Array[]) => {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  parts.forEach((p) => {
    out.set(p, o);
    o += p.length;
  });
  return out;
};

// ---------- TIFF / EXIF ----------
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const IFD0: Record<number, string> = { 0x010f: 'Camera make', 0x0110: 'Camera model', 0x0131: 'Software', 0x0132: 'Date modified', 0x013b: 'Artist', 0x8298: 'Copyright', 0x010e: 'Description', 0x0112: 'Orientation' };
const EXIF: Record<number, string> = { 0x9003: 'Date taken', 0xa434: 'Lens', 0xa431: 'Camera serial number', 0xa430: 'Camera owner', 0x829d: 'Aperture', 0x829a: 'Exposure', 0x8827: 'ISO', 0x920a: 'Focal length', 0xa420: 'Unique image ID' };
const SENSITIVE: Record<string, 1> = { 'Camera serial number': 1, 'Camera owner': 1, Artist: 1, 'Unique image ID': 1, 'Date taken': 1 };

type TagVal = string | number[] | Uint8Array;

/** Parses a TIFF block (starting at "II*\0" / "MM\0*"). Every read is bounds-checked; damaged data is skipped. */
export function parseTiff(b: Uint8Array): Meta {
  if (b.length < 8) throw new Error('EXIF too short');
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) throw new Error('Bad EXIF byte order');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const L = b.length;
  if (v.getUint16(2, le) !== 42) throw new Error('Bad EXIF header');
  function ifd(off: number) {
    const tags: Record<number, TagVal> = {};
    if (off < 8 || off + 2 > L) return tags;
    const n = v.getUint16(off, le);
    for (let i = 0; i < Math.min(n, 400); i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > L) break;
      const tag = v.getUint16(e, le);
      const type = v.getUint16(e + 2, le);
      const count = v.getUint32(e + 4, le);
      const sz = TYPE_SIZE[type];
      if (!sz || count > 1e6) continue;
      const size = sz * count;
      const at = size <= 4 ? e + 8 : v.getUint32(e + 8, le);
      if (at + size > L) continue;
      let val: TagVal;
      if (type === 2) val = ascii(b, at, count).replace(/\0[\s\S]*$/, '').trim();
      else if (type === 3) val = Array.from({ length: Math.min(count, 64) }, (_, k) => v.getUint16(at + 2 * k, le));
      else if (type === 4 || type === 9) val = Array.from({ length: Math.min(count, 64) }, (_, k) => (type === 4 ? v.getUint32(at + 4 * k, le) : v.getInt32(at + 4 * k, le)));
      else if (type === 5 || type === 10)
        val = Array.from({ length: Math.min(count, 64) }, (_, k) => {
          const n1 = type === 5 ? v.getUint32(at + 8 * k, le) : v.getInt32(at + 8 * k, le);
          const d = type === 5 ? v.getUint32(at + 8 * k + 4, le) : v.getInt32(at + 8 * k + 4, le);
          return d ? n1 / d : 0;
        });
      else val = b.subarray(at, at + Math.min(size, 256));
      tags[tag] = val;
    }
    return tags;
  }
  const t0 = ifd(v.getUint32(4, le));
  const ex = t0[0x8769] ? ifd((t0[0x8769] as number[])[0]) : {};
  const gp = t0[0x8825] ? ifd((t0[0x8825] as number[])[0]) : {};
  const fields: Field[] = [];
  const one = (x: TagVal) => (Array.isArray(x) ? x[0] : x);
  const fmt = (tag: number, val: TagVal): string | null => {
    const x = one(val) as number;
    if (tag === 0x829d) return 'f/' + (+x).toFixed(1);
    if (tag === 0x829a) return x >= 1 ? x + ' s' : '1/' + Math.round(1 / x) + ' s';
    if (tag === 0x920a) return (+x).toFixed(1).replace(/\.0$/, '') + ' mm';
    return typeof val === 'string' ? val : val instanceof Uint8Array ? null : String(x);
  };
  ([[IFD0, t0], [EXIF, ex]] as const).forEach((pair) =>
    Object.keys(pair[0]).forEach((k) => {
      const tag = +k;
      const val = pair[1][tag];
      if (val == null || tag === 0x0112) return;
      const s = fmt(tag, val);
      if (s) fields.push({ label: pair[0][tag], value: s.slice(0, 300), sensitive: !!SENSITIVE[pair[0][tag]] });
    }),
  );
  let gps: Gps | null = null;
  const dms = (a: TagVal | undefined) => (Array.isArray(a) && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null);
  const lat = dms(gp[2]);
  const lon = dms(gp[4]);
  if (lat != null && lon != null && (lat || lon)) {
    gps = { lat: /S/i.test((gp[1] as string) || '') ? -lat : lat, lon: /W/i.test((gp[3] as string) || '') ? -lon : lon };
    if (gp[6]) gps.alt = (gp[5] && (gp[5] as number[] | Uint8Array)[0] === 1 ? -1 : 1) * (one(gp[6]) as number);
  }
  if (Object.keys(gp).length && !gps) fields.push({ label: 'GPS data', value: 'present (no coordinates)', sensitive: true });
  return { fields, gps, orientation: t0[0x0112] ? (one(t0[0x0112]) as number) : 1 };
}

export type ExifEntry = [number, number, string | number | number[] | [number, number][]];

/** Writes a TIFF/EXIF payload ("Exif\0\0" + TIFF). entries: {ifd0:[[tag,type,value]], exif:[], gps:[]}. */
export function buildExif(entries: { ifd0?: ExifEntry[]; exif?: ExifEntry[]; gps?: ExifEntry[] }, le: boolean) {
  const groups: Record<string, ExifEntry[]> = { ifd0: (entries.ifd0 || []).slice(), exif: (entries.exif || []).slice(), gps: (entries.gps || []).slice() };
  if (groups.exif.length) groups.ifd0.push([0x8769, 4, 0]);
  if (groups.gps.length) groups.ifd0.push([0x8825, 4, 0]);
  const names = ['ifd0', 'exif', 'gps'].filter((k) => k === 'ifd0' || groups[k].length);
  names.forEach((k) => groups[k].sort((a, b) => a[0] - b[0]));
  const arr = (x: ExifEntry[2]) => ([] as unknown[]).concat(x) as number[];
  const bytesOf = (e: ExifEntry) =>
    e[1] === 2 ? (e[2] as string).length + 1 : e[1] === 3 ? 2 * arr(e[2]).length : e[1] === 4 ? 4 * arr(e[2]).length : 8 * (e[2] as unknown[]).length;
  let off = 8;
  const at: Record<string, number> = {};
  names.forEach((k) => {
    at[k] = off;
    off += 2 + groups[k].length * 12 + 4;
  });
  let data = off;
  const total = names.reduce((s, k) => s + groups[k].reduce((t, e) => t + (bytesOf(e) > 4 ? bytesOf(e) + (bytesOf(e) & 1) : 0), 0), off);
  const b = new Uint8Array(6 + total);
  const v = new DataView(b.buffer, 6);
  b.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  b[6] = b[7] = le ? 0x49 : 0x4d;
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  groups.ifd0.forEach((e) => {
    if (e[0] === 0x8769) e[2] = at.exif;
    if (e[0] === 0x8825) e[2] = at.gps;
  });
  names.forEach((k) => {
    const list = groups[k];
    let p = at[k];
    v.setUint16(p, list.length, le);
    p += 2;
    list.forEach((e) => {
      const n = bytesOf(e);
      const dst = n > 4 ? data : p + 8;
      v.setUint16(p, e[0], le);
      v.setUint16(p + 2, e[1], le);
      v.setUint32(p + 4, e[1] === 2 ? (e[2] as string).length + 1 : e[1] === 5 ? (e[2] as unknown[]).length : arr(e[2]).length, le);
      if (n > 4) {
        v.setUint32(p + 8, data, le);
        data += n + (n & 1);
      }
      if (e[1] === 2) for (let i = 0; i < (e[2] as string).length; i++) v.setUint8(dst + i, (e[2] as string).charCodeAt(i) & 0xff);
      else if (e[1] === 3) arr(e[2]).forEach((x, i) => v.setUint16(dst + 2 * i, x, le));
      else if (e[1] === 4) arr(e[2]).forEach((x, i) => v.setUint32(dst + 4 * i, x, le));
      else
        (e[2] as [number, number][]).forEach((r, i) => {
          v.setUint32(dst + 8 * i, r[0], le);
          v.setUint32(dst + 8 * i + 4, r[1], le);
        });
      p += 12;
    });
    v.setUint32(p, 0, le);
  });
  return b;
}
export function app1(payload: Uint8Array) {
  const s = new Uint8Array(4 + payload.length);
  s[0] = 0xff;
  s[1] = 0xe1;
  s[2] = (payload.length + 2) >> 8;
  s[3] = (payload.length + 2) & 0xff;
  s.set(payload, 4);
  return s;
}

// ---------- JPEG ----------
export interface Seg {
  m: number;
  start: number;
  end: number;
}
export function jpegSegments(b: Uint8Array): { segs: Seg[]; end: number } {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('Not a JPEG file');
  const segs: Seg[] = [{ m: 0xd8, start: 0, end: 2 }];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error('Damaged JPEG (no marker at byte ' + i + ')');
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd9) {
      segs.push({ m, start: i, end: i + 2 });
      return { segs, end: i + 2 };
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      segs.push({ m, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (i + 4 > b.length) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw new Error('Damaged JPEG (segment runs past the end)');
    if (m === 0xda) {
      // Scan data: walk to the real EOI, stepping over any tables between progressive scans.
      let j = i + 2 + len;
      while (j < b.length - 1) {
        if (b[j] !== 0xff) {
          j++;
          continue;
        }
        const n = b[j + 1];
        if (n === 0x00 || n === 0xff || (n >= 0xd0 && n <= 0xd7)) {
          j += n === 0xff ? 1 : 2;
          continue;
        }
        if (n === 0xd9) {
          segs.push({ m, start: i, end: j }, { m: 0xd9, start: j, end: j + 2 });
          return { segs, end: j + 2 };
        }
        const l2 = (b[j + 2] << 8) | b[j + 3];
        if (l2 < 2) {
          j += 2;
          continue;
        }
        j += 2 + l2;
      }
      segs.push({ m, start: i, end: b.length }); // no EOI: keep what is there
      return { segs, end: b.length };
    }
    segs.push({ m, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  return { segs, end: i };
}
const segId = (b: Uint8Array, s: Seg) => ascii(b, s.start + 4, Math.min(30, s.end - s.start - 4));
const utf8 = new TextDecoder();
const latin1 = new TextDecoder('latin1');

export interface Inspection {
  type: 'jpeg' | 'png';
  /** Metadata blocks found: [name, bytes]. */
  blocks: [string, number][];
  meta: Meta;
}

export function inspectJpeg(b: Uint8Array): Inspection {
  const { segs, end } = jpegSegments(b);
  const blocks: [string, number][] = [];
  let meta: Meta = { fields: [], gps: null, orientation: 1 };
  segs.forEach((s) => {
    const id = segId(b, s);
    const size = s.end - s.start;
    if (s.m === 0xe1 && id.indexOf('Exif\0') === 0) {
      blocks.push(['EXIF', size]);
      try {
        const r = parseTiff(b.subarray(s.start + 10, s.end));
        meta = { fields: meta.fields.concat(r.fields), gps: r.gps || meta.gps, orientation: r.orientation };
      } catch (e) {
        meta.fields.push({ label: 'EXIF', value: 'present but damaged (' + (e as Error).message + ')' });
      }
    } else if (s.m === 0xe1 && /^https?:..ns.adobe.com.xap/.test(id) /* XMP namespace id, not a request */) {
      blocks.push(['XMP', size]);
      const xmp = utf8.decode(b.subarray(s.start + 33, s.end));
      const tool = /CreatorTool[=>"]+([^"<]{1,120})/.exec(xmp);
      if (tool) meta.fields.push({ label: 'Edited with', value: tool[1] });
      if (/GPSLatitude/.test(xmp)) meta.fields.push({ label: 'GPS (XMP)', value: 'present', sensitive: true });
    } else if (s.m === 0xe1) blocks.push(['APP1 data', size]);
    else if (s.m === 0xe2 && id.indexOf('ICC_PROFILE') === 0) blocks.push(['ICC color profile', size]);
    else if (s.m === 0xe2 && id.indexOf('MPF') === 0) blocks.push(['Multi-picture index', size]);
    else if (s.m === 0xed) blocks.push(['IPTC / Photoshop', size]);
    else if (s.m === 0xfe) {
      blocks.push(['Comment', size]);
      meta.fields.push({ label: 'Comment', value: utf8.decode(b.subarray(s.start + 4, Math.min(s.end, s.start + 304))) });
    } else if (s.m === 0xe0 && id.indexOf('JFIF') !== 0) blocks.push(['APP0 ' + id.replace(/\0.*$/, ''), size]);
    else if (s.m >= 0xe2 && s.m <= 0xef && s.m !== 0xee) blocks.push(['APP' + (s.m - 0xe0) + ' data', size]);
  });
  if (end < b.length) blocks.push(['Data after the image (embedded previews / depth maps)', b.length - end]);
  return { type: 'jpeg', blocks, meta };
}

export interface CleanOpts {
  keepIcc: boolean;
  keepOri: boolean;
}
export function cleanJpeg(b: Uint8Array, opt: CleanOpts) {
  const { segs } = jpegSegments(b);
  const parts: Uint8Array[] = [];
  let orientation = 1;
  segs.forEach((s) => {
    if (s.m === 0xe1 && segId(b, s).indexOf('Exif\0') === 0) {
      try {
        orientation = parseTiff(b.subarray(s.start + 10, s.end)).orientation;
      } catch {
        /* damaged EXIF: dropped anyway */
      }
    }
  });
  segs.forEach((s) => {
    const id = segId(b, s);
    const isApp = s.m >= 0xe0 && s.m <= 0xef;
    let keep = !isApp && s.m !== 0xfe;
    if (s.m === 0xe0 && id.indexOf('JFIF\0') === 0) keep = true;
    if (s.m === 0xe2 && id.indexOf('ICC_PROFILE') === 0 && opt.keepIcc) keep = true;
    if (s.m === 0xee && id.indexOf('Adobe') === 0) keep = true; // colour transform flag: needed to decode CMYK/YCCK correctly
    if (keep) parts.push(b.subarray(s.start, s.end));
    if (s.m === 0xd8 && opt.keepOri && orientation > 1 && orientation <= 8) parts.push(app1(buildExif({ ifd0: [[0x0112, 3, orientation]] }, false)));
  });
  return concat(parts);
}

// ---------- PNG ----------
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP: Record<string, 1> = { tEXt: 1, zTXt: 1, iTXt: 1, eXIf: 1, tIME: 1 };
export interface Chunk {
  type: string;
  start: number;
  end: number;
  data: Uint8Array;
}
export function pngChunks(b: Uint8Array): { chunks: Chunk[]; end: number } {
  if (!PNG_SIG.every((x, i) => b[i] === x)) throw new Error('Not a PNG file');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Chunk[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = v.getUint32(i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) throw new Error('Damaged PNG (chunk runs past the end)');
    out.push({ type, start: i, end, data: b.subarray(i + 8, i + 8 + len) });
    i = end;
    if (type === 'IEND') break;
  }
  return { chunks: out, end: i };
}
function inflate(bytes: Uint8Array) {
  try {
    return new Uint8Array(inflateSync(bytes));
  } catch {
    return null;
  }
}
export function inspectPng(b: Uint8Array): Inspection {
  const { chunks, end } = pngChunks(b);
  const blocks: [string, number][] = [];
  const meta: Meta = { fields: [], gps: null, orientation: 1 };
  for (const c of chunks) {
    const d = c.data;
    const z = d.indexOf(0);
    const key = z > 0 ? latin1.decode(d.subarray(0, z)) : '';
    if (c.type === 'tEXt') {
      blocks.push(['Text: ' + key, c.end - c.start]);
      meta.fields.push({ label: key || 'Text', value: latin1.decode(d.subarray(z + 1)).slice(0, 300) });
    } else if (c.type === 'zTXt') {
      const t = inflate(d.subarray(z + 2));
      blocks.push(['Text: ' + key, c.end - c.start]);
      meta.fields.push({ label: key || 'Text', value: t ? latin1.decode(t).slice(0, 300) : '(compressed)' });
    } else if (c.type === 'iTXt') {
      const lang = d.indexOf(0, z + 3);
      const tk = d.indexOf(0, lang + 1);
      const raw = d.subarray(tk + 1);
      const t = d[z + 1] ? inflate(raw) : raw;
      blocks.push(['Text: ' + key, c.end - c.start]);
      meta.fields.push({ label: key || 'Text', value: t ? utf8.decode(t).slice(0, 300) : '(compressed)' });
    } else if (c.type === 'eXIf') {
      blocks.push(['EXIF', c.end - c.start]);
      try {
        const r = parseTiff(d);
        meta.fields = meta.fields.concat(r.fields);
        meta.gps = r.gps;
        meta.orientation = r.orientation;
      } catch {
        meta.fields.push({ label: 'EXIF', value: 'present but damaged' });
      }
    } else if (c.type === 'tIME') {
      blocks.push(['Last-modified time', c.end - c.start]);
      if (d.length >= 7)
        meta.fields.push({
          label: 'Date modified',
          value: ((d[0] << 8) | d[1]) + '-' + String(d[2]).padStart(2, '0') + '-' + String(d[3]).padStart(2, '0') + ' ' + d[4] + ':' + String(d[5]).padStart(2, '0'),
        });
    } else if (c.type === 'iCCP') blocks.push(['ICC color profile', c.end - c.start]);
  }
  if (end < b.length) blocks.push(['Data after the image', b.length - end]);
  return { type: 'png', blocks, meta };
}
export function cleanPng(b: Uint8Array, opt: { keepIcc: boolean }) {
  const { chunks } = pngChunks(b);
  return concat([b.subarray(0, 8)].concat(chunks.filter((c) => !PNG_DROP[c.type] && (opt.keepIcc || c.type !== 'iCCP')).map((c) => b.subarray(c.start, c.end))));
}

export function isJpeg(b: Uint8Array) {
  return b[0] === 0xff && b[1] === 0xd8;
}
export function isPng(b: Uint8Array) {
  return b[0] === 0x89 && b[1] === 0x50;
}
export function inspect(b: Uint8Array): Inspection {
  if (isJpeg(b)) return inspectJpeg(b);
  if (isPng(b)) return inspectPng(b);
  throw new Error('Only JPEG and PNG files are supported');
}
export function clean(b: Uint8Array, opt: CleanOpts) {
  return b[0] === 0xff ? cleanJpeg(b, opt) : cleanPng(b, opt);
}
/** The website's clean file name: "a.jpg" → "a-clean.jpg". */
export const cleanName = (n: string) => n.replace(/(\.[^.]+)?$/, '-clean$1');

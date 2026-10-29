import { readFileSync } from 'node:fs';
import sharp from 'sharp';

/** Solid colour image (RGBA allowed: "#ff000080" etc.). */
export function solid(w: number, h: number, background: string, fmt: 'png' | 'jpeg' | 'webp' = 'png') {
  const s = sharp({ create: { width: w, height: h, channels: 4, background } });
  return (fmt === 'png' ? s.png() : fmt === 'jpeg' ? s.jpeg({ quality: 95 }) : s.webp({ lossless: true })).toBuffer();
}

/** Image from an SVG string, as PNG. */
export function fromSvg(svg: string) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Left half `a`, right half `b`. */
export function halves(w: number, h: number, a: string, b: string) {
  return fromSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w / 2}" height="${h}" fill="${a}"/><rect x="${w / 2}" width="${w / 2}" height="${h}" fill="${b}"/></svg>`,
  );
}

/** Horizontal black → white gradient. */
export function gradient(w: number, h: number) {
  return fromSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`,
  );
}

export const b64 = (b: Buffer) => 'base64:' + b.toString('base64');

/** RGBA of one pixel of an encoded image (or a file path). */
export async function px(img: Buffer | string, x: number, y: number) {
  const { data, info } = await sharp(typeof img === 'string' ? readFileSync(img) : img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

export async function meta(img: Buffer | string) {
  return sharp(typeof img === 'string' ? readFileSync(img) : img).metadata();
}

export const head = (p: string, n: number) => [...readFileSync(p).subarray(0, n)];

/** Minimal 24-bit BMP writer (same as the website's self-test). */
export function bmp(w: number, h: number, rgb: [number, number, number]) {
  const row = (w * 3 + 3) & ~3;
  const size = 54 + row * h;
  const b = Buffer.alloc(size);
  b[0] = 66;
  b[1] = 77;
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = 54 + y * row + x * 3;
      b[o] = rgb[2];
      b[o + 1] = rgb[1];
      b[o + 2] = rgb[0];
    }
  return b;
}

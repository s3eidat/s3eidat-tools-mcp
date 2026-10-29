/**
 * QR Code matrix encoder: a TypeScript port of "QR Code Generator for JavaScript" (qrcode.js) by Kazuhiko Arase,
 * MIT licence, Copyright (c) 2009 Kazuhiko Arase (http://www.d-project.com/), the exact library the website's QR
 * tools load from lib/qrcode.js. Same tables, mask scoring and version selection, so a given text + level gives the
 * same modules as https://s3eidat.github.io/qr-studio/. Kanji mode (needs a Shift_JIS table) is left out, as on the
 * site. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
 */

export type EccLevel = 'L' | 'M' | 'Q' | 'H';
export type QrMode = 'Numeric' | 'Alphanumeric' | 'Byte';

const MODE_BITS: Record<QrMode, number> = { Numeric: 1 << 0, Alphanumeric: 1 << 1, Byte: 1 << 2 };
/** Error correction level as encoded in the format bits (L=1, M=0, Q=3, H=2). */
const ECL: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECL_ROW: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };

// [count, totalCount, dataCount, (count, totalCount, dataCount)…] per version (1-40) and level (L, M, Q, H).
const RS_BLOCK_TABLE: number[][] = [
  [1,26,19], [1,26,16], [1,26,13], [1,26,9], // 1
  [1,44,34], [1,44,28], [1,44,22], [1,44,16], // 2
  [1,70,55], [1,70,44], [2,35,17], [2,35,13], // 3
  [1,100,80], [2,50,32], [2,50,24], [4,25,9], // 4
  [1,134,108], [2,67,43], [2,33,15,2,34,16], [2,33,11,2,34,12], // 5
  [2,86,68], [4,43,27], [4,43,19], [4,43,15], // 6
  [2,98,78], [4,49,31], [2,32,14,4,33,15], [4,39,13,1,40,14], // 7
  [2,121,97], [2,60,38,2,61,39], [4,40,18,2,41,19], [4,40,14,2,41,15], // 8
  [2,146,116], [3,58,36,2,59,37], [4,36,16,4,37,17], [4,36,12,4,37,13], // 9
  [2,86,68,2,87,69], [4,69,43,1,70,44], [6,43,19,2,44,20], [6,43,15,2,44,16], // 10
  [4,101,81], [1,80,50,4,81,51], [4,50,22,4,51,23], [3,36,12,8,37,13], // 11
  [2,116,92,2,117,93], [6,58,36,2,59,37], [4,46,20,6,47,21], [7,42,14,4,43,15], // 12
  [4,133,107], [8,59,37,1,60,38], [8,44,20,4,45,21], [12,33,11,4,34,12], // 13
  [3,145,115,1,146,116], [4,64,40,5,65,41], [11,36,16,5,37,17], [11,36,12,5,37,13], // 14
  [5,109,87,1,110,88], [5,65,41,5,66,42], [5,54,24,7,55,25], [11,36,12,7,37,13], // 15
  [5,122,98,1,123,99], [7,73,45,3,74,46], [15,43,19,2,44,20], [3,45,15,13,46,16], // 16
  [1,135,107,5,136,108], [10,74,46,1,75,47], [1,50,22,15,51,23], [2,42,14,17,43,15], // 17
  [5,150,120,1,151,121], [9,69,43,4,70,44], [17,50,22,1,51,23], [2,42,14,19,43,15], // 18
  [3,141,113,4,142,114], [3,70,44,11,71,45], [17,47,21,4,48,22], [9,39,13,16,40,14], // 19
  [3,135,107,5,136,108], [3,67,41,13,68,42], [15,54,24,5,55,25], [15,43,15,10,44,16], // 20
  [4,144,116,4,145,117], [17,68,42], [17,50,22,6,51,23], [19,46,16,6,47,17], // 21
  [2,139,111,7,140,112], [17,74,46], [7,54,24,16,55,25], [34,37,13], // 22
  [4,151,121,5,152,122], [4,75,47,14,76,48], [11,54,24,14,55,25], [16,45,15,14,46,16], // 23
  [6,147,117,4,148,118], [6,73,45,14,74,46], [11,54,24,16,55,25], [30,46,16,2,47,17], // 24
  [8,132,106,4,133,107], [8,75,47,13,76,48], [7,54,24,22,55,25], [22,45,15,13,46,16], // 25
  [10,142,114,2,143,115], [19,74,46,4,75,47], [28,50,22,6,51,23], [33,46,16,4,47,17], // 26
  [8,152,122,4,153,123], [22,73,45,3,74,46], [8,53,23,26,54,24], [12,45,15,28,46,16], // 27
  [3,147,117,10,148,118], [3,73,45,23,74,46], [4,54,24,31,55,25], [11,45,15,31,46,16], // 28
  [7,146,116,7,147,117], [21,73,45,7,74,46], [1,53,23,37,54,24], [19,45,15,26,46,16], // 29
  [5,145,115,10,146,116], [19,75,47,10,76,48], [15,54,24,25,55,25], [23,45,15,25,46,16], // 30
  [13,145,115,3,146,116], [2,74,46,29,75,47], [42,54,24,1,55,25], [23,45,15,28,46,16], // 31
  [17,145,115], [10,74,46,23,75,47], [10,54,24,35,55,25], [19,45,15,35,46,16], // 32
  [17,145,115,1,146,116], [14,74,46,21,75,47], [29,54,24,19,55,25], [11,45,15,46,46,16], // 33
  [13,145,115,6,146,116], [14,74,46,23,75,47], [44,54,24,7,55,25], [59,46,16,1,47,17], // 34
  [12,151,121,7,152,122], [12,75,47,26,76,48], [39,54,24,14,55,25], [22,45,15,41,46,16], // 35
  [6,151,121,14,152,122], [6,75,47,34,76,48], [46,54,24,10,55,25], [2,45,15,64,46,16], // 36
  [17,152,122,4,153,123], [29,74,46,14,75,47], [49,54,24,10,55,25], [24,45,15,46,46,16], // 37
  [4,152,122,18,153,123], [13,74,46,32,75,47], [48,54,24,14,55,25], [42,45,15,32,46,16], // 38
  [20,147,117,4,148,118], [40,75,47,7,76,48], [43,54,24,22,55,25], [10,45,15,67,46,16], // 39
  [19,148,118,6,149,119], [18,75,47,31,76,48], [34,54,24,34,55,25], [20,45,15,61,46,16], // 40
];

const PATTERN_POSITION_TABLE: number[][] = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]];

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

// ---------- GF(256) maths ----------
const EXP_TABLE = new Array<number>(256);
const LOG_TABLE = new Array<number>(256);
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++) EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;

function glog(n: number) {
  if (n < 1) throw new Error('glog(' + n + ')');
  return LOG_TABLE[n];
}
function gexp(n: number) {
  while (n < 0) n += 255;
  while (n >= 256) n -= 255;
  return EXP_TABLE[n];
}

/** Polynomial over GF(256); leading zero coefficients are dropped (as in the original). */
class Poly {
  readonly num: number[];
  constructor(num: number[], shift: number) {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    this.num = new Array<number>(num.length - offset + shift).fill(0);
    for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
  }
  get length() { return this.num.length; }
  multiply(e: Poly) {
    const num = new Array<number>(this.length + e.length - 1).fill(0);
    for (let i = 0; i < this.length; i++) {
      for (let j = 0; j < e.length; j++) {
        if (this.num[i] && e.num[j]) num[i + j] ^= gexp(glog(this.num[i]) + glog(e.num[j]));
      }
    }
    return new Poly(num, 0);
  }
  mod(e: Poly): Poly {
    let p: Poly = this;
    while (p.length - e.length >= 0) {
      const ratio = glog(p.num[0]) - glog(e.num[0]);
      const num = p.num.slice();
      for (let i = 0; i < e.length; i++) if (e.num[i]) num[i] ^= gexp(glog(e.num[i]) + ratio);
      p = new Poly(num, 0);
    }
    return p;
  }
}

function errorCorrectPolynomial(len: number) {
  let a = new Poly([1], 0);
  for (let i = 0; i < len; i++) a = a.multiply(new Poly([1, gexp(i)], 0));
  return a;
}

function bchDigit(data: number) {
  let digit = 0;
  while (data !== 0) { digit++; data >>>= 1; }
  return digit;
}
function bchTypeInfo(data: number) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}
function bchTypeNumber(data: number) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

function maskFunction(p: number): (i: number, j: number) => boolean {
  switch (p) {
    case 0: return (i, j) => (i + j) % 2 === 0;
    case 1: return (i) => i % 2 === 0;
    case 2: return (_i, j) => j % 3 === 0;
    case 3: return (i, j) => (i + j) % 3 === 0;
    case 4: return (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error('bad maskPattern:' + p);
  }
}

function lengthInBits(mode: number, type: number) {
  if (type >= 1 && type < 10) return mode === 1 ? 10 : mode === 2 ? 9 : 8;
  if (type < 27) return mode === 1 ? 12 : mode === 2 ? 11 : 16;
  if (type < 41) return mode === 1 ? 14 : mode === 2 ? 13 : 16;
  throw new Error('type:' + type);
}

function rsBlocks(type: number, ecl: EccLevel) {
  const row = RS_BLOCK_TABLE[(type - 1) * 4 + ECL_ROW[ecl]];
  if (!row) throw new Error('bad rs block @ typeNumber:' + type + '/errorCorrectionLevel:' + ecl);
  const list: { totalCount: number; dataCount: number }[] = [];
  for (let i = 0; i < row.length / 3; i++) {
    for (let j = 0; j < row[i * 3]; j++) list.push({ totalCount: row[i * 3 + 1], dataCount: row[i * 3 + 2] });
  }
  return list;
}

class BitBuffer {
  buffer: number[] = [];
  length = 0;
  put(num: number, length: number) {
    for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
  }
  putBit(bit: boolean) {
    const idx = Math.floor(this.length / 8);
    if (this.buffer.length <= idx) this.buffer.push(0);
    if (bit) this.buffer[idx] |= 0x80 >>> (this.length % 8);
    this.length++;
  }
}

/** UTF-8 bytes exactly like qrcode.stringToBytesFuncs['UTF-8'] (what the website selects). */
export function utf8Bytes(str: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

interface Segment { mode: number; length: number; write(b: BitBuffer): void }

function segment(data: string, mode: QrMode): Segment {
  if (mode === 'Numeric') {
    if (!/^[0-9]*$/.test(data)) throw new Error('Numeric mode takes digits 0-9 only.');
    return {
      mode: MODE_BITS.Numeric, length: data.length,
      write(b) {
        let i = 0;
        while (i + 2 < data.length) { b.put(+data.substring(i, i + 3), 10); i += 3; }
        if (i < data.length) {
          if (data.length - i === 1) b.put(+data.substring(i, i + 1), 4);
          else if (data.length - i === 2) b.put(+data.substring(i, i + 2), 7);
        }
      },
    };
  }
  if (mode === 'Alphanumeric') {
    for (const ch of data) if (ALNUM.indexOf(ch) < 0) throw new Error(`Alphanumeric mode cannot encode "${ch}" (only 0-9, A-Z, space and $ % * + - . / :).`);
    return {
      mode: MODE_BITS.Alphanumeric, length: data.length,
      write(b) {
        let i = 0;
        while (i + 1 < data.length) { b.put(ALNUM.indexOf(data[i]) * 45 + ALNUM.indexOf(data[i + 1]), 11); i += 2; }
        if (i < data.length) b.put(ALNUM.indexOf(data[i]), 6);
      },
    };
  }
  const bytes = utf8Bytes(data);
  return { mode: MODE_BITS.Byte, length: bytes.length, write(b) { for (const x of bytes) b.put(x, 8); } };
}

/** Pick the most compact single mode for a text (the site always uses Byte). */
export function bestMode(text: string): QrMode {
  if (/^[0-9]+$/.test(text)) return 'Numeric';
  if (text.length && [...text].every((c) => ALNUM.includes(c))) return 'Alphanumeric';
  return 'Byte';
}

export class QrOverflowError extends Error {}

export interface QrMatrix {
  /** Version 1-40. */
  version: number;
  ecc: EccLevel;
  mode: QrMode;
  mask: number;
  moduleCount: number;
  /** Bytes (Byte mode) or characters (Numeric/Alphanumeric) encoded. */
  dataLength: number;
  isDark(row: number, col: number): boolean;
  modules: boolean[][];
}

/**
 * Build a QR matrix. `version` 0 (default) = the smallest that fits, like `qrcode(0, ecl)` on the site.
 * `mask` undefined = the lowest-penalty mask (the library's choice); 0-7 forces one.
 */
export function makeQR(text: string, ecc: EccLevel = 'M', opts: { mode?: QrMode; version?: number; mask?: number } = {}): QrMatrix {
  const mode = opts.mode ?? 'Byte';
  const seg = segment(text, mode);
  let type = opts.version ?? 0;
  const segBits = (t: number) => { const b = new BitBuffer(); b.put(seg.mode, 4); b.put(seg.length, lengthInBits(seg.mode, t)); seg.write(b); return b; };
  const capacity = (t: number) => rsBlocks(t, ecc).reduce((s, r) => s + r.dataCount, 0);
  if (type < 1) {
    type = 1;
    for (; type < 40; type++) if (segBits(type).length <= capacity(type) * 8) break;
  }
  if (type > 40) throw new Error('Version must be 1-40.');

  // createData
  const blocks = rsBlocks(type, ecc);
  const buffer = segBits(type);
  const totalDataCount = capacity(type);
  if (buffer.length > totalDataCount * 8) {
    throw new QrOverflowError(`code length overflow. (${buffer.length}>${totalDataCount * 8})`);
  }
  if (buffer.length + 4 <= totalDataCount * 8) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(false);
  for (;;) {
    if (buffer.length >= totalDataCount * 8) break;
    buffer.put(0xec, 8);
    if (buffer.length >= totalDataCount * 8) break;
    buffer.put(0x11, 8);
  }
  const data = createBytes(buffer, blocks);

  const n = type * 4 + 17;
  let modules: (boolean | null)[][] = [];
  const build = (test: boolean, maskPattern: number) => {
    modules = Array.from({ length: n }, () => new Array<boolean | null>(n).fill(null));
    probe(0, 0); probe(n - 7, 0); probe(0, n - 7);
    adjust(); timing(); typeInfo(test, maskPattern);
    if (type >= 7) typeNumber(test);
    mapData(data, maskPattern);
  };
  const probe = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || n <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || n <= col + c) continue;
        modules[row + r][col + c] = (0 <= r && r <= 6 && (c === 0 || c === 6)) || (0 <= c && c <= 6 && (r === 0 || r === 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4);
      }
    }
  };
  const timing = () => {
    for (let r = 8; r < n - 8; r++) if (modules[r][6] == null) modules[r][6] = r % 2 === 0;
    for (let c = 8; c < n - 8; c++) if (modules[6][c] == null) modules[6][c] = c % 2 === 0;
  };
  const adjust = () => {
    const pos = PATTERN_POSITION_TABLE[type - 1];
    for (const row of pos) for (const col of pos) {
      if (modules[row][col] != null) continue;
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
        modules[row + r][col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
      }
    }
  };
  const typeNumber = (test: boolean) => {
    const bits = bchTypeNumber(type);
    for (let i = 0; i < 18; i++) modules[Math.floor(i / 3)][(i % 3) + n - 8 - 3] = !test && ((bits >> i) & 1) === 1;
    for (let i = 0; i < 18; i++) modules[(i % 3) + n - 8 - 3][Math.floor(i / 3)] = !test && ((bits >> i) & 1) === 1;
  };
  const typeInfo = (test: boolean, maskPattern: number) => {
    const bits = bchTypeInfo((ECL[ecc] << 3) | maskPattern);
    for (let i = 0; i < 15; i++) {
      const mod = !test && ((bits >> i) & 1) === 1;
      if (i < 6) modules[i][8] = mod;
      else if (i < 8) modules[i + 1][8] = mod;
      else modules[n - 15 + i][8] = mod;
    }
    for (let i = 0; i < 15; i++) {
      const mod = !test && ((bits >> i) & 1) === 1;
      if (i < 8) modules[8][n - i - 1] = mod;
      else if (i < 9) modules[8][15 - i - 1 + 1] = mod;
      else modules[8][15 - i - 1] = mod;
    }
    modules[n - 8][8] = !test;
  };
  const mapData = (bytes: number[], maskPattern: number) => {
    let inc = -1, row = n - 1, bitIndex = 7, byteIndex = 0;
    const mask = maskFunction(maskPattern);
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      for (;;) {
        for (let c = 0; c < 2; c++) {
          if (modules[row][col - c] == null) {
            let dark = false;
            if (byteIndex < bytes.length) dark = ((bytes[byteIndex] >>> bitIndex) & 1) === 1;
            if (mask(row, col - c)) dark = !dark;
            modules[row][col - c] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || n <= row) { row -= inc; inc = -inc; break; }
      }
    }
  };

  let mask = opts.mask;
  if (mask == null) {
    let min = 0;
    mask = 0;
    for (let i = 0; i < 8; i++) {
      build(true, i);
      const lost = lostPoint(modules as boolean[][], n);
      if (i === 0 || min > lost) { min = lost; mask = i; }
    }
  } else if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new Error('Mask must be 0-7.');
  build(false, mask);
  const final = modules as boolean[][];
  return {
    version: type, ecc, mode, mask, moduleCount: n, dataLength: seg.length, modules: final,
    isDark(r: number, c: number) {
      if (r < 0 || n <= r || c < 0 || n <= c) throw new Error(r + ',' + c);
      return final[r][c];
    },
  };
}

function createBytes(buffer: BitBuffer, blocks: { totalCount: number; dataCount: number }[]) {
  let offset = 0, maxDc = 0, maxEc = 0;
  const dcdata: number[][] = [], ecdata: number[][] = [];
  for (const b of blocks) {
    const dcCount = b.dataCount, ecCount = b.totalCount - dcCount;
    maxDc = Math.max(maxDc, dcCount); maxEc = Math.max(maxEc, ecCount);
    const dc = new Array<number>(dcCount);
    for (let i = 0; i < dcCount; i++) dc[i] = 0xff & (buffer.buffer[i + offset] ?? 0);
    offset += dcCount;
    const rsPoly = errorCorrectPolynomial(ecCount);
    const modPoly = new Poly(dc, rsPoly.length - 1).mod(rsPoly);
    const ec = new Array<number>(rsPoly.length - 1);
    for (let i = 0; i < ec.length; i++) {
      const idx = i + modPoly.length - ec.length;
      ec[i] = idx >= 0 ? modPoly.num[idx] : 0;
    }
    dcdata.push(dc); ecdata.push(ec);
  }
  const out: number[] = [];
  for (let i = 0; i < maxDc; i++) for (const dc of dcdata) if (i < dc.length) out.push(dc[i]);
  for (let i = 0; i < maxEc; i++) for (const ec of ecdata) if (i < ec.length) out.push(ec[i]);
  return out;
}

function lostPoint(m: boolean[][], n: number) {
  let lost = 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      let same = 0;
      const dark = m[row][col];
      for (let r = -1; r <= 1; r++) {
        if (row + r < 0 || n <= row + r) continue;
        for (let c = -1; c <= 1; c++) {
          if (col + c < 0 || n <= col + c) continue;
          if (r === 0 && c === 0) continue;
          if (dark === m[row + r][col + c]) same++;
        }
      }
      if (same > 5) lost += 3 + same - 5;
    }
  }
  for (let row = 0; row < n - 1; row++) {
    for (let col = 0; col < n - 1; col++) {
      let count = 0;
      if (m[row][col]) count++;
      if (m[row + 1][col]) count++;
      if (m[row][col + 1]) count++;
      if (m[row + 1][col + 1]) count++;
      if (count === 0 || count === 4) lost += 3;
    }
  }
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n - 6; col++) {
      if (m[row][col] && !m[row][col + 1] && m[row][col + 2] && m[row][col + 3] && m[row][col + 4] && !m[row][col + 5] && m[row][col + 6]) lost += 40;
    }
  }
  for (let col = 0; col < n; col++) {
    for (let row = 0; row < n - 6; row++) {
      if (m[row][col] && !m[row + 1][col] && m[row + 2][col] && m[row + 3][col] && m[row + 4][col] && !m[row + 5][col] && m[row + 6][col]) lost += 40;
    }
  }
  let darkCount = 0;
  for (let col = 0; col < n; col++) for (let row = 0; row < n; row++) if (m[row][col]) darkCount++;
  lost += (Math.abs((100 * darkCount) / n / n - 50) / 5) * 10;
  return lost;
}

/** Largest payload (in bytes for Byte mode) a given version/level holds. */
export function capacityBytes(version: number, ecc: EccLevel) {
  return rsBlocks(version, ecc).reduce((s, r) => s + r.dataCount, 0);
}

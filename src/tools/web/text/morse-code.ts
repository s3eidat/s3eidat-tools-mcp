import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/morse-code (app.js): the same table (54 symbols), encoder, decoder (with
// look-alike dots/dashes) and timing model. Audio, flash and the tap key need a screen and are not ported.
export const CODE: Record<string, string> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--",
  N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.", "(": "-.--.", ")": "-.--.-", "&": ".-...",
  ":": "---...", ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-", "_": "..--.-", "\"": ".-..-.", "$": "...-..-", "@": ".--.-."
};
const DECODE: Record<string, string> = {}; Object.keys(CODE).forEach(function (k) { DECODE[CODE[k]] = k; });

// Text → Morse: letters split by spaces, words by " / ". Accents are folded (é → E); unknown characters are skipped.
export function encode(text: string) {
  var skipped = 0;
  var words = text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[“”]/g, "\"").replace(/[‘’]/g, "'").toUpperCase()
    .split(/\s+/).filter(Boolean).map(function (w) {
      return Array.from(w).map(function (c) { if (CODE[c]) return CODE[c]; skipped++; return null; }).filter(Boolean).join(" ");
    }).filter(Boolean);
  return { morse: words.join(" / "), skipped: skipped };
}
// Morse → text. Accepts . - and the look-alikes • · – — _ ; words split by / or | or 2+ spaces.
export function decode(morse: string) {
  var bad = 0;
  var text = morse.replace(/[•·∙]/g, ".").replace(/[–—−_]/g, "-").trim()
    .split(/\s*[\/|]\s*|\s{2,}|\n+/).filter(function (w) { return w.trim(); }).map(function (w) {
      return w.trim().split(/\s+/).map(function (c) { if (DECODE[c]) return DECODE[c]; bad++; return "#"; }).join("");
    }).join(" ");
  return { text: text, bad: bad };
}

// Timeline in "units" (1 dot). Returns [{on, off, char}] in units + total length.
export function timeline(morse: string) {
  var t = 0, out: { on: number; off: number; char: number }[] = [], ci = 0;
  morse.trim().split(" ").forEach(function (tok, i, all) {
    if (tok === "/") { t += 4; return; } // 3 already added after the last letter, + 4 = 7
    Array.from(tok).forEach(function (s, k) {
      var len = s === "-" ? 3 : 1;
      out.push({ on: t, off: t + len, char: ci });
      t += len + (k < tok.length - 1 ? 1 : 0);
    });
    ci++;
    if (i < all.length - 1) t += 3;
  });
  return { beeps: out, total: t };
}

const MAX_CHARS = 100_000;

export default defineTool({
  name: 'text_morse',
  title: 'Morse code translator',
  webSlug: 'morse-code',
  description:
    'Translate text to International Morse code and back. Encoding: letters separated by spaces, words by " / "; accents are ' +
    'folded (é → E) and characters without a code are skipped and counted. Decoding accepts . and - plus look-alikes ' +
    '(• · – — _), with words split by /, | or 2+ spaces; unknown codes become #. Encoding also returns the playing ' +
    'time at a given speed (PARIS timing: dot = 1200/WPM ms). No audio. ' +
    `Web version: ${webUrl('morse-code')}`,
  inputSchema: z.object({
    text: z.string().max(MAX_CHARS).describe('Text to encode, or Morse code to decode.'),
    mode: z.enum(['encode', 'decode', 'auto']).optional().default('auto')
      .describe('"encode" text → Morse, "decode" Morse → text, or "auto" (default): decode if the input only has Morse symbols, spaces, / and |.'),
    wpm: z.number().min(1).max(60).optional().default(18).describe('Speed in words per minute for the duration estimate (default 18).'),
  }),
  outputSchema: z.object({
    mode: z.enum(['encode', 'decode']),
    result: z.string(),
    skipped: z.number().optional().describe('encode: characters with no Morse code (skipped).'),
    unrecognized: z.number().optional().describe('decode: codes that were not recognised (shown as #).'),
    durationSeconds: z.number().optional().describe('encode: time to play the Morse at the given WPM.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'SOS', mode: 'encode' }, output: { mode: 'encode', result: '... --- ...', skipped: 0, durationSeconds: 1.8 } },
    { input: { text: '.... ..  /  - .... . .-. .' }, output: { mode: 'decode', result: 'HI THERE', unrecognized: 0 } },
  ],
  run({ text, mode, wpm }) {
    const m = mode === 'auto' ? (/^[\s.\-•·∙–—−_/|]+$/.test(text) && /[.\-•·∙–—−_]/.test(text) ? 'decode' : 'encode') : mode;
    if (!text.trim()) throw new ToolError('Give some text or Morse code.');
    if (m === 'decode') {
      const r = decode(text);
      return { mode: m, result: r.text, unrecognized: r.bad };
    }
    const r = encode(text);
    const ms = r.morse ? timeline(r.morse).total * (1200 / wpm) : 0;
    return { mode: m, result: r.morse, skipped: r.skipped, durationSeconds: Math.round(ms / 10) / 100 };
  },
});

import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/fancy-text (app.js): maps letters to Unicode look-alikes. The character tables
// are copied byte for byte from the website source.
type Style = [string, ((ch: string) => string) | null];

const cp = String.fromCodePoint;

// Mathematical Alphanumeric Symbols: [A, a, 0] start code points, plus letters Unicode placed elsewhere (the "holes").
function math(A: number, a: number, zero: number, holes?: Record<string, string>) {
  return function (ch: string) {
    if (holes && holes[ch]) return holes[ch];
    var c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90 && A) return cp(A + c - 65);
    if (c >= 97 && c <= 122 && a) return cp(a + c - 97);
    if (c >= 48 && c <= 57 && zero) return cp(zero + c - 48);
    return ch;
  };
}
function table(from: string, to: string) {
  var a = Array.from(from), b = Array.from(to), m: Record<string, string> = {};
  a.forEach(function (c, i) { m[c] = b[i]; });
  return function (ch: string) { return m[ch] != null ? m[ch] : ch; };
}
function upperOnly(A: number, digits?: (d: number) => string) {
  return function (ch: string) {
    var c = ch.toUpperCase().charCodeAt(0);
    if (ch.length === 1 && c >= 65 && c <= 90) return cp(A + c - 65);
    if (digits && /^[0-9]$/.test(ch)) return digits(+ch);
    return ch;
  };
}
function combine(mark: string) { return function (ch: string) { return ch === "\n" ? ch : ch + mark; }; }

export const STYLES: Style[] = [
  ["Bold", math(0x1D400, 0x1D41A, 0x1D7CE)],
  ["Italic", math(0x1D434, 0x1D44E, 0, { h: "ℎ" })],
  ["Bold italic", math(0x1D468, 0x1D482, 0)],
  ["Script", math(0x1D49C, 0x1D4B6, 0, { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ", e: "ℯ", g: "ℊ", o: "ℴ" })],
  ["Bold script", math(0x1D4D0, 0x1D4EA, 0)],
  ["Fraktur", math(0x1D504, 0x1D51E, 0, { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" })],
  ["Bold fraktur", math(0x1D56C, 0x1D586, 0)],
  ["Double-struck", math(0x1D538, 0x1D552, 0x1D7D8, { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" })],
  ["Sans-serif", math(0x1D5A0, 0x1D5BA, 0x1D7E2)],
  ["Sans bold", math(0x1D5D4, 0x1D5EE, 0x1D7EC)],
  ["Sans italic", math(0x1D608, 0x1D622, 0)],
  ["Sans bold italic", math(0x1D63C, 0x1D656, 0)],
  ["Monospace", math(0x1D670, 0x1D68A, 0x1D7F6)],
  ["Circled", math(0x24B6, 0x24D0, 0, { "0": "⓪", "1": "①", "2": "②", "3": "③", "4": "④", "5": "⑤", "6": "⑥", "7": "⑦", "8": "⑧", "9": "⑨" })],
  ["Circled dark", upperOnly(0x1F150, function (d) { return d ? cp(0x2775 + d) : "⓿"; })],
  ["Squared", upperOnly(0x1F130)],
  ["Squared dark", upperOnly(0x1F170)],
  ["Parenthesized", math(0x1F110, 0x249C, 0, { "1": "⑴", "2": "⑵", "3": "⑶", "4": "⑷", "5": "⑸", "6": "⑹", "7": "⑺", "8": "⑻", "9": "⑼" })],
  ["Fullwidth", function (ch) { var c = ch.charCodeAt(0); return ch === " " ? "　" : ch.length === 1 && c >= 0x21 && c <= 0x7E ? cp(c + 0xFEE0) : ch; }],
  ["Small caps", table("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ")],
  ["Superscript", table("abcdefghijklmnoprstuvwxyzABDEGHIJKLMNOPRTUVW0123456789+-=()", "ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾")],
  ["Upside down", null],
  ["Strikethrough", combine("̶")],
  ["Underline", combine("̲")],
  ["Double underline", combine("̳")],
  ["Slashed", combine("̸")],
  ["Overline", combine("̅")],
  ["Wide spaced", function (ch) { return ch === "\n" ? ch : ch + " "; }]
];
const FLIP = table("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,'\"?!()[]{}<>_&;",
  "ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz∀ꓭƆᗡƎℲ⅁HIſꓘ˥WNOԀΌᴚS⊥∩ΛMX⅄Z0ƖᄅƐㄣϛ9ㄥ86˙'‚„¿¡)(][}{><‾⅋؛");

export function apply(style: Style, text: string) {
  var chars = Array.from(text.normalize("NFC"));
  if (style[0] === "Upside down") return chars.map(FLIP).reverse().join(""); // reversing the whole string flips the line order too
  var out = chars.map(style[1]!).join("");
  return style[0] === "Wide spaced" ? out.replace(/ +$/gm, "") : out;
}

export const STYLE_NAMES = STYLES.map((s) => s[0]);
const MAX_CHARS = 20_000;

export default defineTool({
  name: 'text_fancy',
  title: 'Fancy text (Unicode styles)',
  webSlug: 'fancy-text',
  description:
    `Restyle text with Unicode look-alike characters for bios and posts (${STYLE_NAMES.length} styles): ${STYLE_NAMES.join(', ')}. ` +
    'Only Latin letters and digits change (other scripts such as Arabic and emoji pass through); some styles cover only ' +
    `capitals or only some symbols. Give one "style", or none to get every style. Up to ${MAX_CHARS.toLocaleString('en')} ` +
    `characters. Web version: ${webUrl('fancy-text')}`,
  inputSchema: z.object({
    text: z.string().max(MAX_CHARS).describe('The text to restyle.'),
    style: z.enum(STYLE_NAMES as [string, ...string[]]).optional().describe('One style name (exact, e.g. "Bold", "Script", "Upside down"). Omit to get all styles.'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({ style: z.string(), text: z.string() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'Hello 2026', style: 'Bold' }, output: { results: [{ style: 'Bold', text: apply(STYLES[0], 'Hello 2026') }] } },
    { input: { text: 'Stay curious' }, note: `Returns all ${STYLE_NAMES.length} styles.` },
  ],
  run({ text, style }) {
    const list = style ? STYLES.filter((s) => s[0] === style) : STYLES;
    return { results: list.map((s) => ({ style: s[0], text: apply(s, text) })) };
  },
});

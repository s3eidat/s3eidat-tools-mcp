import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';
import { readTextInput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/social-counter (app.js): grapheme counts, X (twitter-text v3) weighted length,
// SMS GSM-7 / UCS-2 segments and per-platform limits, same rules and constants as the website. (The website's
// pixel-width estimate for Google titles needs a browser canvas and is not ported.)
interface Stats { g: number; x: number; utf16: number; words: number; tags: number; at: number; links: number; emoji: number; lines: number }
interface Meter { k: string; name: string; limit: number; count: (t: Stats) => number; note?: string; tags?: number; angle?: boolean; soft?: boolean; px?: boolean }

export const HTTPS = "https:" + "//";

// ---------- graphemes ----------
const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export function graphemes(s: string) {
  if (!seg) return Array.from(s);
  var out: string[] = []; for (var it = seg.segment(s)[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) out.push(r.value.segment);
  return out;
}
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

// ---------- links ----------
var TLD = "com|net|org|io|co|ai|app|dev|me|info|biz|edu|gov|uk|jo|sa|ae|eg|qa|kw|bh|om|ma|tn|lb|iq|ps|de|fr|es|it|nl|ly|gl|tv|us|ca|au|in|news|blog|shop|store|xyz|link|site|online|tech";
var URL_RX = new RegExp("(?:https?:\\/\\/|www\\.)[^\\s<>\"]+|\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:" + TLD + ")\\b(?:\\/[^\\s<>\"]*)?", "gi");
export function links(s: string) {
  var out: { start: number; end: number; url: string }[] = [], m: RegExpExecArray | null;
  URL_RX.lastIndex = 0;
  while ((m = URL_RX.exec(s))) {
    var u = m[0].replace(/[.,!?:;'")\]}»”’]+$/, "");
    if (m.index > 0 && /[@\w]/.test(s[m.index - 1])) continue; // part of an email or a word
    out.push({ start: m.index, end: m.index + u.length, url: u });
  }
  return out;
}

// ---------- X weighted length (twitter-text v3 rules) ----------
// Code points in these ranges weigh 1, everything else 2; every emoji sequence weighs 2; every link weighs 23.
var LIGHT = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
function cpWeight(cp: number) { for (var i = 0; i < LIGHT.length; i++) if (cp >= LIGHT[i][0] && cp <= LIGHT[i][1]) return 1; return 2; }
export function xLen(text: string) {
  var s = text.normalize("NFC"), total = 0, pos = 0;
  links(s).forEach(function (l) { total += weigh(s.slice(pos, l.start)) + 23; pos = l.end; });
  return total + weigh(s.slice(pos));
}
function weigh(s: string) {
  var n = 0;
  graphemes(s).forEach(function (g) {
    if (EMOJI.test(g)) { n += 2; return; }
    for (var c of g) n += cpWeight(c.codePointAt(0)!);
  });
  return n;
}

// ---------- SMS: GSM 03.38 vs UCS-2 ----------
var GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
var GSM_EXT = "\f^{}\\[~]|€"; // each costs two septets (escape + char)
var GSM_SET = new Set(Array.from(GSM)), EXT_SET = new Set(Array.from(GSM_EXT));
export function sms(text: string) {
  var chars = Array.from(text), gsm = chars.every(function (c) { return GSM_SET.has(c) || EXT_SET.has(c); });
  var single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
  var units = chars.map(function (c) { return gsm ? (EXT_SET.has(c) ? 2 : 1) : c.length; }); // UCS-2: surrogate pairs take 2
  var total = units.reduce(function (a, b) { return a + b; }, 0);
  if (!total) return { gsm: gsm, total: 0, segments: 0, per: single, remaining: single, bad: [] };
  if (total <= single) return { gsm: gsm, total: total, segments: 1, per: single, remaining: single - total, bad: nonGsm(chars) };
  // Greedy fill: an escape pair or a surrogate pair is never split across parts.
  var segs = 1, used = 0;
  units.forEach(function (u) { if (used + u > multi) { segs++; used = 0; } used += u; });
  return { gsm: gsm, total: total, segments: segs, per: multi, remaining: multi - used, bad: nonGsm(chars) };
}
function nonGsm(chars: string[]) {
  var seen = new Map<string, number>();
  chars.forEach(function (c) { if (!GSM_SET.has(c) && !EXT_SET.has(c)) seen.set(c, (seen.get(c) || 0) + 1); });
  return Array.from(seen, function (e) { return { c: e[0], n: e[1] }; });
}
const LOOKALIKE: Record<string, string> = { "“": '"', "”": '"', "„": '"', "«": '"', "»": '"', "‘": "'", "’": "'", "‚": "'", "´": "'", "`": "'", "–": "-", "—": "-", "‑": "-", "…": "...",
  " ": " ", " ": " ", " ": " ", "\t": " ", "•": "-", "·": "-", "×": "x", "ç": "Ç", "​": "", "‌": "", "‍": "", "﻿": "" };
export function toGsm(s: string) { return Array.from(s).map(function (c) { return Object.prototype.hasOwnProperty.call(LOOKALIKE, c) ? LOOKALIKE[c] : c; }).join(""); }

// ---------- other counts ----------
export function hashtags(s: string) { return (s.match(/(^|[^\p{L}\p{N}_&/])#[\p{L}\p{M}\p{N}_]*[\p{L}\p{M}_][\p{L}\p{M}\p{N}_]*/gu) || []).length; }
export function mentions(s: string) { return (s.match(/(^|[^\p{L}\p{N}_.])@[A-Za-z0-9_.]+/gu) || []).length; }
function words(s: string) { return (s.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*/gu) || []).length; }

export const METERS: Meter[] = [
  { k: "x", name: "X (Twitter) post", limit: 280, count: function (t) { return t.x; }, note: "Weighted: links 23, emoji 2, CJK 2. Premium allows 25,000." },
  { k: "threads", name: "Threads", limit: 500, count: function (t) { return t.g; } },
  { k: "bsky", name: "Bluesky", limit: 300, count: function (t) { return t.g; } },
  { k: "ig", name: "Instagram caption", limit: 2200, count: function (t) { return t.g; }, note: "About 125 characters show before “more”.", tags: 30 },
  { k: "li", name: "LinkedIn post", limit: 3000, count: function (t) { return t.g; }, note: "About 210 characters show before “see more”." },
  { k: "fb", name: "Facebook post", limit: 63206, count: function (t) { return t.g; } },
  { k: "tt", name: "TikTok caption", limit: 4000, count: function (t) { return t.g; } },
  { k: "yt", name: "YouTube title", limit: 100, count: function (t) { return t.g; }, angle: true },
  { k: "ytd", name: "YouTube description", limit: 5000, count: function (t) { return t.g; }, angle: true },
  { k: "pin", name: "Pinterest description", limit: 500, count: function (t) { return t.g; } },
  { k: "gt", name: "Google title", limit: 60, soft: true, count: function (t) { return t.g; }, px: true },
  { k: "gd", name: "Meta description", limit: 160, soft: true, count: function (t) { return t.g; }, note: "Google trims snippets at about 155–160 characters on desktop." }
];

export function analyze(text: string): Stats {
  var g = graphemes(text);
  return {
    g: g.length, x: xLen(text), utf16: text.length, words: words(text), tags: hashtags(text), at: mentions(text),
    links: links(text.normalize("NFC")).length, emoji: g.filter(function (c) { return EMOJI.test(c); }).length,
    lines: text ? text.split("\n").length : 0
  };
}

const PLATFORMS = METERS.map((m) => m.k) as [string, ...string[]];

export default defineTool({
  name: 'text_social_count',
  title: 'Social media character counter',
  webSlug: 'social-counter',
  description:
    'Check a post against platform limits the way the platforms count: X/Twitter weighted length (links = 23, emoji = 2, ' +
    'CJK = 2; limit 280), Threads 500, Bluesky 300, Instagram 2,200 (+ 30 hashtags), LinkedIn 3,000, Facebook 63,206, ' +
    'TikTok 4,000, YouTube title 100 / description 5,000, Pinterest 500, Google title ~60, meta description ~160. ' +
    'Characters are counted as user-perceived graphemes (one emoji = 1). Also: words, hashtags, mentions, links, emoji, ' +
    'and SMS encoding (GSM-7 vs Unicode) with the number of SMS parts and the characters that force Unicode. ' +
    `Give "text" or a text file "path". Web version: ${webUrl('social-counter')}`,
  inputSchema: z.object({
    text: z.string().optional().describe('The post text.'),
    path: z.string().optional().describe('Or: a path to a UTF-8 text file.'),
    platforms: z.array(z.enum(PLATFORMS)).optional()
      .describe('Only these meters: x, threads, bsky, ig, li, fb, tt, yt, ytd, pin, gt (Google title), gd (meta description). Default: all.'),
    gsmLookalikes: z.boolean().optional().default(false)
      .describe('Also return the text with curly quotes, dashes, ellipses, odd spaces etc. replaced by GSM-7 look-alikes (cheaper SMS).'),
  }),
  outputSchema: z.object({
    characters: z.number(), words: z.number(), hashtags: z.number(), mentions: z.number(), links: z.number(), emoji: z.number(),
    lines: z.number(), utf16Units: z.number(), xWeightedLength: z.number(),
    platforms: z.array(z.object({
      id: z.string(), name: z.string(), count: z.number(), limit: z.number(), softLimit: z.boolean(),
      remaining: z.number(), over: z.number(), status: z.enum(['ok', 'warn', 'over']).describe('warn = 90%+ of the limit.'),
      notes: z.array(z.string()),
    })),
    sms: z.object({
      encoding: z.enum(['GSM-7', 'UCS-2']), parts: z.number(), unitsUsed: z.number(), perPart: z.number(), leftInPart: z.number(),
      nonGsmCharacters: z.array(z.object({ char: z.string(), count: z.number() })),
    }),
    gsmText: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { text: 'Read it here: https://example.com/blog/code-reviews 🚀 #coding', platforms: ['x'] }, note: 'xWeightedLength 48: the link counts 23 and the emoji 2.' },
  ],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    const a = analyze(text), s = sms(text);
    const meters = input.platforms?.length ? METERS.filter((m) => input.platforms!.includes(m.k)) : METERS;
    return {
      characters: a.g, words: a.words, hashtags: a.tags, mentions: a.at, links: a.links, emoji: a.emoji, lines: a.lines,
      utf16Units: a.utf16, xWeightedLength: a.x,
      platforms: meters.map((m) => {
        const n = m.count(a), over = n - m.limit, notes: string[] = [];
        if (m.note) notes.push(m.note);
        if (m.tags) notes.push(`${a.tags} / ${m.tags} hashtags` + (a.tags > m.tags ? ' (too many)' : ''));
        if (m.angle && /[<>]/.test(text)) notes.push("YouTube doesn't allow < or >.");
        if (over > 0 && m.soft) notes.push('May be cut off.');
        return {
          id: m.k, name: m.name, count: n, limit: m.limit, softLimit: !!m.soft, remaining: Math.max(0, m.limit - n), over: Math.max(0, over),
          status: (over > 0 ? 'over' : n / m.limit >= 0.9 ? 'warn' : 'ok') as 'ok' | 'warn' | 'over', notes,
        };
      }),
      sms: {
        encoding: (s.gsm ? 'GSM-7' : 'UCS-2') as 'GSM-7' | 'UCS-2', parts: s.segments, unitsUsed: s.total,
        perPart: s.segments > 1 ? s.per : s.gsm ? 160 : 70, leftInPart: s.segments ? s.remaining : s.per,
        nonGsmCharacters: s.gsm ? [] : s.bad.map((b: { c: string; n: number }) => ({ char: b.c, count: b.n })),
      },
      ...(input.gsmLookalikes ? { gsmText: toGsm(text) } : {}),
    };
  },
});

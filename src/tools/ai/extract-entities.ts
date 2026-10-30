import { isIPv6 } from 'node:net';
import { z } from 'zod';
import { defineTool } from '../../registry.js';
import { readTextInput } from '../../util/files.js';
import { ToolError } from '../../util/errors.js';
import { pathField, textField } from './_text.js';

export const TYPES = [
  'emails', 'urls', 'phones', 'dates', 'money', 'percentages', 'hashtags', 'mentions', 'ipv4', 'ipv6', 'ibans', 'cards',
] as const;
export type EntityType = (typeof TYPES)[number];

export interface Entity { value: string; count: number; index: number; [k: string]: unknown }

/** Arabic-Indic and Persian digits (and Arabic decimal/thousands marks) -> ASCII, one char for one char so offsets stay valid. */
export function normDigits(s: string) {
  return s.replace(/[٠-٩۰-۹٫٬]/g, (c) => {
    const n = c.charCodeAt(0);
    if (n === 0x066b) return '.';
    if (n === 0x066c) return ',';
    return String(n >= 0x06f0 ? n - 0x06f0 : n - 0x0660);
  });
}

// ---------- validators ----------

export function luhn(digits: string) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function cardBrand(d: string): string | null {
  const n = d.length;
  if (/^4/.test(d) && (n === 13 || n === 16 || n === 19)) return 'Visa';
  if ((/^5[1-5]/.test(d) || /^2(2[2-9]|[3-6]\d|7[01]|720)/.test(d)) && n === 16) return 'Mastercard';
  if (/^3[47]/.test(d) && n === 15) return 'American Express';
  if (/^(6011|65|64[4-9])/.test(d) && n >= 16 && n <= 19) return 'Discover';
  if (/^35(2[89]|[3-8]\d)/.test(d) && n >= 16 && n <= 19) return 'JCB';
  if (/^3(0[0-5]|[68])/.test(d) && n >= 14 && n <= 19) return 'Diners Club';
  if (/^62/.test(d) && n >= 16 && n <= 19) return 'UnionPay';
  if (/^(5[06-8]|6\d)/.test(d) && n >= 12 && n <= 19) return 'Maestro';
  return null;
}

/** Mask everything but the last 4 digits. The full number is never returned. */
export const maskCard = (d: string) => '*'.repeat(d.length - 4) + d.slice(-4);

export const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28,
  CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28,
  LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24,
  SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

export function ibanValid(iban: string) {
  const s = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of s) {
    const v = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

// ---------- dates ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const monthNum = (m: string) => MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1;
const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
const year2 = (y: string) => (y.length === 2 ? (Number(y) < 70 ? 2000 : 1900) + Number(y) : Number(y));

/** Regions that write dates month-first. */
const MDY_REGIONS = new Set(['US', 'PH', 'FM', 'PW', 'MH', 'AS', 'GU', 'MP', 'PR', 'UM', 'VI']);

// ---------- money ----------

type Cur = { code: string | null; ambiguous?: boolean };
const REGIONAL: Record<string, Record<string, string> & { _?: string }> = {
  dinar: { JO: 'JOD', KW: 'KWD', BH: 'BHD', IQ: 'IQD', LY: 'LYD', TN: 'TND', DZ: 'DZD', RS: 'RSD', _: 'JOD' },
  riyal: { SA: 'SAR', QA: 'QAR', OM: 'OMR', YE: 'YER', IR: 'IRR', _: 'SAR' },
  dirham: { AE: 'AED', MA: 'MAD', _: 'AED' },
  pound: { EG: 'EGP', GB: 'GBP', LB: 'LBP', SY: 'SYP', SD: 'SDG', _: 'EGP' },
  lira: { TR: 'TRY', LB: 'LBP', SY: 'SYP', _: 'TRY' },
};
// [text, currency code or regional family]; matched case-insensitively for Latin words.
const CUR_TOKENS: [string, string][] = [
  ['US$', 'USD'], ['C$', 'CAD'], ['A$', 'AUD'], ['NZ$', 'NZD'], ['HK$', 'HKD'], ['S$', 'SGD'], ['$', 'USD?'],
  ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY?'], ['₹', 'INR'], ['₪', 'ILS'], ['₺', 'TRY'], ['₩', 'KRW'], ['₽', 'RUB'], ['﷼', 'riyal'],
  ['JD', 'JOD'], ['KD', 'KWD'], ['SR', 'SAR'], ['QR', 'QAR'], ['Dhs', 'AED'], ['AED', 'AED'],
  ...['JOD', 'USD', 'EUR', 'GBP', 'SAR', 'KWD', 'QAR', 'BHD', 'OMR', 'EGP', 'JPY', 'CNY', 'RMB', 'INR', 'CHF', 'CAD', 'AUD', 'NZD',
    'TRY', 'ILS', 'LBP', 'SYP', 'IQD', 'MAD', 'TND', 'DZD', 'LYD', 'SDG', 'YER', 'KRW', 'RUB', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK',
    'ZAR', 'BRL', 'MXN', 'PKR', 'BDT', 'IDR', 'MYR', 'THB', 'PHP', 'NGN', 'KES', 'PLN', 'CZK', 'HUF', 'IRR', 'BTC', 'ETH']
    .map((c) => [c, c === 'RMB' ? 'CNY' : c] as [string, string]),
  ['dollars', 'USD?'], ['dollar', 'USD?'], ['euros', 'EUR'], ['euro', 'EUR'], ['dinars', 'dinar'], ['dinar', 'dinar'],
  ['riyals', 'riyal'], ['riyal', 'riyal'], ['rials', 'riyal'], ['rial', 'riyal'], ['dirhams', 'dirham'], ['dirham', 'dirham'],
  ['pounds sterling', 'GBP'], ['yen', 'JPY'], ['rupees', 'INR'], ['shekels', 'ILS'],
  ['دينار أردني', 'JOD'], ['دينار اردني', 'JOD'], ['دنانير أردنية', 'JOD'], ['دينار كويتي', 'KWD'], ['دينار بحريني', 'BHD'],
  ['دينار عراقي', 'IQD'], ['ريال سعودي', 'SAR'], ['ريال قطري', 'QAR'], ['ريال عماني', 'OMR'], ['ريال يمني', 'YER'],
  ['درهم إماراتي', 'AED'], ['درهم اماراتي', 'AED'], ['درهم مغربي', 'MAD'], ['جنيه مصري', 'EGP'], ['جنيه إسترليني', 'GBP'],
  ['جنيه استرليني', 'GBP'], ['دولار أمريكي', 'USD'], ['دولار امريكي', 'USD'], ['ليرة تركية', 'TRY'], ['ليرة لبنانية', 'LBP'],
  ['ليرة سورية', 'SYP'], ['يورو', 'EUR'], ['د.أ', 'JOD'], ['د.ا', 'JOD'], ['د.ك', 'KWD'], ['ر.س', 'SAR'], ['ر.ق', 'QAR'],
  ['ر.ع', 'OMR'], ['د.إ', 'AED'], ['د.ب', 'BHD'], ['ج.م', 'EGP'], ['دولارات', 'USD?'], ['دولار', 'USD?'], ['دنانير', 'dinar'],
  ['دينارا', 'dinar'], ['دينار', 'dinar'], ['ريالات', 'riyal'], ['ريال', 'riyal'], ['دراهم', 'dirham'], ['درهم', 'dirham'],
  ['جنيهات', 'pound'], ['جنيه', 'pound'], ['ليرات', 'lira'], ['ليرة', 'lira'],
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOKENS_SORTED = CUR_TOKENS.map(([t]) => t).sort((a, b) => b.length - a.length);
const TOKEN_MAP = new Map(CUR_TOKENS.map(([t, c]) => [t.toLowerCase(), c]));
const isWordy = (t: string) => /^[\p{L}]/u.test(t);
const TOKEN_ALT = TOKENS_SORTED.map((t) => (isWordy(t) ? `(?<![\\p{L}])${esc(t)}(?![\\p{L}])` : esc(t))).join('|');
const PREFIX_ALT = TOKENS_SORTED.filter((t) => !/[؀-ۿ]/.test(t) && (!isWordy(t) || /^[A-Z]{2,4}$|^Dhs$/.test(t)))
  .map((t) => (isWordy(t) ? `(?<![\\p{L}])${esc(t)}` : esc(t))).join('|');
const AMOUNT = '(\\d{1,3}(?:\\.\\d{3})+,\\d{1,2}|\\d{1,3}(?:[,\\u00a0\\u202f]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const MULT = '(?:\\s?(thousand|million|billion|mn|bn|[kKmMbB]|ألف|مليون|مليار)(?![\\p{L}]))?';
const MONEY_PRE = new RegExp(`(${PREFIX_ALT})\\s?(-)?${AMOUNT}${MULT}`, 'gu');
const MONEY_POST = new RegExp(`(?<![\\d.,])(-)?${AMOUNT}${MULT}\\s?(${TOKEN_ALT})`, 'giu');
const MULTS: Record<string, number> = { thousand: 1e3, k: 1e3, 'ألف': 1e3, million: 1e6, mn: 1e6, m: 1e6, 'مليون': 1e6, billion: 1e9, bn: 1e9, b: 1e9, 'مليار': 1e9 };

function parseAmount(s: string) {
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  return Number(s.replace(/[,  ]/g, ''));
}

function resolveCur(token: string, region: string): Cur {
  const c = TOKEN_MAP.get(token.toLowerCase()) ?? TOKEN_MAP.get(token);
  if (!c) return { code: null, ambiguous: true };
  if (c.endsWith('?')) return { code: c.slice(0, -1), ambiguous: true };
  const fam = REGIONAL[c];
  if (fam) return { code: fam[region] ?? fam._ ?? null, ambiguous: !fam[region] };
  return { code: c };
}

// ---------- extraction ----------

export async function extractEntities(text: string, opts: { region: string; types?: readonly EntityType[] }) {
  const want = new Set(opts.types?.length ? opts.types : TYPES);
  const region = opts.region.toUpperCase();
  const t = normDigits(text);
  const claimed = new Uint8Array(t.length);
  const free = (s: number, e: number) => { for (let i = s; i < e; i++) if (claimed[i]) return false; return true; };
  const claim = (s: number, e: number) => claimed.fill(1, s, e);
  const found = new Map<EntityType, Map<string, Entity>>(TYPES.map((k) => [k, new Map()]));
  const occurrences: Record<string, number> = Object.fromEntries(TYPES.map((k) => [k, 0]));
  const add = (type: EntityType, key: string, index: number, value: string, extra: Record<string, unknown> = {}) => {
    occurrences[type]++;
    const m = found.get(type)!;
    const e = m.get(key);
    if (e) e.count++;
    else m.set(key, { value, count: 1, index, ...extra });
  };
  /** Run a regex; `fn` returns the [start, end) it accepted (claimed), or null to skip. */
  const scan = (re: RegExp, fn: (m: RegExpExecArray) => [number, number] | null) => {
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(t)); ) {
      if (!free(m.index, m.index + m[0].length)) continue;
      const span = fn(m);
      if (span) claim(span[0], span[1]);
    }
  };

  // URLs (before emails so addresses inside links stay part of the link).
  scan(/\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+/gi, (m) => {
    let u = m[0];
    for (;;) {
      const before = u;
      u = u.replace(/[.,;:!?'"،؛…]+$/, '');
      for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        if (u.endsWith(c) && u.split(c).length > u.split(o).length) u = u.slice(0, -1);
      }
      if (u === before) break;
    }
    if (u.length < 5 || /^www\.?$/i.test(u)) return null;
    if (want.has('urls')) add('urls', u.toLowerCase(), m.index, u);
    return [m.index, m.index + u.length];
  });

  scan(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9_%+-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/g, (m) => {
    if (want.has('emails')) add('emails', m[0].toLowerCase(), m.index, m[0]);
    return [m.index, m.index + m[0].length];
  });

  // IBANs: two letters, two check digits, then the account part (spaces allowed between groups).
  scan(/(?<![A-Za-z0-9])([A-Z]{2})(\d{2})((?: ?[A-Z0-9]){11,30})/g, (m) => {
    const cc = m[1];
    const raw = m[0];
    const need = IBAN_LENGTHS[cc];
    let take = raw.replace(/ /g, '');
    let end = m.index + raw.length;
    if (need) {
      if (take.length < need) return null;
      // Walk the raw text until we have `need` non-space characters.
      let n = 0, i = 0;
      while (i < raw.length && n < need) { if (raw[i] !== ' ') n++; i++; }
      end = m.index + i;
      if (/[A-Za-z0-9]/.test(t[end] ?? '')) return null; // glued to more characters: not a clean IBAN
      take = take.slice(0, need);
    } else if (take.length < 15 || take.length > 34) return null;
    const valid = ibanValid(take);
    if (!need && !valid) return null;
    if (want.has('ibans')) add('ibans', take, m.index, take, { formatted: take.replace(/(.{4})(?=.)/g, '$1 '), country: cc, valid });
    return [m.index, end];
  });

  // Card-like numbers: 13-19 digits, Luhn-valid, known brand prefix. Masked; the full number is never returned.
  scan(/(?<![\d.,])(?:\d[ -]?){12,18}\d(?![\d])/g, (m) => {
    const d = m[0].replace(/\D/g, '');
    if (d.length < 13 || d.length > 19 || !luhn(d)) return null;
    const brand = cardBrand(d);
    if (!brand) return null;
    if (want.has('cards')) add('cards', d, m.index, maskCard(d), { brand, last4: d.slice(-4), luhnValid: true });
    return [m.index, m.index + m[0].length];
  });

  scan(/(?<![0-9A-Fa-f:.\w])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f]{0,4})(?:%[A-Za-z0-9]+)?(?![\w:])/g, (m) => {
    const ip = m[0];
    if (!/[0-9A-Fa-f]/.test(ip) || !isIPv6(ip.replace(/%.*$/, ''))) return null;
    if (want.has('ipv6')) add('ipv6', ip.toLowerCase(), m.index, ip);
    return [m.index, m.index + ip.length];
  });

  const OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  scan(new RegExp(`(?<![\\d.])(?:${OCT}\\.){3}${OCT}(?![\\d]|\\.\\d)`, 'g'), (m) => {
    if (want.has('ipv4')) add('ipv4', m[0], m.index, m[0]);
    return [m.index, m.index + m[0].length];
  });

  // Dates.
  const addDate = (m: RegExpExecArray, normalized: string, extra: Record<string, unknown> = {}): [number, number] => {
    if (want.has('dates')) add('dates', normalized + (extra.ambiguous ? '?' + m[0] : ''), m.index, text.slice(m.index, m.index + m[0].length), { normalized, ...extra });
    return [m.index, m.index + m[0].length];
  };
  scan(/(?<![\d.\/-])(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?(?![\d\/-])/g, (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDate(y, mo, d)) return null;
    const time = m[4] ? `T${m[4]}:${m[5]}${m[6] ? ':' + m[6] : ''}${m[7] ?? ''}` : '';
    return addDate(m, iso(y, mo, d) + time, { format: 'ISO' });
  });
  scan(/(?<![\d.\/-])(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})(?![\d\/-]|\.\d)/g, (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDate(y, mo, d)) return null;
    return addDate(m, iso(y, mo, d), { format: 'Y/M/D' });
  });
  scan(/(?<![\d.\/-])(\d{1,2})([\/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\d\/-]|\.\d)/g, (m) => {
    const a = Number(m[1]), b = Number(m[3]), y = year2(m[4]);
    const dmy = validDate(y, b, a), mdy = validDate(y, a, b);
    if (!dmy && !mdy) return null;
    const extra: Record<string, unknown> = {};
    if (m[4].length === 2) extra.twoDigitYear = true;
    if (dmy && mdy && a !== b) {
      const preferMdy = MDY_REGIONS.has(region);
      const first = preferMdy ? iso(y, a, b) : iso(y, b, a);
      const other = preferMdy ? iso(y, b, a) : iso(y, a, b);
      return addDate(m, first, { format: preferMdy ? 'M/D/Y' : 'D/M/Y', ambiguous: true, alternatives: [other], ...extra });
    }
    return dmy ? addDate(m, iso(y, b, a), { format: 'D/M/Y', ...extra }) : addDate(m, iso(y, a, b), { format: 'M/D/Y', ...extra });
  });
  scan(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE},?\\s+(\\d{4})\\b`, 'gi'), (m) => {
    const d = Number(m[1]), mo = monthNum(m[2]), y = Number(m[3]);
    return validDate(y, mo, d) ? addDate(m, iso(y, mo, d), { format: 'D Month Y' }) : null;
  });
  scan(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), (m) => {
    const d = Number(m[2]), mo = monthNum(m[1]), y = Number(m[3]);
    return validDate(y, mo, d) ? addDate(m, iso(y, mo, d), { format: 'Month D, Y' }) : null;
  });
  scan(new RegExp(`\\b${MONTH_RE},?\\s+(\\d{4})\\b`, 'g'), (m) => {
    // Month and year only ("March 2024"): capitalised month names only, so "may 2024" in a sentence is skipped.
    if (!/^[A-Z]/.test(m[0])) return null;
    const mo = monthNum(m[1]), y = Number(m[2]);
    return addDate(m, `${y}-${pad(mo)}`, { format: 'Month Y', precision: 'month' });
  });

  // Money.
  const addMoney = (m: RegExpExecArray, sign: string | undefined, amountS: string, mult: string | undefined, token: string): [number, number] => {
    let amount = parseAmount(amountS) * (mult ? MULTS[mult.toLowerCase()] ?? MULTS[mult] ?? 1 : 1);
    if (sign) amount = -amount;
    const cur = resolveCur(token, region);
    if (want.has('money')) {
      add('money', `${cur.code ?? token}:${amount}`, m.index, text.slice(m.index, m.index + m[0].length), {
        amount, currency: cur.code, currencyText: token, ...(cur.ambiguous ? { ambiguous: true } : {}),
      });
    }
    return [m.index, m.index + m[0].length];
  };
  scan(MONEY_PRE, (m) => addMoney(m, m[2], m[3], m[4], m[1]));
  scan(MONEY_POST, (m) => addMoney(m, m[1], m[2], m[3], m[4]));

  scan(/(?<![\d.\p{L}])([-+]?\d+(?:[.,]\d+)?)\s?(%|٪|‰|percent(?![\p{L}])|per cent(?![\p{L}])|بالمئة|بالمائة|في المئة|في المائة)/giu, (m) => {
    const n = Number(m[1].replace(',', '.'));
    const value = m[2] === '‰' ? n / 10 : n;
    if (want.has('percentages')) add('percentages', String(value), m.index, text.slice(m.index, m.index + m[0].length), { number: value });
    return [m.index, m.index + m[0].length];
  });

  // Phones (libphonenumber "valid" leniency) on the text with digits normalised.
  if (want.has('phones')) {
    const lib = await import('libphonenumber-js/max');
    let list;
    try {
      list = lib.findPhoneNumbersInText(t, { defaultCountry: region as never });
    } catch (e) {
      throw new ToolError(`Bad defaultRegion "${opts.region}": ${(e as Error).message}`);
    }
    for (const f of list) {
      if (!free(f.startsAt, f.endsAt)) continue;
      const raw = t.slice(f.startsAt, f.endsAt);
      const digits = raw.replace(/\D/g, '');
      // Never let a long bare digit run (a possible card or account number) through as a phone.
      if (digits.length >= 13 && !/^\s*(\+|00)/.test(raw)) continue;
      add('phones', f.number.number, f.startsAt, f.number.number, {
        raw: text.slice(f.startsAt, f.endsAt), country: f.number.country ?? null,
        international: f.number.formatInternational(), national: f.number.formatNational(), type: f.number.getType() ?? null,
      });
      claim(f.startsAt, f.endsAt);
    }
  }

  scan(/(?<![\p{L}\p{N}_&\/#])#([\p{L}\p{M}\p{N}_]+)/gu, (m) => {
    if (!/\p{L}/u.test(m[1])) return null;
    if (want.has('hashtags')) add('hashtags', m[1].toLocaleLowerCase(), m.index, m[0]);
    return [m.index, m.index + m[0].length];
  });
  scan(/(?<![\p{L}\p{N}_.@\/])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,48}[A-Za-z0-9_])?)/gu, (m) => {
    if (want.has('mentions')) add('mentions', m[1].toLowerCase(), m.index, m[0]);
    return [m.index, m.index + m[0].length];
  });

  const entities: Partial<Record<EntityType, Entity[]>> = {};
  const counts: Partial<Record<EntityType, number>> = {};
  const occ: Partial<Record<EntityType, number>> = {};
  for (const k of TYPES) {
    if (!want.has(k)) continue;
    entities[k] = [...found.get(k)!.values()].sort((a, b) => a.index - b.index);
    counts[k] = entities[k]!.length;
    occ[k] = occurrences[k];
  }
  return { entities, counts, occurrences: occ };
}

const entitySchema = z.looseObject({ value: z.string(), count: z.number(), index: z.number() });

export default defineTool({
  name: 'ai_extract_entities',
  title: 'Extract entities',
  description:
    'Pull structured items out of text or a text file, deduplicated with counts: emails, URLs, phone numbers (libphonenumber, ' +
    'validated, E.164 plus type/country; local numbers read with defaultRegion, default JO), dates (ISO, D/M/Y or M/D/Y, Y/M/D, ' +
    'English month names; normalised to YYYY-MM-DD; a date like 03/04/2024 is flagged ambiguous with the other reading), money ' +
    '($, €, £, JOD/JD/د.أ, SAR/ر.س, AED/د.إ, KWD, EGP… and Arabic currency words, with amount and ISO currency), percentages, ' +
    '#hashtags, @mentions, IPv4/IPv6, IBANs (country length and mod-97 checked) and card-like numbers (only Luhn-valid ones with ' +
    'a known brand prefix, always masked: only the last 4 digits are shown, the full number is never returned). Arabic-Indic ' +
    'digits are understood. Regex-based, not NLP: no names, places or organisations. Give "text" or "path" (file path or base64).',
  inputSchema: z.object({
    text: textField(),
    path: pathField(),
    types: z.array(z.enum(TYPES)).optional().describe(`Only these types (default all): ${TYPES.join(', ')}.`),
    defaultRegion: z.string().regex(/^[A-Za-z]{2}$/).optional().default('JO')
      .describe('Two-letter country for local phone numbers, regional currencies (dinar, riyal…) and D/M/Y vs M/D/Y. Default JO.'),
    maxPerType: z.number().int().min(1).max(10_000).optional().default(500).describe('Most unique items to return per type. Default 500.'),
  }),
  outputSchema: z.object({
    counts: z.record(z.string(), z.number()).describe('Unique items per type.'),
    occurrences: z.record(z.string(), z.number()).describe('All occurrences per type (before dedupe).'),
    total: z.number().describe('Unique items over all types.'),
    entities: z.record(z.string(), z.array(entitySchema)).describe('Per type, in order of first appearance. "index" is the first offset in the text.'),
    truncated: z.array(z.string()).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: { text: 'Mail omar@example.com or call 079 123 4567 before 15/03/2025. Fee: 25 JOD (10% off). #sale @s3eidat' },
      output: { counts: { emails: 1, phones: 1, dates: 1, money: 1, percentages: 1, hashtags: 1, mentions: 1 } },
    },
  ],
  async run(input, ctx) {
    const text = await readTextInput(input.text, input.path, ctx);
    const r = await extractEntities(text, { region: input.defaultRegion, types: input.types });
    const truncated: string[] = [];
    for (const [k, list] of Object.entries(r.entities)) {
      if (list && list.length > input.maxPerType) { r.entities[k as EntityType] = list.slice(0, input.maxPerType); truncated.push(k); }
    }
    const total = Object.values(r.counts).reduce((a, b) => a + (b ?? 0), 0);
    return { counts: r.counts, occurrences: r.occurrences, total, entities: r.entities, ...(truncated.length ? { truncated } : {}) };
  },
});

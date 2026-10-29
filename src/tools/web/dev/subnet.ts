import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/subnet-calc (app.js): IPv4 maths on unsigned 32-bit numbers, IPv6 with
// BigInt, the same special-range tables, equal split, VLSM (largest first, aligned) and range checker.

// ================= IPv4 core =================
export function parseV4(s: string | undefined): number | null {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(s || '');
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    if (m[i].length > 1 && m[i][0] === '0') return null; // no ambiguous octal-looking octets
    const o = +m[i];
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}
export function v4str(n: number) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
export function maskOf(p: number) {
  return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
}
function prefixOfMask(m: number) {
  for (let p = 0; p <= 32; p++) if (maskOf(p) === m) return p;
  return -1;
}

export type V4Input = { ip: number; prefix: number | null; wildcardGiven?: boolean } | { error: string };
/** "a.b.c.d/nn", "a.b.c.d/m.m.m.m", "a.b.c.d m.m.m.m", "a.b.c.d" → {ip, prefix|null} or {error} */
export function parseV4Input(s: string): V4Input | null {
  s = (s || '').trim();
  if (!s) return null;
  const parts = s.split(/\s*\/\s*|\s+/);
  if (parts.length > 2) return { error: 'Use one address, optionally followed by /prefix or a mask' };
  const ip = parseV4(parts[0]);
  if (ip === null) return { error: 'Not a valid IPv4 address' };
  if (parts.length === 1) return { ip, prefix: null };
  const p = parts[1];
  if (/^\d{1,2}$/.test(p) && +p <= 32) return { ip, prefix: +p };
  const m = parseV4(p);
  if (m === null) return { error: 'The prefix must be 0–32 or a dotted mask' };
  const pr = prefixOfMask(m);
  if (pr < 0) {
    const wp = prefixOfMask(~m >>> 0); // a wildcard mask such as 0.0.0.255
    if (wp >= 0 && m !== 0) return { ip, prefix: wp, wildcardGiven: true };
    return { error: 'That mask is not contiguous (all ones, then all zeros)' };
  }
  return { ip, prefix: pr };
}

const V4_SPECIAL: [string, number, string][] = [
  ['0.0.0.0', 8, '“This network” (RFC 1122)'], ['10.0.0.0', 8, 'Private (RFC 1918)'],
  ['100.64.0.0', 10, 'Shared / carrier-grade NAT (RFC 6598)'], ['127.0.0.0', 8, 'Loopback'],
  ['169.254.0.0', 16, 'Link-local (APIPA)'], ['172.16.0.0', 12, 'Private (RFC 1918)'],
  ['192.0.0.0', 24, 'IETF protocol assignments'], ['192.0.2.0', 24, 'Documentation (TEST-NET-1)'],
  ['192.88.99.0', 24, '6to4 relay anycast (deprecated)'], ['192.168.0.0', 16, 'Private (RFC 1918)'],
  ['198.18.0.0', 15, 'Benchmarking (RFC 2544)'], ['198.51.100.0', 24, 'Documentation (TEST-NET-2)'],
  ['203.0.113.0', 24, 'Documentation (TEST-NET-3)'], ['224.0.0.0', 4, 'Multicast'],
  ['255.255.255.255', 32, 'Limited broadcast'], ['240.0.0.0', 4, 'Reserved (class E)'],
];
export function v4type(ip: number) {
  for (const s of V4_SPECIAL) if ((ip & maskOf(s[1])) >>> 0 === parseV4(s[0])) return { label: s[2], pub: false };
  return { label: 'Public (globally routable)', pub: true };
}
export function v4class(ip: number) {
  const o = ip >>> 24;
  return o < 128 ? 'A' : o < 192 ? 'B' : o < 224 ? 'C' : o < 240 ? 'D (multicast)' : 'E (reserved)';
}

export interface V4Calc {
  ip: number;
  prefix: number;
  mask: number;
  wildcard: number;
  network: number;
  broadcast: number;
  first: number;
  last: number;
  total: number;
  usable: number;
}
export function v4calc(ip: number, prefix: number): V4Calc {
  const mask = maskOf(prefix), wild = ~mask >>> 0;
  const net = (ip & mask) >>> 0, bc = (net | wild) >>> 0;
  const total = Math.pow(2, 32 - prefix);
  const usable = prefix === 32 ? 1 : prefix === 31 ? 2 : total - 2;
  const first = prefix >= 31 ? net : net + 1, last = prefix >= 31 ? bc : bc - 1;
  return { ip, prefix, mask, wildcard: wild, network: net, broadcast: bc, first: first >>> 0, last: last >>> 0, total, usable };
}

/** Split into at least n equal subnets. */
export function splitN(net: number, prefix: number, n: number) {
  if (!(n >= 1)) return { error: 'Enter a number of subnets' };
  const bits = Math.ceil(Math.log2(n) - 1e-9), np = prefix + bits;
  if (np > 32) return { error: "A /" + prefix + " can't be split into " + n + ' subnets (max ' + Math.pow(2, 32 - prefix) + ')' };
  const count = Math.pow(2, bits), size = Math.pow(2, 32 - np), list: V4Calc[] = [];
  for (let i = 0; i < count && i < 4096; i++) list.push(v4calc((net + i * size) >>> 0, np));
  return { prefix: np, count, list, rounded: count !== n };
}

interface Req {
  name: string;
  hosts: number;
  order: number;
}
/** VLSM requests: "50, 20" or "Sales:50, Ops=20". */
export function parseVlsm(s: string): { list: Req[] } | { error: string } {
  const out: Req[] = [];
  let bad: string | null = null;
  (s || '').split(/[,;\n]+/).forEach((part, i) => {
    part = part.trim();
    if (!part) return;
    const m = /^(?:(.*?)\s*[:=]\s*)?(\d+)$/.exec(part);
    if (!m || +m[2] < 1) {
      bad = part;
      return;
    }
    out.push({ name: (m[1] || '').trim() || 'Subnet ' + (out.length + 1), hosts: +m[2], order: i });
  });
  return bad ? { error: "Can't read “" + bad + '”. Use numbers like 50, 20 or names like Sales:50' } : { list: out };
}
/** VLSM: biggest first, each block aligned to its own size. */
export function vlsm(net: number, prefix: number, reqs: Req[]) {
  const end = net + Math.pow(2, 32 - prefix);
  let cur = net;
  const rows: (V4Calc & { name: string; need: number })[] = [];
  const sorted = reqs.slice().sort((a, b) => b.hosts - a.hosts || a.order - b.order);
  for (const r of sorted) {
    const bits = Math.ceil(Math.log2(r.hosts + 2) - 1e-9), p = 32 - bits;
    if (p < prefix) return { error: r.name + ' needs ' + r.hosts + ' hosts, more than the whole /' + prefix + ' holds' };
    const size = Math.pow(2, bits);
    cur = Math.ceil(cur / size) * size;
    if (cur + size > end) return { error: 'Out of space at ' + r.name + ": the requests don't fit in /" + prefix };
    rows.push({ ...v4calc(cur >>> 0, p), name: r.name, need: r.hosts });
    cur += size;
  }
  return { list: rows, used: cur - net, free: end - cur };
}

// ================= IPv6 core (BigInt) =================
const B0 = 0n, B1 = 1n, B16 = 16n, BALL = (B1 << 128n) - B1;
export function parseV6(s: string): { n: bigint; zone: string } | null {
  s = (s || '').trim().replace(/^\[|\]$/g, '');
  let zone = '';
  const zi = s.indexOf('%');
  if (zi >= 0) {
    zone = s.slice(zi + 1);
    s = s.slice(0, zi);
  }
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.indexOf(':') < 0) return null;
  let tail4: number | null = null;
  const m = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m) {
    tail4 = parseV4(m[2]);
    if (tail4 === null) return null;
    s = m[1] + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === '' ? [] : h.split(':'));
  const a = groups(halves[0]), b = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - a.length - b.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = a.concat(new Array(halves.length === 2 ? fill : 0).fill('0'), b);
  let n = B0;
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i])) return null;
    n = (n << B16) | BigInt(parseInt(all[i], 16));
  }
  if (tail4 !== null) n = (n & ~0xffffffffn) | BigInt(tail4);
  return { n, zone };
}
function v6groups(n: bigint) {
  const g: number[] = [];
  for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  return g;
}
export function v6expand(n: bigint) {
  return v6groups(n).map((x) => x.toString(16).padStart(4, '0')).join(':');
}
/** RFC 5952: lower case, no leading zeros, longest run (>= 2) of zero groups becomes "::", first one on a tie. */
export function v6compress(n: bigint) {
  const g = v6groups(n);
  let best = -1, bestLen = 0, i = 0;
  while (i < 8) {
    if (g[i] === 0) {
      let j = i;
      while (j < 8 && g[j] === 0) j++;
      if (j - i > bestLen) {
        best = i;
        bestLen = j - i;
      }
      i = j;
    } else i++;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestLen < 2) return hex.join(':');
  return hex.slice(0, best).join(':') + '::' + hex.slice(best + bestLen).join(':');
}
function v6mask(p: number) {
  return p === 0 ? B0 : (BALL >> BigInt(128 - p)) << BigInt(128 - p);
}
const V6_SPECIAL: [string, number, string][] = [
  ['::', 128, 'Unspecified address'], ['::1', 128, 'Loopback'], ['::ffff:0:0', 96, 'IPv4-mapped'],
  ['64:ff9b::', 96, 'IPv4/IPv6 translation (NAT64)'], ['100::', 64, 'Discard-only'],
  ['2001:db8::', 32, 'Documentation'], ['2001::', 32, 'Teredo tunneling'], ['2002::', 16, '6to4'],
  ['fc00::', 7, 'Unique local (ULA, private)'], ['fe80::', 10, 'Link-local'], ['ff00::', 8, 'Multicast'],
  ['2000::', 3, 'Global unicast'],
];
export function v6type(n: bigint) {
  for (const s of V6_SPECIAL) if ((n & v6mask(s[1])) === parseV6(s[0])!.n) return s[2];
  return 'Reserved / unassigned';
}
export function v6calc(n: bigint, p: number) {
  const m = v6mask(p), net = n & m, last = net | (BALL ^ m);
  return { n, prefix: p, network: net, last, count: B1 << BigInt(128 - p), n64: p <= 64 ? B1 << BigInt(64 - p) : null };
}
export function v6reverse(n: bigint) {
  return v6expand(n).replace(/:/g, '').split('').reverse().join('.') + '.ip6.arpa';
}
const bigFmt = (b: bigint) => b.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const bigPow2 = (e: number) => (e < 1 ? '' : ' (2^' + e + ')');

type Range = { v: 4; start: number; end: number } | { v: 6; start: bigint; end: bigint };
/** Range parser for the checker: CIDR, "a - b" or a single IP, either family. */
export function parseRange(s: string): Range | null {
  s = (s || '').trim();
  if (!s) return null;
  const dash = s.split(/\s+-\s+|\s*–\s*|(?<=\d)-(?=\d)/);
  if (dash.length === 2) {
    const a4 = parseV4(dash[0]), b4 = parseV4(dash[1]);
    if (a4 !== null && b4 !== null) return { v: 4, start: Math.min(a4, b4), end: Math.max(a4, b4) };
    const a6 = parseV6(dash[0]), b6 = parseV6(dash[1]);
    if (a6 && b6) return { v: 6, start: a6.n < b6.n ? a6.n : b6.n, end: a6.n < b6.n ? b6.n : a6.n };
    return null;
  }
  if (s.indexOf(':') >= 0) {
    const sl = s.split('/'), x = parseV6(sl[0]), p = sl.length > 1 ? +sl[1] : 128;
    if (!x || !(p >= 0 && p <= 128) || sl.length > 2) return null;
    const c = v6calc(x.n, p);
    return { v: 6, start: c.network, end: c.last };
  }
  const r = parseV4Input(s);
  if (!r || 'error' in r) return null;
  const cc = v4calc(r.ip, r.prefix === null ? 32 : r.prefix);
  return { v: 4, start: cc.network, end: cc.broadcast };
}
export function checkIn(ipText: string, rangeText: string): { inside: boolean; rg: Range } | { error: string } {
  const rg = parseRange(rangeText);
  if (!rg) return { error: "Can't read the range" };
  if (rg.v === 4) {
    const ip = parseV4(ipText);
    if (ip === null) return { error: parseV6(ipText) ? 'IPv6 address vs an IPv4 range' : 'Not a valid IP address' };
    return { inside: ip >= rg.start && ip <= rg.end, rg };
  }
  const x = parseV6(ipText);
  if (!x) return { error: parseV4(ipText) !== null ? 'IPv4 address vs an IPv6 range' : 'Not a valid IP address' };
  return { inside: x.n >= rg.start && x.n <= rg.end, rg };
}

// ================= tool output =================
const bin32 = (n: number) => (n >>> 0).toString(2).padStart(32, '0').replace(/(.{8})(?=.)/g, '$1.');
function v4row(s: V4Calc) {
  return {
    network: v4str(s.network) + '/' + s.prefix,
    firstHost: v4str(s.first),
    lastHost: v4str(s.last),
    broadcast: s.prefix >= 31 ? null : v4str(s.broadcast),
    usableHosts: s.usable,
    mask: v4str(s.mask),
  };
}
function summaryText(c: V4Calc) {
  return [
    'Address:      ' + v4str(c.ip) + '/' + c.prefix,
    'Network:      ' + v4str(c.network) + '/' + c.prefix,
    'Netmask:      ' + v4str(c.mask),
    'Wildcard:     ' + v4str(c.wildcard),
    'Broadcast:    ' + (c.prefix >= 31 ? 'n/a' : v4str(c.broadcast)),
    'Host range:   ' + v4str(c.first) + ' - ' + v4str(c.last),
    'Usable hosts: ' + c.usable.toLocaleString('en-US'),
    'Total:        ' + c.total.toLocaleString('en-US'),
    'Type:         ' + v4type(c.ip).label,
  ].join('\n');
}

const annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const subnetCalc = defineTool({
  name: 'subnet_calc',
  title: 'Subnet calculator (IPv4 / IPv6)',
  webSlug: 'subnet-calc',
  description:
    'IPv4: from "192.168.1.0/26", "10.0.0.5 255.255.255.0" or a wildcard mask, get network, broadcast, first/last host, ' +
    'usable and total addresses, netmask, wildcard, class, address type (private, CGNAT, loopback, documentation…), ' +
    'integer/hex/binary forms; optionally split into N equal subnets or allocate VLSM blocks by host counts ' +
    '("Sales:50, Ops:20"). /31 and /32 follow RFC 3021. IPv6: compressed (RFC 5952) and expanded forms, network, first/last ' +
    'address, address count, number of /64s, reverse DNS name and type. ' +
    `Web version: ${webUrl('subnet-calc')}`,
  inputSchema: z.object({
    address: z.string().describe('IPv4 or IPv6 address, optionally with /prefix (or an IPv4 dotted mask after a space or slash).'),
    prefix: z.number().int().min(0).max(128).optional().describe('Prefix length to use when "address" has none (default /24 for IPv4, /128 for IPv6), or to override it.'),
    split: z.number().int().min(1).max(4294967296).optional().describe('IPv4: split the network into at least this many equal subnets (rounded up to a power of two; first 4096 listed).'),
    vlsm: z.string().optional().describe('IPv4: VLSM host requirements, e.g. "50, 20, 10" or "Sales:50, Ops:20". Largest first, each block aligned.'),
  }),
  outputSchema: z
    .object({
      version: z.number().describe('4 or 6.'),
      type: z.string().describe('Address type, e.g. "Private (RFC 1918)" or "Documentation".'),
      prefix: z.number(),
      network: z.string(),
      broadcast: z.string().nullable().optional(),
      firstHost: z.string().optional(),
      lastHost: z.string().optional(),
      usableHosts: z.number().optional(),
      totalAddresses: z.number().optional(),
      subnetMask: z.string().optional(),
      wildcardMask: z.string().optional(),
      compressed: z.string().optional(),
      expanded: z.string().optional(),
      firstAddress: z.string().optional(),
      lastAddress: z.string().optional(),
      addresses: z.string().optional(),
      split: z.unknown().optional(),
      vlsm: z.unknown().optional(),
    })
    .passthrough(),
  annotations,
  examples: [
    { input: { address: '192.168.1.0/26' }, note: 'broadcast 192.168.1.63, hosts 192.168.1.1–192.168.1.62, 62 usable, mask 255.255.255.192' },
    { input: { address: '192.168.1.0/24', vlsm: '2, 50, 10, 20' }, note: '192.168.1.0/26, .64/27, .96/28, .112/30' },
    { input: { address: '2001:db8:abcd::1/48' } },
  ],
  run(input) {
    const raw = input.address.trim();
    if (raw.includes(':')) {
      const sl = raw.split('/'), x = parseV6(sl[0]);
      const p = input.prefix ?? (sl.length > 1 ? Number(sl[1].trim()) : 128);
      if (!x || sl.length > 2 || (sl.length > 1 && !/^\d{1,3}$/.test(sl[1].trim())) || !(p >= 0 && p <= 128)) {
        throw new ToolError('Not a valid IPv6 address' + (sl.length > 1 ? ' / prefix' : ''));
      }
      if (input.split || input.vlsm) throw new ToolError('Splitting and VLSM are for IPv4 networks.');
      const c = v6calc(x.n, p);
      return {
        version: 6,
        type: v6type(x.n),
        compressed: v6compress(x.n) + (x.zone ? '%' + x.zone : ''),
        expanded: v6expand(x.n),
        prefix: p,
        network: v6compress(c.network) + '/' + p,
        firstAddress: v6expand(c.network),
        lastAddress: v6expand(c.last),
        addresses: bigFmt(c.count) + bigPow2(128 - p),
        subnets64: c.n64 === null ? 'less than one /64' : bigFmt(c.n64) + bigPow2(64 - p),
        reverseDns: v6reverse(x.n),
      };
    }
    const r = parseV4Input(raw);
    if (!r) throw new ToolError('Give an IPv4 or IPv6 address.');
    if ('error' in r) throw new ToolError(r.error);
    if (input.prefix != null && input.prefix > 32) throw new ToolError('IPv4 prefixes are 0–32.');
    const prefix = input.prefix ?? r.prefix ?? 24;
    const c = v4calc(r.ip, prefix), t = v4type(r.ip);
    const notes: string[] = [];
    if (r.wildcardGiven) notes.push('Read the second value as a wildcard mask.');
    if (r.prefix === null && input.prefix == null) notes.push('No prefix given, using /24.');
    if (prefix === 31) notes.push('/31 is a point-to-point link: both addresses are usable (RFC 3021).');
    const out: Record<string, unknown> = {
      version: 4,
      address: v4str(r.ip),
      prefix,
      network: v4str(c.network) + '/' + prefix,
      broadcast: prefix >= 31 ? null : v4str(c.broadcast),
      firstHost: v4str(c.first),
      lastHost: v4str(c.last),
      usableHosts: c.usable,
      totalAddresses: c.total,
      subnetMask: v4str(c.mask),
      wildcardMask: v4str(c.wildcard),
      class: v4class(r.ip),
      type: t.label,
      isPublic: t.pub,
      integer: r.ip,
      hex: '0x' + r.ip.toString(16).toUpperCase().padStart(8, '0'),
      binary: { address: bin32(c.ip), mask: bin32(c.mask), network: bin32(c.network), broadcast: bin32(c.broadcast) },
      summary: summaryText(c),
    };
    if (notes.length) out.notes = notes;
    if (input.split != null) {
      const s = splitN(c.network, prefix, input.split);
      if ('error' in s) throw new ToolError(s.error!);
      out.split = {
        prefix: s.prefix, count: s.count, roundedUp: s.rounded, usableEach: s.list[0].usable,
        listed: s.list.length, subnets: s.list.map(v4row),
      };
    }
    if (input.vlsm) {
      const req = parseVlsm(input.vlsm);
      if ('error' in req) throw new ToolError(req.error);
      const v = vlsm(c.network, prefix, req.list);
      if ('error' in v) throw new ToolError(v.error!);
      out.vlsm = { used: v.used, free: v.free, subnets: v.list.map((s) => ({ name: s.name, needed: s.need, ...v4row(s) })) };
    }
    return out;
  },
});

const ipInRange = defineTool({
  name: 'ip_in_range',
  title: 'Is this IP in that range?',
  webSlug: 'subnet-calc',
  description:
    'Check whether an IPv4 or IPv6 address falls inside a range given as CIDR ("10.0.0.0/8", "2001:db8::/32"), a dash ' +
    `range ("192.168.1.10 - 192.168.1.60") or a single address. Web version: ${webUrl('subnet-calc')}`,
  inputSchema: z.object({
    ip: z.string().describe('The address to test.'),
    range: z.string().describe('CIDR, "start - end" range, or single address (same family as "ip").'),
  }),
  outputSchema: z.object({ inside: z.boolean(), rangeStart: z.string(), rangeEnd: z.string() }),
  annotations,
  examples: [{ input: { ip: '192.168.10.77', range: '192.168.10.64/27' }, output: { inside: true, rangeStart: '192.168.10.64', rangeEnd: '192.168.10.95' } }],
  run(input) {
    const r = checkIn(input.ip, input.range);
    if ('error' in r) throw new ToolError(r.error);
    const fmt = (x: number | bigint) => (typeof x === 'bigint' ? v6compress(x) : v4str(x));
    return { inside: r.inside, rangeStart: fmt(r.rg.start), rangeEnd: fmt(r.rg.end) };
  },
});

export default [subnetCalc, ipInRange];

import { describe, expect, it } from 'vitest';
import tools, {
  checkIn, parseV4, parseV4Input, parseV6, parseVlsm, splitN, v4calc, v4str, v4type, v6calc, v6compress, v6expand, v6reverse, v6type, vlsm,
} from '../../../src/tools/web/dev/subnet.js';
import { call } from '../../helpers.js';

const [calc, inRange] = tools;
const ok = <T extends object>(x: T | { error: string } | null) => {
  if (!x || 'error' in x) throw new Error('unexpected error');
  return x as T;
};

describe('subnet-calc self-test', () => {
  it('IPv4', () => {
    const r = ok(parseV4Input('192.168.1.0/26')), c = v4calc(r.ip, r.prefix!);
    expect([c.usable, v4str(c.broadcast), v4str(c.first), v4str(c.last), v4str(c.mask), v4str(c.wildcard)]).toEqual([
      62, '192.168.1.63', '192.168.1.1', '192.168.1.62', '255.255.255.192', '0.0.0.63',
    ]);
    const r2 = ok(parseV4Input('10.0.0.5 255.255.255.0'));
    expect(r2.prefix).toBe(24);
    expect(v4str(v4calc(r2.ip, 24).network)).toBe('10.0.0.0');
    expect(ok(parseV4Input('10.0.0.5 0.0.0.255')).prefix).toBe(24);
    expect(v4calc(parseV4('10.0.0.0')!, 31).usable).toBe(2);
    expect(v4calc(parseV4('10.0.0.9')!, 32).usable).toBe(1);
    expect(v4calc(parseV4('1.2.3.4')!, 0).total).toBe(4294967296);
    expect('error' in parseV4Input('1.1.1.1 255.0.255.0')!).toBe(true);
    expect(parseV4('256.1.1.1')).toBeNull();
    expect(parseV4('01.1.1.1')).toBeNull();
    const s = splitN(parseV4('192.168.1.0')!, 24, 4);
    expect(s.list!.map((x) => v4str(x.network) + '/' + x.prefix).join(',')).toBe('192.168.1.0/26,192.168.1.64/26,192.168.1.128/26,192.168.1.192/26');
    expect(splitN(parseV4('10.0.0.0')!, 8, 3).count).toBe(4);
    const v = vlsm(parseV4('192.168.1.0')!, 24, ok(parseVlsm('2, 50, 10, 20')).list);
    expect(v.list!.map((x) => v4str(x.network) + '/' + x.prefix).join(',')).toBe('192.168.1.0/26,192.168.1.64/27,192.168.1.96/28,192.168.1.112/30');
    expect(!!vlsm(parseV4('10.0.0.0')!, 28, ok(parseVlsm('10, 10')).list).error).toBe(true);
    expect(v4type(parseV4('172.20.1.1')!).label).toBe('Private (RFC 1918)');
    expect(v4type(parseV4('100.64.0.1')!).label).toBe('Shared / carrier-grade NAT (RFC 6598)');
    expect(v4type(parseV4('8.8.8.8')!).pub).toBe(true);
  });
  it('IPv6 and range checks', () => {
    expect(v6expand(parseV6('2001:db8::1')!.n)).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(v6compress(parseV6('2001:0db8:0000:0000:0001:0000:0000:0001')!.n)).toBe('2001:db8::1:0:0:1');
    expect(v6compress(parseV6('2001:db8:0:1:1:1:1:1')!.n)).toBe('2001:db8:0:1:1:1:1:1');
    expect(v6compress(parseV6('::')!.n)).toBe('::');
    expect(v6compress(parseV6('1:0:0:2:0:0:0:3')!.n)).toBe('1:0:0:2::3');
    expect(v6compress(parseV6('::ffff:192.0.2.1')!.n)).toBe('::ffff:c000:201');
    expect(parseV6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseV6('1::2::3')).toBeNull();
    expect(parseV6('2001:db8::g')).toBeNull();
    expect(v6calc(parseV6('2001:db8::')!.n, 48).n64!.toString()).toBe('65536');
    expect(v6expand(v6calc(parseV6('2001:db8:1:2::9')!.n, 64).last)).toBe('2001:0db8:0001:0002:ffff:ffff:ffff:ffff');
    expect(v6type(parseV6('2001:db8::1')!.n)).toBe('Documentation');
    expect(v6type(parseV6('fe80::1')!.n)).toBe('Link-local');
    const inside = (ip: string, r: string) => ok(checkIn(ip, r)).inside;
    expect(inside('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inside('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(inside('192.168.1.50', '192.168.1.10 - 192.168.1.60')).toBe(true);
    expect(inside('2001:db8::5', '2001:db8::/32')).toBe(true);
    expect(inside('2001:db9::5', '2001:db8::/32')).toBe(false);
    expect(v6reverse(parseV6('2001:db8::1')!.n).slice(0, 8)).toBe('1.0.0.0.');
  });
});

describe('subnet tools', () => {
  it('subnet_calc v4 with split and vlsm', async () => {
    const r = await call<Record<string, any>>(calc, { address: '192.168.1.0/24', split: 4, vlsm: 'Sales:50, Ops:20' });
    expect(r).toMatchObject({ version: 4, network: '192.168.1.0/24', broadcast: '192.168.1.255', usableHosts: 254, class: 'C', type: 'Private (RFC 1918)', hex: '0xC0A80100' });
    expect(r.binary.mask).toBe('11111111.11111111.11111111.00000000');
    expect(r.split.subnets.map((s: { network: string }) => s.network)).toEqual(['192.168.1.0/26', '192.168.1.64/26', '192.168.1.128/26', '192.168.1.192/26']);
    expect(r.vlsm.subnets[0]).toMatchObject({ name: 'Sales', needed: 50, network: '192.168.1.0/26' });
    expect(r.vlsm.subnets[1]).toMatchObject({ name: 'Ops', network: '192.168.1.64/27' });
  });
  it('subnet_calc v6', async () => {
    expect(await call(calc, { address: '2001:db8:abcd::42/48' })).toMatchObject({
      version: 6, type: 'Documentation', compressed: '2001:db8:abcd::42', network: '2001:db8:abcd::/48',
      lastAddress: '2001:0db8:abcd:ffff:ffff:ffff:ffff:ffff', subnets64: '65,536 (2^16)',
    });
    await expect(call(calc, { address: '300.1.1.1' })).rejects.toThrow(/Not a valid IPv4/);
  });
  it('ip_in_range', async () => {
    expect(await call(inRange, { ip: '192.168.10.77', range: '192.168.10.64/27' })).toEqual({ inside: true, rangeStart: '192.168.10.64', rangeEnd: '192.168.10.95' });
    await expect(call(inRange, { ip: '::1', range: '10.0.0.0/8' })).rejects.toThrow(/IPv6 address vs an IPv4 range/);
  });
});

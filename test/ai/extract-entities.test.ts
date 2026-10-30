import { describe, expect, it } from 'vitest';
import { call } from '../helpers.js';
import tool, { ibanValid, luhn } from '../../src/tools/ai/extract-entities.js';

type E = { value: string; count: number; index: number; [k: string]: unknown };
type Out = { counts: Record<string, number>; occurrences: Record<string, number>; total: number; entities: Record<string, E[]> };

const run = (text: string, extra: Record<string, unknown> = {}) => call<Out>(tool, { text, ...extra });

describe('ai_extract_entities', () => {
  it('validators', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
    expect(ibanValid('GB82WEST12345698765432')).toBe(true);
    expect(ibanValid('GB82WEST12345698765433')).toBe(false);
  });

  it('emails, urls, hashtags, mentions (deduped with counts)', async () => {
    const r = await run('Write to Omar@Example.com or omar@example.com. See https://s3eidat.github.io/tools/(beta). and www.example.org, #Sale #sale @s3eidat_dev #1');
    expect(r.entities.emails).toEqual([expect.objectContaining({ value: 'Omar@Example.com', count: 2 })]);
    expect(r.entities.urls.map((u) => u.value)).toEqual(['https://s3eidat.github.io/tools/(beta)', 'www.example.org']);
    expect(r.entities.hashtags).toEqual([expect.objectContaining({ value: '#Sale', count: 2 })]);
    expect(r.entities.mentions.map((m) => m.value)).toEqual(['@s3eidat_dev']);
    expect(r.occurrences.emails).toBe(2);
  });

  it('phones with default region JO, also Arabic-Indic digits', async () => {
    const r = await run('Call 079 123 4567, +962 79 123 4567 or ٠٦ ٥٥٥ ١٢٣٤. US office: +1 (202) 555-0143.');
    const nums = r.entities.phones.map((p) => p.value);
    expect(nums).toEqual(['+962791234567', '+96265551234', '+12025550143']);
    expect(r.entities.phones[0]).toMatchObject({ count: 2, country: 'JO', type: 'MOBILE' });
  });

  it('dates: ISO, D/M/Y, ambiguity, month names', async () => {
    const r = await run('Due 2025-03-15, then 25/12/2024, 03/04/2024, 12 March 2024, March 5th, 2024 and in June 2025.');
    const d = Object.fromEntries(r.entities.dates.map((x) => [x.value, x]));
    expect(d['2025-03-15']).toMatchObject({ normalized: '2025-03-15' });
    expect(d['25/12/2024']).toMatchObject({ normalized: '2024-12-25', format: 'D/M/Y' });
    expect(d['03/04/2024']).toMatchObject({ normalized: '2024-04-03', ambiguous: true, alternatives: ['2024-03-04'] });
    expect(d['12 March 2024']).toMatchObject({ normalized: '2024-03-12' });
    expect(d['March 5th, 2024']).toMatchObject({ normalized: '2024-03-05' });
    expect(d['June 2025']).toMatchObject({ normalized: '2025-06', precision: 'month' });
    // US reads month first.
    const us = await run('on 03/04/2024', { defaultRegion: 'US' });
    expect(us.entities.dates[0]).toMatchObject({ normalized: '2024-03-04', alternatives: ['2024-04-03'] });
  });

  it('money and percentages', async () => {
    const r = await run('Price: 25 JOD, $1,299.99, €50, 3.5k USD, 120 د.أ, 500 ريال سعودي, 1.234,56 € and 15% or 7.5٪ off.');
    const m = r.entities.money.map((x) => [x.amount, x.currency]);
    expect(m).toEqual([[25, 'JOD'], [1299.99, 'USD'], [50, 'EUR'], [3500, 'USD'], [120, 'JOD'], [500, 'SAR'], [1234.56, 'EUR']]);
    expect(r.entities.percentages.map((p) => p.number)).toEqual([15, 7.5]);
  });

  it('IPs and IBANs', async () => {
    const r = await run('Server 192.168.1.10 and fe80::1ff:fe23:4567:890a, not 999.1.1.1. IBAN JO94 CBJO 0010 0000 0000 0131 0003 02 then GB82 WEST 1234 5698 7654 32 and GB00WEST12345698765432.');
    expect(r.entities.ipv4.map((x) => x.value)).toEqual(['192.168.1.10']);
    expect(r.entities.ipv6.map((x) => x.value)).toEqual(['fe80::1ff:fe23:4567:890a']);
    const ib = r.entities.ibans.map((x) => [x.value, x.valid]);
    expect(ib).toEqual([['JO94CBJO0010000000000131000302', true], ['GB82WEST12345698765432', true], ['GB00WEST12345698765432', false]]);
  });

  it('cards are Luhn-checked and always masked', async () => {
    const r = await run('Card 4111 1111 1111 1111, bad 4111 1111 1111 1112, amex 3782-822463-10005.');
    expect(r.entities.cards.map((c) => [c.value, c.brand])).toEqual([['************1111', 'Visa'], ['***********0005', 'American Express']]);
    const json = JSON.stringify(r);
    expect(json).not.toContain('4111111111111111');
    expect(json).not.toContain('4111 1111 1111 1111');
    expect(json).not.toContain('378282246310005');
  });

  it('filters by type', async () => {
    const r = await run('a@b.com #tag', { types: ['emails'] });
    expect(Object.keys(r.entities)).toEqual(['emails']);
    expect(r.total).toBe(1);
  });
});

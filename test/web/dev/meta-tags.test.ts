import { describe, expect, it } from 'vitest';
import tool, { absUrl, build, chars, crumb, domain, handle, lint, previews, truncate } from '../../../src/tools/web/dev/meta-tags.js';
import { call } from '../../helpers.js';

const evil = '"><img src=x onerror=alert(1)>';

describe('meta-tags self-test', () => {
  it('escapes and builds', () => {
    const html = build({ title: evil, description: "Tom & Jerry's", url: 's3eidat.github.io/a b', image: '', twitter: 'x.com/s3eidat', type: 'website', card: 'summary' });
    expect(html).not.toContain('<img');
    expect(html).toContain('<meta property="og:title" content="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">');
    expect(html).toContain('<title>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</title>');
    expect(html).toContain('content="Tom &amp; Jerry&#39;s"');
    expect(html).toContain('<meta name="twitter:site" content="@s3eidat">');
    expect(html).not.toContain('og:image');
    expect(html).toContain('<link rel="canonical" href="https://s3eidat.github.io/a%20b">');
  });
  it('helpers, previews and lint', () => {
    const p = previews({ title: evil, description: '<b>bold</b>', url: 'https://www.s3eidat.github.io/tools/meta-tags/' });
    expect(p.google.title).toBe(truncate(evil, 60));
    expect(p.google.description).toBe('<b>bold</b>');
    expect(p.facebook.domain).toBe('S3EIDAT.GITHUB.IO');
    expect(p.google.breadcrumb).toBe('s3eidat.github.io › tools › meta-tags');
    expect(crumb('https://www.s3eidat.github.io/tools/meta-tags/')).toBe('s3eidat.github.io › tools › meta-tags');
    expect([truncate('abcdef', 4), truncate('abc', 4), chars('☕☕')]).toEqual(['abc…', 'abc', 2]);
    expect([handle('s3eidat'), handle('x.com/s3eidat/status/1')]).toEqual(['@s3eidat', '@s3eidat']);
    expect(absUrl('s3eidat.github.io')).toBe('https://s3eidat.github.io');
    expect(domain('https://www.s3eidat.github.io/x')).toBe('s3eidat.github.io');
    const l = lint({ title: 'x'.repeat(61), description: '', url: 'nota url', image: '', twitter: '@this_is_way_too_long_handle' });
    expect([l.title[0], l.description[0], l.twitter[0]]).toEqual(['warn', 'bad', 'bad']);
    expect(lint({ title: 'x'.repeat(45), description: 'y'.repeat(150), url: '', image: '', twitter: '' }).title[0]).toBe('ok');
  });
});

describe('meta_tags_generate tool', () => {
  it('runs', async () => {
    const r = await call<Record<string, any>>(tool, { title: 'Hello', description: 'World', url: 'example.com', image: 'example.com/a.png', imageAlt: 'A' });
    expect(r.html).toContain('<meta property="og:image" content="https://example.com/a.png">');
    expect(r.html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(r.problems).toBe(0);
    expect(r.checks.title).toEqual({ level: 'warn', message: '5 · short' });
    expect(r.previews.x.domain).toBe('example.com');
  });
});

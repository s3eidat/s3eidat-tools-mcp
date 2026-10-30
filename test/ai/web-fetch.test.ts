import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tool, { isPrivateIp, USER_AGENT } from '../../src/tools/ai/web-fetch.js';
import { call, tempCtx } from '../helpers.js';

type R = {
  url: string; finalUrl: string; status: number; title?: string; byline?: string; markdown?: string; words: number;
  source: string; bodyTruncated: boolean; truncated?: boolean; contentType: string;
};

const PARA = 'Sourdough needs a lively starter, patience, and a hot oven; the long cold proof gives the crumb its tang and open holes.';
const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bread at home</title><meta name="author" content="Sam Baker"></head>
<body><header><nav><a href="/">Home</a> | <a href="/shop">Shop</a></nav></header>
<main><article><h1>Bread at home</h1>${Array.from({ length: 6 }, () => `<p>${PARA}</p>`).join('')}
<p>Next: <a href="/rye">rye bread</a>.</p></article></main>
<footer>© Baker site</footer></body></html>`;

let server: Server;
let base = '';
const seenAgents: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seenAgents.push(String(req.headers['user-agent']));
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    switch (req.url) {
      case '/robots.txt': return send(200, 'text/plain', 'User-agent: *\nDisallow: /secret\n\nUser-agent: s3eidat-tools-mcp\nDisallow: /no-bots\n');
      case '/article': return send(200, 'text/html; charset=utf-8', ARTICLE);
      case '/old': return send(301, 'text/plain', '', { location: '/article' });
      case '/notes.txt': return send(200, 'text/plain', 'plain   notes\n\n\n\nline two\n');
      case '/photo.png': return send(200, 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/no-bots': return send(200, 'text/html', '<p>hidden</p>');
      case '/missing': return send(404, 'text/html', 'nope');
      case '/latin1': return send(200, 'text/html; charset=iso-8859-1', Buffer.from('<p>Caf\xe9 cr\xe8me</p>', 'latin1'));
      case '/huge': {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const chunk = 'x'.repeat(1024 * 1024 - 1) + '\n';
        for (let i = 0; i < 7; i++) res.write(chunk);
        return res.end();
      }
      default: return send(404, 'text/plain', 'not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('ai_web_fetch', () => {
  it('fetches the main article as Markdown, following redirects', async () => {
    const r = await call<R>(tool, { url: base + '/old', allowPrivate: true }, tempCtx());
    expect(r.finalUrl).toBe(base + '/article');
    expect(r.status).toBe(200);
    expect(r.title).toBe('Bread at home');
    expect(r.byline).toBe('Sam Baker');
    expect(r.source).toBe('readability');
    expect(r.markdown).toContain(PARA);
    expect(r.markdown).toContain(`[rye bread](${base}/rye)`);
    expect(r.markdown).not.toContain('Shop');
    expect(r.markdown).not.toContain('Baker site');
    expect(r.words).toBe(6 * 22 + 3);
    expect(seenAgents).toContain(USER_AGENT);
  });

  it('supports selector, whole body, plain text and declared charsets', async () => {
    const ctx = tempCtx();
    const sel = await call<R>(tool, { url: base + '/article', selector: 'footer', allowPrivate: true }, ctx);
    expect(sel.markdown).toBe('© Baker site\n');
    const whole = await call<R>(tool, { url: base + '/article', readable: false, includeLinks: false, allowPrivate: true }, ctx);
    expect(whole.source).toBe('body');
    expect(whole.markdown).toContain('Home | Shop');
    expect(whole.markdown).not.toContain('](');
    const txt = await call<R>(tool, { url: base + '/notes.txt', allowPrivate: true }, ctx);
    expect(txt.source).toBe('text');
    expect(txt.markdown).toBe('plain   notes\n\nline two\n');
    const latin = await call<R>(tool, { url: base + '/latin1', allowPrivate: true }, ctx);
    expect(latin.markdown).toBe('Café crème\n');
  });

  it('obeys robots.txt and refuses non-HTML, errors and non-http URLs', async () => {
    const ctx = tempCtx();
    await expect(call(tool, { url: base + '/no-bots', allowPrivate: true }, ctx)).rejects.toThrow(/robots\.txt/);
    // Our own robots group replaces the "*" group, so /secret is not blocked for us (and is a 404 here).
    await expect(call(tool, { url: base + '/secret/x', allowPrivate: true }, ctx)).rejects.toThrow(/404/);
    await expect(call(tool, { url: base + '/photo.png', allowPrivate: true }, ctx)).rejects.toThrow(/image\/png/);
    await expect(call(tool, { url: base + '/missing', allowPrivate: true }, ctx)).rejects.toThrow(/404/);
    await expect(call(tool, { url: 'file:///etc/passwd' }, ctx)).rejects.toThrow(/Only http and https/);
    await expect(call(tool, { url: 'not a url' }, ctx)).rejects.toThrow(/Not a valid URL/);
  });

  it('blocks private and loopback hosts unless allowed', async () => {
    const ctx = tempCtx();
    await expect(call(tool, { url: base + '/article' }, ctx)).rejects.toThrow(/private or local/);
    await expect(call(tool, { url: 'http://localhost:1/' }, ctx)).rejects.toThrow(/local address/);
    await expect(call(tool, { url: 'http://[::1]:1/' }, ctx)).rejects.toThrow(/private or local/);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('stops reading at 5 MB', async () => {
    const r = await call<R>(tool, { url: base + '/huge', allowPrivate: true, maxChars: 1000 }, tempCtx());
    expect(r.bodyTruncated).toBe(true);
    expect(r.truncated).toBe(true);
    expect((r as unknown as { characters: number }).characters).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});

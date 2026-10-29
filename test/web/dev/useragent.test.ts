import { describe, expect, it } from 'vitest';
import tool, { major, parseUA } from '../../../src/tools/web/dev/useragent.js';
import { call } from '../../helpers.js';

// Sample strings copied from the website's app.js by script.
const SAMPLES = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68",
  "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager",
  "Mozilla/5.0 (compatible; Googlebot/2.1)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; claudebot@anthropic.com)",
  "curl/8.7.1",
  "python-requests/2.32.3",
  "Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  "Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15"
];

const pick = (r: ReturnType<typeof parseUA>) => [r.type, r.browser, major(r.browserVersion), r.engine, r.os, r.osVersion];

describe('ua-parser self-test', () => {
  it('matches the website', () => {
    expect(pick(parseUA(SAMPLES[0]))).toEqual(['desktop', 'Chrome', '130', 'Blink', 'Windows', '10 or 11']);
    expect(pick(parseUA(SAMPLES[1]))).toEqual(['mobile', 'Mobile Safari', '17', 'WebKit', 'iOS', '17.4']);
    const s = parseUA(SAMPLES[2]);
    expect(pick(s)).toEqual(['mobile', 'Samsung Internet', '25', 'Blink', 'Android', '14']);
    expect([s.vendor, s.model]).toEqual(['Samsung', 'SM-S918B']);
    expect(pick(parseUA(SAMPLES[3]))).toEqual(['desktop', 'Safari', '17', 'WebKit', 'macOS', '10.15.7']);
    expect(pick(parseUA(SAMPLES[4]))).toEqual(['desktop', 'Firefox', '131', 'Gecko', 'Ubuntu', '']);
    expect(pick(parseUA(SAMPLES[5])).slice(0, 4)).toEqual(['desktop', 'Edge', '130', 'Blink']);
    expect(pick(parseUA(SAMPLES[6]))).toEqual(['tablet', 'Chrome', '129', 'WebKit', 'iPadOS', '16.6']);
    expect([parseUA(SAMPLES[7]).vendor, parseUA(SAMPLES[7]).type]).toEqual(['Google', 'mobile']);
    expect(parseUA(SAMPLES[8]).type).toBe('tablet');
    expect([parseUA(SAMPLES[9]).type, parseUA(SAMPLES[9]).os]).toEqual(['tv', 'webOS']);
    expect([parseUA(SAMPLES[10]).type, parseUA(SAMPLES[10]).bot]).toEqual(['bot', 'Googlebot']);
    expect(parseUA(SAMPLES[11]).bot).toBe('ClaudeBot (Anthropic)');
    const curl = parseUA('curl/8.7.1');
    expect([curl.type, curl.browser, curl.browserVersion]).toEqual(['client', 'curl', '8.7.1']);
    expect(parseUA('python-requests/2.32.3').client).toBe('Python requests');
    expect(pick(parseUA(SAMPLES[14]))).toEqual(['desktop', 'Internet Explorer', '11', 'Trident', 'Windows', '7']);
    expect(parseUA(SAMPLES[15]).browser).toBe('Opera');
    expect(parseUA(SAMPLES[16]).type).toBe('console');
    expect(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15').engine).toBe('WebKit');
    expect(parseUA('Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36').browser).toBe('Android WebView');
    expect(parseUA('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36').model).toBe('(hidden by reduced UA)');
    expect(parseUA('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36').type).toBe('bot');
    expect(parseUA('SomeCrawler/1.0 (+contact)').type).toBe('bot');
    expect(parseUA('').type).toBe('unknown');
  });
});

describe('useragent_parse tool', () => {
  it('parses one, many and an access log', async () => {
    const one = await call<Record<string, any>>(tool, { userAgent: SAMPLES[1] });
    expect(one.results[0].summary).toEqual({ browser: 'Mobile Safari 17.4', engine: 'WebKit 605.1.15', os: 'iOS 17.4', device: 'Apple iPhone' });
    const many = await call<Record<string, any>>(tool, { userAgents: SAMPLES });
    expect(many.count).toBe(SAMPLES.length);
    expect(many.byType.bot).toBe(2);
    const log = '1.2.3.4 - - [26/Oct/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 512 "-" "curl/8.7.1"\n5.6.7.8 - - [x] "GET /a HTTP/1.1" 404 0 "-" "' + SAMPLES[10] + '"\n';
    const r = await call<Record<string, any>>(tool, { file: 'base64:' + Buffer.from(log).toString('base64'), accessLog: true });
    expect(r.results.map((x: { type: string }) => x.type)).toEqual(['client', 'bot']);
  });
});

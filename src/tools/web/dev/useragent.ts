import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { readInput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/ua-parser (app.js): the same ordered regex rules for bots, HTTP clients,
// browsers, engines, operating systems, device types and Android vendors. Tables and parseUA() are copied from the
// website by script (only `var` → typed `const`/`let`), so results match it exactly.
export interface UAResult {
  ua: string;
  browser: string;
  browserVersion: string;
  engine: string;
  engineVersion: string;
  os: string;
  osVersion: string;
  type: string;
  vendor: string;
  model: string;
  bot: string;
  client: string;
}

const BOTS: [RegExp, string][] = [
  [/Googlebot-Image/i, "Googlebot Image"], [/Googlebot-Video/i, "Googlebot Video"], [/Googlebot/i, "Googlebot"], [/Google-InspectionTool/i, "Google Inspection Tool"],
  [/AdsBot-Google/i, "Google AdsBot"], [/Mediapartners-Google/i, "Google AdSense"], [/Storebot-Google/i, "Google StoreBot"], [/Google-Extended/i, "Google-Extended"],
  [/bingbot/i, "Bingbot"], [/BingPreview/i, "Bing Preview"], [/msnbot/i, "MSNBot"], [/DuckDuckBot/i, "DuckDuckBot"], [/Baiduspider/i, "Baiduspider"],
  [/YandexBot|YandexMobileBot|YandexImages/i, "YandexBot"], [/Applebot/i, "Applebot"], [/facebookexternalhit|facebookcatalog|meta-externalagent/i, "Facebook crawler"],
  [/Twitterbot/i, "Twitterbot"], [/LinkedInBot/i, "LinkedInBot"], [/Slackbot/i, "Slackbot"], [/Discordbot/i, "Discordbot"], [/TelegramBot/i, "TelegramBot"],
  [/WhatsApp/i, "WhatsApp link preview"], [/Pinterest(bot)?/i, "Pinterestbot"], [/redditbot/i, "Redditbot"], [/AhrefsBot/i, "AhrefsBot"], [/SemrushBot/i, "SemrushBot"],
  [/MJ12bot/i, "MJ12bot"], [/DotBot/i, "DotBot"], [/PetalBot/i, "PetalBot"], [/GPTBot/i, "GPTBot (OpenAI)"], [/ChatGPT-User/i, "ChatGPT-User (OpenAI)"],
  [/OAI-SearchBot/i, "OAI-SearchBot (OpenAI)"], [/ClaudeBot/i, "ClaudeBot (Anthropic)"], [/Claude-User/i, "Claude-User (Anthropic)"], [/Claude-SearchBot/i, "Claude-SearchBot (Anthropic)"],
  [/anthropic-ai/i, "anthropic-ai"], [/PerplexityBot/i, "PerplexityBot"], [/Perplexity-User/i, "Perplexity-User"], [/CCBot/i, "Common Crawl (CCBot)"], [/Bytespider/i, "Bytespider (ByteDance)"],
  [/Amazonbot/i, "Amazonbot"], [/archive\.org_bot|ia_archiver/i, "Internet Archive"], [/UptimeRobot/i, "UptimeRobot"], [/Pingdom/i, "Pingdom"],
  [/Chrome-Lighthouse|Lighthouse/i, "Lighthouse"], [/HeadlessChrome/i, "Headless Chrome (automation)"], [/PhantomJS/i, "PhantomJS"], [/Seznam/i, "SeznamBot"],
  [/Qwantify|Qwantbot/i, "Qwantbot"], [/Sogou/i, "Sogou spider"], [/Exabot/i, "Exabot"], [/coccoc/i, "Coc Coc bot"]
];
const GENERIC_BOT = /bot\b|crawler|spider|crawl|slurp|scraper|fetcher|preview|monitor|validator|checker/i;
const CLIENTS: [RegExp, string][] = [
  [/^curl\/([\d.]+)/i, "curl"], [/^Wget\/([\d.]+)/i, "Wget"], [/python-requests\/([\d.]+)/i, "Python requests"], [/Python-urllib\/([\d.]+)/i, "Python urllib"],
  [/python-httpx\/([\d.]+)/i, "Python httpx"], [/aiohttp\/([\d.]+)/i, "Python aiohttp"], [/Scrapy\/([\d.]+)/i, "Scrapy"], [/okhttp\/([\d.]+)/i, "OkHttp"],
  [/Go-http-client\/([\d.]+)/i, "Go net/http"], [/axios\/([\d.]+)/i, "axios"], [/node-fetch\/?([\d.]*)/i, "node-fetch"], [/undici/i, "Node.js (undici / fetch)"],
  [/PostmanRuntime\/([\d.]+)/i, "Postman"], [/insomnia\/([\d.]+)/i, "Insomnia"], [/HTTPie\/([\d.]+)/i, "HTTPie"], [/Java-http-client\/([\d.]+)/i, "Java HttpClient"],
  [/^Java\/([\d._]+)/i, "Java"], [/Apache-HttpClient\/([\d.]+)/i, "Apache HttpClient"], [/libwww-perl\/([\d.]+)/i, "Perl LWP"], [/Dart\/([\d.]+)/i, "Dart"],
  [/^Deno\/([\d.]+)/i, "Deno"], [/^Bun\/([\d.]+)/i, "Bun"], [/WindowsPowerShell\/([\d.]+)/i, "PowerShell"], [/PowerShell\/([\d.]+)/i, "PowerShell"],
  [/GuzzleHttp\/([\d.]+)/i, "Guzzle (PHP)"], [/Faraday v?([\d.]+)/i, "Faraday (Ruby)"], [/^Ruby/i, "Ruby"], [/RestSharp\/([\d.]+)/i, "RestSharp"],
  [/^Dalvik\/([\d.]+)/i, "Android Dalvik HTTP"], [/CFNetwork\/([\d.]+)/i, "Apple CFNetwork"], [/^Mozilla\/[\d.]+$/i, "Bare Mozilla string"]
];
const BROWSERS: [RegExp, string][] = [
  [/Opera Mini\/([\d.]+)/, "Opera Mini"], [/OPiOS\/([\d.]+)/, "Opera"], [/OPR\/([\d.]+)/, "Opera"], [/Opera.*Version\/([\d.]+)/, "Opera"], [/Opera[\/ ]([\d.]+)/, "Opera"],
  [/EdgiOS\/([\d.]+)/, "Edge"], [/EdgA\/([\d.]+)/, "Edge"], [/Edg\/([\d.]+)/, "Edge"], [/Edge\/([\d.]+)/, "Edge (legacy)"],
  [/SamsungBrowser\/([\d.]+)/, "Samsung Internet"], [/YaBrowser\/([\d.]+)/, "Yandex Browser"], [/Vivaldi\/([\d.]+)/, "Vivaldi"],
  [/UCBrowser\/([\d.]+)/, "UC Browser"], [/(?:DuckDuckGo|Ddg)\/([\d.]+)/, "DuckDuckGo"], [/FBAV\/([\d.]+)/, "Facebook in-app"],
  [/Instagram ([\d.]+)/, "Instagram in-app"], [/ Line\/([\d.]+)/, "LINE in-app"], [/Snapchat\/([\d.]+)/, "Snapchat in-app"], [/MiuiBrowser\/([\d.]+)/, "MIUI Browser"],
  [/HuaweiBrowser\/([\d.]+)/, "Huawei Browser"], [/Whale\/([\d.]+)/, "Naver Whale"], [/Electron\/([\d.]+)/, "Electron"], [/FxiOS\/([\d.]+)/, "Firefox"],
  [/Firefox\/([\d.]+)/, "Firefox"], [/CriOS\/([\d.]+)/, "Chrome"], [/Silk\/([\d.]+)/, "Amazon Silk"],
  [/; wv\).*Chrome\/([\d.]+)/, "Android WebView"], [/HeadlessChrome\/([\d.]+)/, "Headless Chrome"], [/Chromium\/([\d.]+)/, "Chromium"],
  [/Chrome\/([\d.]+)/, "Chrome"], [/Version\/([\d.]+).*Mobile.*Safari/, "Mobile Safari"], [/Version\/([\d.]+).*Safari/, "Safari"],
  [/(?:iPhone|iPad|iPod).*AppleWebKit(?!.*Safari)/, "iOS WebView"], [/MSIE ([\d.]+)/, "Internet Explorer"], [/Trident\/.*rv:([\d.]+)/, "Internet Explorer"]
];
const WIN: Record<string, string> = { "10.0": "10 or 11", "6.3": "8.1", "6.2": "8", "6.1": "7", "6.0": "Vista", "5.2": "XP x64", "5.1": "XP", "5.0": "2000" };

function first(list: [RegExp, string][], ua: string) {
  for (let i = 0; i < list.length; i++) {
    const m = list[i][0].exec(ua);
    if (m) return { name: list[i][1], version: m[1] || '' };
  }
  return null;
}
export function major(v: string) {
  return (v || '').split('.')[0];
}

export function parseUA(ua: string): UAResult {
  ua = (ua || "").trim();
  const r: UAResult = { ua: ua, browser: "", browserVersion: "", engine: "", engineVersion: "", os: "", osVersion: "", type: "desktop", vendor: "", model: "", bot: "", client: "" };
  if (!ua) { r.type = "unknown"; return r; }
  let bot: { name: string; version?: string } | null = first(BOTS, ua);
  if (!bot && GENERIC_BOT.test(ua) && !/Mobile Safari|Chrome\/[\d.]+ (Mobile )?Safari\/[\d.]+$/.test(ua)) bot = { name: "Unknown bot" };
  const client = bot ? null : first(CLIENTS, ua);
  if (bot) { r.type = "bot"; r.bot = bot.name; }
  else if (client) { r.type = "client"; r.client = client.name; r.browser = client.name; r.browserVersion = client.version; }
  // browser
  if (!client) {
    const b = first(BROWSERS, ua);
    if (b) { r.browser = b.name; r.browserVersion = b.version; }
  }
  // engine
  let m: RegExpExecArray | null;
  if (/Edge\/[\d.]+/.test(ua) && !/Edg\//.test(ua)) { r.engine = "EdgeHTML"; r.engineVersion = (/Edge\/([\d.]+)/.exec(ua) || [])[1] || ""; }
  else if ((m = /Trident\/([\d.]+)/.exec(ua))) { r.engine = "Trident"; r.engineVersion = m[1]; }
  else if ((m = /Presto\/([\d.]+)/.exec(ua))) { r.engine = "Presto"; r.engineVersion = m[1]; }
  else if (/iPhone|iPad|iPod/.test(ua) && (m = /AppleWebKit\/([\d.]+)/.exec(ua))) { r.engine = "WebKit"; r.engineVersion = m[1]; }
  else if ((m = /Chrome\/([\d.]+)/.exec(ua)) && /AppleWebKit/.test(ua)) { r.engine = "Blink"; r.engineVersion = m[1]; }
  else if ((m = /AppleWebKit\/([\d.]+)/.exec(ua))) { r.engine = "WebKit"; r.engineVersion = m[1]; }
  else if ((m = /rv:([\d.]+)\) Gecko/.exec(ua))) { r.engine = "Gecko"; r.engineVersion = m[1]; }
  // operating system
  if ((m = /Windows Phone(?: OS)? ([\d.]+)/.exec(ua))) { r.os = "Windows Phone"; r.osVersion = m[1]; }
  else if (/Xbox/.test(ua)) r.os = "Xbox";
  else if ((m = /Windows NT ([\d.]+)/.exec(ua))) { r.os = "Windows"; r.osVersion = WIN[m[1]] || "NT " + m[1]; }
  else if (/Windows/.test(ua)) r.os = "Windows";
  else if ((m = /(?:iPhone|iPod|iPad).*? OS (\d+(?:_\d+)*)/.exec(ua))) { r.os = /iPad/.test(ua) ? "iPadOS" : "iOS"; r.osVersion = m[1].replace(/_/g, "."); }
  else if (/iPhone|iPad|iPod/.test(ua)) r.os = /iPad/.test(ua) ? "iPadOS" : "iOS";
  else if ((m = /HarmonyOS[ \/]?([\d.]*)/.exec(ua))) { r.os = "HarmonyOS"; r.osVersion = m[1]; }
  else if ((m = /Android[ \/]?([\d.]*)/.exec(ua))) { r.os = "Android"; r.osVersion = m[1]; }
  else if ((m = /CrOS \S+ ([\d.]+)/.exec(ua))) { r.os = "ChromeOS"; r.osVersion = m[1]; }
  else if ((m = /Mac OS X (\d+(?:[_.]\d+)*)/.exec(ua))) { r.os = "macOS"; r.osVersion = m[1].replace(/_/g, "."); }
  else if (/Macintosh|Mac OS/.test(ua)) r.os = "macOS";
  else if ((m = /KAIOS\/([\d.]+)/i.exec(ua))) { r.os = "KaiOS"; r.osVersion = m[1]; }
  else if ((m = /Tizen[ \/]?([\d.]*)/.exec(ua))) { r.os = "Tizen"; r.osVersion = m[1]; }
  else if (/Web0S|webOS/.test(ua)) r.os = "webOS";
  else if ((m = /PlayStation (?:\d+ )?(\w+)?/i.exec(ua))) r.os = "PlayStation";
  else if (/Nintendo/.test(ua)) r.os = "Nintendo";
  else if (/FreeBSD/.test(ua)) r.os = "FreeBSD";
  else if (/OpenBSD/.test(ua)) r.os = "OpenBSD";
  else if (/Ubuntu/.test(ua)) r.os = "Ubuntu";
  else if (/Fedora/.test(ua)) r.os = "Fedora";
  else if (/Linux|X11/.test(ua)) r.os = "Linux";
  // device type (bots and HTTP clients keep their type)
  if (!bot && !client) {
    if (/SmartTV|SMART-TV|Smart-TV|HbbTV|AppleTV|GoogleTV|Android TV|AndroidTV|AFT[A-Z]|BRAVIA|Roku|CrKey|NetCast|Viera|AQUOS|Web0S|webOS.*TV|Tizen.*TV|DTV|\bTV\b/i.test(ua)) r.type = "tv";
    else if (/PlayStation|Xbox|Nintendo/i.test(ua)) r.type = "console";
    else if (/iPad|Tablet|Kindle|Silk|PlayBook|KF[A-Z]{2,4}\b/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) r.type = "tablet";
    else if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|BB10|Opera Mini|KaiOS|IEMobile/i.test(ua)) r.type = "mobile";
    else r.type = "desktop";
  }
  // vendor and model
  if ((m = /\((iPhone|iPad|iPod)/.exec(ua))) { r.vendor = "Apple"; r.model = m[1]; }
  else if (/Macintosh/.test(ua)) { r.vendor = "Apple"; r.model = "Mac"; }
  else if ((m = /Android[ \/]?[\d.]*;(?: [a-z]{2}[-_][a-zA-Z]{2};)?(?: U;)? ([^;)]+?)(?: Build\/[^;)]*)?(?:;|\))/.exec(ua))) {
    const model = m[1].trim();
    if (/^(wv|K|Linux|Mobile|Tablet)$/i.test(model)) r.model = model === "K" ? "(hidden by reduced UA)" : "";
    else r.model = model.replace(/^SAMSUNG /i, "");
    const V: [RegExp, string][] = [[/^(SM-|SAMSUNG|Galaxy|GT-|SCH-|SGH-)/i, "Samsung"], [/^Pixel|^Nexus/i, "Google"], [/^(Redmi|Mi |MI |M2\d|POCO|Xiaomi|2\d{3}[A-Z0-9]{4,})/i, "Xiaomi"],
      [/^(CPH|OPPO|PB|PC|PD|PE)/i, "OPPO"], [/^RMX/i, "realme"], [/^(vivo|V2\d)/i, "vivo"], [/^(moto|XT\d)/i, "Motorola"], [/^(ONEPLUS|IN20|KB20|LE2|NE2)/i, "OnePlus"],
      [/^(HUAWEI|ELE-|VOG-|ANA-|LYA-|MAR-|JNY-|NOH-)/i, "Huawei"], [/^(Nokia|TA-)/i, "Nokia"], [/^(LG-|LM-)/i, "LG"], [/^(SO-|Xperia|G8|XQ-)/i, "Sony"],
      [/^KF[A-Z]/, "Amazon"], [/^(Infinix)/i, "Infinix"], [/^(TECNO)/i, "Tecno"], [/^(itel)/i, "itel"], [/^(HONOR|HNY|LGE-)/i, "Honor"], [/^(ASUS|ZS\d|AI\d)/i, "ASUS"]];
    for (let i = 0; i < V.length; i++) if (V[i][0].test(r.model)) { r.vendor = V[i][1]; break; }
  }
  return r;
}
export function describe(r: UAResult) {
  return {
    browser: r.bot ? r.bot : (r.browser ? r.browser + (r.browserVersion ? " " + r.browserVersion : "") : "Unknown"),
    engine: r.engine ? r.engine + (r.engineVersion ? " " + r.engineVersion : "") : "—",
    os: r.os ? r.os + (r.osVersion ? " " + r.osVersion : "") : "—",
    device: [r.vendor, r.model].filter(Boolean).join(" ") || "—"
  };
}

export const TYPE_LABEL: Record<string, string> = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', tv: 'TV', console: 'Console', bot: 'Bot', client: 'HTTP client', unknown: 'Unknown' };

/** Pull user agents out of text: one per line, or the last quoted field of access-log lines (combined log format). */
export function extractAgents(text: string, fromLog: boolean) {
  const lines = text.split(/\r?\n/);
  const picked = fromLog
    ? lines.map((l) => {
        const m = /"([^"]*)"\s*$/.exec(l);
        return m ? m[1] : l;
      }).filter((l) => l.trim() && l !== '-')
    : lines;
  return picked.map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

const MAX_AGENTS = 5000;

export default defineTool({
  name: 'useragent_parse',
  title: 'User agent parse',
  webSlug: 'ua-parser',
  description:
    'Parse browser user-agent strings into browser + version, engine (Blink, WebKit, Gecko, Trident, EdgeHTML, Presto), OS + ' +
    'version, device type (desktop, mobile, tablet, TV, console, bot, HTTP client), vendor and model. Recognises ~50 ' +
    'crawlers and AI bots (Googlebot, Bingbot, GPTBot, ClaudeBot, PerplexityBot…) and HTTP clients (curl, python-requests, ' +
    'Go, okhttp, Postman…). Give one "userAgent", a list, or a text/log file (one per line, or the last quoted field of ' +
    `each access-log line); up to ${MAX_AGENTS} per call, with a count by type. Web version: ${webUrl('ua-parser')}`,
  inputSchema: z.object({
    userAgent: z.string().optional().describe('One user-agent string.'),
    userAgents: z.array(z.string()).max(MAX_AGENTS).optional().describe('Several user-agent strings.'),
    file: z.string().optional().describe('Or: a text file (path or base64) with one user agent per line, or an access log.'),
    accessLog: z.boolean().optional().default(false).describe('Read "file" as an access log: take the last quoted field of each line.'),
  }),
  outputSchema: z.object({
    count: z.number(),
    byType: z.record(z.string(), z.number()),
    results: z.array(
      z.object({
        ua: z.string(), type: z.string(), typeLabel: z.string(), browser: z.string(), browserVersion: z.string(), engine: z.string(),
        engineVersion: z.string(), os: z.string(), osVersion: z.string(), vendor: z.string(), model: z.string(), bot: z.string(),
        client: z.string(), summary: z.object({ browser: z.string(), engine: z.string(), os: z.string(), device: z.string() }),
      }),
    ),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
      note: 'Mobile Safari 17.4, WebKit, iOS 17.4, mobile, Apple iPhone',
    },
  ],
  async run(input, ctx) {
    let agents: string[] = [];
    if (input.userAgent != null) agents.push(input.userAgent.trim());
    if (input.userAgents) agents.push(...input.userAgents.map((s) => s.trim()));
    if (input.file) agents.push(...extractAgents((await readInput(input.file, ctx, 'file')).bytes.toString('utf8'), input.accessLog));
    if (!agents.length) throw new ToolError('Give "userAgent", "userAgents" or a "file".');
    if (agents.length > MAX_AGENTS) agents = agents.slice(0, MAX_AGENTS);
    const results = agents.map((ua) => {
      const r = parseUA(ua);
      return { ...r, typeLabel: TYPE_LABEL[r.type], summary: describe(r) };
    });
    const byType: Record<string, number> = {};
    for (const r of results) byType[r.type] = (byType[r.type] || 0) + 1;
    return { count: results.length, byType, results };
  },
});

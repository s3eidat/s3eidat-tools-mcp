import { z } from 'zod';
import { defineTool, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/http-status (app.js): the same reference text and search. The data rows below
// are copied verbatim from the website by script.
type Row = [number, string, string, string, string, string, boolean?];
// [code, name, what it means, when to use it, common causes, spec, nonStandard?]
const ROWS: Row[] = [
    [100, "Continue", "The server got the request headers and the client should go ahead and send the body.", "Reply to a request that sent `Expect: 100-continue` when you are willing to accept the body.", "A client (curl, many HTTP libraries) asking permission before uploading a large body.", "RFC 9110"],
    [101, "Switching Protocols", "The server agrees to switch to the protocol the client asked for in the Upgrade header.", "Accepting a websocket handshake or another protocol upgrade.", "Websocket connections; an `Upgrade:` request header.", "RFC 9110"],
    [102, "Processing", "The server has accepted the request and is still working on it, so the client should not time out.", "Long WebDAV operations. Rarely used today and deprecated in practice.", "WebDAV servers handling slow, multi-step requests.", "RFC 2518"],
    [103, "Early Hints", "A preview response with headers (usually Link preload hints) sent before the final response.", "Letting the browser start loading CSS, fonts or scripts while the server is still building the page.", "CDNs and servers sending `Link: <…>; rel=preload` early.", "RFC 8297"],

    [200, "OK", "The request worked. The body holds the result.", "The default success answer for GET, and for POST/PUT when you return the result.", "Everything went fine.", "RFC 9110"],
    [201, "Created", "The request worked and a new resource was created.", "After a POST (or PUT) that creates something. Send a Location header pointing to it.", "A new user, order, file or record was made.", "RFC 9110"],
    [202, "Accepted", "The request was accepted for processing, but the work is not finished yet.", "Queued or background jobs. Give the client a way to check progress.", "Async jobs, batch imports, email sending queues.", "RFC 9110"],
    [203, "Non-Authoritative Information", "Success, but a proxy changed the response from what the origin server sent.", "A transforming proxy that modified the payload.", "Proxies that rewrite or compress content.", "RFC 9110"],
    [204, "No Content", "The request worked and there is nothing to send back. There is no body.", "Successful DELETE, or a PUT/PATCH where you don't return the resource.", "Deleting something, saving settings, CORS preflight replies.", "RFC 9110"],
    [205, "Reset Content", "Success; the client should reset the form or view that sent the request.", "Telling a client to clear a form after submission. Rare.", "Form submissions in some apps.", "RFC 9110"],
    [206, "Partial Content", "The server is sending only the part of the file that was asked for with a Range header.", "Answering range requests: resuming downloads, video seeking.", "Video/audio players, download managers, resumable downloads.", "RFC 9110"],
    [207, "Multi-Status", "The body holds separate status codes for several resources.", "WebDAV operations that affect many items at once.", "WebDAV PROPFIND, bulk operations.", "RFC 4918"],
    [208, "Already Reported", "Members of this collection were already listed earlier in the same response.", "Inside a WebDAV 207 response, to avoid listing the same item twice.", "WebDAV bindings that make a resource appear in several places.", "RFC 5842"],
    [226, "IM Used", "The response is the result of instance manipulations (such as a delta) applied to the resource.", "Delta encoding: sending only what changed since the client's version.", "Servers supporting `A-IM` delta encoding. Very rare.", "RFC 3229"],

    [300, "Multiple Choices", "There are several versions of the resource and the client should pick one.", "Offering several formats or languages without picking for the client. Rare.", "Content negotiation that cannot choose a single best match.", "RFC 9110"],
    [301, "Moved Permanently", "The resource has a new permanent URL, given in the Location header.", "Permanent redirects: old URLs, http→https, domain changes. Search engines move ranking to the new URL.", "Site migrations, changed slugs, missing/extra trailing slash.", "RFC 9110"],
    [302, "Found", "The resource is temporarily at another URL. Browsers usually switch to GET for the next request.", "Temporary redirects, like after login. Prefer 303 or 307 when the method matters.", "Login flows, A/B tests, maintenance redirects.", "RFC 9110"],
    [303, "See Other", "Go and GET the result at another URL.", "After a form POST, so refreshing the page doesn't resubmit it (Post/Redirect/Get).", "Form submissions, payment returns.", "RFC 9110"],
    [304, "Not Modified", "The cached copy the client has is still good, so no body is sent.", "Answering conditional requests (If-None-Match / If-Modified-Since) when nothing changed.", "Browser caching with ETag or Last-Modified. Normal, not an error.", "RFC 9110"],
    [305, "Use Proxy", "Deprecated. Meant that the resource must be accessed through a proxy.", "Don't use it; browsers ignore it for security reasons.", "Very old servers.", "RFC 9110"],
    [307, "Temporary Redirect", "Temporarily at another URL, and the client must repeat the same method and body.", "Temporary redirect where a POST must stay a POST. Also what browsers show for HSTS upgrades.", "HSTS internal redirects, maintenance, load balancing.", "RFC 9110"],
    [308, "Permanent Redirect", "Moved permanently, and the client must repeat the same method and body.", "Permanent redirect for APIs where POST/PUT must not turn into GET.", "API endpoint moves, http→https on APIs.", "RFC 9110"],

    [400, "Bad Request", "The server can't understand the request because something about it is malformed.", "Invalid JSON, missing required fields, bad query parameters.", "Broken JSON, wrong Content-Type, oversized or corrupt cookies, bad URL encoding.", "RFC 9110"],
    [401, "Unauthorized", "You need to log in (authenticate). Despite the name, it means “unauthenticated”.", "No credentials, or credentials that are invalid or expired. Send a WWW-Authenticate header.", "Missing or expired token, wrong API key, logged-out session.", "RFC 9110"],
    [402, "Payment Required", "Reserved for future use. Some APIs use it when a payment or plan upgrade is needed.", "Paywalled or quota-exhausted APIs (non-standard use, but common).", "Unpaid subscription, used-up credits.", "RFC 9110"],
    [403, "Forbidden", "The server knows who you are but you are not allowed to do this.", "Logged-in user without permission, or access blocked by policy.", "Wrong role, IP blocks, WAF rules, file permissions on the server, directory listing disabled.", "RFC 9110"],
    [404, "Not Found", "There is nothing at this URL.", "The resource doesn't exist, or you don't want to reveal that it does.", "Typos in the URL, deleted pages, broken links, wrong route or base path.", "RFC 9110"],
    [405, "Method Not Allowed", "The URL exists but doesn't support this HTTP method. The Allow header lists the ones it does.", "A POST to a read-only endpoint, a DELETE where it isn't supported.", "Calling an API with the wrong verb, forms posting to static files.", "RFC 9110"],
    [406, "Not Acceptable", "The server can't produce a response in any format the client said it accepts.", "Strict content negotiation when the Accept header can't be satisfied.", "An Accept header asking only for a format the API doesn't offer.", "RFC 9110"],
    [407, "Proxy Authentication Required", "Like 401, but you must log in to the proxy in between.", "Sent by proxies that need credentials.", "Corporate proxies, missing proxy credentials.", "RFC 9110"],
    [408, "Request Timeout", "The server gave up waiting for the client to finish sending the request.", "Idle connections where the client didn't send the full request in time.", "Slow or dropped client connections, stalled uploads.", "RFC 9110"],
    [409, "Conflict", "The request conflicts with the current state of the resource.", "Edit conflicts, duplicates (e.g. username already taken), version mismatches.", "Two people editing at once, unique-constraint violations.", "RFC 9110"],
    [410, "Gone", "The resource used to exist and was removed on purpose, permanently.", "Content intentionally deleted. Search engines drop it faster than a 404.", "Retired pages, deleted accounts, sunset API versions.", "RFC 9110"],
    [411, "Length Required", "The server needs a Content-Length header and didn't get one.", "Servers that refuse chunked uploads.", "Clients streaming a body without Content-Length.", "RFC 9110"],
    [412, "Precondition Failed", "A condition in the request headers (If-Match, If-Unmodified-Since) was false.", "Optimistic locking: the resource changed since the client last read it.", "Stale ETag on an update.", "RFC 9110"],
    [413, "Content Too Large", "The request body is bigger than the server will accept. (Formerly “Payload Too Large”.)", "Uploads over your size limit.", "Big file uploads hitting `client_max_body_size` or similar limits.", "RFC 9110"],
    [414, "URI Too Long", "The URL is longer than the server is willing to read.", "Rejecting absurdly long URLs.", "Huge query strings, data sent with GET that should be POST, redirect loops that keep adding parameters.", "RFC 9110"],
    [415, "Unsupported Media Type", "The server doesn't support the body's format.", "Body sent with a Content-Type the endpoint doesn't accept.", "Missing `Content-Type: application/json`, uploading the wrong file type.", "RFC 9110"],
    [416, "Range Not Satisfiable", "The requested byte range is outside the file.", "Range requests past the end of the resource.", "Resuming a download of a file that changed or shrank.", "RFC 9110"],
    [417, "Expectation Failed", "The server can't meet the Expect request header.", "Rejecting `Expect: 100-continue` or unknown expectations.", "Proxies or servers that don't support Expect.", "RFC 9110"],
    [418, "I'm a teapot", "An April Fools' joke: the server refuses to brew coffee because it is a teapot.", "Easter eggs. Some sites use it to answer requests they want to refuse.", "Hyper Text Coffee Pot Control Protocol jokes, bot blocking.", "RFC 2324"],
    [421, "Misdirected Request", "The request went to a server that can't answer for this host name.", "HTTP/2 connection reuse across hosts the server doesn't serve.", "TLS certificates covering several domains, connection coalescing.", "RFC 9110"],
    [422, "Unprocessable Content", "The request is well-formed, but the data in it doesn't pass validation.", "Validation errors: valid JSON, but the email is invalid or a field is out of range.", "Form/API validation failures.", "RFC 9110"],
    [423, "Locked", "The resource is locked.", "WebDAV locks, or a record locked for editing.", "Someone else holds a lock on the file.", "RFC 4918"],
    [424, "Failed Dependency", "The request failed because an earlier request it depended on failed.", "WebDAV batch operations.", "A previous step in the same operation failed.", "RFC 4918"],
    [425, "Too Early", "The server won't process a request that might be replayed (TLS early data).", "Refusing non-idempotent requests sent in TLS 1.3 0-RTT data.", "TLS early data on POST requests.", "RFC 8470"],
    [426, "Upgrade Required", "The client must switch to a different protocol, named in the Upgrade header.", "Requiring a newer protocol (e.g. TLS or HTTP/2).", "Old clients talking to servers that require upgrades.", "RFC 9110"],
    [428, "Precondition Required", "The server requires a conditional request (If-Match) to avoid lost updates.", "Forcing clients to send an ETag when updating.", "Updating without If-Match on APIs that demand it.", "RFC 6585"],
    [429, "Too Many Requests", "You sent too many requests in a given time (rate limiting).", "Rate limits. Send Retry-After to say when to try again.", "Scripts and bots looping fast, missing back-off, shared IPs.", "RFC 6585"],
    [431, "Request Header Fields Too Large", "The headers are too big, either one header or all of them together.", "Rejecting huge headers.", "Too many or too large cookies, huge auth tokens.", "RFC 6585"],
    [451, "Unavailable For Legal Reasons", "The resource can't be shown for legal reasons, such as a court order or censorship.", "Content blocked by law in the user's region.", "Government takedowns, copyright orders, geo-legal blocks.", "RFC 7725"],

    [500, "Internal Server Error", "Something went wrong on the server and it has no more specific code for it.", "Unexpected crashes and unhandled exceptions. Log the details, don't show them to users.", "Bugs, unhandled exceptions, bad config, database errors, PHP fatal errors.", "RFC 9110"],
    [501, "Not Implemented", "The server doesn't support the feature needed to answer this request.", "An HTTP method the server doesn't recognise at all.", "Unsupported methods, unfinished API endpoints.", "RFC 9110"],
    [502, "Bad Gateway", "A gateway or proxy got an invalid response from the server behind it.", "Sent by proxies/load balancers when the upstream answers badly.", "App server crashed or restarted, PHP-FPM/Node down, wrong upstream port.", "RFC 9110"],
    [503, "Service Unavailable", "The server can't handle the request right now, usually overload or maintenance.", "Planned maintenance or overload. Send Retry-After if you can.", "Traffic spikes, maintenance mode, exhausted worker pools.", "RFC 9110"],
    [504, "Gateway Timeout", "A gateway or proxy didn't get an answer from the server behind it in time.", "Sent by proxies when the upstream is too slow.", "Slow database queries, long-running scripts, upstream servers that hang.", "RFC 9110"],
    [505, "HTTP Version Not Supported", "The server doesn't support the HTTP version used in the request.", "Rejecting an HTTP version you don't speak.", "Very old or very unusual clients.", "RFC 9110"],
    [506, "Variant Also Negotiates", "The server's content negotiation is misconfigured and loops.", "Rare server misconfiguration.", "Transparent content negotiation set up in a loop.", "RFC 2295"],
    [507, "Insufficient Storage", "The server doesn't have the storage to complete the request.", "WebDAV or upload endpoints when the disk or quota is full.", "Full disks, exceeded storage quotas.", "RFC 4918"],
    [508, "Loop Detected", "The server found an infinite loop while processing the request.", "WebDAV operations that hit circular bindings.", "Circular references in WebDAV collections.", "RFC 5842"],
    [510, "Not Extended", "The request needs more extensions than the server supports. Obsolete.", "Historic; avoid.", "HTTP Extension Framework requests.", "RFC 2774"],
    [511, "Network Authentication Required", "You need to log in to the network first.", "Captive portals: hotel, airport and café Wi-Fi sign-in pages.", "Connecting to public Wi-Fi before accepting its terms.", "RFC 6585"],

    [499, "Client Closed Request", "Nginx-specific: the client hung up before the server answered.", "Seen in nginx logs, never sent to clients.", "Users closing the tab, client timeouts shorter than server work.", "nginx", true],
    [520, "Web Server Returned an Unknown Error", "Cloudflare-specific: the origin server sent an empty, unknown or unexpected response.", "Shown by Cloudflare, not sent by your app.", "Origin crashes, empty replies, oversized headers.", "Cloudflare", true],
    [521, "Web Server Is Down", "Cloudflare-specific: the origin server refused the connection.", "Shown by Cloudflare.", "Origin offline, firewall blocking Cloudflare's IPs.", "Cloudflare", true],
    [522, "Connection Timed Out", "Cloudflare-specific: Cloudflare couldn't open a TCP connection to the origin in time.", "Shown by Cloudflare.", "Overloaded origin, firewall dropping packets, wrong DNS target.", "Cloudflare", true],
    [524, "A Timeout Occurred", "Cloudflare-specific: the origin accepted the connection but didn't answer within 100 seconds.", "Shown by Cloudflare.", "Long-running requests: reports, exports, slow queries.", "Cloudflare", true]
];

export interface Code {
  code: number;
  name: string;
  desc: string;
  use: string;
  causes: string;
  spec: string;
  unofficial: boolean;
}
export const CODES: Code[] = ROWS.map((r) => ({ code: r[0], name: r[1], desc: r[2], use: r[3], causes: r[4], spec: r[5], unofficial: !!r[6] }));
export const CLASS: Record<string, string> = { 1: 'Informational', 2: 'Success', 3: 'Redirection', 4: 'Client error', 5: 'Server error' };
export const BY: Record<number, Code> = {};
CODES.forEach((c) => (BY[c.code] = c));

export function filter(query: string, cls: string, withUnofficial: boolean) {
  const q = String(query || '').trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return CODES.filter((c) => {
    if (c.unofficial && !withUnofficial) return false;
    if (cls && String(c.code)[0] !== cls) return false;
    if (!q) return true;
    if (/^\d{1,3}$/.test(q)) return String(c.code).indexOf(q) === 0;
    const hay = (c.code + ' ' + c.name + ' ' + c.desc + ' ' + c.use + ' ' + c.causes).toLowerCase();
    return words.every((w) => hay.indexOf(w) >= 0);
  }).sort((a, b) => a.code - b.code);
}
export function codeFromHash(hash: string) {
  const m = /^#?(\d{3})$/.exec(String(hash || '').trim());
  return m && BY[+m[1]] ? +m[1] : null;
}

function view(c: Code) {
  const k = String(c.code)[0];
  return {
    code: c.code, name: c.name, class: k + 'xx', className: CLASS[k],
    meaning: c.desc, whenToUse: c.use, commonCauses: c.causes, spec: c.spec, nonStandard: c.unofficial,
  };
}

export default defineTool({
  name: 'http_status',
  title: 'HTTP status codes',
  webSlug: 'http-status',
  description:
    'Look up HTTP status codes: by exact code (e.g. 418, also non-standard ones like 499 or 524), by code prefix ("50"), or ' +
    'by words ("too many", "redirect post"), optionally limited to a class (1xx–5xx). Each result has the name, what it ' +
    'means, when to use it, common causes and the defining spec. Non-standard nginx/Cloudflare codes are only searched ' +
    `when "includeNonStandard" is set. Web version: ${webUrl('http-status')}`,
  inputSchema: z.object({
    query: z.string().optional().default('').describe('A code ("404"), code prefix ("5", "50") or search words. Empty = all codes (filtered by class).'),
    class: z.enum(['1', '2', '3', '4', '5']).optional().describe('Only this class: 1 informational, 2 success, 3 redirection, 4 client error, 5 server error.'),
    includeNonStandard: z.boolean().optional().default(false).describe('Also search non-standard codes (nginx 499, Cloudflare 52x…).'),
    limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results to return. Default 20.'),
  }),
  outputSchema: z.object({
    count: z.number(),
    results: z.array(
      z.object({
        code: z.number(), name: z.string(), class: z.string(), className: z.string(), meaning: z.string(),
        whenToUse: z.string(), commonCauses: z.string(), spec: z.string(), nonStandard: z.boolean(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { query: '429' }, note: '429 Too Many Requests with meaning, when to use and causes' }, { input: { query: 'teapot' } }],
  run(input) {
    const exact = codeFromHash(input.query);
    const rows = exact !== null && (!input.class || String(exact)[0] === input.class) ? [BY[exact]] : filter(input.query, input.class ?? '', input.includeNonStandard);
    return { count: rows.length, results: rows.slice(0, input.limit).map(view) };
  },
});

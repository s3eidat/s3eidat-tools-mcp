/**
 * The MCP server: builds an McpServer with every discovered tool, and serves it over stdio (default) or
 * Streamable HTTP (`--http`, bound to 127.0.0.1 unless `--host` is given).
 */
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { loadErrors, loadTools, toCallToolResult, type ToolModule } from './registry.js';
import { setContext, DEFAULT_MAX_BYTES, type ToolContext } from './util/context.js';
import { metaTools } from './compact.js';

export const SERVER_NAME = 's3eidat-tools';

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

export const INSTRUCTIONS = `S3eidat Tools: free, private tools for PDF, images, text, developer chores, calculators, QR codes and documents.
Everything runs on this machine; files are never uploaded. File inputs take a local path or base64; file outputs are written
to the "output" path you give (a file, or a folder ending in "/") or to a temp folder, and the result gives the path.
Chain tools by passing one tool's output path as the next tool's input (e.g. images_to_pdf → pdf_compress).
Each tool's description links the matching web tool on https://s3eidat.github.io for humans who want a visual version.`;

function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
}

export interface BuildOptions {
  /** Advertise each tool's outputSchema in tools/list (adds ~30% to the listing). structuredContent is always returned. */
  outputSchemas?: boolean;
  /** Expose three meta-tools (find / info / run) instead of every tool. */
  compact?: boolean;
}

/** Build one McpServer instance with the tools registered. */
export function buildServer(tools: ToolModule[], ctx: ToolContext, opts: BuildOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION, title: 'S3eidat Tools' }, { instructions: INSTRUCTIONS });
  if (opts.compact) {
    for (const m of metaTools(tools, ctx)) {
      server.registerTool(
        m.name,
        { title: m.title, description: m.description, inputSchema: m.inputSchema, annotations: { title: m.title, readOnlyHint: m.name !== 's3eidat_run_tool', openWorldHint: false } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (async (args: any) => m.run(args)) as any,
      );
    }
    return server;
  }
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema && opts.outputSchemas ? { outputSchema: tool.outputSchema } : {}),
        annotations: { title: tool.title, ...tool.annotations },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        try {
          return toCallToolResult(tool, await tool.run(args, ctx));
        } catch (e) {
          return errorResult(e);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
  }
  return server;
}

export interface CliOptions {
  http: boolean;
  port: number;
  host: string;
  root?: string;
  outDir?: string;
  maxMb?: number;
  only?: string[];
  groups?: string[];
  compact: boolean;
  outputSchemas: boolean;
  list: boolean;
  help: boolean;
  version: boolean;
}

/** Empty values and unfilled template placeholders (e.g. an optional Claude Desktop setting) mean "not set". */
const optional = (v: string) => (v.trim() === '' || /^\$\{[^}]*\}$/.test(v.trim()) ? undefined : v);

/** Boolean flag, optionally with an inline value: --compact, --compact=true, --compact=false. */
const asFlag = (inline: string | undefined) => inline == null || /^(1|true|yes|on)$/i.test(inline.trim());

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { http: false, port: 8787, host: '127.0.0.1', list: false, help: false, version: false, compact: false, outputSchemas: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const val = () => {
      const v = inline ?? argv[++i];
      if (v == null) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--http': o.http = true; break;
      case '--port': o.port = Number(val()); break;
      case '--host': o.host = val(); break;
      case '--root': o.root = optional(val()); break;
      case '--out-dir': o.outDir = optional(val()); break;
      case '--max-mb': o.maxMb = Number(val()); break;
      case '--only': o.only = optional(val())?.split(',').map((x) => x.trim()).filter(Boolean); break;
      case '--groups': o.groups = optional(val())?.split(',').map((x) => x.trim()).filter(Boolean); break;
      case '--compact': o.compact = asFlag(inline); break;
      case '--output-schemas': o.outputSchemas = asFlag(inline); break;
      case '--list': o.list = true; break;
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      default: throw new Error(`Unknown option: ${a} (see --help)`);
    }
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0-65535');
  return o;
}

export const HELP = `s3eidat-tools-mcp ${VERSION}: S3eidat Tools as a local MCP server (files never leave your machine)

Usage: npx -y s3eidat-tools-mcp [options]

  (no options)      serve over stdio (what Claude Desktop, Claude Code, Cursor… expect)
  --http            serve Streamable HTTP at http://127.0.0.1:8787/mcp instead
  --port <n>        HTTP port (default 8787)
  --host <addr>     HTTP bind address (default 127.0.0.1; anything else exposes your files to that network)
  --root <dir>      only allow reading/writing files inside <dir>
  --out-dir <dir>   default folder for outputs (default: <root>/s3eidat-out, or a temp folder)
  --max-mb <n>      largest input file in MB (default ${DEFAULT_MAX_BYTES / 1048576})
  --groups <list>   only expose these groups: pdf,image,text,data,dev,calc,everyday,qr,docs,ai
  --only <prefixes> only expose tools whose names start with these prefixes (e.g. pdf_,image_)
  --compact         expose 3 small meta-tools (find / info / run) instead of every tool; for clients with tool
                    limits or small context windows
  --output-schemas  also advertise each tool's output JSON Schema (bigger tool list)
  --list            print the tool list and exit
  -v, --version     print the version
  -h, --help        this help

Docs: https://s3eidat.github.io/s3eidat-tools-mcp/`;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function main(argv = process.argv.slice(2)) {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  }
  if (opts.help) return void console.log(HELP);
  if (opts.version) return void console.log(VERSION);

  const ctx = setContext({
    root: opts.root,
    outDir: opts.outDir,
    maxBytes: opts.maxMb ? opts.maxMb * 1048576 : DEFAULT_MAX_BYTES,
    version: VERSION,
  });
  let tools = await loadTools();
  for (const e of loadErrors) console.error(`[s3eidat-tools] skipped ${e.file}: ${e.error}`);
  if (opts.only?.length) tools = tools.filter((t) => opts.only!.some((p) => t.name.startsWith(p)));
  if (opts.groups?.length) {
    const unknown = opts.groups.filter((g) => !tools.some((t) => t.group === g));
    if (unknown.length) console.error(`[s3eidat-tools] unknown group(s): ${unknown.join(', ')}`);
    tools = tools.filter((t) => opts.groups!.includes(t.group ?? ''));
  }

  if (opts.list) {
    for (const t of tools) console.log(`${t.name.padEnd(28)} ${t.title}`);
    console.log(`\n${tools.length} tools`);
    return;
  }

  const factory = () => buildServer(tools, ctx, { compact: opts.compact, outputSchemas: opts.outputSchemas });

  if (!opts.http) {
    const handle = serveStdio(factory, { onerror: (e) => console.error('[s3eidat-tools]', e.message) });
    console.error(`s3eidat-tools-mcp ${VERSION}: ${tools.length} tools${opts.compact ? ' (compact mode)' : ''} on stdio. Files stay on this machine.`);
    const stop = () => void handle.close().finally(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  const handler = createMcpHandler(factory, { onerror: (e) => console.error('[s3eidat-tools]', e.message) });
  const nodeHandler = toNodeHandler(handler);
  const loopback = LOOPBACK.has(opts.host);
  const validateHost = loopback ? localhostHostValidation() : hostHeaderValidation([opts.host.replace(/^\[|\]$/g, '')]);
  const validateOrigin = localhostOriginValidation();
  const http = createHttpServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`s3eidat-tools-mcp ${VERSION}: MCP endpoint is POST /mcp (${tools.length} tools)\n`);
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found. The MCP endpoint is /mcp\n');
      return;
    }
    if (!validateHost(req, res)) return;
    if (loopback && !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const shownHost = opts.host.includes(':') && !opts.host.startsWith('[') ? `[${opts.host}]` : opts.host;
  console.error(`s3eidat-tools-mcp ${VERSION}: ${tools.length} tools at http://${shownHost}:${port}/mcp`);
  if (!loopback) console.error('Warning: listening beyond this machine; anyone who can reach it can read/write files the server can.');
  const stop = () => void handler.close().finally(() => http.close(() => process.exit(0)));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

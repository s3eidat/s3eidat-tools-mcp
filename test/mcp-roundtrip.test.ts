import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Runs against the built server (npm test builds first via "pretest").
const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));

type TextResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

async function exercise(client: Client) {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(['text_word_count', 'text_case', 'hash_compute']));
  for (const t of tools) {
    expect(t.description, t.name).toBeTruthy();
    expect(t.inputSchema.type).toBe('object');
  }

  const wc = (await client.callTool({ name: 'text_word_count', arguments: { text: 'Hello world. Bye.' } })) as TextResult;
  expect(wc.isError).toBeFalsy();
  expect(wc.structuredContent?.words).toBe(3);

  const cc = (await client.callTool({ name: 'text_case', arguments: { text: 'someVariableName', mode: 'snake' } })) as TextResult;
  expect(cc.structuredContent?.result).toBe('some_variable_name');

  const h = (await client.callTool({ name: 'hash_compute', arguments: { text: 'abc' } })) as TextResult;
  expect((h.structuredContent?.hashes as Record<string, string>)['SHA-256']).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );

  const bad = (await client.callTool({ name: 'text_case', arguments: { text: 'x', mode: 'nope' } })) as TextResult;
  expect(bad.isError).toBe(true);
}

describe('MCP round trip over stdio', () => {
  it('lists and calls tools', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], stderr: 'ignore' }));
    try {
      await exercise(client);
    } finally {
      await client.close();
    }
  });
});

describe('MCP round trip over Streamable HTTP', () => {
  let child: ChildProcess;
  let url: URL;
  beforeAll(async () => {
    child = spawn(process.execPath, [bin, '--http', '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
    url = await new Promise<URL>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('server did not start: ' + buf)), 15_000);
      child.stderr!.on('data', (d) => {
        buf += d;
        const m = /(http:\/\/\S+\/mcp)/.exec(buf);
        if (m) { clearTimeout(timer); resolve(new URL(m[1])); }
      });
      child.on('exit', (c) => reject(new Error(`server exited ${c}: ${buf}`)));
    });
  });
  afterAll(() => { child?.kill(); });

  it('lists and calls tools', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await exercise(client);
    } finally {
      await client.close();
    }
  });

  it('rejects a foreign Host header (DNS rebinding guard)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});

describe('listing modes', () => {
  async function connect(args: string[]) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, ...args], stderr: 'ignore' }));
    return client;
  }

  it('omits output schemas by default and adds them with --output-schemas', async () => {
    const a = await connect([]);
    const b = await connect(['--output-schemas', '--groups', 'text']);
    try {
      const plain = (await a.listTools()).tools.find((t) => t.name === 'text_case')!;
      expect(plain.outputSchema).toBeUndefined();
      const res = (await a.callTool({ name: 'text_case', arguments: { text: 'a b', mode: 'snake' } })) as TextResult;
      expect(res.structuredContent?.result).toBe('a_b');
      const listed = (await b.listTools()).tools;
      expect(listed.every((t) => t.name.startsWith('text_'))).toBe(true);
      expect(listed.find((t) => t.name === 'text_case')!.outputSchema).toBeTruthy();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('--compact exposes find / info / run', async () => {
    const c = await connect(['--compact']);
    try {
      const names = (await c.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(['s3eidat_find_tools', 's3eidat_run_tool', 's3eidat_tool_info']);
      const found = (await c.callTool({ name: 's3eidat_find_tools', arguments: { query: 'merge pdf' } })) as TextResult;
      expect((found.structuredContent?.tools as { name: string }[])[0].name).toBe('pdf_merge');
      const info = (await c.callTool({ name: 's3eidat_tool_info', arguments: { name: 'text_case' } })) as TextResult;
      expect(JSON.stringify(info.structuredContent?.inputSchema)).toContain('kebab');
      const run = (await c.callTool({ name: 's3eidat_run_tool', arguments: { name: 'text_case', arguments: { text: 'Hello World', mode: 'kebab' } } })) as TextResult;
      expect(run.structuredContent?.result).toBe('hello-world');
      const bad = (await c.callTool({ name: 's3eidat_run_tool', arguments: { name: 'text_case', arguments: { text: 1 } } })) as TextResult;
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/Invalid arguments for text_case/);
    } finally {
      await c.close();
    }
  });
});

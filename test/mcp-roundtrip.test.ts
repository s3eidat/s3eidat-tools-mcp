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

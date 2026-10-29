/**
 * Compact mode (`--compact`): instead of listing every tool (tens of thousands of tokens of schemas), the server
 * exposes three small meta-tools. The model finds a tool, reads its schema, then runs it. Meant for clients with a
 * tool limit (Cursor, Windsurf…) or small context windows.
 */
import { z } from 'zod';
import { toCallToolResult, webUrl, type CallToolResult, type ToolModule } from './registry.js';
import type { ToolContext } from './util/context.js';

export interface MetaTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  run: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

const firstSentence = (s: string) => {
  const m = /^(.+?[.!?])(\s|$)/s.exec(s);
  return (m ? m[1] : s).replace(/\s+/g, ' ').slice(0, 220);
};

function score(t: ToolModule, words: string[]) {
  const name = t.name.replace(/_/g, ' '), title = t.title.toLowerCase(), desc = t.description.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (name.includes(w)) s += 5;
    if (title.includes(w)) s += 3;
    if (t.group === w) s += 4;
    if (desc.includes(w)) s += 1;
    else if (!name.includes(w) && !title.includes(w)) return 0; // every word must match somewhere
  }
  return s;
}

const json = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }], structuredContent: v as Record<string, unknown> });
const fail = (msg: string): CallToolResult => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

export function metaTools(tools: ToolModule[], ctx: ToolContext): MetaTool[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const groups = [...new Set(tools.map((t) => t.group ?? 'misc'))];
  return [
    {
      name: 's3eidat_find_tools',
      title: 'Find a S3eidat tool',
      description:
        `Search ${tools.length} local, private tools (PDF, images, text, JSON/CSV/YAML/XML/SQL, hashes, calculators, dates, ` +
        `prayer times, passwords, encryption, QR codes, invoices/CVs as PDF…) by keywords, e.g. "merge pdf", "resize image", ` +
        `"loan", "arabic". Returns tool names and one-line summaries; then call s3eidat_tool_info for a tool's inputs and ` +
        `s3eidat_run_tool to run it. Groups: ${groups.join(', ')}.`,
      inputSchema: z.object({
        query: z.string().optional().describe('Keywords. Leave empty with a group to list the whole group.'),
        group: z.string().optional().describe(`Only this group: ${groups.join(', ')}.`),
        limit: z.number().int().min(1).max(200).optional().default(15),
      }),
      async run({ query, group, limit }) {
        const words = String(query ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
        const pool = group ? tools.filter((t) => t.group === group) : tools;
        const hits = (words.length ? pool.map((t) => ({ t, s: score(t, words) })).filter((h) => h.s > 0).sort((a, b) => b.s - a.s) : pool.map((t) => ({ t, s: 0 })))
          .slice(0, Number(limit ?? 15))
          .map(({ t }) => ({ name: t.name, title: t.title, group: t.group, summary: firstSentence(t.description) }));
        return json({ count: hits.length, tools: hits, ...(hits.length ? {} : { hint: 'No match. Try fewer or simpler words, or list a group.' }) });
      },
    },
    {
      name: 's3eidat_tool_info',
      title: 'Describe a S3eidat tool',
      description: 'Full description, input JSON Schema and examples of one tool found with s3eidat_find_tools.',
      inputSchema: z.object({ name: z.string().describe('Tool name, e.g. "pdf_merge".') }),
      async run({ name }) {
        const t = byName.get(String(name));
        if (!t) return fail(`No tool named "${name}". Use s3eidat_find_tools.`);
        return json({
          name: t.name,
          title: t.title,
          description: t.description,
          web: t.webSlug ? webUrl(t.webSlug) : undefined,
          inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input', unrepresentable: 'any' }),
          examples: t.examples?.map((e) => ({ input: e.input, note: e.note })),
          annotations: t.annotations,
        });
      },
    },
    {
      name: 's3eidat_run_tool',
      title: 'Run a S3eidat tool',
      description:
        'Run one tool by name with its arguments (see s3eidat_tool_info for the schema). Runs locally; files never leave ' +
        'this machine. File inputs take a local path or base64; file outputs go to the "output" path you give or a temp folder.',
      inputSchema: z.object({
        name: z.string().describe('Tool name, e.g. "pdf_merge".'),
        arguments: z.record(z.string(), z.unknown()).optional().default({}).describe('The tool\'s arguments as an object.'),
      }),
      async run({ name, arguments: args }) {
        const t = byName.get(String(name));
        if (!t) return fail(`No tool named "${name}". Use s3eidat_find_tools.`);
        const parsed = t.inputSchema.safeParse(args ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ');
          return fail(`Invalid arguments for ${t.name}: ${issues}. See s3eidat_tool_info.`);
        }
        try {
          return toCallToolResult(t, await t.run(parsed.data, ctx));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}

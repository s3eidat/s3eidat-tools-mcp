import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import { outputPath, readInput, writeOutput } from '../../util/files.js';

type JsonType = 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'object' | 'array';
type Schema = Record<string, unknown>;

const FORMAT_TESTS: [string, RegExp][] = [
  ['date-time', /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/],
  ['date', /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ['uri', /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i],
];

/** Everything seen at one place in the samples. */
class Node {
  count = 0;
  types = new Set<JsonType>();
  // strings
  strings = new Map<string, number>();
  stringCount = 0;
  tooManyStrings = false;
  formats: Set<string> | null = null;
  // objects
  objects = 0;
  props = new Map<string, Node>();
  propSeen = new Map<string, number>();
  // arrays
  items: Node | null = null;

  add(v: unknown, enumCap: number) {
    this.count++;
    if (v === null) { this.types.add('null'); return; }
    if (Array.isArray(v)) {
      this.types.add('array');
      for (const x of v) (this.items ??= new Node()).add(x, enumCap);
      return;
    }
    switch (typeof v) {
      case 'boolean': this.types.add('boolean'); return;
      case 'number': this.types.add(Number.isInteger(v) ? 'integer' : 'number'); return;
      case 'string': {
        this.types.add('string');
        this.stringCount++;
        if (!this.tooManyStrings) {
          this.strings.set(v, (this.strings.get(v) ?? 0) + 1);
          if (this.strings.size > Math.max(enumCap, 50)) { this.tooManyStrings = true; this.strings.clear(); }
        }
        const fmts = new Set(FORMAT_TESTS.filter(([, re]) => re.test(v)).map(([f]) => f));
        this.formats = this.formats ? new Set([...this.formats].filter((f) => fmts.has(f))) : fmts;
        return;
      }
      case 'object': {
        this.types.add('object');
        this.objects++;
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          let p = this.props.get(k);
          if (!p) { p = new Node(); this.props.set(k, p); }
          p.add(x, enumCap);
          this.propSeen.set(k, (this.propSeen.get(k) ?? 0) + 1);
        }
        return;
      }
      default:
        throw new ToolError(`Not a JSON value: ${typeof v}`);
    }
  }
}

export interface InferOptions {
  enums: boolean;
  maxEnumValues: number;
  formats: boolean;
  additionalProperties: boolean;
  required: boolean;
}

function toSchema(n: Node, o: InferOptions): Schema {
  const types = new Set(n.types);
  if (types.has('integer') && types.has('number')) types.delete('integer');
  const order: JsonType[] = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
  const list = order.filter((t) => types.has(t));
  const s: Schema = {};
  if (list.length === 1) s.type = list[0];
  else if (list.length > 1) s.type = list;

  if (types.has('string')) {
    const distinct = n.strings.size;
    const fmt = o.formats && n.formats && n.formats.size ? FORMAT_TESTS.map(([f]) => f).find((f) => n.formats!.has(f)) : undefined;
    if (fmt) s.format = fmt;
    else if (o.enums && !n.tooManyStrings && distinct > 0 && distinct <= o.maxEnumValues && n.stringCount > distinct) {
      const values: unknown[] = [...n.strings.keys()].sort();
      if (types.has('null')) values.push(null);
      // An enum only makes sense when everything at this place is a string (or null).
      if (list.every((t) => t === 'string' || t === 'null')) s.enum = values;
    }
  }
  if (types.has('object')) {
    const props: Record<string, Schema> = {};
    for (const [k, p] of n.props) props[k] = toSchema(p, o);
    s.properties = props;
    if (o.required) {
      const req = [...n.propSeen].filter(([, c]) => c === n.objects).map(([k]) => k);
      if (req.length) s.required = req;
    }
    if (!o.additionalProperties) s.additionalProperties = false;
  }
  if (types.has('array') && n.items) s.items = toSchema(n.items, o);
  return s;
}

/** Infer a draft 2020-12 JSON Schema from sample values. */
export function inferSchema(samples: unknown[], o: InferOptions, title?: string): Schema {
  const root = new Node();
  for (const s of samples) root.add(s, o.maxEnumValues);
  const body = toSchema(root, o);
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...(title ? { title } : {}), ...body };
}

function parseSamples(text: string): unknown[] {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) throw new ToolError('The JSON input is empty.');
  try {
    return [JSON.parse(t)];
  } catch (e) {
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new ToolError(`Invalid JSON: ${(e as Error).message}`);
    return lines.map((l, i) => {
      try { return JSON.parse(l); } catch (err) { throw new ToolError(`JSONL line ${i + 1}: ${(err as Error).message}`); }
    });
  }
}

export default defineTool({
  name: 'ai_json_schema_infer',
  title: 'Infer a JSON Schema from samples',
  description:
    'Generate a JSON Schema (draft 2020-12) from one or more sample JSON values: types (integer vs number, mixed types as a ' +
    'type list), "null" added where a value can be null, required = keys present in every sample object, array items merged ' +
    'across all elements, string formats guessed when every sample matches (date-time, date, email, uri, uuid), and ' +
    'optional enums for small repeated string sets. Give "samples" (an array of sample values), or "text" (JSON, or JSONL = one ' +
    'sample per line), or "file" (path or base64 of a .json/.jsonl file). An array sample describes an array; to treat its ' +
    'elements as separate samples set eachItem. Pure local code; optionally writes the schema to "output".',
  inputSchema: z.object({
    samples: z.array(z.unknown()).optional().describe('Sample values; each element is one sample.'),
    text: z.string().optional().describe('Or: JSON text (one sample) or JSONL (one sample per line).'),
    file: z.string().optional().describe('Or: a .json/.jsonl file (local path or base64).'),
    eachItem: z.boolean().optional().default(false).describe('If the only sample is an array, use its elements as the samples (schema of one record). Default false.'),
    title: z.string().optional().describe('Optional "title" for the schema.'),
    enums: z.boolean().optional().default(false).describe('Emit "enum" for string fields with few distinct values that repeat. Default false.'),
    maxEnumValues: z.number().int().min(1).max(50).optional().default(8).describe('Largest string set turned into an enum (default 8).'),
    formats: z.boolean().optional().default(true).describe('Guess string formats (default true).'),
    required: z.boolean().optional().default(true).describe('List keys present in every sample as "required" (default true).'),
    additionalProperties: z.boolean().optional().default(true).describe('false adds additionalProperties: false to every object (strict). Default true (left open).'),
    output: outputPath().describe('Optional: also write the schema as a .json file here.'),
  }),
  outputSchema: z.object({
    schema: z.record(z.string(), z.unknown()),
    samples: z.number().describe('How many samples were used.'),
    path: z.string().optional(),
    bytes: z.number().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: { samples: [{ id: 1, email: 'a@b.co', tags: ['x'] }, { id: 2, email: 'c@d.org', tags: [], note: null }] },
    output: {
      samples: 2,
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          id: { type: 'integer' }, email: { type: 'string', format: 'email' },
          tags: { type: 'array', items: { type: 'string' } }, note: { type: 'null' },
        },
        required: ['id', 'email', 'tags'],
      },
    },
  }],
  async run(input, ctx) {
    const given = [input.samples, input.text, input.file].filter((v) => v !== undefined).length;
    if (given !== 1) throw new ToolError('Give exactly one of "samples", "text" or "file".');
    let samples = input.samples
      ?? (input.text !== undefined ? parseSamples(input.text) : parseSamples((await readInput(input.file!, ctx, 'file')).bytes.toString('utf8')));
    if (input.eachItem && samples.length === 1 && Array.isArray(samples[0])) samples = samples[0] as unknown[];
    if (!samples.length) throw new ToolError('No samples given.');
    const schema = inferSchema(samples, {
      enums: input.enums, maxEnumValues: input.maxEnumValues, formats: input.formats,
      additionalProperties: input.additionalProperties, required: input.required,
    }, input.title);
    const out: Record<string, unknown> = { schema, samples: samples.length };
    if (input.output) {
      const w = await writeOutput(JSON.stringify(schema, null, 2) + '\n', { output: input.output, defaultName: 'schema.json', mimeType: 'application/schema+json' }, ctx);
      out.path = w.path;
      out.bytes = w.bytes;
    }
    return out;
  },
});

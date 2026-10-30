import { z } from 'zod';
import { defineTool, ToolError, type ToolContext } from '../../registry.js';
import { readInput } from '../../util/files.js';

// Common string formats, checked without extra packages (ajv-formats is not a dependency).
const UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$/i;
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const HOST = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function validDate(s: string) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
}
function validUri(s: string, needScheme: boolean) {
  if (/\s/.test(s)) return false;
  if (needScheme && !/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  try { new URL(s, needScheme ? undefined : 'http://x/'); return true; } catch { return false; }
}
function validIpv6(s: string) {
  try { return new URL(`http://[${s}]/`).hostname.length > 2 && !s.includes('%'); } catch { return false; }
}

export const FORMATS: Record<string, (s: string) => boolean> = {
  date: validDate,
  time: (s) => TIME_RE.test(s),
  'date-time': (s) => {
    const i = s.search(/[tT ]/);
    return i > 0 && validDate(s.slice(0, i)) && TIME_RE.test(s.slice(i + 1)) && /(z|[+-]\d\d:?\d\d)$/i.test(s);
  },
  email: (s) => EMAIL.test(s),
  hostname: (s) => HOST.test(s),
  ipv4: (s) => IPV4.test(s),
  ipv6: validIpv6,
  uri: (s) => validUri(s, true),
  'uri-reference': (s) => validUri(s, false),
  iri: (s) => validUri(s, true),
  'iri-reference': (s) => validUri(s, false),
  uuid: (s) => UUID.test(s),
  regex: (s) => { try { new RegExp(s, 'u'); return true; } catch { return false; } },
  'json-pointer': (s) => /^(?:\/(?:[^~/]|~0|~1)*)*$/.test(s),
};

/** Parse JSON text with a readable error. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new ToolError(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

async function readJsonFile(v: string, ctx: ToolContext, what: string) {
  const f = await readInput(v, ctx, what);
  return parseJson(f.bytes.toString('utf8'), what);
}

const errorShape = z.object({
  instancePath: z.string().describe('JSON Pointer to the failing value ("" = the root).'),
  schemaPath: z.string(),
  keyword: z.string(),
  message: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export default defineTool({
  name: 'ai_json_schema_validate',
  title: 'Validate JSON against a JSON Schema',
  description:
    'Validate JSON data against a JSON Schema with Ajv, reporting every error (allErrors) with its instancePath (JSON Pointer), ' +
    'schemaPath, keyword, message and params. Draft 2020-12 is used when the schema\'s $schema says 2020-12 (2019-09 likewise), ' +
    'otherwise draft-07 (draft-04/06 schemas are checked as draft-07). Formats checked: date, time, date-time, email, hostname, ' +
    'ipv4, ipv6, uri, uri-reference, uuid, regex, json-pointer (other formats are ignored and listed). Data: inline "data" (any ' +
    'JSON value), "dataText" (JSON text) or "dataFile" (path or base64). Schema: inline "schema" (object or JSON text) or ' +
    '"schemaFile". Remote $ref URLs are never fetched. Runs locally.',
  inputSchema: z.object({
    data: z.unknown().optional().describe('The JSON value to validate, inline (a string here is validated as a string; use dataText for JSON text).'),
    dataText: z.string().optional().describe('Or: the data as JSON text.'),
    dataFile: z.string().optional().describe('Or: a JSON file (local path or base64).'),
    schema: z.union([z.record(z.string(), z.unknown()), z.boolean(), z.string()]).optional().describe('The JSON Schema inline: an object (or JSON text).'),
    schemaFile: z.string().optional().describe('Or: a JSON Schema file (local path or base64).'),
    maxErrors: z.number().int().min(1).max(1000).optional().default(100).describe('Most errors to return (default 100).'),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    errorCount: z.number(),
    errors: z.array(errorShape),
    draft: z.string().describe('The JSON Schema draft used.'),
    ignoredFormats: z.array(z.string()).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{
    input: { data: { name: 'Omar', age: -1 }, schema: { type: 'object', required: ['name', 'email'], properties: { age: { type: 'integer', minimum: 0 } } } },
    output: { valid: false, errorCount: 2, draft: 'draft-07' },
  }],
  async run(input, ctx) {
    const nData = [input.data !== undefined, input.dataText !== undefined, input.dataFile !== undefined].filter(Boolean).length;
    if (nData !== 1) throw new ToolError('Give exactly one of "data", "dataText" or "dataFile".');
    if ((input.schema === undefined) === (input.schemaFile === undefined)) throw new ToolError('Give exactly one of "schema" or "schemaFile".');
    const data = input.dataText !== undefined ? parseJson(input.dataText, 'dataText')
      : input.dataFile !== undefined ? await readJsonFile(input.dataFile, ctx, 'dataFile') : input.data;
    let schema = input.schemaFile !== undefined ? await readJsonFile(input.schemaFile, ctx, 'schemaFile')
      : typeof input.schema === 'string' ? parseJson(input.schema, 'schema') : input.schema;
    if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object' || Array.isArray(schema))) {
      throw new ToolError('The schema must be a JSON object (or true/false).');
    }

    const declared = typeof schema === 'object' ? String((schema as Record<string, unknown>).$schema ?? '') : '';
    let draft = 'draft-07';
    let Ctor;
    if (/2020-12/.test(declared)) { draft = '2020-12'; Ctor = (await import('ajv/dist/2020.js')).Ajv2020; }
    else if (/2019-09/.test(declared)) { draft = '2019-09'; Ctor = (await import('ajv/dist/2019.js')).Ajv2019; }
    else {
      Ctor = (await import('ajv')).Ajv;
      // Ajv only ships the draft-07 meta-schema; other drafts are checked as draft-07.
      if (declared && !/draft-07/.test(declared) && typeof schema === 'object') {
        const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
        schema = rest;
      }
    }

    const ignored = new Set<string>();
    const ajv = new Ctor({ allErrors: true, strict: false, logger: false, validateFormats: true });
    for (const [name, fn] of Object.entries(FORMATS)) ajv.addFormat(name, { type: 'string', validate: fn });
    // Unknown formats pass, but are reported.
    const scan = (n: unknown) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(scan); return; }
      const o = n as Record<string, unknown>;
      if (typeof o.format === 'string' && !FORMATS[o.format]) { ignored.add(o.format); ajv.addFormat(o.format, true); }
      Object.values(o).forEach(scan);
    };
    scan(schema);

    let validate;
    try {
      validate = ajv.compile(schema as object);
    } catch (e) {
      throw new ToolError(`The schema is invalid: ${(e as Error).message}`);
    }
    const valid = validate(data) as boolean;
    const errs = validate.errors ?? [];
    const out: Record<string, unknown> = {
      valid,
      errorCount: errs.length,
      errors: errs.slice(0, input.maxErrors).map((e) => ({
        instancePath: e.instancePath,
        schemaPath: e.schemaPath,
        keyword: e.keyword,
        message: e.message ?? e.keyword,
        params: (e.params ?? {}) as Record<string, unknown>,
      })),
      draft,
    };
    if (ignored.size) out.ignoredFormats = [...ignored];
    return out;
  },
});

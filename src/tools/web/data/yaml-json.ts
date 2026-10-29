import * as Y from 'js-yaml';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { deliver, failAt, outputField, pathField, READ_ONLY, readText, resultShape, textField } from './_io.js';
import { parseJson } from './json-studio.js';

// Ported from https://github.com/s3eidat/yaml-json (app.js). The website uses js-yaml 4 with its DEFAULT_SCHEMA
// (core + merge keys, timestamps, binary, omap, pairs, set; no code tags). js-yaml 5 splits those into tags,
// so the same schema is rebuilt here, and Set/Map results are turned back into the plain objects js-yaml 4 gave.
const SCHEMA = Y.CORE_SCHEMA.withTags(Y.mergeTag, Y.timestampTag, Y.binaryTag, Y.omapTag, Y.pairsTag, Y.setTag);
const MAX_NODES = 2_000_000; // guards against "billion laughs" alias expansion

function plain(v: unknown, seen = new Map<object, unknown>()): unknown {
  if (!v || typeof v !== 'object' || v instanceof Date || ArrayBuffer.isView(v)) return v;
  if (seen.has(v)) return seen.get(v); // keep shared aliases shared (guard() measures the expansion)
  if (v instanceof Set) { const o: Record<string, null> = {}; seen.set(v, o); for (const k of v) o[String(k)] = null; return o; }
  if (v instanceof Map) { const o: Record<string, unknown> = {}; seen.set(v, o); for (const [k, x] of v) o[String(k)] = plain(x, seen); return o; }
  if (Array.isArray(v)) { const a: unknown[] = []; seen.set(v, a); for (const x of v) a.push(plain(x, seen)); return a; }
  const o: Record<string, unknown> = {}; seen.set(v, o);
  for (const k of Object.keys(v)) o[k] = plain((v as Record<string, unknown>)[k], seen);
  return o;
}

// Walk the value the way JSON.stringify would; stop on cycles and alias bombs.
export function guard(v: unknown): number {
  let seen = 0;
  const path: unknown[] = [];
  (function walk(x: unknown) {
    if (++seen > MAX_NODES) throw new ToolError('This YAML expands to more than ' + MAX_NODES.toLocaleString('en-US') + ' values (alias bomb?), so it was not converted');
    if (x && typeof x === 'object' && !(x instanceof Date)) {
      if (path.indexOf(x) >= 0) throw new ToolError("This YAML refers to itself (a recursive alias), which JSON can't represent");
      path.push(x);
      for (const k of Object.keys(x)) walk((x as Record<string, unknown>)[k]);
      path.pop();
    }
  })(v);
  return seen;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

export interface YamlOpts { indent: number; sort?: boolean; multi?: boolean; always?: boolean }

export function yamlToJson(text: string, opt: YamlOpts) {
  const docs = (Y.loadAll(text, { schema: SCHEMA, maxTotalMergeKeys: -1 }) as unknown[]).map((d) => plain(d));
  let val: unknown = docs.length === 1 && !opt.always ? docs[0] : docs;
  const count = guard(val);
  if (opt.sort) val = sortDeep(val);
  return { text: JSON.stringify(val, null, +opt.indent) + '\n', docs: docs.length, nodes: count, value: val };
}

export function jsonToYaml(text: string, opt: YamlOpts) {
  const r = parseJson(text);
  if (!r.ok) failAt('Invalid JSON', r.error, text, r.at);
  const val = r.data, o = { indent: +opt.indent, sortKeys: !!opt.sort, lineWidth: -1, noRefs: true };
  if (opt.multi && Array.isArray(val)) {
    return { text: val.length ? val.map((d) => '---\n' + Y.dump(d, o)).join('') : '', docs: val.length, value: val };
  }
  return { text: Y.dump(val, o), docs: 1, value: val };
}

/** YAML error → message + 1-based line/column. */
export function yamlError(e: unknown): { msg: string; at: { line: number; col: number } | null } {
  const ye = e as { reason?: string; message?: string; mark?: { line: number; column: number } };
  if (ye.mark) return { msg: ye.reason || String(ye.message), at: { line: ye.mark.line + 1, col: ye.mark.column + 1 } };
  return { msg: String(ye.message ?? e), at: null };
}

const indent = z.union([z.literal(2), z.literal(4), z.enum(['2', '4'])]).optional().default(2).describe('Indentation: 2 or 4 spaces.');

const yamlToJsonTool = defineTool({
  name: 'yaml_to_json',
  title: 'YAML to JSON',
  webSlug: 'yaml-json',
  description:
    'Convert YAML to JSON (YAML 1.2 core schema plus anchors/aliases, << merge keys, timestamps, multi-document files). Safe: ' +
    'no code tags (!!js/function, !!python… are rejected), alias bombs and recursive aliases are stopped. Several documents ' +
    'become a JSON array. Errors give line and column. Give "text" or a file "path". ' +
    `Web version: ${webUrl('yaml-json')}`,
  inputSchema: z.object({
    text: textField('YAML'),
    path: pathField('YAML'),
    indent,
    sortKeys: z.boolean().optional().default(false).describe('Sort object keys alphabetically at every level.'),
    alwaysArray: z.boolean().optional().default(false).describe('Always output an array of documents, even for one document.'),
    output: outputField(),
  }),
  outputSchema: z.object({ documents: z.number(), values: z.number(), ...resultShape }),
  annotations: READ_ONLY,
  examples: [{ input: { text: 'base: &b {x: 1}\nchild:\n  <<: *b\n  y: 2\n' }, output: { documents: 1, values: 6, result: '{\n  "base": {\n    "x": 1\n  },\n  "child": {\n    "x": 1,\n    "y": 2\n  }\n}\n' } }],
  async run(input, ctx) {
    const text = await readText(input, ctx);
    if (!text.trim()) throw new ToolError('The YAML is empty.');
    let r;
    try {
      r = yamlToJson(text, { indent: +input.indent, sort: input.sortKeys, always: input.alwaysArray });
    } catch (e) {
      if (e instanceof ToolError) throw e;
      const er = yamlError(e);
      failAt('YAML error', er.msg, text, er.at);
    }
    return { documents: r.docs, values: r.nodes, ...(await deliver(r.text, { output: input.output, defaultName: 'data.json', mimeType: 'application/json' }, ctx)) };
  },
});

const jsonToYamlTool = defineTool({
  name: 'json_to_yaml',
  title: 'JSON to YAML',
  webSlug: 'yaml-json',
  description:
    'Convert JSON to YAML (js-yaml dump: no line wrapping, no anchors; strings that would read as numbers/booleans are quoted). ' +
    'Options: 2 or 4 space indent, sort keys, and write a top-level array as a multi-document YAML stream (--- per item). ' +
    `Invalid JSON gives line and column. Give "text" or a file "path". Web version: ${webUrl('yaml-json')}`,
  inputSchema: z.object({
    text: textField('JSON'),
    path: pathField('JSON'),
    indent,
    sortKeys: z.boolean().optional().default(false).describe('Sort mapping keys alphabetically.'),
    multiDocument: z.boolean().optional().default(false).describe('A top-level JSON array becomes one YAML document per item.'),
    output: outputField(),
  }),
  outputSchema: z.object({ documents: z.number(), ...resultShape }),
  annotations: READ_ONLY,
  examples: [{ input: { text: '{"b":1,"a":{"d":1,"c":2}}', sortKeys: true }, output: { documents: 1, result: 'a:\n  c: 2\n  d: 1\nb: 1\n' } }],
  async run(input, ctx) {
    const text = await readText(input, ctx);
    if (!text.trim()) throw new ToolError('The JSON is empty.');
    const r = jsonToYaml(text, { indent: +input.indent, sort: input.sortKeys, multi: input.multiDocument });
    return { documents: r.docs, ...(await deliver(r.text, { output: input.output, defaultName: 'data.yaml', mimeType: 'application/yaml' }, ctx)) };
  },
});

export default [yamlToJsonTool, jsonToYamlTool];

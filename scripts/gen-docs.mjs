#!/usr/bin/env node
// Generates docs/tools.md, docs/tools.json, docs/tools.html and docs/llms.txt from the tool registry.
// Run with `npm run docs` (builds first). Examples without a stated output are run for real (offline, temp folder).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const root = fileURLToPath(new URL('..', import.meta.url));

// Examples run with a frozen clock so time-based results (world clock, countdowns, "relative") don't churn the docs.
const FROZEN = Date.parse('2026-01-15T09:30:00Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FROZEN])); }
  static now() { return FROZEN; }
};
const { loadTools, webUrl } = await import(pathToFileURL(join(root, 'dist/registry.js')).href);
const { DEFAULT_MAX_BYTES } = await import(pathToFileURL(join(root, 'dist/util/context.js')).href);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tools = await loadTools();

const GROUPS = [
  ['pdf', 'PDF', 'Merge, split, organise, compress, watermark, number, sign and fill PDFs; text and images out.'],
  ['image', 'Images', 'Convert, resize, crop, compress, watermark, EXIF, palettes, favicons, placeholders.'],
  ['text', 'Text', 'Counting, case, slugs, cleaning, diffs, readability, Arabic tools, numbers to words, citations.'],
  ['data', 'Developer: data formats', 'JSON, CSV, YAML, XML, SQL, HTML/CSS formatting and conversion, types from JSON, curl to code.'],
  ['dev', 'Developer: utilities', 'Hashes, Base64, URLs, JWT, IDs, regex, cron, timestamps, subnets, chmod, HTTP status, .gitignore.'],
  ['calc', 'Calculators', 'Loans, interest, percentages, salary, GPA, zakat, BMI, dates, units, Hijri, maths.'],
  ['everyday', 'Everyday & security', 'Prayer times, qibla, world clock, random picks, Secret Santa, passwords, encryption.'],
  ['qr', 'QR & barcodes', 'Make and read QR codes, Wi-Fi QR, barcodes.'],
  ['docs', 'Document makers', 'Invoices, receipts, business cards, labels, calendars and CVs as PDF.'],
  ['ai', 'For AI agents', 'Extra tools made for agents: documents to Markdown, OCR, chunking, SQL over CSV, charts and more.'],
];
const groupInfo = new Map(GROUPS.map(([k, t, d], i) => [k, { title: t, blurb: d, order: i }]));
const info = (g) => groupInfo.get(g) ?? { title: g[0].toUpperCase() + g.slice(1), blurb: '', order: 99 };

function jsonSchema(schema) {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return undefined;
  }
}

function typeOf(p) {
  if (!p) return 'any';
  if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (p.const !== undefined) return JSON.stringify(p.const);
  if (p.anyOf || p.oneOf) return (p.anyOf || p.oneOf).map(typeOf).join(' | ');
  if (p.type === 'array') { const t = typeOf(p.items); return t.includes(' | ') ? `(${t})[]` : `${t}[]`; }
  if (Array.isArray(p.type)) return p.type.join(' | ');
  return p.type ?? 'object';
}

function fields(schema) {
  const js = jsonSchema(schema);
  if (!js?.properties) return [];
  const req = new Set(js.required ?? []);
  return Object.entries(js.properties).map(([name, p]) => ({
    name,
    type: typeOf(p),
    required: req.has(name) && p.default === undefined,
    default: p.default,
    description: (p.description ?? '').replace(/\n/g, ' '),
  }));
}

async function exampleOutput(tool, ex) {
  if (ex.output !== undefined) return ex.output;
  if (tool.annotations?.idempotentHint === false || tool.annotations?.openWorldHint) return undefined;
  const outDir = mkdtempSync(join(tmpdir(), 's3eidat-docs-'));
  try {
    const input = tool.inputSchema.parse(ex.input);
    const res = await Promise.race([
      tool.run(input, { outDir, maxBytes: DEFAULT_MAX_BYTES, version: pkg.version }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
    ]);
    const text = JSON.stringify(res, (k, v) => (typeof v === 'string' && v.length > 600 ? v.slice(0, 600) + '…' : v));
    return JSON.parse(text.split(outDir).join('/tmp/s3eidat-tools'));
  } catch {
    return undefined;
  }
}

const docs = [];
for (const t of tools) {
  const examples = [];
  for (const ex of t.examples ?? []) examples.push({ ...ex, output: await exampleOutput(t, ex) });
  docs.push({
    name: t.name,
    title: t.title,
    group: t.group,
    description: t.description,
    web: t.webSlug ? webUrl(t.webSlug) : undefined,
    annotations: t.annotations,
    inputs: fields(t.inputSchema),
    outputs: fields(t.outputSchema),
    inputSchema: jsonSchema(t.inputSchema),
    outputSchema: jsonSchema(t.outputSchema),
    examples,
  });
}
const grouped = [...new Set(docs.map((d) => d.group))]
  .sort((a, b) => info(a).order - info(b).order || a.localeCompare(b))
  .map((g) => ({ key: g, ...info(g), tools: docs.filter((d) => d.group === g) }));

const fence = (v) => '```json\n' + JSON.stringify(v, null, 2) + '\n```';
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ---------- tools.md ----------
let md = `# Tools reference\n\n_Generated by \`npm run docs\` from the registry — ${docs.length} tools, s3eidat-tools-mcp ${pkg.version}. Do not edit by hand._\n\n`;
md += 'Examples were run with the clock set to 2026-01-15 09:30 UTC. File inputs take a local path or base64; file outputs go to `output` (a file, or a folder ending in `/`) or a temp folder, and the result returns the path. Everything runs locally.\n\n';
md += '## Contents\n\n' + grouped.map((g) => `- [${g.title}](#${g.key}) (${g.tools.length})`).join('\n') + '\n\n';
for (const g of grouped) {
  md += `<a id="${g.key}"></a>\n## ${g.title}\n\n${g.blurb}\n\n| Tool | What it does |\n|---|---|\n`;
  md += g.tools.map((t) => `| [\`${t.name}\`](#${t.name}) | ${cell(t.title)} |`).join('\n') + '\n\n';
  for (const t of g.tools) {
    md += `<a id="${t.name}"></a>\n### \`${t.name}\` — ${t.title}\n\n${t.description}\n\n`;
    if (t.web && !t.description.includes(t.web)) md += `Web version for humans: ${t.web}\n\n`;
    const hints = Object.entries(t.annotations ?? {}).filter(([, v]) => v).map(([k]) => k.replace(/Hint$/, ''));
    if (hints.length) md += `Hints: ${hints.join(', ')}\n\n`;
    if (t.inputs.length) {
      md += '**Inputs**\n\n| Name | Type | Required | Description |\n|---|---|---|---|\n';
      md += t.inputs.map((f) => `| \`${f.name}\` | ${cell(f.type)} | ${f.required ? 'yes' : 'no'}${f.default !== undefined ? ` (default \`${cell(JSON.stringify(f.default))}\`)` : ''} | ${cell(f.description)} |`).join('\n') + '\n\n';
    }
    if (t.outputs.length) {
      md += '**Output**\n\n| Field | Type | Description |\n|---|---|---|\n';
      md += t.outputs.map((f) => `| \`${f.name}\` | ${cell(f.type)} | ${cell(f.description)} |`).join('\n') + '\n\n';
    }
    for (const ex of t.examples) {
      md += `**Example**${ex.note ? ` — ${ex.note}` : ''}\n\n${fence(ex.input)}\n\n`;
      if (ex.output !== undefined) md += `Result:\n\n${fence(ex.output)}\n\n`;
    }
  }
}
writeFileSync(join(root, 'docs/tools.md'), md);

// ---------- tools.json ----------
writeFileSync(
  join(root, 'docs/tools.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, count: docs.length, groups: grouped.map(({ key, title, blurb, tools }) => ({ key, title, blurb, tools: tools.map(({ inputs, outputs, ...t }) => t) })) }),
);

// ---------- tools.html ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const linkify = (s) => esc(s).replace(/https:\/\/[^\s)<]+[^\s)<.,;]/g, (u) => `<a href="${u}">${u}</a>`);
let body = `<p class="lead">${docs.length} tools in ${grouped.length} groups. Every one runs on your machine. Click a tool for its inputs and an example.</p>
<input id="q" class="search" type="search" placeholder="Filter tools: pdf, resize, arabic, qr…" aria-label="Filter tools" autocomplete="off">
<nav class="chips">${grouped.map((g) => `<a href="#${g.key}">${esc(g.title)} <span>${g.tools.length}</span></a>`).join('')}</nav>`;
for (const g of grouped) {
  body += `<section class="group" id="${g.key}"><h2>${esc(g.title)}</h2><p class="muted">${esc(g.blurb)}</p>`;
  for (const t of g.tools) {
    body += `<details class="tool" id="${t.name}" data-q="${esc((t.name + ' ' + t.title + ' ' + t.description).toLowerCase())}"><summary><code>${t.name}</code><span>${esc(t.title)}</span></summary><div class="tool-body">`;
    body += `<p>${linkify(t.description)}</p>`;
    if (t.inputs.length) {
      body += '<table><thead><tr><th>Input</th><th>Type</th><th>Description</th></tr></thead><tbody>';
      body += t.inputs.map((f) => `<tr><td><code>${esc(f.name)}</code>${f.required ? ' <b class="req">required</b>' : ''}</td><td>${esc(f.type)}${f.default !== undefined ? `<br><small>default ${esc(JSON.stringify(f.default))}</small>` : ''}</td><td>${esc(f.description)}</td></tr>`).join('');
      body += '</tbody></table>';
    }
    for (const ex of t.examples) {
      body += `<p class="muted">Example${ex.note ? ': ' + esc(ex.note) : ''}</p><pre>${esc(JSON.stringify(ex.input, null, 2))}</pre>`;
      if (ex.output !== undefined) body += `<p class="muted">Result</p><pre>${esc(JSON.stringify(ex.output, null, 2))}</pre>`;
    }
    body += '</div></details>';
  }
  body += '</section>';
}
const tpl = readFileSync(join(root, 'docs/_template.html'), 'utf8');
const script = `<script>
const q=document.getElementById('q');q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
document.querySelectorAll('.tool').forEach(d=>{d.hidden=v&&!v.split(/\\s+/).every(w=>d.dataset.q.includes(w))});
document.querySelectorAll('.group').forEach(s=>{s.hidden=!s.querySelector('.tool:not([hidden])')})});
if(location.hash){const el=document.getElementById(location.hash.slice(1));if(el&&el.tagName==='DETAILS')el.open=true}
</script>`;
writeFileSync(
  join(root, 'docs/tools.html'),
  tpl.replace(/\{\{title\}\}/g, 'All tools').replace('{{description}}', `Reference for all ${docs.length} S3eidat Tools MCP tools: inputs, outputs and examples.`).replace('{{active-tools}}', ' aria-current="page"').replace(/\{\{active-[a-z]+\}\}/g, '').replace('{{body}}', `<h1>All tools</h1>${body}${script}`),
);

// ---------- llms.txt ----------
let llms = `# S3eidat Tools MCP\n\n> ${pkg.description}\n\n`;
llms += `Install: \`npx -y s3eidat-tools-mcp\` (stdio MCP server; \`--http\` for Streamable HTTP on 127.0.0.1:8787/mcp). Claude Code: \`claude mcp add s3eidat -- npx -y s3eidat-tools-mcp\`.\n`;
llms += 'File inputs: local path or base64. File outputs: written to the given `output` path (or a temp folder); results return the path. No network, no telemetry.\n\n';
llms += '## Docs\n\n- [README](https://github.com/s3eidat/s3eidat-tools-mcp#readme): install for every AI client\n- [Tools reference](https://s3eidat.github.io/s3eidat-tools-mcp/tools.md): every tool with inputs, outputs, examples\n- [Tools JSON](https://s3eidat.github.io/s3eidat-tools-mcp/tools.json): machine-readable schemas\n- [Skill](https://github.com/s3eidat/s3eidat-tools-mcp/tree/main/skills/s3eidat-tools): which tool for which job\n- [Web tools](https://s3eidat.github.io/): the same tools in the browser, for humans\n\n';
for (const g of grouped) {
  llms += `## ${g.title}\n\n` + g.tools.map((t) => `- \`${t.name}\`: ${t.title}${t.web ? ` (web: ${t.web})` : ''}`).join('\n') + '\n\n';
}
writeFileSync(join(root, 'docs/llms.txt'), llms);

// ---------- README tool count ----------
const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const table = grouped.map((g) => `| ${g.title} | ${g.tools.length} | ${g.tools.map((t) => '`' + t.name + '`').join(', ')} |`).join('\n');
const block = `<!-- tools:start -->\n**${docs.length} tools.** Full reference: [docs/tools.md](docs/tools.md).\n\n| Group | Count | Tools |\n|---|---|---|\n${table}\n<!-- tools:end -->`;
if (readme.includes('<!-- tools:start -->')) writeFileSync(readmePath, readme.replace(/<!-- tools:start -->[\s\S]*<!-- tools:end -->/, block));

console.log(`docs: ${docs.length} tools in ${grouped.length} groups → docs/tools.md, docs/tools.json, docs/tools.html, docs/llms.txt`);

// ---------- index.html + skill.html ----------
function page(title, description, active, html) {
  return tpl
    .replace(/\{\{title\}\}/g, esc(title))
    .replace('{{description}}', esc(description))
    .replace(`{{active-${active}}}`, ' aria-current="page"')
    .replace(/\{\{active-[a-z]+\}\}/g, '')
    .replace('{{body}}', html);
}
const cards = grouped.map((g) => `<a class="card" href="tools.html#${g.key}"><h3>${esc(g.title)} · ${g.tools.length}</h3><p>${esc(g.blurb)}</p></a>`).join('\n');
const indexBody = readFileSync(join(root, 'docs/_index.body.html'), 'utf8').replace(/\{\{count\}\}/g, String(docs.length)).replace('{{groups}}', cards);
writeFileSync(join(root, 'docs/index.html'), page('Free, private tools for your AI', `${docs.length} free tools for AI assistants (MCP): PDF, images, text, developer, calculators, QR. Runs locally; files never uploaded.`, 'home', indexBody));

/** Tiny Markdown → HTML for our own docs (headings, lists, code, tables, links, bold/italic). */
function mdToHtml(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = src.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { let code = ''; i++; while (i < lines.length && !/^```/.test(lines[i])) code += lines[i++] + '\n'; i++; html += `<pre>${esc(code)}</pre>`; continue; }
    const h = /^(#{1,4})\s+(.*)/.exec(l);
    if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cellsOf = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      html += '<table><thead><tr>' + cellsOf(rows[0]).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
        rows.slice(2).map((r) => '<tr>' + cellsOf(r).map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); let items = '';
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.)\s/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) item += ' ' + lines[i++].trim();
        items += `<li>${inline(item)}</li>`;
      }
      html += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`; continue;
    }
    if (!l.trim()) { i++; continue; }
    let para = l; i++;
    while (i < lines.length && lines[i].trim() && !/^(#|```|\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para += ' ' + lines[i++];
    html += `<p>${inline(para)}</p>`;
  }
  return html;
}
const skillMd = readFileSync(join(root, 'skills/s3eidat-tools/SKILL.md'), 'utf8');
const installMd = readFileSync(join(root, 'skills/README.md'), 'utf8');
writeFileSync(join(root, 'docs/skill.html'), page('Skill', 'A Claude skill that teaches AI assistants to use S3eidat Tools well.', 'skill',
  `<span class="pill">Claude skill</span>${mdToHtml(installMd)}<h2>The skill itself</h2><p class="muted">Source: <a href="https://github.com/s3eidat/s3eidat-tools-mcp/blob/main/skills/s3eidat-tools/SKILL.md">skills/s3eidat-tools/SKILL.md</a></p><div class="card">${mdToHtml(skillMd)}</div>`));
console.log('docs: index.html, skill.html');

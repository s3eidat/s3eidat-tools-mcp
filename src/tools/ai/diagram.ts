import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import { outputPath, returnBase64, writeOutput } from '../../util/files.js';
import { escapeXml, FONT_STACK, imageFormat, scaleSchema, svgToPng, textWidth } from './_svg.js';

const SHAPES = ['box', 'round', 'diamond', 'circle', 'ellipse'] as const;
type Shape = (typeof SHAPES)[number];
const DIRS = ['TB', 'LR', 'BT', 'RL'] as const;
type Dir = (typeof DIRS)[number];
type EdgeStyle = 'solid' | 'dashed' | 'thick';
type ArrowKind = 'end' | 'both' | 'none';

export interface DNode { id: string; label: string; shape: Shape; color?: string }
export interface DEdge { from: string; to: string; label?: string; style: EdgeStyle; arrow: ArrowKind }
export interface DGraph { direction: Dir; title?: string; nodes: DNode[]; edges: DEdge[] }

const MAX_NODES = 500, MAX_EDGES = 2000, MAX_SOURCE = 200_000;
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

// ---------- DSL parser ----------
type Tok = { t: 'id' | 'attrs' | 'arrow' | 'label'; v: string };
const ARROWS: [string, EdgeStyle, ArrowKind][] = [
  ['<->', 'solid', 'both'], ['-->', 'dashed', 'end'], ['==>', 'thick', 'end'], ['->', 'solid', 'end'], ['=>', 'thick', 'end'], ['---', 'solid', 'none'], ['--', 'solid', 'none'],
];

function unquote(s: string) {
  return s.replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
}

function tokenize(line: string, ln: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const err = (m: string) => new ToolError(`Line ${ln}: ${m}`);
  while (i < line.length) {
    const c = line[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ':') { toks.push({ t: 'label', v: line.slice(i + 1).trim().replace(/^"(.*)"$/s, '$1') }); break; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\' && j + 1 < line.length) { s += line[j] + line[j + 1]; j += 2; } else s += line[j++]; }
      if (j >= line.length) throw err('unclosed quote.');
      toks.push({ t: 'id', v: unquote(s) }); i = j + 1; continue;
    }
    if (c === '[') {
      let j = i + 1, q = false;
      while (j < line.length && (q || line[j] !== ']')) { if (line[j] === '"') q = !q; else if (line[j] === '\\') j++; j++; }
      if (j >= line.length) throw err('unclosed "[".');
      toks.push({ t: 'attrs', v: line.slice(i + 1, j) }); i = j + 1; continue;
    }
    const arrow = ARROWS.find(([a]) => line.startsWith(a, i));
    if (arrow) { toks.push({ t: 'arrow', v: arrow[0] }); i += arrow[0].length; continue; }
    const m = /^[\p{L}\p{N}_.$&]+/u.exec(line.slice(i));
    if (!m) throw err(`unexpected "${c}".`);
    toks.push({ t: 'id', v: m[0] }); i += m[0].length;
  }
  return toks;
}

function parseAttrs(s: string, ln: number) {
  const out: Record<string, string> = {};
  const re = /\s*([A-Za-z_-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^,\s\]]+)\s*,?/gy;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(s))) { out[m[1].toLowerCase()] = m[3] !== undefined ? unquote(m[3]) : m[2]; last = re.lastIndex; }
  if (s.slice(last).trim()) throw new ToolError(`Line ${ln}: can't read attributes "[${s}]" (use [shape=box, label="Text", color=#fde68a]).`);
  return out;
}

/** Parse the diagram DSL into nodes and edges. */
export function parseDsl(src: string): DGraph {
  if (src.length > MAX_SOURCE) throw new ToolError(`The diagram source is over ${MAX_SOURCE / 1000} KB.`);
  const g: DGraph = { direction: 'TB', nodes: [], edges: [] };
  const byId = new Map<string, DNode>();
  const node = (id: string) => {
    let n = byId.get(id);
    if (!n) { n = { id, label: id, shape: 'round' }; byId.set(id, n); g.nodes.push(n); }
    return n;
  };
  src.split(/\r?\n/).forEach((raw, idx) => {
    const ln = idx + 1;
    const line = raw.replace(/^\s*(#|\/\/).*$/, '').trim();
    if (!line) return;
    let m = /^(?:direction|rankdir)\s*[:=]?\s*(LR|RL|TB|BT|TD)\s*;?$/i.exec(line);
    if (m) { const d = m[1].toUpperCase(); g.direction = (d === 'TD' ? 'TB' : d) as Dir; return; }
    m = /^title\s*:\s*(.+)$/i.exec(line);
    if (m) { g.title = m[1].trim().replace(/^"(.*)"$/s, '$1'); return; }
    const toks = tokenize(line.replace(/;\s*$/, ''), ln);
    let label: string | undefined;
    if (toks.at(-1)?.t === 'label') label = toks.pop()!.v;
    const chain: string[] = [], arrows: string[] = [];
    let expectNode = true;
    for (const tk of toks) {
      if (tk.t === 'id') {
        if (!expectNode) throw new ToolError(`Line ${ln}: expected an arrow (->) before "${tk.v}".`);
        node(tk.v); chain.push(tk.v); expectNode = false;
      } else if (tk.t === 'attrs') {
        if (expectNode || !chain.length) throw new ToolError(`Line ${ln}: attributes must follow a node name.`);
        const a = parseAttrs(tk.v, ln), n = node(chain.at(-1)!);
        if (a.label !== undefined) n.label = a.label;
        if (a.shape !== undefined) {
          const s = a.shape.toLowerCase() === 'rect' ? 'box' : a.shape.toLowerCase();
          if (!(SHAPES as readonly string[]).includes(s)) throw new ToolError(`Line ${ln}: unknown shape "${a.shape}" (use ${SHAPES.join(', ')}).`);
          n.shape = s as Shape;
        }
        const col = a.color ?? a.fill;
        if (col !== undefined) n.color = col;
      } else if (tk.t === 'arrow') {
        if (expectNode) throw new ToolError(`Line ${ln}: an arrow needs a node on both sides.`);
        arrows.push(tk.v); expectNode = true;
      }
    }
    if (expectNode && arrows.length) throw new ToolError(`Line ${ln}: an arrow needs a node on both sides.`);
    if (label !== undefined && !arrows.length) {
      if (chain.length === 1) { node(chain[0]).label = label; return; }
      throw new ToolError(`Line ${ln}: a ":" label belongs on an edge (A -> B: label).`);
    }
    for (let i = 0; i < arrows.length; i++) {
      const [, style, arrow] = ARROWS.find(([a]) => a === arrows[i])!;
      g.edges.push({ from: chain[i], to: chain[i + 1], style, arrow, ...(label !== undefined && i === arrows.length - 1 ? { label } : {}) });
    }
  });
  return g;
}

// ---------- layout + SVG ----------
const FS = 14, LH = 18, PADX = 16, PADY = 10, EFS = 12;

const THEMES = {
  light: { bg: '#ffffff', text: '#1e293b', edge: '#475569', title: '#0f172a',
    shape: { box: ['#eef2ff', '#6366f1'], round: ['#eef2ff', '#6366f1'], diamond: ['#fef3c7', '#d97706'], circle: ['#dcfce7', '#16a34a'], ellipse: ['#e0f2fe', '#0284c7'] } },
  dark: { bg: '#0f172a', text: '#e2e8f0', edge: '#94a3b8', title: '#f8fafc',
    shape: { box: ['#1e293b', '#818cf8'], round: ['#1e293b', '#818cf8'], diamond: ['#3b2f12', '#f59e0b'], circle: ['#14301f', '#22c55e'], ellipse: ['#0c2a3d', '#38bdf8'] } },
} as const;

function normHex(c: string) {
  const h = c.replace('#', '');
  return '#' + (h.length === 3 ? h.split('').map((x) => x + x).join('') : h).toLowerCase();
}
function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  return '#' + [16, 8, 0].map((s) => Math.round(((n >> s) & 255) * k).toString(16).padStart(2, '0')).join('');
}
function lum(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

type Pt = { x: number; y: number };
/** Where the ray from the node centre towards `p` leaves the node's shape. */
function boundary(n: { x: number; y: number; width: number; height: number }, shape: Shape, p: Pt): Pt {
  const ux = p.x - n.x, uy = p.y - n.y, a = n.width / 2, b = n.height / 2;
  if (!ux && !uy) return { x: n.x, y: n.y };
  let t: number;
  if (shape === 'diamond') t = 1 / (Math.abs(ux) / a + Math.abs(uy) / b);
  else if (shape === 'circle' || shape === 'ellipse') t = 1 / Math.sqrt((ux / a) ** 2 + (uy / b) ** 2);
  else t = 1 / Math.max(Math.abs(ux) / a, Math.abs(uy) / b);
  return { x: n.x + ux * t, y: n.y + uy * t };
}

const f1 = (v: number) => Math.round(v * 10) / 10;

function arrowHead(tip: Pt, from: Pt, color: string, size: number) {
  const dx = tip.x - from.x, dy = tip.y - from.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, w = size * 0.5;
  const bx = tip.x - ux * size, by = tip.y - uy * size;
  return `<path d="M${f1(tip.x)},${f1(tip.y)}L${f1(bx - uy * w)},${f1(by + ux * w)}L${f1(bx + uy * w)},${f1(by - ux * w)}Z" fill="${color}"/>`;
}

/** Lay the graph out with dagre and draw it as SVG. */
export async function renderDiagram(g: DGraph, theme: 'light' | 'dark' = 'light') {
  if (!g.nodes.length) throw new ToolError('The diagram has no nodes.');
  if (g.nodes.length > MAX_NODES) throw new ToolError(`Too many nodes (${g.nodes.length}; max ${MAX_NODES}).`);
  if (g.edges.length > MAX_EDGES) throw new ToolError(`Too many edges (${g.edges.length}; max ${MAX_EDGES}).`);
  const T = THEMES[theme];
  const dagre = (await import('@dagrejs/dagre')).default;
  const gr = new dagre.graphlib.Graph({ multigraph: true });
  gr.setGraph({ rankdir: g.direction, nodesep: 40, ranksep: 56, edgesep: 16, marginx: 24, marginy: 24 });
  gr.setDefaultEdgeLabel(() => ({}));
  const shapeOf = new Map<string, Shape>();
  for (const n of g.nodes) {
    const lines = n.label.split('\n');
    const tw = Math.max(...lines.map((l) => textWidth(l, FS))), th = lines.length * LH;
    let w = Math.max(tw + 2 * PADX, 64), h = Math.max(th + 2 * PADY, 38);
    if (n.shape === 'diamond') { w = Math.max(tw * 1.6 + 2 * PADX, 80); h = Math.max(th * 1.8 + 2 * PADY, 56); }
    if (n.shape === 'circle') { w = h = Math.max(Math.hypot(tw, th) + 2 * PADY, 48); }
    if (n.shape === 'ellipse') { w = Math.max(tw * 1.3 + 2 * PADX, 72); h = Math.max(th * 1.4 + 2 * PADY, 44); }
    gr.setNode(n.id, { width: w, height: h });
    shapeOf.set(n.id, n.shape);
  }
  g.edges.forEach((e, i) => {
    for (const id of [e.from, e.to]) if (!gr.hasNode(id)) throw new ToolError(`Edge ${e.from} -> ${e.to}: unknown node "${id}".`);
    const lab = e.label ? { width: Math.max(...e.label.split('\n').map((l) => textWidth(l, EFS))) + 10, height: e.label.split('\n').length * 15 + 4, labelpos: 'c' } : {};
    gr.setEdge(e.from, e.to, { ...lab, minlen: 1 }, `e${i}`);
  });
  dagre.layout(gr);
  const gl = gr.graph() as { width?: number; height?: number };
  const titleH = g.title ? 40 : 0;
  const W = Math.ceil(Math.max(gl.width ?? 0, g.title ? textWidth(g.title, 18, true) + 48 : 0));
  const H = Math.ceil((gl.height ?? 0) + titleH);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT_STACK}'>`);
  parts.push(`<rect width="100%" height="100%" fill="${T.bg}"/>`);
  if (g.title) parts.push(`<text x="24" y="30" font-size="18" font-weight="bold" fill="${T.title}">${escapeXml(g.title)}</text>`);
  parts.push(`<g transform="translate(0,${titleH})">`);
  // Edges first, so nodes sit on top.
  g.edges.forEach((e, i) => {
    const ed = gr.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points: Pt[]; x?: number; y?: number };
    const a = gr.node(e.from) as { x: number; y: number; width: number; height: number };
    const b = gr.node(e.to) as { x: number; y: number; width: number; height: number };
    let pts = ed.points.map((p) => ({ ...p }));
    if (e.from === e.to) {
      // Self loop: a small arc on the right side.
      const r = Math.min(a.height / 2, 18);
      pts = [{ x: a.x + a.width / 2, y: a.y - r / 2 }, { x: a.x + a.width / 2 + r * 2, y: a.y - r }, { x: a.x + a.width / 2 + r * 2, y: a.y + r }, { x: a.x + a.width / 2, y: a.y + r / 2 }];
    } else {
      const n = pts.length;
      pts[0] = boundary(a, shapeOf.get(e.from)!, n > 2 ? pts[1] : b);
      pts[n - 1] = boundary(b, shapeOf.get(e.to)!, n > 2 ? pts[n - 2] : a);
    }
    const color = T.edge, width = e.style === 'thick' ? 2.6 : 1.5, ah = e.style === 'thick' ? 11 : 9;
    const n = pts.length;
    const heads: string[] = [];
    // Shorten the line under each arrowhead so the stroke doesn't poke through the tip.
    const shorten = (tip: Pt, prev: Pt) => {
      const dx = tip.x - prev.x, dy = tip.y - prev.y, len = Math.hypot(dx, dy) || 1, k = Math.min(ah * 0.8, len / 2) / len;
      return { x: tip.x - dx * k, y: tip.y - dy * k };
    };
    const line = pts.map((p) => ({ ...p }));
    if (e.arrow !== 'none') { heads.push(arrowHead(pts[n - 1], pts[n - 2], color, ah)); line[n - 1] = shorten(pts[n - 1], pts[n - 2]); }
    if (e.arrow === 'both') { heads.push(arrowHead(pts[0], pts[1], color, ah)); line[0] = shorten(pts[0], pts[1]); }
    let d = `M${f1(line[0].x)},${f1(line[0].y)}`;
    if (n === 2) d += `L${f1(line[1].x)},${f1(line[1].y)}`;
    else {
      for (let k = 1; k < n - 1; k++) {
        const mid = k === n - 2 ? line[n - 1] : { x: (line[k].x + line[k + 1].x) / 2, y: (line[k].y + line[k + 1].y) / 2 };
        d += `Q${f1(line[k].x)},${f1(line[k].y)} ${f1(mid.x)},${f1(mid.y)}`;
      }
    }
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${e.style === 'dashed' ? ' stroke-dasharray="6 4"' : ''} stroke-linecap="round" stroke-linejoin="round"/>`);
    parts.push(...heads);
    if (e.label) {
      const lines = e.label.split('\n');
      const lw = Math.max(...lines.map((l) => textWidth(l, EFS))) + 10, lh = lines.length * 15 + 4;
      const cx = e.from === e.to ? a.x + a.width / 2 + 40 + lw / 2 : ed.x ?? (pts[0].x + pts[n - 1].x) / 2;
      const cy = e.from === e.to ? a.y : ed.y ?? (pts[0].y + pts[n - 1].y) / 2;
      parts.push(`<rect x="${f1(cx - lw / 2)}" y="${f1(cy - lh / 2)}" width="${f1(lw)}" height="${f1(lh)}" rx="4" fill="${T.bg}" fill-opacity="0.92"/>`);
      lines.forEach((l, k) => parts.push(`<text x="${f1(cx)}" y="${f1(cy - lh / 2 + 2 + 15 * k + 11)}" font-size="${EFS}" text-anchor="middle" fill="${T.text}">${escapeXml(l)}</text>`));
    }
  });
  for (const n of g.nodes) {
    const p = gr.node(n.id) as { x: number; y: number; width: number; height: number };
    let fill: string = T.shape[n.shape][0], stroke: string = T.shape[n.shape][1], text: string = T.text;
    if (n.color) {
      if (!HEX.test(n.color)) throw new ToolError(`Node "${n.id}": color must be a hex colour like #fde68a.`);
      fill = normHex(n.color); stroke = shade(fill, 0.6); text = lum(fill) > 0.55 ? '#111827' : '#f9fafb';
    }
    const x = p.x - p.width / 2, y = p.y - p.height / 2, st = `fill="${fill}" stroke="${stroke}" stroke-width="1.5"`;
    if (n.shape === 'box') parts.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(p.width)}" height="${f1(p.height)}" rx="3" ${st}/>`);
    else if (n.shape === 'round') parts.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(p.width)}" height="${f1(p.height)}" rx="${f1(Math.min(12, p.height / 2))}" ${st}/>`);
    else if (n.shape === 'diamond') parts.push(`<path d="M${f1(p.x)},${f1(y)}L${f1(x + p.width)},${f1(p.y)}L${f1(p.x)},${f1(y + p.height)}L${f1(x)},${f1(p.y)}Z" ${st}/>`);
    else parts.push(`<ellipse cx="${f1(p.x)}" cy="${f1(p.y)}" rx="${f1(p.width / 2)}" ry="${f1(p.height / 2)}" ${st}/>`);
    const lines = n.label.split('\n');
    const top = p.y - (lines.length * LH) / 2;
    lines.forEach((l, k) => parts.push(`<text x="${f1(p.x)}" y="${f1(top + LH * k + LH / 2 + FS * 0.35)}" font-size="${FS}" text-anchor="middle" fill="${text}">${escapeXml(l)}</text>`));
  }
  parts.push('</g></svg>');
  return { svg: parts.join('\n'), width: W, height: H };
}

const jsonGraph = z.object({
  direction: z.enum(DIRS).optional(),
  title: z.string().max(200).optional(),
  nodes: z.array(z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    shape: z.enum(SHAPES).optional(),
    color: z.string().optional().describe('Fill colour, hex.'),
  })).max(MAX_NODES).optional().default([]),
  edges: z.array(z.object({
    from: z.string().min(1), to: z.string().min(1), label: z.string().optional(),
    style: z.enum(['solid', 'dashed', 'thick']).optional(), arrow: z.enum(['end', 'both', 'none']).optional(),
  })).max(MAX_EDGES).optional().default([]),
});

function fromJson(j: z.infer<typeof jsonGraph>): DGraph {
  const g: DGraph = { direction: j.direction ?? 'TB', title: j.title, nodes: [], edges: [] };
  const seen = new Map<string, DNode>();
  const add = (id: string) => { let n = seen.get(id); if (!n) { n = { id, label: id, shape: 'round' }; seen.set(id, n); g.nodes.push(n); } return n; };
  for (const n of j.nodes) { const d = add(n.id); if (n.label !== undefined) d.label = n.label; if (n.shape) d.shape = n.shape; if (n.color) d.color = n.color; }
  for (const e of j.edges) { add(e.from); add(e.to); g.edges.push({ from: e.from, to: e.to, label: e.label, style: e.style ?? 'solid', arrow: e.arrow ?? 'end' }); }
  return g;
}

export default defineTool({
  name: 'ai_diagram',
  title: 'Diagram to SVG/PNG',
  description:
    'Draw a flowchart / graph diagram from a tiny text language and save it as SVG or PNG, laid out automatically (dagre). ' +
    'One statement per line: `direction: LR` (TB, LR, BT, RL), `title: My flow`, `A [shape=diamond, label="Ready?", color=#fde68a]` ' +
    '(shapes: box, round, diamond, circle, ellipse), edges `A -> B: label`, chains `A -> B -> C`, `-->` dashed, `==>` thick, `<->` both ends, `--` no arrow; ' +
    'quote names with spaces ("Start here" -> A); `\\n` in labels breaks lines; # starts a comment. Or pass JSON { nodes: [{id, label, shape, color}], edges: [{from, to, label, style, arrow}] } as "graph". ' +
    `Up to ${MAX_NODES} nodes and ${MAX_EDGES} edges. Labels use Helvetica/Arial metrics (Latin text is measured best).`,
  inputSchema: z.object({
    source: z.string().max(MAX_SOURCE).optional().describe('Diagram text in the DSL (or a JSON graph as text).'),
    graph: jsonGraph.optional().describe('The diagram as JSON instead of "source".'),
    direction: z.enum(DIRS).optional().describe('Override the layout direction: TB (top-bottom, default), LR, BT, RL.'),
    theme: z.enum(['light', 'dark']).optional().default('light'),
    format: imageFormat(),
    scale: scaleSchema(),
    output: outputPath(),
    returnBase64: returnBase64(),
  }),
  outputSchema: z.object({
    path: z.string(), bytes: z.number(), mimeType: z.string().optional(), base64: z.string().optional(),
    format: z.string(), width: z.number(), height: z.number(), nodes: z.number(), edges: z.number(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { source: 'direction: LR\nStart [shape=circle]\nCheck [shape=diamond, label="Valid?"]\nStart -> Check\nCheck -> Done: yes\nCheck -> Fix: no\nFix --> Check' }, output: { format: 'svg', nodes: 4, edges: 4 } },
    { input: { graph: { nodes: [{ id: 'a', label: 'Client' }, { id: 'b', label: 'Server', shape: 'box' }], edges: [{ from: 'a', to: 'b', label: 'HTTPS', arrow: 'both' }] }, format: 'png' }, output: { format: 'png', nodes: 2, edges: 1 } },
  ],
  async run(input, ctx) {
    let g: DGraph;
    if (input.graph) {
      if (input.source) throw new ToolError('Give either "source" or "graph", not both.');
      g = fromJson(input.graph);
    } else if (input.source?.trim()) {
      const s = input.source.trim();
      if (s.startsWith('{')) {
        let j: unknown;
        try { j = JSON.parse(s); } catch (e) { throw new ToolError(`"source" looks like JSON but doesn't parse: ${(e as Error).message}`); }
        const r = jsonGraph.safeParse(j);
        if (!r.success) throw new ToolError(`Invalid JSON graph: ${r.error.issues[0]?.message}`);
        g = fromJson(r.data);
      } else g = parseDsl(s);
    } else throw new ToolError('Give the diagram as "source" (DSL text) or "graph" (JSON).');
    if (input.direction) g.direction = input.direction;
    const { svg, width, height } = await renderDiagram(g, input.theme);
    const name = (g.title || 'diagram').slice(0, 60);
    const counts = { nodes: g.nodes.length, edges: g.edges.length };
    if (input.format === 'png') {
      const r = await svgToPng(svg, input.scale);
      const out = await writeOutput(r.png, { output: input.output, defaultName: `${name}.png`, mimeType: 'image/png', base64: input.returnBase64 }, ctx);
      return { ...out, format: 'png', width: r.width, height: r.height, ...counts };
    }
    const out = await writeOutput(svg, { output: input.output, defaultName: `${name}.svg`, mimeType: 'image/svg+xml', base64: input.returnBase64 }, ctx);
    return { ...out, format: 'svg', width, height, ...counts };
  },
});

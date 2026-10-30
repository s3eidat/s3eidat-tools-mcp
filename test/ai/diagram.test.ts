import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import diagram, { parseDsl, renderDiagram } from '../../src/tools/ai/diagram.js';
import { call, tempCtx } from '../helpers.js';

const ctx = tempCtx();
type Out = { path: string; format: string; width: number; height: number; nodes: number; edges: number };

const SRC = `
# a small flow
direction: LR
title: Order flow
Start [shape=circle]
Check [shape=diamond, label="Paid?"]
"Ship it" [shape=box, color=#bbf7d0]
Start -> Check
Check -> "Ship it": yes
Check --> Remind: no
Remind -> Check
A -> B -> C
`;

describe('ai_diagram DSL', () => {
  it('parses nodes, attributes, chains and edge styles', () => {
    const g = parseDsl(SRC);
    expect(g.direction).toBe('LR');
    expect(g.title).toBe('Order flow');
    expect(g.nodes.map((n) => n.id)).toEqual(['Start', 'Check', 'Ship it', 'Remind', 'A', 'B', 'C']);
    expect(g.nodes[1]).toEqual({ id: 'Check', label: 'Paid?', shape: 'diamond' });
    expect(g.nodes[2].color).toBe('#bbf7d0');
    expect(g.edges).toHaveLength(6);
    expect(g.edges[1]).toEqual({ from: 'Check', to: 'Ship it', style: 'solid', arrow: 'end', label: 'yes' });
    expect(g.edges[2]).toMatchObject({ from: 'Check', to: 'Remind', style: 'dashed', label: 'no' });
    expect(g.edges.slice(4).map((e) => `${e.from}>${e.to}`)).toEqual(['A>B', 'B>C']);
  });

  it('reports bad lines with their number', () => {
    expect(() => parseDsl('A ->')).toThrow(/Line 1/);
    expect(() => parseDsl('A\nB [shape=star]')).toThrow(/Line 2: unknown shape/);
  });

  it('lays out left-to-right: each rank is further right', async () => {
    const { svg, width, height } = await renderDiagram(parseDsl('direction: LR\nA -> B -> C'));
    const xs = [...svg.matchAll(/<text x="([\d.]+)"[^>]*>([ABC])<\/text>/g)].map((m) => [m[2], Number(m[1])] as const);
    expect(xs.map((x) => x[0])).toEqual(['A', 'B', 'C']);
    expect(xs[0][1]).toBeLessThan(xs[1][1]);
    expect(xs[1][1]).toBeLessThan(xs[2][1]);
    expect(width).toBeGreaterThan(height);
  });
});

describe('ai_diagram tool', () => {
  it('writes an SVG with every label, shape and arrowhead', async () => {
    const r = await call<Out>(diagram, { source: SRC }, ctx);
    expect([r.format, r.nodes, r.edges]).toEqual(['svg', 7, 6]);
    const svg = readFileSync(r.path, 'utf8');
    expect(svg.startsWith('<svg')).toBe(true);
    for (const t of ['Order flow', 'Paid?', 'Ship it', 'Remind', '>yes<', '>no<']) expect(svg).toContain(t);
    expect(svg).toContain('<ellipse'); // circle
    expect(svg).toContain('stroke-dasharray'); // dashed edge
    expect(svg).toContain('fill="#bbf7d0"');
    expect((svg.match(/<path d="M[^"]*Z" fill="#475569"\/>/g) ?? []).length).toBe(6); // one arrowhead per edge
  });

  it('accepts a JSON graph and renders PNG', async () => {
    const r = await call<Out>(diagram, {
      graph: { nodes: [{ id: 'a', label: 'Client' }, { id: 'b', label: 'Server', shape: 'box' }], edges: [{ from: 'a', to: 'b', label: 'HTTPS', arrow: 'both' }] },
      format: 'png', scale: 2, theme: 'dark',
    }, ctx);
    const png = readFileSync(r.path);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([r.nodes, r.edges]).toEqual([2, 1]);
    const svg = await call<Out>(diagram, { graph: { nodes: [{ id: 'a', label: 'Client' }, { id: 'b', label: 'Server', shape: 'box' }], edges: [{ from: 'a', to: 'b', label: 'HTTPS', arrow: 'both' }] } }, ctx);
    expect(r.width).toBe(svg.width * 2);
  });
});

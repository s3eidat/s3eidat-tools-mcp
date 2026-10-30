import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import chart, { inferType, simpleToVegaLite } from '../../src/tools/ai/chart.js';
import { call, tempCtx } from '../helpers.js';

const ctx = tempCtx();
type Out = { path: string; bytes: number; format: string; width: number; height: number; mimeType?: string };
const rows = [{ month: 'Jan', sales: 12, cost: 5 }, { month: 'Feb', sales: 19, cost: 8 }, { month: 'Mar', sales: 7, cost: 4 }];

describe('ai_chart', () => {
  it('infers field types', () => {
    expect(inferType(rows, 'sales')).toBe('quantitative');
    expect(inferType(rows, 'month')).toBe('nominal');
    expect(inferType([{ d: '2026-01-02' }, { d: '2026-02-03' }], 'd')).toBe('temporal');
  });

  it('builds Vega-Lite from the simple form', () => {
    const s = simpleToVegaLite({ type: 'line', data: rows, x: 'month', y: ['sales', 'cost'] }) as { transform: unknown; encoding: { color: { field: string } } };
    expect(s.transform).toEqual([{ fold: ['sales', 'cost'], as: ['series', 'value'] }]);
    expect(s.encoding.color.field).toBe('series');
    expect(() => simpleToVegaLite({ type: 'bar', data: rows, x: 'nope', y: 'sales' })).toThrow(/not in the data/);
  });

  it('renders a bar chart to SVG with the labels in it', async () => {
    const r = await call<Out>(chart, { type: 'bar', data: rows, x: 'month', y: 'sales', title: 'Monthly sales' }, ctx);
    const svg = readFileSync(r.path, 'utf8');
    expect(svg.startsWith('<svg')).toBe(true);
    for (const t of ['Monthly sales', 'Jan', 'Feb', 'Mar', 'sales']) expect(svg).toContain(t);
    // Three bars whose heights are proportional to the values (12 : 19 : 7).
    const bars = [...svg.matchAll(/<path aria-label="month: (\w+); sales: (\d+)"[^>]*aria-roledescription="bar" d="M[\d.]+,[\d.]+h[\d.]+v([\d.]+)h/g)];
    expect(bars.map((m) => [m[1], Number(m[2])])).toEqual([['Jan', 12], ['Feb', 19], ['Mar', 7]]);
    const heights = bars.map((m) => Number(m[3]));
    expect(heights[0] / heights[1]).toBeCloseTo(12 / 19, 2);
    expect(heights[2] / heights[1]).toBeCloseTo(7 / 19, 2);
    expect(r.width).toBeGreaterThan(600);
  });

  it('renders a pie chart and a raw Vega-Lite spec to PNG', async () => {
    const pie = await call<Out>(chart, { type: 'pie', data: [{ k: 'A', v: 3 }, { k: 'B', v: 1 }], x: 'k', y: 'v', format: 'png', scale: 1 }, ctx);
    const png = readFileSync(pie.path);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(pie.mimeType).toBe('image/png');
    const spec = { data: { values: rows }, mark: 'point', encoding: { x: { field: 'sales', type: 'quantitative' }, y: { field: 'cost', type: 'quantitative' } } };
    const r = await call<Out>(chart, { spec, format: 'png', scale: 2 }, ctx);
    const r1 = await call<Out>(chart, { spec, format: 'svg' }, ctx);
    expect(readFileSync(r.path).subarray(1, 4).toString()).toBe('PNG');
    expect(r.width).toBe(r1.width * 2);
  });

  it('refuses specs that load data from a URL', async () => {
    await expect(call(chart, { spec: { data: { url: 'https://example.com/x.csv' }, mark: 'bar' } }, ctx)).rejects.toThrow(/not allowed/);
    await expect(call(chart, { spec: { data: { url: 'C:/secret.json' }, mark: 'bar' } }, ctx)).rejects.toThrow(/not allowed/);
  });
});

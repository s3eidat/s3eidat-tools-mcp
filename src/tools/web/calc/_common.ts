/**
 * Shared helpers for the calculator ports (src/tools/web/calc/*). Not a tool (leading underscore).
 */
import { z } from 'zod';
import { ToolError } from '../../../registry.js';

/**
 * The website's number parser: accepts "250,000", "6.5", Arabic-Indic and Persian digits, the Arabic decimal mark (٫),
 * thousands marks (٬ , _ space), a leading minus sign (−), a trailing % and exponents. NaN when it is not a number.
 */
export function num(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, '.')
    .replace(/[,\s_٬%]/g, '')
    .replace(/^[−–]/, '-');
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? parseFloat(s) : NaN;
}

/** Zod: a number, or a string the website would accept ("1,200", "٦٫٥"). */
export const numLike = (desc: string) => z.union([z.number(), z.string()]).describe(desc);
export const optNumLike = (desc: string) => z.union([z.number(), z.string()]).optional().describe(desc);

/** Parse a number-like input; empty/undefined gives `dflt` (when given), anything unreadable is a ToolError. */
export function need(v: number | string | undefined, field: string, dflt?: number): number {
  if (v === undefined || (typeof v === 'string' && !v.trim())) {
    if (dflt !== undefined) return dflt;
    throw new ToolError(`"${field}" is required.`);
  }
  const n = num(v);
  if (!Number.isFinite(n)) throw new ToolError(`"${field}" is not a number: ${JSON.stringify(v)}`);
  return n;
}

/** 12 significant digits hides float noise (0.1 + 0.2 → 0.3). NaN/±Infinity become null for JSON. */
export function clean(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  const r = Number(v.toPrecision(12));
  return Object.is(r, -0) ? 0 : r;
}

/** Round to `d` decimals the way the site's money display does (after removing binary noise). */
export function round(v: number, d = 2): number {
  const p = 10 ** d;
  const r = Math.round(Number((v * p).toPrecision(12))) / p;
  return Object.is(r, -0) ? 0 : r;
}

/** en-US grouping with fixed decimals: 1234.5 → "1,234.50". */
export function money(v: number, d = 2): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export const ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

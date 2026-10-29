import { expect } from 'vitest';
import type { ToolModule } from '../../../src/registry.js';
import { call } from '../../helpers.js';

/** Call a calculator tool, check its result against its outputSchema and that it survives JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function run<T = any>(tool: ToolModule, input: unknown): Promise<T> {
  const r = await call<Record<string, unknown>>(tool, input);
  if (tool.outputSchema) tool.outputSchema.parse(r);
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  return r as T;
}

/** Expect the tool to fail with a message matching `re`. */
export async function fails(tool: ToolModule, input: unknown, re: RegExp) {
  await expect(call(tool, input)).rejects.toThrow(re);
}

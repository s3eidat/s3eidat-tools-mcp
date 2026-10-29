import { describe, expect, it } from 'vitest';
import { call } from '../../helpers.js';
import tool, { CODE, decode, encode, timeline } from '../../../src/tools/web/text/morse-code.js';

// Known answers copied verbatim from the website's S3_SELFTEST (morse-code/app.js); the tap-key cases are not ported.
describe('text_morse', () => {
  it('matches the website self-test', () => {
    const t: [unknown, unknown][] = [
      [encode("SOS").morse, "... --- ..."],
      [encode("Hello World").morse, ".... . .-.. .-.. --- / .-- --- .-. .-.. -.."],
      [encode("é!").morse, ". -.-.--"],
      [encode("A مرحبا B").skipped, 5],
      [decode(".... ..  /  - .... . .-. .").text, "HI THERE"],
      [decode("•••  −−−  •••").text, "S O S"],
      [decode("...|---").text, "S O"],
      [decode("........").bad, 1],
      [decode(encode("Morse 2026, ok?").morse).text, "MORSE 2026, OK?"],
      [timeline(".").total, 1],
      [timeline(".-").total, 5],                 // dot 1 + gap 1 + dash 3
      [timeline(". .").total, 5],                // 1 + letter gap 3 + 1
      [timeline(". / .").total, 9],              // 1 + word gap 7 + 1
    ];
    expect(Object.keys(CODE)).toHaveLength(54);
    t.forEach((p) => expect(p[0]).toBe(p[1]));
  });

  it('runs as a tool', async () => {
    for (const ex of tool.examples!) expect(await call(tool, ex.input)).toEqual(ex.output);
    const r = await call<{ mode: string; result: string }>(tool, { text: 'Hello World' });
    expect(r).toMatchObject({ mode: 'encode', result: '.... . .-.. .-.. --- / .-- --- .-. .-.. -..' });
    const d = await call<{ mode: string; result: string }>(tool, { text: '... --- ...' });
    expect(d).toMatchObject({ mode: 'decode', result: 'SOS' });
  });
});

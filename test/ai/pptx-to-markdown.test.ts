import PptxGen from 'pptxgenjs';
import { describe, expect, it } from 'vitest';
import tool, { xmlText } from '../../src/tools/ai/pptx-to-markdown.js';
import { call, tempCtx } from '../helpers.js';

// CommonJS build: the class is the default import at runtime; the typings put it one level down.
const PptxGenJS = ((PptxGen as unknown as { default?: unknown }).default ?? PptxGen) as typeof PptxGen.default;

type R = { markdown?: string; slideCount: number; slides: { slide: number; title?: string; hasNotes: boolean }[] };
const b64 = (b: Uint8Array) => 'base64:' + Buffer.from(b).toString('base64');

async function sampleDeck() {
  const pptx = new PptxGenJS();
  pptx.defineSlideMaster({
    title: 'TITLED',
    objects: [{ placeholder: { options: { name: 'title', type: 'title', x: 0.5, y: 0.3, w: 9, h: 1 }, text: '' } }],
  });
  const s1 = pptx.addSlide({ masterName: 'TITLED' });
  s1.addText('Q3 Results & Plans', { placeholder: 'title' });
  s1.addText('Revenue grew <10% but costs fell.', { x: 0.5, y: 1.5, w: 9, h: 1 });
  s1.addText(
    [
      { text: 'New shop', options: { bullet: true, breakLine: true } },
      { text: 'Online orders', options: { bullet: true, indentLevel: 1, breakLine: true } },
      { text: 'Hire two bakers', options: { bullet: { type: 'number' }, breakLine: true } },
      { text: 'Open on Sundays', options: { bullet: { type: 'number' } } },
    ],
    { x: 0.5, y: 2.6, w: 9, h: 2 },
  );
  s1.addNotes('Mention the new oven.');
  const s2 = pptx.addSlide();
  s2.addText('Numbers', { x: 0.5, y: 0.3, w: 9, h: 1 });
  s2.addTable([[{ text: 'Region' }, { text: 'Sales' }], [{ text: 'North' }, { text: '120' }]], { x: 0.5, y: 1.5, w: 6 });
  const s3 = pptx.addSlide();
  s3.addText('Thanks', { x: 1, y: 1, w: 8, h: 1 });
  s3.addText('Questions?', { x: 1, y: 2, w: 8, h: 1 });
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

describe('ai_pptx_to_markdown', () => {
  it('extracts titles, text, bullets, tables and notes in slide order', async () => {
    const r = await call<R>(tool, { file: b64(await sampleDeck()) }, tempCtx());
    expect(r.slideCount).toBe(3);
    expect(r.slides).toEqual([
      { slide: 1, title: 'Q3 Results & Plans', hasNotes: true },
      { slide: 2, title: 'Numbers', hasNotes: false },
      { slide: 3, title: 'Thanks', hasNotes: false },
    ]);
    expect(r.markdown).toBe(
      '## Slide 1: Q3 Results & Plans\n\nRevenue grew <10% but costs fell.\n\n- New shop\n  - Online orders\n1. Hire two bakers\n2. Open on Sundays\n\n' +
        '**Notes:**\n\n> Mention the new oven.\n\n' +
        '## Slide 2: Numbers\n\n| Region | Sales |\n| --- | --- |\n| North | 120 |\n\n' +
        '## Slide 3: Thanks\n\nQuestions?\n',
    );
  });

  it('honours slide ranges and notes: false, rejects non-pptx', async () => {
    const ctx = tempCtx();
    const r = await call<R>(tool, { file: b64(await sampleDeck()), slides: '1', notes: false }, ctx);
    expect(r.slides.map((s) => s.slide)).toEqual([1]);
    expect(r.markdown).not.toContain('Notes');
    expect(r.markdown).not.toContain('Slide 2');
    await expect(call(tool, { file: b64(await sampleDeck()), slides: '9' }, ctx)).rejects.toThrow(/outside 1-3/);
    await expect(call(tool, { file: b64(Buffer.from('hello there')) }, ctx)).rejects.toThrow(/Not a \.pptx/);
  });

  it('decodes XML entities', () => {
    expect(xmlText('a &amp; b &lt;c&gt; &#233;&#x2713; &quot;q&quot;')).toBe('a & b <c> é✓ "q"');
  });
});

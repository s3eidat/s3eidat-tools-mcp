import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import mediaInfo, { hms } from '../../src/tools/ai/media-info.js';
import { call, tempCtx } from '../helpers.js';

const ctx = tempCtx();

/** A valid PCM WAV: `seconds` of a 440 Hz tone, with an optional RIFF INFO tag list (INAM title, IART artist). */
function wav(seconds: number, rate = 8000, channels = 1, tags?: { INAM?: string; IART?: string }) {
  const n = Math.round(seconds * rate), bytesPer = 2 * channels, dataLen = n * bytesPer;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * bytesPer, 16); fmt.writeUInt16LE(bytesPer, 20); fmt.writeUInt16LE(16, 22);
  let list = Buffer.alloc(0);
  if (tags) {
    const subs = Object.entries(tags).map(([id, text]) => {
      const body = Buffer.from(text + '\0', 'latin1'), pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
      const h = Buffer.alloc(8); h.write(id, 0); h.writeUInt32LE(body.length, 4);
      return Buffer.concat([h, body, pad]);
    });
    const inner = Buffer.concat([Buffer.from('INFO'), ...subs]);
    const h = Buffer.alloc(8); h.write('LIST', 0); h.writeUInt32LE(inner.length, 4);
    list = Buffer.concat([h, inner]);
  }
  const data = Buffer.alloc(8 + dataLen);
  data.write('data', 0); data.writeUInt32LE(dataLen, 4);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 8 + i * bytesPer + c * 2);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0); riff.writeUInt32LE(4 + fmt.length + list.length + data.length, 4); riff.write('WAVE', 8);
  return Buffer.concat([riff, fmt, list, data]);
}

type Out = { name: string; fileSize: number; container: string; codec: string; lossless: boolean; durationSeconds: number; duration: string; bitrate: number; sampleRate: number; bitsPerSample: number; channels: number; tags: Record<string, unknown>; hasCoverArt: boolean; numberOfSamples: number };

describe('ai_media_info', () => {
  it('formats durations', () => {
    expect([hms(1), hms(61.5), hms(3725)]).toEqual(['0:01', '1:01.5', '1:02:05']);
  });

  it('reads a 1-second mono 16-bit 8 kHz WAV from a path', async () => {
    const p = join(ctx.outDir, 'tone.wav');
    const bytes = wav(1, 8000, 1, { INAM: 'Test Tone', IART: 'S3eidat' });
    writeFileSync(p, bytes);
    const r = await call<Out>(mediaInfo, { file: p }, ctx);
    expect(r).toMatchObject({
      name: 'tone.wav', fileSize: bytes.length, container: 'WAVE', codec: 'PCM', lossless: true,
      durationSeconds: 1, duration: '0:01', sampleRate: 8000, bitsPerSample: 16, channels: 1, bitrate: 128000, numberOfSamples: 8000, hasCoverArt: false,
    });
    expect(r.tags).toMatchObject({ title: 'Test Tone', artist: 'S3eidat' });
  });

  it('reads stereo WAV from base64, and rejects non-media', async () => {
    const r = await call<Out>(mediaInfo, { file: 'base64:' + wav(0.5, 44100, 2).toString('base64') }, ctx);
    expect(r).toMatchObject({ durationSeconds: 0.5, sampleRate: 44100, channels: 2, bitrate: 1411200 });
    await expect(call(mediaInfo, { file: 'base64:' + Buffer.from('hello, this is not audio at all, just some text bytes').toString('base64') }, ctx)).rejects.toThrow();
  });
});

import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolError } from '../../registry.js';
import { fileInput, readInput, resolvePath } from '../../util/files.js';

/** 61.5 -> "1:01.5", 3725 -> "1:02:05". */
export function hms(sec: number) {
  const t = Math.round(sec * 1000) / 1000;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = Math.round((t - h * 3600 - m * 60) * 1000) / 1000;
  const ss = (r < 10 ? '0' : '') + String(r);
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Matroska track type codes (music-metadata's TrackType). */
const TRACK_TYPES: Record<number, string> = { 1: 'video', 2: 'audio', 3: 'complex', 16: 'logo', 17: 'subtitle', 18: 'buttons', 32: 'control' };

const tagsShape = z.object({
  title: z.string().optional(), artist: z.string().optional(), album: z.string().optional(), albumArtist: z.string().optional(),
  year: z.number().optional(), date: z.string().optional(), genre: z.array(z.string()).optional(), track: z.number().optional(),
  trackOf: z.number().optional(), disk: z.number().optional(), comment: z.string().optional(), composer: z.string().optional(),
});

export default defineTool({
  name: 'ai_media_info',
  title: 'Audio/video metadata',
  description:
    'Read audio and video file metadata offline (music-metadata): container, codec, duration, bitrate, sample rate, bit depth, channels, lossless or not, ' +
    'tags (title, artist, album, year, genre, track…), embedded cover art, and per-track info (including video width/height for MP4/MKV/WebM). ' +
    'Formats: MP3, AAC/M4A/MP4/MOV, FLAC, WAV, AIFF, OGG/Opus/Vorbis, WebM/Matroska, WMA/ASF, APE, WavPack, DSD and more. ' +
    'File path (streamed, any size) or base64. Duration of VBR MP3s without a header is computed by scanning the file.',
  inputSchema: z.object({
    file: fileInput('audio or video file'),
  }),
  outputSchema: z.object({
    name: z.string(), fileSize: z.number(),
    container: z.string().nullable(), codec: z.string().nullable(), codecProfile: z.string().optional(), lossless: z.boolean().nullable(),
    durationSeconds: z.number().nullable(), duration: z.string().nullable().describe('Duration as m:ss or h:mm:ss.'),
    bitrate: z.number().nullable().describe('Bits per second.'), sampleRate: z.number().nullable(), bitsPerSample: z.number().nullable(),
    channels: z.number().nullable(), numberOfSamples: z.number().optional(), tool: z.string().optional(),
    tagTypes: z.array(z.string()), tags: tagsShape,
    hasCoverArt: z.boolean(), coverArt: z.array(z.object({ format: z.string(), bytes: z.number(), type: z.string().optional() })),
    tracks: z.array(z.object({ type: z.string().optional(), codec: z.string().optional(), language: z.string().optional(), width: z.number().optional(), height: z.number().optional(), sampleRate: z.number().optional(), channels: z.number().optional() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { file: 'song.mp3' }, note: 'Duration, bitrate, codec, ID3 tags and cover art presence.' }],
  async run(input, ctx) {
    const mm = await import('music-metadata');
    const opts = { duration: true, skipCovers: false };
    const v = input.file.trim();
    let meta: Awaited<ReturnType<typeof mm.parseFile>>;
    let name: string, fileSize: number;
    try {
      const abs = !/^(data:|base64:)/.test(v) && v.length < 4096 ? await resolvePath(v, ctx).catch(() => undefined) : undefined;
      if (abs && existsSync(abs) && statSync(abs).isFile()) {
        name = basename(abs); fileSize = statSync(abs).size;
        meta = await mm.parseFile(abs, opts);
      } else {
        const f = await readInput(v, ctx, 'file');
        name = f.name; fileSize = f.bytes.length;
        meta = await mm.parseBuffer(new Uint8Array(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength), f.mimeType ? { mimeType: f.mimeType } : undefined, opts);
      }
    } catch (e) {
      if (e instanceof ToolError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ToolError(/MIME-type|unsupported|guess/i.test(msg) ? `Not a recognised audio/video format (${msg}).` : `Couldn't read the media file: ${msg}`);
    }
    const f = meta.format, c = meta.common;
    const pics = c.picture ?? [];
    const tags: z.infer<typeof tagsShape> = {};
    if (c.title) tags.title = c.title;
    if (c.artist) tags.artist = c.artist;
    if (c.album) tags.album = c.album;
    if (c.albumartist) tags.albumArtist = c.albumartist;
    if (c.year) tags.year = c.year;
    if (c.date) tags.date = c.date;
    if (c.genre?.length) tags.genre = c.genre;
    if (c.track?.no) tags.track = c.track.no;
    if (c.track?.of) tags.trackOf = c.track.of;
    if (c.disk?.no) tags.disk = c.disk.no;
    if (c.comment?.length) tags.comment = c.comment.map((x) => (typeof x === 'string' ? x : x.text ?? '')).filter(Boolean).join('\n') || undefined;
    if (c.composer?.length) tags.composer = c.composer.join(', ');
    if (tags.comment === undefined) delete tags.comment;
    const typeName = (t?: number) => (t === undefined ? undefined : TRACK_TYPES[t] ?? String(t));
    const tracks = (f.trackInfo ?? []).map((t) => {
      const o: { type?: string; codec?: string; language?: string; width?: number; height?: number; sampleRate?: number; channels?: number } = {};
      const ty = typeName(t.type); if (ty) o.type = ty;
      if (t.codecName) o.codec = t.codecName;
      if (t.language) o.language = t.language;
      if (t.video?.pixelWidth) o.width = t.video.pixelWidth;
      if (t.video?.pixelHeight) o.height = t.video.pixelHeight;
      if (t.audio?.samplingFrequency) o.sampleRate = t.audio.samplingFrequency;
      if (t.audio?.channels) o.channels = t.audio.channels;
      return o;
    });
    const out = {
      name, fileSize,
      container: f.container ?? null, codec: f.codec ?? null,
      ...(f.codecProfile ? { codecProfile: f.codecProfile } : {}),
      lossless: f.lossless ?? null,
      durationSeconds: f.duration !== undefined ? Math.round(f.duration * 1000) / 1000 : null,
      duration: f.duration !== undefined ? hms(f.duration) : null,
      bitrate: f.bitrate !== undefined ? Math.round(f.bitrate) : null,
      sampleRate: f.sampleRate ?? null, bitsPerSample: f.bitsPerSample ?? null, channels: f.numberOfChannels ?? null,
      ...(f.numberOfSamples !== undefined ? { numberOfSamples: f.numberOfSamples } : {}),
      ...(f.tool ? { tool: f.tool } : {}),
      tagTypes: [...(f.tagTypes ?? [])].map(String), tags,
      hasCoverArt: pics.length > 0,
      coverArt: pics.map((p) => ({ format: p.format, bytes: p.data.length, ...(p.type ? { type: p.type } : {}) })),
      tracks,
    };
    return out;
  },
});

import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { CITY_IDS, findCity } from './_cities.js';

// Ported from https://github.com/s3eidat/qibla-finder (app.js): great-circle initial bearing and haversine
// distance to the Kaaba, same constants, compass points and turn instructions.
export const KAABA = { lat: 21.4225, lon: 39.8262 };
const R_KM = 6371.0088;
const rad = Math.PI / 180;

export function bearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lon2 - lon1) * rad;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
const P16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
// Arabic 8-point compass, copied from the website as escapes: north, north-east, east, south-east, south, south-west, west, north-west.
const P8AR = ['شمال', 'شمال شرق', 'شرق', 'جنوب شرق', 'جنوب', 'جنوب غرب', 'غرب', 'شمال غرب'];
export const point16 = (b: number) => P16[Math.round(b / 22.5) % 16];
export const point8ar = (b: number) => P8AR[Math.round(b / 45) % 8];
export const turn = (b: number) => (b <= 180 ? { dir: 'right' as const, deg: b } : { dir: 'left' as const, deg: 360 - b });
/** Signed difference a − b in degrees, −180..180. */
export const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

const r1 = (n: number) => Math.round(n * 10) / 10;

export default defineTool({
  name: 'qibla_direction',
  title: 'Qibla direction',
  webSlug: 'qibla-finder',
  description:
    'Qibla direction (great-circle bearing from true north to the Kaaba in Makkah) and distance from any coordinates or a ' +
    'known city, with the compass point, a "face north, then turn right/left N°" instruction, and (if you give a device ' +
    'heading) how far to turn. Bearings are from TRUE north; a magnetic compass can differ by a few degrees. ' +
    `Web version: ${webUrl('qibla-finder')}`,
  inputSchema: z.object({
    latitude: z.number().min(-90).max(90).optional().describe('Latitude in degrees (−90..90).'),
    longitude: z.number().min(-180).max(180).optional().describe('Longitude in degrees (−180..180).'),
    city: z.string().optional().describe(`Or a known city: ${CITY_IDS.join(', ')}.`),
    heading: z.number().min(0).lt(360).optional().describe('Optional: the direction you are facing now (degrees from north) to get a turn instruction.'),
  }),
  outputSchema: z.object({
    latitude: z.number(), longitude: z.number(), place: z.string().optional(),
    bearing: z.number().describe('Degrees clockwise from true north, 1 decimal.'),
    direction: z.string().describe('16-point compass direction, e.g. SSE.'),
    directionAr: z.string().describe('8-point compass direction in Arabic.'),
    distanceKm: z.number().describe('Great-circle distance to the Kaaba, rounded km.'),
    atKaaba: z.boolean(),
    turnFromNorth: z.object({ direction: z.enum(['right', 'left']), degrees: z.number() }),
    instruction: z.string(),
    fromHeading: z.object({ aligned: z.boolean(), turn: z.enum(['right', 'left', 'none']), degrees: z.number() }).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { city: 'amman' }, output: { bearing: 160.7, direction: 'SSE', distanceKm: 1234 }, note: 'Face north, then turn clockwise 160.7°' },
    { input: { latitude: 51.5074, longitude: -0.1278 }, note: 'London: about 119° (ESE)' },
  ],
  run(input) {
    let lat = input.latitude, lon = input.longitude, place: string | undefined;
    if (input.city) {
      const c = findCity(input.city);
      if (!c) throw new ToolError(`Unknown city "${input.city}". Known: ${CITY_IDS.join(', ')}. Or give latitude and longitude.`);
      lat = c.lat; lon = c.lon; place = c.en;
    }
    if (lat == null || lon == null) throw new ToolError('Give latitude and longitude (or a city).');
    const b = bearing(lat, lon, KAABA.lat, KAABA.lon), km = distanceKm(lat, lon, KAABA.lat, KAABA.lon), here = km < 0.05;
    const tr = turn(b), pt = point16(b);
    const out: Record<string, unknown> = {
      latitude: lat, longitude: lon, ...(place ? { place } : {}),
      bearing: r1(b), direction: pt, directionAr: point8ar(b), distanceKm: Math.round(km), atKaaba: here,
      turnFromNorth: { direction: tr.dir, degrees: r1(tr.deg) },
      instruction: here ? 'You are at the Kaaba.'
        : `Face north, then turn ${tr.dir === 'right' ? 'clockwise (to your right)' : 'counter-clockwise (to your left)'} by ${r1(tr.deg)}°. You are then facing the Qibla (${pt}).`,
    };
    if (input.heading != null) {
      const diff = angDiff(b, input.heading), aligned = Math.abs(diff) <= 5;
      out.fromHeading = { aligned, turn: aligned ? 'none' : diff > 0 ? 'right' : 'left', degrees: Math.round(Math.abs(diff)) };
    }
    return out;
  },
});

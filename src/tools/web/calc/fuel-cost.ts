import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';

// Ported from https://github.com/s3eidat/fuel-cost (app.js): everything is converted to litres and kilometres internally.
export const KM_PER_MI = 1.609344, L_PER_GALUS = 3.785411784, L_PER_GALUK = 4.54609;
export type ConsUnit = 'l100' | 'kml' | 'mpgus' | 'mpguk';
export const UNITS: Record<ConsUnit, string> = { l100: 'L/100 km', kml: 'km/L', mpgus: 'mpg (US)', mpguk: 'mpg (UK)' };

/** Any consumption → litres per 100 km. */
export function toL100(v: number, unit: ConsUnit) {
  if (!(v > 0)) return null;
  if (unit === 'l100') return v;
  if (unit === 'kml') return 100 / v;
  if (unit === 'mpgus') return (100 * L_PER_GALUS) / (v * KM_PER_MI);
  if (unit === 'mpguk') return (100 * L_PER_GALUK) / (v * KM_PER_MI);
  return null;
}
export function fromL100(l: number, unit: ConsUnit) {
  if (!(l > 0)) return null;
  if (unit === 'l100') return l;
  if (unit === 'kml') return 100 / l;
  if (unit === 'mpgus') return (100 * L_PER_GALUS) / (l * KM_PER_MI);
  if (unit === 'mpguk') return (100 * L_PER_GALUK) / (l * KM_PER_MI);
  return null;
}
export const pricePerLitre = (p: number, unit: 'L' | 'galUS' | 'galUK') => (unit === 'galUS' ? p / L_PER_GALUS : unit === 'galUK' ? p / L_PER_GALUK : p);
export function trip(o: { km: number; l100: number; ppl: number; people: number }) {
  const litres = (o.km * o.l100) / 100, cost = litres * o.ppl;
  return { litres, cost, each: cost / Math.max(1, o.people), perKm: o.km ? cost / o.km : 0 };
}
/** The site's lenient parser: "7,5" and "7.5" are both 7.5; Arabic-Indic digits. */
export function num(v: unknown) {
  const s = String(v == null ? '' : v).trim().replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u066b,]/g, '.').replace(/\s/g, '');
  return /^\d*\.?\d+$|^\d+\.$/.test(s) ? parseFloat(s) : null;
}

const fmt = (n: number, d: number) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const r2 = (v: number) => Math.round(v * 100) / 100;
const numIn = (d: string) => z.union([z.number(), z.string()]).describe(d);
const consUnit = z.enum(['l100', 'kml', 'mpgus', 'mpguk']);

export default defineTool({
  name: 'calc_fuel_cost',
  title: 'Fuel cost of a trip',
  webSlug: 'fuel-cost',
  description:
    'Fuel needed and cost of a trip from distance (km or miles, optionally round trip), fuel price (per litre, US gallon or ' +
    'UK gallon) and consumption in L/100 km, km/L, mpg (US) or mpg (UK); split between people; cost per km/mile and per 100. ' +
    'Optionally compare a second car (its own consumption and, if different, fuel price). Also converts the consumption to ' +
    `the other units. Web version: ${webUrl('fuel-cost')}`,
  inputSchema: z.object({
    distance: numIn('Trip distance (one way unless roundTrip).'),
    distanceUnit: z.enum(['km', 'mi']).optional().default('km').describe('Distance unit.'),
    roundTrip: z.boolean().optional().default(false).describe('Double the distance (there and back).'),
    price: numIn('Fuel price per priceUnit.'),
    priceUnit: z.enum(['L', 'galUS', 'galUK']).optional().default('L').describe('The price is per litre, US gallon or UK gallon.'),
    consumption: numIn('Car consumption / economy, e.g. 7.5 (L/100 km) or 35 (mpg).'),
    consumptionUnit: consUnit.optional().default('l100').describe('l100 = L/100 km, kml = km/L, mpgus, mpguk.'),
    people: z.number().int().min(1).max(99).optional().default(1).describe('Split the cost between this many people.'),
    currency: z.string().max(6).optional().describe('Currency label for the text, e.g. "JD" or "$".'),
    name: z.string().max(30).optional().describe('Name of the car (default "Car A").'),
    compare: z.object({
      consumption: numIn('Second car consumption.'),
      consumptionUnit: consUnit.optional().default('l100').describe('Its consumption unit (l100, kml, mpgus, mpguk).'),
      price: z.union([z.number(), z.string()]).optional().describe('Its fuel price if different (same priceUnit).'),
      name: z.string().max(30).optional().describe('Name (default "Car B").'),
    }).optional().describe('Optional second car to compare.'),
  }),
  outputSchema: z.object({
    distanceKm: z.number(), litres: z.number(), gallons: z.number(), gallonUnit: z.string(), cost: z.number(), costEach: z.number(),
    costPerDistanceUnit: z.number(), costPer100: z.number(), pricePerLitre: z.number(), l100km: z.number(),
    consumptionIn: z.record(z.string(), z.number()),
    compare: z.object({ name: z.string(), l100km: z.number(), litres: z.number(), cost: z.number(), costEach: z.number(), cheaper: z.string().nullable(), saving: z.number(), savingPercent: z.number(), text: z.string() }).optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { distance: 335, roundTrip: true, price: 0.9, consumption: 10.5, people: 3, currency: 'JD' }, note: '70.35 L, cost 63.32, 21.11 each' }],
  run(input) {
    const dist = num(input.distance), price = num(input.price), cons = num(input.consumption);
    const lA = cons == null ? null : toL100(cons, input.consumptionUnit);
    if (!(dist !== null && dist > 0)) throw new ToolError('Enter a distance above 0.');
    if (price == null) throw new ToolError('Enter the fuel price.');
    if (!lA) throw new ToolError('Enter a consumption above 0.');
    const mi = input.distanceUnit === 'mi', people = input.people;
    const km = dist * (mi ? KM_PER_MI : 1) * (input.roundTrip ? 2 : 1), ppl = pricePerLitre(price, input.priceUnit);
    const a = trip({ km, l100: lA, ppl, people }), nameA = input.name?.trim() || 'Car A';
    const galUnit = input.priceUnit === 'galUK' ? L_PER_GALUK : L_PER_GALUS, galName = input.priceUnit === 'galUK' ? 'UK gal' : 'US gal';
    const c = input.currency?.trim(), money = (n: number) => (c ? c + ' ' : '') + fmt(n, n < 1000 ? 2 : 0);
    const out: Record<string, unknown> = {
      distanceKm: r2(km), litres: r2(a.litres), gallons: r2(a.litres / galUnit), gallonUnit: galName, cost: r2(a.cost), costEach: r2(a.each),
      costPerDistanceUnit: Number((a.perKm * (mi ? KM_PER_MI : 1)).toFixed(4)), costPer100: r2(a.perKm * 100 * (mi ? KM_PER_MI : 1)), pricePerLitre: Number(ppl.toFixed(4)),
      l100km: Number(lA.toFixed(3)),
      consumptionIn: Object.fromEntries((Object.keys(UNITS) as ConsUnit[]).map((u) => [u, Number(fromL100(lA, u)!.toFixed(2))])),
    };
    let text = 'Trip: ' + fmt(km / (mi ? KM_PER_MI : 1), 0) + (mi ? ' miles' : ' km') + (input.roundTrip ? ' (round trip)' : '') + ', ' + nameA + ' at ' + fmt(lA, 1) + ' L/100 km: ' +
      fmt(a.litres, 1) + ' L = ' + money(a.cost) + (people > 1 ? ' (' + money(a.each) + ' each for ' + people + ')' : '');
    if (input.compare) {
      const cb = num(input.compare.consumption), lB = cb == null ? null : toL100(cb, input.compare.consumptionUnit);
      if (!lB) throw new ToolError('Enter a consumption above 0 for the second car.');
      const pB = input.compare.price === undefined ? null : num(input.compare.price);
      const b = trip({ km, l100: lB, ppl: pB != null ? pricePerLitre(pB, input.priceUnit) : ppl, people });
      const nameB = input.compare.name?.trim() || 'Car B', diff = b.cost - a.cost, same = Math.abs(diff) < 0.005, cheaper = diff < 0 ? nameB : nameA;
      const pct = (Math.abs(diff) / Math.max(a.cost, b.cost)) * 100;
      const line = same ? 'Both cost the same for this trip.' : cheaper + ' saves ' + money(Math.abs(diff)) + ' on this trip (' + fmt(pct, 0) + '% less).';
      out.compare = { name: nameB, l100km: Number(lB.toFixed(3)), litres: r2(b.litres), cost: r2(b.cost), costEach: r2(b.each), cheaper: same ? null : cheaper, saving: r2(Math.abs(diff)), savingPercent: Math.round(pct), text: line };
      text += '\n' + nameB + ' at ' + fmt(lB, 1) + ' L/100 km: ' + money(b.cost) + '. ' + line;
    }
    out.summary = text;
    return out;
  },
});

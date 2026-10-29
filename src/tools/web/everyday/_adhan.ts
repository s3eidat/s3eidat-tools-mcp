/**
 * Prayer-time astronomy: a line-by-line TypeScript port of adhan.js (MIT, Batoul Apps), the exact build the website
 * ships in prayer-times/lib/adhan.min.js, so every time matches the website to the second.
 *
 * Differences from the library are only in plumbing: the calendar day is passed as {y, m, d} instead of a local
 * `Date` (adhan only ever reads a date's year/month/day), and the polar-circle resolution (unused by the website,
 * always "Unresolved") is left out.
 */

export type Madhab = 'shafi' | 'hanafi';
export type HighLatitudeRule = 'middleofthenight' | 'seventhofthenight' | 'twilightangle';
export type Rounding = 'nearest' | 'up' | 'none';
export type Shafaq = 'general' | 'ahmer' | 'abyad';
export type PrayerKey = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';
export type Adjustments = Record<PrayerKey, number>;

export interface Coordinates { latitude: number; longitude: number }
export interface Ymd { y: number; m: number; d: number }

const zeroAdj = (): Adjustments => ({ fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 });

export const recommendedHighLatitudeRule = (c: Coordinates): HighLatitudeRule =>
  c.latitude > 48 ? 'seventhofthenight' : 'middleofthenight';

export class CalculationParameters {
  madhab: Madhab = 'shafi';
  highLatitudeRule: HighLatitudeRule = 'middleofthenight';
  adjustments: Adjustments = zeroAdj();
  methodAdjustments: Adjustments = zeroAdj();
  rounding: Rounding = 'nearest';
  shafaq: Shafaq = 'general';
  constructor(
    public method: string,
    public fajrAngle = 0,
    public ishaAngle = 0,
    public ishaInterval = 0,
    public maghribAngle = 0,
  ) {}
  nightPortions() {
    switch (this.highLatitudeRule) {
      case 'middleofthenight': return { fajr: 1 / 2, isha: 1 / 2 };
      case 'seventhofthenight': return { fajr: 1 / 7, isha: 1 / 7 };
      case 'twilightangle': return { fajr: this.fajrAngle / 60, isha: this.ishaAngle / 60 };
      default: throw new Error('Invalid high latitude rule: ' + this.highLatitudeRule);
    }
  }
}

export const CalculationMethod = {
  MuslimWorldLeague() { const p = new CalculationParameters('MuslimWorldLeague', 18, 17); p.methodAdjustments.dhuhr = 1; return p; },
  Egyptian() { const p = new CalculationParameters('Egyptian', 19.5, 17.5); p.methodAdjustments.dhuhr = 1; return p; },
  Karachi() { const p = new CalculationParameters('Karachi', 18, 18); p.methodAdjustments.dhuhr = 1; return p; },
  UmmAlQura() { return new CalculationParameters('UmmAlQura', 18.5, 0, 90); },
  Dubai() { const p = new CalculationParameters('Dubai', 18.2, 18.2); p.methodAdjustments = { ...p.methodAdjustments, sunrise: -3, dhuhr: 3, asr: 3, maghrib: 3 }; return p; },
  MoonsightingCommittee() { const p = new CalculationParameters('MoonsightingCommittee', 18, 18); p.methodAdjustments = { ...p.methodAdjustments, dhuhr: 5, maghrib: 3 }; return p; },
  NorthAmerica() { const p = new CalculationParameters('NorthAmerica', 15, 15); p.methodAdjustments.dhuhr = 1; return p; },
  Kuwait() { return new CalculationParameters('Kuwait', 18, 17.5); },
  Qatar() { return new CalculationParameters('Qatar', 18, 0, 90); },
  Singapore() { const p = new CalculationParameters('Singapore', 20, 18); p.methodAdjustments.dhuhr = 1; p.rounding = 'up'; return p; },
  Tehran() { return new CalculationParameters('Tehran', 17.7, 14, 0, 4.5); },
  Turkey() { const p = new CalculationParameters('Turkey', 18, 17); p.methodAdjustments = { ...p.methodAdjustments, sunrise: -7, dhuhr: 5, asr: 4, maghrib: 7 }; return p; },
  Other() { return new CalculationParameters('Other', 0, 0); },
};

// ---------- math ----------
const degreesToRadians = (d: number) => (d * Math.PI) / 180;
const radiansToDegrees = (r: number) => (r * 180) / Math.PI;
const normalizeToScale = (n: number, max: number) => n - max * Math.floor(n / max);
const unwindAngle = (a: number) => normalizeToScale(a, 360);
const quadrantShiftAngle = (a: number) => (a >= -180 && a <= 180 ? a : a - 360 * Math.round(a / 360));
const isLeapYear = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

const addSeconds = (t: Date, s: number) => new Date(t.getTime() + s * 1000);
const addMinutes = (t: Date, m: number) => addSeconds(t, m * 60);
function roundedMinute(t: Date, rounding: Rounding = 'nearest') {
  const s = t.getUTCSeconds();
  let offset = s >= 30 ? 60 - s : -1 * s;
  if (rounding === 'up') offset = 60 - s;
  else if (rounding === 'none') offset = 0;
  return addSeconds(t, offset);
}
export function addDays(x: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(x.y, x.m - 1, x.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function dayOfYear(x: Ymd) {
  const days = [31, isLeapYear(x.y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let n = 0;
  for (let i = 0; i < x.m - 1; i++) n += days[i];
  return n + x.d;
}
const isValidDate = (d: Date) => !isNaN(d.valueOf());

// ---------- astronomical ----------
const Astro = {
  meanSolarLongitude: (T: number) => unwindAngle(280.4664567 + 36000.76983 * T + 0.0003032 * Math.pow(T, 2)),
  meanLunarLongitude: (T: number) => unwindAngle(218.3165 + 481267.8813 * T),
  ascendingLunarNodeLongitude: (T: number) => unwindAngle(125.04452 - 1934.136261 * T + 0.0020708 * Math.pow(T, 2) + Math.pow(T, 3) / 450000),
  meanSolarAnomaly: (T: number) => unwindAngle(357.52911 + 35999.05029 * T - 0.0001537 * Math.pow(T, 2)),
  solarEquationOfTheCenter(T: number, M: number) {
    const Mr = degreesToRadians(M);
    return (1.914602 - 0.004817 * T - 0.000014 * Math.pow(T, 2)) * Math.sin(Mr) + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) + 0.000289 * Math.sin(3 * Mr);
  },
  apparentSolarLongitude(T: number, L0: number) {
    const omega = 125.04 - 1934.136 * T;
    return unwindAngle(L0 + Astro.solarEquationOfTheCenter(T, Astro.meanSolarAnomaly(T)) - 0.00569 - 0.00478 * Math.sin(degreesToRadians(omega)));
  },
  meanObliquityOfTheEcliptic: (T: number) => 23.439291 - 0.013004167 * T - 0.0000001639 * Math.pow(T, 2) + 0.0000005036 * Math.pow(T, 3),
  apparentObliquityOfTheEcliptic: (T: number, e0: number) => e0 + 0.00256 * Math.cos(degreesToRadians(125.04 - 1934.136 * T)),
  meanSiderealTime(T: number) {
    const JD = T * 36525 + 2451545;
    return unwindAngle(280.46061837 + 360.98564736629 * (JD - 2451545) + 0.000387933 * Math.pow(T, 2) - Math.pow(T, 3) / 38710000);
  },
  nutationInLongitude: (_T: number, L0: number, Lp: number, O: number) =>
    (-17.2 / 3600) * Math.sin(degreesToRadians(O)) - (1.32 / 3600) * Math.sin(2 * degreesToRadians(L0)) -
    (0.23 / 3600) * Math.sin(2 * degreesToRadians(Lp)) + (0.21 / 3600) * Math.sin(2 * degreesToRadians(O)),
  nutationInObliquity: (_T: number, L0: number, Lp: number, O: number) =>
    (9.2 / 3600) * Math.cos(degreesToRadians(O)) + (0.57 / 3600) * Math.cos(2 * degreesToRadians(L0)) +
    (0.1 / 3600) * Math.cos(2 * degreesToRadians(Lp)) - (0.09 / 3600) * Math.cos(2 * degreesToRadians(O)),
  altitudeOfCelestialBody(phi: number, delta: number, H: number) {
    const t1 = Math.sin(degreesToRadians(phi)) * Math.sin(degreesToRadians(delta));
    const t2 = Math.cos(degreesToRadians(phi)) * Math.cos(degreesToRadians(delta)) * Math.cos(degreesToRadians(H));
    return radiansToDegrees(Math.asin(t1 + t2));
  },
  approximateTransit: (L: number, Theta0: number, a2: number) => normalizeToScale((a2 + -1 * L - Theta0) / 360, 1),
  correctedTransit(m0: number, L: number, Theta0: number, a2: number, a1: number, a3: number) {
    const Lw = -1 * L;
    const Theta = unwindAngle(Theta0 + 360.985647 * m0);
    const a = unwindAngle(Astro.interpolateAngles(a2, a1, a3, m0));
    const H = quadrantShiftAngle(Theta - Lw - a);
    return (m0 + H / -360) * 24;
  },
  correctedHourAngle(m0: number, h0: number, c: Coordinates, afterTransit: boolean, Theta0: number,
    a2: number, a1: number, a3: number, d2: number, d1: number, d3: number) {
    const Lw = -1 * c.longitude;
    const term1 = Math.sin(degreesToRadians(h0)) - Math.sin(degreesToRadians(c.latitude)) * Math.sin(degreesToRadians(d2));
    const term2 = Math.cos(degreesToRadians(c.latitude)) * Math.cos(degreesToRadians(d2));
    const H0 = radiansToDegrees(Math.acos(term1 / term2));
    const m = afterTransit ? m0 + H0 / 360 : m0 - H0 / 360;
    const Theta = unwindAngle(Theta0 + 360.985647 * m);
    const a = unwindAngle(Astro.interpolateAngles(a2, a1, a3, m));
    const delta = Astro.interpolate(d2, d1, d3, m);
    const H = Theta - Lw - a;
    const h = Astro.altitudeOfCelestialBody(c.latitude, delta, H);
    const term3 = h - h0;
    const term4 = 360 * Math.cos(degreesToRadians(delta)) * Math.cos(degreesToRadians(c.latitude)) * Math.sin(degreesToRadians(H));
    return (m + term3 / term4) * 24;
  },
  interpolate(y2: number, y1: number, y3: number, n: number) {
    const a = y2 - y1, b = y3 - y2, c = b - a;
    return y2 + (n / 2) * (a + b + n * c);
  },
  interpolateAngles(y2: number, y1: number, y3: number, n: number) {
    const a = unwindAngle(y2 - y1), b = unwindAngle(y3 - y2), c = b - a;
    return y2 + (n / 2) * (a + b + n * c);
  },
  julianDay(year: number, month: number, day: number, hours = 0) {
    const trunc = Math.trunc;
    const Y = trunc(month > 2 ? year : year - 1), M = trunc(month > 2 ? month : month + 12), D = day + hours / 24;
    const A = trunc(Y / 100), B = trunc(2 - A + trunc(A / 4));
    const i0 = trunc(365.25 * (Y + 4716)), i1 = trunc(30.6001 * (M + 1));
    return i0 + i1 + D + B - 1524.5;
  },
  julianCentury: (JD: number) => (JD - 2451545.0) / 36525,
  seasonAdjustedMorningTwilight(latitude: number, day: number, year: number, sunrise: Date) {
    const L = Math.abs(latitude);
    const a = 75 + (28.65 / 55.0) * L, b = 75 + (19.44 / 55.0) * L, c = 75 + (32.74 / 55.0) * L, d = 75 + (48.1 / 55.0) * L;
    const adj = piecewise(Astro.daysSinceSolstice(day, year, latitude), a, b, c, d);
    return addSeconds(sunrise, Math.round(adj * -60.0));
  },
  seasonAdjustedEveningTwilight(latitude: number, day: number, year: number, sunset: Date, shafaq: Shafaq) {
    const L = Math.abs(latitude);
    let a: number, b: number, c: number, d: number;
    if (shafaq === 'ahmer') { a = 62 + (17.4 / 55.0) * L; b = 62 - (7.16 / 55.0) * L; c = 62 + (5.12 / 55.0) * L; d = 62 + (19.44 / 55.0) * L; }
    else if (shafaq === 'abyad') { a = 75 + (25.6 / 55.0) * L; b = 75 + (7.16 / 55.0) * L; c = 75 + (36.84 / 55.0) * L; d = 75 + 1.488 * L; }
    else { a = 75 + (25.6 / 55.0) * L; b = 75 + (2.05 / 55.0) * L; c = 75 - (9.21 / 55.0) * L; d = 75 + (6.14 / 55.0) * L; }
    const adj = piecewise(Astro.daysSinceSolstice(day, year, latitude), a, b, c, d);
    return addSeconds(sunset, Math.round(adj * 60.0));
  },
  daysSinceSolstice(dayOfYear: number, year: number, latitude: number) {
    let r = 0;
    const northernOffset = 10, southernOffset = isLeapYear(year) ? 173 : 172, daysInYear = isLeapYear(year) ? 366 : 365;
    if (latitude >= 0) { r = dayOfYear + northernOffset; if (r >= daysInYear) r -= daysInYear; }
    else { r = dayOfYear - southernOffset; if (r < 0) r += daysInYear; }
    return r;
  },
};
function piecewise(dyy: number, a: number, b: number, c: number, d: number) {
  if (dyy < 91) return a + ((b - a) / 91.0) * dyy;
  if (dyy < 137) return b + ((c - b) / 46.0) * (dyy - 91);
  if (dyy < 183) return c + ((d - c) / 46.0) * (dyy - 137);
  if (dyy < 229) return d + ((c - d) / 46.0) * (dyy - 183);
  if (dyy < 275) return c + ((b - c) / 46.0) * (dyy - 229);
  return b + ((a - b) / 91.0) * (dyy - 275);
}

class SolarCoordinates {
  declination: number;
  rightAscension: number;
  apparentSiderealTime: number;
  constructor(julianDay: number) {
    const T = Astro.julianCentury(julianDay);
    const L0 = Astro.meanSolarLongitude(T), Lp = Astro.meanLunarLongitude(T), Omega = Astro.ascendingLunarNodeLongitude(T);
    const Lambda = degreesToRadians(Astro.apparentSolarLongitude(T, L0));
    const Theta0 = Astro.meanSiderealTime(T);
    const dPsi = Astro.nutationInLongitude(T, L0, Lp, Omega), dEpsilon = Astro.nutationInObliquity(T, L0, Lp, Omega);
    const Epsilon0 = Astro.meanObliquityOfTheEcliptic(T), EpsilonApparent = degreesToRadians(Astro.apparentObliquityOfTheEcliptic(T, Epsilon0));
    this.declination = radiansToDegrees(Math.asin(Math.sin(EpsilonApparent) * Math.sin(Lambda)));
    this.rightAscension = unwindAngle(radiansToDegrees(Math.atan2(Math.cos(EpsilonApparent) * Math.sin(Lambda), Math.cos(Lambda))));
    this.apparentSiderealTime = Theta0 + (dPsi * 3600 * Math.cos(degreesToRadians(Epsilon0 + dEpsilon))) / 3600;
  }
}

class SolarTime {
  observer: Coordinates;
  solar: SolarCoordinates;
  prevSolar: SolarCoordinates;
  nextSolar: SolarCoordinates;
  approxTransit: number;
  transit: number;
  sunrise: number;
  sunset: number;
  constructor(date: Ymd, coordinates: Coordinates) {
    const jd = Astro.julianDay(date.y, date.m, date.d, 0);
    this.observer = coordinates;
    this.solar = new SolarCoordinates(jd);
    this.prevSolar = new SolarCoordinates(jd - 1);
    this.nextSolar = new SolarCoordinates(jd + 1);
    const m0 = Astro.approximateTransit(coordinates.longitude, this.solar.apparentSiderealTime, this.solar.rightAscension);
    const solarAltitude = -50.0 / 60.0;
    this.approxTransit = m0;
    this.transit = Astro.correctedTransit(m0, coordinates.longitude, this.solar.apparentSiderealTime, this.solar.rightAscension, this.prevSolar.rightAscension, this.nextSolar.rightAscension);
    this.sunrise = this.hourAngle(solarAltitude, false);
    this.sunset = this.hourAngle(solarAltitude, true);
  }
  hourAngle(angle: number, afterTransit: boolean) {
    return Astro.correctedHourAngle(this.approxTransit, angle, this.observer, afterTransit, this.solar.apparentSiderealTime,
      this.solar.rightAscension, this.prevSolar.rightAscension, this.nextSolar.rightAscension,
      this.solar.declination, this.prevSolar.declination, this.nextSolar.declination);
  }
  afternoon(shadowLength: number) {
    const tangent = Math.abs(this.observer.latitude - this.solar.declination);
    const inverse = shadowLength + Math.tan(degreesToRadians(tangent));
    const angle = radiansToDegrees(Math.atan(1.0 / inverse));
    return this.hourAngle(angle, true);
  }
}

/** Hours as a decimal → a UTC instant on the given day (adhan `TimeComponents.utcDate`). */
function utcDate(num: number, day: Ymd) {
  const hours = Math.floor(num);
  const minutes = Math.floor((num - hours) * 60);
  const seconds = Math.floor((num - (hours + minutes / 60)) * 60 * 60);
  return new Date(Date.UTC(day.y, day.m - 1, day.d, hours, minutes, seconds));
}

export interface PrayerTimesResult extends Record<PrayerKey, Date> { sunset: Date }

/** adhan `new PrayerTimes(coordinates, date, params)`; invalid (polar) times come back as Invalid Date. */
export function prayerTimes(coordinates: Coordinates, date: Ymd, params: CalculationParameters): PrayerTimesResult {
  const solarTime = new SolarTime(date, coordinates);
  const dhuhrTime = utcDate(solarTime.transit, date);
  const sunriseTime = utcDate(solarTime.sunrise, date);
  const sunsetTime = utcDate(solarTime.sunset, date);
  const tomorrow = addDays(date, 1);
  const tomorrowSolarTime = new SolarTime(tomorrow, coordinates);
  const shadow = params.madhab === 'hanafi' ? 2 : 1;
  const asrTime = utcDate(solarTime.afternoon(shadow), date);
  const tomorrowSunrise = utcDate(tomorrowSolarTime.sunrise, tomorrow);
  const night = (Number(tomorrowSunrise) - Number(sunsetTime)) / 1000;

  let fajrTime = utcDate(solarTime.hourAngle(-1 * params.fajrAngle, false), date);
  if (params.method === 'MoonsightingCommittee' && coordinates.latitude >= 55) fajrTime = addSeconds(sunriseTime, -1 * (night / 7));
  const safeFajr = params.method === 'MoonsightingCommittee'
    ? Astro.seasonAdjustedMorningTwilight(coordinates.latitude, dayOfYear(date), date.y, sunriseTime)
    : addSeconds(sunriseTime, -1 * (params.nightPortions().fajr * night));
  if (isNaN(fajrTime.getTime()) || safeFajr > fajrTime) fajrTime = safeFajr;

  let ishaTime: Date;
  if (params.ishaInterval > 0) ishaTime = addMinutes(sunsetTime, params.ishaInterval);
  else {
    ishaTime = utcDate(solarTime.hourAngle(-1 * params.ishaAngle, true), date);
    if (params.method === 'MoonsightingCommittee' && coordinates.latitude >= 55) ishaTime = addSeconds(sunsetTime, night / 7);
    const safeIsha = params.method === 'MoonsightingCommittee'
      ? Astro.seasonAdjustedEveningTwilight(coordinates.latitude, dayOfYear(date), date.y, sunsetTime, params.shafaq)
      : addSeconds(sunsetTime, params.nightPortions().isha * night);
    if (isNaN(ishaTime.getTime()) || safeIsha < ishaTime) ishaTime = safeIsha;
  }

  let maghribTime = sunsetTime;
  if (params.maghribAngle) {
    const angleBased = utcDate(solarTime.hourAngle(-1 * params.maghribAngle, true), date);
    if (sunsetTime < angleBased && ishaTime > angleBased) maghribTime = angleBased;
  }

  const adj = (k: PrayerKey) => (params.adjustments[k] || 0) + (params.methodAdjustments[k] || 0);
  return {
    fajr: roundedMinute(addMinutes(fajrTime, adj('fajr')), params.rounding),
    sunrise: roundedMinute(addMinutes(sunriseTime, adj('sunrise')), params.rounding),
    dhuhr: roundedMinute(addMinutes(dhuhrTime, adj('dhuhr')), params.rounding),
    asr: roundedMinute(addMinutes(asrTime, adj('asr')), params.rounding),
    sunset: roundedMinute(sunsetTime, params.rounding),
    maghrib: roundedMinute(addMinutes(maghribTime, adj('maghrib')), params.rounding),
    isha: roundedMinute(addMinutes(ishaTime, adj('isha')), params.rounding),
  };
}

export { isValidDate };

/**
 * Cities shared by prayer_times, qibla_direction (same ids, coordinates, time zones and default methods as the
 * website lists in prayer-times/app.js; qibla-finder uses the same coordinates). Arabic names as \u escapes.
 */
export interface City { id: string; en: string; ar: string; lat: number; lon: number; tz: string; method: string }

export const CITIES: City[] = [
  { id: "amman", en: "Amman", ar: '\u0639\u0645\u0651\u0627\u0646', lat: 31.9539, lon: 35.9106, tz: "Asia/Amman", method: "jordan" },
  { id: "irbid", en: "Irbid", ar: '\u0625\u0631\u0628\u062f', lat: 32.5556, lon: 35.85, tz: "Asia/Amman", method: "jordan" },
  { id: "zarqa", en: "Zarqa", ar: '\u0627\u0644\u0632\u0631\u0642\u0627\u0621', lat: 32.0728, lon: 36.088, tz: "Asia/Amman", method: "jordan" },
  { id: "aqaba", en: "Aqaba", ar: '\u0627\u0644\u0639\u0642\u0628\u0629', lat: 29.5321, lon: 35.0063, tz: "Asia/Amman", method: "jordan" },
  { id: "mecca", en: "Mecca", ar: '\u0645\u0643\u0629 \u0627\u0644\u0645\u0643\u0631\u0645\u0629', lat: 21.4225, lon: 39.8262, tz: "Asia/Riyadh", method: "ummalqura" },
  { id: "medina", en: "Medina", ar: '\u0627\u0644\u0645\u062f\u064a\u0646\u0629 \u0627\u0644\u0645\u0646\u0648\u0631\u0629', lat: 24.4686, lon: 39.6142, tz: "Asia/Riyadh", method: "ummalqura" },
  { id: "riyadh", en: "Riyadh", ar: '\u0627\u0644\u0631\u064a\u0627\u0636', lat: 24.7136, lon: 46.6753, tz: "Asia/Riyadh", method: "ummalqura" },
  { id: "jeddah", en: "Jeddah", ar: '\u062c\u062f\u0629', lat: 21.4858, lon: 39.1925, tz: "Asia/Riyadh", method: "ummalqura" },
  { id: "jerusalem", en: "Jerusalem", ar: '\u0627\u0644\u0642\u062f\u0633', lat: 31.7683, lon: 35.2137, tz: "Asia/Jerusalem", method: "mwl" },
  { id: "gaza", en: "Gaza", ar: '\u063a\u0632\u0629', lat: 31.5017, lon: 34.4668, tz: "Asia/Gaza", method: "mwl" },
  { id: "damascus", en: "Damascus", ar: '\u062f\u0645\u0634\u0642', lat: 33.5138, lon: 36.2765, tz: "Asia/Damascus", method: "mwl" },
  { id: "beirut", en: "Beirut", ar: '\u0628\u064a\u0631\u0648\u062a', lat: 33.8938, lon: 35.5018, tz: "Asia/Beirut", method: "mwl" },
  { id: "baghdad", en: "Baghdad", ar: '\u0628\u063a\u062f\u0627\u062f', lat: 33.3152, lon: 44.3661, tz: "Asia/Baghdad", method: "mwl" },
  { id: "cairo", en: "Cairo", ar: '\u0627\u0644\u0642\u0627\u0647\u0631\u0629', lat: 30.0444, lon: 31.2357, tz: "Africa/Cairo", method: "egyptian" },
  { id: "alexandria", en: "Alexandria", ar: '\u0627\u0644\u0625\u0633\u0643\u0646\u062f\u0631\u064a\u0629', lat: 31.2001, lon: 29.9187, tz: "Africa/Cairo", method: "egyptian" },
  { id: "dubai", en: "Dubai", ar: '\u062f\u0628\u064a', lat: 25.2048, lon: 55.2708, tz: "Asia/Dubai", method: "dubai" },
  { id: "abudhabi", en: "Abu Dhabi", ar: '\u0623\u0628\u0648\u0638\u0628\u064a', lat: 24.4539, lon: 54.3773, tz: "Asia/Dubai", method: "dubai" },
  { id: "doha", en: "Doha", ar: '\u0627\u0644\u062f\u0648\u062d\u0629', lat: 25.2854, lon: 51.531, tz: "Asia/Qatar", method: "qatar" },
  { id: "kuwait", en: "Kuwait City", ar: '\u0645\u062f\u064a\u0646\u0629 \u0627\u0644\u0643\u0648\u064a\u062a', lat: 29.3759, lon: 47.9774, tz: "Asia/Kuwait", method: "kuwait" },
  { id: "manama", en: "Manama", ar: '\u0627\u0644\u0645\u0646\u0627\u0645\u0629', lat: 26.2285, lon: 50.586, tz: "Asia/Bahrain", method: "mwl" },
  { id: "muscat", en: "Muscat", ar: '\u0645\u0633\u0642\u0637', lat: 23.588, lon: 58.3829, tz: "Asia/Muscat", method: "mwl" },
  { id: "istanbul", en: "Istanbul", ar: '\u0625\u0633\u0637\u0646\u0628\u0648\u0644', lat: 41.0082, lon: 28.9784, tz: "Europe/Istanbul", method: "turkey" },
  { id: "casablanca", en: "Casablanca", ar: '\u0627\u0644\u062f\u0627\u0631 \u0627\u0644\u0628\u064a\u0636\u0627\u0621', lat: 33.5731, lon: -7.5898, tz: "Africa/Casablanca", method: "mwl" },
  { id: "tunis", en: "Tunis", ar: '\u062a\u0648\u0646\u0633', lat: 36.8065, lon: 10.1815, tz: "Africa/Tunis", method: "mwl" },
  { id: "algiers", en: "Algiers", ar: '\u0627\u0644\u062c\u0632\u0627\u0626\u0631', lat: 36.7538, lon: 3.0588, tz: "Africa/Algiers", method: "mwl" },
  { id: "khartoum", en: "Khartoum", ar: '\u0627\u0644\u062e\u0631\u0637\u0648\u0645', lat: 15.5007, lon: 32.5599, tz: "Africa/Khartoum", method: "egyptian" },
  { id: "karachi", en: "Karachi", ar: '\u0643\u0631\u0627\u062a\u0634\u064a', lat: 24.8607, lon: 67.0011, tz: "Asia/Karachi", method: "karachi" },
  { id: "lahore", en: "Lahore", ar: '\u0644\u0627\u0647\u0648\u0631', lat: 31.5204, lon: 74.3587, tz: "Asia/Karachi", method: "karachi" },
  { id: "dhaka", en: "Dhaka", ar: '\u062f\u0643\u0627', lat: 23.8103, lon: 90.4125, tz: "Asia/Dhaka", method: "karachi" },
  { id: "delhi", en: "Delhi", ar: '\u062f\u0644\u0647\u064a', lat: 28.6139, lon: 77.209, tz: "Asia/Kolkata", method: "karachi" },
  { id: "kualalumpur", en: "Kuala Lumpur", ar: '\u0643\u0648\u0627\u0644\u0627\u0644\u0645\u0628\u0648\u0631', lat: 3.139, lon: 101.6869, tz: "Asia/Kuala_Lumpur", method: "singapore" },
  { id: "jakarta", en: "Jakarta", ar: '\u062c\u0627\u0643\u0631\u062a\u0627', lat: -6.2088, lon: 106.8456, tz: "Asia/Jakarta", method: "singapore" },
  { id: "tehran", en: "Tehran", ar: '\u0637\u0647\u0631\u0627\u0646', lat: 35.6892, lon: 51.389, tz: "Asia/Tehran", method: "tehran" },
  { id: "london", en: "London", ar: '\u0644\u0646\u062f\u0646', lat: 51.5074, lon: -0.1278, tz: "Europe/London", method: "mwl" },
  { id: "paris", en: "Paris", ar: '\u0628\u0627\u0631\u064a\u0633', lat: 48.8566, lon: 2.3522, tz: "Europe/Paris", method: "mwl" },
  { id: "berlin", en: "Berlin", ar: '\u0628\u0631\u0644\u064a\u0646', lat: 52.52, lon: 13.405, tz: "Europe/Berlin", method: "mwl" },
  { id: "newyork", en: "New York", ar: '\u0646\u064a\u0648\u064a\u0648\u0631\u0643', lat: 40.7128, lon: -74.006, tz: "America/New_York", method: "isna" },
  { id: "chicago", en: "Chicago", ar: '\u0634\u064a\u0643\u0627\u063a\u0648', lat: 41.8781, lon: -87.6298, tz: "America/Chicago", method: "isna" },
  { id: "toronto", en: "Toronto", ar: '\u062a\u0648\u0631\u0646\u062a\u0648', lat: 43.6532, lon: -79.3832, tz: "America/Toronto", method: "isna" },
  { id: "losangeles", en: "Los Angeles", ar: '\u0644\u0648\u0633 \u0623\u0646\u062c\u0644\u0648\u0633', lat: 34.0522, lon: -118.2437, tz: "America/Los_Angeles", method: "isna" },
  { id: "sydney", en: "Sydney", ar: '\u0633\u064a\u062f\u0646\u064a', lat: -33.8688, lon: 151.2093, tz: "Australia/Sydney", method: "mwl" },
];

export const CITY_IDS = CITIES.map((c) => c.id);
const key = (s: string) => s.trim().toLowerCase().replace(/[\s_.-]+/g, '');
/** Find a city by id or English name ("newyork", "New York", "kuwait city"). */
export const findCity = (q: string) => {
  const k = key(q);
  return CITIES.find((c) => c.id === k || key(c.en) === k);
};

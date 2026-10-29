/**
 * Unit table of https://github.com/s3eidat/unit-convert (app.js), generated from the website's source so symbols and
 * factors match exactly (non-ASCII characters kept as \u escapes). Not a tool (leading underscore).
 * [symbol, name, factor-to-base | {to, from}, extra search words]
 */
export type Factor = number | { to: (v: number) => number; from: (k: number) => number };
export interface RawCat { id: string; name: string; base: string; def: [string, string]; units: [string, string, Factor, string?][] }

export const CATS: RawCat[] = [
  { id: "length", name: "Length", base: "m", def: ["km", "mi"], units: [
    ["nm", "nanometre", 1e-9], ["\u00b5m", "micrometre", 1e-6, "um micron"], ["mm", "millimetre", 1e-3, "millimeter"], ["cm", "centimetre", 1e-2, "centimeter"],
    ["m", "metre", 1, "meter"], ["km", "kilometre", 1e3, "kilometer"], ["in", "inch", 0.0254, "inches \""], ["ft", "foot", 0.3048, "feet '"],
    ["yd", "yard", 0.9144, "yards"], ["mi", "mile", 1609.344, "miles"], ["nmi", "nautical mile", 1852], ["ly", "light-year", 9460730472580800]] },
  { id: "mass", name: "Mass", base: "kg", def: ["kg", "lb"], units: [
    ["mg", "milligram", 1e-6], ["g", "gram", 1e-3, "grams"], ["kg", "kilogram", 1, "kilo kilos"], ["t", "tonne (metric)", 1000, "ton metric"],
    ["ct", "carat", 0.0002], ["oz", "ounce", 0.028349523125, "ounces"], ["lb", "pound", 0.45359237, "lbs pounds"], ["st", "stone", 6.35029318],
    ["us ton", "short ton (US)", 907.18474], ["uk ton", "long ton (UK)", 1016.0469088]] },
  { id: "temp", name: "Temperature", base: "K", def: ["\u00b0C", "\u00b0F"], units: [
    ["\u00b0C", "Celsius", { to: function (v: number) { return v + 273.15; }, from: function (k: number) { return k - 273.15; } }, "c centigrade"],
    ["\u00b0F", "Fahrenheit", { to: function (v: number) { return (v - 32) * 5 / 9 + 273.15; }, from: function (k: number) { return (k - 273.15) * 9 / 5 + 32; } }, "f"],
    ["K", "Kelvin", 1, "k"], ["\u00b0R", "Rankine", 5 / 9, "r"]] },
  { id: "volume", name: "Volume", base: "L", def: ["L", "gal"], units: [
    ["mL", "millilitre", 1e-3, "ml milliliter cc"], ["cm\u00b3", "cubic centimetre", 1e-3, "cm3"], ["L", "litre", 1, "l liter liters"], ["m\u00b3", "cubic metre", 1000, "m3"],
    ["in\u00b3", "cubic inch", 0.016387064, "in3"], ["ft\u00b3", "cubic foot", 28.316846592, "ft3"], ["fl oz", "fluid ounce (US)", 0.0295735295625, "floz"],
    ["pt", "pint (US)", 0.473176473], ["qt", "quart (US)", 0.946352946], ["gal", "gallon (US)", 3.785411784, "gallons"],
    ["uk pt", "pint (UK)", 0.56826125], ["uk gal", "gallon (UK)", 4.54609, "imperial"], ["bbl", "barrel (oil)", 158.987294928]] },
  { id: "area", name: "Area", base: "m\u00b2", def: ["m\u00b2", "ft\u00b2"], units: [
    ["mm\u00b2", "square millimetre", 1e-6, "mm2"], ["cm\u00b2", "square centimetre", 1e-4, "cm2"], ["m\u00b2", "square metre", 1, "m2 sqm"], ["dunam", "dunam (\u062f\u0648\u0646\u0645)", 1000, "dunum donum"],
    ["ha", "hectare", 1e4], ["km\u00b2", "square kilometre", 1e6, "km2"], ["in\u00b2", "square inch", 0.00064516, "in2"], ["ft\u00b2", "square foot", 0.09290304, "ft2 sqft"],
    ["yd\u00b2", "square yard", 0.83612736, "yd2"], ["ac", "acre", 4046.8564224, "acres"], ["mi\u00b2", "square mile", 2589988.110336, "mi2"]] },
  { id: "speed", name: "Speed", base: "m/s", def: ["km/h", "mph"], units: [
    ["m/s", "metres per second", 1, "mps"], ["km/h", "kilometres per hour", 1 / 3.6, "kph kmh"], ["mph", "miles per hour", 0.44704],
    ["kn", "knot", 1852 / 3600, "knots"], ["ft/s", "feet per second", 0.3048, "fps"], ["c", "speed of light", 299792458]] },
  { id: "time", name: "Time", base: "s", def: ["h", "min"], units: [
    ["ns", "nanosecond", 1e-9], ["\u00b5s", "microsecond", 1e-6, "us"], ["ms", "millisecond", 1e-3], ["s", "second", 1, "sec seconds"],
    ["min", "minute", 60, "minutes"], ["h", "hour", 3600, "hr hours"], ["d", "day", 86400, "days"], ["wk", "week", 604800, "weeks"],
    ["mo", "month (average)", 2629746, "months"], ["yr", "year (average)", 31556952, "years"], ["dec", "decade", 315569520], ["cent", "century", 3155695200]] },
  { id: "data", name: "Data", base: "B", def: ["GB", "GiB"], units: [
    ["bit", "bit", 0.125, "bits b"], ["B", "byte", 1, "bytes"], ["kB", "kilobyte", 1e3, "kb"], ["MB", "megabyte", 1e6, "mb"], ["GB", "gigabyte", 1e9, "gb gig"],
    ["TB", "terabyte", 1e12, "tb"], ["PB", "petabyte", 1e15, "pb"], ["KiB", "kibibyte", 1024, "kib"], ["MiB", "mebibyte", 1048576, "mib"],
    ["GiB", "gibibyte", 1073741824, "gib"], ["TiB", "tebibyte", 1099511627776, "tib"], ["PiB", "pebibyte", 1125899906842624, "pib"],
    ["kbit", "kilobit", 125, "kbps"], ["Mbit", "megabit", 125000, "mbps megabits"], ["Gbit", "gigabit", 1.25e8, "gbps"]] },
  { id: "pressure", name: "Pressure", base: "Pa", def: ["bar", "psi"], units: [
    ["Pa", "pascal", 1], ["hPa", "hectopascal", 100, "mbar millibar"], ["kPa", "kilopascal", 1e3], ["MPa", "megapascal", 1e6],
    ["bar", "bar", 1e5], ["atm", "atmosphere", 101325], ["psi", "pound per square inch", 6894.757293168361],
    ["mmHg", "millimetre of mercury", 133.322387415, "torr"], ["inHg", "inch of mercury", 3386.389]] },
  { id: "energy", name: "Energy", base: "J", def: ["kcal", "kJ"], units: [
    ["J", "joule", 1], ["kJ", "kilojoule", 1e3], ["MJ", "megajoule", 1e6], ["cal", "calorie", 4.184], ["kcal", "kilocalorie (food Calorie)", 4184, "calories"],
    ["Wh", "watt-hour", 3600], ["kWh", "kilowatt-hour", 3.6e6], ["BTU", "British thermal unit", 1055.05585262, "btu"],
    ["ft\u00b7lbf", "foot-pound", 1.3558179483314004, "ftlb"], ["eV", "electronvolt", 1.602176634e-19], ["thm", "therm (US)", 105480400]] },
  { id: "power", name: "Power", base: "W", def: ["kW", "hp"], units: [
    ["W", "watt", 1, "watts"], ["kW", "kilowatt", 1e3], ["MW", "megawatt", 1e6], ["hp", "horsepower (mechanical)", 745.69987158227022],
    ["PS", "metric horsepower", 735.49875, "cv"], ["BTU/h", "BTU per hour", 0.29307107017], ["kcal/h", "kilocalorie per hour", 1.1622222222]] },
  { id: "angle", name: "Angle", base: "\u00b0", def: ["\u00b0", "rad"], units: [
    ["\u00b0", "degree", 1, "deg degrees"], ["rad", "radian", 180 / Math.PI, "radians"], ["grad", "gradian", 0.9, "gon"], ["\u2032", "arcminute", 1 / 60, "arcmin"],
    ["\u2033", "arcsecond", 1 / 3600, "arcsec"], ["turn", "turn", 360, "revolution rev"], ["mil", "NATO mil", 360 / 6400]] },
  { id: "fuel", name: "Fuel economy", base: "km/L", def: ["L/100km", "mpg"], units: [
    ["km/L", "kilometres per litre", 1, "kmpl"],
    ["L/100km", "litres per 100 km", { to: function (v: number) { return 100 / v; }, from: function (k: number) { return 100 / k; } }, "l100km consumption"],
    ["mpg", "miles per gallon (US)", 1.609344 / 3.785411784, "mpg us"], ["mpg uk", "miles per gallon (UK)", 1.609344 / 4.54609, "imperial"]] },
  { id: "cooking", name: "Cooking", base: "mL", def: ["cup", "mL"], units: [
    ["tsp", "teaspoon (US)", 4.92892159375, "teaspoons"], ["tbsp", "tablespoon (US)", 14.78676478125, "tablespoons"], ["fl oz", "fluid ounce (US)", 29.5735295625],
    ["cup", "cup (US)", 236.5882365, "cups"], ["pt", "pint (US)", 473.176473], ["mL", "millilitre", 1, "ml"], ["L", "litre", 1000, "l liter"],
    ["m tsp", "teaspoon (metric)", 5], ["m tbsp", "tablespoon (metric)", 15], ["m cup", "cup (metric)", 250, "metric cup"]] }];

export const NOTES: Record<string, string> = {
  data: "SI units (kB, MB, GB) are powers of 1000; binary units (KiB, MiB, GiB) are powers of 1024. Disk makers use GB; many operating systems show GiB.",
  cooking: "Volume only. Converting cups to grams needs the ingredient's density (a cup of flour and a cup of sugar weigh differently).",
  fuel: "L/100km is consumption (lower is better); km/L and mpg are economy (higher is better).",
  time: "A month is the average Gregorian month (30.436875 days), a year is 365.2425 days.",
  temp: "Temperatures convert with offsets, not just a factor: 0 \u00b0C = 32 \u00b0F."
};

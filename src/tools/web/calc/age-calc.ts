import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { ANNOTATIONS } from './_common.js';
import { addMonths, cfd, dfc, diff, hijriParts, hijriText, iso, nice, parseOr, plural, todayLocal, weekday, ymd, type YMD } from './_cal.js';

// Ported from https://github.com/s3eidat/age-calc (app.js): pure calendar-day arithmetic.
const ZODIAC: [number, number, string, string][] = [[1, 20, 'Aquarius', '♒'], [2, 19, 'Pisces', '♓'], [3, 21, 'Aries', '♈'],
  [4, 20, 'Taurus', '♉'], [5, 21, 'Gemini', '♊'], [6, 21, 'Cancer', '♋'], [7, 23, 'Leo', '♌'], [8, 23, 'Virgo', '♍'],
  [9, 23, 'Libra', '♎'], [10, 23, 'Scorpio', '♏'], [11, 22, 'Sagittarius', '♐'], [12, 22, 'Capricorn', '♑']];
const ANIMALS = ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse', 'Goat', 'Monkey', 'Rooster', 'Dog', 'Pig'];

export function zodiac(o: YMD) { let z = ZODIAC[11]; ZODIAC.forEach((s) => { if (o.m > s[0] || (o.m === s[0] && o.d >= s[1])) z = s; }); return z[2] + ' ' + z[3]; }
export function animal(y: number) { return ANIMALS[(((y - 4) % 12) + 12) % 12]; }

export default defineTool({
  name: 'calc_age',
  title: 'Age calculator',
  webSlug: 'age-calc',
  description:
    'Exact age in years, months and days from a date of birth (on today or any "on" date), with totals in months, weeks, days ' +
    'and hours, the weekday of birth, Hijri (Umm al-Qura) birth date and Hijri age, next birthday (Feb 29 birthdays fall on ' +
    'Feb 28 in common years), star sign, Chinese zodiac, the next 1,000-day milestone, and optionally the age gap to a second ' +
    `person. Dates are ISO YYYY-MM-DD. Web version: ${webUrl('age-calc')}`,
  inputSchema: z.object({
    birthDate: z.string().describe('Date of birth, YYYY-MM-DD.'),
    onDate: z.string().optional().describe('Work out the age on this date (YYYY-MM-DD). Default: today.'),
    otherBirthDate: z.string().optional().describe('Optional second person\'s date of birth, to compare.'),
    otherName: z.string().max(60).optional().describe('Name of the second person (default "They").'),
  }),
  outputSchema: z.object({
    years: z.number(), months: z.number(), days: z.number(), text: z.string(),
    totalMonths: z.number(), totalWeeks: z.number(), weeksRemainderDays: z.number(), totalDays: z.number(), approxHours: z.number(),
    bornOn: z.object({ date: z.string(), weekday: z.string(), long: z.string() }),
    hijri: z.object({ birth: z.string(), birthArabic: z.string(), age: z.number().nullable() }).optional(),
    birthdayToday: z.boolean(),
    nextBirthday: z.object({ date: z.string(), weekday: z.string(), inDays: z.number(), turning: z.number() }),
    starSign: z.string(), chineseZodiac: z.string(),
    nextMilestone: z.object({ days: z.number(), date: z.string(), weekday: z.string(), inDays: z.number() }),
    comparison: z.string().optional(),
    summary: z.string(),
  }),
  annotations: ANNOTATIONS,
  examples: [{ input: { birthDate: '1994-05-15', onDate: '2026-10-26' }, note: '32 years, 5 months, 11 days' }],
  run(input) {
    const dob = parseOr(input.birthDate, 'birthDate'), on = parseOr(input.onDate, 'onDate');
    const isToday = dfc(on) === dfc(todayLocal());
    if (dfc(dob) > dfc(on)) throw new ToolError('The birth date is after the "on" date (not born yet: ' + plural(dfc(dob) - dfc(on), 'day') + ' to go).');
    const a = diff(dob, on);
    const bdayToday = a.m === 0 && a.d === 0, next = bdayToday ? on : addMonths(dob, 12 * (a.y + 1)), until = dfc(next) - dfc(on);
    const hEn = hijriText(dob, 'en'), hAr = hijriText(dob, 'ar-SA'), hp = hijriParts(dob), ht = hijriParts(on);
    const hAge = hp && ht ? ht.y - hp.y - (ht.m < hp.m || (ht.m === hp.m && ht.d < hp.d) ? 1 : 0) : null;
    const ms = (Math.floor(a.days / 1000) + 1) * 1000, msDate = cfd(dfc(dob) + ms);
    const out: Record<string, unknown> = {
      years: a.y, months: a.m, days: a.d, text: ymd(a),
      totalMonths: a.months, totalWeeks: Math.floor(a.days / 7), weeksRemainderDays: a.days % 7, totalDays: a.days, approxHours: a.days * 24,
      bornOn: { date: iso(dob), weekday: weekday(dob), long: nice(dob) },
      ...(hEn ? { hijri: { birth: hEn, birthArabic: hAr, age: hAge } } : {}),
      birthdayToday: bdayToday,
      nextBirthday: { date: iso(next), weekday: weekday(next), inDays: until, turning: bdayToday ? a.y : a.y + 1 },
      starSign: zodiac(dob),
      chineseZodiac: animal(dob.y) + (dob.m <= 2 ? ' (or ' + animal(dob.y - 1) + ' if born before Chinese New Year)' : ''),
      nextMilestone: { days: ms, date: iso(msDate), weekday: weekday(msDate), inDays: ms - a.days },
    };
    let summary = 'Age: ' + ymd(a) + (isToday ? '' : ' (on ' + nice(on) + ')') + '\nBorn: ' + weekday(dob) + ', ' + nice(dob) + (hEn ? ' (' + hEn + ')' : '') +
      '\nTotal: ' + a.days.toLocaleString('en-US') + ' days, ' + Math.floor(a.days / 7).toLocaleString('en-US') + ' weeks' +
      (bdayToday ? '\nBirthday today!' : '\nNext birthday: ' + nice(next) + ' (' + weekday(next) + '), in ' + plural(until, 'day'));
    if (input.otherBirthDate) {
      const dob2 = parseOr(input.otherBirthDate, 'otherBirthDate'), nm = input.otherName?.trim() || 'They';
      const d = dfc(dob2) - dfc(dob), gap = d < 0 ? diff(dob2, dob) : diff(dob, dob2);
      const age2 = dfc(dob2) <= dfc(on) ? diff(dob2, on) : null;
      const line = (d === 0 ? nm + ' shares your exact birthday!' : nm + ' is ' + ymd(gap) + (d > 0 ? ' younger' : ' older') + ' than you (' + plural(Math.abs(d), 'day') + ').') +
        (age2 ? ' Their age: ' + ymd(age2) + '.' : ' Not born yet on that date.');
      out.comparison = line;
      summary += '\n' + line;
    }
    out.summary = summary;
    return out;
  },
});

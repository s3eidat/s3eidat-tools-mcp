import { describe, expect, it } from 'vitest';
import tool, { dec, hm, overnight, pay, shiftMinutes, weekCalc } from '../../../src/tools/web/calc/hours-calc.js';
import { fails, run } from './_run.js';

describe('calc_hours (hours-calc self-test)', () => {
  it('matches the website known answers', () => {
    expect([shiftMinutes('22:00', '06:00', 30, 0), shiftMinutes('09:00', '17:00', 60, 0), shiftMinutes('09:00', '09:00', 0, 0)]).toEqual([450, 420, 1440]);
    expect([shiftMinutes('09:00', '', 0, 0), shiftMinutes('08:58', '17:07', 0, 15), shiftMinutes('10:00', '11:00', 90, 0)]).toEqual([null, 495, 0]);
    expect(overnight('23:30', '07:00') && !overnight('07:00', '23:30')).toBe(true);
    expect([hm(450), dec(450), hm(65)]).toEqual(['7:30', '7.50', '1:05']);
    const d = weekCalc([600, 600, 600, 600, 480, 0, 0], 480, 2400);
    const w = weekCalc([540, 540, 540, 540, 540, 0, 0], null, 2400);
    const b = weekCalc([600, 600, 600, 600, 600, 300, 0], 480, 2400);
    const p = pay(w, 20, 1.5);
    expect([d.total, d.overtime, d.regular, d.weeklyOT]).toEqual([2880, 480, 2400, 0]);
    expect([w.overtime, w.regular, p.regular, p.overtime, p.total]).toEqual([300, 2400, 800, 150, 950]);
    expect([b.overtime, b.regular]).toEqual([900, 2400]);
  });
  it('runs as a tool', async () => {
    const r = await run(tool, {
      weekStart: 'sunday', weekOf: '2026-10-28', hourlyRate: 12.5, currency: '$', dailyOvertimeHours: 8, weeklyOvertimeHours: 40,
      shifts: [
        { day: 'monday', start: '09:00', end: '17:30', breakMinutes: 30 }, { day: 'tuesday', start: '09:00', end: '18:45', breakMinutes: 45 },
        { day: 'wednesday', start: '08:30', end: '12:30' }, { day: 'wednesday', start: '13:15', end: '17:45' },
        { day: 'thursday', start: '22:00', end: '06:00', breakMinutes: 30 }, { day: 'friday', start: '09:00', end: '19:00', breakMinutes: 30 },
        { day: 'saturday', start: '10:00', end: '14:00' },
      ],
    });
    expect(r.days[0]).toMatchObject({ day: 'Sunday', date: '2026-10-25', minutes: 0 });
    expect(r.days[1]).toMatchObject({ day: 'Monday', date: '2026-10-26', hm: '8:00' });
    expect(r.total).toEqual({ minutes: 2790, hm: '46:30', hours: '46.50' });
    expect(r.overtime).toMatchObject({ daily: 180, weekly: 210, minutes: 390 });
    expect(r.pay).toEqual({ regular: 500, overtime: 121.88, total: 621.88 });
    expect(r.shifts[4].overnight).toBe(true);
    expect(r.summary).toContain('Pay: $ 621.88 at $ 12.50/h, overtime ×1.5');
    const n = await run(tool, { shifts: [{ day: 'monday', start: '08:58', end: '17:07' }], roundMinutes: 15 });
    expect(n.total.hm).toBe('8:15');
    await fails(tool, { shifts: [{ day: 'monday', start: '25:00', end: '17:00' }] }, /HH:MM/);
  });
});

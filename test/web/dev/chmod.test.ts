import { describe, expect, it } from 'vitest';
import tool, { parseOctal, parseSymbolic, shellQuote, toClauses, toOctal, toSymbolic } from '../../../src/tools/web/dev/chmod.js';
import { call } from '../../helpers.js';

describe('chmod-calc self-test', () => {
  it('known answers', () => {
    expect([toOctal(0o755), toSymbolic(0o755), toOctal(0o4755), toSymbolic(0o4755)]).toEqual(['755', 'rwxr-xr-x', '4755', 'rwsr-xr-x']);
    expect([toSymbolic(0o1777), toSymbolic(0o2644), toSymbolic(0o1754)]).toEqual(['rwxrwxrwt', 'rw-r-Sr--', 'rwxr-xr-T']);
    expect([toClauses(0o4750), toClauses(0o644)]).toEqual(['u=rwxs,g=rx,o=', 'u=rw,g=r,o=r']);
    expect([parseOctal('0644'), parseOctal('8'), parseOctal('12345')]).toEqual([0o644, null, null]);
    expect([parseSymbolic('rwxr-x---'), parseSymbolic('-rwsr-xr-x'), parseSymbolic('drwxrwxrwt')]).toEqual([0o750, 0o4755, 0o1777]);
    expect([parseSymbolic('u=rw,go=r', 0), parseSymbolic('+x', 0o644), parseSymbolic('g-w,o-rwx', 0o775), parseSymbolic('u+s', 0o755), parseSymbolic('q=r', 0)]).toEqual([
      0o644, 0o755, 0o750, 0o4755, null,
    ]);
    expect([shellQuote('a b'), shellQuote("it's"), shellQuote('/srv/app.sh')]).toEqual(["'a b'", "'it'\\''s'", '/srv/app.sh']);
  });
  it('round trips every mode', () => {
    for (let m = 0; m < 0o10000; m++) {
      expect(parseSymbolic(toSymbolic(m))).toBe(m);
      expect(parseOctal(toOctal(m))).toBe(m);
      expect(parseSymbolic(toClauses(m), 0o777)).toBe(m);
    }
  });
});

describe('chmod_calc tool', () => {
  it('runs', async () => {
    const r = await call<Record<string, any>>(tool, { mode: '2775', file: '/srv/shared dir', recursive: true });
    expect(r).toMatchObject({ octal: '2775', symbolic: 'rwxrwsr-x', clauses: 'u=rwx,g=rwxs,o=rx' });
    expect(r.commands.octal).toBe("chmod -R 2775 '/srv/shared dir'");
    expect(r.description[0]).toEqual({ who: 'Owner', text: 'can read, write and execute' });
    expect(r.description[3].who).toBe('setgid');
    expect((await call<Record<string, any>>(tool, { mode: 'g-w,o-rwx', base: '775' })).octal).toBe('750');
    expect((await call<Record<string, any>>(tool, { mode: '777' })).warnings[0].text).toBe('Anyone can change or replace this');
    await expect(call(tool, { mode: 'nope' })).rejects.toThrow();
  });
});

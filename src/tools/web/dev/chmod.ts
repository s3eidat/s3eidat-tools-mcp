import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/chmod-calc (app.js): Unix permission bits ⇄ octal ⇄ symbolic, same parser
// (ls -l strings and u/g/o/a clauses), descriptions, safety flags and shell quoting.
const WHO: [string, string, number][] = [['u', 'Owner', 6], ['g', 'Group', 3], ['o', 'Others', 0]];
const SPECIAL: [string, number, string][] = [
  ['setuid', 0o4000, "Runs as the file's owner"],
  ['setgid', 0o2000, 'Runs as the group; new files in a folder inherit its group'],
  ['sticky', 0o1000, "In a folder, only a file's owner can delete or rename it"],
];

export function toOctal(mode: number) {
  const s = (mode & 0o777).toString(8).padStart(3, '0');
  return mode & 0o7000 ? ((mode >> 9) & 7) + s : s;
}
export function toSymbolic(mode: number) {
  let out = '';
  WHO.forEach((w, i) => {
    const t = (mode >> w[2]) & 7, x = t & 1;
    out += (t & 4 ? 'r' : '-') + (t & 2 ? 'w' : '-');
    const sp = i === 0 ? mode & 0o4000 : i === 1 ? mode & 0o2000 : mode & 0o1000, ch = i === 2 ? 't' : 's';
    out += sp ? (x ? ch : ch.toUpperCase()) : x ? 'x' : '-';
  });
  return out;
}
/** Canonical clause form, e.g. 4755 -> "u=rwxs,g=rx,o=rx" */
export function toClauses(mode: number) {
  return WHO.map((w, i) => {
    const t = (mode >> w[2]) & 7;
    let s = (t & 4 ? 'r' : '') + (t & 2 ? 'w' : '') + (t & 1 ? 'x' : '');
    if (i === 0 && mode & 0o4000) s += 's';
    if (i === 1 && mode & 0o2000) s += 's';
    if (i === 2 && mode & 0o1000) s += 't';
    return w[0] + '=' + s;
  }).join(',');
}
export function parseOctal(str: string) {
  const s = String(str).trim();
  if (!/^[0-7]{1,4}$/.test(s)) return null;
  return parseInt(s, 8);
}
/** Accepts "rwxr-xr-x", "-rwsr-xr-x" (ls -l style) or clauses "u=rwx,g+w,o-r,a+x" applied to `base`. */
export function parseSymbolic(str: string, base?: number): number | null {
  const s = String(str).trim();
  const m = /^[-dlcbps]?([r-])([w-])([xsS-])([r-])([w-])([xsS-])([r-])([w-])([xtT-])$/.exec(s);
  if (m) {
    let mode = 0;
    const c = m.slice(1);
    [0, 3, 6].forEach((o, i) => {
      const shift = WHO[i][2];
      if (c[o] === 'r') mode |= 4 << shift;
      if (c[o + 1] === 'w') mode |= 2 << shift;
      const x = c[o + 2];
      if (x === 'x' || x === 's' || x === 't') mode |= 1 << shift;
      if (x === 's' || x === 'S') mode |= i === 0 ? 0o4000 : 0o2000;
      if (x === 't' || x === 'T') mode |= 0o1000;
    });
    return mode;
  }
  if (!s) return null;
  let mode2 = base || 0, ok = true;
  s.split(',').forEach((cl) => {
    const p = /^([ugoa]*)([+\-=])([rwxst]*)$/.exec(cl.trim());
    if (!p) {
      ok = false;
      return;
    }
    let who = p[1] || 'a', bits = 0, mask = 0;
    if (who.indexOf('a') >= 0) who = 'ugo';
    who.split('').forEach((w) => {
      const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
      mask |= 7 << shift;
      if (w === 'u') mask |= 0o4000;
      if (w === 'g') mask |= 0o2000;
      if (w === 'o') mask |= 0o1000;
      p[3].split('').forEach((ch) => {
        if (ch === 'r') bits |= 4 << shift;
        if (ch === 'w') bits |= 2 << shift;
        if (ch === 'x') bits |= 1 << shift;
        if (ch === 's' && w === 'u') bits |= 0o4000;
        if (ch === 's' && w === 'g') bits |= 0o2000;
        if (ch === 't') bits |= 0o1000;
      });
    });
    if (p[2] === '+') mode2 |= bits;
    else if (p[2] === '-') mode2 &= ~bits;
    else mode2 = (mode2 & ~mask) | bits;
  });
  return ok ? mode2 & 0o7777 : null;
}
export function shellQuote(name: string) {
  if (/^[\w@%+=:,./-]+$/.test(name)) return name;
  return "'" + name.replace(/'/g, "'\\''") + "'";
}
export function describe(mode: number): [string, string][] {
  const lines: [string, string][] = WHO.map((w) => {
    const t = (mode >> w[2]) & 7, can: string[] = [];
    if (t & 4) can.push('read');
    if (t & 2) can.push('write');
    if (t & 1) can.push('execute');
    return [w[1], can.length ? 'can ' + (can.length > 1 ? can.slice(0, -1).join(', ') + ' and ' + can[can.length - 1] : can[0]) : 'has no access'];
  });
  SPECIAL.forEach((sp) => {
    if (mode & sp[1]) lines.push([sp[0], sp[2]]);
  });
  return lines;
}
export function flags(mode: number) {
  const f: { level: 'bad' | 'warn'; text: string }[] = [];
  if ((mode & 0o777) === 0o777) f.push({ level: 'bad', text: 'Anyone can change or replace this' });
  else if (mode & 0o002) f.push({ level: 'warn', text: 'World-writable' });
  if (mode & 0o4000 && mode & 0o022) f.push({ level: 'bad', text: 'setuid + writable by others: risky' });
  if (((mode >> 6) & 7) < (mode & 7)) f.push({ level: 'warn', text: 'Others have more access than the owner' });
  return f;
}

export default defineTool({
  name: 'chmod_calc',
  title: 'chmod calculator',
  webSlug: 'chmod-calc',
  description:
    'Convert Unix file permissions between octal (755, 0644, 4755), symbolic (rwxr-xr-x, ls -l style -rwsr-xr-x) and ' +
    'chmod clauses (u=rwx,g=rx,o=; relative ones like g+w or +x apply to "base"). Returns all forms, a plain-English ' +
    'description per owner/group/others, setuid/setgid/sticky meaning, safety warnings, and ready chmod commands. ' +
    `Web version: ${webUrl('chmod-calc')}`,
  inputSchema: z.object({
    mode: z.string().describe('Octal ("755", "0644", "2775"), symbolic ("rwxr-x---", "drwxrwxrwt") or clauses ("u=rw,go=r", "+x").'),
    base: z.string().optional().describe('Starting mode (octal) for relative clauses like "g+w". Default 000.'),
    file: z.string().optional().default('file').describe('File name for the example chmod commands (shell-quoted).'),
    recursive: z.boolean().optional().default(false).describe('Add -R to the example commands.'),
  }),
  outputSchema: z.object({
    octal: z.string(),
    symbolic: z.string(),
    clauses: z.string(),
    description: z.array(z.object({ who: z.string(), text: z.string() })),
    warnings: z.array(z.object({ level: z.enum(['bad', 'warn']), text: z.string() })),
    commands: z.object({ octal: z.string(), symbolic: z.string() }),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    { input: { mode: '4755' }, note: 'symbolic rwsr-xr-x, clauses u=rwxs,g=rx,o=rx, setuid explained' },
    { input: { mode: 'g-w,o-rwx', base: '775', file: '/srv/app' }, note: 'octal 750' },
  ],
  run(input) {
    let base = 0;
    if (input.base != null) {
      const b = parseOctal(input.base);
      if (b === null) throw new ToolError('"base" must be octal, 1–4 digits 0–7 (e.g. 644).');
      base = b;
    }
    const m = /^[0-7]{1,4}$/.test(input.mode.trim()) ? parseOctal(input.mode) : parseSymbolic(input.mode, base);
    if (m === null) throw new ToolError('Try octal like 755 or 4755, symbolic like rwxr-xr-x / -rw-r--r--, or clauses like u=rwx,g=rx,o=');
    const file = shellQuote(input.file.trim() || 'file'), r = input.recursive ? '-R ' : '';
    return {
      octal: toOctal(m),
      symbolic: toSymbolic(m),
      clauses: toClauses(m),
      description: describe(m).map(([who, text]) => ({ who, text })),
      warnings: flags(m),
      commands: { octal: 'chmod ' + r + toOctal(m) + ' ' + file, symbolic: 'chmod ' + r + toClauses(m) + ' ' + file },
    };
  },
});

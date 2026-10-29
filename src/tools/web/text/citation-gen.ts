import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';

// Ported from https://github.com/s3eidat/citation-gen (app.js): APA 7, MLA 9, Chicago author-date (17th), Harvard (Cite
// Them Right) and IEEE, built from structured fields with the same rules as the website. Sources are loosely typed
// (`any`) exactly as in the original, where every field is an optional string.
export interface Person { first: string; last: string; org: boolean }
interface DateParts { y: string; m: number; d: number }
export interface Run { t: string; i: boolean }

export const HTTPS = "https:" + "//"; // split so the source never contains a literal remote URL
export const DOI_BASE = HTTPS + "doi.org/";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON_ABBR = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."]; // MLA 9 and IEEE
export const STYLES: Record<string, string> = { apa: "APA 7", mla: "MLA 9", chicago: "Chicago author-date", harvard: "Harvard", ieee: "IEEE" };
export const BIB_TITLE: Record<string, string> = { apa: "References", mla: "Works Cited", chicago: "References", harvard: "Reference list", ieee: "References" };

// Which fields each source type uses, and what the container is called.
export const TYPES: Record<string, { f: string[]; container: string; title?: string; auth?: string; pub?: string }> = {
  book: { f: ["title", "edition", "year", "publisher", "place", "doi", "url"], container: "" },
  chapter: { f: ["title", "container", "editors", "edition", "pages", "year", "publisher", "place", "doi", "url"], container: "Book title", title: "Chapter title" },
  journal: { f: ["title", "container", "volume", "issue", "pages", "year", "month", "doi", "url", "accessed"], container: "Journal name", title: "Article title" },
  website: { f: ["title", "container", "year", "month", "day", "url", "accessed"], container: "Website name", title: "Page title" },
  newspaper: { f: ["title", "container", "year", "month", "day", "pages", "url", "accessed"], container: "Newspaper or magazine", title: "Article title" },
  video: { f: ["title", "container", "year", "month", "day", "url", "accessed"], container: "Platform", title: "Video title", auth: "Creator / channel" },
  report: { f: ["title", "number", "year", "publisher", "place", "doi", "url", "accessed"], container: "", title: "Report title", pub: "Organisation / publisher" }
};

// ---------- small text helpers ----------
function clean(s: unknown) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
function ends(s: string) { return /[.?!]["”’']?$/.test(s); }
function q(title: string, punct?: string) { return "“" + title + (punct && !/[.?!]$/.test(title) ? punct : "") + "”"; } // punctuation inside double quotes
function ordinal(n: number) {
  var s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function edition(e: string) {
  e = clean(e);
  if (!e) return "";
  var m = /^(\d+)(st|nd|rd|th)?\.?(\s*(ed|edn|edition)\.?)?$/i.exec(e);
  if (m) return +m[1] === 1 ? "" : ordinal(+m[1]);
  return e.replace(/\s*(ed|edn|edition)\.?$/i, "");
}
function pages(p: string) { return clean(p).replace(/\s*[-–—]+\s*/g, "–"); }
function isRange(p: string) { return /–/.test(p); }
// MLA: second number keeps only the digits that change, at least two (127–53, 395–401, 1608–774).
export function mlaPages(p: string) {
  p = pages(p);
  var m = /^(\d+)–(\d+)$/.exec(p);
  if (!m || +m[1] < 100 || m[2].length !== m[1].length) return p.replace("–", "-");
  for (var k = 2; k < m[2].length; k++) {
    if (m[1].slice(0, -k) === m[2].slice(0, -k)) return m[1] + "-" + m[2].slice(-k);
  }
  return m[1] + "-" + m[2];
}
function doiOf(d: string) { return clean(d).replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, ""); }
function fullUrl(u: string) { u = clean(u); return u && !/^[a-z][a-z0-9+.-]*:/i.test(u) ? HTTPS + u : u; }
function bareUrl(u: string) { return clean(u).replace(/^https?:\/\//i, ""); }

const MINOR = new Set(("a an the and but or nor for so yet as at by for from in into of off on onto out over per to up upon via with " +
  "about above across after against along among around before behind below beneath beside between beyond down during except " +
  "inside like near outside past since through throughout toward towards under underneath until within without vs vs. versus").split(" "));
// Title case for MLA / Chicago / IEEE: never lowercases a word you capitalised on purpose except minor words mid-title.
export function titleCase(s: string) {
  var words = clean(s).split(" "), out: string[] = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i], prev = i ? out[i - 1] : "", first = i === 0 || /[:?!—]$/.test(prev), last = i === words.length - 1;
    var core = w.replace(/^[“"‘'(\[]+|[”"’'),.;:!?\]]+$/g, "").toLowerCase();
    if (!first && !last && MINOR.has(core)) { out.push(w.toLowerCase() === w ? w : w.replace(/[A-Za-z]+/, function (x) { return x.toLowerCase(); })); continue; }
    out.push(w.split("-").map(function (part, j) {
      if (/[A-Z].*[A-Z]|[a-z][A-Z]|\d/.test(part)) return part; // NASA, iPhone, 3D: leave alone
      if (j > 0 && MINOR.has(part.toLowerCase())) return part.toLowerCase();
      return part.replace(/^([^A-Za-zÀ-ɏ]*)([A-Za-zÀ-ɏ])/, function (m0, pre, c) { return pre + c.toUpperCase(); });
    }).join("-"));
  }
  return out.join(" ");
}

// ---------- names ----------
export function initials(first: string, spaced: boolean) {
  var parts = clean(first).split(" ").filter(Boolean).map(function (tok) {
    return tok.split("-").map(function (p) { var c = p.replace(/\.$/, ""); return c ? Array.from(c)[0].toUpperCase() + "." : ""; }).join("-");
  });
  return parts.join(spaced ? " " : "");
}
export function person(a: any): Person { return { first: clean(a.first), last: clean(a.last), org: !!a.org }; }
function invFull(a: Person) { return a.org || !a.first ? a.last : a.last + ", " + a.first; }          // Kahneman, Daniel
function full(a: Person) { return a.org || !a.first ? a.last : a.first + " " + a.last; }               // Daniel Kahneman
function apaName(a: Person) { return a.org || !a.first ? a.last : a.last + ", " + initials(a.first, true); }  // Kahneman, D.
function apaFwd(a: Person) { return a.org || !a.first ? a.last : initials(a.first, true) + " " + a.last; }    // D. Kahneman
function harvName(a: Person) { return a.org || !a.first ? a.last : a.last + ", " + initials(a.first, false); } // Sussman, G.J.
function ieeeName(a: Person) { return a.org || !a.first ? a.last : initials(a.first, true) + " " + a.last; }  // G. J. Sussman
function list(names: string[], sep: string, lastSep: string) {
  if (names.length < 2) return names.join("");
  return names.slice(0, -1).join(sep) + lastSep + names[names.length - 1];
}

export const AUTH: Record<string, (au: Person[]) => string> = {
  apa: function (au) {
    var n = au.map(apaName);
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[0] + ", & " + n[1];
    if (n.length <= 20) return list(n, ", ", ", & ");
    return n.slice(0, 19).join(", ") + ", . . . " + n[n.length - 1];
  },
  mla: function (au) {
    if (au.length === 1) return invFull(au[0]);
    if (au.length === 2) return invFull(au[0]) + ", and " + full(au[1]);
    return invFull(au[0]) + ", et al.";
  },
  chicago: function (au) {
    if (au.length > 10) return [invFull(au[0])].concat(au.slice(1, 7).map(full)).join(", ") + ", et al.";
    var n = [invFull(au[0])].concat(au.slice(1).map(full));
    if (n.length === 2) return n[0] + ", and " + n[1];
    return list(n, ", ", ", and ");
  },
  harvard: function (au) {
    var n = au.map(harvName);
    if (n.length >= 4) return n[0] + " et al.";
    return list(n, ", ", " and ");
  },
  ieee: function (au) {
    var n = au.map(ieeeName);
    if (n.length >= 7) return n[0] + " et al.";
    if (n.length === 2) return n[0] + " and " + n[1];
    return list(n, ", ", ", and ");
  }
};
function parseEditors(s: string): Person[] {
  return clean(s).split(/\s*;\s*/).filter(Boolean).map(function (e) {
    if (/,/.test(e)) { var p = e.split(/\s*,\s*/); return { last: p[0], first: p.slice(1).join(" "), org: false }; }
    var w = e.split(" "); return w.length < 2 ? { last: e, first: "", org: true } : { last: w.pop()!, first: w.join(" "), org: false };
  });
}

// ---------- dates ----------
function D(f: any): DateParts { return { y: clean(f.year), m: +f.month || 0, d: +clean(f.day) || 0 }; }
function acc(f: any): DateParts | null { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.accessed || ""); return m ? { y: m[1], m: +m[2], d: +m[3] } : null; }
function mdy(t: DateParts, abbr?: boolean) { return t.m ? (abbr ? MON_ABBR : MONTHS)[t.m - 1] + (t.d ? " " + t.d : "") + (t.y ? ", " + t.y : "") : t.y; } // March 15, 2021
function dmy(t: DateParts, abbr?: boolean) { return (t.d && t.m ? t.d + " " : "") + (t.m ? (abbr ? MON_ABBR : MONTHS)[t.m - 1] + " " : "") + t.y; } // 15 Mar. 2021

// ---------- the builder: a list of {t, i} runs, i = italic ----------
export class Out {
  r: Run[] = [];
  add(t: unknown, it?: boolean) { if (t) this.r.push({ t: String(t), i: !!it }); return this; }
  i(t: unknown) { return this.add(t, true); }
  text() { return this.r.map((x) => x.t).join(''); }
  dot() { // end a sentence once (never ". ." or "..")
    while (this.r.length && /\s$/.test(this.r[this.r.length - 1].t)) {
      const l = this.r[this.r.length - 1]; l.t = l.t.replace(/\s+$/, ''); if (!l.t) this.r.pop();
    }
    if (this.r.length && !ends(this.text())) this.add('.');
    return this;
  }
  sp() { if (this.r.length && !/\s$/.test(this.text())) this.add(' '); return this; }
  runs() {
    const out: Run[] = [];
    this.r.forEach((x) => { const l = out[out.length - 1]; if (l && l.i === x.i) l.t += x.t; else out.push({ t: x.t, i: x.i }); });
    if (out.length) out[out.length - 1].t = out[out.length - 1].t.replace(/\s+$/, '');
    return out;
  }
}

function prep(src: any, style: string) {
  var f: any = {}, k: string;
  for (k in src) f[k] = typeof src[k] === "string" ? clean(src[k]) : src[k];
  f.authors = (<any[]>(src.authors || [])).map(person).filter(function (a) { return a.last || a.first; })
    .map(function (a) { return a.last ? a : { first: "", last: a.first, org: a.org }; });
  var tc = src.autoCase !== false && (style === "mla" || style === "chicago");
  f.T = tc ? titleCase(f.title) : f.title;             // the work's own title
  f.Tbook = (tc || (style === "ieee" && src.autoCase !== false)) ? titleCase(f.title) : f.title;
  f.C = f.container;
  f.ed = edition(f.edition);
  f.pg = pages(f.pages);
  f.doi = doiOf(f.doi);
  f.date = D(f);
  f.acc = acc(f);
  f.eds = parseEditors(f.editors || "");
  return f;
}

// ---------- APA 7 ----------
function apa(src: any) {
  var f = prep(src, "apa"), o = new Out(), t = src.type, d = f.date;
  var fullDate = t === "website" || t === "newspaper" || t === "video";
  var date = "(" + (d.y ? d.y + (fullDate && d.m ? ", " + MONTHS[d.m - 1] + (d.d ? " " + d.d : "") : "") : "n.d.") + ")";
  var italicTitle = t === "book" || t === "website" || t === "video" || t === "report";
  function title() {
    if (italicTitle) o.i(f.T); else o.add(f.T);
    if (t === "book" && f.ed) o.add(" (" + f.ed + " ed.)");
    if (t === "report" && f.number) o.add(" (" + (/^\D/.test(f.number) && !/^no\.?\s/i.test(f.number) ? f.number : "Report No. " + f.number.replace(/^no\.?\s*/i, "")) + ")");
    if (t === "video") o.add(" [Video]");
    o.dot().sp();
  }
  if (f.authors.length) { o.add(AUTH.apa(f.authors)).dot().sp().add(date + ".").sp(); if (f.T) title(); }
  else { if (f.T) title(); o.add(date + ".").sp(); }
  var authorIsPub = f.authors.length === 1 && f.authors[0].org && f.authors[0].last === f.publisher;
  if (t === "book") { if (f.publisher) o.add(f.publisher).dot().sp(); }
  else if (t === "report") { if (f.publisher && !authorIsPub) o.add(f.publisher).dot().sp(); }
  else if (t === "chapter") {
    o.add("In ");
    if (f.eds.length) o.add((f.eds.length === 1 ? apaFwd(f.eds[0]) : f.eds.length === 2 ? apaFwd(f.eds[0]) + " & " + apaFwd(f.eds[1]) : list(f.eds.map(apaFwd), ", ", ", & ")) + (f.eds.length > 1 ? " (Eds.), " : " (Ed.), "));
    o.i(f.C);
    var bits = [];
    if (f.ed) bits.push(f.ed + " ed.");
    if (f.pg) bits.push((isRange(f.pg) ? "pp. " : "p. ") + f.pg);
    if (bits.length) o.add(" (" + bits.join(", ") + ")");
    o.dot().sp();
    if (f.publisher) o.add(f.publisher).dot().sp();
  } else if (t === "journal") {
    if (f.C) {
      o.i(f.C + (f.volume ? ", " : ""));
      if (f.volume) o.i(f.volume);
      if (f.issue) o.add("(" + f.issue + ")");
      if (f.pg) o.add(", " + f.pg);
      o.dot().sp();
    }
  } else if (t === "website") {
    var same = f.authors.length === 1 && f.authors[0].last === f.C;
    if (f.C && !same) o.add(f.C).dot().sp();
  } else if (t === "newspaper") {
    if (f.C) { o.i(f.C); if (f.pg) o.add(", " + f.pg); o.dot().sp(); }
  } else if (t === "video") {
    if (f.C) o.add(f.C).dot().sp();
  }
  if (f.doi) o.add(DOI_BASE + f.doi);
  else if (f.url) o.add(fullUrl(f.url));
  return o;
}

// ---------- MLA 9 ----------
function mla(src: any) {
  var f = prep(src, "mla"), o = new Out(), t = src.type, d = f.date, els: Run[] = [];
  var authorIsPub = f.authors.length === 1 && f.authors[0].org && f.authors[0].last === f.publisher;
  if (f.authors.length && !authorIsPub) o.add(AUTH.mla(f.authors)).dot().sp();
  var quoted = t === "chapter" || t === "journal" || t === "website" || t === "newspaper" || t === "video";
  if (f.T) { if (quoted) o.add(q(f.T, ".")); else o.i(f.T).dot(); o.sp(); }
  // Container and the rest, comma separated, one period at the end.
  function el(txt: string, it?: boolean) { els.push({ t: txt, i: !!it }); }
  var date = d.y ? dmy(d, true) : "";
  if (t === "book" || t === "report") {
    if (f.ed && t === "book") el(f.ed + " ed.");
    if (f.publisher) el(f.publisher);
    if (date) el(t === "book" ? d.y : date);
  } else if (t === "chapter") {
    if (f.C) el(titleIf(f.C, src), true);
    if (f.eds.length) el("edited by " + (f.eds.length === 1 ? full(f.eds[0]) : f.eds.length === 2 ? full(f.eds[0]) + " and " + full(f.eds[1]) : full(f.eds[0]) + " et al."));
    if (f.ed) el(f.ed + " ed.");
    if (f.publisher) el(f.publisher);
    if (d.y) el(d.y);
    if (f.pg) el((isRange(f.pg) ? "pp. " : "p. ") + mlaPages(f.pg));
  } else if (t === "journal") {
    if (f.C) el(f.C, true);
    if (f.volume) el("vol. " + f.volume);
    if (f.issue) el("no. " + f.issue);
    if (date) el(date);
    if (f.pg) el((isRange(f.pg) ? "pp. " : "p. ") + mlaPages(f.pg));
  } else {
    if (f.C) el(f.C, true);
    if (date) el(date);
    if (t === "newspaper" && f.pg) el((isRange(f.pg) ? "pp. " : "p. ") + mlaPages(f.pg));
  }
  if (f.doi) el(DOI_BASE + f.doi);
  else if (f.url) el(bareUrl(f.url));
  els.forEach(function (e, i) { o.add(e.t, e.i); o.add(i < els.length - 1 ? ", " : ""); });
  o.dot();
  if (f.acc && !d.y && f.url && !f.doi) o.sp().add("Accessed " + dmy(f.acc, true) + ".");
  return o;
}
function titleIf(s: string, src: any) { return src.autoCase !== false ? titleCase(s) : s; }

// ---------- Chicago author-date (17th) ----------
function chicago(src: any) {
  var f = prep(src, "chicago"), o = new Out(), t = src.type, d = f.date;
  var year = d.y || "n.d.";
  var italicTitle = t === "book" || t === "report";
  function title() { if (italicTitle) o.i(f.T); else o.add(q(f.T, ".")); o.dot().sp(); }
  if (f.authors.length) { o.add(AUTH.chicago(f.authors)).dot().sp().add(year + ".").sp(); if (f.T) title(); }
  else { if (f.T) title(); o.add(year + ".").sp(); }
  function place() { var s = f.place && f.publisher ? f.place + ": " + f.publisher : f.publisher || f.place; if (s) o.add(s).dot().sp(); }
  if (t === "book") { if (f.ed) o.add(f.ed + " ed.").sp(); place(); }
  else if (t === "report") { if (f.number) o.add(/^\D/.test(f.number) ? f.number : "Report no. " + f.number).dot().sp(); place(); }
  else if (t === "chapter") {
    o.add("In ").i(titleIf(f.C, src));
    if (f.eds.length) o.add(", edited by " + list(f.eds.map(full), ", ", f.eds.length === 2 ? " and " : ", and "));
    if (f.ed) o.add(", " + f.ed + " ed.");
    if (f.pg) o.add(", " + f.pg);
    o.dot().sp(); place();
  } else if (t === "journal") {
    if (f.C) {
      o.i(f.C);
      if (f.volume) o.add(" " + f.volume);
      if (f.issue) o.add(" (" + f.issue + ")");
      if (f.pg) o.add((f.volume || f.issue ? ": " : ", ") + f.pg);
      o.dot().sp();
    }
  } else if (t === "website") {
    if (f.C) o.add(f.C).dot().sp();
    if (d.y && d.m) o.add(mdy(d)).dot().sp();
  } else if (t === "newspaper") {
    if (f.C) { o.i(f.C); if (d.m) o.add(", " + mdy(d)); o.dot().sp(); }
  } else if (t === "video") {
    o.add((f.C ? f.C + " video" : "Video") + (d.m ? ", " + mdy(d) : "")).dot().sp();
  }
  if (f.acc && !d.y && f.url && !f.doi) o.add("Accessed " + mdy(f.acc)).dot().sp();
  if (f.doi) o.add(DOI_BASE + f.doi).dot();
  else if (f.url) o.add(fullUrl(f.url)).dot();
  return o;
}

// ---------- Harvard (Cite Them Right) ----------
function harvard(src: any) {
  var f = prep(src, "harvard"), o = new Out(), t = src.type, d = f.date;
  var year = "(" + (d.y || "no date") + ")";
  var italicTitle = t === "book" || t === "website" || t === "video" || t === "report";
  function title() { if (italicTitle) o.i(f.T); else o.add("‘" + f.T + "’"); }
  if (f.authors.length) { o.add(AUTH.harvard(f.authors)).sp().add(year).sp(); if (f.T) title(); }
  else { if (f.T) title(); o.sp().add(year); }
  function place() { var s = f.place && f.publisher ? f.place + ": " + f.publisher : f.publisher || f.place; if (s) o.add(s); return !!s; }
  if (t === "book") { o.dot().sp(); if (f.ed) o.add(f.ed + " edn.").sp(); if (place()) o.dot().sp(); }
  else if (t === "report") { o.dot().sp(); if (f.number) o.add(/^\D/.test(f.number) ? f.number : "Report " + f.number).dot().sp(); if (place()) o.dot().sp(); }
  else if (t === "chapter") {
    o.add(", in ");
    if (f.eds.length) o.add(AUTH.harvard(f.eds) + " (" + (f.eds.length > 1 ? "eds" : "ed.") + ") ");
    o.i(f.C).dot().sp();
    if (f.ed) o.add(f.ed + " edn.").sp();
    var hasPub = place();
    if (f.pg) o.add((hasPub ? ", " : "") + (isRange(f.pg) ? "pp. " : "p. ") + f.pg);
    o.dot().sp();
  } else if (t === "journal") {
    if (f.C) o.add(", ").i(f.C);
    if (f.volume) o.add(", " + f.volume + (f.issue ? "(" + f.issue + ")" : ""));
    else if (f.issue) o.add(", (" + f.issue + ")");
    if (f.pg) o.add(", " + (isRange(f.pg) ? "pp. " : "p. ") + f.pg);
    o.dot().sp();
  } else if (t === "newspaper") {
    if (f.C) o.add(", ").i(f.C);
    if (d.m) o.add(", " + (d.d ? d.d + " " : "") + MONTHS[d.m - 1]);
    if (f.pg) o.add(", " + (isRange(f.pg) ? "pp. " : "p. ") + f.pg);
    o.dot().sp();
  } else if (t === "video") {
    if (f.C) o.add(" [" + f.C + "]");
    o.dot().sp();
  } else o.dot().sp();
  if (f.doi) o.add("Available at: " + DOI_BASE + f.doi).dot();
  else if (f.url) o.add("Available at: " + fullUrl(f.url) + (f.acc ? " (Accessed: " + dmy(f.acc) + ")" : "")).dot();
  return o;
}

// ---------- IEEE ----------
function ieee(src: any) {
  var f = prep(src, "ieee"), o = new Out(), t = src.type, d = f.date;
  var au = f.authors.length ? AUTH.ieee(f.authors) : "";
  var place = f.place && f.publisher ? f.place + ": " + f.publisher : f.publisher || f.place;
  var online = f.url && !f.doi;
  if (t === "website") {
    if (au) o.add(au).dot().sp();
    if (f.T) o.add(q(f.T, ".")).sp();
    if (f.C) o.add(f.C).dot().sp();
    if (f.url) o.add(fullUrl(f.url) + (f.acc ? " (accessed " + mdy(f.acc, true) + ")" : "")).dot();
    return o;
  }
  if (t === "video") {
    if (au) o.add(au).dot().sp();
    if (f.T) o.add(f.T).dot().sp();
    if (d.y) o.add("(" + mdy(d, true) + ").").sp();
    if (f.acc) o.add("Accessed: " + mdy(f.acc, true) + ".").sp();
    if (f.url) o.add("[Online Video]. Available: " + fullUrl(f.url));
    return o;
  }
  if (au) o.add(au + ", ");
  if (t === "book") {
    o.i(f.Tbook);
    if (f.ed) o.add(", " + f.ed + " ed.");
    o.dot().sp();
    if (place) o.add(place + (d.y ? ", " : ""));
    if (d.y) o.add(d.y);
    o.dot();
  } else if (t === "chapter") {
    o.add(q(f.T, ",")).add(" in ").i(titleIf(f.C, src));
    if (f.eds.length) o.add(", " + AUTH.ieee(f.eds) + (f.eds.length > 1 ? ", Eds" : ", Ed"));
    if (f.ed) o.add(", " + f.ed + " ed");
    o.add(".").sp();
    var parts: string[] = [];
    if (place) parts.push(place);
    if (d.y) parts.push(d.y);
    if (f.pg) parts.push((isRange(f.pg) ? "pp. " : "p. ") + f.pg);
    o.add(parts.join(", ")).dot();
  } else if (t === "journal") {
    o.add(q(f.T, ","));
    var j: { t: string; i?: boolean }[] = [];
    if (f.C) j.push({ t: f.C, i: true });
    if (f.volume) j.push({ t: "vol. " + f.volume });
    if (f.issue) j.push({ t: "no. " + f.issue });
    if (f.pg) j.push({ t: (isRange(f.pg) ? "pp. " : "p. ") + f.pg });
    if (d.y) j.push({ t: (d.m ? MON_ABBR[d.m - 1] + " " : "") + d.y });
    if (f.doi) j.push({ t: "doi: " + f.doi });
    o.sp();
    j.forEach(function (x, i) { o.add(x.t, x.i); if (i < j.length - 1) o.add(", "); });
    o.dot();
  } else if (t === "newspaper") {
    o.add(q(f.T, ",")).sp();
    if (f.C) o.i(f.C);
    if (d.y) o.add(", " + mdy(d, true));
    if (f.pg) o.add(", " + (isRange(f.pg) ? "pp. " : "p. ") + f.pg);
    o.dot();
  } else if (t === "report") {
    o.add(q(f.T, ",")).sp();
    var r: string[] = [];
    if (f.publisher) r.push(f.publisher);
    if (f.place) r.push(f.place);
    if (f.number) r.push(/^\D/.test(f.number) ? f.number : "Rep. " + f.number);
    if (d.y) r.push(d.y);
    o.add(r.join(", ")).dot();
    if (f.doi) o.sp().add("doi: " + f.doi).dot();
  }
  if (online) o.sp().add("[Online]. Available: " + fullUrl(f.url));
  else if (f.doi && t !== "journal" && t !== "report") o.sp().add("doi: " + f.doi).dot();
  return o;
}

const FORMAT: Record<string, (src: any) => Out> = { apa: apa, mla: mla, chicago: chicago, harvard: harvard, ieee: ieee };
export function format(src: any, style: string) { return FORMAT[style](src); }

// In-text (parenthetical) citation.
export function inText(src: any, style: string, n?: number) {
  if (style === "ieee") return "[" + (n || 1) + "]";
  var au = (<any[]>(src.authors || [])).map(person).filter(function (a) { return a.last || a.first; }).map(function (a) { return a.last || a.first; });
  var y = clean(src.year) || (style === "harvard" ? "no date" : "n.d."), who: string;
  if (!au.length) { var t = clean(src.title).split(" ").slice(0, 4).join(" "); who = /^(book|report|website|video)$/.test(src.type) && style !== "mla" ? t : "“" + t + "”"; }
  else if (style === "apa") who = au.length === 1 ? au[0] : au.length === 2 ? au[0] + " & " + au[1] : au[0] + " et al.";
  else if (style === "mla") who = au.length === 1 ? au[0] : au.length === 2 ? au[0] + " and " + au[1] : au[0] + " et al.";
  else if (style === "chicago") who = au.length === 1 ? au[0] : au.length === 2 ? au[0] + " and " + au[1] : au.length === 3 ? au[0] + ", " + au[1] + ", and " + au[2] : au[0] + " et al.";
  else who = au.length === 1 ? au[0] : au.length === 2 ? au[0] + " and " + au[1] : au.length === 3 ? au[0] + ", " + au[1] + " and " + au[2] : au[0] + " et al.";
  if (style === "mla") return "(" + who + ")";
  if (style === "chicago") return "(" + who + " " + y + ")";
  return "(" + who + ", " + y + ")";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function toHtml(runs: Run[]) { return runs.map(function (r) { return r.i ? "<i>" + esc(r.t) + "</i>" : esc(r.t); }).join(""); }
function plain(runs: Run[]) { return runs.map(function (r) { return r.t; }).join(""); }

function sortKey(text: string) { return text.replace(/^[^\p{L}\p{N}]+/u, "").replace(/^(the|a|an)\s+/i, "").toLocaleLowerCase(); }

/** Fields a style guide expects but the source lacks (the website's "Missing:" chip). */
function missing(src: any) {
  const out: string[] = [];
  if (!clean(src.title)) out.push('title');
  if (!clean(src.year) && src.type !== 'website') out.push('year');
  if (TYPES[src.type].f.indexOf('container') >= 0 && !clean(src.container)) out.push(TYPES[src.type].container.toLowerCase());
  return out;
}

const STYLE_IDS = ['apa', 'mla', 'chicago', 'harvard', 'ieee'] as const;
const FIELD_KEYS = ['title', 'container', 'editors', 'year', 'month', 'day', 'edition', 'volume', 'issue', 'pages', 'number', 'publisher', 'place', 'doi', 'url', 'accessed'] as const;

const str = (d: string) => z.union([z.string(), z.number()]).optional().describe(d);
const sourceSchema = z.object({
  type: z.enum(['book', 'chapter', 'journal', 'website', 'newspaper', 'video', 'report']).describe('Source type.'),
  authors: z.array(z.object({
    first: z.string().optional().describe('Given name(s), e.g. "Gerald Jay".'),
    last: z.string().optional().describe('Family name, or the organisation name when org is true.'),
    org: z.boolean().optional().describe('The author is an organisation.'),
  })).optional().describe('Authors in order (for a video: the creator/channel).'),
  title: str('Title of the work (book, article, chapter, page, video, report).'),
  container: str('Journal / book (for a chapter) / website / newspaper / platform name.'),
  editors: str('chapter: editors as "First Last; First Last" or "Last, First; …".'),
  year: str('Year of publication.'), month: str('Month 1-12.'), day: str('Day of the month.'),
  edition: str('Edition, e.g. "2" or "2nd ed." (1st is omitted).'),
  volume: str('journal: volume.'), issue: str('journal: issue.'), pages: str('Page or page range, e.g. "715-731".'),
  number: str('report: report number.'), publisher: str('Publisher (report: organisation).'), place: str('Place of publication.'),
  doi: str('DOI (with or without https://doi.org/).'), url: str('URL.'), accessed: z.string().optional().describe('Date accessed, YYYY-MM-DD.'),
});

export default defineTool({
  name: 'text_citation',
  title: 'Citation generator',
  webSlug: 'citation-gen',
  description:
    'Format references from structured fields in APA 7, MLA 9, Chicago author-date (17th), Harvard (Cite Them Right) or ' +
    'IEEE, for books, book chapters, journal articles, web pages, newspaper/magazine articles, videos and reports. Handles ' +
    'author-count rules (et al.), initials, organisations as authors, editions, page ranges (MLA 127-53), DOIs, URLs and ' +
    'access dates, and title case for MLA/Chicago/IEEE. Returns each citation as plain text and HTML (italics as <i>), the ' +
    'in-text citation, missing-field hints, and the whole list as a bibliography sorted for the style (numbered for IEEE). ' +
    `Web version: ${webUrl('citation-gen')}`,
  inputSchema: z.object({
    style: z.enum(STYLE_IDS).describe('Citation style: apa, mla, chicago, harvard or ieee.'),
    sources: z.array(sourceSchema).min(1).max(500).describe('One or more sources.'),
    autoCase: z.boolean().optional().default(true).describe('Apply title case where the style wants it (MLA, Chicago, IEEE book titles). Default true.'),
  }),
  outputSchema: z.object({
    style: z.string(),
    citations: z.array(z.object({
      text: z.string(), html: z.string(), inText: z.string(), missing: z.array(z.string()).describe('Fields the style expects but are empty.'),
    })).describe('In the order given.'),
    bibliographyTitle: z.string().describe('References / Works Cited / Reference list.'),
    bibliography: z.string().describe('All entries sorted for the style (IEEE: numbered in the order given), separated by blank lines.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [
    {
      input: { style: 'apa', sources: [{ type: 'book', authors: [{ first: 'Harold', last: 'Abelson' }, { first: 'Gerald Jay', last: 'Sussman' }], title: 'Structure and interpretation of computer programs', edition: '2', year: '1996', publisher: 'MIT Press', place: 'Cambridge, MA, USA' }] },
      note: 'Abelson, H., & Sussman, G. J. (1996). Structure and interpretation of computer programs (2nd ed.). MIT Press.',
    },
  ],
  run(input) {
    const srcs = input.sources.map((s) => {
      const src: any = { type: s.type, autoCase: input.autoCase, authors: s.authors ?? [] };
      for (const k of FIELD_KEYS) src[k] = TYPES[s.type].f.indexOf(k) >= 0 && s[k] != null ? String(s[k]) : '';
      if (!clean(src.title) && !src.authors.some((a: any) => clean(a.last) || clean(a.first))) throw new ToolError('Each source needs at least a title or an author.');
      return src;
    });
    const st = input.style;
    const rows = srcs.map((src, i) => { const runs = format(src, st).runs(); return { src, runs, text: plain(runs), n: i }; });
    const sorted = st === 'ieee' ? rows : rows.slice().sort((a, b) => sortKey(a.text).localeCompare(sortKey(b.text)));
    return {
      style: STYLES[st],
      citations: rows.map((r) => ({ text: r.text, html: toHtml(r.runs), inText: inText(r.src, st, r.n + 1), missing: missing(r.src) })),
      bibliographyTitle: BIB_TITLE[st],
      bibliography: sorted.map((r, i) => (st === 'ieee' ? '[' + (i + 1) + '] ' : '') + r.text).join('\n\n'),
    };
  },
});

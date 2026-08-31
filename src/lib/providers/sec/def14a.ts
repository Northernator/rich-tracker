/**
 * SEC EDGAR DEF 14A — the only sanctioned source for pledged shares.
 *
 * Pledges are disclosed in the proxy statement's beneficial-ownership table
 * footnotes ("Mr. X has pledged N shares as collateral …"), and nowhere else —
 * not Form 4, not 13F. A 13F reports a fund's portfolio; a Form 4 reports
 * transactions, not encumbrances.
 *
 * This module fetches the company's most recent DEF 14A per securities.cik,
 * saves the raw document verbatim under data/raw/sec/<cik>/<accession>.htm
 * (+ .meta.json) per the audit-trail rule, and strips HTML to text. The
 * loader (load_pledges.ts) indexes that text into `filings_fts` (FTS5,
 * porter) and MATCHes 'pledge OR pledged OR collateral' with snippet() to
 * pull the surrounding sentences.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { politeFetch } from "@/lib/providers/http";
import { fetchSubmissions, filingUrl } from "./edgar";

const RAW_ROOT = join(process.cwd(), "data", "raw", "sec");

export interface Def14aDoc {
  /** Zero-padded 10-digit issuer CIK. */
  cik: string;
  accession: string;
  filingDate: string;
  primaryDocument: string;
  /** Human-openable URL of the document that states the pledge. */
  url: string;
  /** Stripped HTML text, parsed from the on-disk copy. */
  text: string;
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  bull: "\u2022",
  deg: "\u00b0",
  eacute: "\u00e9",
  agrave: "\u00e0",
  egrave: "\u00e8",
  oacute: "\u00f3",
  uacute: "\u00fa",
  iacute: "\u00ed",
  ccedil: "\u00e7",
  ntilde: "\u00f1",
  szlig: "\u00df",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Strip HTML to plain text while preserving block boundaries (a <p> or a
 * table cell is a separate line), so a sentence never gets glued to its
 * neighbour and the text can be FTS-indexed + sentence-split reliably.
 */
export function stripHtml(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|tr|table|h[1-6]|li|br|section|article|td|th)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  t = t.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/** Abbreviations whose trailing period must not be read as a sentence end. */
const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "st", "sr", "jr", "inc", "corp", "ltd", "co", "no",
  "approx", "vs", "etc", "e.g", "i.e", "al", "u.s", "u.k", "ph.d", "jan", "feb",
  "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "dept", "fig",
  "cf", "mfs", "nasdaq", "nyse", "gen", "maj", "sen", "rep", "gov", "cl", "assn",
  "cto", "ceo", "cfo", "sec", "dol", "irs", "e.g", "i.e", "mr", "mrs", "dr",
]);

/** Split text into sentences. Returns trimmed, whitespace-collapsed sentences. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const re = /([.!?])(\s+)([A-Z0-9\u201c"'(\[])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(0, m.index).trimEnd();
    const prevToken = before.match(/([A-Za-z.]+)$/);
    let isAbbrev = false;
    if (prevToken) {
      const tok = prevToken[1].toLowerCase();
      if (ABBREV.has(tok)) isAbbrev = true;
      else if (/^[A-Za-z]\.$/.test(tok)) isAbbrev = true; // single-letter initial "J."
    }
    if (isAbbrev) continue;
    sentences.push(text.slice(last, m.index + 1).replace(/\s+/g, " ").trim());
    last = m.index + 1;
  }
  sentences.push(text.slice(last).replace(/\s+/g, " ").trim());
  return sentences.filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch (or reuse) the company's most recent DEF 14A for an issuer CIK.
 * Returns null when the issuer has no DEF 14A in its recent filings.
 */
export async function fetchDef14a(issuerCik: string): Promise<Def14aDoc | null> {
  const cik = issuerCik.replace(/\D/g, "").padStart(10, "0");
  const sub = await fetchSubmissions(cik);
  const def14a = sub.recent.find((f) => f.form === "DEF 14A");
  if (!def14a) return null;

  const url = filingUrl(cik, def14a.accession, def14a.primaryDocument);
  const rel = join(cik, `${def14a.accession}.htm`);
  const abs = join(RAW_ROOT, rel);

  if (!existsSync(abs)) {
    const res = await politeFetch(url);
    const html = await res.text();
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, html, "utf8");
    writeFileSync(
      `${abs}.meta.json`,
      JSON.stringify(
        {
          url,
          accession: def14a.accession,
          filingDate: def14a.filingDate,
          cik,
          primaryDocument: def14a.primaryDocument,
          fetchedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
  }

  const html = readFileSync(abs, "utf8");
  return {
    cik,
    accession: def14a.accession,
    filingDate: def14a.filingDate,
    primaryDocument: def14a.primaryDocument,
    url,
    text: stripHtml(html),
  };
}

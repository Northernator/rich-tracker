/**
 * SEC EDGAR client — the only sanctioned source for personal shareholdings.
 *
 * Citation semantics (the whole point of this module):
 *   Form 4  — sharesOwnedFollowingTransaction is the exact post-transaction
 *             holding. PRIMARY source, always preferred.
 *   Form 3  — initial statement of beneficial ownership. Baseline when no
 *             Form 4 exists.
 *   Form 5  — annual statement of deferred transactions. Supplement.
 *   13F-HR  — an institutional manager's portfolio. NEVER used here: a 13F
 *             row would attribute a fund's book to an individual.
 *   10-K    — the company's annual report. It does not state any individual's
 *             shareholding and is never cited for one.
 *
 * Audit trail: every fetched document is saved verbatim under
 *   data/raw/sec/<cik>/<accession>.xml  (+ .meta.json)
 * and parsed FROM DISK, so a number in the database can always be traced to
 * the exact bytes EDGAR served. No document is ever rewritten or deleted —
 * data/raw/ is append-only.
 *
 * Etiquette: User-Agent is mandatory (politeFetch sets it) and the per-host
 * rate limiter in politeFetch keeps us under EDGAR's 8 req/sec ceiling.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { politeFetch } from "@/lib/providers/http";

const RAW_ROOT = join(process.cwd(), "data", "raw", "sec");
const SUBMISSIONS_URL = (cik: string) =>
  `https://data.sec.gov/submissions/CIK${cik.replace(/\D/g, "").padStart(10, "0")}.json`;

export interface OwnerFiling {
  form: string;
  accession: string;
  filingDate: string;
  reportDate: string;
  primaryDocument: string;
}

export interface Submissions {
  cik: string;
  name: string;
  tickers: string[];
  recent: OwnerFiling[];
}

interface RawSubmissions {
  cik: string;
  name: string;
  tickers?: string[];
  filings: {
    recent: {
      form: string[];
      filingDate: string[];
      accessionNumber: string[];
      reportDate: string[];
      primaryDocument: string[];
    };
  };
}

function saveRaw(relPath: string, content: string, meta?: object): string {
  const abs = join(RAW_ROOT, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  if (meta) writeFileSync(`${abs}.meta.json`, JSON.stringify(meta, null, 2), "utf8");
  return abs;
}

/** Fetch submissions JSON for a CIK, caching verbatim under data/raw/sec/. */
export async function fetchSubmissions(cik: string): Promise<Submissions> {
  const rel = join(cik, "submissions.json");
  const abs = join(RAW_ROOT, rel);
  let text: string;
  if (existsSync(abs)) {
    text = readFileSync(abs, "utf8");
  } else {
    const res = await politeFetch(SUBMISSIONS_URL(cik));
    text = await res.text();
    saveRaw(rel, text, { url: SUBMISSIONS_URL(cik), fetchedAt: new Date().toISOString() });
  }
  const raw = JSON.parse(text) as RawSubmissions;
  const r = raw.filings.recent;
  const recent: OwnerFiling[] = r.form.map((form, i) => ({
    form,
    accession: r.accessionNumber[i],
    filingDate: r.filingDate[i],
    reportDate: r.reportDate[i],
    primaryDocument: r.primaryDocument[i],
  }));
  return { cik: raw.cik, name: raw.name, tickers: raw.tickers ?? [], recent };
}

/**
 * Fetch a Form 3/4/5 XML body, saving it verbatim, and return the bytes for
 * parsing. The parse always runs over the on-disk copy (audit-trail rule).
 *
 * The submissions list reports Form 4 documents as "xslF345X06/wk-form4….xml"
 * — that path renders EDGAR's XSL-styled HTML. The raw XML lives at the same
 * accession without the stylesheet directory, so the prefix is stripped and a
 * doctype-shaped response is rejected loudly rather than parsed as HTML.
 */
export async function fetchFilingXml(
  cik: string,
  accession: string,
  primaryDocument: string
): Promise<string> {
  const accNoDash = accession.replace(/-/g, "");
  const cikNoPad = cik.replace(/^0+/, "");
  const rawDoc = primaryDocument.replace(/^xsl[^/]*\//i, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accNoDash}`;
  const url = `${base}/${rawDoc}`;
  const rel = join(cik, `${accession}.xml`);
  const abs = join(RAW_ROOT, rel);
  if (!existsSync(abs)) {
    const res = await politeFetch(url);
    const body = await res.text();
    if (/^\s*(<!DOCTYPE|<html)/i.test(body)) {
      throw new Error(`expected raw XML but got HTML at ${url} — refusing to parse a rendered page`);
    }
    saveRaw(rel, body, {
      url,
      accession,
      primaryDocument: rawDoc,
      cik,
      fetchedAt: new Date().toISOString(),
    });
  }
  return readFileSync(abs, "utf8");
}

/** The human-openable URL of the filing document that states the share count. */
export function filingUrl(cik: string, accession: string, primaryDocument: string): string {
  const accNoDash = accession.replace(/-/g, "");
  const rawDoc = primaryDocument.replace(/^xsl[^/]*\//i, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${accNoDash}/${rawDoc}`;
}

// ---------------------------------------------------------------------------
// Form 4 XML parsing
// ---------------------------------------------------------------------------

export interface Form4Entry {
  /** securityTitle as stated in the filing, e.g. "Class A Common Stock". */
  title: string;
  /** sharesOwnedFollowingTransaction — the post-transaction holding. */
  shares: number;
  /** Transaction date for the line that produced this count (Form 4 only). */
  asOf: string | null;
  /**
   * True when the filing's own footnotes state that an entity (trust, LLC,
   * partnership) holds these shares and the reporting person DISCLAIMS
   * beneficial ownership of them. Such a line is evidence of the entity's
   * stake, never the individual's — three Walton family members each report
   * the same trust's 603,989,702 WMT shares this way.
   */
  disclaimed: boolean;
}

export interface ParsedOwnershipDoc {
  issuerName: string;
  symbol: string;
  /** documentType: 3, 4, or 5. */
  form: string;
  /** periodOfReport from the document header. */
  periodOfReport: string;
  /** Per security title: the latest post-transaction/holding count. */
  entries: Form4Entry[];
  /**
   * Entity-held lines whose beneficial ownership the filing disclaims. Never
   * part of `entries` — kept so the run log can show exactly what was skipped
   * and why (e.g. three Waltons × the same trust's 603,989,702 WMT).
   */
  disclaimedTitles: Array<{ title: string; shares: number }>;
}

function firstValue(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>[\\s\\S]*?<value>([^<]*)</value>`));
  return m ? m[1].trim() : null;
}

/** Footnote text that marks a line as an entity's stake, not the person's. */
const DISCLAIMER_RE = /disclaims beneficial ownership|pecuniary interest|by trust|held by (?:the )?(?:trust|llc|partnership|entity)/i;

/**
 * Parse a Form 3/4/5 ownership XML.
 *
 * Reads sharesOwnedFollowingTransaction — NOT transactionShares. The
 * transaction line (transactionShares) is how much moved in the trade; the
 * old loader read it, which is how Bezos once showed 230,637 AMZN shares.
 *
 * Footnote attribution: each transaction line can cite footnotes, and those
 * footnotes often state the shares are held by a trust or LLC whose
 * beneficial ownership the reporting person disclaims. Lines whose footnotes
 * match the disclaimer language are flagged; a disclaimed line is never used
 * as the person's holding.
 */
export function parseOwnershipXml(xml: string, fallbackForm: string, fallbackDate: string): ParsedOwnershipDoc | null {
  const issuerName = xml.match(/<issuerName>([^<]+)<\/issuerName>/)?.[1]?.trim() ?? "";
  const symbol = xml.match(/<issuerTradingSymbol>([^<]+)<\/issuerTradingSymbol>/)?.[1]?.trim() ?? "";
  const form = xml.match(/<documentType>([^<]+)<\/documentType>/)?.[1]?.trim() ?? fallbackForm;
  const periodOfReport =
    xml.match(/<periodOfReport>([^<]+)<\/periodOfReport>/)?.[1]?.trim() || fallbackDate;

  if (!symbol) return null;

  // Footnotes: id → plain text.
  const footnotes = new Map<string, string>();
  const fnRe = /<footnote(?:\s+id="([^"]*)")[^>]*>([\s\S]*?)<\/footnote>/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(xml)) !== null) {
    const id = m[1] ?? `anon:${footnotes.size}`;
    footnotes.set(id, m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }

  const lineDisclaimed = (block: string): boolean => {
    const ids = [...block.matchAll(/<footnoteId\s+id="([^"]*)"/g)].map((x) => x[1]);
    for (const id of ids) {
      const text = footnotes.get(id);
      if (text && DISCLAIMER_RE.test(text)) return true;
    }
    return false;
  };

  const entries: Form4Entry[] = [];
  const disclaimedTitles: Array<{ title: string; shares: number }> = [];
  const byTitle = new Map<string, Form4Entry>();

  // Disclaimed lines (entity-held, ownership disclaimed) never contribute;
  // among personal lines, the last one per title wins (chronological order).
  const record = (title: string, shares: number, asOf: string | null, disclaimed: boolean) => {
    if (disclaimed) {
      const last = disclaimedTitles[disclaimedTitles.length - 1];
      if (last && last.title === title) last.shares = shares; // running entity count
      else disclaimedTitles.push({ title, shares });
      return;
    }
    byTitle.set(title, { title, shares, asOf, disclaimed: false });
  };

  // Transactions: the LAST non-disclaimed sharesOwnedFollowingTransaction per
  // title wins — lines are chronological within the document.
  const txnRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  while ((m = txnRe.exec(xml)) !== null) {
    const block = m[1];
    const title = firstValue(block, "securityTitle");
    const post = firstValue(block, "sharesOwnedFollowingTransaction");
    if (!title || post == null) continue;
    const shares = Number(post.replace(/,/g, ""));
    if (!Number.isFinite(shares)) continue;
    const asOf = firstValue(block, "transactionDate");
    record(title, shares, asOf, lineDisclaimed(block));
  }

  // Holdings (Form 3 / lines without transactions): initial ownership counts.
  const holdRe = /<nonDerivativeHolding>([\s\S]*?)<\/nonDerivativeHolding>/g;
  while ((m = holdRe.exec(xml)) !== null) {
    const block = m[1];
    const title = firstValue(block, "securityTitle");
    const post = firstValue(block, "sharesOwnedFollowingTransaction");
    if (!title || post == null) continue;
    const shares = Number(post.replace(/,/g, ""));
    if (!Number.isFinite(shares)) continue;
    if (!byTitle.has(title) && !lineDisclaimed(block)) {
      byTitle.set(title, { title, shares, asOf: null, disclaimed: false });
    }
  }

  for (const e of byTitle.values()) entries.push(e);
  return { issuerName, symbol, form, periodOfReport, entries, disclaimedTitles };
}

/**
 * Select the entry for a tracked listed security from a parsed ownership doc.
 *
 * Class rules (why this exists): insiders hold multiple classes but only one
 * is the listed security we track. Meta's Form 4s report huge Class B counts
 * (unlisted voting shares); crediting those as META would double the real
 * Class A stake. Berkshire files as "BRK" — aliased to our BRK-B security.
 */
const SYMBOL_ALIASES: Record<string, string> = {
  BRK: "BRK-B",
};

export function symbolToTrackedTicker(symbol: string): string | null {
  if (SYMBOL_ALIASES[symbol]) return SYMBOL_ALIASES[symbol];
  return symbol; // caller checks membership in the securities table
}

export function selectEntryForTicker(
  parsed: ParsedOwnershipDoc,
  ticker: string
): Form4Entry | null {
  // Class letter of the tracked security: BRK-B → "B", GOOGL → none.
  const classLetter = ticker.match(/[-.\/ ]([A-Z])$/)?.[1] ?? null;
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

  const candidates = parsed.entries.filter((e) => e.shares > 0);
  if (candidates.length === 0) return null;

  if (classLetter) {
    const match = candidates.filter((e) => norm(e.title).includes(`class ${classLetter.toLowerCase()}`));
    return match.length === 1 ? match[0] : null;
  }

  // No class suffix: prefer the plain "Common Stock" line; if every line is
  // class-qualified (META reports "Class A Common Stock"), take Class A —
  // the listed class for single-class-A tickers like META and GOOGL.
  const plain = candidates.filter((e) => !norm(e.title).includes("class"));
  if (plain.length === 1) return plain[0];
  if (plain.length === 0) {
    const classA = candidates.filter((e) => norm(e.title).includes("class a"));
    if (classA.length === 1) return classA[0];
    return null;
  }
  return null; // several plain lines and no way to disambiguate — do not guess
}

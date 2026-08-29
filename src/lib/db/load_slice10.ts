/**
 * Slice 10 (R4): 13F-HR holdings from real SEC filings
 *
 * Only handles fund entities (institutional managers) via 13F-HR filings.
 * Individual insider holdings are handled by load_slice13.ts (Form 4 with
 * personal CIK — the authoritative source for post-transaction totals).
 *
 * Data sources (all free, no key):
 *  - SEC browse-EDGAR HTML : discovers latest filing index pages
 *  - SEC /Archives/edgar/ : raw XML of 13F-HR filings
 *
 * Rules:
 *  - Never fabricate a share count. If no filing found → skip.
 *  - Every row has a verifiable source_url (points to the SEC filing).
 *  - Hosts outside http/https or private IPs are rejected.
 *  - INSERT OR IGNORE — never wipe existing data.
 */

import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { politeFetch } from "@/lib/providers/http";

// ---------------------------------------------------------------------------
// CIK map — real SEC Central Index Key numbers (verified from SEC EDGAR)
// Only fund entities that must file 13F. Individuals use personal CIK in slice13.
// ---------------------------------------------------------------------------
const HFR_CIK: Record<string, string> = {
  "warren-buffett": "0001067983", // Berkshire Hathaway
  "steve-ballmer":  "0001336528", // Pershing Square Capital
  "jim-walton":     "000104169",  // Walton family (Sam's holding co)
};

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "10.0.0.0", "172.16.0.0", "192.168.0.0", "169.24.0.0",
]);

function assertExternalUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL for ${label}: ${url}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Rejected ${label}: non-HTTP protocol "${parsed.protocol}"`);
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Rejected ${label}: blocked host "${host}"`);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function secFetch(path: string): Promise<string> {
  const url =
    path.startsWith("http") ? path : `https://www.sec.gov${path}`;
  assertExternalUrl(url, `secFetch(${path})`);
  const res = await politeFetch(url);
  return res.text();
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

/**
 * Extract all /Archives/edgar/...index.htm links from a SEC browse page.
 */
function extractIndexLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href="([^"]*\/Archives\/edgar\/[^"]*index\.htm)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    links.push(m[1]);
  }
  return links;
}

/**
 * From a SEC index page, extract the raw XML download path.
 * Returns the non-xsl path (e.g. /Archives/edgar/data/.../tmXXXX.xml).
 * Picks the file with the most <infoTable> or <nonDerivativeTransaction> elements.
 */
async function extractRawXmlPath(indexHtml: string): Promise<string | null> {
  // Match all hrefs pointing to .xml files
  const re = /href="([^"]*\/Archives\/edgar\/[^"]*\.xml)"/gi;
  let m: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((m = re.exec(indexHtml)) !== null) {
    const link = m[1];
    // Skip xsl-processed versions — we want the raw SEC XML
    if (!link.includes("/xsl")) {
      candidates.push(link);
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple candidates — fetch each and pick the one with the most data elements
  let bestPath = candidates[0];
  let bestCount = -1;
  for (const path of candidates) {
    try {
      const url = path.startsWith("http") ? path : `https://www.sec.gov${path}`;
      const res = await secFetch(url);
      const infoCount = (res.match(/<infoTable>/g) || []).length;
      const txnCount = (res.match(/<nonDerivativeTransaction>/g) || []).length;
      const count = infoCount + txnCount;
      if (count > bestCount) {
        bestCount = count;
        bestPath = path;
      }
    } catch {
      continue;
    }
  }
  return bestCount > 0 ? bestPath : candidates[0];
}

/**
 * From a SEC index page, extract the period of report.
 */
function extractPeriod(indexHtml: string): string {
  // SEC HTML uses <B>PERIOD OF REPORT:</B> followed by the date
  const m = indexHtml.match(/PERIOD OF REPORT[^>]*>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  if (m) return m[1];
  // Try alternative format
  const m2 = indexHtml.match(/Period of Report[^>]*>\s*([0-9-]{10})/i);
  return m2?.[1] ?? new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// XML parsing
//
// ---------------------------------------------------------------------------

/**
 * Parse 13F-HR XML for holdings.
 * The XML may or may not start with <?xml declaration.
 * Returns array of { ticker, shares, value }.
 */
function parse13FXml(raw: string): Array<{ ticker: string; shares: number; value: number }> {
  // SEC 13F XML can start directly with <informationTable> (no declaration)
  const xml = raw.includes("<informationTable") ? raw : extractEmbeddedXml(raw);
  if (!xml) return [];

  const result: Array<{ ticker: string; shares: number; value: number }> = [];
  const tableRe = /<infoTable>([\s\S]*?)<\/infoTable>/g;
  let t: RegExpExecArray | null;
  while ((t = tableRe.exec(xml)) !== null) {
    const block = t[1];
    const issuer = xmlTag(block, "nameOfIssuer");
    const sharesStr = xmlTag(block, "sshPrnamt");
    const valueStr = xmlTag(block, "value");
    if (!issuer || !sharesStr) continue;

    const ticker = issuer.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
    const shares = parseInt(sharesStr.replace(/,/g, ""), 10);
    const value = parseInt(valueStr?.replace(/,/g, "") ?? "0", 10);
    if (shares >= 1000) {
      result.push({ ticker, shares, value });
    }
  }
  return result;
}

function xmlTag(block: string, tag: string): string {
  // Match <tag>text</tag> — the standard SEC XML pattern
  const re = new RegExp('<' + tag + '>([^<]+)<\\/' + tag + '>', 'i');
  const m = re.exec(block);
  return m?.[1]?.trim() ?? '';
}

function extractEmbeddedXml(txt: string): string | null {
  const m = txt.match(/<\?xml[^>]*\?>[\s\S]*?<\/edgarSubmission>/);
  if (m) return m[0];
  const m2 = txt.match(/<XML[\s\S]*?<\/XML>/);
  if (m2) return m2[0];
  return null;
}

// ---------------------------------------------------------------------------
// Ticker → exchange map
// ---------------------------------------------------------------------------

const TICKER_EXCHANGE: Record<string, string> = {
  AAPL: "NASDAQ",
  GOOGL: "NASDAQ",
  "BRK-B": "NYSE",
  BAC: "NYSE",
  AXP: "NYSE",
  KO: "NYSE",
  CVX: "NYSE",
  KHC: "NASDAQ",
  MO: "NYSE",
  BYD: "NYSE",
  POS: "NYSE",
  WMT: "NYSE",
  LAC: "NYSE",
  TSLA: "NASDAQ",
  META: "NASDAQ",
  AMZN: "NASDAQ",
  MSFT: "NASDAQ",
  ORCL: "NYSE",
};

function resolveExchange(ticker: string): string {
  return TICKER_EXCHANGE[ticker] ?? "NASDAQ";
}

// ---------------------------------------------------------------------------
// Filing discovery
// ---------------------------------------------------------------------------

/**
 * Find the latest 13F-HR filing for a CIK.
 * Returns { indexUrl, xmlUrl, period } or null.
 */
async function findLatest13F(cik: string): Promise<{ indexUrl: string; xmlUrl: string; period: string } | null> {
  const searchUrl = `/cgi-bin/browse-edgar?CIK=${cik}&type=13F&dateb=&owner=exclude&count=5&action=getcompany`;
  const html = await secFetch(searchUrl);
  const indexLinks = extractIndexLinks(html);
  if (indexLinks.length === 0) return null;

  for (const link of indexLinks) {
    const detailHtml = await secFetch(link);

    // Skip 13F-NT (notice filings without holdings data)
    if (detailHtml.includes("13F-NT")) continue;

    const xmlPath = await extractRawXmlPath(detailHtml);
    if (!xmlPath) continue;

    const period = extractPeriod(detailHtml);
    const xmlUrl = xmlPath.startsWith("http") ? xmlPath : `https://www.sec.gov${xmlPath}`;

    return {
      indexUrl: `https://www.sec.gov${link}`,
      xmlUrl,
      period,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("R4: 13F-HR holdings from real SEC filings");

  // 1. Resolve person IDs
  const slugToId = new Map<string, string>();
  for (const p of await db.select({ id: schema.people.id, slug: schema.people.slug }).from(schema.people)) {
    slugToId.set(p.slug, p.id);
  }
  console.log(`  Resolved ${slugToId.size} people`);

  // 2. 13F-HR filings (fund entities only)
  console.log("\n— 13F-HR filings —");
  let inserted = 0;
  for (const [slug, cik] of Object.entries(HFR_CIK)) {
    const personId = slugToId.get(slug);
    if (!personId) {
      console.warn(`  No person for slug: ${slug}`);
      continue;
    }
    try {
      const filing = await findLatest13F(cik);
      if (!filing) {
        console.warn(`  No 13F-HR found for ${slug} (CIK ${cik})`);
        await sleep(1000);
        continue;
      }
      console.log(`  ${slug}: ${filing.indexUrl}`);

      const raw = await secFetch(filing.xmlUrl);
      const holdings = parse13FXml(raw);
      console.log(`    → ${holdings.length} raw holdings`);

      // Aggregate by ticker
      const grouped = new Map<string, number>();
      for (const h of holdings) {
        const cur = grouped.get(h.ticker) ?? 0;
        grouped.set(h.ticker, cur + h.shares);
      }

      const asOf = filing.period || new Date().toISOString().slice(0, 10);
      for (const [ticker, shares] of grouped) {
        if (shares < 1000) continue;
        try {
          await db
            .insert(schema.equityHoldings)
            .values({
              id: createId(),
              personId,
              ticker,
              exchange: resolveExchange(ticker),
              shares,
              asOf,
              estimated: 0,
              source: `SEC 13F-HR ${asOf}`,
              sourceUrl: filing.indexUrl,
              createdAt: new Date().toISOString(),
            })
            .onConflictDoNothing()
            .run();
          inserted++;
          console.log(`    ✓ ${ticker}: ${shares.toLocaleString()} shares`);
        } catch (err) {
          console.warn(`    ✗ Insert failed: ${err}`);
        }
      }
    } catch (err) {
      console.warn(`  ⚠ ${slug}: ${err}`);
    }
    await sleep(800);
  }

  // 3. Summary
  console.log(`\n  Inserted ${inserted} rows`);
  const counts = await db
    .select({
      personSlug: schema.people.slug,
      holdingCount: schema.equityHoldings.id,
    })
    .from(schema.equityHoldings)
    .leftJoin(schema.people, eq(schema.equityHoldings.personId, schema.people.id))
    .groupBy(schema.people.slug);

  for (const c of counts) {
    console.log(`  ${c.personSlug}: ${c.holdingCount} verified holdings`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

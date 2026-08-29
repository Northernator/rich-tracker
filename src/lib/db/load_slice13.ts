/**
 * Slice 13: Holdings from SEC Form 4 (post-transaction shares)
 *
 * Uses the billionaire's PERSONAL CIK to fetch Form 4 filings directly.
 * Filters by known ticker to get the right filing.
 * Extracts post-transaction holdings (sharesOwnedFollowingTransaction),
 * not transaction shares.
 *
 * For fund entities (Buffett/Berkshire, Ballmer/Pershing), falls back to
 * 13F-HR with CUSIP→ticker mapping.
 *
 * Rules:
 * - Never delete existing equity_holdings. INSERT OR IGNORE on (person_id, ticker, as_of).
 * - Every row has a verifiable source_url pointing to the SEC filing.
 * - Post-transaction holdings are the authoritative count.
 * - If no filing found → skip (don't fabricate).
 */

import { db, sqlite } from "@/lib/db";
import { checkHolding } from "./sanity";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { politeFetch } from "@/lib/providers/http";

// ---------------------------------------------------------------------------
// CUSIP → Ticker mapping (compiled from SEC EDGAR data)
// ---------------------------------------------------------------------------
const CUSIP_MAP: Record<string, string> = {
  // Financials
  "02005N100": "ALLY",   // Ally Financial
  "060505104": "BAC",   // Bank of America
  "14040H105": "COF",   // Capital One
  "47233W109": "JEF",   // Jefferies
  "615369105": "MCO",   // Moody's
  "H1467J104": "CB",    // Chubb
  // Industrials
  "23331A109": "DHI",   // D.R. Horton
  "526057104": "LEN",   // Lennar
  "526057302": "LEN",   // Lennar (class B)
  "670346105": "NUE",   // Nucor
  "62944T105": "NVR",   // NVR Inc
  // Energy
  "166764100": "CVX",   // Chevron
  "674599105": "OXY",   // Occidental Petroleum
  // Consumer
  "191216100": "KO",    // Coca-Cola
  "23918K108": "DVA",   // DaVita
  "500754106": "KHC",   // Kraft Heinz
  "501044101": "KR",    // Kroger
  "55616P104": "M",     // Macy's
  // Technology
  "02079K107": "GOOGL", // Alphabet (class A)
  "02079K305": "GOOGL", // Alphabet (class C)
  "829933100": "SIRI",  // SiriusXM
  "92343E102": "VRSN",  // Verisign
  // Other
  "025816109": "AXP",   // American Express
  "037833100": "AAPL",  // Apple
  "247361702": "DAL",   // Delta Air Lines
  "546347105": "LPX",   // Louisiana-Pacific
};

// ---------------------------------------------------------------------------
// Form 4 filers — personal CIK + known ticker
// ---------------------------------------------------------------------------
const FORM4_FILERS: Array<{
  slug: string;
  name: string;
  cik: string;
  ticker: string;
  exchange: string;
}> = [
  { slug: "elon-musk", name: "Musk Elon", cik: "0001494730", ticker: "TSLA", exchange: "NASDAQ" },
  { slug: "jeff-bezos", name: "BEZOS JEFFREY P", cik: "0001043298", ticker: "AMZN", exchange: "NASDAQ" },
  { slug: "mark-zuckerberg", name: "Zuckerberg Mark", cik: "0001548760", ticker: "META", exchange: "NASDAQ" },
  { slug: "larry-page", name: "Page", cik: "0001738007", ticker: "GOOGL", exchange: "NASDAQ" },
  { slug: "sergey-brin", name: "Brin", cik: "0001280765", ticker: "GOOGL", exchange: "NASDAQ" },
];

// ---------------------------------------------------------------------------
// Fund entity CIKs — use 13F-HR for these (not Form 4)
// ---------------------------------------------------------------------------
const FUND_FILERS: Array<{
  slug: string;
  cik: string;
  name: string;
}> = [
  { slug: "warren-buffett", cik: "0001067983", name: "Berkshire Hathaway" },
  { slug: "steve-ballmer", cik: "0001336528", name: "Pershing Square" },
];

// ---------------------------------------------------------------------------
// SEC helpers
// ---------------------------------------------------------------------------

async function secFetch(path: string): Promise<string> {
  const url = path.startsWith("http") ? path : `https://www.sec.gov${path}`;
  const res = await politeFetch(url);
  return res.text();
}

function extractIndexLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href="([^"]*\/Archives\/edgar\/[^"]*index\.htm)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    links.push(m[1]);
  }
  return links;
}

async function extractRawXmlPath(indexHtml: string): Promise<string | null> {
  const re = /href="([^"]*\/Archives\/edgar\/[^"]*\.xml)"/gi;
  let m: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((m = re.exec(indexHtml)) !== null) {
    const link = m[1];
    if (!link.includes("/xsl")) {
      candidates.push(link);
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let bestPath = candidates[0];
  let bestCount = -1;
  for (const path of candidates) {
    try {
      const url = path.startsWith("http") ? path : `https://www.sec.gov${path}`;
      const res = await secFetch(url);
      // Remove namespace declarations before counting
      const cleaned = res.replace(/xmlns[^=]*=[^>]*>/g, '>');
      const infoCount = (cleaned.match(/<infoTable>/g) || []).length;
      const txnCount = (cleaned.match(/<nonDerivativeTransaction>/g) || []).length;
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Parse Form 4 XML — extract post-transaction holdings
// ---------------------------------------------------------------------------
interface Form4Holding {
  ticker: string;
  shares: number;
  asOf: string;
  sourceUrl: string;
  source: string;
}

async function parseForm4(xml: string, filingUrl: string, expectedTicker: string): Promise<Form4Holding | null> {
  const xmlText = xml.includes("<?xml") ? xml : extractEmbeddedXml(xml);
  const xml2 = xml.includes("<informationTable") ? xml : xmlText;
  if (!xml2) return null;

  const ticker = xml2.match(/<issuerTradingSymbol>([^<]+)<\/issuerTradingSymbol>/)?.[1]?.trim();
  if (ticker !== expectedTicker) return null;

  const updatedMatch = xml2.match(/<dateTime>[\s\S]*?<year>(\d{4})<\/year>[\s\S]*?<month>(\d{2})<\/month>[\s\S]*?<day>(\d{2})<\/day>/);
  const asOf = updatedMatch ? `${updatedMatch[1]}-${updatedMatch[2]}-${updatedMatch[3]}` : new Date().toISOString().slice(0, 10);

  const txns = [...xml2.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)];

  // Find the latest transaction with post-holding
  let latestPostShares: number | null = null;
  for (const txMatch of txns) {
    const block = txMatch[1];
    const postSharesMatch = block.match(/<sharesOwnedFollowingTransaction>\s*<value>([^<]*)<\/value>/);
    const postShares = postSharesMatch ? parseInt(postSharesMatch[1].replace(/,/g, ""), 10) : null;
    if (postShares !== null && postShares > 0) {
      latestPostShares = postShares;
    }
  }

  if (latestPostShares === null || latestPostShares === 0) return null;

  return {
    ticker,
    shares: latestPostShares,
    asOf,
    sourceUrl: filingUrl,
    source: `SEC Form 4 ${asOf}`,
  };
}

function extractEmbeddedXml(html: string): string | null {
  const match = html.match(/<[^>]*>[\s\S]*?<\/[^>]*>/);
  return match?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Parse 13F-HR XML — extract CUSIP-based holdings
// ---------------------------------------------------------------------------
interface Filing13FHolding {
  ticker: string;
  shares: number;
  asOf: string;
  sourceUrl: string;
  source: string;
}

async function parse13F(xml: string, period: string, sourceUrl: string): Promise<Filing13FHolding[]> {
  // Remove XML namespace declarations so regex works
  const cleaned = xml.replace(/xmlns[^=]*=[^>]*>/g, '>');
  const infoTables = [...cleaned.matchAll(/<infoTable>([\s\S]*?)<\/infoTable>/g)];
  const entries: Array<{ cusip: string; shares: number }> = [];

  for (const t of infoTables) {
    const block = t[1];
    const cusip = block.match(/<cusip>([^<]*)<\/cusip>/)?.[1]?.trim();
    // Fixed: shares are inside <shrsOrPrnAmt><sshPrnamt>
    const sharesMatch = block.match(/<sshPrnamt>([^<]*)<\/sshPrnamt>/);
    const shares = sharesMatch ? parseInt(sharesMatch[1].replace(/,/g, ""), 10) : null;
    if (cusip && shares) {
      entries.push({ cusip, shares });
    }
  }

  // Aggregate by CUSIP first
  const cusipAgg = new Map<string, number>();
  for (const e of entries) {
    cusipAgg.set(e.cusip, (cusipAgg.get(e.cusip) ?? 0) + e.shares);
  }

  // Then aggregate by ticker (multiple CUSIPs can map to same ticker)
  const tickerAgg = new Map<string, number>();
  for (const [cusip, shares] of cusipAgg) {
    const ticker = CUSIP_MAP[cusip];
    if (ticker) {
      tickerAgg.set(ticker, (tickerAgg.get(ticker) ?? 0) + shares);
    }
  }

  // Build result
  const result: Filing13FHolding[] = [];
  for (const [ticker, shares] of tickerAgg) {
    if (shares >= 1000) {
      result.push({
        ticker,
        shares,
        asOf: period || new Date().toISOString().slice(0, 10),
        sourceUrl,
        source: `SEC 13F-HR ${period || "latest"}`,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Fetch latest Form 4 for a CIK matching a specific ticker
// ---------------------------------------------------------------------------
async function findLatestForm4(cik: string, ticker: string): Promise<{ xmlUrl: string; indexUrl: string; period: string } | null> {
  const searchUrl = `/cgi-bin/browse-edgar?CIK=${cik}&type=4&dateb=&owner=include&count=10&action=getcompany`;
  const html = await secFetch(searchUrl);
  const indexLinks = extractIndexLinks(html);

  for (const link of indexLinks) {
    const detailHtml = await secFetch(link);
    const xmlPath = await extractRawXmlPath(detailHtml);
    if (!xmlPath) continue;

    // Fetch XML and check if it matches the expected ticker
    const xmlUrl = xmlPath.startsWith("http") ? xmlPath : `https://www.sec.gov${xmlPath}`;
    const xml = await secFetch(xmlUrl);
    const filingTicker = xml.match(/<issuerTradingSymbol>([^<]+)<\/issuerTradingSymbol>/)?.[1]?.trim();

    if (filingTicker === ticker) {
      const periodMatch = link.match(/(\d{4})[^/]*index\.htm/);
      const period = periodMatch?.[1] ?? new Date().toISOString().slice(0, 10);
      return { xmlUrl, indexUrl: `https://www.sec.gov${link}`, period };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch latest 13F-HR for a CIK
// ---------------------------------------------------------------------------
async function findLatest13F(cik: string): Promise<{ xmlUrl: string; indexUrl: string; period: string } | null> {
  const searchUrl = `/cgi-bin/browse-edgar?CIK=${cik}&type=13F&dateb=&owner=exclude&count=5&action=getcompany`;
  const html = await secFetch(searchUrl);
  const indexLinks = extractIndexLinks(html);
  if (indexLinks.length === 0) return null;

  for (const link of indexLinks) {
    const detailHtml = await secFetch(link);
    if (detailHtml.includes("13F-NT")) continue;

    const xmlPath = await extractRawXmlPath(detailHtml);
    if (!xmlPath) continue;

    const periodMatch = link.match(/(\d{4})[^/]*index\.htm/);
    const period = periodMatch?.[1] ?? new Date().toISOString().slice(0, 10);

    const xmlUrl = xmlPath.startsWith("http") ? xmlPath : `https://www.sec.gov${xmlPath}`;
    const indexUrl = `https://www.sec.gov${link}`;

    return { xmlUrl, indexUrl, period };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("Slice 13: Holdings loader (Form 4 post-transaction) starting");

  // Resolve person IDs
  const slugToId = new Map<string, string>();
  for (const p of await db.select({ id: schema.people.id, slug: schema.people.slug }).from(schema.people)) {
    slugToId.set(p.slug, p.id);
  }
  console.log(`  Resolved ${slugToId.size} people`);

  let inserted = 0;
  let skipped = 0;

  // 1. Form 4 filings (personal CIK, filtered by ticker)
  console.log("\n— Form 4 filings (insiders) —");
  for (const f of FORM4_FILERS) {
    const personId = slugToId.get(f.slug);
    if (!personId) {
      console.warn(`  No person found for ${f.slug}`);
      continue;
    }

    try {
      const filing = await findLatestForm4(f.cik, f.ticker);
      if (!filing) {
        console.warn(`  No Form 4 found for ${f.slug} (ticker ${f.ticker}, CIK ${f.cik})`);
        await sleep(800);
        continue;
      }

      console.log(`  ${f.slug}: ${filing.indexUrl}`);
      const raw = await secFetch(filing.xmlUrl);
      const holding = await parseForm4(raw, filing.indexUrl, f.ticker);

      if (holding) {
        console.log(`    → ${holding.ticker}: ${holding.shares.toLocaleString()} shares (post-transaction)`);
        const verdict = checkHolding(sqlite, {
          personSlug: f.slug,
          ticker: holding.ticker,
          shares: holding.shares,
          sourceUrl: holding.sourceUrl,
        });
        if (!verdict.ok) {
          console.warn(`    \u2717 REJECTED (sanity): ${verdict.reason}`);
          skipped++;
          await sleep(800);
          continue;
        }
        try {
          await db
            .insert(schema.equityHoldings)
            .values({
              id: createId(),
              personId,
              ticker: holding.ticker,
              exchange: f.exchange,
              shares: holding.shares,
              asOf: holding.asOf,
              estimated: 0,
              source: holding.source,
              sourceUrl: holding.sourceUrl,
              createdAt: new Date().toISOString(),
            })
            .onConflictDoNothing()
            .run();
          inserted++;
        } catch (err) {
          console.warn(`    ✗ Insert failed: ${err}`);
          skipped++;
        }
      } else {
        console.warn(`    → No valid holding found`);
        skipped++;
      }
    } catch (err) {
      console.warn(`  ⚠ ${f.slug}: ${err}`);
    }
    await sleep(800);
  }

  // 2. 13F-HR filings (fund entities only)
  console.log("\n— 13F-HR filings (fund entities) —");
  for (const f of FUND_FILERS) {
    const personId = slugToId.get(f.slug);
    if (!personId) {
      console.warn(`  No person found for ${f.slug}`);
      continue;
    }

    try {
      const filing = await findLatest13F(f.cik);
      if (!filing) {
        console.warn(`  No 13F-HR found for ${f.slug} (CIK ${f.cik})`);
        await sleep(800);
        continue;
      }

      console.log(`  ${f.slug}: ${filing.indexUrl}`);
      const raw = await secFetch(filing.xmlUrl);
      const holdings = await parse13F(raw, filing.period, filing.indexUrl);
      console.log(`    → ${holdings.length} holdings`);

      for (const h of holdings) {
        const verdict = checkHolding(sqlite, {
          personSlug: f.slug,
          ticker: h.ticker,
          shares: h.shares,
          sourceUrl: h.sourceUrl,
        });
        if (!verdict.ok) {
          console.warn(`    \u2717 REJECTED (sanity): ${verdict.reason}`);
          skipped++;
          continue;
        }
        try {
          await db
            .insert(schema.equityHoldings)
            .values({
              id: createId(),
              personId,
              ticker: h.ticker,
              exchange: "NYSE",
              shares: h.shares,
              asOf: h.asOf,
              estimated: 0,
              source: h.source,
              sourceUrl: h.sourceUrl,
              createdAt: new Date().toISOString(),
            })
            .onConflictDoNothing()
            .run();
          inserted++;
          console.log(`    ✓ ${h.ticker}: ${h.shares.toLocaleString()} shares`);
        } catch (err) {
          console.warn(`    ✗ Insert failed: ${err}`);
          skipped++;
        }
      }
    } catch (err) {
      console.warn(`  ⚠ ${f.slug}: ${err}`);
    }
    await sleep(800);
  }

  // 3. Summary
  console.log("\n— Summary —");
  console.log(`  Inserted: ${inserted} rows`);
  console.log(`  Skipped: ${skipped} rows`);
  console.log("  Note: Existing equity_holdings preserved (INSERT OR IGNORE)");
}

main().catch((err) => {
  console.error("Slice 13 failed:", err);
  process.exit(1);
});

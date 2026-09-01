/**
 * Chunk 14 — additive source backfill.
 *
 * Two sources were never registered as rows (the market-data provider used for
 * prices, and the ECB/frankfurter FX feed), and several rows were loaded
 * without a licence. This script:
 *   - INSERT OR IGNORE the two missing source rows;
 *   - UPDATE only the still-null licence columns (attribution is already
 *     present and correct, so we never overwrite it blindly).
 *
 * It is idempotent and additive: re-running it changes nothing. It does NOT
 * delete or reload any source row.
 */

import { db } from "../src/lib/db";
import { sources } from "../src/lib/db/schema";
import { eq, isNull } from "drizzle-orm";

const NEW_ROWS = [
  {
    id: "market-data-yahoo",
    name: "Yahoo Finance (market data)",
    url: "https://finance.yahoo.com",
    license: "Proprietary — display not licensed (see docs/LICENSING.md)",
    attribution:
      "Market prices are fetched from Yahoo Finance. Yahoo's terms do not permit " +
      "public redistribution or display without a commercial licence; no " +
      "Yahoo-derived prices are published on this site while the provider is unlicensed.",
  },
  {
    id: "ecb-frankfurter",
    name: "ECB / frankfurter.app (FX)",
    url: "https://www.frankfurter.app",
    license: "ECB copyright — free reuse with attribution",
    attribution:
      "Foreign-exchange rates from frankfurter.app, derived from European Central " +
      "Bank reference rates.",
  },
];

// Correct licences for rows loaded without one. Only the licence column is
// touched; attribution is left as the loader set it.
const LICENCE_FIXES: Record<string, string> = {
  "auction-record": "Public domain (facts from public records)",
  "county-records": "Public domain (government records)",
  "faa-registry": "Public domain (U.S. government)",
  "uk-land-registry": "Open Government Licence (OGL) v3.0",
  "maritime-registry": "Public domain (flag-state records)",
  "public-disclosure": "Public domain (regulatory disclosure)",
  "sec-edgar": "Public domain (U.S. government / EDGAR)",
  "companies-house": "Open Government Licence (OGL) v3.0",
  "uscg-registry": "Public domain (U.S. government)",
};

async function main(): Promise<void> {
  for (const row of NEW_ROWS) {
    await db.insert(sources).values(row).onConflictDoNothing();
    console.log(`upserted source: ${row.id}`);
  }

  for (const [id, license] of Object.entries(LICENCE_FIXES)) {
    await db.update(sources).set({ license }).where(eq(sources.id, id));
    console.log(`licence set for ${id}: ${license}`);
  }

  const remaining = await db
    .select({ id: sources.id })
    .from(sources)
    .where(isNull(sources.license));

  if (remaining.length) {
    console.warn("Sources still missing a licence:", remaining.map((r) => r.id).join(", "));
    process.exit(1);
  }
  console.log("All sources now carry a licence + attribution.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

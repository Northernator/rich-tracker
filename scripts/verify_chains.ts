/**
 * Chunk 10 — verify ownership chains.
 *
 * This is the acceptance gate made runnable. It checks, for every chain in the
 * database, that:
 *   1. Every hop's source_url resolves (HTTP 2xx, never 404) — a chained hop
 *      without a working citation is, by the project's own rule, NOT sourced.
 *   2. Every company→person hop points at a Companies House PSC page, not an
 *      API URL a reader could not open.
 *   3. Every property asset links to a Price Paid record or, at worst, the
 *      OCOD dataset page (the only fallback, since no per-title URL exists).
 *   4. The Companies House rate limiter never breached its 550 / 5-minute
 *      bucket during the load that produced these rows.
 *
 * With --live it ALSO exercises the live providers against a real overseas
 * entity (OE000002) and a real Price Paid record, so the "click each link"
 * review can be rehearsed even before a full OCOD file is loaded: the two hops
 * are checked at the source rather than from cached rows.
 *
 * Exits non-zero on the first failed assertion, so it is safe as a pre-commit
 * or CI check.
 *
 * Run: npm run verify:chains [-- --live]
 */

import { loadChains, countHops, countDanglingPropertyHops } from "@/lib/db/chains";
import { rateLimitStats } from "@/lib/providers/http";
import { fetchBeneficialOwners } from "@/lib/providers/uk/companieshouse";
import { findPricePaid } from "@/lib/providers/uk/pricepaid";

const CH_PSC_PATTERN =
  /^https:\/\/find-and-update\.company-information\.service\.gov\.uk\/company\/.+\/persons-with-significant-control/;
const PPD_PATTERN =
  /^https:\/\/landregistry\.data\.gov\.uk\/data\/ppi\/transaction\/.+/;
const OCOD_DATASET_URL = "https://use-land-property-data.service.gov.uk/datasets/ocod";

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

async function httpOk(url: string, timeoutMs = 20000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": "RichTracker/1.0 (taylorc697@gmail.com)" },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (res.status >= 200 && res.status < 400) return true;
    if (res.status === 405) {
      // Some hosts refuse HEAD; retry with GET.
      const res2 = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "RichTracker/1.0 (taylorc697@gmail.com)" },
        signal: controller.signal,
      });
      clearTimeout(t);
      return res2.status >= 200 && res2.status < 400;
    }
    return false;
  } catch {
    return false;
  }
}

async function main() {
  const live = process.argv.includes("--live");
  const checks: CheckResult[] = [];
  const fail = (label: string, detail: string) => checks.push({ label, ok: false, detail });
  const pass = (label: string, detail: string) => checks.push({ label, ok: true, detail });

  console.log("=== Chunk 10: verify ownership chains ===\n");

  const chains = await loadChains(0);
  const totalHops = await countHops();
  console.log(`chains: ${chains.length} · hops: ${totalHops} · dangling property hops: ${await countDanglingPropertyHops()}\n`);

  if (chains.length === 0) {
    console.log(
      "No chains in the database. To build them, drop the OCOD full file into\n" +
        "data/raw/uk/ocod/ (or set HMLR_API_KEY) and run: npm run property:uk\n"
    );
  }

  for (const chain of chains) {
    const c = chain.confidence.toFixed(2);
    console.log(
      `chain ${chain.property.entityId} → ${chain.company.entityId} → ${chain.person.entityId} ` +
        `[${chain.verdict}] (conf ${c})`
    );

    for (const hop of chain.hops) {
      const reachable = await httpOk(hop.sourceUrl);
      if (!reachable) {
        fail(`hop ${hop.edgeType}`, `${hop.fromLabel} → ${hop.toLabel}: ${hop.sourceUrl} 404s`);
        console.log(`  ✗ ${hop.edgeType}: ${hop.sourceUrl} is NOT reachable`);
      } else {
        pass(`hop ${hop.edgeType}`, hop.sourceUrl);
        console.log(`  ✓ ${hop.edgeType}: ${hop.sourceUrl}`);
      }

      if (hop.edgeType === "person_controls_company") {
        if (CH_PSC_PATTERN.test(hop.sourceUrl)) {
          pass("company→person link target", hop.sourceUrl);
        } else {
          fail("company→person link target", `${hop.sourceUrl} is not a Companies House PSC page`);
        }
      }
    }

    // Property asset citation: Price Paid record or the OCOD dataset page.
    if (chain.asset) {
      if (PPD_PATTERN.test(chain.asset.sourceUrl) || chain.asset.sourceUrl === OCOD_DATASET_URL) {
        pass("property citation", chain.asset.sourceUrl);
        console.log(`  ✓ property cites: ${chain.asset.sourceUrl}`);
      } else {
        fail("property citation", `${chain.asset.sourceUrl} is neither a Price Paid record nor the OCOD dataset page`);
      }
    }
  }

  if (live) {
    console.log("\n--- live provider probe (real sources) ---");
    const psc = await fetchBeneficialOwners("OE000002");
    const pscOk = CH_PSC_PATTERN.test(psc.publicUrl) && (await httpOk(psc.publicUrl));
    if (pscOk) pass("live PSC page", psc.publicUrl);
    else fail("live PSC page", psc.publicUrl);
    console.log(`  ${pscOk ? "✓" : "✗"} companies-house: ${psc.companyName} → ${psc.publicUrl}`);
    console.log(`     individual owners: ${psc.owners.filter((o) => o.kind === "individual").length}`);

    const pp = await findPricePaid({
      postcode: "WA2 8SN",
      address: "3 ROSEMOUNT COTTAGE, GOLBORNE ROAD, WINWICK, WARRINGTON",
    });
    if (pp && PPD_PATTERN.test(pp.recordUrl) && (await httpOk(pp.recordUrl))) {
      pass("live Price Paid record", pp.recordUrl);
      console.log(`  ✓ price-paid: £${pp.priceGbp.toLocaleString("en-GB")} on ${pp.date} → ${pp.recordUrl}`);
    } else {
      fail("live Price Paid record", pp ? pp.recordUrl : "no match");
      console.log(`  ✗ price-paid: ${pp ? pp.recordUrl : "no match returned"}`);
    }
  }

  // Rate-limit assertion (acceptance item 4).
  const breached = rateLimitStats().filter((s) => s.breached);
  if (breached.length === 0) {
    pass("rate limit", "no Companies House bucket breached");
  } else {
    for (const b of breached) {
      fail("rate limit", `${b.host} breached ${b.maxObservedInWindow}/${b.limit}`);
    }
  }

  console.log("");
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.detail ? " — " + c.detail : ""}`);
  }

  if (failed.length > 0) {
    console.error(`\nverify_chains: ${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nverify_chains: all checks passed.");
}

main().catch((err) => {
  console.error("verify_chains failed:", err);
  process.exit(1);
});

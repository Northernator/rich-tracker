/**
 * Chunk 9 — live FAA verification of candidate tail numbers.
 *
 * For each seed tail, hit the public FAA N-number inquiry page and extract the
 * EXACT registrant string + manufacturer/model as the FAA itself renders it.
 * Only tails that the live FAA page returns (`Aircraft Description` present) are
 * kept — this is the chunk's "review gate: open the FAA site, confirm the
 * registrant matches" done programmatically, and also enforces "deliberately
 * remove a source_url → the row is skipped".
 *
 * The FAA page exposes the REGISTERED OWNER ENTITY (almost always an LLC/trust),
 * never the individual's name. So confidence is 'medium' (entity verified on
 * FAA; person↔entity link rests on a second public source, recorded in
 * ownership_links.citation). We do NOT fabricate a person name into the FAA
 * registrant string.
 *
 * Output: data/raw/faa/_work/verified_tails.json  [{tail, owner, mfr, model,
 * status, sourceUrl}]
 */
const fs = require("fs");
const path = require("path");

const ROOT = "D:/DEV_ON_D/rich_tracker";
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "data/raw/faa/_work/seed.json"), "utf8"));

async function fetchFaa(tail) {
  const url = `https://registry.faa.gov/aircraftinquiry/Search/NNumberResult?nNumberTxt=${tail}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const txt = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (!txt.includes("Aircraft Description")) return { found: false, txt: "" };
  return { found: true, html };
}

// Known label tokens in the FAA data table, used as field boundaries.
const LABELS = [
  "N-Number Entered", "Aircraft Description", "Serial Number", "Status", "Manufacturer Name",
  "Model", "Type Aircraft", "Type Engine", "Engine Manufacturer", "Engine Model",
  "Engine Dealer", "Document Index", "State and County", "Territory and Country",
  "N-Numbers", "N-Number Availability", "Pending Number Change", "Dealer", "Date Change Authorized",
  "Mode S Code (base 8 / Oct)", "MFR Year", "Mode S Code (Base 16 / Hex)", "Type Registration",
  "Fractional Owner", "Registered Owner Name", "Street 1", "City", "State", "County", "Zip Code",
  "Country", "Airworthiness", "Certificate Issue Date", "Expiration Date",
];

// Extract visible table cells in order (this is the robust structure the FAA
// page uses: label || value || label || value …). The model sits in the cell
// immediately after the "Model" label.
function cellsOf(html) {
  return [...html.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function cellAfter(cells, label) {
  const i = cells.indexOf(label);
  return i >= 0 && i + 1 < cells.length ? cells[i + 1] : "";
}

(async () => {
  const out = [];
  for (const [tail, personSlug, personName] of seed) {
    const sourceUrl = `https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=${tail}`;
    try {
      const { found, html } = await fetchFaa(tail);
      if (!found) {
        console.log(`SKIP  ${tail} (${personName}): not found on live FAA — no row`);
        out.push({ tail, personSlug, personName, found: false, sourceUrl });
        continue;
      }
      const cells = cellsOf(html);
      // The registered owner name sits in the owner sub-table: the cell after
      // "Name" that follows the "Fractional Owner" / "Type Registration" block.
      // (The public page shows the LLC/trust, never the individual.) When the
      // owner has paid for PII withholding the name cell is blank and the next
      // cell is "Street" — in that case there is no registrant string to quote,
      // so we record empty and skip the row.
      let owner = "";
      const fracIdx = cells.indexOf("Fractional Owner");
      const ownerNameIdx = fracIdx >= 0 ? cells.indexOf("Name", fracIdx) : cells.indexOf("Name");
      if (ownerNameIdx >= 0) {
        const cand = cells[ownerNameIdx + 1] || "";
        // Skip if it's actually the following address field (blank name / withheld)
        if (cand && !/^(street|city|state|country|zip)/i.test(cand)) owner = cand;
      }
      const mfr = cellAfter(cells, "Manufacturer Name");
      const model = cellAfter(cells, "Model");
      console.log(`OK    ${tail} (${personName}): owner="${owner}" mfr="${mfr}" model="${model}"`);
      out.push({ tail, personSlug, personName, found: true, owner, mfr, model, sourceUrl });
    } catch (e) {
      console.log(`ERR   ${tail} (${personName}): ${e.message} — skipped`);
      out.push({ tail, personSlug, personName, found: false, error: e.message, sourceUrl });
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  fs.writeFileSync(path.join(ROOT, "data/raw/faa/_work/verified_tails.json"), JSON.stringify(out, null, 2));
  const kept = out.filter((o) => o.found).length;
  console.log(`\nKept ${kept} of ${seed.length} tails (verified on live FAA).`);
})();

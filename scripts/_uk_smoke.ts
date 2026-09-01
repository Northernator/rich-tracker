/** Temporary smoke test for the chunk-10 UK providers. Not part of the build. */
import { findPricePaid } from "@/lib/providers/uk/pricepaid";
import { fetchBeneficialOwners } from "@/lib/providers/uk/companieshouse";
import { formatRateLimitReport } from "@/lib/providers/http";

async function main() {
  console.log("--- Price Paid ---");
  const pp = await findPricePaid({
    postcode: "WA2 8SN",
    address: "3 ROSEMOUNT COTTAGE, GOLBORNE ROAD, WINWICK, WARRINGTON",
  });
  console.log(JSON.stringify(pp, null, 1));

  const pp2 = await findPricePaid({ postcode: "SW612VT", address: "FLAT 11, MAHOGANY HOUSE" });
  console.log("mangled postcode:", JSON.stringify(pp2, null, 1));

  console.log("\n--- Companies House: individual BO ---");
  const a = await fetchBeneficialOwners("OE000002");
  console.log(a.companyName, a.provider, a.publicUrl);
  console.log(JSON.stringify(a.owners, null, 1));
  console.log("statements:", a.statements.length, "active:", a.statements.filter(s=>s.status==="active").length);

  console.log("\n--- Companies House: corporate BO ---");
  const b = await fetchBeneficialOwners("OE016669");
  console.log(b.companyName, b.provider);
  console.log(JSON.stringify(b.owners, null, 1));

  console.log("\n" + formatRateLimitReport());
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});

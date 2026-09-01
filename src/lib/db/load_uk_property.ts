/**
 * Chunk 10 — UK property: build beneficial-ownership chains.
 *
 *   property (Land Registry title)
 *     └─ owned by → overseas entity (Companies House OE number)
 *          └─ beneficial owner → person
 *
 * Every hop is its own `entity_edges` row with its own citation and a numeric
 * confidence, because confidence MULTIPLIES along a path and a three-valued
 * adjective cannot express that.
 *
 * Sources
 *   - OCOD (HM Land Registry, OGL): title → proprietor + registration number.
 *     Needs a local capture in data/raw/uk/ocod/ or HMLR_API_KEY. See
 *     src/lib/providers/uk/ocod.ts for why there is no anonymous route.
 *   - Price Paid / PPI (HM Land Registry, OGL): the resolvable per-property
 *     citation. No public per-title URL exists, so this is what a property row
 *     links to.
 *   - Companies House PSC (OGL): entity → beneficial owners. Public pages by
 *     default; the API when COMPANIES_HOUSE_KEY is set.
 *
 * What this loader will NOT do
 *   - Never DELETE then reload. Inserts are additive (onConflictDoNothing on
 *     the natural keys); a re-run changes nothing.
 *   - Never guess a person. A beneficial owner is either matched to the roster
 *     on an exact name with an agreeing birth year, or left as the register's
 *     own record (node id `psc:<OE>:<n>`). A name-only match is stored at 0.5,
 *     which puts the chain under the floor and renders as "possible link".
 *   - Never assume a currency or an FX rate. A GBP price converts at the ECB
 *     rate for that date, fetched and stored if missing; if it cannot be
 *     resolved the value stays NULL.
 *   - Never chase a corporate beneficial owner. The register regularly names a
 *     trust company; the schema has no company→company hop, so the chain ends
 *     there and says so. Inventing a person behind it is fabrication.
 *
 * Caps (v1): 200 assets, 15 people. Entity resolution has no natural finish
 * line; the caps are what keep this chunk reviewable. Override with
 * --max-assets / --max-people.
 *
 * Run: npm run property:uk [-- --file=path/to/OCOD_FULL_2026_08.csv]
 */

import { db } from "@/lib/db";
import { assets, entityEdges, fxRates, people, sources } from "./schema";
import { and, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  OCOD_DATASET_URL,
  OCOD_SPEC_URL,
  isOverseasEntityNumber,
  normaliseOeNumber,
  resolveOcod,
} from "@/lib/providers/uk/ocod";
import { findPricePaid, type PricePaidMatch } from "@/lib/providers/uk/pricepaid";
import { fetchBeneficialOwners, type BeneficialOwner } from "@/lib/providers/uk/companieshouse";
import { loadFxLookup } from "@/lib/db/fx";
import { toUsdCents, type FxLookup } from "@/lib/money";
import { getFxProvider } from "@/lib/providers/registry";
import { loadLocalEnv } from "@/lib/providers/uk/env";
import { formatRateLimitReport, rateLimitStats } from "@/lib/providers/http";

const MAX_ASSETS = 200;
const MAX_PEOPLE = 15;
const MAX_PPI_LOOKUPS = 400;

/**
 * Hop confidences.
 *
 * 0.95 — OCOD is the register itself: it states that title X's proprietor is
 *        the entity with registration number OE… . Not 1.0 because the file is
 *        a monthly snapshot and a proprietor can have changed since.
 * 0.90 — the PSC entry is the register stating that this person is a
 *        beneficial owner of this entity, and the roster match is corroborated
 *        by an agreeing birth year.
 * 0.50 — name matches the roster but nothing corroborates it. Common names
 *        collide; this deliberately lands below the 0.5 floor once multiplied
 *        by the 0.95 title hop, so it renders as a possibility, not a finding.
 */
const CONF = {
  titleToEntity: 0.95,
  pscIndividual: 0.9,
  pscNameAndBirthYear: 0.9,
  pscNameOnly: 0.5,
} as const;

const SOURCE_OCOD = "uk-land-registry";
const SOURCE_CH = "companies-house";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  file?: string;
  maxAssets: number;
  maxPeople: number;
  dryRun: boolean;
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    maxAssets: Number(process.env.UK_MAX_ASSETS ?? MAX_ASSETS),
    maxPeople: Number(process.env.UK_MAX_PEOPLE ?? MAX_PEOPLE),
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--file=")) cli.file = arg.slice("--file=".length);
    else if (arg.startsWith("--max-assets=")) cli.maxAssets = Number(arg.split("=")[1]);
    else if (arg.startsWith("--max-people=")) cli.maxPeople = Number(arg.split("=")[1]);
    else if (arg === "--dry-run") cli.dryRun = true;
  }
  if (!Number.isFinite(cli.maxAssets) || cli.maxAssets <= 0) cli.maxAssets = MAX_ASSETS;
  if (!Number.isFinite(cli.maxPeople) || cli.maxPeople <= 0) cli.maxPeople = MAX_PEOPLE;
  return cli;
}

// ---------------------------------------------------------------------------
// URL guard (same allowlist posture as the other loaders)
// ---------------------------------------------------------------------------

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function assertExternalUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid source_url for ${label}: ${url}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Rejected source_url for ${label}: non-HTTP protocol "${parsed.protocol}"`);
  }
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

const TITLES = /\b(mr|mrs|ms|miss|dr|sir|lord|lady|prof|hon|capt|col|rev)\b\.?/g;

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(TITLES, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Order-insensitive key, so "HANLEY, Michael" in one register and
 * "Mr Michael Hanley" in the other produce the same key.
 */
function nameKey(s: string): string {
  return normaliseName(s)
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

interface RosterPerson {
  id: string;
  slug: string;
  fullName: string;
  bornYear: number | null;
}

type PersonResolution =
  | {
      kind: "roster";
      entityId: string;
      slug: string;
      confidence: number;
      basis: "name+birth-year" | "name-only";
    }
  | { kind: "psc-only"; entityId: string; confidence: number; basis: "psc-record" };

function resolvePerson(
  owner: BeneficialOwner,
  oeNumber: string,
  index: number,
  roster: Map<string, RosterPerson[]>
): PersonResolution {
  const candidates = roster.get(nameKey(owner.name));
  if (candidates && candidates.length > 0) {
    // Prefer a candidate whose birth year agrees with the register's.
    const byYear =
      owner.birthYear != null
        ? candidates.find((c) => c.bornYear != null && c.bornYear === owner.birthYear)
        : undefined;
    if (byYear) {
      return {
        kind: "roster",
        entityId: byYear.id,
        slug: byYear.slug,
        confidence: CONF.pscNameAndBirthYear,
        basis: "name+birth-year",
      };
    }
    // A name-only match is a possibility, not a finding.
    return {
      kind: "roster",
      entityId: candidates[0].id,
      slug: candidates[0].slug,
      confidence: CONF.pscNameOnly,
      basis: "name-only",
    };
  }

  // No roster match: the terminal node IS the register's record. Still a real
  // person, still cited — just not someone with a profile page here.
  return {
    kind: "psc-only",
    entityId: `psc:${oeNumber}:${index}`,
    confidence: CONF.pscIndividual,
    basis: "psc-record",
  };
}

// ---------------------------------------------------------------------------
// FX: make sure a GBP rate exists for the price-paid date
// ---------------------------------------------------------------------------

const fxDates = new Set<string>();
/** Rates this run added, so the in-memory lookup sees them without a reload. */
const addedRates = new Map<string, number>();

/**
 * Guarantee a GBP→USD rate for a Price Paid date.
 *
 * FX coverage in `fx_rates` currently spans the last few months, but a house
 * sold in 2019 needs the 2019 rate. Rather than invent parity, the rate is
 * fetched for that exact date and stored (additively, with its own citation).
 * If even that fails, the caller leaves the value NULL.
 */
async function ensureGbpRate(asOf: string): Promise<boolean> {
  if (fxDates.has(asOf)) return true;

  const existing = await db
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.base, "GBP"), eq(fxRates.quote, "USD"), eq(fxRates.asOf, asOf)))
    .limit(1)
    .execute();

  if (existing.length > 0) {
    fxDates.add(asOf);
    return true;
  }

  const provider = getFxProvider();
  const rates = await provider.ratesToUsd(asOf);
  const gbp = rates.GBP;
  if (!gbp || !Number.isFinite(gbp) || gbp <= 0) {
    console.warn(`  ! no GBP rate available for ${asOf} — value stays NULL`);
    return false;
  }

  const sourceUrl = `https://api.frankfurter.app/${asOf}?base=USD&symbols=GBP`;
  await db
    .insert(fxRates)
    .values({
      base: "GBP",
      quote: "USD",
      asOf,
      rate: gbp,
      sourceUrl,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();

  addedRates.set(`GBP|${asOf}`, gbp);
  fxDates.add(asOf);
  return true;
}

// ---------------------------------------------------------------------------
// Sources rows
// ---------------------------------------------------------------------------

async function ensureSources(): Promise<void> {
  const rows = [
    {
      id: SOURCE_OCOD,
      name: "HM Land Registry — Overseas Companies Ownership Data",
      url: OCOD_DATASET_URL,
      license: "Open Government Licence v3",
      attribution:
        "Contains HM Land Registry data © Crown copyright and database right 2026. " +
        "This data is licensed under the Open Government Licence v3.0.",
    },
    {
      id: SOURCE_CH,
      name: "UK Companies House — Register of Overseas Entities (PSC)",
      url: "https://find-and-update.company-information.service.gov.uk/",
      license: "Open Government Licence v3",
      attribution:
        "Contains public sector information licensed under the Open Government Licence v3.0.",
    },
  ];

  for (const r of rows) {
    const existing = await db
      .select({ id: sources.id, url: sources.url, license: sources.license })
      .from(sources)
      .where(eq(sources.id, r.id))
      .limit(1)
      .execute();

    if (existing.length === 0) {
      await db
        .insert(sources)
        .values({ ...r, createdAt: new Date().toISOString() })
        .onConflictDoNothing()
        .run();
      console.log(`  + sources row "${r.id}" inserted`);
      continue;
    }
    // Rows seeded before this chunk carry NULL url/licence. Filling them in is
    // additive — it adds attribution that was missing, it changes no numbers.
    const cur = existing[0];
    if (!cur.url || !cur.license) {
      await db
        .update(sources)
        .set({ url: cur.url ?? r.url, license: cur.license ?? r.license })
        .where(eq(sources.id, r.id))
        .run();
      console.log(`  ~ sources row "${r.id}": filled missing url/licence`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Stats {
  rowsRead: number;
  rowsNoRegistrationNo: number;
  assetsInserted: number;
  assetsReused: number;
  propertyHops: number;
  personHops: number;
  companiesQueried: number;
  companiesFailed: number;
  corporateOwners: number;
  statementOnly: number;
  peopleCapped: number;
  assetsCapped: number;
  valuesUnpriced: number;
  valuesNoFx: number;
  ppiLookups: number;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  loadLocalEnv();

  console.log("=== Chunk 10: UK property ownership chains ===");
  console.log(
    `caps: max-assets=${cli.maxAssets} max-people=${cli.maxPeople}${cli.dryRun ? " (dry run)" : ""}\n`
  );

  await ensureSources();

  const { source: ocodSource, rows } = await resolveOcod(cli.file ? { explicitPath: cli.file } : {});
  console.log(
    `OCOD: ${ocodSource.fileName} · ${rows.length} rows · ` +
      `release ${ocodSource.release ?? "unknown"} · origin ${ocodSource.origin}`
  );
  console.log(`raw capture: ${ocodSource.csvPath}\n`);

  if (cli.dryRun) {
    const chainable = rows.filter((r) => r.proprietors.some((p) => isOverseasEntityNumber(p.companyRegistrationNo)));
    console.log(
      `DRY RUN: ${chainable.length} of ${rows.length} rows carry a Companies House ` +
        `overseas-entity number and can therefore start a chain.`
    );
    for (const r of chainable.slice(0, 10)) {
      const p = r.proprietors.find((x) => isOverseasEntityNumber(x.companyRegistrationNo))!;
      console.log(
        `  ${r.titleNumber} · ${normaliseOeNumber(p.companyRegistrationNo)} · ` +
          `${p.name} · ${r.postcode || "(no postcode)"} · ${r.propertyAddress.slice(0, 60)}`
      );
    }
    return;
  }

  // Roster index for person resolution.
  const rosterRows = (await db
    .select({ id: people.id, slug: people.slug, fullName: people.fullName, bornYear: people.bornYear })
    .from(people)
    .execute()) as RosterPerson[];
  const roster = new Map<string, RosterPerson[]>();
  for (const p of rosterRows) {
    const key = nameKey(p.fullName);
    if (key === "") continue;
    const list = roster.get(key);
    if (list) list.push(p);
    else roster.set(key, [p]);
  }
  console.log(`roster: ${rosterRows.length} people indexed for name matching\n`);

  // One FX read for the run; rates added below are layered on top of it.
  const storedFx = await loadFxLookup();
  const fx: FxLookup = {
    get(currency: string, asOf: string): number | undefined {
      const added = addedRates.get(`${currency}|${asOf}`);
      return added ?? storedFx.get(currency, asOf);
    },
  };

  const stats: Stats = {
    rowsRead: rows.length,
    rowsNoRegistrationNo: 0,
    assetsInserted: 0,
    assetsReused: 0,
    propertyHops: 0,
    personHops: 0,
    companiesQueried: 0,
    companiesFailed: 0,
    corporateOwners: 0,
    statementOnly: 0,
    peopleCapped: 0,
    assetsCapped: 0,
    valuesUnpriced: 0,
    valuesNoFx: 0,
    ppiLookups: 0,
  };

  const companyCache = new Map<string, Awaited<ReturnType<typeof fetchBeneficialOwners>> | null>();
  const personNodeIds = new Set<string>();
  let assetsUsed = 0;

  for (const row of rows) {
    const chainable = row.proprietors.filter((p) => isOverseasEntityNumber(p.companyRegistrationNo));
    if (chainable.length === 0) {
      stats.rowsNoRegistrationNo++;
      continue;
    }

    if (assetsUsed >= cli.maxAssets) {
      stats.assetsCapped++;
      continue;
    }
    assetsUsed++;

    const titleRef = `title:${row.titleNumber}`;
    const address = row.propertyAddress.replace(/\s+/g, " ").trim() || `Title ${row.titleNumber}`;

    // --- Price Paid: the resolvable per-property citation -------------------
    let pp: PricePaidMatch | null = null;
    if (row.postcode && stats.ppiLookups < MAX_PPI_LOOKUPS) {
      stats.ppiLookups++;
      pp = await findPricePaid({ postcode: row.postcode, address: row.propertyAddress });
    }

    let estimatedValueCents: number | null = null;
    if (pp) {
      if (await ensureGbpRate(pp.date)) {
        try {
          estimatedValueCents = toUsdCents(pp.priceGbp * 100, "GBP", pp.date, fx);
        } catch (err) {
          console.warn(`  ! ${titleRef}: ${String(err).slice(0, 120)}`);
          stats.valuesNoFx++;
        }
      } else {
        stats.valuesNoFx++;
      }
    } else {
      stats.valuesUnpriced++;
    }

    const assetSourceUrl = pp ? pp.recordUrl : OCOD_DATASET_URL;
    assertExternalUrl(assetSourceUrl, `asset ${titleRef}`);

    const descriptionParts = [
      row.tenure ? `${row.tenure}` : null,
      `Proprietor on the Land Register: ${chainable[0].name} (${normaliseOeNumber(chainable[0].companyRegistrationNo)}).`,
      `OCOD release ${ocodSource.release ?? "unknown"}.`,
      pp
        ? `Price Paid record: £${pp.priceGbp.toLocaleString("en-GB")} on ${pp.date} (matched on ${pp.basis}).`
        : "No Price Paid record matched this address — cited to the OCOD dataset, not to a transaction.",
    ].filter(Boolean) as string[];

    // --- Asset (additive, keyed on the registry identifier) -----------------
    const existingAsset = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.sourceId, SOURCE_OCOD), eq(assets.externalRef, titleRef)))
      .limit(1)
      .execute();

    let assetId: string;
    if (existingAsset.length > 0) {
      assetId = existingAsset[0].id;
      stats.assetsReused++;
    } else {
      assetId = createId();
      await db
        .insert(assets)
        .values({
          id: assetId,
          name: address,
          assetType: "real_estate",
          description: descriptionParts.join(" "),
          location: [row.postcode, row.district || row.county || row.region].filter(Boolean).join(", ") || null,
          estimatedValueCents: estimatedValueCents ?? undefined,
          sourceId: SOURCE_OCOD,
          sourceUrl: assetSourceUrl,
          externalRef: titleRef,
          lat: undefined,
          lng: undefined,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
      stats.assetsInserted++;
    }

    console.log(
      `  ${existingAsset.length > 0 ? "~" : "+"} ${titleRef} · ${address.slice(0, 60)}` +
        `${pp ? ` · £${pp.priceGbp.toLocaleString("en-GB")} (${pp.date}, ${pp.basis})` : " · no Price Paid match"}`
    );

    // --- Hop 1: company → property ------------------------------------------
    for (const proprietor of chainable) {
      const oe = normaliseOeNumber(proprietor.companyRegistrationNo);
      const companyNode = `ch:${oe}`;

      let psc = companyCache.get(oe);
      if (psc === undefined) {
        try {
          psc = await fetchBeneficialOwners(oe);
          stats.companiesQueried++;
        } catch (err) {
          console.warn(
            `  ! Companies House lookup failed for ${oe}: ${String(err).slice(0, 160)}`
          );
          stats.companiesFailed++;
          companyCache.set(oe, null);
          continue;
        }
        companyCache.set(oe, psc);
      }
      if (!psc) continue;

      const companyLabel = psc.companyName || proprietor.name;

      await db
        .insert(entityEdges)
        .values({
          edgeType: "company_owns_property",
          fromEntityType: "company",
          fromEntityId: companyNode,
          fromLabel: companyLabel,
          toEntityType: "property",
          toEntityId: titleRef,
          toLabel: address,
          confidence: CONF.titleToEntity,
          sourceId: SOURCE_OCOD,
          sourceUrl: OCOD_DATASET_URL,
          detail: JSON.stringify({
            titleNumber: row.titleNumber,
            tenure: row.tenure,
            proprietorName: proprietor.name,
            companyRegistrationNo: oe,
            proprietorshipCategory: proprietor.proprietorshipCategory,
            countryIncorporated: proprietor.countryIncorporated,
            dateProprietorAdded: row.dateProprietorAdded,
            ocodRelease: ocodSource.release,
            ocodFile: ocodSource.fileName,
            rawCapture: ocodSource.csvPath,
            specUrl: OCOD_SPEC_URL,
            pricePaid: pp
              ? { gbp: pp.priceGbp, date: pp.date, basis: pp.basis, recordUrl: pp.recordUrl }
              : null,
          }),
          asOf: row.dateProprietorAdded ?? ocodSource.release ?? null,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
      stats.propertyHops++;

      // --- Hop 2: person → company ------------------------------------------
      const activeIndividuals = psc.owners.filter(
        (o) => o.kind === "individual" && o.status === "active" && o.name.trim() !== ""
      );
      const corporates = psc.owners.filter((o) => o.status === "active" && o.kind !== "individual");

      if (activeIndividuals.length === 0) {
        stats.statementOnly++;
        if (corporates.length > 0) stats.corporateOwners += corporates.length;
        console.log(
          `      · ${companyLabel}: no individual beneficial owner on the register` +
            ` (${corporates.length} corporate, ${psc.statements.filter((s) => s.status === "active").length} active statements) — chain ends here`
        );
        continue;
      }

      let idx = 0;
      for (const owner of activeIndividuals) {
        idx++;
        const resolution = resolvePerson(owner, oe, idx, roster);

        if (!personNodeIds.has(resolution.entityId)) {
          if (personNodeIds.size >= cli.maxPeople) {
            stats.peopleCapped++;
            continue;
          }
          personNodeIds.add(resolution.entityId);
        }

        const detail: Record<string, unknown> = {
          kind: owner.kind,
          nationality: owner.nationality,
          countryOfResidence: owner.countryOfResidence,
          birthMonth: owner.birthMonth,
          birthYear: owner.birthYear,
          natureOfControl: owner.natureOfControl,
          notifiedOn: owner.notifiedOn,
          matchBasis: resolution.basis,
          beneficiaryIsTrustee: owner.natureOfControl.some((n) => /trustee/i.test(n)),
        };
        if (resolution.kind === "roster") detail.rosterSlug = resolution.slug;

        await db
          .insert(entityEdges)
          .values({
            edgeType: "person_controls_company",
            fromEntityType: "person",
            fromEntityId: resolution.entityId,
            fromLabel: owner.name,
            toEntityType: "company",
            toEntityId: companyNode,
            toLabel: companyLabel,
            confidence: resolution.confidence,
            sourceId: SOURCE_CH,
            sourceUrl: psc.publicUrl,
            detail: JSON.stringify(detail),
            asOf: owner.notifiedOn,
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing()
          .run();
        stats.personHops++;

        const chainConfidence = CONF.titleToEntity * resolution.confidence;
        console.log(
          `      → ${owner.name}` +
            `${resolution.kind === "roster" ? ` [roster: ${resolution.slug}]` : " [register record]"} ` +
            `${resolution.basis} · hop ${resolution.confidence.toFixed(2)} · ` +
            `chain ${chainConfidence.toFixed(2)} ` +
            `${chainConfidence >= 0.5 ? "sourced" : "POSSIBLE LINK"} · ${psc.publicUrl}`
        );
      }
    }
  }

  // --- Rate-limit proof (acceptance item 4) --------------------------------
  const breached = rateLimitStats().filter((s) => s.breached);
  console.log("\n" + formatRateLimitReport());

  console.log(
    `\n=== Chunk 10 summary ===\n` +
      `  OCOD rows read:             ${stats.rowsRead}\n` +
      `  rows with no OE number:     ${stats.rowsNoRegistrationNo}\n` +
      `  rows skipped (asset cap):   ${stats.assetsCapped}\n` +
      `  assets inserted / reused:   ${stats.assetsInserted} / ${stats.assetsReused}\n` +
      `  price-paid lookups:         ${stats.ppiLookups}\n` +
      `  unpriced / no FX rate:      ${stats.valuesUnpriced} / ${stats.valuesNoFx}\n` +
      `  companies queried / failed: ${stats.companiesQueried} / ${stats.companiesFailed}\n` +
      `  company→property hops:      ${stats.propertyHops}\n` +
      `  person→company hops:        ${stats.personHops}\n` +
      `  chains ending at a company: ${stats.statementOnly} (corporate owners: ${stats.corporateOwners})\n` +
      `  hops skipped (people cap):  ${stats.peopleCapped}\n` +
      `  distinct person nodes:      ${personNodeIds.size}`
  );

  if (breached.length > 0) {
    throw new Error(
      `Rate limit breached for: ${breached.map((b) => `${b.host} (${b.maxObservedInWindow}/${b.limit})`).join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error("\nUK property loader failed:", err);
  process.exit(1);
});

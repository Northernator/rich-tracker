/**
 * Slice 1: Load billionaire data from rtb-api into SQLite — real roster.
 *
 * Rules:
 * - Never call rtb-api at request time. Fetch once, save to data/raw/rtb/<date>/list.json
 *   with sibling .meta.json { url, http_status, fetched_at, sha256, bytes }.
 * - Refuse to read any raw file without sibling meta http_status 200.
 * - Never generate synthetic data. If source unreachable, throw and leave DB unchanged.
 * - Match existing people by slug first, then exact full_name.
 * - Set country, primary_org, born_year from /profile/{uri}/info.
 * - Insert new baseline_estimates per run; never update.
 * - Source id = 'rtb-api', licence MIT, attribution komed3/rtb-api.
 */

import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { sources, people, baselineEstimates } from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { politeFetch } from "@/lib/providers/http";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const DEFAULT_RTB_BASE = "https://cdn.statically.io/gh/komed3/rtb-api/main/api";
const FALLBACK_BASES = [
  "https://cdn.jsdelivr.net/gh/komed3/rtb-api@main/api",
  "https://raw.githubusercontent.com/komed3/rtb-api/main/api",
];
// Allow override for testing breakage: RTB_BASE env forces single base (no fallback)
const ALL_BASES = process.env.RTB_BASE ? [process.env.RTB_BASE] : [DEFAULT_RTB_BASE, ...FALLBACK_BASES];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function citizenshipToCountry(code: string): string | null {
  if (!code) return null;
  const c = code.toLowerCase();
  const map: Record<string, string> = {
    us: "USA",
    cn: "China",
    in: "India",
    de: "Germany",
    ru: "Russia",
    it: "Italy",
    ca: "Canada",
    hk: "Hong Kong",
    br: "Brazil",
    tw: "Taiwan",
    gb: "United Kingdom",
    au: "Australia",
    fr: "France",
    sg: "Singapore",
    se: "Sweden",
    kr: "South Korea",
    es: "Spain",
    jp: "Japan",
    ch: "Switzerland",
    il: "Israel",
    tr: "Turkey",
    id: "Indonesia",
    mx: "Mexico",
    my: "Malaysia",
    gr: "Greece",
    th: "Thailand",
    no: "Norway",
    be: "Belgium",
    nl: "Netherlands",
    ph: "Philippines",
    nl2: "Netherlands",
    ae: "United Arab Emirates",
    sa: "Saudi Arabia",
    za: "South Africa",
    dk: "Denmark",
    pl: "Poland",
    ie: "Ireland",
    at: "Austria",
    nz: "New Zealand",
    ar: "Argentina",
    cl: "Chile",
    co: "Colombia",
    pe: "Peru",
    pt: "Portugal",
    fi: "Finland",
    cz: "Czech Republic",
    hu: "Hungary",
    ro: "Romania",
    ua: "Ukraine",
    kz: "Kazakhstan",
    ng: "Nigeria",
    eg: "Egypt",
    qa: "Qatar",
    kw: "Kuwait",
    vn: "Vietnam",
    bd: "Bangladesh",
    pk: "Pakistan",
    ma: "Morocco",
    dz: "Algeria",
    lu: "Luxembourg",
    mc: "Monaco",
    li: "Liechtenstein",
    cy: "Cyprus",
    sk: "Slovakia",
    hr: "Croatia",
    si: "Slovenia",
    bg: "Bulgaria",
    rs: "Serbia",
    ee: "Estonia",
    lv: "Latvia",
    lt: "Lithuania",
    is: "Iceland",
    mt: "Malta",
    fo: "Faroe Islands",
    bs: "Bahamas",
    pa: "Panama",
    uy: "Uruguay",
    ve: "Venezuela",
    ec: "Ecuador",
    gt: "Guatemala",
    hn: "Honduras",
    cr: "Costa Rica",
    do: "Dominican Republic",
    jm: "Jamaica",
    tt: "Trinidad and Tobago",
    bz: "Belize",
    bb: "Barbados",
    bm: "Bermuda",
    ky: "Cayman Islands",
    vg: "British Virgin Islands",
    kh: "Cambodia",
    la: "Laos",
    mm: "Myanmar",
    np: "Nepal",
    lk: "Sri Lanka",
    jo: "Jordan",
    lb: "Lebanon",
    om: "Oman",
    bh: "Bahrain",
    tn: "Tunisia",
    ke: "Kenya",
    tz: "Tanzania",
    ug: "Uganda",
    gh: "Ghana",
    zm: "Zambia",
    zw: "Zimbabwe",
    na: "Namibia",
    mw: "Malawi",
    rw: "Rwanda",
    et: "Ethiopia",
    sn: "Senegal",
    ci: "Ivory Coast",
    cm: "Cameroon",
    ao: "Angola",
    mz: "Mozambique",
    bw: "Botswana",
    mu: "Mauritius",
  };
  return map[c] ?? c.toUpperCase();
}

function parseBornYear(birthDate: string | null | undefined): number | null {
  if (!birthDate) return null;
  const m = birthDate.match(/^(\d{4})-/);
  if (m) {
    const y = parseInt(m[1], 10);
    if (y > 1900 && y < 2026) return y;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raw capture — mandatory with meta
// ---------------------------------------------------------------------------

function writeRawCapture(
  kind: string,
  name: string,
  url: string,
  httpStatus: number,
  body: string
): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const dir = join(process.cwd(), "data", "raw", kind, dateStr);
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${name}.json`);
  const metaPath = join(dir, `${name}.meta.json`);
  writeFileSync(jsonPath, body, "utf8");
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const meta = {
    url,
    http_status: httpStatus,
    fetched_at: new Date().toISOString(),
    sha256,
    bytes: Buffer.byteLength(body, "utf8"),
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  const relPath = join("data", "raw", kind, dateStr, `${name}.json`).replace(/\\/g, "/");
  console.log(`  Raw capture: ${relPath} (${meta.bytes} bytes, sha256 ${sha256.slice(0, 12)}…)`);
  // Verify sibling immediately
  if (!existsSync(metaPath)) throw new Error(`Meta file missing after write: ${metaPath}`);
  const metaRaw = JSON.parse(readFileSync(metaPath, "utf8")) as { http_status: number };
  if (metaRaw.http_status !== 200) throw new Error(`Refusing capture with http_status ${metaRaw.http_status}`);
  return relPath;
}

function verifyRawCapture(relPath: string): void {
  const absPath = join(process.cwd(), relPath);
  const metaPath = absPath.replace(/\.json$/, ".meta.json");
  if (!existsSync(metaPath)) throw new Error(`Refusing to read ${absPath}: missing sibling meta ${metaPath}`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { http_status: number };
  if (meta.http_status !== 200) throw new Error(`Refusing to read ${absPath}: meta http_status ${meta.http_status} != 200`);
}

// ---------------------------------------------------------------------------
// Fetch helpers — politeFetch with fallback bases, no synthetic fallback
// ---------------------------------------------------------------------------

interface RtbListResponse {
  date: string;
  count: number;
  list: RtbItem[];
}
interface RtbItem {
  rank?: number;
  uri?: string;
  name?: string;
  citizenship?: string;
  industry?: string[];
  source?: string[];
  networth?: number;
  value?: number;
  citizenship_code?: string;
  [k: string]: unknown;
}

interface ProfileInfo {
  uri: string;
  name: string;
  birthDate?: string;
  citizenship?: string;
  deceased?: boolean;
  organization?: { name?: string; title?: string };
  source?: string[];
}

async function fetchWithBases(path: string): Promise<{ url: string; status: number; body: string }> {
  let lastErr: Error | null = null;
  for (const base of ALL_BASES) {
    const url = `${base}${path}`;
    try {
      const res = await politeFetch(url, { signal: AbortSignal.timeout(30000) } as unknown as RequestInit);
      const body = await res.text();
      if (!res.ok) throw new Error(`rtb-api ${res.status} from ${url} — aborting, no fallback`);
      return { url, status: res.status, body };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`  fetch failed for ${url}: ${lastErr.message} — trying fallback`);
      continue;
    }
  }
  throw new Error(`All rtb-api bases failed for ${path}: ${lastErr?.message} — aborting, no synthetic fallback`);
}

async function fetchRtbList(): Promise<{ items: RtbItem[]; rawPath: string; date: string }> {
  const path = "/list/rtb/latest";
  const { url, status, body } = await fetchWithBases(path);
  const rawPath = writeRawCapture("rtb", "list", url, status, body);
  verifyRawCapture(rawPath);
  const parsed = JSON.parse(body) as RtbListResponse | RtbItem[];
  let items: RtbItem[];
  let date: string;
  if (Array.isArray(parsed)) {
    items = parsed;
    date = new Date().toISOString().slice(0, 10);
  } else {
    items = parsed.list ?? [];
    date = parsed.date ?? new Date().toISOString().slice(0, 10);
  }
  if (!Array.isArray(items) || items.length === 0) throw new Error(`rtb-api returned empty list from ${url}`);
  return { items, rawPath, date };
}

async function fetchProfileInfo(uri: string): Promise<ProfileInfo | null> {
  const path = `/profile/${uri}/info`;
  try {
    const { body } = await fetchWithBases(path);
    const info = JSON.parse(body) as ProfileInfo;
    return info;
  } catch (e) {
    console.warn(`  profile fetch failed for ${uri}: ${(e as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

const dbPath = join(process.cwd(), "data", "app.db");

async function main() {
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema: { sources, people, baselineEstimates } });

  // Fetch live list — abort if unreachable, DB unchanged up to this point
  console.log("Fetching rtb-api list/rtb/latest …");
  const { items, rawPath } = await fetchRtbList();
  console.log(`  Fetched ${items.length} entries, rawPath=${rawPath}`);

  // Register source properly
  const now = new Date().toISOString();
  // Use INSERT OR IGNORE then update to ensure correct values even if old row exists
  db.insert(sources)
    .values({
      id: "rtb-api",
      name: "komed3/rtb-api",
      url: "https://github.com/komed3/rtb-api",
      license: "MIT",
      attribution: "komed3/rtb-api (MIT), derived from Forbes real-time list",
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  // Ensure correct values if row already existed with wrong data
  sqlite
    .prepare(
      `UPDATE sources SET url = ?, license = ?, attribution = ?, name = ? WHERE id = ?`
    )
    .run(
      "https://github.com/komed3/rtb-api",
      "MIT",
      "komed3/rtb-api (MIT), derived from Forbes real-time list",
      "komed3/rtb-api",
      "rtb-api"
    );
  console.log("  Source rtb-api registered (MIT)");

  // Upsert people + baseline estimates
  let insertedPeople = 0;
  let updatedPeople = 0;
  let insertedEstimates = 0;
  let skipped = 0;
  let deceasedSkipped = 0;

  // Allow optional limit for testing: RTB_LIMIT env
  const limitEnv = process.env.RTB_LIMIT ? parseInt(process.env.RTB_LIMIT, 10) : 0;
  const toProcess = limitEnv && limitEnv > 0 ? items.slice(0, limitEnv) : items;
  if (limitEnv) console.log(`  RTB_LIMIT=${limitEnv} — processing subset of ${toProcess.length}/${items.length}`);

  // Fetch profiles with limited concurrency to hide latency while respecting politeFetch throttling (20/sec for rtb hosts)
  const concurrency = 20;
  for (let batchStart = 0; batchStart < toProcess.length; batchStart += concurrency) {
    const batch = toProcess.slice(batchStart, batchStart + concurrency);
    const fetched = await Promise.all(
      batch.map(async (item) => {
        const uri = (item.uri as string) ?? slugify((item.name as string) ?? "");
        const name = (item.name as string) ?? "";
        if (!name || !uri) return { item, uri, name, profile: null as ProfileInfo | null, skip: true };
        if (/claims|fake|placeholder|dummy|hardcode/.test(name.toLowerCase())) return { item, uri, name, profile: null, skip: true };
        const profile = await fetchProfileInfo(uri);
        return { item, uri, name, profile, skip: false };
      })
    );

    for (const { item, uri, name, profile, skip } of fetched) {
      if (skip) {
        skipped++;
        continue;
      }
      if (profile?.deceased === true) {
        deceasedSkipped++;
        console.log(`  skipping deceased: ${name} (${uri})`);
        continue;
      }
      const slug = slugify(uri) || slugify(name);

    // Derive fields from profile or fallback to list data (list data is not used for fabricated fallback, just for enrichment)
    const citizenshipCode = profile?.citizenship ?? (item.citizenship as string) ?? null;
    const country = citizenshipCode ? citizenshipToCountry(citizenshipCode) : null;
    const primaryOrg =
      profile?.organization?.name ??
      (Array.isArray(profile?.source) ? profile.source[0] : null) ??
      (Array.isArray(item.source) ? (item.source as string[])[0] : null) ??
      null;
    const bornYear = parseBornYear(profile?.birthDate ?? null);

    // Resolve person id: slug first, then exact full_name (fallback only for legacy data without uri)
    // For rtb-api, uri is unique; avoid merging distinct people who share a name (e.g., Zhang Jian)
    let personId: string | null = null;
    const bySlug = (await db.select({ id: people.id }).from(people).where(eq(people.slug, slug)).limit(1)) as Array<{ id: string }>;
    if (bySlug.length > 0) {
      personId = bySlug[0].id;
    } else if (!uri || uri === slugify(name)) {
      // Only fallback to full_name when uri is missing or slug was derived from name (legacy)
      const byName = (await db.select({ id: people.id }).from(people).where(eq(people.fullName, name)).limit(1)) as Array<{ id: string }>;
      if (byName.length > 0) personId = byName[0].id;
    }

    const isNew = !personId;
    if (isNew) personId = createId();

    // Net worth: networth in millions → cents
    const millions = (item.networth as number) ?? (item.value as number);
    if (millions == null || !Number.isFinite(millions)) {
      console.warn(`  skipping ${name}: missing networth`);
      skipped++;
      continue;
    }
    const netWorthCents = Math.round(millions * 1_000_000 * 100); // millions -> dollars -> cents
    const rank = (item.rank as number) ?? null;
    // asOf: use list date or item change date
    const asOf = (item as unknown as { date?: string }).date ?? now;

    if (isNew) {
      db.insert(people)
        .values({
          id: personId!,
          slug,
          fullName: name,
          country: country ?? null,
          primaryOrg: primaryOrg ?? null,
          bornYear: bornYear ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      insertedPeople++;
    } else {
      // Update existing person with profile data if missing or changed
      const current = (await db.select().from(people).where(eq(people.id, personId!)).limit(1))[0] as typeof people.$inferSelect | undefined;
      if (current) {
        const needsUpdate =
          (country && current.country !== country) ||
          (primaryOrg && current.primaryOrg !== primaryOrg) ||
          (bornYear && current.bornYear !== bornYear);
        if (needsUpdate) {
          sqlite
            .prepare(`UPDATE people SET country = COALESCE(?, country), primary_org = COALESCE(?, primary_org), born_year = COALESCE(?, born_year), updated_at = ? WHERE id = ?`)
            .run(country, primaryOrg, bornYear, now, personId);
          updatedPeople++;
        }
      }
    }

    // Always insert new baseline_estimates row per run; never update
    db.insert(baselineEstimates)
      .values({
        id: createId(),
        personId: personId!,
        sourceId: "rtb-api",
        netWorthCents,
        asOf: typeof asOf === "string" ? asOf : now,
        rank: rank ?? null,
        rawPath,
        raw: JSON.stringify(item),
        createdAt: now,
      })
      .onConflictDoNothing()
        .run();
      insertedEstimates++;
    }
  }

  console.log(`Loaded ${insertedEstimates} baseline estimates (${insertedPeople} new people, ${updatedPeople} updated, ${skipped} skipped, ${deceasedSkipped} deceased skipped)`);

  // Summary
  const totalPeople = sqlite.prepare("SELECT COUNT(*) as c FROM people").get() as { c: number };
  console.log(`  Total people in DB: ${totalPeople.c}`);

  sqlite.close();
}

main().catch((err) => {
  console.error("load_slice1 FAILED:", err);
  process.exit(1);
});

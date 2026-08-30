/**
 * Wikidata P2218 (net worth) provider — CC0, no key, no cost.
 *
 * Two SPARQL calls, both against https://query.wikidata.org/sparql:
 *
 *   1. Every P2218 statement, with the amount and its currency unit read from
 *      the SAME statement node. The query this replaced took the amount from
 *      `wdt:P2218` and the unit from `psv:P2218`, which for the 145 people who
 *      carry more than one net-worth statement pairs an amount with a
 *      different statement's currency. Mixing up the unit is exactly the
 *      "silent currency assumption" this project forbids, so the statement is
 *      kept intact: `p:P2218 ?stmt` → `ps:P2218 ?amount`, `psv:P2218 ?vn` →
 *      `?vn wikibase:quantityUnit ?currency`.
 *
 *   2. Currency unit QIDs → ISO 4217 codes, read from Wikidata's own P498.
 *      Nothing is hard-coded: if Wikidata has no ISO code for a unit (Q8142
 *      "currency", Q1367869 "fantastillion", Q16068 "Deutsche Mark"), the row
 *      is unresolvable and gets dropped rather than assumed to be USD.
 *
 * Both responses are written to data/raw/wikidata/<date>/ with a sibling
 * .meta.json, and the loader refuses to read a capture whose meta is not
 * http 200. On any failure this throws — there is no fallback value.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { politeFetch } from "@/lib/providers/http";

const ENDPOINT = "https://query.wikidata.org/sparql";

/** Descriptive User-Agent — Wikidata asks for tool, purpose and contact. */
const WIKIDATA_UA =
  "RichTracker/1.0 (net-worth consensus research; taylorc697@gmail.com)";

/** SPARQL responses can legitimately take a minute on a cold cache. */
const QUERY_TIMEOUT_MS = 180_000;

export const NET_WORTH_QUERY = `SELECT ?person ?personLabel ?amount ?currency ?pointInTime ?timePrecision ?ref ?birth ?citizenshipIso WHERE {
?person p:P2218 ?stmt .
?stmt ps:P2218 ?amount .
?stmt psv:P2218 ?valueNode .
?valueNode wikibase:quantityUnit ?currency .
OPTIONAL { ?stmt pq:P585 ?pointInTime . }
OPTIONAL { ?stmt pqv:P585 ?timeNode . ?timeNode wikibase:timePrecision ?timePrecision . }
OPTIONAL { ?stmt prov:wasDerivedFrom/pr:P854 ?ref . }
OPTIONAL { ?person wdt:P569 ?birth . }
OPTIONAL { ?person wdt:P27 ?cit . ?cit wdt:P297 ?citizenshipIso . }
SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

export interface WikidataNetWorthRow {
  qid: string;
  label: string;
  /** Raw quantity, denominated in `currencyIso`. */
  amount: number;
  unitQid: string;
  /** ISO 4217, or null when Wikidata publishes no code for the unit. */
  currencyIso: string | null;
  /**
   * P585 at the precision Wikidata actually holds it: "2025", "2025-06" or
   * "2025-06-05".
   *
   * SPARQL normalises every P585 to a full xsd:dateTime, so a statement that
   * says only "2025" still arrives as "2025-01-01T00:00:00Z". Storing that
   * literal asserts New Year's Day, a day the source never claimed, and ages
   * every year-precision figure by up to twelve months. The precision has to
   * be asked for separately (pqv:P585 → wikibase:timePrecision) and the date
   * truncated back to it.
   */
  asOf: string | null;
  /** Wikidata time precision: 9 = year, 10 = month, 11 = day. */
  timePrecision: number | null;
  /** P854 reference URL — the document supporting this specific claim. */
  referenceUrl: string | null;
  birthYear: number | null;
  citizenshipIso2: string | null;
}

interface Binding {
  value: string;
  type?: string;
  datatype?: string;
}
type Row = Record<string, Binding | undefined>;

// ---------------------------------------------------------------------------
// Raw capture — every response is persisted before it is parsed
// ---------------------------------------------------------------------------

function writeRawCapture(name: string, url: string, body: string): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const dir = join(process.cwd(), "data", "raw", "wikidata", dateStr);
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${name}.json`);
  const metaPath = join(dir, `${name}.meta.json`);
  writeFileSync(jsonPath, body, "utf8");
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const meta = {
    url,
    http_status: 200,
    fetched_at: new Date().toISOString(),
    sha256,
    bytes: Buffer.byteLength(body, "utf8"),
    license: "CC0",
    attribution: "Wikidata (CC0)",
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  const relPath = join("data", "raw", "wikidata", dateStr, `${name}.json`).replace(/\\/g, "/");
  console.log(`  Raw capture: ${relPath} (${meta.bytes} bytes, sha256 ${sha256.slice(0, 12)}…)`);
  if (!existsSync(metaPath)) throw new Error(`Meta file missing after write: ${metaPath}`);
  return relPath;
}

/** Guard used by the loader: never read a capture without a 200 sibling meta. */
export function verifyRawCapture(relPath: string): void {
  const absPath = join(process.cwd(), relPath);
  const metaPath = absPath.replace(/\.json$/, ".meta.json");
  if (!existsSync(metaPath)) {
    throw new Error(`Refusing to read ${absPath}: missing sibling meta ${metaPath}`);
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { http_status: number };
  if (meta.http_status !== 200) {
    throw new Error(`Refusing to read ${absPath}: meta http_status ${meta.http_status} != 200`);
  }
}

async function runSparql(query: string, name: string): Promise<{ url: string; rows: Row[]; rawPath: string }> {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const res = await politeFetch(url, {
    headers: { Accept: "application/sparql-results+json" },
    userAgent: WIKIDATA_UA,
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  } as RequestInit);
  const body = await res.text();
  const rawPath = writeRawCapture(name, url, body);
  verifyRawCapture(rawPath);
  const parsed = JSON.parse(body) as { results?: { bindings?: Row[] } };
  const rows = parsed.results?.bindings ?? [];
  return { url, rows, rawPath };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface NetWorthSnapshot {
  rows: WikidataNetWorthRow[];
  rawPath: string;
  currencyRawPath: string;
  /** unitQid → ISO 4217, for every unit seen in the result set. */
  currencyByQid: Map<string, string | null>;
}

/** Resolve Wikidata quantity-unit QIDs to ISO 4217 codes via P498. */
export async function resolveCurrencyUnits(
  unitQids: string[]
): Promise<{ byQid: Map<string, string | null>; rawPath: string }> {
  if (unitQids.length === 0) return { byQid: new Map(), rawPath: "" };

  // Batch to keep the VALUES clause inside a sane request size.
  const byQid = new Map<string, string | null>();
  let rawPath = "";
  const BATCH = 20;
  for (let i = 0; i < unitQids.length; i += BATCH) {
    const slice = unitQids.slice(i, i + BATCH);
    const values = slice.map((q) => `wd:${q}`).join(" ");
    const query = `SELECT ?cur ?iso WHERE {
  VALUES ?cur { ${values} }
  OPTIONAL { ?cur wdt:P498 ?iso . }
}`;
    const { rows, rawPath: p } = await runSparql(query, `currency-units-${i / BATCH + 1}`);
    rawPath = rawPath || p;
    for (const r of rows) {
      const qid = r.cur!.value.split("/").pop()!;
      const iso = r.iso?.value ?? null;
      byQid.set(qid, iso && /^[A-Z]{3}$/.test(iso) ? iso : null);
    }
    // Units Wikidata omitted from the response are still unresolved, not USD.
    for (const qid of slice) if (!byQid.has(qid)) byQid.set(qid, null);
  }
  return { byQid, rawPath };
}

/** Fetch every P2218 statement with its currency resolved to ISO 4217. */
export async function fetchWikidataNetWorth(): Promise<NetWorthSnapshot> {
  console.log("Querying Wikidata P2218 (net worth) …");
  const { rows, rawPath } = await runSparql(NET_WORTH_QUERY, "p2218");
  if (rows.length === 0) throw new Error("Wikidata returned zero P2218 rows — refusing to continue");

  const parsed = rows.map((r) => toRow(r));
  const unitQids = [...new Set(parsed.map((r) => r.unitQid))].sort();
  console.log(`  ${parsed.length} statement(s), ${unitQids.length} distinct currency unit(s)`);

  console.log("Resolving currency units to ISO 4217 via Wikidata P498 …");
  const { byQid, rawPath: currencyRawPath } = await resolveCurrencyUnits(unitQids);
  const resolved = [...byQid.entries()].filter(([, iso]) => iso !== null);
  console.log(`  ${resolved.length}/${unitQids.length} unit(s) carry an ISO 4217 code`);

  for (const row of parsed) {
    row.currencyIso = byQid.get(row.unitQid) ?? null;
  }

  return { rows: parsed, rawPath, currencyRawPath, currencyByQid: byQid };
}

export const PRECISION_YEAR = 9;
export const PRECISION_MONTH = 10;
export const PRECISION_DAY = 11;

/**
 * Truncate an xsd:dateTime back to the precision Wikidata recorded.
 * Returns null when the literal cannot be read, so an unreadable date is
 * dropped rather than defaulted.
 */
export function formatAsOf(value: string | undefined, precision: number | null): string | null {
  if (!value) return null;
  const m = value.match(/^(-?\d{4,})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (precision == null) return `${y}-${mo}-${d}`;
  if (precision <= PRECISION_YEAR) return y;
  if (precision === PRECISION_MONTH) return `${y}-${mo}`;
  return `${y}-${mo}-${d}`;
}

function toRow(r: Row): WikidataNetWorthRow {
  const qid = r.person!.value.split("/").pop()!;
  const amount = Number(r.amount!.value);
  const precision =
    r.timePrecision?.value != null ? parseInt(r.timePrecision.value, 10) : null;
  return {
    qid,
    label: r.personLabel?.value ?? qid,
    amount,
    unitQid: r.currency!.value.split("/").pop()!,
    currencyIso: null, // filled in after the currency pass
    asOf: formatAsOf(r.pointInTime?.value, Number.isFinite(precision) ? precision : null),
    timePrecision: Number.isFinite(precision) ? precision : null,
    referenceUrl: r.ref?.value ?? null,
    birthYear: r.birth?.value ? parseYear(r.birth.value) : null,
    citizenshipIso2: r.citizenshipIso?.value ?? null,
  };
}

function parseYear(value: string): number | null {
  const m = value.match(/(-?\d{4})-\d{2}-\d{2}/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return Number.isFinite(y) && y > 1800 && y < 2100 ? y : null;
}

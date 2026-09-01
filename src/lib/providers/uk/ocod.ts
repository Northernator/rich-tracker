/**
 * Chunk 10 — OCOD: Overseas companies that own property in England and Wales.
 *
 * This is the file that makes a beneficial-ownership chain possible at all.
 * It is the ONLY open source that names, per Land Registry title, the overseas
 * company that owns it:
 *
 *   title number → proprietor name + Company Registration No. → (OE number)
 *
 * The Register of Overseas Entities (Companies House) then names the humans
 * behind that OE number. Neither register alone links a property to a person;
 * OCOD is the join, and the registration number it carries is the only thing
 * that makes the second hop addressable.
 *
 * Access posture (verified 2026-09-01, and this is why the provider is shaped
 * the way it is):
 *   - The dataset page states "You will need to create an account or sign in,
 *     and agree to the data licence". The API returns 403 without a key and
 *     /datasets/ocod/download 302s to /error. There is NO anonymous route, and
 *     no per-title public URL exists — you cannot cite a single OCOD row to a
 *     URL on the Land Registry's site.
 *   - So the loader is file-first: a CSV (or the service's ZIP) dropped into
 *     data/raw/uk/ocod/ is the audit trail, exactly as chunk 9 treats the FAA
 *     download. With HMLR_API_KEY set it downloads the monthly full file
 *     itself. With neither, it throws — it never invents rows, and it never
 *     reaches for a third-party mirror whose provenance we cannot show.
 *
 * Licence: Open Government Licence v3 (Crown copyright), free of charge.
 *
 * Integrity rules enforced here:
 *   - Rows are parsed, never interpreted. A proprietor with no registration
 *     number is returned as such; deciding it is unusable for chaining is the
 *     loader's job, not the parser's.
 *   - Dates in this file are genuinely inconsistent ("23-12–2008" with an en
 *     dash, "18-6-09", "26-3-18"). Unparseable dates come back null rather
 *     than guessing a year.
 *   - The CSV is quoted with embedded commas and newlines; a naive
 *     `split(",")` would shift every address column by one. Hence a real
 *     parser.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, extname } from "path";
import { inflateRawSync } from "zlib";
import { politeFetch } from "@/lib/providers/http";
import { loadLocalEnv } from "./env";

/** The dataset landing page — the citation for an OCOD row (see module doc). */
export const OCOD_DATASET_URL = "https://use-land-property-data.service.gov.uk/datasets/ocod";

/** Technical specification, cited alongside the dataset for column meaning. */
export const OCOD_SPEC_URL =
  "https://use-land-property-data.service.gov.uk/datasets/ocod/tech-spec";

const API_BASE = "https://use-land-property-data.service.gov.uk/api/v1";

export const OCOD_DIR = join("data", "raw", "uk", "ocod");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OcodProprietor {
  name: string;
  /** The field the whole chain hangs on. OE numbers look like "OE016669". */
  companyRegistrationNo: string;
  proprietorshipCategory: string;
  countryIncorporated: string;
  addressLines: string[];
}

export interface OcodRow {
  titleNumber: string;
  tenure: string;
  propertyAddress: string;
  district: string;
  county: string;
  region: string;
  /** Raw, unformatted — OCOD strips the space inside the outward code. */
  postcode: string;
  multipleAddressIndicator: string;
  /** GBP as published, or null. OCOD only populates this for some titles. */
  pricePaid: number | null;
  proprietors: OcodProprietor[];
  /** ISO date (YYYY-MM-DD) or null when the source value cannot be parsed. */
  dateProprietorAdded: string | null;
  additionalProprietorIndicator: string;
}

export interface OcodSource {
  /** Path of the CSV actually parsed — the audit trail for every row loaded. */
  csvPath: string;
  fileName: string;
  origin: "local-file" | "hm-land-registry-api";
  /** "YYYY-MM" parsed from the file name, e.g. OCOD_FULL_2026_08.zip. */
  release: string | null;
  rowCount: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * RFC-4180-ish CSV parser. Handles quoted fields containing commas,
 * double-quoted newlines and escaped quotes (""). Returns rows of raw strings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  // Strip a BOM if present — the service has shipped files with one.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (c === "\r") continue;
    field += c;
  }
  // Final field/row (files do not always end with a newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[().]/g, "")
    .trim();
}

/**
 * Map a header row to column indexes by normalised name.
 *
 * Throws on a missing column rather than silently reading the wrong one: the
 * OCOD file has four near-identical proprietor blocks, so an off-by-one here
 * would attribute one company's registration number to another company's
 * name — a fabricated ownership link produced by a parser bug.
 */
function headerIndex(header: string[], required: string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((h, i) => map.set(normaliseHeader(h), i));
  for (const key of required) {
    if (!map.has(key)) {
      throw new Error(
        `OCOD header is missing required column "${key}". ` +
          `Header was: ${header.slice(0, 12).join(" | ")}…`
      );
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

/**
 * OCOD date formats observed in the wild: "23-12–2008" (en dash between month
 * and year), "18-6-09", "26-3-18", "2018-03-26". Returns ISO or null — a date
 * we cannot read is not a date we are willing to assert.
 */
export function parseOcodDate(raw: string): string | null {
  const s = raw.trim().replace(/[–—]/g, "-");
  if (s === "") return null;
  const parts = s.split("-").map((p) => p.trim());
  if (parts.length !== 3) return null;

  // ISO form: 2018-03-26
  if (parts[0].length === 4) {
    const [y, m, d] = parts.map((p) => parseInt(p, 10));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // day-month-year with a 2- or 4-digit year
  const d = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const yRaw = parts[2];
  if (!Number.isFinite(d) || !Number.isFinite(m)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  let y: number;
  if (yRaw.length === 4) {
    y = parseInt(yRaw, 10);
  } else if (yRaw.length === 2) {
    // Two-digit years: treat anything up to the current year as 20xx and the
    // rest as 19xx. The dataset begins in 2015 but "Date Proprietor Added"
    // predates it for long-held titles.
    const yy = parseInt(yRaw, 10);
    if (!Number.isFinite(yy)) return null;
    const currentTwoDigit = new Date().getUTCFullYear() % 100;
    y = yy <= currentTwoDigit ? 2000 + yy : 1900 + yy;
  } else {
    return null;
  }
  if (!Number.isFinite(y)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Price Paid in OCOD is GBP, published bare ("350000"). Null when absent. */
export function parsePricePaid(raw: string): number | null {
  const cleaned = raw.replace(/[£,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * True when the registration number is a Companies House overseas-entity
 * number. Only these are addressable on the register, so only these can carry
 * a chain to a person. Anything else (a Guernsey or Isle of Man number, or a
 * blank on pre-2022 rows) is returned to the loader as unchainable.
 */
export function isOverseasEntityNumber(reg: string): boolean {
  return /^oe\s?\d{5,8}$/i.test(reg.trim());
}

/** Normalise "oe016669" / "OE 016669" to the canonical "OE016669". */
export function normaliseOeNumber(reg: string): string {
  return reg.trim().toUpperCase().replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

export function parseOcodRows(rows: string[][]): OcodRow[] {
  if (rows.length < 2) return [];
  const header = rows[0];
  const idx = headerIndex(header, [
    "title number",
    "tenure",
    "property address",
    "postcode",
    "proprietor name 1",
    "company registration no 1",
  ]);

  const at = (row: string[], key: string): string => {
    const i = idx.get(key);
    if (i === undefined) return "";
    return (row[i] ?? "").trim();
  };

  const out: OcodRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || (row.length === 1 && row[0].trim() === "")) continue;

    const titleNumber = at(row, "title number");
    if (titleNumber === "") continue; // trailing/blank line

    const proprietors: OcodProprietor[] = [];
    for (const n of [1, 2, 3, 4]) {
      const name = at(row, `proprietor name ${n}`);
      const regNo = at(row, `company registration no ${n}`);
      if (name === "" && regNo === "") continue;
      proprietors.push({
        name,
        companyRegistrationNo: regNo,
        proprietorshipCategory: at(row, `proprietorship category ${n}`),
        countryIncorporated: at(row, `country incorporated ${n}`),
        addressLines: [
          at(row, `proprietor ${n} address 1`),
          at(row, `proprietor ${n} address 2`),
          at(row, `proprietor ${n} address 3`),
        ].filter((l) => l !== ""),
      });
    }

    out.push({
      titleNumber,
      tenure: at(row, "tenure"),
      propertyAddress: at(row, "property address"),
      district: at(row, "district"),
      county: at(row, "county"),
      region: at(row, "region"),
      postcode: at(row, "postcode"),
      multipleAddressIndicator: at(row, "multiple address indicator"),
      pricePaid: parsePricePaid(at(row, "price paid")),
      proprietors,
      dateProprietorAdded: parseOcodDate(at(row, "date proprietor added")),
      additionalProprietorIndicator: at(row, "additional proprietor indicator"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ZIP (the service ships OCOD_FULL_YYYY_MM.zip)
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Minimal single-entry ZIP reader. Supports stored (0) and deflate (8) —
 * which is what the service publishes — and throws on anything else rather
 * than returning half a file.
 */
export function unzipFirst(buf: Buffer, mustEndWith = ".csv"): ZipEntry {
  // End of central directory: 0x06054b50, searched from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP file: no end-of-central-directory record found");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16); // central directory offset
  if (entryCount === 0) throw new Error("ZIP contains no entries");

  for (let e = 0; e < entryCount; e++) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`ZIP central directory entry ${e} has a bad signature`);
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;

    if (!name.toLowerCase().endsWith(mustEndWith)) continue;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP local header for "${name}" has a bad signature`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) return { name, data: Buffer.from(raw) };
    if (method === 8) return { name, data: inflateRawSync(raw) };
    throw new Error(`ZIP entry "${name}" uses unsupported compression method ${method}`);
  }
  throw new Error(`ZIP contains no ${mustEndWith} entry`);
}

// ---------------------------------------------------------------------------
// Source resolution — file first, API second, throw otherwise
// ---------------------------------------------------------------------------

function listLocalFiles(dir: string): Array<{ path: string; name: string; mtimeMs: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => {
      const ext = extname(f).toLowerCase();
      return ext === ".csv" || ext === ".zip";
    })
    .map((f) => {
      const p = join(dir, f);
      return { path: p, name: f, mtimeMs: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Read a local CSV or ZIP into text, extracting a ZIP next to the archive. */
function readLocalCsv(file: { path: string; name: string }): { csvPath: string; text: string } {
  if (extname(file.name).toLowerCase() === ".zip") {
    const entry = unzipFirst(readFileSync(file.path));
    const csvPath = join(OCOD_DIR, entry.name);
    writeFileSync(csvPath, entry.data);
    return { csvPath, text: entry.data.toString("utf8") };
  }
  return { csvPath: file.path, text: readFileSync(file.path, "utf8") };
}

/** "OCOD_FULL_2026_08.zip" → "2026-08"; unmatched → null. */
export function releaseFromFile(fileName: string): string | null {
  const m = fileName.match(/(19|20)(\d{2})[_-](\d{2})/);
  if (!m) return null;
  return `${m[1]}${m[2]}-${m[3]}`;
}

interface ApiResource {
  file_name: string;
  name?: string;
  row_count?: number;
  format?: string;
}

async function downloadViaApi(): Promise<{ fileName: string; bytes: Buffer }> {
  loadLocalEnv();
  const key = process.env.HMLR_API_KEY;
  if (!key) {
    throw new Error(
      "HMLR_API_KEY is not set. Register (free) at " +
        "https://use-land-property-data.service.gov.uk/registration, agree to the " +
        "OGL licence, then either set HMLR_API_KEY or drop the OCOD full file " +
        `(CSV or the service's ZIP) into ${OCOD_DIR}/.`
    );
  }

  const headers = { Authorization: key, Accept: "application/json" };

  const metaRes = await politeFetch(`${API_BASE}/datasets/ocod`, { headers });
  const meta = (await metaRes.json()) as {
    result?: { resources?: ApiResource[] };
    success?: boolean;
  };
  const resources = meta.result?.resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error(
      "HMLR API returned no resources for dataset 'ocod' — the account may not " +
        "have accepted the dataset licence yet."
    );
  }

  // Prefer the complete file. The service labels it "Full File"; fall back to
  // the name convention OCOD_FULL_YYYY_MM.zip.
  const full =
    resources.find((r) => (r.name ?? "").toLowerCase().includes("full")) ??
    resources.find((r) => /FULL/i.test(r.file_name ?? ""));
  if (!full || !full.file_name) {
    throw new Error(
      `Could not identify the full file among ocod resources: ` +
        JSON.stringify(resources.map((r) => r.file_name))
    );
  }

  const linkRes = await politeFetch(
    `${API_BASE}/datasets/ocod/${encodeURIComponent(full.file_name)}`,
    { headers }
  );
  const link = (await linkRes.json()) as { result?: { download_url?: string } };
  const downloadUrl = link.result?.download_url;
  if (!downloadUrl) {
    throw new Error(
      `HMLR API returned no download_url for "${full.file_name}". ` +
        "Check the account has licence access to the OCOD dataset."
    );
  }

  // The presigned URL is valid for ~10 seconds. No retry window here —
  // re-request the link rather than hammering an expired URL.
  const fileRes = await politeFetch(downloadUrl);
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  return { fileName: full.file_name, bytes };
}

export interface ResolveOptions {
  /** Parse this exact file instead of searching data/raw/uk/ocod. */
  explicitPath?: string;
}

/**
 * Resolve and parse the OCOD release.
 *
 * Order: explicit path → newest local file in data/raw/uk/ocod → API download.
 * Every path returns the rows AND the local file they came from, because that
 * local file is the audit trail the acceptance checklist wants to be able to
 * re-read.
 */
export async function resolveOcod(opts: ResolveOptions = {}): Promise<{
  source: OcodSource;
  rows: OcodRow[];
}> {
  let csvPath: string;
  let text: string;
  let fileName: string;
  let origin: OcodSource["origin"];

  if (opts.explicitPath) {
    if (!existsSync(opts.explicitPath)) {
      throw new Error(`OCOD file not found: ${opts.explicitPath}`);
    }
    fileName = opts.explicitPath.split(/[\\/]/).pop() ?? opts.explicitPath;
    ({ csvPath, text } = readLocalCsv({ path: opts.explicitPath, name: fileName }));
    origin = "local-file";
  } else {
    const local = listLocalFiles(OCOD_DIR);
    if (local.length > 0) {
      console.log(`[ocod] using local capture: ${local[0].path}`);
      ({ csvPath, text } = readLocalCsv(local[0]));
      fileName = local[0].name;
      origin = "local-file";
      if (local.length > 1) {
        console.log(
          `[ocod] note: ${local.length} files present in ${OCOD_DIR}; using the newest by mtime`
        );
      }
    } else {
      console.log(`[ocod] no local capture in ${OCOD_DIR} — falling back to the HMLR API`);
      const { fileName: apiName, bytes } = await downloadViaApi();
      mkdirSync(OCOD_DIR, { recursive: true });
      const target = join(OCOD_DIR, apiName);
      writeFileSync(target, bytes);
      fileName = apiName;
      if (apiName.toLowerCase().endsWith(".zip")) {
        ({ csvPath, text } = readLocalCsv({ path: target, name: apiName }));
      } else {
        csvPath = target;
        text = bytes.toString("utf8");
      }
      origin = "hm-land-registry-api";
    }
  }

  const rows = parseOcodRows(parseCsv(text));
  if (rows.length === 0) {
    throw new Error(`OCOD file parsed to zero rows: ${csvPath}`);
  }
  if (rows.length < 200) {
    // The service's public example.csv is 14 rows of illustrative data with
    // no registration numbers. Loading it would produce a plausible-looking
    // property table with no chains behind it.
    console.warn(
      `[ocod] WARNING: only ${rows.length} rows in ${fileName}. If this is the ` +
        "public example.csv it carries no company registration numbers and will " +
        "produce no chains — use the full file."
    );
  }

  return {
    source: {
      csvPath,
      fileName,
      origin,
      release: releaseFromFile(fileName),
      rowCount: rows.length,
      bytes: Buffer.byteLength(text, "utf8"),
    },
    rows,
  };
}

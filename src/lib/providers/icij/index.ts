/**
 * Chunk 11 — ICIJ Offshore Leaks provider.
 *
 * Responsibilities:
 *   - Parse the official ICIJ CSV export (ODbL) tolerantly. The export's
 *     header style varies between releases (`node_id` vs `:ID(Entity)`,
 *     `:START_ID`/`:END_ID`/`:TYPE` on relationships), so every lookup is by
 *     normalised header name, never by position.
 *   - Build a RESOLVABLE source_url for each node: the ICIJ node page opens the
 *     document supporting the claim. (Standing rule: every claims row carries a
 *     resolvable citation; a node id with no link is not inserted.)
 *   - Discover a local capture in data/raw/icij/ (the project's audit-trail
 *     convention, same as chunk 10's OCOD) and, optionally, download one.
 *
 * This module NEVER invents data. If no capture is found and no download is
 * requested (or it fails), the loader that calls this throws — loudly.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const ICIJ_SOURCE_ID = "icij-offshore-leaks";

/** Resolvable public URL for an ICIJ node — the document behind a claim. */
export function nodeUrl(nodeId: string): string {
  return `https://offshoreleaks.icij.org/node/${encodeURIComponent(nodeId)}`;
}

/** RFC4180-ish CSV parser. Quoted fields may contain commas and newlines. */
export function* parseCsv(text: string): Generator<string[]> {
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
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
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      yield row;
      row = [];
      field = "";
    } else if (c === "\r") {
      // Ignore; the following \n ends the row.
    } else {
      field += c;
    }
  }
  if (row.length > 0 || field.length > 0) {
    row.push(field);
    yield row;
  }
}

/** Normalise a header: drop leading colons and any `:Type` suffix, lowercase. */
function normHeader(h: string): string {
  return h
    .trim()
    .replace(/^:+/, "")
    .replace(/:.*$/, "")
    .toLowerCase();
}

/** Index of the first header matching any candidate (normalised), or -1. */
function col(map: Map<string, number>, candidates: string[]): number {
  for (const c of candidates) {
    const idx = map.get(c.toLowerCase());
    if (idx != null) return idx;
  }
  return -1;
}

export interface CsvHeader {
  map: Map<string, number>;
  row: string[];
}

export function headerOf(rows: Generator<string[]>): CsvHeader {
  const first = rows.next();
  if (first.done || !first.value) throw new Error("CSV has no header row");
  const row = first.value;
  const map = new Map<string, number>();
  row.forEach((h, i) => {
    const key = normHeader(h);
    if (key && !map.has(key)) map.set(key, i);
  });
  return { map, row };
}

export interface IcijEntityRow {
  nodeId: string;
  name: string | null;
  jurisdiction: string | null;
  jurisdictionDescription: string | null;
  companyType: string | null;
  address: string | null;
  sourceId: string | null;
  validUntil: string | null;
  countryCodes: string | null;
  status: string | null;
  note: string | null;
}

export function readEntityRow(h: CsvHeader, cells: string[]): IcijEntityRow | null {
  const id = col(h.map, ["node_id", "id"]);
  const name = col(h.map, ["name"]);
  if (id < 0) return null;
  const nodeId = (cells[id] ?? "").trim();
  if (!nodeId) return null;
  const get = (c: number) => (c >= 0 && cells[c] != null ? cells[c].trim() || null : null);
  return {
    nodeId,
    name: get(name),
    jurisdiction: get(col(h.map, ["jurisdiction"])),
    jurisdictionDescription: get(col(h.map, ["jurisdiction_description"])),
    companyType: get(col(h.map, ["company_type"])),
    address: get(col(h.map, ["address"])),
    sourceId: get(col(h.map, ["sourceid", "source_id"])),
    validUntil: get(col(h.map, ["valid_until"])),
    countryCodes: get(col(h.map, ["country_codes"])),
    status: get(col(h.map, ["status"])),
    note: get(col(h.map, ["note"])),
  };
}

export interface IcijOfficerRow {
  nodeId: string;
  name: string | null;
  countryCodes: string | null;
  jurisdiction: string | null;
  jurisdictionDescription: string | null;
  sourceId: string | null;
  validUntil: string | null;
  status: string | null;
  note: string | null;
}

export function readOfficerRow(h: CsvHeader, cells: string[]): IcijOfficerRow | null {
  const id = col(h.map, ["node_id", "id"]);
  const name = col(h.map, ["name"]);
  if (id < 0) return null;
  const nodeId = (cells[id] ?? "").trim();
  if (!nodeId) return null;
  const get = (c: number) => (c >= 0 && cells[c] != null ? cells[c].trim() || null : null);
  return {
    nodeId,
    name: get(name),
    countryCodes: get(col(h.map, ["country_codes"])),
    jurisdiction: get(col(h.map, ["jurisdiction"])),
    jurisdictionDescription: get(col(h.map, ["jurisdiction_description"])),
    sourceId: get(col(h.map, ["sourceid", "source_id"])),
    validUntil: get(col(h.map, ["valid_until"])),
    status: get(col(h.map, ["status"])),
    note: get(col(h.map, ["note"])),
  };
}

export interface IcijRelationshipRow {
  startId: string;
  endId: string;
  relType: string;
  sourceId: string | null;
  validUntil: string | null;
  status: string | null;
  note: string | null;
}

export function readRelationshipRow(h: CsvHeader, cells: string[]): IcijRelationshipRow | null {
  const start = col(h.map, ["start_id", "startid"]);
  const end = col(h.map, ["end_id", "endid"]);
  const type = col(h.map, ["type", "rel_type", "reltype"]);
  if (start < 0 || end < 0) return null;
  const startId = (cells[start] ?? "").trim();
  const endId = (cells[end] ?? "").trim();
  if (!startId || !endId) return null;
  const get = (c: number) => (c >= 0 && cells[c] != null ? cells[c].trim() || null : null);
  return {
    startId,
    endId,
    relType: (type >= 0 ? (cells[type] ?? "").trim() : "").toUpperCase() || "UNKNOWN",
    sourceId: get(col(h.map, ["sourceid", "source_id"])),
    validUntil: get(col(h.map, ["valid_until"])),
    status: get(col(h.map, ["status"])),
    note: get(col(h.map, ["note"])),
  };
}

// ---------------------------------------------------------------------------
// Local capture discovery — mirrors chunk 10's data/raw/uk/ocod convention.
// ---------------------------------------------------------------------------

export interface IcijCapture {
  entities?: string;
  officers?: string;
  relationships?: string;
  dir: string;
}

const ENTITY_NAMES = ["nodes-entities.csv", "entities.csv", "Entities.csv"];
const OFFICER_NAMES = ["nodes-officers.csv", "officers.csv", "Officers.csv"];
const REL_NAMES = ["relationships.csv", "Relationships.csv", "edges.csv"];

function findFile(dir: string, names: string[]): string | undefined {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return undefined;
}

/**
 * Locate a real ICIJ capture under data/raw/icij/. Returns undefined (never a
 * fabricated path) if none is present — the caller then decides whether to
 * download or to throw.
 */
export function discoverCapture(dir = join(process.cwd(), "data", "raw", "icij")): IcijCapture | undefined {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const capture: IcijCapture = { dir };
  capture.entities = findFile(dir, ENTITY_NAMES);
  capture.officers = findFile(dir, OFFICER_NAMES);
  capture.relationships = findFile(dir, REL_NAMES);
  if (!capture.entities && !capture.officers && !capture.relationships) return undefined;
  return capture;
}

/** Read a capture CSV as a row generator. Throws on missing file. */
export function readCaptureCsv(path: string): Generator<string[]> {
  const text = readFileSync(path, "utf8");
  return parseCsv(text);
}

/**
 * Optional download. The operator may point ICIJ_RAW_BASE at the official ODbL
 * CSV location (default: the ICIJ data-packages repo). This is best-effort and
 * fails loudly — it never fabricates. Not run unless --download is passed.
 */
export const ICIJ_RAW_BASE =
  process.env.ICIJ_RAW_BASE ??
  "https://raw.githubusercontent.com/ICIJ/offshoreleaks-data-packages/main/raw-data";

export async function downloadIfRequested(dir: string): Promise<IcijCapture> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const files = [
    { name: "nodes-entities.csv", key: "entities" as const },
    { name: "nodes-officers.csv", key: "officers" as const },
    { name: "relationships.csv", key: "relationships" as const },
  ];
  const captured: IcijCapture = { dir };
  const { writeFile } = await import("node:fs/promises");
  for (const f of files) {
    const url = `${ICIJ_RAW_BASE.replace(/\/$/, "")}/${f.name}`;
    console.log(`  downloading ${url} …`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`ICIJ download failed for ${f.name}: HTTP ${res.status}`);
    }
    // Read the whole body at once (loaders run server-side, not in a request).
    const buf = new Uint8Array(await res.arrayBuffer());
    const out = join(dir, f.name);
    await writeFile(out, buf);
    captured[f.key] = out;
    console.log(`  saved ${out} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
  return captured;
}

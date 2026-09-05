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

import {
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  createWriteStream,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { politeFetch } from "@/lib/providers/http";

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

// ---------------------------------------------------------------------------
// Streaming CSV reader — the load-bearing fix.
//
// The old readCaptureCsv did readFileSync(path) of the ENTIRE file and parsed it
// in memory. A real ICIJ relationships.csv is 1–3 GB; that path OOM-killed the
// process. The streaming reader reads the file in fixed-size buffers and yields
// rows as it goes, so peak memory is bounded by one buffer (plus a small carry
// for a partial UTF-8 sequence) regardless of file size. The Generator<string[]>
// contract is byte-for-byte compatible with the old readFileSync+parseCsv path,
// so every caller (loadStaging, matchOfficers, buildEdges, headerOf) is
// unchanged.
// ---------------------------------------------------------------------------

/** Read this many bytes at a time. 64 MB keeps a multi-GB file bounded. */
const CSV_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Count the bytes at the tail of `buf` that form an INCOMPLETE UTF-8 sequence
 * (a multibyte char split across a read boundary). Those bytes must be carried
 * to the next chunk and prepended before decoding, or the character is mangled.
 */
function trailingIncompleteBytes(buf: Buffer): number {
  let i = buf.length;
  let cont = 0; // number of trailing continuation bytes seen so far
  while (i > 0) {
    const b = buf[i - 1];
    if ((b & 0x80) === 0) return 0; // ASCII byte → safe boundary, nothing to carry
    if ((b & 0xc0) === 0x80) {
      cont++; // a 0x80–0xBF continuation byte
      i--;
      if (cont >= 4) break; // at most 4 bytes in a UTF-8 sequence
      continue;
    }
    // Lead byte at position i-1. Determine how many continuation bytes it needs.
    let need = 0;
    if ((b & 0xe0) === 0xc0) need = 1;
    else if ((b & 0xf0) === 0xe0) need = 2;
    else if ((b & 0xf8) === 0xf0) need = 3;
    return cont < need ? cont + 1 : 0; // incomplete → carry lead + seen continuations
  }
  return cont; // ran off the front of the buffer; treat all as incomplete
}

/** Decode `buf` as UTF-8, returning the clean head and any bytes to carry over. */
function decodeUtf8Safe(buf: Buffer): { text: string; rest: Buffer } {
  const k = trailingIncompleteBytes(buf);
  if (k === 0) return { text: buf.toString("utf8"), rest: Buffer.alloc(0) };
  return {
    text: buf.subarray(0, buf.length - k).toString("utf8"),
    rest: buf.subarray(buf.length - k),
  };
}

/**
 * Memory-bounded streaming CSV generator. Read state (in-quotes flag, current
 * field, current row) is carried across chunk boundaries so a quoted field that
 * contains a newline — or that straddles a 64 MB read — is handled correctly,
 * exactly as parseCsv would on the whole string.
 */
export function* streamCsv(path: string, chunkSize = CSV_CHUNK_BYTES): Generator<string[]> {
  const fd = openSync(path, "r");
  try {
    let carry: Buffer = Buffer.alloc(0);
    let inQuotes = false;
    // A '"' seen inside quotes whose meaning (escaped-quote vs closing-quote)
    // depends on the FOLLOWING char. We defer the decision into carried state
    // instead of peeking text[i+1], because a "" pair can straddle a chunk
    // boundary — a forward peek would mis-read the boundary and close the quote
    // early, corrupting every field after it. pendingQuote is carried across
    // chunks along with inQuotes/field/row, so boundaries are handled exactly.
    let pendingQuote = false;
    let field = "";
    let row: string[] = [];
    const buf = Buffer.alloc(chunkSize);
    let n: number;
    while ((n = readSync(fd, buf, 0, chunkSize, null)) > 0) {
      const { text, rest } = decodeUtf8Safe(Buffer.concat([carry, buf.subarray(0, n)]));
      carry = rest;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"') {
            if (pendingQuote) {
              field += '"'; // second '"' of an escaped "" pair
              pendingQuote = false;
            } else {
              pendingQuote = true; // await the next char to decide
            }
          } else if (pendingQuote) {
            // The pending '"' was a closing quote; resume outside quotes.
            inQuotes = false;
            pendingQuote = false;
            if (c === ",") {
              row.push(field);
              field = "";
            } else if (c === "\n") {
              row.push(field);
              yield row;
              row = [];
              field = "";
            } else if (c !== "\r") {
              field += c;
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
        } else if (c !== "\r") {
          field += c;
        }
      }
    }
    // Flush any trailing content after EOF (files without a final newline).
    // A dangling pendingQuote at EOF is just a closing quote; discard it.
    if (row.length > 0 || field.length > 0) {
      row.push(field);
      yield row;
    }
  } finally {
    closeSync(fd);
  }
}

/** Read a capture CSV as a memory-bounded, streaming row generator. Never reads
 * the whole file into memory, so a multi-GB relationships export cannot OOM.
 * Throws (via openSync) on a missing file. */
export function readCaptureCsv(path: string): Generator<string[]> {
  return streamCsv(path);
}

/**
 * Optional download. The operator may point ICIJ_RAW_BASE at a valid ODbL CSV
 * location. The previously-bundled default
 * (ICIJ/offshoreleaks-data-packages/main/raw-data) is DEAD — ICIJ no longer
 * serves the flat nodes-* / relationships.csv files at that path (the repo's
 * raw-data folder does not exist on main and the data has moved to their
 * download portal). So --download fails with a 404 unless ICIJ_RAW_BASE is
 * explicitly set to a current source. Best-effort and fails loudly — it never
 * fabricates. Not run unless --download is passed.
 *
 * Preferred workflow: obtain the official ODbL CSVs (nodes-entities.csv,
 * nodes-officers.csv, relationships.csv) from ICIJ's current distribution and
 * place them in data/raw/icij/, then run "npm run offshore:icij" WITHOUT
 * --download (discoverCapture picks them up).
 */
export const ICIJ_RAW_BASE =
  process.env.ICIJ_RAW_BASE ??
  "https://raw.githubusercontent.com/ICIJ/offshoreleaks-data-packages/main/raw-data";

export async function downloadIfRequested(dir: string): Promise<IcijCapture> {
  mkdirSync(dir, { recursive: true });
  const files = [
    { name: "nodes-entities.csv", key: "entities" as const },
    { name: "nodes-officers.csv", key: "officers" as const },
    { name: "relationships.csv", key: "relationships" as const },
  ];
  const captured: IcijCapture = { dir };
  for (const f of files) {
    const url = `${ICIJ_RAW_BASE.replace(/\/$/, "")}/${f.name}`;
    console.log(`  downloading ${url} …`);
    const res = await politeFetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(
        `ICIJ download failed for ${f.name}: HTTP ${res.status}. ` +
          "The bundled ICIJ_RAW_BASE default is dead (ICIJ moved the flat CSVs off " +
          "that GitHub path). Set ICIJ_RAW_BASE to a current ODbL source, or place the " +
          "official nodes-entities.csv / nodes-officers.csv / relationships.csv in " +
          "data/raw/icij/ and run without --download."
      );
    }
    // Stream the body straight to disk — never buffer the whole file. A real
    // relationships.csv is 1–3 GB; res.arrayBuffer() would OOM the process.
    const out = join(dir, f.name);
    const fileStream = createWriteStream(out);
    await new Promise<void>((resolve, reject) => {
      const src = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      src.on("error", reject);
      fileStream.on("error", reject);
      fileStream.on("finish", resolve);
      src.pipe(fileStream);
    });
    const size = statSync(out).size;
    captured[f.key] = out;
    console.log(`  saved ${out} (${(size / 1e6).toFixed(1)} MB)`);
  }
  return captured;
}

/**
 * OpenFIGI — ticker → FIGI / share-class FIGI mapping (Bloomberg Open Symbology).
 *
 * Role: fill the `securities` registry's identifier columns so a ticker is
 * never confused with another listing. A FIGI is evidence that "TSLA on
 * NASDAQ" is the instrument we think it is — it ends identifier-guessing.
 *
 * Key: optional (`OPENFIGI_API_KEY`, free signup). Without a key the
 * published limits are 25 req/min and ≤5 jobs per request; with a key 25 per
 * 6s and ≤100 jobs per request. politeFetch's bucket is key-aware (see
 * http.ts); this module sizes its batches the same way. No daily cap exists.
 *
 * Endpoint shape (published docs, https://www.openfigi.com/api/documentation):
 *   POST https://api.openfigi.com/v3/mapping
 *   header: Content-Type application/json, optional X-OPENFIGI-APIKEY
 *   body: [{idType:"TICKER", idValue:"IBM", exchCode:"US"}]
 *   → [{data:[{figi, ticker, exchCode, marketSector, name, shareClassFIGI,
 *       compositeFIGI, ...}]}] | [{warning:"..."}] | [{error:"..."}]
 *
 * Anti-guessing rules (a wrong FIGI is worse than none):
 *   - the returned ticker must equal the requested ticker (case-insensitive);
 *   - the returned exchCode must equal the exchCode we sent;
 *   - marketSector must be "Equity";
 *   - exactly one candidate may survive the filter — zero or several both
 *     mean "skip this security with a warning", never "pick one".
 */
import { politeFetch } from "../http";

const MAPPING_URL = "https://api.openfigi.com/v3/mapping";
export const OPENFIGI_DOC_URL = "https://www.openfigi.com/api/documentation";

/**
 * Our `securities.exchange` values → Bloomberg exchCode. Only exchanges on
 * this list are mapped; anything else is skipped by the loader, not guessed.
 * (UN = NYSE, UW = NASDAQ, FP = Euronext Paris, SM = Bolsa de Madrid,
 * IS = NSE India — Bloomberg symbology, same values OpenFIGI filters on.
 * NASDAQ is UW, not UQ: verified live 2026-09-05, TSLA/UQ returns "No
 * identifier found" while TSLA/UW resolves.)
 */
export const EXCHANGE_TO_EXCHCODE: Record<string, string> = {
  NYSE: "UN",
  NASDAQ: "UW",
  EPA: "FP",
  BME: "SM",
  NSE: "IS",
};

/**
 * Yahoo-style suffix per exchange, stripped by the loader before mapping:
 * OpenFIGI's TICKER idType wants the bare venue ticker ("MC"), not the
 * Yahoo composite ("MC.PA"). Only the listed suffix is ever stripped — a
 * dash like BRK-B is NOT a suffix and is sent verbatim (it warns and skips).
 */
export const EXCHANGE_YAHOO_SUFFIX: Record<string, string> = {
  EPA: ".PA",
  BME: ".MC",
  NSE: ".NS",
};

export interface FigiJob {
  ticker: string;
  exchCode: string;
}

export interface FigiMatch {
  ticker: string;
  exchCode: string;
  figi: string;
  shareClassFigi: string | null;
  compositeFigi: string | null;
  name: string | null;
}

interface MappingResult {
  data?: Array<{
    figi?: string;
    ticker?: string | null;
    exchCode?: string | null;
    marketSector?: string | null;
    name?: string | null;
    shareClassFIGI?: string | null;
    compositeFIGI?: string | null;
  }>;
  warning?: string;
  error?: string;
}

function hasKey(): boolean {
  return !!process.env.OPENFIGI_API_KEY;
}

function batchSize(): number {
  // Mirrors the published jobs-per-request limits (5 keyless, 100 with key).
  return hasKey() ? 100 : 5;
}

/**
 * Map tickers to FIGIs. Returns one entry per job: a match, or null when the
 * instrument is unknown or ambiguous. Throws on provider-level failures
 * (including per-job `error`), so a skipped security is always a logged
 * decision, never a silent one.
 */
export async function mapTickers(jobs: FigiJob[]): Promise<(FigiMatch | null)[]> {
  const out: (FigiMatch | null)[] = new Array(jobs.length).fill(null);
  if (jobs.length === 0) return out;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.OPENFIGI_API_KEY;
  if (key) headers["X-OPENFIGI-APIKEY"] = key;

  const size = batchSize();
  for (let i = 0; i < jobs.length; i += size) {
    const batch = jobs.slice(i, i + size);
    const body = batch.map((j) => ({
      idType: "TICKER",
      idValue: j.ticker,
      exchCode: j.exchCode,
      marketSecDes: "Equity",
    }));
    const res = await politeFetch(MAPPING_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json) || json.length !== batch.length) {
      throw new Error(
        `OpenFIGI returned ${Array.isArray(json) ? json.length : typeof json} results ` +
          `for ${batch.length} jobs — refusing to align by position`
      );
    }
    (json as MappingResult[]).forEach((row, idx) => {
      const job = batch[idx];
      if (!row || typeof row !== "object") {
        throw new Error(`OpenFIGI job ${idx} (${job.ticker}) returned a non-object`);
      }
      if (row.error) {
        throw new Error(`OpenFIGI refused ${job.ticker}/${job.exchCode}: ${row.error}`);
      }
      if (row.warning || !Array.isArray(row.data)) {
        console.warn(`  ! OpenFIGI: no FIGI for ${job.ticker}/${job.exchCode} (${row.warning ?? "no data"})`);
        return;
      }
      const candidates = row.data.filter(
        (c) =>
          typeof c.ticker === "string" &&
          c.ticker.toUpperCase() === job.ticker.toUpperCase() &&
          c.exchCode === job.exchCode &&
          c.marketSector === "Equity" &&
          typeof c.figi === "string" &&
          c.figi.length > 0
      );
      if (candidates.length === 0) {
        console.warn(
          `  ! OpenFIGI: ${row.data.length} result(s) for ${job.ticker}/${job.exchCode} but none match ticker+venue+Equity — skipping`
        );
        return;
      }
      if (candidates.length > 1) {
        console.warn(
          `  ! OpenFIGI: ${candidates.length} identical candidates for ${job.ticker}/${job.exchCode} — refusing to pick one`
        );
        return;
      }
      const c = candidates[0];
      // FIGIs are 12 chars starting BBG. A malformed identifier from the
      // provider is a provider failure, not a row to store.
      if (!/^BBG[0-9A-Z]{9}$/.test(c.figi!)) {
        throw new Error(
          `OpenFIGI returned a malformed FIGI for ${job.ticker}/${job.exchCode}: ${c.figi}`
        );
      }
      out[i + idx] = {
        ticker: job.ticker,
        exchCode: job.exchCode,
        figi: c.figi!,
        shareClassFigi: c.shareClassFIGI ?? null,
        compositeFigi: c.compositeFIGI ?? null,
        name: c.name ?? null,
      };
    });
  }
  return out;
}

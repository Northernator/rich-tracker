/**
 * FRED — macro observations (CPI, policy rate, long rate) for context.
 *
 * Role: store a small number of benchmark economic series in
 * `macro_observations` so event impacts and methodology notes can reference
 * the actual CPI / Fed-funds / 10-year values instead of prose. Three series,
 * capped history — this is context, not a data warehouse.
 *
 * Key: required (`FRED_API_KEY`, free signup). Published ceiling is
 * 120 req/min; politeFetch stays at half that (see http.ts). One call per
 * series per run.
 *
 * Endpoint shape (published docs,
 * https://fred.stlouisfed.org/docs/api/fred/series_observations.html):
 *   GET https://api.stlouisfed.org/fred/series/observations
 *     ?series_id=CPIAUCSL&api_key=<KEY>&file_type=json
 *     &observation_start=2021-09-05&sort_order=asc
 *   → {"units":"...","observations":[{"date":"2021-09-01","value":"..."}]}
 * A value of "." means the observation is missing — skipped, never stored
 * as zero.
 */
import { politeFetch } from "../http";

const OBS_URL = "https://api.stlouisfed.org/fred/series/observations";
export const FRED_DOC_URL = "https://fred.stlouisfed.org/docs/api/fred/";

export interface FredObservation {
  date: string;
  value: number;
}

export interface FredSeries {
  seriesId: string;
  units: string;
  observations: FredObservation[];
}

function requireKey(): string {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    throw new Error(
      "FRED_API_KEY not set — sign up free at https://fredaccount.stlouisfed.org and set it in .env.local"
    );
  }
  return key;
}

interface ObservationsResponse {
  units?: unknown;
  observations?: unknown;
  error_message?: unknown;
}

export async function seriesObservations(
  seriesId: string,
  opts?: { observationStart?: string }
): Promise<FredSeries> {
  const key = requireKey();
  if (!/^[A-Z0-9_]+$/i.test(seriesId)) {
    throw new Error(`Refusing to request FRED series "${seriesId}" — not a series id`);
  }
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: "json",
    sort_order: "asc",
  });
  if (opts?.observationStart) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.observationStart)) {
      throw new Error(
        `observationStart must be YYYY-MM-DD, got "${opts.observationStart}"`
      );
    }
    params.set("observation_start", opts.observationStart);
  }
  const res = await politeFetch(`${OBS_URL}?${params.toString()}`);
  const json = (await res.json()) as ObservationsResponse;
  if (typeof json.error_message === "string" && json.error_message) {
    throw new Error(`FRED refused ${seriesId}: ${json.error_message}`);
  }
  if (!Array.isArray(json.observations)) {
    throw new Error(
      `FRED answered ${seriesId} with an unexpected shape ` +
        `(keys: ${Object.keys(json).join(", ")}) — refusing to parse`
    );
  }
  const units = typeof json.units === "string" ? json.units : "";
  const observations: FredObservation[] = [];
  let missing = 0;
  for (const raw of json.observations) {
    const o = raw as Record<string, unknown>;
    const date = typeof o.date === "string" ? o.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`FRED ${seriesId} returned an undated observation — refusing to store it`);
    }
    // "." is FRED's missing-value marker. Storing it as 0 would invent a
    // reading; skipping keeps the gap visible.
    if (o.value === ".") {
      missing++;
      continue;
    }
    const value = typeof o.value === "string" ? Number(o.value) : NaN;
    if (!Number.isFinite(value)) {
      throw new Error(
        `FRED ${seriesId} ${date} returned a non-numeric value (${JSON.stringify(o.value)})`
      );
    }
    observations.push({ date, value });
  }
  if (missing > 0) {
    console.warn(`  ! FRED ${seriesId}: skipped ${missing} missing (".") observation(s)`);
  }
  return { seriesId, units, observations };
}

/** Resolvable per-series citation for `macro_observations.source_url`. */
export function fredSeriesUrl(seriesId: string): string {
  return `https://fred.stlouisfed.org/series/${seriesId}`;
}

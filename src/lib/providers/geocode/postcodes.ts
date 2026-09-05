/**
 * Postcodes.io — UK postcode → latitude/longitude.
 *
 * Role: give real coordinates to UK assets (Price Paid / OCOD rows) whose
 * `assets.lat/lng` is NULL, so the globe can plot them instead of listing
 * them as "unmapped". Only ever fills NULLs — never overwrites a coordinate
 * that is already there.
 *
 * Key: none. Fair use (no published numeric ceiling), so this module uses the
 * bulk endpoint — up to 100 postcodes per POST — keeping a full-asset run to
 * ~1 request inside politeFetch's 2/sec default bucket.
 *
 * Verified live (2026-09-05, no key):
 *   GET https://api.postcodes.io/postcodes/SW1A1AA
 *   → {"status":200,"result":{"postcode":"SW1A 1AA","latitude":51.50101,
 *      "longitude":-0.141563, ...}}
 *   Unknown postcode → HTTP 404 {"status":404,"error":"Postcode not found"}.
 *   The 404 is a fact about the postcode, not a provider failure: callers get
 *   `null` for that postcode, everything else throws.
 */
import { politeFetch } from "../http";

const BULK_URL = "https://api.postcodes.io/postcodes";
const MAX_BATCH = 100;

export interface PostcodeCoord {
  /** Postcode as returned by the API (e.g. "SW1A 1AA"). */
  postcode: string;
  lat: number;
  lng: number;
}

interface SingleResponse {
  status: number;
  result?: { postcode?: string; latitude?: unknown; longitude?: unknown };
  error?: string;
}

interface BulkResponse {
  status: number;
  result?: Array<{ query?: string; result?: SingleResponse["result"] | null }>;
}

function parseCoord(postcode: string, result: SingleResponse["result"]): PostcodeCoord | null {
  const lat = result?.latitude;
  const lng = result?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error(
      `Postcodes.io returned out-of-range coordinates for ${postcode}: (${lat}, ${lng})`
    );
  }
  if (lat === 0 && lng === 0) {
    throw new Error(
      `Postcodes.io returned null-island (0, 0) for ${postcode} — refusing to store it`
    );
  }
  return { postcode: result?.postcode ?? postcode, lat, lng };
}

/**
 * Bulk lookup. Returns a map from the *query string as sent* to the resolved
 * coordinate, or null when the postcode is unknown (HTTP-404 equivalent in
 * the bulk response). Throws on any provider-level failure.
 */
export async function lookupPostcodes(
  postcodes: string[]
): Promise<Map<string, PostcodeCoord | null>> {
  const out = new Map<string, PostcodeCoord | null>();
  const queue = [...new Set(postcodes.map((p) => p.trim()).filter(Boolean))];
  for (const q of queue) out.set(q, null);
  if (queue.length === 0) return out;

  for (let i = 0; i < queue.length; i += MAX_BATCH) {
    const batch = queue.slice(i, i + MAX_BATCH);
    const res = await politeFetch(BULK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcodes: batch }),
    });
    const json = (await res.json()) as BulkResponse;
    if (json.status !== 200 || !Array.isArray(json.result)) {
      throw new Error(
        `Postcodes.io bulk lookup failed (status ${json.status}, ` +
          `keys: ${Object.keys(json).join(", ")})`
      );
    }
    if (json.result.length !== batch.length) {
      throw new Error(
        `Postcodes.io returned ${json.result.length} results for ${batch.length} queries — refusing to align by position`
      );
    }
    json.result.forEach((row, idx) => {
      const query = batch[idx];
      if (!row || row.query !== query) {
        throw new Error(
          `Postcodes.io bulk response misaligned at index ${idx} (sent "${query}", got "${row?.query}")`
        );
      }
      out.set(query, row.result ? parseCoord(query, row.result) : null);
    });
  }
  return out;
}

/** Resolvable per-postcode citation for `postcode_coords.source_url`. */
export function postcodeSourceUrl(postcode: string): string {
  return `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`;
}

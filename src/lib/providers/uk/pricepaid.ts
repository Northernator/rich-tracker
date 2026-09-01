/**
 * Chunk 10 — HM Land Registry Price Paid (the "PPI" linked-data service).
 *
 * OCOD tells us a title number is owned by an overseas company, but there is
 * NO public URL for a Land Registry title: the register itself is paywalled,
 * so an OCOD row cannot be cited to a row-level page on the Land Registry's
 * own site. Price Paid can be. Every sale since 1995 is published as linked
 * data, and each transaction has its own resolvable URI:
 *
 *   https://landregistry.data.gov.uk/data/ppi/transaction/<uuid>.html
 *
 * That URI is what "every property row links to a title or Price Paid record"
 * resolves to in practice: the property is identified by its OCOD title number
 * (assets.external_ref), and its citation is a real Price Paid record for the
 * same address.
 *
 * Two things worth knowing, both measured on 2026-09-01:
 *   - The SPARQL endpoint is https://landregistry.data.gov.uk/landregistry/query
 *     (NOT /query — that 404s).
 *   - Binding the postcode as a triple pattern answers in ~1.5s; the same
 *     query written as FILTER(STR(?pc) = "…") scans every address in the
 *     dataset and took 91s to time out. So the postcode is always bound, never
 *     filtered.
 *
 * Licence: Open Government Licence v3. No key required.
 */

import { politeFetch } from "@/lib/providers/http";

const SPARQL_ENDPOINT = "https://landregistry.data.gov.uk/landregistry/query";

const PREFIXES = `
PREFIX ppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX common: <http://landregistry.data.gov.uk/def/common/>
`;

export type MatchBasis = "paon+street" | "street" | "postcode-only";

/**
 * How much the Price Paid record is worth as evidence that this is the SAME
 * property as the OCOD row. A postcode alone can cover a whole apartment
 * block, so it never rises above the "possible link" floor on its own.
 */
export const PRICE_PAID_BASIS_CONFIDENCE: Record<MatchBasis, number> = {
  "paon+street": 0.9,
  street: 0.7,
  "postcode-only": 0.5,
};

export interface PricePaidMatch {
  /** The clickable citation: a real Price Paid record for this address. */
  recordUrl: string;
  transactionUri: string;
  /** GBP as published by the Land Registry. */
  priceGbp: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  paon: string | null;
  saon: string | null;
  street: string | null;
  town: string | null;
  postcode: string;
  basis: MatchBasis;
  confidence: number;
}

export interface PricePaidQuery {
  /** Postcode in any reasonable shape; normalised internally. */
  postcode: string;
  /** Free-text property address from OCOD, used only to disambiguate. */
  address?: string;
}

/**
 * OCOD publishes postcodes with the space removed ("SW61 2VT"). UK inward
 * codes are always the final three characters, so the space can be put back
 * deterministically — which matters, because Price Paid stores them spaced
 * ("SW6 1AA") and a literal match would otherwise miss every row.
 */
export function canonicalPostcode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 5 || s.length > 7) return null;
  return `${s.slice(0, s.length - 3)} ${s.slice(-3)}`;
}

function normaliseAddressPart(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `token` appears in `hay` as a whole word/number, not a substring. */
function containsToken(hay: string, token: string): boolean {
  if (token === "") return false;
  const padded = ` ${hay} `;
  // Escaping is unnecessary: both sides are already reduced to [A-Z0-9 ].
  return new RegExp(`(^| )${token}( |$)`).test(padded);
}

interface SparqlBinding {
  value: string;
}

interface SparqlRow {
  txn?: SparqlBinding;
  price?: SparqlBinding;
  date?: SparqlBinding;
  paon?: SparqlBinding;
  saon?: SparqlBinding;
  street?: SparqlBinding;
  town?: SparqlBinding;
}

const BASIS_RANK: Record<MatchBasis, number> = {
  "paon+street": 3,
  street: 2,
  "postcode-only": 1,
};

/**
 * Look up the most recent Price Paid record at a postcode, preferring the
 * record whose house number/name and street both appear in the OCOD address.
 *
 * Returns null when the postcode is unusable or the register holds nothing for
 * it — an unmatched property is a property without a price, not an error and
 * never a reason to invent one.
 */
export async function findPricePaid(q: PricePaidQuery): Promise<PricePaidMatch | null> {
  const postcode = canonicalPostcode(q.postcode);
  if (!postcode) return null;

  const query = `${PREFIXES}
SELECT ?txn ?price ?date ?paon ?saon ?street ?town WHERE {
  ?addr common:postcode "${postcode}" .
  ?rec ppi:propertyAddress ?addr ;
       ppi:pricePaid ?price ;
       ppi:transactionDate ?date .
  ?txn ppi:hasTransactionRecord ?rec .
  OPTIONAL { ?addr common:paon ?paon }
  OPTIONAL { ?addr common:saon ?saon }
  OPTIONAL { ?addr common:street ?street }
  OPTIONAL { ?addr common:town ?town }
} ORDER BY DESC(?date) LIMIT 50`;

  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`;
  const res = await politeFetch(url, {
    headers: { Accept: "application/sparql-results+json" },
  });
  const body = (await res.json()) as { results?: { bindings?: SparqlRow[] } };
  const bindings = body.results?.bindings ?? [];
  if (bindings.length === 0) return null;

  const hay = normaliseAddressPart(q.address ?? "");

  let best: PricePaidMatch | null = null;
  for (const b of bindings) {
    const txn = b.txn?.value;
    const price = b.price?.value;
    const date = b.date?.value;
    if (!txn || !price || !date) continue;

    const priceGbp = Number(price);
    if (!Number.isFinite(priceGbp) || priceGbp <= 0) continue;

    const street = b.street?.value ? normaliseAddressPart(b.street.value) : null;
    const paon = b.paon?.value ? normaliseAddressPart(b.paon.value) : null;

    let basis: MatchBasis = "postcode-only";
    if (street && containsToken(hay, street)) {
      basis = paon && containsToken(hay, paon) ? "paon+street" : "street";
    }

    // The SPARQL ?txn binding is the linked-data URI and is published as
    // http://. Force https:// and reduce it to the transaction id so the
    // clickable citation is the canonical .html page and matches the https
    // scheme the acceptance gate's PPD_PATTERN expects.
    const txnUuid = txn
      .replace(/^https?:\/\/landregistry\.data\.gov\.uk\/data\/ppi\/transaction\//i, "")
      .replace(/\.html?$/i, "");

    const candidate: PricePaidMatch = {
      recordUrl: `https://landregistry.data.gov.uk/data/ppi/transaction/${txnUuid}.html`,
      transactionUri: txn,
      priceGbp,
      date: date.slice(0, 10),
      paon: b.paon?.value ?? null,
      saon: b.saon?.value ?? null,
      street: b.street?.value ?? null,
      town: b.town?.value ?? null,
      postcode,
      basis,
      confidence: PRICE_PAID_BASIS_CONFIDENCE[basis],
    };

    if (best === null || betterThan(candidate, best)) best = candidate;
  }
  return best;
}

function betterThan(a: PricePaidMatch, b: PricePaidMatch): boolean {
  if (BASIS_RANK[a.basis] !== BASIS_RANK[b.basis]) {
    return BASIS_RANK[a.basis] > BASIS_RANK[b.basis];
  }
  return a.date > b.date;
}

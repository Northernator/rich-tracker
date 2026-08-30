/**
 * Country vocabulary bridge.
 *
 * `people.country` holds display names produced by the rtb-api loader
 * ("USA", "United Kingdom", "South Korea"), while Wikidata reports citizenship
 * as ISO 3166-1 alpha-2 codes (US, GB, KR). Comparing those two strings
 * directly matches almost nothing, so rule 3 of the Wikidata matcher
 * (exact name + country) needs a translation in between.
 *
 * This is a code mapping, not a claim about anyone's wealth — it carries no
 * data that ends up on a page. Unknown values return null and the caller skips
 * the row loudly; nothing is ever coerced to a guess.
 */

/** Display name as stored in `people.country` → ISO 3166-1 alpha-2. */
const NAME_TO_ISO2: Record<string, string> = {
  "USA": "US",
  "United States": "US",
  "United States of America": "US",
  "China": "CN",
  "India": "IN",
  "Germany": "DE",
  "Russia": "RU",
  "Italy": "IT",
  "Canada": "CA",
  "Brazil": "BR",
  // ISO 3166-1 assigns HK and TW as country codes; they are used here purely
  // as the identifier Wikidata itself publishes for these citizenship items,
  // so the two datasets can be joined.
  "Hong Kong": "HK",
  "Taiwan": "TW",
  "United Kingdom": "GB",
  "Australia": "AU",
  "France": "FR",
  "Sweden": "SE",
  "Singapore": "SG",
  "South Korea": "KR",
  "Spain": "ES",
  "Japan": "JP",
  "Israel": "IL",
  "Switzerland": "CH",
  "Turkey": "TR",
  "Indonesia": "ID",
  "Mexico": "MX",
  "Malaysia": "MY",
  "Greece": "GR",
  "Thailand": "TH",
  "Norway": "NO",
  "Belgium": "BE",
  "Netherlands": "NL",
  "Philippines": "PH",
  "Ireland": "IE",
  "Czech Republic": "CZ",
  "Czechia": "CZ",
  "Saudi Arabia": "SA",
  "Poland": "PL",
  "Cyprus": "CY",
  "United Arab Emirates": "AE",
  "South Africa": "ZA",
  "Kazakhstan": "KZ",
  "Denmark": "DK",
  "Austria": "AT",
  "Vietnam": "VN",
  "Ukraine": "UA",
  "Finland": "FI",
  "Romania": "RO",
  "Lebanon": "LB",
  "Hungary": "HU",
  "Egypt": "EG",
  "Chile": "CL",
  "Argentina": "AR",
  "Nigeria": "NG",
  "New Zealand": "NZ",
  "Colombia": "CO",
  "Morocco": "MA",
  "Uruguay": "UY",
  "Slovakia": "SK",
  "Portugal": "PT",
  "Monaco": "MC",
  "Estonia": "EE",
  "Bulgaria": "BG",
  "Zimbabwe": "ZW",
  "Venezuela": "VE",
  "Tanzania": "TZ",
  "Qatar": "QA",
  "Peru": "PE",
  "Pakistan": "PK",
  "Oman": "OM",
  "Nepal": "NP",
  "Luxembourg": "LU",
  "Liechtenstein": "LI",
  "Iceland": "IS",
  "Croatia": "HR",
  "Belize": "BZ",
  "Barbados": "BB",
  "Algeria": "DZ",
};

const LOWER_MAP = new Map(
  Object.entries(NAME_TO_ISO2).map(([name, iso]) => [name.toLowerCase(), iso])
);

/** Codes that already appear verbatim in `people.country` (rtb-api passes them through). */
const PASSTHROUGH_ISO2 = new Set([
  "US", "CN", "IN", "DE", "RU", "IT", "CA", "BR", "HK", "TW", "GB", "AU", "FR",
  "SE", "SG", "KR", "ES", "JP", "IL", "CH", "TR", "ID", "MX", "MY", "GR", "TH",
  "NO", "BE", "NL", "PH", "IE", "CZ", "SA", "PL", "CY", "AE", "ZA", "KZ", "DK",
  "AT", "VN", "UA", "FI", "RO", "LB", "HU", "EG", "CL", "AR", "NG", "NZ", "CO",
  "MA", "UY", "SK", "PT", "MC", "EE", "BG", "ZW", "VE", "TZ", "QA", "PE", "PK",
  "OM", "NP", "LU", "LI", "IS", "HR", "BZ", "BB", "DZ",
  // Seen in the live table: rtb-api emits bare codes for a handful of people.
  "GE", "GG", "AM", "AL", "AF",
]);

/**
 * Resolve a `people.country` value to ISO 3166-1 alpha-2.
 * Returns null when the value is unknown — the caller must skip, not guess.
 */
export function countryToIso2(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.length === 2 && PASSTHROUGH_ISO2.has(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }
  return LOWER_MAP.get(trimmed.toLowerCase()) ?? null;
}

/**
 * Reverse lookup, used only for log messages so a skipped row is readable.
 */
export function iso2ToCountry(iso2: string): string | null {
  for (const [name, code] of Object.entries(NAME_TO_ISO2)) {
    if (code === iso2.toUpperCase()) return name;
  }
  return null;
}

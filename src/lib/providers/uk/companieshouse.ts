/**
 * Chunk 10 — Companies House: beneficial owners of an overseas entity.
 *
 * This is the hop that turns a company into a person. OCOD says "title BLG69408
 * is owned by the entity registered as OE016669"; Companies House says who
 * stands behind OE016669, because every overseas entity must file its
 * beneficial owners on the Register of Overseas Entities.
 *
 * Two routes, one shape:
 *   - COMPANIES_HOUSE_KEY set → the JSON API (api.company-information…).
 *   - No key → the public page (find-and-update.company-information…), which
 *     is open and needs no account. Verified working 2026-09-01.
 *
 * WHY THE CITATION IS ALWAYS THE PUBLIC PAGE: an API URL is useless to a
 * reader — it 401s without a key. `publicUrl` is what every hop stores, so a
 * reviewer can click it and land on the register entry the row came from.
 * Whichever route produced the data, the link resolves.
 *
 * Rate limiting: both hosts share the 550-per-5-min bucket in
 * `src/lib/providers/http.ts`. That bucket deliberately covers the public web
 * host too — the service's own limit is account-level, and routing the HTML
 * route through the 2/sec default would look polite while still breaching the
 * 5-minute window under load.
 *
 * Only ACTIVE owners are usable. A withdrawn statement or a ceased owner is
 * history: it is parsed and reported, but no chain is built on it.
 *
 * Licence: Open Government Licence v3. Free key; the public pages need none.
 */

import { politeFetch } from "@/lib/providers/http";
import { loadLocalEnv } from "./env";

const API_HOST = "https://api.company-information.service.gov.uk";
const PUBLIC_HOST = "https://find-and-update.company-information.service.gov.uk";

/** The citation stored on every company→person hop. Resolvable by anyone. */
export function pscPublicUrl(companyNumber: string): string {
  return `${PUBLIC_HOST}/company/${encodeURIComponent(companyNumber)}/persons-with-significant-control`;
}

export type BoKind = "individual" | "corporate" | "legal-person" | "unknown";
export type BoStatus = "active" | "ceased" | "unknown";

export interface BeneficialOwner {
  kind: BoKind;
  name: string;
  status: BoStatus;
  notifiedOn: string | null;
  ceasedOn: string | null;
  nationality: string | null;
  countryOfResidence: string | null;
  /** Month 1-12 and year, as filed. Companies House never publishes a full DOB. */
  birthMonth: number | null;
  birthYear: number | null;
  natureOfControl: string[];
  /** Published correspondence / service address. Never a private home address. */
  correspondenceAddress: string | null;
}

export interface PscStatement {
  text: string;
  status: BoStatus;
  notifiedOn: string | null;
  ceasedOn: string | null;
}

export interface CompanyPsc {
  companyNumber: string;
  companyName: string;
  publicUrl: string;
  owners: BeneficialOwner[];
  statements: PscStatement[];
  provider: "companies-house-api" | "companies-house-public-page";
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#\d+);/g, (m) => {
    if (ENTITIES[m] !== undefined) return ENTITIES[m];
    const num = m.match(/#(\d+);/);
    if (num) return String.fromCharCode(parseInt(num[1], 10));
    return m;
  });
}

/** Text content of an element, tags stripped and entities decoded. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The Companies House page addresses every field by a numbered id
 * (`psc-name-3`, `psc-nationality-3`, `psc-notified-on-3`). Reading by id
 * rather than by DOM position is what keeps this parser alive when GOV.UK
 * changes a wrapper div: the numbering is the page's own data model.
 */
function fieldById(html: string, id: string): string | null {
  const re = new RegExp(`id="${escapeRe(id)}"[^>]*>([\\s\\S]*?)</`, "i");
  const m = html.match(re);
  if (!m) return null;
  const v = textOf(m[1]);
  return v === "" ? null : v;
}

function allByPrefix(html: string, idPrefix: string): string[] {
  const re = new RegExp(`id="${escapeRe(idPrefix)}[^"]*"[^>]*>([\\s\\S]*?)</`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = textOf(m[1]);
    if (v !== "") out.push(v);
  }
  return out;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** "22 January 2026" / "3 August 2026" → "2026-01-22". Null when unreadable. */
export function parseUkDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  const y = parseInt(m[3], 10);
  if (!month || d < 1 || d > 31 || !Number.isFinite(y)) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "October 1988" → { month: 10, year: 1988 }. */
function parseBirthDate(raw: string | null): { month: number | null; year: number | null } {
  if (!raw) return { month: null, year: null };
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 2) {
    const month = MONTHS[parts[0].toLowerCase()] ?? null;
    const year = parseInt(parts[1], 10);
    if (month && Number.isFinite(year)) return { month, year };
    // "1988 October" — same shape, reversed.
    const month2 = MONTHS[parts[1].toLowerCase()] ?? null;
    const year2 = parseInt(parts[0], 10);
    if (month2 && Number.isFinite(year2)) return { month: month2, year: year2 };
  }
  const yearOnly = parseInt(raw.trim(), 10);
  if (Number.isFinite(yearOnly) && yearOnly > 1900 && yearOnly < 2200) {
    return { month: null, year: yearOnly };
  }
  return { month: null, year: null };
}

function parseStatus(raw: string | null): BoStatus {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("active")) return "active";
  if (s.includes("ceased") || s.includes("withdrawn")) return "ceased";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Public-page route
// ---------------------------------------------------------------------------

function companyNameFromHtml(html: string): string {
  const h1 = html.match(/<h1[^>]*class="heading-xlarge"[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const name = textOf(h1[1]);
    if (name !== "") return name;
  }
  const title = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (title) {
    const cleaned = textOf(title[1])
      .replace(/\s*persons with significant control\s*-\s*Find and update company information\s*-\s*GOV\.UK\s*$/i, "")
      .trim();
    if (cleaned !== "" && cleaned !== "GOV.UK") return cleaned;
  }
  throw new Error(
    "Could not read the company name off the Companies House page — the page " +
      "structure has changed and the parser refuses to guess."
  );
}

/** Index numbers present on the page, from both owner and statement ids. */
function blockIndices(html: string): number[] {
  const set = new Set<number>();
  const re = /id="psc-(?:name|statement-label)-(\d+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) set.add(parseInt(m[1], 10));
  return [...set].sort((a, b) => a - b);
}

export function parsePscHtml(html: string, companyNumber: string): CompanyPsc {
  const companyName = companyNameFromHtml(html);
  const owners: BeneficialOwner[] = [];
  const statements: PscStatement[] = [];

  for (const n of blockIndices(html)) {
    const statementLabel = fieldById(html, `psc-statement-label-${n}`);
    if (statementLabel && /statement/i.test(statementLabel)) {
      statements.push({
        text: fieldById(html, `psc-statement-${n}`) ?? "",
        status: parseStatus(fieldById(html, `statement-status-tag-${n}`)),
        notifiedOn: parseUkDate(fieldById(html, `psc-statement-notified-on-${n}`)),
        ceasedOn: parseUkDate(fieldById(html, `psc-statement-ceased-on-${n}`)),
      });
      continue;
    }

    const name = fieldById(html, `psc-name-${n}`);
    if (!name) continue; // neither an owner nor a statement — nothing to record

    const dob = parseBirthDate(fieldById(html, `psc-date-of-birth-${n}`));
    const nationality = fieldById(html, `psc-nationality-${n}`);
    const legalForm = fieldById(html, `psc-legal-form-${n}`);
    const placeRegistered = fieldById(html, `psc-place-registered-${n}`);

    let kind: BoKind = "unknown";
    if (dob.year !== null || nationality !== null) kind = "individual";
    else if (legalForm !== null || placeRegistered !== null) kind = "corporate";

    owners.push({
      kind,
      name,
      status: parseStatus(fieldById(html, `psc-status-tag-${n}`)),
      notifiedOn: parseUkDate(fieldById(html, `psc-notified-on-${n}`)),
      ceasedOn: parseUkDate(fieldById(html, `psc-ceased-on-${n}`)),
      nationality,
      countryOfResidence: fieldById(html, `psc-country-of-residence-${n}`),
      birthMonth: dob.month,
      birthYear: dob.year,
      natureOfControl: allByPrefix(html, `psc-noc-${n}-`),
      correspondenceAddress: fieldById(html, `psc-address-value-${n}`),
    });
  }

  return {
    companyNumber,
    companyName,
    publicUrl: pscPublicUrl(companyNumber),
    owners,
    statements,
    provider: "companies-house-public-page",
  };
}

// ---------------------------------------------------------------------------
// API route (used only when COMPANIES_HOUSE_KEY is present)
// ---------------------------------------------------------------------------

interface ApiItem {
  kind?: string;
  name?: string;
  name_elements?: { title?: string; forename?: string; middle_name?: string; surname?: string };
  nationality?: string;
  country_of_residence?: string;
  date_of_birth?: { month?: number; year?: number };
  notified_on?: string;
  ceased_on?: string;
  natures_of_control?: string[];
  address?: Record<string, string>;
  statement?: string | string[];
}

function apiName(item: ApiItem): string | null {
  if (item.name && item.name.trim() !== "") return item.name.trim();
  const e = item.name_elements;
  if (!e) return null;
  const parts = [e.title, e.forename, e.middle_name, e.surname].filter(
    (p) => p && p.trim() !== ""
  );
  return parts.length > 0 ? parts.join(" ").trim() : null;
}

function apiKind(item: ApiItem): BoKind {
  const kind = (item.kind ?? "").toLowerCase();
  if (kind.startsWith("individual")) return "individual";
  if (kind.startsWith("corporate")) return "corporate";
  if (kind.startsWith("legal-person")) return "legal-person";
  return "unknown";
}

function apiAddress(item: ApiItem): string | null {
  const a = item.address;
  if (!a) return null;
  const parts = [
    a.premises, a.address_line_1, a.address_line_2, a.locality,
    a.region, a.postal_code, a.country,
  ].filter((p) => p && p.trim() !== "");
  return parts.length > 0 ? parts.join(", ") : null;
}

function parsePscApi(json: unknown, companyNumber: string, companyName: string): CompanyPsc {
  const root = json as { items?: ApiItem[] } | null;
  if (!root || !Array.isArray(root.items)) {
    throw new Error(
      "Companies House API response has no `items` array — refusing to guess at " +
        `a different shape. Raw: ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  const owners: BeneficialOwner[] = [];
  const statements: PscStatement[] = [];

  for (const item of root.items) {
    const kind = (item.kind ?? "").toLowerCase();
    if (kind.includes("statement")) {
      const text = Array.isArray(item.statement)
        ? item.statement.join(" ")
        : (item.statement ?? "");
      statements.push({
        text,
        status: item.ceased_on ? "ceased" : "active",
        notifiedOn: item.notified_on ?? null,
        ceasedOn: item.ceased_on ?? null,
      });
      continue;
    }

    const name = apiName(item);
    if (!name) {
      // An owner without a name cannot be cited or shown; skip rather than
      // substituting a placeholder.
      console.warn("[companies-house] skipping an API item with no name");
      continue;
    }

    owners.push({
      kind: apiKind(item),
      name,
      status: item.ceased_on ? "ceased" : "active",
      notifiedOn: item.notified_on ?? null,
      ceasedOn: item.ceased_on ?? null,
      nationality: item.nationality ?? null,
      countryOfResidence: item.country_of_residence ?? null,
      birthMonth: item.date_of_birth?.month ?? null,
      birthYear: item.date_of_birth?.year ?? null,
      natureOfControl: item.natures_of_control ?? [],
      correspondenceAddress: apiAddress(item),
    });
  }

  return {
    companyNumber,
    companyName,
    publicUrl: pscPublicUrl(companyNumber),
    owners,
    statements,
    provider: "companies-house-api",
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Fetch the beneficial owners of a company (overseas entity or UK company).
 *
 * Throws on any non-2xx after retries — a missing or dissolved entity is an
 * error, not an empty owner list. Callers must not treat "no response" as
 * "no beneficial owner", which is exactly the confusion that lets a nominee
 * company look like a dead end.
 */
export async function fetchBeneficialOwners(companyNumber: string): Promise<CompanyPsc> {
  loadLocalEnv();
  const key = process.env.COMPANIES_HOUSE_KEY?.trim();
  const publicUrl = pscPublicUrl(companyNumber);

  if (key) {
    const res = await politeFetch(
      `${API_HOST}/company/${encodeURIComponent(companyNumber)}/persons-with-significant-control`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
          Accept: "application/json",
        },
      }
    );
    const json = (await res.json()) as unknown;
    // The API does not return the company name on the PSC endpoint, so read it
    // from the profile endpoint to keep labels human-readable.
    let companyName = companyNumber;
    try {
      const profileRes = await politeFetch(
        `${API_HOST}/company/${encodeURIComponent(companyNumber)}`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
            Accept: "application/json",
          },
        }
      );
      const profile = (await profileRes.json()) as { company_name?: string };
      if (profile.company_name) companyName = profile.company_name;
    } catch {
      // A missing label is not a missing chain — fall back to the number.
    }
    return parsePscApi(json, companyNumber, companyName);
  }

  const res = await politeFetch(publicUrl, { headers: { Accept: "text/html" } });
  return parsePscHtml(await res.text(), companyNumber);
}

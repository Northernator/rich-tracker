/**
 * GNews — billionaire news → `events` rows with real article citations.
 *
 * Role: feed the events pipeline with published articles. The citation stored
 * on each row is the publisher's article URL, not GNews data — GNews is the
 * finder, the article is the source.
 *
 * Key: required (`GNEWS_API_KEY`, free signup). Free tier is 100 requests/day
 * (raise GNEWS_DAILY_LIMIT only if the plan allows it). The budget throws when
 * exhausted — a skipped news run must be visible, never an empty "no news".
 *
 * Endpoint shape (published docs, https://gnews.io/docs/v4):
 *   GET https://gnews.io/api/v4/search?q=<q>&lang=en&max=10&apikey=<KEY>
 *   → {"totalArticles":N,"articles":[{"title","description","content","url",
 *      "image","publishedAt","source":{"name","url"}}]}
 *
 * The API key travels in the query string (GNews's design, not ours), so the
 * request URL is NEVER logged — logs carry the query text only.
 */
import { politeFetch } from "../http";

const SEARCH_URL = "https://gnews.io/api/v4/search";
const HEADLINES_URL = "https://gnews.io/api/v4/top-headlines";
export const GNEWS_DOC_URL = "https://gnews.io/docs/v4";

/** Free-tier ceiling. Overridable because paid tiers raise it. */
const DAILY_LIMIT = Number(process.env.GNEWS_DAILY_LIMIT ?? 100);

let budgetDay = "";
let budgetUsed = 0;

/**
 * A throttle must never look like a quiet news day. If the daily budget is
 * gone this throws, so a skipped run is visible instead of silently reading
 * as "nothing happened".
 */
function takeBudget(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    budgetUsed = 0;
  }
  if (budgetUsed >= DAILY_LIMIT) {
    throw new Error(
      `GNews daily request budget exhausted (${budgetUsed}/${DAILY_LIMIT} on ` +
        `${budgetDay}). Raise GNEWS_DAILY_LIMIT only if the plan allows it.`
    );
  }
  budgetUsed++;
}

export function _budgetState(): { day: string; used: number; limit: number } {
  return { day: budgetDay, used: budgetUsed, limit: DAILY_LIMIT };
}

function requireKey(): string {
  const key = process.env.GNEWS_API_KEY;
  if (!key) {
    throw new Error(
      "GNEWS_API_KEY not set — sign up free at https://gnews.io/register and set it in .env.local"
    );
  }
  return key;
}

export interface NewsArticle {
  title: string;
  description: string | null;
  url: string;
  image: string | null;
  publishedAt: string;
  sourceName: string;
  sourceUrl: string | null;
}

interface SearchResponse {
  totalArticles?: unknown;
  articles?: unknown;
  errors?: unknown;
}

function assertHttpUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`GNews returned an unresolvable URL for ${label}: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`GNews returned a non-HTTP URL for ${label}: ${url}`);
  }
}

function parseArticles(json: SearchResponse, query: string): NewsArticle[] {
  if (typeof json.totalArticles !== "number" || !Array.isArray(json.articles)) {
    throw new Error(
      `GNews answered "${query}" with an unexpected shape ` +
        `(keys: ${Object.keys(json).join(", ")}) — refusing to parse`
    );
  }
  const out: NewsArticle[] = [];
  let skipped = 0;
  for (const raw of json.articles) {
    const a = raw as Record<string, unknown>;
    const title = typeof a.title === "string" ? a.title.trim() : "";
    const url = typeof a.url === "string" ? a.url.trim() : "";
    const publishedAt = typeof a.publishedAt === "string" ? a.publishedAt : "";
    // No URL = no citation = no row. No date = cannot place it in time.
    // Either is a skip, counted and reported, never a stored guess.
    if (!title || !url || !publishedAt) {
      skipped++;
      continue;
    }
    const ms = Date.parse(publishedAt);
    if (!Number.isFinite(ms)) {
      skipped++;
      continue;
    }
    if (ms > Date.now() + 24 * 3600 * 1000) {
      skipped++;
      continue;
    }
    try {
      assertHttpUrl(url, title.slice(0, 60));
    } catch {
      skipped++;
      continue;
    }
    const source =
      a.source && typeof a.source === "object"
        ? (a.source as Record<string, unknown>)
        : {};
    out.push({
      title,
      description: typeof a.description === "string" ? a.description : null,
      url,
      image: typeof a.image === "string" ? a.image : null,
      publishedAt: new Date(ms).toISOString(),
      sourceName: typeof source.name === "string" ? source.name : "unknown",
      sourceUrl: typeof source.url === "string" ? source.url : null,
    });
  }
  if (skipped > 0) {
    console.warn(`  ! GNews "${query}": skipped ${skipped} article(s) with no citable URL/date`);
  }
  return out;
}

async function get(path: string, params: Record<string, string>, query: string): Promise<NewsArticle[]> {
  const key = requireKey();
  takeBudget();
  const qs = new URLSearchParams({ ...params, apikey: key }).toString();
  const res = await politeFetch(`${path}?${qs}`);
  const json = (await res.json()) as SearchResponse;
  console.log(`  GNews "${query}": ${json.totalArticles ?? "?"} total (budget ${budgetUsed}/${DAILY_LIMIT})`);
  return parseArticles(json, query);
}

export async function searchArticles(
  query: string,
  opts?: { max?: number; from?: string; to?: string; lang?: string }
): Promise<NewsArticle[]> {
  const params: Record<string, string> = {
    q: query,
    lang: opts?.lang ?? "en",
    max: String(opts?.max ?? 10),
    sortby: "publishedAt",
  };
  if (opts?.from) params.from = opts.from;
  if (opts?.to) params.to = opts.to;
  return get(SEARCH_URL, params, query);
}

export async function topHeadlines(
  category = "business",
  max = 10
): Promise<NewsArticle[]> {
  return get(
    HEADLINES_URL,
    { category, lang: "en", max: String(max) },
    `top-headlines:${category}`
  );
}

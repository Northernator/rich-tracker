/**
 * politeFetch — single outbound fetch used by every external call.
 *
 * - Sets User-Agent: RichTracker/1.0 (taylorc697@gmail.com) on all requests
 * - Per-host token-bucket (sliding-window) rate limiting
 *   - data.sec.gov / www.sec.gov : 8/sec
 *   - api.company-information.service.gov.uk : 550 per 5 min
 *   - everything else : 2/sec
 * - Retries only on 429/5xx, exponential backoff, max 4 attempts
 * - Throws on non-2xx after retries. Never returns a fallback value.
 */

const SEC_UA =
  process.env.SEC_USER_AGENT ?? "RichTracker/1.0 (taylorc697@gmail.com)";
const DEFAULT_UA = "RichTracker/1.0 (taylorc697@gmail.com)";
const USER_AGENT = SEC_UA || DEFAULT_UA;

type HostConfig = { limit: number; windowMs: number };

const SEC_CONFIG: HostConfig = { limit: 8, windowMs: 1000 };
const COMPANIES_HOUSE_CONFIG: HostConfig = { limit: 550, windowMs: 5 * 60 * 1000 };
const DEFAULT_CONFIG: HostConfig = { limit: 2, windowMs: 1000 };

function getHostConfig(hostname: string): HostConfig {
  const h = hostname.toLowerCase();
  if (h === "www.sec.gov" || h === "data.sec.gov" || h.endsWith(".sec.gov")) {
    return SEC_CONFIG;
  }
  if (h === "api.company-information.service.gov.uk") {
    return COMPANIES_HOUSE_CONFIG;
  }
  return DEFAULT_CONFIG;
}

// Sliding-window timestamps per host
const hostTimestamps = new Map<string, number[]>();

async function throttle(hostname: string): Promise<void> {
  const config = getHostConfig(hostname);
  let queue = hostTimestamps.get(hostname);
  if (!queue) {
    queue = [];
    hostTimestamps.set(hostname, queue);
  }

  while (true) {
    const now = Date.now();
    // prune outside window
    while (queue.length > 0 && queue[0] <= now - config.windowMs) {
      queue.shift();
    }
    if (queue.length < config.limit) {
      queue.push(now);
      return;
    }
    const oldest = queue[0];
    const waitMs = oldest + config.windowMs - now + 5;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface PoliteFetchOptions extends RequestInit {
  /** Override User-Agent (defaults to RichTracker UA) */
  userAgent?: string;
}

export async function politeFetch(
  url: string,
  opts: PoliteFetchOptions = {}
): Promise<Response> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  const { userAgent, headers: inputHeaders, ...rest } = opts;

  const ua = userAgent ?? USER_AGENT;

  // Merge headers, ensuring User-Agent is set
  const headers = new Headers(inputHeaders as HeadersInit | undefined);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", ua);
  }

  let lastError: unknown = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    await throttle(hostname);

    let res: Response;
    try {
      res = await fetch(url, { ...rest, headers });
    } catch (err) {
      // Network error — retry as if 5xx (honour max attempts)
      lastError = err;
      if (attempt < 4) {
        const backoff = 500 * Math.pow(2, attempt - 1) + Math.random() * 100;
        await sleep(backoff);
        continue;
      }
      throw new Error(
        `politeFetch failed after ${attempt} attempts for ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (res.ok) {
      return res;
    }

    lastResponse = res;

    const isRetryable = res.status === 429 || res.status >= 500;
    if (isRetryable && attempt < 4) {
      const backoff = 500 * Math.pow(2, attempt - 1) + Math.random() * 100;
      // Respect Retry-After if present
      const retryAfter = res.headers.get("retry-after");
      let waitMs = backoff;
      if (retryAfter) {
        const sec = parseInt(retryAfter, 10);
        if (Number.isFinite(sec)) waitMs = Math.max(waitMs, sec * 1000);
      }
      await sleep(waitMs);
      continue;
    }

    // Non-retryable or exhausted
    const body = await res.text().catch(() => "");
    const snippet = body.slice(0, 500);
    throw new Error(
      `politeFetch failed: HTTP ${res.status} ${res.statusText} for ${url}${snippet ? ` — ${snippet}` : ""}`
    );
  }

  // Should not reach here
  if (lastResponse) {
    throw new Error(
      `politeFetch failed after 4 attempts: HTTP ${lastResponse.status} for ${url}`
    );
  }
  throw new Error(
    `politeFetch failed after 4 attempts for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

/** For testing: clear rate-limit state */
export function _resetRateLimitState(): void {
  hostTimestamps.clear();
}

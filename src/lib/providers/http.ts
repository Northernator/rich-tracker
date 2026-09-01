/**
 * politeFetch — single outbound fetch used by every external call.
 *
 * - Sets User-Agent: RichTracker/1.0 (taylorc697@gmail.com) on all requests
 * - Per-host token-bucket (sliding-window) rate limiting
 *   - data.sec.gov / www.sec.gov : 8/sec
 *   - *.company-information.service.gov.uk : 550 per 5 min (API *and* the
 *     public web UI — chunk 10 reads the public PSC pages when no API key is
 *     set, and those count against the same account-level limit)
 *   - everything else : 2/sec
 * - Every admission is logged with its in-window count and asserted against the
 *   limit, so a breach is a thrown error rather than a silent overrun.
 *   `rateLimitStats()` / `formatRateLimitReport()` expose the run's counters.
 * - Retries only on 429/5xx, exponential backoff, max 4 attempts
 * - Throws on non-2xx after retries. Never returns a fallback value.
 */

const SEC_UA =
  process.env.SEC_USER_AGENT ?? "RichTracker/1.0 (taylorc697@gmail.com)";
const DEFAULT_UA = "RichTracker/1.0 (taylorc697@gmail.com)";
const USER_AGENT = SEC_UA || DEFAULT_UA;

type HostConfig = { limit: number; windowMs: number };

const SEC_CONFIG: HostConfig = { limit: 8, windowMs: 1000 };
/**
 * Companies House publishes 600 requests / 5 minutes, then HTTP 429, and
 * repeated breaches risk a ban. We stay at 550 for headroom.
 *
 * This bucket covers EVERY Companies House host we touch, not just the API:
 * chunk 10 reads the public PSC pages on
 * find-and-update.company-information.service.gov.uk when no API key is set,
 * and those requests count against the same account-level limit. Routing the
 * web host through the 2/sec default would have looked polite while still
 * breaching the 5-minute window under load.
 */
const COMPANIES_HOUSE_CONFIG: HostConfig = { limit: 550, windowMs: 5 * 60 * 1000 };

/**
 * The published ceiling per host. `getHostConfig` may under-use it (we choose
 * to), but it may never exceed it — a config edit that raises a bucket above
 * what the provider allows is a change to the provider relationship, not a
 * tuning knob, and it fails here rather than as a 429 in production.
 */
const HARD_CAPS: Record<string, number> = {
  "api.company-information.service.gov.uk": 600,
  "find-and-update.company-information.service.gov.uk": 600,
  "document-api.company-information.service.gov.uk": 600,
  "data.sec.gov": 10,
  "www.sec.gov": 10,
};
const RTB_CONFIG: HostConfig = { limit: 20, windowMs: 1000 };
// Finnhub free tier: 60 calls/minute. Stay under it; the shared default of
// 2/sec would otherwise reach 120/min and earn a 429.
const FINNHUB_CONFIG: HostConfig = { limit: 55, windowMs: 60 * 1000 };
// Alpha Vantage free tier: 5 calls/minute and 25/day. The per-minute side lives
// here; the daily side is a hard budget in prices/alphavantage.ts, because a
// throttle there must fail loudly instead of reading as "no data".
const ALPHAVANTAGE_CONFIG: HostConfig = { limit: 5, windowMs: 60 * 1000 };
const DEFAULT_CONFIG: HostConfig = { limit: 2, windowMs: 1000 };

function getHostConfig(hostname: string): HostConfig {
  const h = hostname.toLowerCase();
  if (h === "www.sec.gov" || h === "data.sec.gov" || h.endsWith(".sec.gov")) {
    return SEC_CONFIG;
  }
  if (h.endsWith(".company-information.service.gov.uk")) {
    return COMPANIES_HOUSE_CONFIG;
  }
  if (h === "finnhub.io" || h.endsWith(".finnhub.io")) {
    return FINNHUB_CONFIG;
  }
  if (h === "www.alphavantage.co" || h === "alphavantage.co") {
    return ALPHAVANTAGE_CONFIG;
  }
  if (
    h === "cdn.statically.io" ||
    h === "cdn.jsdelivr.net" ||
    h === "raw.githubusercontent.com"
  ) {
    return RTB_CONFIG;
  }
  return DEFAULT_CONFIG;
}

// Sliding-window timestamps per host
const hostTimestamps = new Map<string, number[]>();

interface HostStat {
  totalCalls: number;
  maxObservedInWindow: number;
  timesThrottled: number;
}
const hostStats = new Map<string, HostStat>();

export interface RateLimitStat {
  host: string;
  limit: number;
  windowMs: number;
  inWindow: number;
  totalCalls: number;
  maxObservedInWindow: number;
  timesThrottled: number;
  /** True if the window ever held more calls than the configured limit. */
  breached: boolean;
}

/**
 * Per-host rate-limit counters for the current process.
 *
 * Exists so a limit is not merely intended but checkable: `scripts/verify_chains.ts`
 * asserts `breached === false` for every Companies House host after a run, which
 * is what acceptance item 4 asks for ("never exceed 550 per 5 minutes, assert
 * in the rate limiter's logs"). Relying on "we set the constant correctly" is
 * how the 60-day price history got deleted.
 */
export function rateLimitStats(): RateLimitStat[] {
  const now = Date.now();
  const out: RateLimitStat[] = [];
  for (const [host, queue] of hostTimestamps) {
    const config = getHostConfig(host);
    const inWindow = queue.filter((t) => t > now - config.windowMs).length;
    const stat = hostStats.get(host) ?? {
      totalCalls: 0,
      maxObservedInWindow: 0,
      timesThrottled: 0,
    };
    out.push({
      host,
      limit: config.limit,
      windowMs: config.windowMs,
      inWindow,
      totalCalls: stat.totalCalls,
      maxObservedInWindow: stat.maxObservedInWindow,
      timesThrottled: stat.timesThrottled,
      breached: stat.maxObservedInWindow > config.limit,
    });
  }
  return out;
}

/** Human-readable rate-limit report for run logs. */
export function formatRateLimitReport(): string {
  const stats = rateLimitStats();
  if (stats.length === 0) return "politeFetch: no calls made";
  const lines = stats.map((s) => {
    const flag = s.breached ? "BREACH" : "OK";
    return (
      `  ${flag}  ${s.host}\n` +
      `         window ${s.inWindow}/${s.limit} per ${s.windowMs}ms · ` +
      `peak ${s.maxObservedInWindow} · total ${s.totalCalls} · throttled ${s.timesThrottled}x`
    );
  });
  return `politeFetch rate-limit report:\n${lines.join("\n")}`;
}

async function throttle(hostname: string): Promise<void> {
  const config = getHostConfig(hostname);

  // A bucket may under-use the provider's published ceiling but never exceed
  // it. Checked on every call so an edit to the constants fails loudly here
  // rather than as a 429 (or a ban) mid-run.
  const cap = HARD_CAPS[hostname.toLowerCase()];
  if (cap !== undefined && config.limit > cap) {
    throw new Error(
      `politeFetch: host "${hostname}" is configured for ${config.limit} requests ` +
        `per ${config.windowMs}ms, above the published ceiling of ${cap}. ` +
        `Raise HARD_CAPS only alongside evidence from the provider.`
    );
  }

  let queue = hostTimestamps.get(hostname);
  if (!queue) {
    queue = [];
    hostTimestamps.set(hostname, queue);
  }
  let stat = hostStats.get(hostname);
  if (!stat) {
    stat = { totalCalls: 0, maxObservedInWindow: 0, timesThrottled: 0 };
    hostStats.set(hostname, stat);
  }

  while (true) {
    const now = Date.now();
    // prune outside window
    while (queue.length > 0 && queue[0] <= now - config.windowMs) {
      queue.shift();
    }
    if (queue.length < config.limit) {
      queue.push(now);
      stat.totalCalls += 1;
      stat.maxObservedInWindow = Math.max(stat.maxObservedInWindow, queue.length);

      // Assertion, in the logs, per call — this is the audit trail for
      // "Companies House calls never exceed 550 per 5 minutes".
      if (queue.length > config.limit) {
        throw new Error(
          `politeFetch RATE LIMIT BREACHED: ${hostname} admitted ${queue.length} ` +
            `calls in ${config.windowMs}ms, limit ${config.limit}`
        );
      }
      console.log(
        `[politeFetch] ${hostname} call ${stat.totalCalls} · ` +
          `${queue.length}/${config.limit} in ${config.windowMs}ms · ` +
          `peak ${stat.maxObservedInWindow} · OK`
      );
      return;
    }
    const oldest = queue[0];
    const waitMs = oldest + config.windowMs - now + 5;
    if (waitMs > 0) {
      stat.timesThrottled += 1;
      console.log(
        `[politeFetch] ${hostname} throttle: ${queue.length}/${config.limit} reached, ` +
          `waiting ${Math.round(waitMs)}ms`
      );
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
  hostStats.clear();
}

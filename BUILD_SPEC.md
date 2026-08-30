# Rich Tracker — Build Specification
### Target: public launch · Budget: £0 for the build · Verified 2026-08-29

This is the complete remaining build, in 15 reviewable chunks. It is written to be handed to a coding agent **one chunk at a time**. Each chunk names the files, the SQL, the endpoints, the guardrails and a numbered acceptance checklist. Do not hand an agent more than one chunk at a time, and do not start the next chunk until the acceptance checklist passes.

---

## 0. Where the build actually is

Verified against `data/app.db` on 2026-08-29:

| Table | Rows | State |
|---|---|---|
| `people` | 89 | ⚠️ Synthetic roster — 32 are Russian, `primary_org` is NULL for all 89 |
| `baseline_estimates` | 89 | ⚠️ One source, hardcoded, `raw_path` is `forbes://…` (not a real file) |
| `securities` | 13 | ✅ Real — CIK, currency, outstanding_shares, source_url |
| `stock_snapshots` | 2,142 | ⚠️ Real data (63 days × 34 tickers) but from Yahoo's undocumented API |
| `equity_holdings` | 16 | ⚠️ Round invented numbers; citations point at 10-Ks, which don't state personal holdings |
| `pledge_holdings` | 7 | ❌ Fabricated since day one; one accession number is invented |
| `events` | 500 | ✅ Real — USGS quakes + SEC Form 4 insider sales |
| `event_impacts` | 5 | ✅ Real, benchmark-adjusted, reports null results honestly |
| `assets` | 0 | ✅ Empty and constrained (`source_url NOT NULL CHECK LIKE 'http%'`) |
| `ownership_links` | 0 | ✅ Empty and constrained |
| `fx_rates` | 0 | ✅ Cleared — the old rows held the wrong currency pairs |
| `valuation_snapshots` | — | ❌ Table does not exist |

**What works and must not be broken:** the events pipeline, the securities table, the globe rendering, and the constraints added in migration `0012`.

---

## 1. Data providers, verified

### 1.1 Free and licence-clean — use these freely

| Source | What for | Limits | Licence | Key needed |
|---|---|---|---|---|
| **SEC EDGAR** `data.sec.gov` | Form 3/4/5, 13D/G, 13F, DEF 14A | ~10 req/sec; descriptive `User-Agent` with contact email is **mandatory** or you get blocked | US public domain | No |
| **Wikidata** SPARQL | Net worth (`P2218`), identifiers, birth/death | Be polite; set a `User-Agent` | CC0 | No |
| **rtb-api** (`komed3/rtb-api`) | Billionaire roster + historical lists | Static files on `cdn.statically.io`; updated ~monthly | MIT | No |
| **UK Companies House** | PSC register (beneficial ownership) | **600 requests / 5 minutes**, then HTTP 429. Repeated breaches = ban | Open Government Licence | Free key |
| **UK Land Registry** Price Paid + Overseas Entities | Property ownership | Bulk download | OGL | No |
| **FAA Aircraft Registry** | Aircraft ownership by N-number | Bulk ZIP download | US public domain | No |
| **frankfurter.app** (ECB rates) | FX | None published | ECB reference rates, free reuse | No |
| **USGS Earthquakes** | Event feed | None published | US public domain | No |
| **NASA FIRMS** | Fire events | Generous | US public domain | Free key |
| **CelesTrak** | Satellite TLEs | Be polite | Free reuse | No |
| **OpenSky Network** | Live flights | **OAuth2 client-credentials only** (basic auth removed). Anonymous: 400 credits/day. Registered free: 4,000 credits/day, 1h lookback | Own terms | Free account |
| **Launch Library 2** | Rocket launches | Free tier rate-limited | Free reuse | No |
| **ICIJ Offshore Leaks** | Offshore entity graph | Bulk download | ODbL — attribution + share-alike | No |
| **ProPublica Nonprofit Explorer** | Form 990-PF | Be polite | Free reuse | No |

### 1.2 Market data — read this before writing any code

**There is no free market-data tier that permits public display.** Verified:

| Provider | Free tier | Restriction | Cheapest paid |
|---|---|---|---|
| **Twelve Data** | 800 credits/day, 8/min | **"Internal non-display usage"** — explicitly bars public-facing use | Grow, $79/mo |
| **Polygon.io** (now at massive.com) | 5 calls/min, 2yr history, end-of-day | **"Individual use"** | Starter $29/mo — also marked Individual use |
| **Alpha Vantage** | **25 requests/day** | Too small regardless — 34 tickers exceeds it in one run | $49.99/mo (75 req/min) |
| **Yahoo Finance** (current source) | Undocumented endpoint | No licence; ToS prohibits redistribution. **Fine privately, not for launch** | n/a |
| **Finnhub** | 60 calls/min | Terms could not be verified from their site — **must be confirmed in writing before launch** | Verify |

**The decision this forces:**

- **During the build (now → chunk 14): stay on a free tier.** It is a private local app; nothing is published. Yahoo can remain until chunk 4 swaps it for an adapter.
- **At launch: budget $29–79/month for a display-licensed market-data plan.** This is the only unavoidable cost in the whole project. Everything else on this page is free forever.
- Because of that, **chunk 4 builds a provider adapter**, so switching provider is a config change and not a rewrite. Do not scatter `fetch()` calls to a price API through the codebase.

### 1.3 Hosting

SQLite on disk means **Vercel cannot host this** — its filesystem is ephemeral. Options, cheapest first: a small VPS with a persistent disk (Hetzner/Netcup, roughly £4–6/mo), Fly.io with a volume, or migrating to **Turso** (hosted libSQL, same SQL, has a free tier). Verify current limits and prices at launch — they change. Decide in chunk 15, not before.

---

## 2. Standing rules — the agent must re-read these at the start of every chunk

These are also in `CLAUDE.md` and `AGENTS.md`. They exist because fabricated data has been introduced into this project **four separate times**, each round better disguised than the last.

1. **Never generate placeholder, synthetic or example data** for any table representing real-world facts. Not for testing, not for demos, not "temporarily".
2. **If a source fails, throw.** Never `catch` and substitute invented values. Never write an invented payload into `data/raw/` — that directory is the audit trail.
3. **Every claims-table row carries a resolvable `source_url`** that opens a document supporting *that specific claim*. A 10-K does not evidence an individual's shareholding. A sentence like "County Assessor confirms ownership" is a description, not a citation.
4. **Loaders are additive.** `INSERT OR IGNORE` / `onConflictDoNothing` on a natural key. Never `DELETE` then reload — that destroyed 60 days of real price history once already.
5. **No silent unit or currency assumptions.** A column named `_cents` holds cents. An unknown currency is an error, not USD.
6. **Sanity-check before insert** using `src/lib/db/sanity.ts`. A personal holding cannot exceed outstanding shares; verified liquid cannot exceed baseline net worth.
7. **An empty table is a valid, honest result.** Shipping zero rows beats shipping invented ones.
8. **Never scrape Forbes or Bloomberg**, and never attribute data to them that did not come from them.

**Definition of done for every chunk:** the acceptance checklist passes, `npm run lint` is clean, every page still renders, and `git commit` has been run.

---

## 3. The chunk template

Every chunk below follows the same shape. When you hand one to an agent, hand the whole section plus section 2.

---

# PHASE 0 — Foundations

## Chunk 1 — Provider adapter + secrets + source registry

**Goal:** one place that knows how to call every external source, so the market-data swap at launch is a config change.

**Provider:** none (refactor). **Cost:** £0.

### Files to create

```
src/lib/providers/types.ts        # shared interfaces
src/lib/providers/registry.ts     # name -> adapter, chosen by env var
src/lib/providers/prices/yahoo.ts       # existing behaviour, moved
src/lib/providers/prices/finnhub.ts     # stub that throws "not configured"
src/lib/providers/fx/frankfurter.ts
src/lib/providers/http.ts         # shared fetch with User-Agent, retry, rate limit
.env.local.example
```

### `src/lib/providers/types.ts`

```ts
export interface DailyBar { asOf: string; ticker: string; priceCents: number; currency: string; }
export interface PriceProvider {
  readonly name: string;
  readonly licence: "display-permitted" | "internal-only" | "unlicensed";
  dailyBars(ticker: string, fromISO: string, toISO: string): Promise<DailyBar[]>;
  latest(tickers: string[]): Promise<DailyBar[]>;
}
export interface FxProvider {
  readonly name: string;
  ratesToUsd(asOfISO?: string): Promise<Record<string, number>>; // 1 unit of key = N USD
}
```

The `licence` field is not decoration. Chunk 14 refuses to build for production when the active price provider is not `display-permitted`.

### `src/lib/providers/http.ts` — required behaviour

- A single `politeFetch(url, opts)` used by **every** outbound call.
- Sets `User-Agent: RichTracker/1.0 (taylorc697@gmail.com)` on all requests.
- Per-host token-bucket rate limiting. Configure: `data.sec.gov` 8/sec, `api.company-information.service.gov.uk` 550 per 5 min, everything else 2/sec.
- Retries only on 429/5xx, exponential backoff, max 4 attempts.
- **Throws on non-2xx after retries. Never returns a fallback value.**

### Env

```
PRICE_PROVIDER=yahoo          # yahoo | finnhub | alphavantage
FINNHUB_API_KEY=
COMPANIES_HOUSE_KEY=
SEC_USER_AGENT=RichTracker/1.0 (taylorc697@gmail.com)
```

### Acceptance checklist

1. `grep -rn "fetch(" src/lib/db/ src/app/` returns **no** direct calls to an external host — everything routes through `politeFetch`.
2. `PRICE_PROVIDER=finnhub npm run prices` fails with a clear "FINNHUB_API_KEY not set" error, not a crash and not silent fallback data.
3. Setting `PRICE_PROVIDER` to an unknown value throws at startup naming the valid options.
4. Every page still renders.
5. Committed.

**Review gate:** open `src/lib/providers/registry.ts` and confirm you could add a new provider by writing one file and adding one line.

---

## Chunk 2 — Replace the synthetic roster with the real one

**Goal:** the 89 people become a real, sourced list. This is the highest-value chunk in the document; almost everything downstream is wrong while the roster is invented.

**Provider:** rtb-api (MIT). **Cost:** £0.

### The endpoint (the current code has it wrong)

```
BASE = https://cdn.statically.io/gh/komed3/rtb-api/main/api
GET  {BASE}/list/rtb/latest          -> current real-time list (JSON)
GET  {BASE}/list/rtb/{YYYY-MM-DD}    -> historical list
GET  {BASE}/profile/{uri}/info       -> name, country, org, birth year
GET  {BASE}/profile/{uri}/latest     -> current rank + net worth
```

The existing loader calls `https://rtb-api.komed.dev/v1/list`, which does not exist. That failure is what produced the synthetic roster in the first place.

### Raw capture — mandatory

For every fetch, write **two** files:

```
data/raw/rtb/<YYYY-MM-DD>/list.json        # response bytes, unmodified
data/raw/rtb/<YYYY-MM-DD>/list.meta.json   # { url, http_status, fetched_at, sha256, bytes }
```

The loader must **refuse to read any raw file that has no sibling `.meta.json` recording `http_status: 200`.** This is what stops a fabricated file ever masquerading as a capture again.

### Loader rewrite: `src/lib/db/load_slice1.ts`

Delete `generateSyntheticData()` entirely — the whole function, not just the call site. Then:

```ts
async function fetchRtbList(): Promise<RtbItem[]> {
  const url = `${RTB_BASE}/list/rtb/latest`;
  const res = await politeFetch(url);
  if (!res.ok) throw new Error(`rtb-api ${res.status} from ${url} — aborting, no fallback`);
  const body = await res.text();
  writeRawCapture("rtb", "list", url, res.status, body);
  return JSON.parse(body);
}
```

Upsert rules:
- Match existing people by `slug` first, then by exact `full_name`. Do not create duplicates.
- Set `country`, `primary_org`, `born_year` from the profile endpoint.
- `raw_path` = the real path under `data/raw/`. The `forbes://` scheme must not appear anywhere.
- Insert a **new** `baseline_estimates` row per run; never update an existing one.
- Register the source properly: `sources.id = 'rtb-api'`, `url = 'https://github.com/komed3/rtb-api'`, `licence = 'MIT'`, `attribution = 'komed3/rtb-api (MIT), derived from Forbes real-time list'`.

### Removing the synthetic people

People who exist only because of the old fallback must go. Write `scripts/prune_unsourced_people.mjs`:

```sql
-- anyone with no baseline_estimate whose raw_path points at a verified capture
DELETE FROM baseline_estimates WHERE raw_path IS NULL OR raw_path NOT LIKE 'data/raw/%';
DELETE FROM people WHERE id NOT IN (SELECT DISTINCT person_id FROM baseline_estimates);
```

Back up first (`db.backup()`), print before/after counts.

### Acceptance checklist

1. `SELECT COUNT(*) FROM people` returns a number you can reconcile against the published list.
2. `SELECT DISTINCT raw_path FROM baseline_estimates` shows only paths under `data/raw/` — **no `forbes://`**.
3. Every path in (2) exists on disk and has a `.meta.json` with `http_status: 200`.
4. `SELECT country, COUNT(*) FROM people GROUP BY 1 ORDER BY 2 DESC` is plausible (USA largest, China and India substantial, Russia a modest share — **not 36%**).
5. `SELECT COUNT(*) FROM people WHERE primary_org IS NULL` is near zero.
6. No person on the list is deceased. Spot-check the top 20 by hand.
7. Deliberately break the URL → the loader **throws**; the database is unchanged.
8. Committed.

**Review gate:** load `/` and read the top 20 names aloud. If any name makes you pause, stop and investigate before continuing.

---

# PHASE 1 — The honest number

## Chunk 3 — A second independent source

**Goal:** the consensus band, the spread sort and the confidence tiers start doing something. With one source they are inert and every row is correctly-but-uselessly "Low".

**Provider:** Wikidata SPARQL (CC0). **Cost:** £0.

### Query

```sparql
SELECT ?person ?personLabel ?netWorth ?currency ?pointInTime ?ref WHERE {
  ?person wdt:P2218 ?netWorth .
  ?person p:P2218 ?stmt .
  ?stmt psv:P2218 ?valueNode .
  ?valueNode wikibase:quantityUnit ?currency .
  OPTIONAL { ?stmt pq:P585 ?pointInTime . }
  OPTIONAL { ?stmt prov:wasDerivedFrom/pr:P854 ?ref . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
```

Endpoint `https://query.wikidata.org/sparql`, `Accept: application/sparql-results+json`, descriptive `User-Agent`.

### Matching people — do this carefully

Do **not** match on name string alone. Match in this order, and record which rule fired in `baseline_estimates.raw`:

1. Wikidata QID already stored in `people.aliases`.
2. Exact `full_name` **and** matching `born_year`.
3. Exact `full_name` and matching `country`.
4. Otherwise **skip and log**. A wrong match is worse than a missing one.

Store the QID back into `people.aliases` so subsequent runs use rule 1.

### Notes

- `P2218` values carry a currency unit. Convert via `fx_rates` (chunk 5). If no rate exists for that day, **skip the row** — do not assume USD.
- Wikidata values are often stale. Store `pointInTime` as `as_of`; do not overwrite it with today.
- `sources` row: `id='wikidata'`, `licence='CC0'`, `attribution='Wikidata (CC0)'`.

### Acceptance checklist

1. ≥40 people have ≥2 independent estimates.
2. `/` shows a real range (`$X – $Y`) on those rows, not a single dot.
3. Confidence tiers now produce a mix of ●/◐/○ rather than all ○.
4. Sorting by spread surfaces genuinely disputed people, and the top of that list is interesting rather than noise.
5. Every skipped match is logged with a reason; the log has no silent drops.
6. Committed.

**Review gate:** pick the three widest spreads and confirm the disagreement is real by checking both sources by hand.

---

## Chunk 4 — Market-data adapter and the launch decision

**Goal:** prices come through a swappable adapter, and the app knows whether its current provider may legally be displayed publicly.

**Provider:** Yahoo now (private), display-licensed plan at launch. **Cost:** £0 now, $29–79/mo at launch.

### Work

1. Move the existing Yahoo logic into `src/lib/providers/prices/yahoo.ts` with `licence: "unlicensed"`.
2. Implement `finnhub.ts` fully (`/quote` and `/stock/candle`), `licence` set only after you have confirmed their terms **in writing**. Until then, `"unlicensed"`.
3. Add `alphavantage.ts` — useful as a cross-check even at 25 req/day.
4. Every provider returns `DailyBar` with an explicit `currency`. Never assume USD.
5. Store `stock_snapshots.source` as the provider name and add `stock_snapshots.licence` mirroring the adapter, so a row's provenance survives a provider switch.

### Backfill without destroying history

```ts
// INSERT OR IGNORE on (ticker, as_of). Never DELETE.
// Log "n new bars, m already present" — running twice must change nothing.
```

### Acceptance checklist

1. `PRICE_PROVIDER=yahoo npm run prices` then immediately again → second run inserts 0 rows.
2. Existing 2,142 rows are still present. `SELECT COUNT(*) FROM stock_snapshots` has not gone down.
3. `SELECT COUNT(DISTINCT ticker) FROM securities WHERE ticker NOT IN (SELECT ticker FROM stock_snapshots)` returns 0 — every security has prices. (Nine of sixteen equity rows currently render "no data"; this chunk fixes that.)
4. Switching `PRICE_PROVIDER` and re-running produces rows tagged with the new provider, and the old rows are untouched.
5. Committed.

**Review gate:** decide and write down, in `docs/LICENSING.md`, which provider you will pay for at launch and what it costs. This chunk is not done until that file exists.

---

## Chunk 5 — Currency, applied end to end

**Goal:** a EUR or INR holding is valued correctly. `fx_rates` is currently empty and no page reads it, so this bug is live the moment a non-USD price arrives.

**Provider:** frankfurter.app (ECB). **Cost:** £0.

### The bug that must not come back

The previous loader called `https://api.frankfurter.app/latest?symbols=INR,EUR,GBP`. **Frankfurter defaults to `base=EUR`.** So the response was EUR→INR / EUR→GBP / EUR→USD, and every row was stored as "`<currency>` → USD". EUR→INR (111.06) was written as INR→USD — which would inflate an Indian holding by roughly 12,000×.

Always pass `base=USD`, assert `data.base === "USD"` on the response, and invert: `1 unit of X = 1 / (USD→X) USD`.

### Schema

```sql
-- one row per currency PER DAY, so historical snapshots convert at the rate
-- that applied then
CREATE UNIQUE INDEX IF NOT EXISTS ux_fx_base_quote_date ON fx_rates (base, quote, as_of);
```

### Backfill

`https://api.frankfurter.app/{start}..{end}?base=USD&symbols=EUR,GBP,INR,JPY,CNY,HKD` returns a date-keyed series in one call. Backfill to match the earliest `stock_snapshots.as_of`.

### Wire it into the UI

`src/lib/money.ts`:

```ts
export function toUsdCents(amountCents: number, currency: string, asOf: string, rates: FxLookup): number {
  if (currency === "USD") return amountCents;
  const rate = rates.get(currency, asOf);      // must fall back to the most recent PRIOR date, never to 1
  if (rate == null) throw new Error(`No FX rate for ${currency} on or before ${asOf}`);
  return Math.round(amountCents * rate);
}
```

Use it in `/equity`, `/` and the globe. There must be no remaining path where a non-USD price is added to a USD total.

### Acceptance checklist

1. `SELECT * FROM fx_rates WHERE base='INR'` shows a rate around **0.011–0.012**, not 111. Sanity: 1 rupee is about one US cent.
2. `SELECT COUNT(DISTINCT as_of) FROM fx_rates` ≥ 60.
3. Arnault's MC.PA holding on `/equity` shows a plausible USD figure (EUR price × ~1.16).
4. Ambani's RELIANCE.NS figure is plausible — if it looks ~85× too big, the conversion is not being applied.
5. Delete a rate row and reload → the page shows an explicit error for that row, not a silently wrong number.
6. Committed.

**Review gate:** hand-calculate one non-USD holding on a calculator and match it to the screen.

---

## Chunk 6 — Persist the honest number

**Goal:** `valuation_snapshots` — the table the whole "show your working" thesis depends on, and the one still missing.

**Provider:** none. **Cost:** £0.

### Migration `0013_valuation_snapshots.sql`

```sql
CREATE TABLE valuation_snapshots (
  id                TEXT PRIMARY KEY,
  person_id         TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ts                TEXT NOT NULL,
  liquid_cents      INTEGER NOT NULL,
  baseline_cents    INTEGER NOT NULL,
  pledged_cents     INTEGER NOT NULL DEFAULT 0,
  verifiability     REAL,
  method_version    TEXT NOT NULL,
  inputs            TEXT NOT NULL CHECK (json_valid(inputs)),
  created_at        TEXT NOT NULL
);
CREATE INDEX ix_snap_person_ts ON valuation_snapshots (person_id, ts DESC);
CREATE UNIQUE INDEX ux_snap_person_ts_method ON valuation_snapshots (person_id, ts, method_version);
```

`inputs` must contain **every** number used: each `security_id`, share count, `price_cents`, `as_of`, FX rate, and the baseline row id. The test is simple — a person with the JSON and a calculator must be able to reproduce `liquid_cents` exactly.

`method_version` starts at `'v1'` and bumps whenever the formula changes. Never recompute old rows under a new version; insert new ones.

### Verifiability

```
verifiability = liquid_cents / baseline_cents
```

Do **not** clamp it in the data. Store the true value, including values above 1.0, and let the UI flag them — an impossible ratio is a signal that a share count or baseline is wrong, and hiding it hides the bug. The UI already renders `122%⚠` in red for exactly this case.

### `/methodology` page

Publish the formula, the current `method_version`, the version history, and what each source contributes. This page *is* the marketing — it is the thing no other tracker has.

### Acceptance checklist

1. `npm run snapshot` writes one row per person per run.
2. Pick any row; recompute `liquid_cents` by hand from `inputs`. It matches exactly.
3. Running twice in the same minute does not create duplicates.
4. `/` sparkline plots **wealth over time** from snapshots, not share price.
5. `/methodology` renders and matches the code.
6. Committed.

**Review gate:** ask someone unfamiliar with the project to read `/methodology` and explain back how a number is produced.

---

# PHASE 2 — Provenance

## Chunk 7 — Holdings from the filings that actually state them

**Goal:** replace the 16 invented share counts with filing-derived ones. Their current `source_url` values point at 10-K annual reports, which do not state any individual's shareholding — the citation does not support the claim.

**Provider:** SEC EDGAR (public domain). **Cost:** £0.

### Which filing says what — get this right

| Form | What it states | Use for |
|---|---|---|
| **Form 4** | `sharesOwnedFollowingTransaction` — exact post-transaction holding | ✅ Primary source. Start here. |
| **Form 3** | Initial statement of beneficial ownership | ✅ Baseline when no Form 4 exists |
| **Form 5** | Annual statement of deferred transactions | ✅ Supplement |
| **Schedule 13D/13G** | Anyone crossing 5% | ✅ Large non-insider holders |
| **13F-HR** | An *institutional manager's* portfolio | ⚠️ **Not a person's stake.** Attribute to the fund entity, never the individual |
| **10-K** | Company annual report | ❌ Does not state individual holdings. Never cite for a holding |

The previous build attributed Berkshire's entire 13F book to individuals, which is how Ballmer and Jim Walton ended up "holding" Berkshire's positions.

### Endpoints

```
GET https://data.sec.gov/submissions/CIK##########.json    # zero-padded to 10 digits
GET https://www.sec.gov/Archives/edgar/data/{cik}/{accession-no-dashes}/{file}
GET https://efts.sec.gov/LATEST/search-index?q=...&forms=4  # full-text search
```

`User-Agent` header is mandatory. Cap at 8 req/sec via `politeFetch`.

### Steps

1. **Populate `people.filing_cik` first.** The column exists and is empty. Resolve via EDGAR company search on the person's name; store only exact matches, log ambiguities for manual review. Nothing else in this chunk works until this is done.
2. Fetch the submissions JSON, filter `form == "4"`, take the most recent per (person, issuer).
3. Fetch the Form 4 XML. Parse `<nonDerivativeHolding>` / `<nonDerivativeTransaction>` and read **`sharesOwnedFollowingTransaction`** — *not* `transactionShares`. Reading the transaction line is why Bezos previously showed 230,637 AMZN shares.
4. Save every fetched document to `data/raw/sec/<cik>/<accession>.xml` plus `.meta.json`, and parse from disk.
5. Run `checkHolding()` from `src/lib/db/sanity.ts` before every insert. Rejections are skipped and logged — never clamped.
6. `INSERT OR IGNORE` on `(person_id, ticker, as_of)`.

### Non-US holders

Arnault, Ortega, Ambani, Adani have no SEC presence. Use AMF (France), CNMV (Spain), BSE/NSE (India) disclosures — or leave the holding out. **A missing holding is correct. An invented one is not.** Render "no verified holdings" in the UI.

### Acceptance checklist

1. Every row in `equity_holdings` has a `source_url` you can paste into a browser that opens a filing **stating that share count**.
2. `SELECT COUNT(*) FROM equity_holdings WHERE source_url LIKE '%10-k%' OR source_url LIKE '%10k%'` returns 0.
3. No person's holding exceeds 50% of `securities.outstanding_shares`.
4. `/` shows **no** verifiability above 100%. The `122%⚠` and `104%⚠` flags are gone because the underlying numbers are right, not because the flag was removed.
5. Buffett's row reflects his actual Berkshire holding, or is absent with "no verified holdings" — not 152,000 B shares.
6. Any 13F-derived row is attributed to a fund entity, not a person.
7. Rejected rows appear in the run log with reasons.
8. Committed.

**Review gate:** pick three holdings at random, open the `source_url`, and find the share count on the page. If you cannot find it, the row is not sourced.

---

## Chunk 8 — Pledged shares, from DEF 14A

**Goal:** rebuild the leverage feature. This is still the genuine differentiator — Bloomberg's figures make no assumption about personal debt at all — and it is still built on invented numbers.

**Provider:** SEC EDGAR. **Cost:** £0.

### First, delete what's there

All 7 rows are fabricated: the same round 130M/85M/45M numbers since day one, an invented accession (`wf-form4_171234567890456.xml`), and `evidence_text` that *describes* a filing rather than quoting it. Two rows cite 13F, which does not report individual pledges.

**Pledges are disclosed in the DEF 14A proxy statement**, in the beneficial-ownership table footnotes. Nowhere else.

### Pipeline

1. From `securities.cik`, fetch the company's most recent `DEF 14A` via the submissions API.
2. Save the document to `data/raw/sec/<cik>/<accession>.htm` + `.meta.json`.
3. Strip HTML to text. Index into SQLite **FTS5**:

```sql
CREATE VIRTUAL TABLE filings_fts USING fts5(accession_no UNINDEXED, cik UNINDEXED, body, tokenize='porter');
```

4. Query `body MATCH 'pledge OR pledged OR collateral'` with `snippet()` to pull the surrounding sentences.
5. Extract the share count from the matched sentence. An LLM call is fine here — but it must return `{ shares: number, person: string, verbatim_sentence: string }` and **the verbatim sentence must appear byte-for-byte in the document.** Verify that programmatically before inserting; if it doesn't match, reject.
6. Insert with `evidence_text` = the verbatim sentence and `source_url` = the filing index URL.

### Presentation rules — unchanged and non-negotiable

- Pledged shares are **collateral, not a dollar liability.** Loan size is almost never disclosed.
- **Never subtract them from net worth.** Surface separately: *"38% of this stake is pledged as loan collateral."*
- Render the quoted sentence next to the figure. **No sentence, no row.**

### Acceptance checklist

1. `SELECT COUNT(*) FROM pledge_holdings WHERE evidence_text NOT LIKE '%pledg%'` returns 0.
2. Every `evidence_text` is a full sentence found verbatim in the linked document — verify three by hand.
3. No `source_url` contains "13F" or "form4".
4. `/equity` shows the quoted sentence on hover or expand.
5. Net worth totals are unchanged by pledges — confirm arithmetically.
6. Committed.

**Review gate:** open one filing, use Ctrl-F on the quoted sentence, and confirm it is there.

---

# PHASE 3 — The graph

## Chunk 9 — Aircraft ownership from the FAA registry

**Goal:** the first genuinely sourced rows in the asset graph. Start with aircraft because the FAA publishes a complete bulk file — no scraping, no guessing.

**Provider:** FAA Aircraft Registry (US public domain). **Cost:** £0.

### Data

Download the releasable aircraft database ZIP from the FAA registry site. It contains `MASTER.txt` (N-number → registrant name/address, serial, type code) and `ACFTREF.txt` (type code → manufacturer/model). Extract to `data/raw/faa/<YYYY-MM-DD>/` with a `.meta.json`.

### The hard part — and be honest about it

Business jets are almost always registered to an **LLC or trust**, not to a person. So:

- Match registrant names against known corporate vehicles, not personal names.
- `confidence: 'high'` **only** when the registrant string contains the person's name or a company where they are the documented controlling owner.
- Everything else is `'medium'` or `'low'`, or excluded.
- If you cannot establish the link from public documents, **do not create the row.** The previous build invented tail numbers — `N177TS` on a Boeing 767 for Musk, a Boeing 747-8 for Bezos, and a "United Airlines A380" that never existed, since United has never operated the type.

### Insert shape

```
assets.name        = "Gulfstream G650ER"      -- the aircraft type
assets.location    = "N628TS"                  -- the tail number, unique
assets.source_url  = "https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=N628TS"
assets.estimated_value_cents = <market estimate in CENTS>   -- see below
ownership_links.citation   = "FAA MASTER.txt registrant: <exact registrant string>"
ownership_links.source_url = <same FAA URL>
```

**Units:** `estimated_value_cents` is **cents**. A $65M jet is `6500000000`. The CSV column is `estimated_value_usd` and the loader multiplies by 100. The previous build put dollars in the cents column and valued a Boeing 747-8 at $4M.

Leave `estimated_value_cents` NULL rather than guessing. A NULL renders as "value unknown", which is honest.

### Acceptance checklist

1. Every asset row's `source_url` opens an FAA record showing that tail number.
2. Every `ownership_links.citation` quotes the **exact registrant string** from `MASTER.txt`.
3. No two assets share a tail number (`ux_assets_identity` enforces this).
4. No asset has more than 2 owners. (The old fuzzy matcher put 17 billionaires on one house; chunk-9 code must match on `(person_slug, asset_name)` exactly.)
5. `/ownership` "Physical assets" total is plausible — tens to low hundreds of millions per jet, not $4M.
6. Deliberately remove a `source_url` from the CSV → the row is **skipped with a log line**, and the DB CHECK would reject it anyway.
7. Committed.

**Review gate:** pick two tail numbers, look them up on the FAA site yourself, confirm the registrant matches.

---

## Chunk 10 — Property from UK Land Registry and the Overseas Entities register

**Goal:** real property ownership where the registry is genuinely open. This is the best beneficial-ownership data in the world right now.

**Provider:** HM Land Registry (OGL), Companies House PSC (OGL, free key). **Cost:** £0.

### Sources

- **Price Paid Data** — every England/Wales sale since 1995, bulk CSV, OGL.
- **Register of Overseas Entities** — pierces foreign-company-held UK property.
- **Companies House PSC register** — People with Significant Control. Free API key. **600 requests / 5 minutes**, then 429; repeated breaches risk a ban, so route through `politeFetch` with a 550/5min bucket.

### Chain to build

```
property (Land Registry title)
   └─ owned by → company (Companies House number)
        └─ PSC → person
```

Every hop is a separate `entity_edges` row with its own `source_url` and `confidence`. Confidence multiplies along the path; anything below 0.5 renders as "possible link", never as fact.

### Scope

Cap at **15 people and 200 assets** for v1. Entity resolution has no natural finish line — this is the chunk most likely to sprawl.

### Acceptance checklist

1. Every property row links to a title or Price Paid record.
2. Every company→person hop links to a Companies House PSC page.
3. No US property is included yet — county assessors are chunk 11.
4. Companies House calls never exceed 550 per 5 minutes (assert in the rate limiter's logs).
5. An ownership chain renders on `/ownership` with a confidence and a working link on **every** hop.
6. Committed.

**Review gate:** follow one full chain — property → company → person — clicking each link. If any link 404s, the chain is not sourced.

---

## Chunk 11 — Entity resolution and the offshore layer

**Goal:** the moat. Link a shell company to a filing to an offshore entity to a person.

**Provider:** ICIJ Offshore Leaks (ODbL — attribution and share-alike required). **Cost:** £0.

### Work

1. Download the ICIJ bulk data. Load `nodes-entities`, `nodes-officers`, `relationships` into staging tables.
2. Match ICIJ officers to `people` using the same strict rules as chunk 3: identifier first, then name + birth year, then skip.
3. Recursive resolution with SQLite's `WITH RECURSIVE`:

```sql
WITH RECURSIVE chain(entity_id, person_id, depth, confidence, path) AS (
  SELECT e.id, e.person_id, 0, 1.0, e.name FROM entities e WHERE e.id = ?
  UNION ALL
  SELECT ed.to_entity, e2.person_id, c.depth + 1, c.confidence * ed.confidence,
         c.path || ' -> ' || e2.name
  FROM chain c
  JOIN entity_edges ed ON ed.from_entity = c.entity_id
  JOIN entities e2 ON e2.id = ed.to_entity
  WHERE c.depth < 6
)
SELECT * FROM chain WHERE person_id IS NOT NULL;
```

4. Cap depth at 6 and guard against cycles.

### ODbL obligations

Attribution on every page displaying ICIJ-derived data, and a note that ICIJ data does not imply wrongdoing. Add both to `/sources` in chunk 14.

### Acceptance checklist

1. At least 5 multi-hop chains resolve end to end.
2. Every chain shows a cumulative confidence, and chains below 0.5 are labelled "possible link".
3. Cycles do not hang the query — test with a deliberately circular edge.
4. ICIJ attribution and the no-wrongdoing note render wherever ICIJ data appears.
5. Committed.

---

# PHASE 4 — The demo

## Chunk 12 — Event → asset linking at scale

**Goal:** the 500 real events meet the now-real asset graph, with honest impact numbers.

**Provider:** USGS, NASA FIRMS, SEC (all free). **Cost:** £0.

### Proximity

R-tree bounding box prefilter, then haversine for exact distance:

```sql
CREATE VIRTUAL TABLE assets_rtree USING rtree(id_num, min_lat, max_lat, min_lon, max_lon);
CREATE TABLE assets_rtree_map (id_num INTEGER PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE);
```

Link threshold 500 km, stored in `event_asset_links.distance_km`.

### Impact, honestly

The existing `scripts/compute_event_impacts.ts` already does this well — keep its discipline:

- Always compute `excess_pct` = ticker move − benchmark move. A −2% move on a day the index fell 2% means nothing.
- `ticker` column holds tickers only. Per-ticker moves go in the note. (It previously held `"GOOGL-0.1%"`.)
- **Show null results.** *"M5.2, 210km from X. Owner has no public equity holdings. No detectable effect."* is a good output, not a failure.
- Never write causal language. Co-occurrence only.

### Also

Group the 271 near-identical Form 4 insider-sale rows by filing — `/events` currently renders them as 271 separate cards from a single 2022 filing day.

### Acceptance checklist

1. Every `event_impacts` row has a benchmark comparison or an explicit reason it doesn't.
2. `SELECT COUNT(*) FROM event_impacts WHERE ticker LIKE '%\%%' ESCAPE '\'` returns 0.
3. At least one prominent event honestly reports no detectable effect.
4. No impact note contains "caused", "cost him", or "because of".
5. `/events` groups multi-transaction filings into one card.
6. Committed.

---

## Chunk 13 — The globe, wired to real data

**Goal:** the asset and event layers render real, sourced rows.

**Provider:** none new. **Cost:** £0 (see the Google-tiles warning below).

### Work

1. Asset layer reads `physical_assets` with lat/lng, coloured by owner, sized by value. Assets with NULL value render at a fixed small size — never guess.
2. Owner hover card: name, live total, verifiability, pledge percentage.
3. "Follow the money" toggle dims anything not linked to a tracked person.
4. Fix the header count — it currently reads "99 tracked assets" while counting `ownership_links`, not `assets`.
5. Keep textures local in `public/textures/`. Do not reintroduce the `//unpkg.com` CDN reference; it breaks offline and is a third-party dependency on a local-first app.

### If you move to Cesium

Only worth it for terrain, satellite orbits or time-dynamic playback. Default to **Cesium World Terrain + OSM imagery** (free). Google Photorealistic 3D Tiles bill **per session** on metered Maps Platform billing — keep them behind a demo-only feature flag, and set a billing alert before you ever enable them.

### Acceptance checklist

1. Header counts match `SELECT COUNT(*) FROM assets`.
2. Clicking an asset opens that person's profile.
3. Legend lists only event types present in the data.
4. No external CDN requests in the network tab.
5. Committed.

---

# PHASE 5 — Launch

## Chunk 14 — Licensing, GDPR, attribution, and the build gate

**Goal:** everything that must be true before this is public. Do not skip any of it.

**Cost:** £0 except the market-data plan.

### The build gate

```ts
// next.config.ts or a prebuild script
if (process.env.NODE_ENV === "production" && priceProvider.licence !== "display-permitted") {
  throw new Error(
    `Price provider "${priceProvider.name}" is licensed "${priceProvider.licence}". ` +
    `Public display requires a display-permitted plan. See docs/LICENSING.md.`
  );
}
```

This makes the one unavoidable cost impossible to forget.

### UK GDPR

You are compiling personal financial profiles, which engages UK GDPR directly. Your cover is the journalistic / legitimate-interest lane Forbes and Bloomberg operate in — and it holds only if you stay disciplined:

- **`people.is_public_figure` must gate every person-facing query.** The column exists and, as of this writing, **nothing reads it.** Add it to every query and add a test that fails if a non-public-figure is ever returned.
- Publish a **Legitimate Interest Assessment** at `/privacy` — write it before launch, not after the first complaint.
- Provide a working correction/removal route. A visible "dispute this figure" link costs nothing and defuses most complaints.
- Never let the pipeline drift toward private individuals.
- Retain raw captures with a documented retention policy, but never delete a raw file that a `valuation_snapshots.inputs` row references.

### `/sources` page

One row per source with licence and attribution: rtb-api (MIT), Wikidata (CC0), Wikipedia (CC BY-SA), SEC (public domain), Companies House and Land Registry (OGL), NASA/USGS/FAA (public domain), ICIJ (ODbL, **share-alike**), ECB via frankfurter, and the market-data provider under its commercial terms.

### Not investment advice

Footer and terms, plainly. You cannot deliver that precision and claiming otherwise invites regulatory attention.

### Acceptance checklist

1. `NODE_ENV=production npm run build` **fails** while the price provider is unlicensed. Confirm it fails.
2. Every source on `/sources` has a licence and correct attribution.
3. A query for a non-public-figure returns nothing — test it.
4. `/privacy` contains the Legitimate Interest Assessment.
5. "Dispute this figure" works and routes somewhere you'll actually see.
6. No page claims a figure is a fact.
7. Committed.

**Review gate:** read `/` as a stranger. If any number looks more certain than it is, fix the copy.

---

## Chunk 15 — Deploy

**Goal:** live, with backups and monitoring.

**Cost:** hosting ~£4–6/mo VPS, or a hosted libSQL free tier. Verify current prices — they change.

### Vercel will not work

Ephemeral, read-only filesystem at runtime — a local SQLite file does not survive. Options:

1. **VPS with a persistent disk** (Hetzner, Netcup). Cheapest, full control, you manage updates.
2. **Fly.io with a volume.** Simple, scales down.
3. **Turso / hosted libSQL.** Same SQL, minimal code change (`better-sqlite3` → `@libsql/client`), has a free tier — check current limits before committing.

### Operations

```bash
# safe on a live WAL database, unlike copying the file
sqlite3 data/app.db ".backup data/backups/app-$(date +%F).db"
```

- Weekly `VACUUM` and `PRAGMA optimize`.
- `data/curated/` committed to git — that is your real backup, since everything else rebuilds from it.
- Prune `data/raw/` on a retention policy, **never** deleting a file referenced by a snapshot's `inputs`.
- Cron worker: prices during market hours, baselines daily, snapshots hourly, event impacts daily.
- Alert if any loader hasn't succeeded in 48 hours. A silently stale tracker is worse than one that's honestly down.

### Acceptance checklist

1. Site loads from a public URL.
2. Cron worker survives a reboot.
3. Restore a backup into a scratch directory and boot the app against it.
4. Stale-data alert fires when you deliberately stop the worker.
5. Committed and tagged.

---

## Appendix A — Repo tidy-up (do whenever it annoys you)

Small, independent, none of it blocking:

- `elite/` is an unrelated personal-finance app sitting in this repo — `move elite ..\elite-finance-app`.
- `_to_delete/` holds junk I couldn't delete without a permission prompt — `rmdir /s /q _to_delete`.
- Stray zero-byte `data/rich.db` and `data/rich_tracker.db`.
- Migration state: 10+ SQL files against an empty `__drizzle_migrations`. Squash to one baseline that `drizzle-kit migrate` reproduces from empty, and verify on a fresh clone.
- `README.md` is still create-next-app boilerplate.
- 30+ files are untracked. Commit them before anything else — one `git checkout .` currently loses days of work.

## Appendix B — Cost summary

| Phase | Monthly cost |
|---|---|
| Chunks 1–13 (build, private) | **£0** |
| Chunk 14–15 (public launch) | Market data **$29–79**, hosting **~£4–6** |
| **Total at launch** | **roughly £30–70/month** |

Everything else — SEC, Wikidata, Companies House, Land Registry, FAA, USGS, NASA, ECB, ICIJ, rtb-api — is free and licence-clean permanently. The market-data licence is the only real cost in this project, and it exists solely because you want to be public.

## Appendix C — Order and dependencies

```
1 (adapters) ──┬─> 2 (roster) ──┬─> 3 (2nd source) ──┐
               │                │                    ├─> 6 (snapshots) ─> 14 ─> 15
               └─> 4 (prices) ──┴─> 5 (currency) ────┘
                                       │
                          7 (holdings) ┴─> 8 (pledges)
                                       │
             9 (aircraft) ─> 10 (property) ─> 11 (offshore) ─> 12 (events) ─> 13 (globe)
```

Chunks 1 and 2 gate everything. Chunk 2 is the single highest-value piece of work remaining: while the roster is invented, every figure downstream is attached to the wrong people.

# Rich Tracker — Build Review & Remediation Roadmap (v2)

Reviewed `D:\DEV_ON_D\rich_tracker` on 2026-08-28 against the running SQLite database, the loader scripts, the schema and every page. 4,101 lines of app code, 12 tables, 1,268 rows.

**Headline:** the app is further along than it looks, and less true than it looks. The shell, schema shape and design system are solid. But **every net-worth figure in the database is a random number**, and the globe renders dead because of a one-line join bug. Both are cheap to fix. The fabricated-provenance problem underneath them is not, and it's the thing to deal with first.

Your instinct about the globe was right, and the cause is more specific than "it wasn't forked".

---

# Part 1 — Review

## 1.1 What's genuinely real

Worth saying first, because it's a real foundation:

- **Stock prices are real.** 760 rows, 12 tickers, ~60 trading days across June–August 2026, pulled from live Yahoo Finance endpoints (`query1.finance.yahoo.com/v8/finance/chart`). This is the only honestly-sourced dataset in the build.
- **Schema shape is broadly right** and close to the original roadmap — money as `INTEGER` cents, `raw_path` lineage column, `is_public_figure` flag, cuid2 ids.
- **The app builds and runs.** Twelve pages including `/privacy`, `/terms`, `/about`, `sitemap.ts` and `robots.txt` — the agent did the boring compliance surface, which most don't.
- **`DESIGN.md` is a coherent, binding design system** and the pages actually follow it.

## 1.2 P0 — The data is fabricated

### All 314 baseline estimates are `Math.random()`

`src/lib/db/load_slice1.ts:125`:

```ts
value: 50 + Math.random() * 200, // $50B–$250B range
```

What that produces, straight from your database:

| Person | "Forbes" figure | Reality |
|---|---|---|
| Julia Koch | $274.5B | ranked #1, above Musk and Bezos |
| Sergey Galitsky | $257.8B | ~$3B in reality |
| Vasily Anisimov | $245.5B | ~$2B in reality |
| Larry Ellison | $235.1B | plausible by accident |

The raw capture is self-incriminating: `data/raw/rtb/2026-08-28/list.json` has **Musk at $129.5B ranked #1 and Bezos at $231.8B ranked #2**. The ranks don't match the values, because the ranks are array indices and the values are random draws.

**Root cause — and it's a small one.** `load_slice1.ts:50` fetches:

```ts
const res = await fetch("https://rtb-api.komed.dev/v1/list");   // does not exist
```

The documented base URL is `https://cdn.statically.io/gh/komed3/rtb-api/main/api/{REQUEST}`, with `list/{LIST}/latest` for the list and `profile/{URI}/latest` for individuals. So the fetch fails, and this happens:

```ts
} catch (err) {
  console.warn(`rtb-api unavailable (${err}), using synthetic data for development`);
  return generateSyntheticData();          // ← 102 people, random net worths
}
```

A warning on stdout, then 102 fabricated people written to the database **and to `data/raw/`**, where they are indistinguishable from a genuine capture. That's the part that matters more than the wrong URL: the lineage layer designed to make the data auditable is now certifying invented data.

### The consensus feature is measuring noise

314 estimates across two source ids (`rtb-api`, 284 rows; `forbes`, 30 rows). Both come from the same random generator. So the "spread between sources" — the product's entire differentiating claim — is **the distance between two random draws**. The consistency band on the landing page is rendering noise, styled as insight.

### Every other table is hand-invented, with fabricated citations

| Table | Rows | What it claims | What it is |
|---|---|---|---|
| `equity_holdings` | 16 | `source: "SEC filing / Bloomberg estimate"` | hardcoded TS array, round numbers (411,000,000 TSLA), no `source_url` |
| `pledge_holdings` | 7 | `source: "SEC Form 4 / Bloomberg pledge tracker"` | invented; no filing, no evidence text |
| `assets` | 21 | `source_id: "sec-edgar"` | invented; Trump Tower is not in EDGAR |
| `ownership_links` | 17 | `citation: "Santa Barbara County Assessor, APN 053-290-014"` | fabricated parcel number, `confidence: "high"` |
| `events` | 10 | `source_id: "usgs"` | invented, dated 2025, references "Bezos' Greenbytes Ranch" |

Two of these need naming specifically:

**The methodology comments are confidently wrong.** `load_slice5.ts` states *"pledged shares are NOT reported as a separate line in 13F, they reduce the reported holdings. We infer pledge size from the gap."* That is not how any of this works — 13F covers institutional investment managers, not individual pledges. Pledged shares are disclosed in the **DEF 14A proxy statement**, in the beneficial-ownership footnotes. The one feature that was going to be your genuine edge is built on an invented mechanism.

**False claims about named real people.** `assets` contains *"1 Wall Street — JPMorgan Chase headquarters. Trump ownership stake via Development Associates."* 1 Wall Street is the former Bank of New York building, redeveloped as residential; JPMorgan's HQ is 270 Park Avenue; the ownership claim is invented. There are more like it. Fabricated financial claims about identifiable living people, with fake official citations attached at `confidence: "high"`, is the one category here with real legal exposure — and it's exactly what your `is_public_figure` gate was meant to contain. That column is never read by any query in the codebase.

### The copy promises the opposite

`src/app/layout.tsx:27` ships as the site description:

> "Multi-source billionaire net-worth estimates with consistency bands. Shows what Forbes and Bloomberg disagree on, and what fraction is verifiable."

The landing page explains the green segment is "verifiable liquid equity". Nothing in the codebase computes verifiability — `grep` finds the word only in marketing copy. An app that fabricates data is bad; an app that fabricates data *while explicitly inviting the reader to trust it on transparency grounds* is worse. This has to be fixed before anything is shown to anyone, and it's the reason Part 2 starts where it does.

## 1.3 P1 — Valuation is wrong even where the data is real

**No currency handling at all.** There's no `securities` table, no `currency` column and no FX conversion, but the holdings span five exchanges:

| Exchange | Currency | Example | Effect |
|---|---|---|---|
| NYSE / NASDAQ | USD | TSLA | correct |
| EPA (Euronext Paris) | EUR | MC.PA | ~8% overstated |
| BME (Madrid) | EUR | ITX.MC | ~8% overstated |
| NSE (India) | INR | RELIANCE.NS @ ₹1,282.20 | **treated as $1,282.20 — ~85× overstated** |

Ambani's liquid position is inflated by roughly two orders of magnitude, and nothing in the UI would reveal it.

**Other correctness gaps:**

- No `valuation_snapshots` table → no `method_version`, no `inputs`, no reproducibility, no wealth history. The sparkline plots *share price*, not wealth.
- `leverageRatio = baseline / (liquid − pledged)` goes to infinity or negative as pledged approaches liquid. No guard.
- `equity_holdings.shares` is `integer` — no fractional shares.
- `db/index.ts` sets **no PRAGMAs**. `foreign_keys` is OFF by default in SQLite, so every `references()` in the schema is decorative at runtime. No WAL either.
- `equity/page.tsx` opens a **second `better-sqlite3` connection inside the page render**, alongside the module-level one.

## 1.4 P2 — Why the globe looks dead

This is your actual complaint, and there's a precise answer.

### The join matches zero rows

`src/app/globe/page.tsx:44`:

```ts
.leftJoin(baselineEstimates, sql`${baselineEstimates.personId} = ${people.slug}`)
```

`baseline_estimates.person_id` holds a cuid2 (`rtz4yx1ciq3b7m1y9yq10dx2`); `people.slug` holds `elon-musk`. Verified against your database:

```
join as written (person_id = slug):   102 people,   0 matched
join corrected  (person_id = id):     314 rows,   314 matched
```

So `avgWealth` is `null` for everyone → `wealthB = 0` → every country's `totalWealthB = 0`. Which then cascades:

- `countryColor(0)` → `#666666` — **every dot renders grey**, the gold/blue tiers are unreachable
- `countryRadius(count, 0)` → smallest radius
- The sidebar overview reads **"$0B"**
- Every person in every country panel reads `$0.0B`

That's the whole "not much going on" — one wrong column reference.

### And it's a country-dot chart, not a spatial intelligence tool

Independent of the bug, this was never a God's Eye View fork. It's `globe.gl` with:

- **Zoom and pan disabled** — `enableZoom = false; enablePan = false`. You cannot explore it. It auto-rotates and that's it.
- **Ten hardcoded country centres**, duplicated verbatim in `GlobeView.tsx` *and* `globe/page.tsx`. Anything outside them is silently `continue`d. It happens to cover all 102 current people; the first real dataset breaks it.
- **The `assets` and `events` tables are never rendered.** 21 assets and 10 events carry `lat`/`lng` and sit in the database unused. The two layers that would make the globe worth looking at already have data and no renderer.
- **Textures loaded from `//unpkg.com/three-globe/...`** — protocol-relative, external CDN, on a local-first app. Offline it's a black sphere.
- No Cesium, no OpenSky/AIS/CelesTrak/USGS/FIRMS. None of the live event layers.

## 1.5 P3 — Repo hygiene

- **`elite/` is a different application.** A Vite personal-finance tracker — `GoalForm`, `TransactionsTable`, `SpendingChart`, `SubscribeModal` — with its own `package.json`, lockfile and built `dist/`, sitting untracked inside this repo. Nothing to do with Rich Tracker.
- **`nul`** — a file containing `bash: line 3: del: command not found`. An agent ran a Windows `> nul` redirect in bash. Harmless, delete it.
- **Two commits total.** Slices 6 and 8, `src/app/events/`, `error.tsx`, five migrations and `elite/` are all uncommitted. One `git checkout .` and a day's work is gone.
- **Migration numbering collision** — two `0001_` files (`0001_core.sql`, `0001_uneven_vampiro.sql`), 7 SQL files but only 2 entries in drizzle's `_journal.json`. Migrations have been partly applied by hand; `drizzle-kit migrate` will not reproduce this database.
- **No `data/curated/`.** The file-as-source-of-truth pattern was skipped entirely — all curation lives in TypeScript arrays inside `src/lib/db/*.ts`, and `data/` is gitignored (twice). There is no `rebuild` script and no `migrate`/`seed` npm scripts; loaders are run ad hoc via `tsx`.
- **Dead tables:** `billionaires` (10 mock rows, superseded by `people`) and `__new_people` (0 rows, leftover from a Drizzle table rebuild).
- **`sources.rtb-api`** has `url: "http://test"`, `attribution: "Test"`.
- **`next.config.ts` is empty** — no `serverExternalPackages: ['better-sqlite3']`.
- **Yahoo Finance** is an undocumented endpoint with no `sources` row (it's a free-text string). Fine for local use, a ToS problem if you publish.

---

# Part 2 — Remediation roadmap

Same rule as before: each slice is demoable on its own. Ordered by "what makes the next slice safe", not by what's most fun.

Two slices before the globe. I know the globe is what's bothering you — R3 fixes the visible deadness in about twenty minutes, and R6 rebuilds it properly. But shipping a beautiful globe on top of random numbers just makes the fabrication more persuasive, so R1 and R2 come first.

---

## R0 — Quarantine and commit (30 minutes)

**Goal:** stop the bleeding, get a clean git baseline, make the untrustworthy data visibly untrustworthy.

```bat
cd /d D:\DEV_ON_D\rich_tracker
del nul
move elite ..\elite-finance-app
git add -A
git commit -m "checkpoint: slices 6+8, events page, before remediation"
```

Purge the fabricated tables — keep the real prices:

```sql
DELETE FROM ownership_links;
DELETE FROM assets;
DELETE FROM events;
DELETE FROM pledge_holdings;
DELETE FROM equity_holdings;
DELETE FROM baseline_estimates;
DROP TABLE IF EXISTS billionaires;
DROP TABLE IF EXISTS __new_people;
UPDATE sources SET url='https://github.com/komed3/rtb-api', attribution='komed3/rtb-api (MIT)' WHERE id='rtb-api';
-- stock_snapshots and people survive: prices are real, people are mostly real names
```

Then quarantine the poisoned capture so it can never be mistaken for real:

```bat
move data\raw\rtb\2026-08-28 data\raw\_SYNTHETIC_DO_NOT_USE_2026-08-28
```

Add a banner component that renders on every page while the DB is unverified — hardcode `DATA_STATUS = 'unverified'` in one file and render a bar reading *"Development data — figures are not sourced."* Remove the verifiability language from `layout.tsx:27` and the landing page until R3 actually computes it.

**Done when:** git is clean, `elite/` is out, no fabricated row remains, and every page carries the banner.

---

## R1 — Make the truth pipeline actually true (1 session)

**Goal:** 100 people with real, sourced net-worth figures — and a loader that can no longer lie.

### Fix the endpoint

```ts
const RTB_BASE = "https://cdn.statically.io/gh/komed3/rtb-api/main/api";
const res = await fetch(`${RTB_BASE}/list/rtb/latest`);
```

### Delete the fallback entirely

Non-negotiable, and the single most important change in this document:

```ts
async function fetchRTBData(): Promise<RTBItem[]> {
  const res = await fetch(`${RTB_BASE}/list/rtb/latest`);
  if (!res.ok) throw new Error(`rtb-api ${res.status} — ABORTING, no synthetic fallback`);
  return res.json();
}
```

**A loader must never invent data on failure.** An empty database is honest; a database full of plausible fiction is not. If you want a demo mode later, it goes behind an explicit `--synthetic` flag that writes to `sources.id = 'SYNTHETIC'` and paints the UI red.

### Make the raw layer prove itself

Every capture gets a sidecar so a synthetic file can never masquerade as real:

```ts
// data/raw/rtb/<date>/list.json      — the bytes, unmodified
// data/raw/rtb/<date>/list.meta.json — { url, http_status, fetched_at, sha256, bytes }
writeFileSync(`${dir}/list.meta.json`, JSON.stringify({
  url, http_status: res.status, fetched_at: new Date().toISOString(),
  sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length,
}, null, 2));
```

Refuse to load any raw file without a `.meta.json` recording a 200.

### Add the second real source

Wikidata `P2218` via SPARQL — CC0, cites its own references, and genuinely independent of Forbes. That gives R4 a real spread to measure instead of noise.

**Done when:** the top 10 by net worth are actually the top 10, every row traces to a `raw_path` with a verified `.meta.json`, and deliberately breaking the URL causes a crash rather than a silent fabrication.

---

## R2 — Provenance and currency (1–2 sessions)

**Goal:** make fabrication structurally impossible, and stop valuing rupees as dollars.

### Schema changes

```sql
-- Nothing enters a claim table without a resolvable URL.
ALTER TABLE equity_holdings ADD COLUMN source_url TEXT;
ALTER TABLE pledge_holdings ADD COLUMN source_url TEXT;
ALTER TABLE pledge_holdings ADD COLUMN evidence_text TEXT;
ALTER TABLE pledge_holdings ADD COLUMN filing_id TEXT;
-- then rebuild each table with: source_url TEXT NOT NULL CHECK (source_url LIKE 'http%')

CREATE TABLE securities (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  exchange TEXT NOT NULL,
  name TEXT,
  currency TEXT NOT NULL,          -- the fix
  cik TEXT,
  UNIQUE (ticker, exchange)
);

CREATE TABLE fx_rates (
  base TEXT NOT NULL, quote TEXT NOT NULL, as_of TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (base, quote, as_of)
) WITHOUT ROWID;
```

Point `equity_holdings`, `pledge_holdings` and `stock_snapshots` at `security_id` instead of loose `ticker`/`exchange` strings. Backfill currency: NYSE/NASDAQ→USD, EPA/BME→EUR, NSE→INR, LSE→GBP.

FX from **frankfurter.app** (ECB daily, no key). Store per-day rates so a historical snapshot converts at the rate that applied *then*, not today's.

### Fix the connection layer

`src/lib/db/index.ts`:

```ts
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');     // currently OFF — all your FKs do nothing
sqlite.pragma('busy_timeout = 5000');
```

Remove the second `new Database()` from `equity/page.tsx` and import the shared handle.

### Establish `data/curated/`

Move every hardcoded array out of `src/lib/db/*.ts` into CSVs — `holdings.csv`, `securities.csv`, `assets.csv`, `ownership_links.csv` — each with a mandatory `source_url` column, committed to git (drop `data/curated/` from `.gitignore`). Add `npm run rebuild`: drop → migrate → load raw → load curated → snapshot.

The point isn't tidiness. A hardcoded array in a 400-line TypeScript file is invisible; a CSV row with an empty `source_url` column is obviously missing something. Make the gap visible and it stops being fillable by invention.

**Done when:** `npm run rebuild` reconstructs the DB from disk, Ambani's holding is valued in INR converted to USD, and inserting a claim without a `source_url` fails.

---

## R3 — Fix the globe's data, compute verifiability (1 session)

**Goal:** the globe lights up, and the site's central claim becomes true. Quick wins, high visibility.

### The one-line fix

`src/app/globe/page.tsx:44`:

```ts
- .leftJoin(baselineEstimates, sql`${baselineEstimates.personId} = ${people.slug}`)
+ .leftJoin(baselineEstimates, eq(baselineEstimates.personId, people.id))
```

Use Drizzle's `eq()` rather than a raw `sql` template — the type checker catches this class of mistake; the template literal silently accepted `slug`.

While you're there: take the *latest* estimate per person, not `AVG` across every source and date. Averaging Forbes with Wikidata destroys the spread you exist to show.

### Restore interaction

```ts
controls.enableZoom = true;
controls.enablePan  = true;
controls.autoRotate = true;   // stop on first user interaction
```

Move the two `COUNTRY_CENTERS` copies into `src/lib/geo/country-centers.ts`, extend past 10 countries, and log a warning for unmapped countries instead of silently dropping them.

Download the three-globe textures into `public/textures/` and reference them locally.

### Compute verifiability for real

```sql
CREATE TABLE valuation_snapshots (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  liquid_cents INTEGER NOT NULL,
  baseline_cents INTEGER NOT NULL,
  pledged_cents INTEGER NOT NULL DEFAULT 0,
  verifiability REAL,                    -- liquid / baseline, clamped 0..1
  method_version TEXT NOT NULL,
  inputs TEXT NOT NULL CHECK (json_valid(inputs)),
  created_at TEXT NOT NULL
);
```

`inputs` stores every share count, price, FX rate and security id used. Only once this table is populated do you put the verifiability language back in `layout.tsx` — and then it's true.

Guard the leverage ratio: express it as `pledged / liquid` (0–1, bounded, meaningful) rather than `baseline / (liquid − pledged)`.

**Done when:** the globe shows real gold and blue tiers with non-zero totals, you can zoom and pan, and the landing page's verifiability figure is computed rather than asserted.

---

## R4 — Real holdings from real filings (3–4 sessions)

**Goal:** replace the 16 invented `equity_holdings` rows with filing-derived ones for 15–25 people.

Endpoints, free, no key, `User-Agent: RichTracker/0.1 (taylorc697@gmail.com)` required, ~10 req/sec:

```
https://data.sec.gov/submissions/CIK##########.json
https://www.sec.gov/Archives/edgar/data/<cik>/<accession>.txt
https://efts.sec.gov/LATEST/search-index?q=...
```

Build order: **Form 4** (clean XML, exact post-transaction share counts) → **Forms 3/5** → **13D/13G**. Fetch to `data/raw/sec/<cik>/<accession>.xml`, parse from disk, record `filing_id` and `source_url` on every holding.

Populate `people.filing_cik` first — the column exists and is empty.

Non-US holders (Arnault, Ortega, Ambani) have no SEC presence. Use AMF, CNMV and BSE/NSE disclosures, or leave the holding out. **A missing holding is fine. An invented one is not.**

**Done when:** every `equity_holdings` row links to a real filing you can open in a browser, and people with no filing coverage show "no verified holdings" rather than a number.

---

## R5 — Pledged shares, done correctly (2–3 sessions)

**Goal:** rebuild the leverage feature on the right filing type. This is still your best differentiator — it was just built on a fabricated mechanism.

Correct the methodology in code and comments: pledges are disclosed in the **DEF 14A proxy statement**, in beneficial-ownership footnotes — *not* Form 4, *not* 13F.

Pipeline: fetch DEF 14A → index body into **FTS5** → search `pledged` / `pledge` / `collateral` → LLM-extract the share count → store `evidence_text` (the verbatim sentence), `source_url` and `filing_id`. Render the quoted sentence in the UI next to the figure. If there's no sentence, there's no row.

Keep the honest framing from the original roadmap: pledged shares are **collateral, not a dollar liability** — the loan size is almost never disclosed. Never subtract them from net worth. Show *"38% of this stake is pledged as loan collateral"* and let the reader draw the conclusion.

**Done when:** at least three people show a pledge figure with a quotable sentence and a working link to the proxy statement.

---

## R6 — Rebuild the globe properly (3–5 sessions)

**Goal:** the spatial intelligence layer you actually wanted.

**Decide first: keep `globe.gl` or move to Cesium.**

- **Stay with globe.gl** if the goal is an attractive owner/asset map. It handles points, arcs, rings and custom layers well, has no billing, and R3 already made it work. Cheaper and probably right for now.
- **Move to CesiumJS** only if you want real geospatial work — accurate terrain, satellite orbits, time-dynamic playback. Forking God's Eye View makes sense at this point and not before. Default to Cesium World Terrain + OSM imagery; keep Google Photorealistic 3D Tiles behind a demo-only flag, since they bill per session.

Either way, the layers that make it worth looking at:

1. **Asset layer** — `physical_assets` as points, coloured by owner, sized by value. The data model exists; nothing renders it.
2. **Owner hover card** — name, live total, verifiability score, pledge percentage.
3. **"Follow the money"** — dim everything not linked to a tracked person.
4. **Event layer** — `events` with `lat`/`lng`, time-scrubbable.
5. **Live feeds**, if you go Cesium: OpenSky (flights), AISStream (vessels), CelesTrak (satellites), USGS (quakes), NASA FIRMS (fires), Launch Library 2 (launches).

Rebuild the asset graph from real sources as you go: UK Land Registry and the Register of Overseas Entities, US county assessors, FAA registry, ICIJ Offshore Leaks. Every row needs a `source_url` and an honest `confidence`. Cap v1 at 15 people and 200 assets.

**Done when:** clicking an asset shows an owner chain with a confidence and a working source link on every hop — and no hop is invented.

---

## R7 — Event correlation, honestly (2–3 sessions)

**Goal:** the demo that sells it — without the causal overclaiming the current `events` table is full of.

Replace invented events with real feeds: USGS earthquakes, NASA FIRMS fires, Launch Library 2, and dated market events from a real source.

The discipline, unchanged from the original roadmap and now more necessary given what's in there:

- Always compute `excess_pct` against a benchmark. A −2% move on a day the index fell 2% means nothing. **Nothing in the current codebase compares to any benchmark** — `grep` finds no S&P, no index, no excess return.
- Kill the free-text `impact_note` field. It currently holds prose asserting linkage ("Musk and Welch both hold large TSLA positions") with no computation behind it. Replace with computed columns: `market_delta_pct`, `index_delta_pct`, `excess_pct`, `distance_km`.
- Copy reads *"7.1 quake, 40km from this fab. Operator −2.1% vs index −0.3% over 24h."* Never *"this quake cost him $400M."*
- **Show null results.** A tracker that sometimes says "no detectable move" is far more trustworthy than one that always finds a story.

**Done when:** every event impact is computed from real prices against a real benchmark, and at least one prominent event honestly reports no detectable effect.

---

## R8 — Repo hygiene (1 session, do it whenever it annoys you)

- Reconcile migrations: two `0001_` files, 7 SQL files, 2 journal entries. Squash to a single clean baseline that `drizzle-kit migrate` reproduces from empty. Verify with `npm run rebuild` on a fresh clone.
- Add npm scripts: `migrate`, `seed`, `rebuild`, `ingest:rtb`, `ingest:prices`, `ingest:sec`.
- `next.config.ts`: `serverExternalPackages: ['better-sqlite3']`.
- Replace the boilerplate `README.md` (still Vercel's create-next-app text) with real setup steps.
- Deduplicate `data/` in `.gitignore`; un-ignore `data/curated/`.
- Add a `sources` row for Yahoo Finance and note the ToS position; if you publish, move to Finnhub's free tier.
- **Enforce `is_public_figure`** in every person-facing query. It exists and nothing reads it.
- A local `node-cron` worker for scheduled ingestion (prices, rtb refresh, snapshots), plus `npm run tick` for one-shot runs.

---

## Priority summary

| # | Slice | Why | Effort |
|---|---|---|---|
| **R0** | Quarantine & commit | Fabricated data is live; git is one `checkout` from disaster | 30 min |
| **R1** | Fix the truth pipeline | Fixes the wrong URL and kills the synthetic fallback | 1 session |
| **R2** | Provenance & currency | Makes fabrication structurally impossible; fixes the 85× INR bug | 1–2 sessions |
| **R3** | Globe data + verifiability | **The one-line join fix — the globe lights up** | 1 session |
| **R4** | Real SEC holdings | Real filings behind every holding | 3–4 sessions |
| **R5** | Pledges, correctly | Rebuilds your differentiator on the right filing | 2–3 sessions |
| **R6** | Globe rebuild | The spatial layer you wanted | 3–5 sessions |
| **R7** | Event correlation | The demo — benchmark-adjusted | 2–3 sessions |
| **R8** | Hygiene | Whenever it bites | 1 session |

**If you only do three:** R0, R1, R3. That's roughly a day and a half and takes you from "fabricated data behind a dead globe" to "real data behind a working one" — which is a genuine product, and the honest floor everything else builds on.

---

## The lesson worth keeping

The agent did something specific and worth naming, because it will happen again on your other projects: **when a data source failed, it substituted invention and kept going.** The wrong URL was a trivial bug. The `catch` block that turned that bug into 102 fabricated people with fake Forbes attributions — and wrote them into the audit trail — is the actual failure.

The guardrail is a project rule, and it belongs in `CLAUDE.md` and `AGENTS.md` so every future agent session inherits it:

> **Never generate placeholder, synthetic, or example data for any table that represents real-world facts.** If a source is unavailable, fail loudly and leave the table empty. Every row in a claims table must carry a resolvable `source_url`. If you cannot cite it, do not insert it.

Add that now, before R1. It's the difference between an app that's wrong and an app that's confidently wrong.

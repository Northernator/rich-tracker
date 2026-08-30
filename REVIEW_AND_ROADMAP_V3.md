# Rich Tracker — Post-R7 Review, Fixes Applied, and Development Roadmap (v3)

Reviewed `D:\DEV_ON_D\rich_tracker` on 2026-08-29 against the live database, the running dev server on `localhost:3000`, and every page. Bugs found were fixed in place and verified in the browser.

**Where it stands:** genuinely better. The globe is now a real spatial view with layers, arcs and 194 live USGS earthquake markers. Events are real data. The leaderboard numbers are plausible. Provenance columns exist across the claim tables.

**But three things from v2 were never actually done**, and one of them is the legal-exposure item: the fabricated asset graph — Trump/1 Wall Street, "Greenbytes Ranch", the invented parcel number at `confidence: 'high'` — is untouched and still rendering. R0 was skipped.

---

# Part 1 — Bugs found and fixed

All eight verified live on the running server after the change.

### 1. Every figure on `/equity` was 100× too large — **fixed**

`liquidCents` is computed in cents (`priceCents × shares`) then rendered with `formatB(cents / 1e9)`. Dividing cents by 1e9 gives billions *of cents*.

The page was reporting Musk's Tesla stake as **$10,600.63B** — $10.6 trillion, roughly four times the market cap of Tesla — and a top-6 baseline total of **$97,890B**, about the GDP of the planet. Every other page in the app used the correct `/100/1e9`; `/equity` was the sole offender, at five sites.

```diff
- {formatB(row.liquidCents / 1e9)}
+ {formatB(row.liquidCents / 1e11)}
```

Now: Musk $106.01B, liquid total $106.30B, baseline total $978.90B, pledged $45.34B.

### 2. Confidence was "Medium" for every single row — **fixed**

```diff
- } else if (sourceCount >= 2 || spreadPct < 20) {
+ } else if (sourceCount >= 2 && spreadPct < 20) {
```

With one source the spread is zero, so `spreadPct < 20` was always true and every row scored medium — while the legend on the same page said single-source means Low. The site was overstating its own confidence in itself, which is precisely the failure mode this product exists to avoid. All rows now correctly render `○ Low`.

### 3. Leverage ratio rendered as **3511.88x** — **fixed**

`baselineCents / (liquid − pledged)` explodes when the verified liquid stake is a rounding error against the baseline. Bezos had $0.06B liquid against a $215.8B baseline, producing a meaningless four-figure multiple displayed with two decimal places of false precision.

Now suppressed unless the liquid stake is ≥5% of baseline *and* there is an actual pledge. Bezos shows `—`; Musk still shows a real 3.86x.

### 4. The pledge methodology copy was factually wrong — **fixed**

The page told readers *"Pledged shares reduce reported 13F holdings but economic exposure remains."* 13F covers institutional investment managers; it has nothing to do with an individual's pledges. Replaced with the correct mechanism: executives pledge shares as collateral for personal loans, disclosed in **DEF 14A** proxy statements, and headline net-worth figures ignore it.

### 5. Ownership page summed mansions and trillion-dollar companies — **fixed**

"COMBINED VALUE **$2446.90B**" was arithmetically correct and semantically meaningless: it added Meta at $1.2T and Tesla at $800B to a $120M house. The company valuations swamped every physical asset by four orders of magnitude.

Split into two figures: **Physical assets $7.90B** and **Company stakes $2,439.00B**. Different kinds of claim, reported separately.

### 6. Globe legend advertised event types that don't exist — **fixed**

Legend showed "Event (scandal)" and "Event (merger)". The database contains `earthquake` (194), `insider_sell` (271), `sec_enforcement` (25) and `pledge` (10) — none of which were in the colour map either, so they all fell through to the default grey. Colour map and legend now match the data.

### 7. "1 billionaires" — **fixed**

Pluralisation on four call sites. Spain, Italy, Hong Kong and Japan now read "1 billionaire".

### 8. `next.config.ts` was empty — **fixed**

Added `serverExternalPackages: ["better-sqlite3"]`. Without it `next build` can fail to resolve the native `.node` binary — `next dev` was masking this.

### Also cleaned

`nul`, two empty `rich_tracker.db` files and `pasted_review.txt` moved to `_to_delete/` (the session can't delete files on your machine without a permission prompt — delete that folder yourself). `scripts/fix_data.mjs` added with `npm run fix:data` and `npm run db:backup`.

---

# Part 2 — What still needs work

## 2.1 The fabricated asset graph is still live — **run this first**

R0 in the v2 roadmap said purge it. It wasn't done. `/ownership` right now serves, to anyone who loads it:

- *"1 Wall Street — JPMorgan Chase headquarters. Trump ownership stake via Development Associates."* 1 Wall Street is the former Bank of New York building, redeveloped as residential. JPMorgan's HQ is 270 Park Avenue. The ownership claim is invented.
- *"Greenbytes Ranch — 12,000-acre ranch, Bezos purchased 2020"*, cited as **"Santa Barbara County Assessor, APN 053-290-014"** at `confidence: HIGH`. The property and the parcel number are both invented.
- *"Rising Sun — Arnold Arnault-owned"*. Rising Sun is David Geffen's, and "Arnold Arnault" is not a person.
- *"Airbus A380 (N767BE) — Bezos acquired from United Airlines 2019."* United has never operated an A380.
- *"The Spearwood Estate — Gates purchased 2024"*, cited to Miami-Dade public records.

Fabricated financial claims about identifiable living people, wearing invented official citations, marked high-confidence. That's the one category in this project with real legal exposure, and it's the page whose headline says *"a citation you can verify."*

The 7 pledge rows are the same story with better camouflage: still the round 130M/85M/45M numbers from the original invented array, now with real-looking SEC URLs bolted on — one of them `wf-form4_171234567890456.xml`, an obviously invented accession — and `evidence_text` that *describes* a filing ("Pledged shares disclosed in SEC Form 4 filing") rather than quoting one.

**I could not run the fix myself** — SQLite locking doesn't work over the device file bridge, and the browser route I tried to trigger it with was blocked. One command from you:

```bat
cd /d D:\DEV_ON_D\rich_tracker
npm run fix:data
```

It backs up first, then purges `assets`, `ownership_links` and `pledge_holdings`, drops the mangled holdings, clears the bad `primary_org`, removes "Paul Allen Estate", and drops the leftover `billionaires` / `__new_events` / `__new_people` tables.

## 2.2 The people roster is still the synthetic list

This is the one that surprised me. The *values* were replaced with plausible figures, but the *names* were never re-fetched — they're still the hardcoded fallback array from the original bug:

- **"Paul Allen Estate", $210.0B, rank 4.** Paul Allen died in 2018.
- **31 of 102 people are Russian** — Sechin, Melnichenko, Usmanov, Tinkov, Galitsky. Not remotely the real distribution, and several are nowhere near billionaire status at those figures.
- **`primary_org` is "Tesla" for all 102.** Every row reads "Bernard Arnault · France · Tesla", "Mukesh Ambani · India · Tesla".
- **Gautam Adani is listed as USA.**
- `raw_path` is `forbes://real-time-billionaires/` — a made-up URI scheme, not a file. There is no raw capture behind any baseline figure, so the provenance chain the landing page promises doesn't exist.

And the site says *"Forbes 2026 net worth estimates"* — attributing a hardcoded array to Forbes, whose ToS you didn't want to be near in the first place.

## 2.3 The consensus feature has nothing to compare

`baseline_estimates` has 102 rows from exactly **one** source. The spread band, the "most disputed" sort, the confidence tiers — the entire differentiating thesis — needs a second independent source to do anything. Right now the band renders as a single dot and every row is correctly, uselessly, Low confidence.

## 2.4 R2 landed as schema only

`securities`: **0 rows.** `fx_rates`: **0 rows.** The tables were created; nothing populates them. So there is still no currency handling — the moment a non-USD holding comes back, INR and EUR get valued as dollars again.

## 2.5 Price history was destroyed

`stock_snapshots` went from **760 rows across ~60 trading days (June–August)** down to **34 rows on a single day**. The real Yahoo history — the one genuinely well-sourced dataset in the build — was wiped by a reload. Every sparkline on `/equity` now reads "no data".

Restoring it is a re-fetch, but the lesson is the loaders are destructive where they should be additive.

## 2.6 The 13F parser is producing garbage

42 holdings, only **3** resolve to a price. The rest are six-character truncations of the issuer *name* column: `ALLYFI`, `ALPHAB`, `AMERIC`, `APPLEI`, `KRAFTH`, `MACYSI`. All 42 come from CIK **1067983** — Berkshire Hathaway — and were attributed to individuals, so Steve Ballmer and Jim Walton now "hold" Berkshire's institutional book.

This is the 13F confusion again in a new form. 13F reports what an institutional manager holds; it is not a person's stake, and its identifier column is a CUSIP, not a ticker.

Two smaller ones in the same table: Bezos shows **230,637** AMZN shares (real is ~900M — this looks like a single Form 4 transaction line mistaken for a total), and Brin has 673,200 GOOGL held against 55,000,000 pledged, which is internally impossible.

## 2.7 Still missing from R3

No `valuation_snapshots` table. So there's no `method_version`, no stored `inputs`, no reproducibility, and no wealth history — the sparkline plots share price, not wealth. Verifiability is computed inline per request and never persisted.

## 2.8 R8 wasn't done, and neither was the commit

Still **two commits**, both from the 28th. Everything since — R1 through R7, every migration, the events page — is uncommitted working tree. `elite/`, the unrelated personal-finance app, is still sitting in the repo. Migration state is worse than before: 10 SQL files against 2 journal entries. `npm run rebuild` points at `seed.ts`, the original mock seeder.

---

# Part 3 — Development roadmap

## D0 — Run the data fix and commit (20 minutes)

```bat
cd /d D:\DEV_ON_D\rich_tracker
npm run fix:data
move elite ..\elite-finance-app
rmdir /s /q _to_delete
git add -A
git commit -m "R1-R7 + review fixes: cents bug, confidence tiers, leverage guard, purge fabricated asset graph"
```

Then add the guardrail to `CLAUDE.md` and `AGENTS.md` — it was the recommendation at the end of v2 and it's why 2.1 and 2.2 are still open:

> **Never generate placeholder, synthetic, or example data for any table representing real-world facts.** If a source is unavailable, fail loudly and leave the table empty. Every row in a claims table carries a resolvable `source_url`. If you cannot cite it, do not insert it. **Never delete or replace existing sourced rows** — loaders are additive.

**Done when:** git is clean, `/ownership` shows an honest empty state, and the rule is in both agent files.

## D1 — A real roster and a real second source (1–2 sessions)

Two jobs, and the first unblocks everything downstream.

**Real people.** Replace the hardcoded array with the actual rtb-api, which does work — the base URL is `https://cdn.statically.io/gh/komed3/rtb-api/main/api`, with `list/{LIST}/latest` for the list and `profile/{URI}/latest` per person. Write the response to `data/raw/rtb/<date>/list.json` plus a `list.meta.json` recording `url`, `http_status`, `fetched_at` and `sha256`. Refuse to load any raw file lacking a verified 200. That kills the `forbes://` fiction and gets you real names, countries and organisations in one pass.

**A real second source.** Wikidata `P2218` via the SPARQL endpoint — CC0, machine-readable, cites its own references, genuinely independent. This is what makes `/` work as designed: real spread, real "most disputed" sort, confidence tiers that mean something.

**Done when:** no name on the leaderboard is dead or invented, `primary_org` varies, ≥40 people carry two independent estimates, and the widest spreads are interesting rather than noise.

## D2 — Currency, and the honest number persisted (1–2 sessions)

Populate the two empty tables. `securities` gets a `currency` per listing (NYSE/NASDAQ→USD, EPA/BME→EUR, NSE→INR, LSE→GBP); `fx_rates` gets daily ECB rates from **frankfurter.app** (no key). Store per-day rates so a historical snapshot converts at the rate that applied then. Point `equity_holdings` and `stock_snapshots` at `security_id` rather than loose ticker strings — that alone would have prevented the mangled-ticker problem in 2.6.

Then build `valuation_snapshots` as specified in v2 R3: `liquid_cents`, `baseline_cents`, `pledged_cents`, `verifiability`, `method_version`, and an `inputs` JSON blob holding every price, share count, FX rate and security id used. Write one row per person per run.

**Done when:** a non-USD holding values correctly, and you can reconstruct any number the site displayed last Tuesday.

## D3 — Restore price history and schedule ingestion (1 session)

Re-fetch the June–August daily series, and make every loader additive: `INSERT OR IGNORE` on `(security_id, as_of)`, never `DELETE` then reload. Add a local `node-cron` worker — prices during US market hours, baselines daily, snapshots hourly — with `npm run tick` for one-shot runs, registered in Task Scheduler at logon.

**Done when:** sparklines render, and running a loader twice changes nothing.

## D4 — Holdings from the right filings (3–4 sessions)

Bin the 13F path for individuals. Correct order: **Form 4** (clean XML, exact post-transaction totals — note *post-transaction holdings*, not the transaction line, which is where Bezos's 230,637 came from), then **Forms 3/5**, then **13D/13G** for large non-insider holders. Keep 13F only where wealth genuinely sits in a fund, and attribute it to the fund entity, never the person.

Resolve identifiers properly: 13F reports CUSIPs. Map CUSIP → ticker via a lookup table you populate and store; never slice the issuer-name column.

Populate `people.filing_cik` first — the column exists and is empty. Non-US holders (Arnault, Ortega, Ambani) need AMF, CNMV and BSE/NSE disclosures, or no holding at all. A missing holding is fine.

**Done when:** every holding opens to a real filing, and share counts survive a sanity check against the company's outstanding shares.

## D5 — Rebuild the asset graph from real registries (3–5 sessions)

Starting from empty after D0, and this time sourced: UK Land Registry and the Register of Overseas Entities, US county assessor portals, the FAA aircraft registry, ICIJ Offshore Leaks. Every row gets a `source_url` that resolves and a `confidence` you can defend. Keep company stakes and physical assets as separate concepts — the fix in Part 1 §5 papered over a modelling problem that D5 should solve properly.

Cap v1 at 15 people and 200 assets. Curate through `data/curated/*.csv` so each claim is a reviewable line in git.

**Done when:** every hop in every ownership chain opens to a real document.

## D6 — Event impact, benchmark-adjusted (2–3 sessions)

You have 500 real events and no impact computation. Build `event_asset_links` (R-tree bounding box, then haversine) and `event_impacts` with `market_delta_pct`, `index_delta_pct` and **`excess_pct`** — nothing in the codebase compares against a benchmark today, and a −2% move on a day the index fell 2% means nothing.

Drop the free-text `impact_note` field. Copy reads *"M5.4, 40km from this fab. Operator −2.1% vs index −0.3% over 24h."* Show null results explicitly.

**Done when:** at least one prominent event honestly reports no detectable effect.

## D7 — Hygiene (1 session)

Squash the migrations to a baseline `drizzle-kit migrate` reproduces from empty, verified on a fresh clone. Point `npm run rebuild` at a real rebuild (drop → migrate → load raw → load curated → snapshot), not `seed.ts`. Replace the create-next-app README. Enforce `is_public_figure` in every person-facing query — it exists and nothing reads it. Add a `sources` row for Yahoo Finance and decide the ToS position; if you publish, move to Finnhub's free tier.

---

## Priority summary

| # | Slice | Why now | Effort |
|---|---|---|---|
| **D0** | Run `fix:data`, commit | Fabricated claims about real people are live | 20 min |
| **D1** | Real roster + Wikidata | Unblocks the consensus thesis; kills the dead-billionaire problem | 1–2 sessions |
| **D2** | Currency + valuation snapshots | Correctness and reproducibility | 1–2 sessions |
| **D3** | Price history + scheduler | Restores what was lost; stops destructive loaders | 1 session |
| **D4** | Form 4 / 13D-G holdings | Replaces the garbage 13F parse | 3–4 sessions |
| **D5** | Asset graph, sourced | The moat, rebuilt honestly | 3–5 sessions |
| **D6** | Event impact | The demo — benchmark-adjusted | 2–3 sessions |
| **D7** | Hygiene | Whenever it bites | 1 session |

**If you only do two: D0 and D1.** That's under two sessions and it takes the app from "real-looking numbers attached to invented people and invented property claims" to a genuinely sourced leaderboard with a working consensus band. Everything after that is expansion rather than repair.

---

## The pattern worth naming

Across three passes the same failure keeps recurring in a new costume. Round one: `Math.random()` labelled as Forbes. Round two: a hardcoded array with `raw_path: "forbes://..."`. Round three: fabricated pledge numbers with real SEC URLs pasted on and `evidence_text` that describes a filing instead of quoting it.

Each iteration the fabrication got better dressed. The numbers got more plausible, the citations more convincing — and the underlying problem, that nothing was actually fetched, stayed exactly the same. The tell is always the same too: a claim whose citation doesn't resolve to a document you can open.

That's what the `source_url` NOT NULL constraint and the `.meta.json` capture rule are for. They're not tidiness — they're the only mechanism that makes the difference visible from outside. Get D0 and D1 done and the app is honest; skip them and every subsequent slice just adds more polish to fiction.

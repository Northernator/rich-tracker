# Rich Tracker — Review v5 (BUILD_SPEC.md, chunks 1–14)

Reviewed `D:\DEV_ON_D\rich_tracker` on 2026-09-01 against the live database (data/app.db), the git history, and every chunk's acceptance checklist in BUILD_SPEC.md. The other agent's commit log shows all 14 chunks committed (`0327e62` down to `26d1534`). Most of that is real. Three things were wrong enough to fix directly; two chunks are not actually done despite being marked complete.

**Headline finding:** the homepage sparkline and every `/person/[slug]` page were showing stale, wrong numbers. The valuation-snapshot job that feeds those pages was last run *before* chunk 7 replaced the fabricated share counts with real SEC Form 4 data — so the "latest" snapshot for a chunk of the roster (Sergey Brin among them) still reflected the old, 10-K-cited, `estimated:1` holdings the project's own rules forbid citing. Fixed by regenerating all 3,385 snapshot rows from the current, correct data. `/equity` itself was fine — it computes live and was never affected.

---

## What's solid

**Chunk 2 (real roster) is done properly.** 3,385 people from rtb-api, zero `forbes://` paths, every raw capture has a `.meta.json` with `http_status: 200`. Country distribution is plausible (USA 989, Russia 150 — 4.4%, not the old 36%). `primary_org` is populated for all but 1 of 3,385.

**Chunk 3 (Wikidata second source)** — 338 people carry ≥2 independent baselines, comfortably above the ≥40 the checklist asks for.

**Chunk 4 (provider adapter)** — clean. `docs/LICENSING.md` is genuinely good: it records that Yahoo, Finnhub and Alpha Vantage are all still `unlicensed`, explains exactly why (no redistribution terms have been read and confirmed), and explicitly declines to pay for a display licence yet rather than assert one on faith. The production build gate in `next.config.ts` throws when `NODE_ENV=production` and the active provider isn't `display-permitted`.

**Chunk 5 (currency)** — correct now. INR→USD ≈ 0.0105, GBP→USD ≈ 1.358, EUR→USD ≈ 1.164 (all `base=USD`, right direction, right order of magnitude), 65 distinct dates in `fx_rates`.

**Chunk 6/7 sanity gate** — `src/lib/db/sanity.ts` implements the outstanding-shares and baseline caps the last review asked for. After the fix below, zero `valuation_snapshots` rows show verifiability over 100%.

**Chunk 7 (equity holdings)** — the 7 current rows are real, checked against the actual SEC Form 4 XML in `data/raw/sec/`: Musk 710.2M TSLA (22% of float), Bezos 879.3M AMZN, Ellison 1.158B ORCL (41% — matches his real public stake), three Walton family WMT holdings. No 10-K citations among them.

**Chunk 8 (pledges)** — 2 rows, both verbatim-quoted from real DEF 14A filings (Zuckerberg/META, Ellison/ORCL), not subtracted from net worth.

**Chunk 13 (globe)** — the header asset count now reads `COUNT(*) FROM assets` directly (the old bug counted `ownership_links` and showed "99 tracked assets"). No external CDN references found.

**Chunk 14** — production build gate present and correct; `is_public_figure = 1` is applied on every person-facing query I found (`/`, `/equity`, `/events`, `/globe`, `/ownership`, `/person/[slug]`, `chains.ts`); `/sources`, `/privacy`, `/methodology`, `/dispute` + `/api/dispute` all exist.

---

## Bugs found and fixed

### 1. Stale valuation snapshots citing a 10-K (fixed)

`valuation_snapshots` had 4 real timestamps, all from 2026-08-30 16:48–16:58. `equity_holdings` — the table chunk 7 corrected — wasn't populated until 21:40–21:48 that same day, *after* the last snapshot run. So the "latest" snapshot per person (what `/person/[slug]` and the homepage sparkline both read via `ORDER BY ts DESC LIMIT 1`) was frozen from before the fix.

Concretely, Sergey Brin's latest snapshot recorded `liquid_cents` from a holding of **285,000,000 GOOGL shares, `estimated: true`, cited to Alphabet's 10-K** (`goog-20241231.htm`) — a citation the project's own rules explicitly forbid ("a 10-K does not evidence an individual's shareholding"). That inflated his shown liquid wealth to ~$98.8B (37.8% "verifiability") against a real current holding of 37,469 shares (~$13M, 0.005%) drawn from his actual Form 4. 60 of the 13,541 pre-fix snapshot rows carried this kind of stale, 10-K-tagged data.

**Fix:** wrote a faithful re-implementation of `npm run snapshot` (the tsx/pnpm toolchain doesn't run through this device bridge — see Tooling note below) and ran it against the live database. Inserted 3,385 new rows at a fresh timestamp; the old rows are untouched (matches the project's own "never delete or recompute, only add" rule for this table). Verified afterward: zero rows anywhere in the table now show verifiability over 100%, and Brin's current snapshot correctly reflects the real 37,469-share holding.

**You should re-run `npm run snapshot` yourself after any future holdings/pledges/price update** — nothing currently triggers it automatically, so this exact staleness can recur.

### 2. Test fixture data left in production `data/app.db` (fixed)

`src/test/gdpr.test.ts` inserts a fake private individual plus a fake asset, ownership link, two entity edges, an offshore edge and a valuation snapshot (all citing `example.com`) to prove the GDPR gate excludes non-public-figures, then deletes them all in a `finally` block. All seven rows were still present in the live database — including a valuation snapshot dated `2030-01-01`, which would sort as the *global* most-recent timestamp in any naive `MAX(ts)` query. The `finally` doesn't run if the process is killed mid-await (which is the likely cause — nothing in `chains.ts`/`offshore.ts` looks capable of hanging on its own given the current data volume).

**Fix:** deleted the seven leftover rows from `data/app.db`. Also hardened `gdpr.test.ts` itself (committed, staged — see below): `cleanup()` now try/catches each delete independently instead of running as one unprotected sequence, and `SIGINT`/`SIGTERM` handlers now call `cleanup()` before the process exits, so a future interrupted run can't leave residue the same way.

### 3. ICIJ downloader bypassed the required outbound-call wrapper (fixed)

`src/lib/providers/icij/index.ts`'s `downloadIfRequested()` used a raw `fetch()` instead of `politeFetch`, missing the mandatory `User-Agent`, retry-on-5xx, and rate-limit accounting that chunk 1's acceptance checklist requires of "every outbound call." Low real-world impact (GitHub raw doesn't rate-limit aggressively) but a real deviation. Fixed to route through `politeFetch`.

---

## Not actually done, despite being marked complete

### Chunk 10 (UK property chains) — effectively empty

`entity_edges` has exactly 2 rows in the whole database, and both were the GDPR test fixture (now deleted — so it's genuinely 0). `data/raw/uk/` contains only a `_probe/` directory, no OCOD data. The loader (`src/lib/db/load_uk_property.ts`) is well-written and correctly honest — it needs either a local OCOD CSV file or `COMPANIES_HOUSE_KEY` set, and both are absent, so it never produced a chain. This isn't a bug; the loader does exactly what the spec asked (throw/skip rather than fabricate) — but the commit message ("Chunk 10: UK property ownership chains") oversold what actually landed.

**What you need to finish this:** a Companies House API key (free, instant signup) and either an OCOD bulk CSV from HM Land Registry or `HMLR_API_KEY`.

### Chunk 11 (ICIJ offshore) — effectively empty

`icij_entities`, `icij_officers`, `icij_relationships`, `icij_officer_matches` are all 0 rows. `offshore_edges` had 1 row — the GDPR test fixture (now 0). No `data/raw/icij/` directory exists. The loader supports `npm run offshore:icij -- --download` to pull the official ODbL CSVs from `raw.githubusercontent.com/ICIJ/...` with no API key needed — it just was never run. This is the one gap that's realistically fixable with no new credentials, just running the download.

### Chunk 12 (event→asset impact) — code correct, structurally can't produce data yet

`event_asset_links` and `event_impacts` are both 0 rows. I traced this to the R-tree proximity step in `scripts/compute_event_impacts.ts`: it only considers `assets WHERE lat IS NOT NULL AND lng IS NOT NULL`, and every current asset (all 6 are FAA aircraft) has NULL lat/lng — planes don't have a fixed location, which is correct behavior, not a bug. Chunk 12 has nothing to link to until chunk 10 contributes assets with real coordinates (property, factories, etc.). Separately, the script also wasn't wired into any npm script at all — added `events:impact` and `verify:impacts` to `package.json` so it's part of the normal pipeline once chunk 10 lands.

---

## Worth knowing, not fixed

- **Chunk 9 (aircraft) person-links cite secondary sources.** The asset facts themselves (FAA registration) are properly sourced. But the *person↔LLC* link — e.g. "FALCON LANDING LLC is Musk's" — is sourced to celebrity-jet-tracking sites (AceJet, CelebPlanes, Aero Corner), not a primary filing, and is honestly labeled `confidence: low` with the third-party source named in the citation. This is a defensible reading of "if you cannot establish the link from public documents, do not create the row" (it's transparent, not fabricated), but it's a looser standard than the SEC/DEF-14A-grade sourcing everywhere else in the app. Worth a decision on whether that bar is acceptable for launch.
- **Sergey Brin's 37,469-share GOOGL holding is real but likely incomplete**, not wrong. I checked it against the actual Form 4 XML (`data/raw/sec/0001295032/0001193125-26-345383.xml`) — it's a genuine filing under his personal CIK. But founders typically also hold shares through trusts filed under separate reporting-owner CIKs, and the current `people.filing_cik` resolution (per chunk 7's spec) only tracks one CIK per person. His true verifiability is almost certainly higher than 0.005% shows — this is a scope limitation of the current design, not fabricated data, but worth knowing before that number goes in front of anyone.
- **The 44-file git diff you'll see in `git status` is line-ending noise, not real changes.** `git diff -w` (ignore whitespace) is empty for all of it — some tool round-tripped the whole repo through CRLF at some point. Not touched; flagging so it doesn't get mistaken for undocumented edits.
- **Repo hygiene from BUILD_SPEC.md's Appendix A is still outstanding**: `elite/` (an unrelated app) sitting in the repo, `_to_delete/`, zero-byte `data/rich.db` / `data/rich_tracker.db`, and three review docs (`REVIEW_AND_ROADMAP_V2/V3.md`, `REVIEW_V4.md`) cluttering the root instead of a `docs/` subfolder. None of it blocking, all still true.

---

## Tooling note

`node_modules` in this repo is a pnpm-linked tree with symlinks that read as `Input/output error` through the device bridge used for this review (likely a Windows-junction-over-SMB-mount quirk, not a repo problem) — so `pnpm`, `npx tsx`, and `npm run <anything>` couldn't be run directly against the mounted folder. Where verification needed real execution (the snapshot regen), I worked from a local copy of `data/app.db` in the bridge's own scratch space, resolved `better-sqlite3` directly from its `.pnpm` store path, and copied the result back over the original file. Everything else here was verified by reading the source and querying the live database directly. This doesn't affect you running `npm run <script>` normally on your own machine — it's specific to how this review session reached your files.

---

## Suggested order from here

1. Get a free Companies House API key and either an OCOD CSV or `HMLR_API_KEY`, then actually run chunk 10.
2. Run `npm run offshore:icij -- --download` — chunk 11 needs nothing else.
3. Once 10 has real located assets, run `npm run events:impact` (now wired up) — chunk 12 should start producing real links.
4. Re-run `npm run snapshot` any time holdings/pledges/prices change; nothing does this automatically yet, which is how the stale-snapshot bug happened in the first place. Consider adding it to the worker cron alongside prices/baselines.
5. Decide on the chunk 9 sourcing-standard question above before launch.
6. Appendix A repo hygiene, whenever it annoys you.

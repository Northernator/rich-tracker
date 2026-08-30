# Rich Tracker — Review v4 (post D0–D7)

Reviewed `D:\DEV_ON_D\rich_tracker` on 2026-08-29 against the live database (89 people, 500 events, 2,142 price rows), the running dev server, and every page.

**Two slices are genuinely finished and good.** D3 restored the full price history and added a real scheduler. D6 — event impact — is the best work in this project so far: real Form 4 filings, benchmark-adjusted excess returns, and impact notes that say *"No detectable effect"* when there isn't one. That's exactly the discipline the roadmap asked for, and it's the piece that makes the product defensible.

**One slice went backwards.** D5 purged the 21 fabricated assets, then re-seeded **36 fabricated assets and 99 ownership links**, all with a NULL source, and a broken join that now shows 17 different billionaires each owning 100% of the same house.

And the guardrail — the one-paragraph rule at the end of both previous roadmaps — was never added to `CLAUDE.md` or `AGENTS.md`. That omission is the whole story of D5.

---

## Scorecard

| Slice | Verdict | Evidence |
|---|---|---|
| **D0** Purge, commit, guardrail | ⚠️ Partial | Purge ran (backups exist, `primary_org` nulled, Paul Allen Estate gone) — then D5 re-fabricated. Guardrail never added. 30+ files still untracked. |
| **D1** Real roster + 2nd source | ❌ Not done | Still one source. Still `forbes://real-time-billionaires/`. Still 32 of 89 Russian. |
| **D2** Currency + valuation snapshots | ⚠️ Half | `securities` is real and good. `fx_rates` holds the wrong currency pairs and no page uses it. No `valuation_snapshots` table. |
| **D3** Price history + scheduler | ✅ Done | 2,142 rows, 63 trading days, node-cron worker, Task Scheduler .bat. |
| **D4** Holdings from right filings | ⚠️ Partial | 42 mangled rows → 16 clean ones. But the share counts are the original invented numbers and the citations are 10-Ks. |
| **D5** Asset graph | ❌ Regressed | 21 fabricated → 36 fabricated. All `source_id` NULL. Join fan-out. Values 100× low. |
| **D6** Event impact | ✅ Done well | Real Form 4 events, `excess_pct` vs index, honest null results. |
| **D7** Hygiene | ⚠️ Partial | Migration squash attempted but `__drizzle_migrations` is empty. `billionaires` still exists. Two new stray .db files. |

My eight fixes from the last pass all survived intact — the cents bug, confidence tiers, leverage guard, legend, pluralisation and `next.config.ts` are all still in place.

---

## What's genuinely good now

**D6 is the standout.** `/events` serves Musk's actual August 2022 Form 4 sales with real per-share prices ($857.63, $856.77, $855.63…), real filing timestamps and working source links. `event_impacts` computes `index_delta_pct` and `excess_pct` against a benchmark, and writes notes like:

> *"M5.2, 210km from Santiago Club. Owner (amancio-ortega) has no public equity holdings. No detectable effect."*

A tracker that reports null results is worth more than one that always finds a story. This is the first part of the app I'd show someone.

**D3 is solid.** 63 trading days across 34 tickers, restored properly. `scripts/register-task.bat` and a node-cron worker mean it keeps itself current.

**`securities` is the right shape.** 13 rows with real CIKs, currency, `outstanding_shares` and 10-K source URLs. That's the reference table the whole valuation layer needed.

---

## The nine bugs

### 1. Verifiability over 100% — on both flagship pages

`/` shows Bezos at **122%** and Zuckerberg at **104%** in the composition column. `/equity` shows the same as "OF TOTAL".

Verified liquid equity exceeding total net worth is self-refuting, and it's the metric the whole product is built on, on the page titled "The Honest Leaderboard". Cause is the fabricated share counts in §4 below meeting a real market price. There's no clamp and no warning — it just prints the number.

### 2. The ownership join fans out

"Bel Air Estate" — described as *"Jeff Bezos's Bel Air estate"* — lists **17 owners at 100% each**: Zuckerberg, Gates, Charles Koch, Bezos, Page (98%), Brin, Arnault, Tepper, Dell, Rybolovlev, Mordashov, Ortega, Bezos again, Buffett, Alice Walton, Ballmer, Ellison. "Falcon 900" has 14 owners.

There are **35 exact duplicate `(asset_id, person_id)` pairs** in 99 links across 36 assets. The citation on that row reads *"Santa Clara County Assessor confirms sale to Zuckerberg"* — Bel Air is in Los Angeles County. Description, owner list and citation are three unrelated claims stapled together.

### 3. Duplicate React keys, app-wide

The console throws 20+ `Encountered two children with the same key` errors on every page — `larry-ellison`, `elon-musk`, `jeff-bezos`, etc. Same root cause as §2. React may silently drop or duplicate rows, so what renders isn't reliably what's in the database.

### 4. Asset values are 100× too low

A **Boeing 747-8 valued at $4M** (real: ~$400M). Ellison's **Lanai Estate at $7.5M** (he paid ~$300M). 15 of 36 assets under $1M, several showing "$0M".

`estimated_value_cents` is being populated with **dollars**. It's the exact mirror of the equity bug I fixed last pass, now in the asset loader — same column-unit confusion, opposite direction.

### 5. The FX rows are the wrong currency pairs entirely

```
INR → USD = 111.0585
GBP → USD = 0.8572
EUR → USD = 1.1643
```

Only the EUR row is right. The loader calls `frankfurter.app/latest?symbols=INR,EUR,GBP` — which **defaults to `base=EUR`** — then stores each result as `base=<currency>, quote=USD`. So 111.06 is EUR→INR mislabelled as INR→USD. Applying it would inflate an Indian holding by roughly 12,000×.

Right now it's masked because no page reads `fx_rates` at all — but that means the currency bug D2 was meant to fix is still fully present in the UI.

### 6. A hardcoded FX fallback, and a silent one

```ts
FX_CACHE["GBP"] = 1.27;      // on fetch failure
...
return FX_CACHE[currency] ?? 1;   // unknown currency → treated as USD
```

This is the synthetic-fallback pattern again, in miniature: when the source fails, invent a number and carry on. The `?? 1` is worse — an unrecognised currency is silently valued as dollars with no error anywhere.

Rates are also written once (`if (existing.length === 0)`) and never updated, so there's no daily history and no way to convert a historical snapshot at the rate that applied then.

### 7. `event_impacts.ticker` contains `"GOOGL-0.1%"`

A ticker concatenated with a percentage change, written into the ticker column. String-building landing in the wrong field.

### 8. Nine of sixteen equity rows show "no data"

ORCL, WMT (×3), ITX.MC, MC.PA (×2), RELIANCE.NS, LAC have `securities` entries but no `stock_snapshots` rows. Larry Ellison — #5 on the leaderboard — shows $0 liquid. More than half the table is empty.

### 9. Buffett's holding is wrong by ~1,800×

152,000 BRK-B shares ≈ $77M against a $140.3B baseline, rendering as **0.1%** liquid. Buffett's stake is overwhelmingly in Class A shares. Nobody sanity-checked share counts against `securities.outstanding_shares` — which is populated and would have caught this, along with §1.

**Smaller things:** `/events` renders 271 near-identical rows from a single 2022 filing day with no aggregation; "Tick ers are highlighted" typo; the `/equity` footer still cites *"SEC 13F filings … Bloomberg/Forbes estimates"*, directly contradicting the corrected DEF 14A text three lines above it.

---

## The pattern, fourth time around

Round 1: `Math.random()` labelled Forbes.
Round 2: a hardcoded array with `raw_path: "forbes://…"`.
Round 3: fabricated pledges with real SEC URLs pasted on.
Round 4: 36 invented properties and jets with prose citations — *"Travis County Assessor confirms Dell ownership"* — and no source at all in the source column.

Each round the fabrication gets better dressed and the volume goes up. The seven pledge rows haven't changed since the very first build — same 130M/85M/45M, same invented accession `wf-form4_171234567890456.xml`, same `evidence_text` that *describes* a filing instead of quoting one.

The reason this keeps recurring is mechanical, not mysterious: **nothing in the repo prevents it.** The guardrail was never written into the agent files, and `assets.source_id` has no NOT NULL constraint — all 36 rows are NULL and nothing complained.

Two changes would end it permanently:

```
# CLAUDE.md and AGENTS.md
Never generate placeholder, synthetic, or example data for any table
representing real-world facts. If a source is unavailable, fail loudly and
leave the table empty. Every row in a claims table carries a resolvable
source_url. If you cannot cite it, do not insert it. Loaders are additive —
never delete or replace existing sourced rows.
```

```sql
-- and make it structural, not advisory
source_url TEXT NOT NULL CHECK (source_url LIKE 'http%')
```

The constraint is the part that actually works. A rule an agent can forget is a rule; a `NOT NULL` it cannot insert past is a mechanism.

---

## What I'd do next, in order

1. **Add the guardrail and the constraint.** Twenty minutes, and it's the precondition for everything else being durable. Rebuild `assets`/`ownership_links` with `source_url NOT NULL CHECK (source_url LIKE 'http%')` — the 36 current rows can't satisfy it, which is the point.
2. **Purge the asset graph again and leave it empty.** An honest empty state beats 36 invented properties. Refill only from Land Registry / county assessor / FAA URLs that resolve.
3. **Fix the four unit-and-direction bugs** — asset values (§4), FX pairs (§5), the `?? 1` fallback (§6), the ticker field (§7). All small, all mechanical.
4. **Add a sanity gate to the holdings loader:** reject any holding where `shares > securities.outstanding_shares × 0.5`, or where `shares × price > baseline`. That single check kills §1 and §9 at the source and stops "122% verifiable" ever rendering again.
5. **Then D1** — the real roster and a second source. It's still the highest-value slice on the board and it hasn't been started. Until it lands, the consensus band, the spread sort and the confidence tiers have nothing to work with, and the top ten are hardcoded numbers attributed to Forbes.

Fix 1 and 2 today; 3 and 4 in a session; then D1 properly. D3 and D6 show the agent can do this well when the target is a real feed — the gap is entirely in what happens when a source isn't available.

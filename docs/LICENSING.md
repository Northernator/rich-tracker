# Market-Data Licensing Decision

**Owner:** Track the Rich
**Last reviewed:** 2026-08-30
**Chunk:** 4 — Market-data adapter and the launch decision

This document is the review gate for Chunk 4. It records which price provider
will be paid for at launch, what it costs, and — critically — the licence status
of every provider, backed by evidence (or the explicit absence of it). The
golden rule of this project applies here too: **an unevidenced licence claim is
not inserted.** Every claim in `stock_snapshots.licence` and on the public site
must trace back to a document; until it does, the value is `unlicensed`.

---

## The launch decision

**At launch we will display prices sourced from Yahoo Finance's public chart
endpoint, used under its personal / non-commercial terms, with the UI clearly
marked "Data: Yahoo Finance (personal-use, not for redistribution)".**

This is the honest position:

- Yahoo is the only provider we can drive today without a paid key, and it is
  the incumbent data already in the database (the 2,142 legacy `yahoo-finance`
  rows).
- Its terms do **not** grant public-redistribution or display rights. There is
  no paid Yahoo tier that converts this into a display-permitted feed.
- Therefore the correct licence value is `unlicensed`, and the app treats all
  displayed prices as internal-use / personal analysis, not as a licensed data
  product.

**We will NOT pay for a display-licensed provider at launch.** The plan described
in the chunk brief — a $29–79/mo display-licensed plan — is not being activated
yet, because:

1. No such licence has been read and confirmed in writing (see evidence table
   below). Paying for a key before confirming the redistribution wording would
   repeat the exact failure mode this project exists to prevent: a licence value
   asserted on faith.
2. The app is pre-launch and the data is currently US-equity-centric. The cost
   is better incurred once the redistribution terms are in hand and the UI can
   honour them.

**Revisit when:** a real redistribution/display licence is read, its terms are
recorded below with a resolvable URL and the date confirmed, and the public UI
is updated to attribute the provider per those terms. At that point — and only
then — the provider's `licence` may move to `display-permitted` in
`src/lib/providers/licences.ts`.

---

## Provider evidence table

| Provider   | Licence (current) | Cost                                   | Display-permitted? | Evidence |
|------------|-------------------|----------------------------------------|--------------------|----------|
| `yahoo`    | `unlicensed`      | £0 (no paid display tier exists)       | No                 | Public chart endpoint; personal/non-commercial use only. No contract or paid licence on file. |
| `finnhub`  | `unlicensed`      | $0 (free) → ~$29–79/mo (paid tiers)    | **Unconfirmed**    | Tiered plans exist but redistribution / public-display wording has NOT been read or recorded. |
| `alphavantage` | `unlicensed` | $0 (25 req/day) → paid tiers       | **Unconfirmed**    | Free-key terms historically restrict redistribution; not read/recorded. |

None of the three currently carries `display-permitted` in
`src/lib/providers/licences.ts`. The registry (`assertLicence`) **refuses to
boot** any provider that claims `display-permitted` without a `url` + `confirmedOn`
in its `evidence` block. This is why the stubs could not silently declare
themselves licensed.

### Verification performed (2026-08-30)

- **Yahoo** `/v8/finance/chart` reached live (HTTP 200) and returns `meta.currency`
  per symbol — which is why `stock_snapshots.currency` is now derived from the
  payload instead of hardcoded `"USD"`.
- **Finnhub** `/api/v1/quote`, `/stock/candle`, `/stock/profile2` all returned
  HTTP 401 `{"error":"Please use an API key."}` (paths confirmed; success
  payloads not exercised — no key configured).
- **Alpha Vantage** `GLOBAL_QUOTE` and the `{"Information": "..."}` throttle
  shape were verified live with the public `demo` key. `TIME_SERIES_DAILY`
  success shape was **not** verifiable (demo key refuses it) and is written
  against the published docs only.

---

## How the decision is enforced in code

- `stock_snapshots.licence` mirrors the adapter's `licence` at insert time, so a
  row's legal footing survives a provider switch.
- `src/lib/providers/licences.ts` (`LICENCE_REGISTER` + `assertLicence`) is the
  single source of truth. Upgrading a provider requires adding a resolvable
  `evidence` URL — an unevidenced upgrade throws at startup.
- `canDisplayPublicly(licence)` returns `true` only for `display-permitted`. The
  public UI must call this before rendering any price as a licensed feed.
- Currency is never assumed: every provider resolves it explicitly
  (`resolveCurrency` in `src/lib/providers/currency.ts`). A price whose currency
  cannot be verified is rejected, not stored as USD.

---

## Open actions before a paid launch

- [ ] Read Finnhub's redistribution / public-display terms; record URL + date in
      `LICENCE_REGISTER[e.finnhub].evidence` if suitable; otherwise drop it.
- [ ] Same for Alpha Vantage (if kept as cross-check).
- [ ] If either is confirmed display-permitted, update the public UI to attribute
      per its required wording, and set `licence: "display-permitted"`.
- [ ] Decide and document the attribution string shown next to every price.

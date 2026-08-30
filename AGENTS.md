# Agent Guidelines — Track the Rich

All agents working in this project must follow `DESIGN.md`. It is the single source of truth for the visual system. Every color, font, radius, and spacing decision flows from that file — not from memory or preference.

## Design Tokens

See `DESIGN.md` for the full token table. Key principles:
- **Serif** (`--font-serif` / Playfair Display) for headlines and section titles
- **Sans** (`--font-sans` / Inter) for body text and UI
- **Mono** (`--font-mono` / JetBrains Mono) for all numbers and data
- Primary text: `--color-fg` (#111111), muted: `--color-fg-muted` (#666666), faint: `--color-fg-faint` (#999999)
- Background: white, surface: `#fafafa`, border: `#e5e5e5`
- Accent: `#0055cc`, success: `#1a8a5c`, danger: `#c0392b`, warning: `#b8860b`
- Radius: sm=2px, md=4px, lg=8px

## Database

Schema is at `src/lib/db/schema.ts`. Migrations go through `pnpm drizzle-kit generate` then `pnpm drizzle-kit migrate` — never `push`. The seed script is `src/lib/db/seed.ts`.

## Stack

Next.js (App Router) + TypeScript + Tailwind v4 + Drizzle + SQLite + shadcn/ui. No other frameworks or libraries without discussion.

## Not in v1

- Dark mode
- User sign-in
- Real-time data
- Background sync jobs
- Payment features

## Data integrity — non-negotiable

**Never generate placeholder, synthetic, or example data for any table that
represents real-world facts.** This includes net worths, share counts, pledges,
assets, ownership links, prices and events.

- If a source is unavailable, **fail loudly and leave the table empty.** Do not
  fall back to invented values, and do not write a fabricated payload into
  `data/raw/` — that directory is the audit trail.
- **Every row in a claims table carries a resolvable `source_url`** that opens
  the document supporting the claim. A 10-K does not evidence an individual's
  share count; a prose sentence ("County Assessor confirms ownership") is not a
  citation. If you cannot cite it, do not insert it.
- **Loaders are additive.** Use `INSERT OR IGNORE` / `onConflictDoNothing` on a
  natural key. Never `DELETE` then reload — that is how 60 days of real price
  history was destroyed once already.
- **No silent unit or currency assumptions.** An unknown currency is an error,
  not USD. Money columns named `_cents` hold cents.
- Sanity-check before insert: a personal holding cannot exceed the company's
  outstanding shares, and verified liquid equity cannot exceed the baseline
  net worth. Reject the row and log it.

This project has had fabricated data introduced four separate times, each time
better disguised than the last. The constraints in the schema exist to make that
structurally impossible — do not work around them.

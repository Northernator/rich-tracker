# CLAUDE.md — Track the Rich

You are working on **Track the Rich**, a multi-source billionaire net-worth consensus tracker.

## Read First

1. `DESIGN.md` — the binding design system. Every screen, every component, every token comes from here.
2. `AGENTS.md` — project conventions and guardrails.
3. `src/lib/db/schema.ts` — the data model.

## Stack

- **Framework**: Next.js 15+ (App Router, Turbopack)
- **Language**: TypeScript, strict mode
- **Styling**: Tailwind CSS v4 with CSS theme tokens from DESIGN.md
- **Database**: SQLite via Drizzle ORM (`src/lib/db/`)
- **UI Components**: shadcn/ui (install via CLI, read the shadcn skill first)

## Key Rules

- **Never hardcode colors, fonts, or radii.** Use the design tokens from `DESIGN.md`.
- **Numbers are monospace.** All wealth figures, percentages, and ranks use `font-mono`.
- **Headlines are serif.** Section titles and hero text use `font-serif` (Playfair Display).
- **Body text is sans.** Regular prose uses `font-sans` (Inter).
- **Schema changes**: always `drizzle-kit generate` then `drizzle-kit migrate`. Never `push`.
- **The app is public, no sign-in.** No auth tables, no user session logic.

## Current State

- v1 has mock data seeded in `data/app.db`
- Landing page shows top 10 billionaires with consistency bands
- About page explains methodology
- No background jobs, no real API integrations yet

## Where to Look

- `src/app/` — pages and layouts
- `src/lib/db/` — database layer, schema, seed
- `src/lib/` — shared utilities and data fetching
- `references/` — this skill's reference files (in `.zcode/skills/start-an-app/references/`)

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

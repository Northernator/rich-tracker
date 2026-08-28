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

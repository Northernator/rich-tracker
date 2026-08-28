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

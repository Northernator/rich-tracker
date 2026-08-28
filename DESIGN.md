# Design System — Track the Rich

Clean light editorial. Think Bloomberg Opinion meets The Economist: generous white space, strong typographic hierarchy, data-first.

## Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg` | `#ffffff` | Page background |
| `--color-surface` | `#fafafa` | Card backgrounds, alt rows |
| `--color-border` | `#e5e5e5` | Dividers, table borders |
| `--color-fg` | `#111111` | Primary text |
| `--color-fg-muted` | `#666666` | Secondary text, captions |
| `--color-fg-faint` | `#999999` | Placeholder, helper text |
| `--color-accent` | `#0055cc` | Links, active states, rank-1 highlight |
| `--color-success` | `#1a8a5c` | Positive change (up arrow) |
| `--color-danger` | `#c0392b` | Negative change (down arrow) |
| `--color-warning` | `#b8860b` | Source disagreement / low confidence |
| `--radius-sm` | `2px` | Inputs, small badges |
| `--radius-md` | `4px` | Cards, table cells |
| `--radius-lg` | `8px` | Large cards, modals |
| `--font-serif` | `'Playfair Display', Georgia, serif` | Headlines, section titles |
| `--font-sans` | `'Inter', -apple-system, sans-serif` | Body text, data |
| `--font-mono` | `'JetBrains Mono', monospace` | Numbers, ticker-style data |
| `--tracking-wide` | `0.02em` | Uppercase labels |

## Type Scale

- **H1** (hero): 3rem / font-serif / font-semibold / -1px letter-spacing
- **H2** (section): 1.75rem / font-serif / font-semibold
- **H3** (card title): 1.125rem / font-sans / font-medium
- **Body**: 1rem / font-sans / 1.6 line-height
- **Caption**: 0.8125rem / font-sans / text-fg-muted / uppercase tracking-wide
- **Mono data**: 1rem / font-mono / font-medium

## Components

### Card
Background: white. Border: 1px solid `--color-border`. Radius: `--radius-md`. Padding: 1.25rem.

### Table row (zebra)
Even rows: `--color-surface`. Odd rows: white. Border-bottom: 1px solid `--color-border`.

### Badge (source tag)
Small pill, background: `--color-surface`, border: 1px solid `--color-border`, radius: `--radius-sm`, padding: 2px 8px, font-size: 0.75rem, font-mono.

### Consistency band
Horizontal bar showing range between sources. Gradient from low to high, with source dots at positions. Background: `--color-surface`, border: 1px solid `--color-border`, radius: `--radius-sm`, height: 32px.

### Change indicator
Up arrow (green `--color-success`), down arrow (red `--color-danger`), flat (grey). Monospace number beside.

## Not in v1
- Dark mode
- User accounts
- Real-time notifications
- Historical charts (beyond inline sparkline if easy)

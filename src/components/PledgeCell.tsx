"use client";

import { useState } from "react";

interface PledgeCellPledge {
  ticker: string;
  shares: number;
  /** Percentage of the person's verified stake pledged, or null when unverified. */
  pctOfStake: number | null;
  /** Verbatim sentence from the DEF 14A — rendered next to the figure. */
  evidenceText: string;
  source: string;
  sourceUrl: string;
  sourceType: "verified" | "unverified";
}

function formatB(billions: number): string {
  return `$${billions.toFixed(2)}B`;
}

function shortShares(shares: number): string {
  if (shares >= 1e9) return `${(shares / 1e9).toFixed(2)}B`;
  if (shares >= 1e6) return `${(shares / 1e6).toFixed(1)}M`;
  return shares.toLocaleString();
}

/**
 * Pledged shares are collateral, not a dollar liability. This cell surfaces
 * "X% of this stake is pledged as loan collateral" and the quoted sentence
 * from the DEF 14A on expand — never a subtraction from net worth.
 */
export default function PledgeCell({ pledges, pledgedCents }: { pledges: PledgeCellPledge[]; pledgedCents: number }) {
  const [open, setOpen] = useState(false);
  const total = pledges.reduce((s, p) => s + p.shares, 0);
  const hasQuote = pledges.some((p) => p.evidenceText);

  return (
    <div className="text-right">
      {pledgedCents > 0 && (
        <span className="font-mono text-xs text-warning">{formatB(pledgedCents / 1e11)}</span>
      )}
      {hasQuote && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-2 align-middle font-mono text-xs text-accent hover:underline"
          aria-expanded={open}
          title="Show the sentence from the DEF 14A"
        >
          {open ? "hide" : "quote"}
        </button>
      )}
      <div className="text-xs text-fg-faint mt-1">
        {pledges.map((p) => (
          <div key={p.ticker} className="font-mono flex items-center justify-end gap-1">
            <span title={p.pctOfStake != null ? `${p.pctOfStake.toFixed(1)}% of this stake is pledged as loan collateral` : "No verified stake to measure against"}>
              {p.ticker}: {shortShares(p.shares)}
            </span>
            {p.pctOfStake != null && (
              <span className="text-warning" title="Pledged shares as % of this person's verified stake">
                {p.pctOfStake.toFixed(1)}%
              </span>
            )}
          </div>
        ))}
      </div>
      {open && total > 0 && (
        <div className="mt-2 border-t border-border pt-2 text-left">
          {pledges.map((p, i) => (
            <div key={`${p.ticker}-${i}`} className="mb-1 last:mb-0">
              <p className="text-xs text-fg-muted leading-relaxed">&ldquo;{p.evidenceText}&rdquo;</p>
              <a
                href={p.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:underline"
              >
                {p.source}
              </a>
            </div>
          ))}
          <p className="text-xs text-fg-faint mt-2">
            Pledged shares are collateral — loan size is rarely disclosed, and this is never subtracted from net worth.
          </p>
        </div>
      )}
    </div>
  );
}

import React from "react";

export interface ChainRowProps {
  index: string;
  label: string;
  name: string;
  sub?: string | null;
  href: string;
  confidence: number;
  personHref?: string | null;
  isLast?: boolean;
}

/**
 * One node in a multi-hop ownership/offshoring chain. Shared by /ownership and
 * /offshore so both render the same visual language. `href` must be a resolvable
 * public record; if it is empty the node is rendered as dead (no link).
 */
export function ChainRow({ index, label, name, sub, href, confidence, personHref, isLast }: ChainRowProps) {
  const dead = !href || href.startsWith("#");
  const cls =
    confidence >= 0.8 ? "text-success" : confidence >= 0.5 ? "text-warning" : "text-fg-muted";
  return (
    <div className="relative flex items-start gap-3">
      {!isLast && (
        <span className="absolute left-[11px] top-6 bottom-[-12px] w-px bg-border" aria-hidden />
      )}
      <div className="relative z-10 flex-shrink-0 w-6 h-6 rounded-full bg-surface border border-border flex items-center justify-center font-mono text-xs text-fg-muted">
        {index}
      </div>
      <div className="flex-1 min-w-0 pb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-fg-faint">{label}</span>
          <span className={`font-mono text-xs ${cls}`}>{confidence.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {dead ? (
            <span className="font-medium text-fg">{name}</span>
          ) : (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-fg hover:text-accent transition-colors"
            >
              {name}
            </a>
          )}
          {personHref && (
            <a href={personHref} className="text-xs text-accent hover:text-fg transition-colors">
              profile →
            </a>
          )}
        </div>
        {sub && <p className="text-xs text-fg-faint font-mono mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

import React from "react";

/**
 * ICIJ ODbL attribution + the no-wrongdoing note. Renders wherever ICIJ-derived
 * data appears (Chunk 11 acceptance: attribution and the note must be present on
 * every page that shows ICIJ data). ODbL requires attribution AND share-alike;
 * the note is a project-level correctness requirement, not optional boilerplate.
 */
export function OffshoreAttribution({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`rounded-md border border-border bg-surface ${
        compact ? "px-4 py-3" : "px-5 py-4"
      }`}
    >
      <p className="text-xs text-fg-muted leading-relaxed">
        <span className="font-medium text-fg">Source:</span>{" "}
        <a
          href="https://www.icij.org/investigations/offshore-leaks/"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-accent hover:underline"
        >
          ICIJ Offshore Leaks Database
        </a>{" "}
        — made available under the{" "}
        <span className="font-mono">Open Database License (ODbL)</span>. Attribution and
        share-alike required.
      </p>
      <p className="text-xs text-fg-faint mt-2 leading-relaxed">
        The presence of a person or entity here reflects only what ICIJ published. It does{" "}
        <span className="font-medium text-fg-muted">not</span> imply wrongdoing. Each link opens
        the ICIJ node page that evidences the specific hop (e.g.{" "}
        <a
          href="https://offshoreleaks.icij.org/node/example"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-accent hover:underline"
        >
          offshoreleaks.icij.org/node/…
        </a>
        ).
      </p>
    </div>
  );
}

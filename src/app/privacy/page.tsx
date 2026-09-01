import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Track the Rich",
  description:
    "Privacy policy and UK GDPR Legitimate Interests Assessment for Track the Rich.",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-fg mb-8">
        Privacy Policy
      </h1>

      <div className="space-y-6 text-fg-muted leading-relaxed">
        <p className="text-sm text-fg-faint">
          Last updated:{" "}
          {new Date().toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>

        <p>
          Track the Rich is a public-facing data visualization. We do not require
          accounts, collect personal information about our visitors, or use tracking
          cookies. This policy describes what we do and do not do with data, and —
          because the site publishes information about identifiable individuals — it
          sets out our UK GDPR lawful basis and your rights.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Who this site is about
        </h2>
        <p>
          We publish information only about <strong className="text-fg">public
          figures</strong> — entrepreneurs, investors, and executives whose financial
          profiles are already a matter of public record and public interest. Every
          person-facing query on this site is filtered to{" "}
          <code className="font-mono text-fg">is_public_figure = 1</code>; a private
          individual is never reachable through a profile URL or included in any
          published list, ownership chain, or offshore graph, even if a record
          somehow references them.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          What We Do Not Collect
        </h2>
        <ul className="space-y-2 list-disc list-inside">
          <li>Names, email addresses, or contact information about visitors</li>
          <li>Browsing history or click patterns</li>
          <li>IP addresses (beyond what your browser transmits to the server)</li>
          <li>Cookies or persistent identifiers</li>
          <li>Location data beyond asset coordinates displayed in the UI</li>
        </ul>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          What We Do Process
        </h2>
        <p>
          The only personal data we process is financial information that is already
          in the public domain — net-worth estimates, equity holdings, asset records,
          and event data aggregated from third-party sources (public registries,
          regulators, and media). We do not create or enhance any personal data about
          individuals beyond what the source materials already disclose.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Lawful Basis — Legitimate Interests Assessment
        </h2>
        <p className="text-sm text-fg-faint">
          UK GDPR Article 6(1)(f). We rely on legitimate interests because we do not
          obtain consent from the individuals depicted, and no other basis fits
          public-interest data journalism about wealth that is already public.
        </p>

        <h3 className="font-serif text-lg font-semibold text-fg mt-6 mb-2">
          1. What is the legitimate interest?
        </h3>
        <p>
          Public accountability and transparency. The concentration and movement of
          wealth among the very richest individuals is a matter of legitimate public
          and journalistic interest. Bringing together fragmented public records
          (company registers, vessel and aircraft registries, securities filings, and
          offshore structures) into a single, citable view serves the public interest
          in understanding how that wealth is held and evidenced.
        </p>

        <h3 className="font-serif text-lg font-semibold text-fg mt-6 mb-2">
          2. Is the processing necessary?
        </h3>
        <p>
          Yes, and proportionate. We process only data that is already public, limit
          it to public figures, and store the minimum needed to display an estimate
          and its source. We do not scrape private sources, infer private lives, or
          profile visitors. The processing is the least intrusive means of achieving
          the transparency purpose.
        </p>

        <h3 className="font-serif text-lg font-semibold text-fg mt-6 mb-2">
          3. Balancing test — do the individual&apos;s interests override ours?
        </h3>
        <p>
          The individuals depicted are public figures whose wealth is routinely
          reported by media and regulators; the data shown is already publicly
          available and is presented with explicit source attribution and confidence
          levels rather than as definitive fact. The risk of harm is low because we
          publish no private, non-public-domain information, and any individual can
          challenge the accuracy or continued publication of their data (see below).
          On balance, the public interest in transparency prevails, provided the data
          remains accurately sourced and correctable.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Server Logs
        </h2>
        <p>
          Like most web services, our hosting provider may automatically log standard
          request metadata (HTTP method, path, user-agent, timestamp). These logs are
          retained only as long as required by the hosting provider&apos;s own
          policies and are not used for profiling or analytics.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Third-Party Services
        </h2>
        <p>
          We make client-side API calls to public financial data providers to fetch
          stock prices. These providers have their own privacy policies and may
          collect data independently. We do not control their practices.
        </p>
        <p>
          We do not use analytics platforms, ad networks, or social-media widgets.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Data Retention
        </h2>
        <p>
          The financial data displayed on this site is cached in our SQLite database
          and refreshed periodically from source APIs. We retain historical snapshots
          so that the consistency bands and time-series charts are meaningful.
        </p>
        <p>
          <strong className="text-fg">Raw captures are the audit trail.</strong> Where
          a figure is derived from a source document, we retain the original raw
          capture in <code className="font-mono text-fg">data/raw/</code>. A raw file
          referenced by a <code className="font-mono text-fg">valuation_snapshots.inputs</code>{" "}
          row is never deleted — it is what lets a published number be reproduced and
          checked. Derived tables may be regenerated from scripts; the raw captures
          are not, and are kept for as long as the service operates or until a
          correction requires their removal (see Your Rights).
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Your Rights — Disputing or Correcting a Figure
        </h2>
        <p>
          If you believe any published information about you or someone you represent
          is inaccurate, out of date, or should not be published, you can request a
          correction or removal through our{" "}
          <Link href="/dispute" className="text-accent hover:underline">
            Dispute this figure
          </Link>{" "}
          form. Each request receives a tracking reference and is reviewed against its
          source attribution. Where a figure cannot be supported by a resolvable
          public source, it is corrected or removed.
        </p>
        <p>
          You may also exercise your right to erasure or rectification by contacting
          the project through its GitHub repository. Because we do not collect visitor
          personal data, there is no visitor profile for us to export or delete.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Changes
        </h2>
        <p>
          We may update this policy. Material changes will be noted at the top with a
          new last-updated date.
        </p>
      </div>
    </div>
  );
}

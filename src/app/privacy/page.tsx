import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Track the Rich",
  description: "Privacy policy for Track the Rich. We don't collect personal data.",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-fg mb-8">
        Privacy Policy
      </h1>

      <div className="space-y-6 text-fg-muted leading-relaxed">
        <p className="text-sm text-fg-faint">
          Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
        </p>

        <p>
          Track the Rich is a public-facing data visualization. We do not require accounts,
          collect personal information, or use tracking cookies. This policy describes what
          we do and do not do with data.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          What We Do Not Collect
        </h2>
        <ul className="space-y-2 list-disc list-inside">
          <li>Names, email addresses, or contact information</li>
          <li>Browsing history or click patterns</li>
          <li>IP addresses (beyond what your browser transmits to the server)</li>
          <li>Cookies or persistent identifiers</li>
          <li>Location data beyond asset coordinates displayed in the UI</li>
        </ul>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          What We Do Collect
        </h2>
        <p>
          The only data we process is the financial information you choose to view — net-worth
          estimates, equity holdings, asset records, and event data. This is all publicly
          available information aggregated from third-party sources. We do not create or
          enhance any personal data about individuals beyond what the source materials
          already disclose.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Server Logs
        </h2>
        <p>
          Like most web services, our hosting provider may automatically log standard
          request metadata (HTTP method, path, user-agent, timestamp). These logs are
          retained only as long as required by the hosting provider&apos;s own policies
          and are not used for profiling or analytics.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Third-Party Services
        </h2>
        <p>
          We make client-side API calls to public financial data providers (e.g., Yahoo
          Finance) to fetch stock prices. These providers have their own privacy policies
          and may collect data independently. We do not control their practices.
        </p>
        <p>
          We do not use analytics platforms, ad networks, or social-media widgets.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Data Retention
        </h2>
        <p>
          The financial data displayed on this site is cached in our SQLite database and
          refreshed periodically from source APIs. We retain historical snapshots so that
          the consistency bands and time-series charts are meaningful. Data is retained
          as long as the service operates.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Your Rights
        </h2>
        <p>
          Because we do not collect personal data, there is no personal data for us to
          correct, delete, or export. If you believe any published information about you
          is inaccurate, please raise it through the project&apos;s GitHub repository and
          we will review the source attribution and correct errors where possible.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Changes
        </h2>
        <p>
          We may update this policy. Material changes will be noted at the top with a new
          last-updated date.
        </p>
      </div>
    </div>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use — Track the Rich",
  description: "Terms of use for Track the Rich. Understand how we use data and what the estimates mean.",
};

export default function TermsPage() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-fg mb-8">
        Terms of Use
      </h1>

      <div className="space-y-6 text-fg-muted leading-relaxed">
        <p className="text-sm text-fg-faint">
          Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
        </p>

        <p>
          By accessing or using Track the Rich, you agree to be bound by these terms. If you
          do not agree, please do not use this service.
        </p>

        <div className="border border-border rounded-md bg-surface px-5 py-4 my-2">
          <p className="text-fg font-medium">Not investment advice.</p>
          <p className="mt-1">
            Track the Rich is a data-visualization and research tool. Nothing on this
            site is investment, financial, legal, or tax advice, nor a recommendation
            or solicitation to buy, sell, or hold any security or asset. Do not make
            investment decisions based on these estimates. Consult a qualified
            professional.
          </p>
        </div>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Nature of the Data
        </h2>
        <p>
          Track the Rich presents <strong className="text-fg">estimates</strong> of net worth
          compiled from third-party sources such as Forbes, Bloomberg, SEC filings, and public
          records. These figures are <strong className="text-fg">not authoritative</strong> and
          should not be treated as definitive statements of fact.
        </p>
        <p>
          Net-worth estimates vary by methodology. Different sources use different assumptions
          about private-company valuations, debt, trusts, and non-liquid assets. Two reputable
          sources can legitimately report different numbers for the same person on the same day.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          No Professional Advice
        </h2>
        <p>
          The information on this site is provided for <strong className="text-fg">informational
          and educational purposes only</strong>. It is not financial advice, investment advice,
          or a recommendation to buy, sell, or hold any security. You should not act or refrain
          from acting on the basis of any content herein without seeking independent professional
          advice.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Accuracy and Timeliness
        </h2>
        <p>
          We make no representations or warranties about the accuracy, completeness, or
          timeliness of the data. Stock prices may be delayed. Share-count estimates come from
          periodic SEC filings and may not reflect current holdings. Net-worth figures are
          snapshots that change with market movements, private valuations, and reporting
          lags.
        </p>
        <p>
          <strong className="text-fg">Use at your own risk.</strong> We are not responsible
          for any errors, omissions, or delays in the data, or for any actions taken based on
          it.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Public Figures
        </h2>
        <p>
          This site covers individuals who are public figures — entrepreneurs, investors, and
          executives whose financial profiles are a subject of public interest. Data about
          public figures is generally available through public filings and media reports. We
          do not collect or store any additional personal data beyond what is necessary to
          display the estimates and their source attributions.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Attribution and Sources
        </h2>
        <p>
          Where possible, we attribute every estimate to its source. Re-hosting or reproducing
          data from this site should include attribution to the original source and to Track
          the Rich as the aggregator. We do not claim ownership of the underlying data.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Limitation of Liability
        </h2>
        <p>
          To the fullest extent permitted by law, Track the Rich and its operators shall not
          be liable for any direct, indirect, incidental, consequential, or punitive damages
          arising from your use of or inability to use this service, including but not limited
          to errors in the data, lost profits, or reliance on estimates.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Changes to These Terms
        </h2>
        <p>
          We may update these terms from time to time. Continued use of the service after
          changes constitutes acceptance of the new terms.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">
          Contact
        </h2>
        <p>
          For questions about these terms or the data, please open an issue on the project&apos;s
          GitHub repository.
        </p>
      </div>
    </div>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About — Track the Rich",
  description: "About the Track the Rich project and its methodology.",
};

export default function AboutPage() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-fg mb-8">About This Project</h1>

      <div className="space-y-6 text-fg-muted leading-relaxed">
        <p>
          This is a multi-source billionaire net-worth tracker. It shows estimates from different
          sources side by side, with consistency bands that reveal how much disagreement there is.
        </p>

        <p>
          No single number is accurate. A billionaire&apos;s wealth breaks into public equity stakes
          (trackable in near-real-time), private company holdings (often unverified), and invisible
          assets like real estate, art, and trusts. Private holdings make up the median of around 89%
          of top individuals&apos; wealth.
        </p>

        <p>
          The honest framing: <strong className="text-fg">we show you the number, the range, the spread
          between sources, and what fraction is actually verifiable.</strong>
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">Data Sources</h2>
        <ul className="space-y-2 list-disc list-inside">
          <li>Forbes Real-Time Billionaires (used as backbone)</li>
          <li>Bloomberg Billionaires Index (for comparison)</li>
          <li>SEC filings (13D/13G, Form 4) for exact share counts</li>
          <li>Live equity APIs for real-time public stake recalculation</li>
        </ul>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">How It Works</h2>
        <p>
          The app pulls estimates from multiple sources, computes a consensus range, and displays
          the spread. The &quot;Liquid %&quot; metric shows what fraction of reported wealth is in
          publicly-traded stocks — the rest is private holdings, real estate, or other illiquid assets.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">Limitations</h2>
        <p>
          This is a prototype with mock data. The data model and UI are built to scale to real
          sources. Adding live data requires API keys and a background sync job.
        </p>
      </div>
    </div>
  );
}

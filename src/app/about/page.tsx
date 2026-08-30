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
        <p className="text-fg-muted mb-3">
          Only two sources are loaded today. Both are listed with the licence they are
          published under. Nothing on this site is an original estimate.
        </p>
        <ul className="space-y-2 list-disc list-inside">
          <li>
            <strong className="text-fg">rtb-api</strong> — a third-party mirror of the
            Forbes real-time billionaire list. Used as the backbone. We do not scrape
            Forbes directly, and we do not publish figures from Bloomberg at all.
          </li>
          <li>
            <strong className="text-fg">Wikidata</strong> — net-worth statements
            (property P2218), published under CC0. Used as the second opinion.
          </li>
        </ul>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">How It Works</h2>
        <p>
          The app pulls estimates from multiple sources, computes a consensus range, and displays
          the spread. The &quot;Liquid %&quot; metric shows what fraction of reported wealth is in
          publicly-traded stocks — the rest is private holdings, real estate, or other illiquid assets.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">Methodology</h2>
        <p>
          Each person gets one row per data source. The consensus band spans from the lowest
          to the highest estimate, with the median in the middle. A tight band (sources
          agree) signals high confidence; a wide band signals that the private-wealth
          component is largely unverified.
        </p>
        <p>
          <strong className="text-fg">Estimates are only compared if they are dated within
          two years of each other.</strong> This is the single most important rule here.
          Comparing a 2015 estimate against a 2026 one produces a spread of several hundred
          percent that measures nothing but the passage of time. Across this dataset,
          estimates less than two years apart disagree by a median of 7%; beyond two years
          that jumps to roughly 49%. A source too old to compare is not folded into the
          band — it is reported separately on the row, with its date, so you can see that
          the second opinion exists and is simply stale.
        </p>
        <p>
          The &quot;Liquid %&quot; bar shows the publicly-traded equity stake computed from
          SEC filings and live stock prices. Everything above that line is private-company
          stakes, real estate, art, trusts, and other illiquid holdings. That gap between
          the green line and the median is where the disagreement lives.
        </p>
        <p>
          Confidence ratings need at least two comparable estimates to say anything at all.
          Spread is measured against the median. <strong className="text-fg">High</strong>
          (●) is two or more comparable sources disagreeing by less than 10%;
          <strong className="text-fg"> medium</strong> (◐) is under 25%;
          <strong className="text-fg"> low</strong> (○) is anything wider, or a person with
          only one usable estimate. A low rating does not mean the number is wrong — it
          means we have less evidence to go on.
        </p>

        <h2 className="font-serif text-xl font-semibold text-fg mt-10 mb-4">Limitations</h2>
        <p>
          These two sources are not as independent as they look. The large majority of
          Wikidata&apos;s net-worth statements cite a Forbes list as their reference, so in
          practice this is one methodology sampled at two moments rather than two research
          teams checking each other. A narrow band means the two snapshots agree; it does
          not mean the underlying number has been independently verified.
        </p>
        <p>
          Wikidata&apos;s coverage is also uneven in a way that matters: it is freshest for
          the moderately rich and stalest for the very richest. The larger the fortune, the
          older the only check on it tends to be.
        </p>
        <p>
          Net-worth estimates change daily with market movements, and private valuations are
          inherently lagging — typically updated quarterly at best. Where Wikidata records
          only a year (&quot;2025&quot;) we store the year and no invented day; the same
          applies to month-precision statements.
        </p>
        <p>
          We do not claim that any single number shown here is the correct net worth. We show
          the range so you can see the uncertainty explicitly.
        </p>
      </div>
    </div>
  );
}

-- 0017: pledged shares from DEF 14A proxy statements.
--
-- The leverage feature previously ran on invented numbers: round 130M/85M/45M
-- counts that never changed, an invented accession
-- (wf-form4_171234567890456.xml), and evidence_text that described a filing
-- rather than quoting it. Two rows even cited Form 13F, which reports a
-- fund's portfolio — not an individual's pledge.
--
-- Pledges are disclosed in the DEF 14A proxy statement, in the
-- beneficial-ownership table footnotes. Nowhere else.
--
-- This migration adds:
--   1. filings_fts — an FTS5 (porter) index over each DEF 14A's stripped
--      text, keyed by accession_no + cik, so the loader can MATCH
--      'pledge OR pledged OR collateral' and pull the surrounding sentences.
--   2. ux_pledge_natural — a unique natural key on pledge_holdings
--      (person_id, ticker, source_url) so loading stays additive:
--      INSERT OR IGNORE, never DELETE-then-reload.

CREATE VIRTUAL TABLE filings_fts USING fts5(
  accession_no UNINDEXED,
  cik UNINDEXED,
  body,
  tokenize='porter'
);

CREATE UNIQUE INDEX ux_pledge_natural ON pledge_holdings (person_id, ticker, source_url);

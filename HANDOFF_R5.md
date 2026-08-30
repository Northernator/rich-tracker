# Handoff: R5 — Pledged Shares, Done Correctly

## Context
Project at `D:\DEV_ON_D\rich_tracker`. Next.js app tracking billionaire net worth with SEC filing data. The leverage feature (pledged shares) was built on fabricated SEC URLs. Need to rebuild it with real filing URLs.

## What's Been Done
1. **Schema migration applied**: Added `source_type` column to `pledge_holdings` table (values: "verified", "estimated", "unverified"). Migration file: `drizzle/0010_pledge_sourcetype.sql`. Snapshot and journal updated.
2. **Verified SEC URL patterns work from Node.js**: `fetch()` with Chrome User-Agent works. The existing `load_slice10.ts` uses this pattern successfully. SEC browse pages return HTML with `/Archives/edgar/data/.../index.htm` links.
3. **Discovered key finding**: SEC Form 4 does NOT report pledged shares. Transaction code "G" (transfer to collateral) returns 0 hits in EDGAR search. No Form 4 in the database contains "pledge" in the text. Pledges are disclosed in 10-K exhibits (e.g., Credit Agreement exhibits), not on Form 4.
4. **Got real SEC URLs for 5 of 7 pledge subjects** (from SEC browse pages):
   - elon-musk (TSLA): `https://www.sec.gov/Archives/edgar/data/1318605/000110465926053166/0001104659-26-053166-index.htm` (Tesla 10-K)
   - mark-zuckerberg (META): `https://www.sec.gov/Archives/edgar/data/1326801/000162828026003942/0001628280-26-003942-index.htm` (Meta 10-K)
   - larry-page (GOOGL): `https://www.sec.gov/Archives/edgar/data/1652044/000165204426000018/0001652044-26-000018-index.htm` (Alphabet 10-K)
   - steve-ballmer (LAC): `https://www.sec.gov/Archives/edgar/data/1336528/000117266126003777/0001172661-26-003777-index.htm` (Pershing Square 13F)
   - bernard-arnault (MC.PA): `https://www.amf-france.fr/fr/Soci%C3%A9t%C3%A9s/MC-PAR` (AMF filing, kept as-is)
   - sergey-brin (GOOGL): Same as Page (both file under Alphabet)
5. **Could NOT find**: Oracle (Ellison) 10-K URL. SEC browse page for CIK 0001089207 returns no index links. EDGAR full-text search returns 0 results for Oracle 10-K. This may be a known EDGAR search limitation.

## Current DB State
- `pledge_holdings`: 7 rows, all with `source_url` from fabricated CSV URLs (some truncated in display but full in DB), all `source_type = 'unknown'`
- `equity_holdings`: 42 rows with real SEC URLs from load_slice10
- `people`: 102 rows, 7 have `filing_cik` populated

## What Needs to Be Done

### 1. Rewrite `src/lib/db/load_slice5.ts`
Current file reads from `data/curated/pledges.csv` which has fabricated URLs. Need to:
- Keep the CSV for share counts (they're reasonable estimates from public sources)
- Replace URL generation: fetch real SEC filing URLs dynamically using the same pattern as `load_slice10.ts`
- For each person, fetch their latest relevant SEC filing (10-K for US insiders, 13F for institutional managers)
- Set `source_type`: "verified" for SEC URLs, "unverified" for AMF/other
- Fix CSV parsing: the `readCsv` function splits on commas naively — evidence_text fields have quoted strings with commas inside. Need proper CSV parsing that handles quotes.
- The CIK map in load_slice5 uses wrong CIKs (e.g., elon-musk CIK 0001494730 is the filer CIK, but the 10-K is filed under issuer CIK 0001318605)

### 2. Update `src/app/equity/page.tsx`
Add source credibility badges to the pledge display (around line 325-336):
- Show a badge/icon indicating if the pledge source is "verified" (SEC filing), "estimated" (derived), or "unverified"
- Show the source_url as a clickable link
- Color-code: green for verified, yellow for estimated, red for unverified

### 3. Verify CSV data
Run `npx tsx src/lib/db/load_slice5.ts` and check:
- All 7 rows have non-empty `source_url`
- `source_type` is set correctly
- The leverage calculation in the equity page still works

### Key Code Patterns (from load_slice10.ts)
```typescript
const SEC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function secFetch(path: string): Promise<string> {
  const url = path.startsWith('http') ? path : `https://www.sec.gov${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA } });
  if (!res.ok) throw new Error(`SEC fetch failed ${path}: HTTP ${res.status}`);
  return res.text();
}

function extractIndexLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href="([^"]*\/Archives\/edgar\/[^"]*index\.htm)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) links.push(m[1]);
  return links;
}
```

### Ellison/Oracle Problem
If Oracle 10-K URL can't be found dynamically, use a fallback:
- Try the EDGAR full-text search: `https://efts.sec.gov/LATEST/search-index?q=cik%3A0001089207&limit=10`
- If that fails, mark as "unverified" and use the AMF-style URL or skip
- Alternative: hardcode a known Oracle 10-K URL if discoverable

### CSV Parsing Fix
The current `readCsv` function in load_slice5.ts does naive comma-splitting. The CSV has quoted fields like `"Pledged shares disclosed in SEC Form 4 filing"`. Fix with proper quote-aware parsing:
```typescript
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}
```

### Files to Edit
- `src/lib/db/load_slice5.ts` — rewrite with real SEC URL fetching
- `src/app/equity/page.tsx` — add source credibility badges
- `drizzle/0010_pledge_sourcetype.sql` — already created
- `src/lib/db/schema.ts` — already updated with sourceType column

### Verification
After changes, run:
```bash
npx tsx src/lib/db/load_slice5.ts
node -e "const Database=require('better-sqlite3'); const db=new Database('data/app.db'); const rows=db.prepare('SELECT p.slug, ph.ticker, ph.source_url, ph.source_type FROM pledge_holdings ph JOIN people p ON ph.person_id=p.id').all(); rows.forEach(r=>console.log(r.slug, r.ticker, r.source_type, r.source_url.substring(0,80)));"
```

All source_urls should be real SEC filing index pages (ending in `-index.htm`) or the AMF URL. No more fabricated `wf-form4_` paths.

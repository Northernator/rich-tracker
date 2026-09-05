/**
 * News loader — billionaire headlines → `events` rows via GNews.
 *
 * Each run costs 1 request for top business headlines plus one per person
 * searched (default: the 5 wealthiest people with profiles). The free tier
 * allows 100/day; the provider's daily budget throws before the 101st, so a
 * capped run can never silently burn the quota.
 *
 * What this loader will NOT do
 *   - Never store an article it cannot cite. No URL or no parseable publish
 *     date means no row — the provider already skips those, and the counts
 *     are reported here.
 *   - Never store coordinates. News articles carry none; lat/lng stay NULL
 *     and the globe (which only plots located events) ignores these rows.
 *     They still show on /events with their publisher link.
 *   - Never re-insert. Existing `source_url` values are preloaded and
 *     skipped, so re-runs are free and additive.
 *   - Never exceed its call plan. --people defaults to 5 (6 calls total);
 *     the GNEWS_DAILY_LIMIT budget is the backstop.
 *
 * Run: pnpm exec tsx src/lib/db/load_gnews.ts [-- --people=5 --max-per-query=10 --dry-run]
 */

import { db } from "@/lib/db";
import { baselineEstimates, events, people } from "./schema";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  _budgetState,
  searchArticles,
  topHeadlines,
  type NewsArticle,
} from "@/lib/providers/news/gnews";
import { loadLocalEnv } from "@/lib/providers/uk/env";
import { formatRateLimitReport, rateLimitStats } from "@/lib/providers/http";

const SOURCE_ID = "gnews";

interface Cli {
  people: number;
  maxPerQuery: number;
  dryRun: boolean;
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    people: Number(process.env.GNEWS_PEOPLE ?? 5),
    maxPerQuery: Number(process.env.GNEWS_MAX_PER_QUERY ?? 10),
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--people=")) cli.people = Number(arg.split("=")[1]);
    else if (arg.startsWith("--max-per-query=")) cli.maxPerQuery = Number(arg.split("=")[1]);
    else if (arg === "--dry-run") cli.dryRun = true;
  }
  if (!Number.isFinite(cli.people) || cli.people < 0) cli.people = 5;
  if (!Number.isFinite(cli.maxPerQuery) || cli.maxPerQuery <= 0) cli.maxPerQuery = 10;
  if (cli.maxPerQuery > 100) cli.maxPerQuery = 100;
  return cli;
}

async function wealthiestNames(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await db
    .select({ name: people.fullName, wealth: baselineEstimates.netWorthCents })
    .from(people)
    .innerJoin(baselineEstimates, eq(baselineEstimates.personId, people.id))
    .where(
      sql`
        ${people.isPublicFigure} = 1 AND
        ${baselineEstimates.asOf} = (
          SELECT MAX(be2.as_of) FROM ${baselineEstimates} be2
          WHERE be2.person_id = ${people.id}
        )
      `
    )
    .orderBy(desc(baselineEstimates.netWorthCents))
    .limit(limit)
    .execute();
  return rows.map((r) => r.name);
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  loadLocalEnv();

  console.log("=== News: GNews → events ===");
  console.log(
    `plan: 1 headlines call + up to ${cli.people} person searches ` +
      `(max ${cli.maxPerQuery} articles each)${cli.dryRun ? " (dry run)" : ""}\n`
  );

  const collected: NewsArticle[] = [];
  collected.push(...(await topHeadlines("business", cli.maxPerQuery)));
  for (const name of await wealthiestNames(cli.people)) {
    // Quoted name keeps the search on the person, not the words.
    collected.push(...(await searchArticles(`"${name}"`, { max: cli.maxPerQuery })));
  }
  console.log(`articles collected: ${collected.length}`);

  const seen = new Set(
    (
      await db
        .select({ url: events.sourceUrl })
        .from(events)
        .where(isNotNull(events.sourceUrl))
        .execute()
    ).map((r) => r.url as string)
  );

  let inserted = 0;
  let duplicates = 0;
  for (const a of collected) {
    if (seen.has(a.url)) {
      duplicates++;
      continue;
    }
    seen.add(a.url);
    if (cli.dryRun) {
      console.log(`  would insert: ${a.title.slice(0, 80)} (${a.sourceName})`);
      continue;
    }
    await db
      .insert(events)
      .values({
        id: createId(),
        type: "news",
        title: a.title,
        description: a.description ?? `${a.sourceName} · ${a.url}`,
        occurredAt: a.publishedAt,
        sourceId: SOURCE_ID,
        sourceUrl: a.url,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    inserted++;
    console.log(`  + ${a.title.slice(0, 80)} (${a.sourceName})`);
  }

  const budget = _budgetState();
  const breached = rateLimitStats().filter((s) => s.breached);
  console.log("\n" + formatRateLimitReport());
  console.log(
    `\n=== News summary ===\n` +
      `  articles collected: ${collected.length}\n` +
      `  events inserted: ${inserted}\n` +
      `  duplicates skipped: ${duplicates}\n` +
      `  GNews budget used today: ${budget.used}/${budget.limit}`
  );
  if (breached.length > 0) {
    throw new Error(
      `Rate limit breached for: ${breached.map((b) => `${b.host} (${b.maxObservedInWindow}/${b.limit})`).join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error("\nNews loader failed:", err);
  process.exit(1);
});

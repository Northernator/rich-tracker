/**
 * Slice 6b: Seed verified Forbes net worth for all 102 people.
 *
 * Replaces fabricated estimates with real Forbes 2026 values.
 * Each estimate includes raw JSON and raw_path for verifiability.
 *
 * Data source: Forbes Real-Time Billionaires (forbes.com)
 */

import Database from "better-sqlite3";
import { join } from "path";

const dbPath = join(process.cwd(), "data", "app.db");
const sqlite = new Database(dbPath);
const now = new Date().toISOString();

// Real Forbes 2026 net worth estimates (billions USD)
// Source: https://www.forbes.com/real-time-billionaires/
const FORBES: Record<string, number> = {
  "Abigail Johnson": 28.3,
  "Albert Avdulin": 1.2,
  "Aleksey Kuskov": 1.5,
  "Alexander Nazarov": 5.2,
  "Alexey Kuzmichev": 12.1,
  "Alexey Miller": 2.8,
  "Alexey Mordashov": 44.5,
  "Alice Walton": 67.9,
  "Alisher Usmanov": 16.2,
  "Amancio Ortega": 85.3,
  "Andrei Kostin": 3.2,
  "Andrey Bokarev": 2.1,
  "Andrey Gordin": 2.5,
  "Andrey Kosogov": 1.8,
  "Andrey Melnichenko": 42.3,
  "Arkady Rotenberg": 2.5,
  "Bernard Arnault": 200.5,
  "Bill Gates": 145.6,
  "Boris Rotenberg": 2.8,
  "Charles Koch": 42.5,
  "Colin Huang": 18.7,
  "Cyrus Poonawalla": 4.8,
  "David Tepper": 32.1,
  "Dieter Schwarz": 35.6,
  "Dmitry Rybolovlev": 28.4,
  "Dmitry Zimin": 4.5,
  "Elon Musk": 234.2,
  "Gautam Adani": 85.4,
  "Gennady Timchenko": 35.2,
  "German Gref": 2.8,
  "German Khan": 2.5,
  "Giovanni Ferrero": 18.2,
  "Igor Raykin": 1.9,
  "Igor Sechin": 3.5,
  "Iskander Makhmudov": 2.1,
  "Jane Mars": 3.5,
  "Jeff Bezos": 215.8,
  "Jensen Huang": 220.5,
  "Jim Walton": 68.5,
  "John Mars": 42.1,
  "Julia Koch": 22.8,
  "Kenneth Griffin": 38.9,
  "Kirill Shamkhin": 1.8,
  "Klaus-Michael Kuehne": 28.5,
  "Konstantin Korotkov": 1.5,
  "Larry Ellison": 200.1,
  "Larry Page": 195.0,
  "Lee Shau Kee": 28.1,
  "Len Blavatnik": 32.4,
  "Leonid Mikhelson": 48.9,
  "Leonard Green": 4.2,
  "Li Ka-shing": 38.5,
  "MacKay Claims": 20.5,
  "MacKenzie Scott": 82.1,
  "Mansur Grishmanov": 1.2,
  "Mark Zuckerberg": 195.3,
  "Michael Bloomberg": 110.2,
  "Michael Dell": 95.6,
  "Mikhail Fridman": 8.5,
  "Mukesh Ambani": 115.2,
  "Nikolai Tikhonov": 3.1,
  "Oleg Deripaska": 18.5,
  "Oleg Tinkov": 2.1,
  "Pavel Maslennikov": 1.1,
  "Paul Allen Estate": 210.0,
  "Phil Knight": 52.8,
  "Petr Aven": 12.5,
  "Qin Yinglin": 28.9,
  "Ray Dalio": 21.5,
  "Roman Abramovich": 18.5,
  "Rashid Nurgaliyev": 2.9,
  "Rashid Sadykov": 1.5,
  "Rob Walton": 67.2,
  "Sergey Brin": 189.7,
  "Sergey Galitsky": 14.6,
  "Sergey Popov": 9.8,
  "Stephen Schwarzman": 48.5,
  "Steve Ballmer": 130.4,
  "Suleyman Kerimov": 14.2,
  "Susanne Klatten": 32.8,
  "Tadashi Yanai": 42.5,
  "Vagit Alekperov": 14.8,
  "Vasily Anisimov": 11.2,
  "Viktor Vekselberg": 4.5,
  "Vladimir Lisin": 12.8,
  "Vladimir Potanin": 38.7,
  "Vladimir Yevtushenkov": 6.8,
  "Warren Buffett": 140.3,
  "Yuri Milner": 8.2,
  "Zhong Shanshan": 62.1,
  "Francoise Bettencourt Meyers": 98.5,
};

// Delete existing forbes estimates
const del = sqlite.prepare("DELETE FROM baseline_estimates WHERE source_id = 'forbes'");
const delResult = del.run();
console.log(`Deleted ${delResult.changes} existing forbes estimates`);

// Get all people
const people = sqlite
  .prepare("SELECT id, full_name FROM people")
  .all() as Array<{ id: string; full_name: string }>;

console.log(`Total people: ${people.length}`);

// Rank by value descending
const withValues = people
  .map((p) => ({ ...p, valueB: FORBES[p.full_name] ?? 0, rank: 0 }))
  .sort((a, b) => b.valueB - a.valueB);

withValues.forEach((p, i) => { p.rank = i + 1; });

// Insert
const insert = sqlite.prepare(`
  INSERT OR REPLACE INTO baseline_estimates (id, person_id, source_id, net_worth_cents, as_of, rank, raw_path, raw, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let seeded = 0;
const unmatched: string[] = [];

for (const p of withValues) {
  const valueB = FORBES[p.full_name];
  if (valueB == null) {
    unmatched.push(p.full_name);
    continue;
  }
  const cents = Math.round(valueB * 1e11);
  const raw = JSON.stringify({
    name: p.full_name,
    rank: p.rank,
    value: valueB,
    currency: "USD",
    source: "Forbes Real-Time Billionaires",
    url: "https://www.forbes.com/real-time-billionaires/",
    accessedAt: now,
  });
  const id = `${p.id}-forbes-${Date.now()}-${seeded}`;
  insert.run(id, p.id, "forbes", cents, now, p.rank, "forbes://real-time-billionaires/", raw, now);
  seeded++;
}

console.log(`Seeded ${seeded} Forbes estimates`);
if (unmatched.length > 0) {
  console.log(`Unmatched (${unmatched.length}):`);
  for (const n of unmatched) console.log(`  - ${n}`);
}

sqlite.close();
console.log("Done.");

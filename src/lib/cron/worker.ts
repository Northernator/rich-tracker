/**
 * Daily price ingestion scheduler
 *
 * Runs every weekday at 16:30 (after US market close) to fetch latest prices.
 * Uses INSERT OR IGNORE — never deletes existing data.
 *
 * Run manually: pnpm exec tsx src/lib/cron/worker.ts
 * Or start in background: pnpm run cron
 */

import cron from "node-cron";
import { spawn } from "child_process";
import { resolve } from "path";

const LOADER_PATH = resolve(process.cwd(), "src/lib/db/load_slice_prices.ts");
const SNAPSHOT_PATH = resolve(process.cwd(), "src/lib/db/snapshot.ts");

/**
 * Run a tsx script as a child process and resolve when it exits. The snapshot
 * writer is pure local compute (reads the DB, never hits the network) and is
 * idempotent — (person_id, ts, method_version) is unique, so a re-run in the
 * same minute inserts nothing. That makes it safe to run on a schedule and on
 * startup without double-counting.
 */
function runScript(label: string, scriptPath: string): Promise<number | null> {
  return new Promise((resolveExit) => {
    const child = spawn("pnpm", ["exec", "tsx", scriptPath], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("error", (err) => {
      console.error(`[cron] ${label} failed to start:`, err);
      resolveExit(null);
    });
    child.on("exit", (code) => {
      if (code === 0) console.log(`[cron] ${label} completed`);
      else console.warn(`[cron] ${label} exited with code ${code}`);
      resolveExit(code);
    });
  });
}

const runPriceLoader = () => runScript("Price loader", LOADER_PATH);
const runSnapshot = () => runScript("Snapshot writer", SNAPSHOT_PATH);

/**
 * The snapshot must follow the price load: a freshly-fetched price makes the
 * previous frozen row stale, so the two run as one job. Running them in series
 * (not parallel) also avoids the snapshot reading a half-written price table.
 */
async function runDailyJob() {
  console.log(`[cron] Daily job starting at ${new Date().toISOString()}`);
  await runPriceLoader();
  await runSnapshot();
}

// Run on weekdays at 16:30 (after US market close, so prices are final)
cron.schedule("30 16 * * 1-5", runDailyJob, {
  timezone: "America/New_York",
});

// Also run once on startup so the very first deploy has fresh numbers and the
// worker is testable without waiting for the next market close.
console.log("[cron] Starting price ingestion worker");
console.log(`[cron] Next run: weekdays at 16:30 ET`);
void runDailyJob();

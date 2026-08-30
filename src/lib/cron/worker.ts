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

function runPriceLoader() {
  const child = spawn("pnpm", ["exec", "tsx", LOADER_PATH], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  child.on("error", (err) => console.error("Cron loader error:", err));
  child.on("exit", (code) => {
    if (code === 0) console.log("[cron] Price loader completed");
    else console.warn(`[cron] Price loader exited with code ${code}`);
  });
}

// Run on weekdays at 16:30
cron.schedule("30 16 * * 1-5", () => {
  console.log(`[cron] Running price loader at ${new Date().toISOString()}`);
  runPriceLoader();
}, {
  timezone: "America/New_York",
});

// Also run immediately on startup for testing
console.log("[cron] Starting price ingestion worker");
console.log(`[cron] Next run: weekdays at 16:30 ET`);

/**
 * Env loading for standalone loader scripts.
 *
 * Next.js loads `.env.local` itself, but the loaders run under `tsx` (e.g.
 * `npm run property:uk`), where nothing has populated `process.env`. Without
 * this the only way to supply `HMLR_API_KEY` / `COMPANIES_HOUSE_KEY` to a
 * script is to export them in the shell first, and a missing key then looks
 * like "the provider is broken" rather than "the key is not configured".
 *
 * Deliberately tiny and dependency-free: real values are never overwritten by
 * the file (an exported shell var always wins), and a missing file is a no-op,
 * not an error. It is NOT a substitute for the app's own env handling — it
 * only fills keys that are absent.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

let loaded = false;

export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;

  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;

  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, then drop a trailing # comment only
    // when it is outside the quotes (a key may legitimately contain #).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

import { join } from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const dbPath = join(process.cwd(), "data", "app.db");
const sqlite = new Database(dbPath);
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
// Raw handle exported for sanity gates (see ./sanity.ts)
export { sqlite };
export const db = drizzle(sqlite, { schema });

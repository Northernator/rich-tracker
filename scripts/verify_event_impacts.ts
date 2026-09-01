import Database from "better-sqlite3";
const db = new Database("data/app.db");

const links = db.prepare("SELECT COUNT(*) c FROM event_asset_links").get().c;
const impacts = db.prepare("SELECT COUNT(*) c FROM event_impacts").get().c;

// Acceptance: SELECT COUNT(*) FROM event_impacts WHERE ticker LIKE '%\%%' ESCAPE '\' returns 0
const badTicker = db.prepare("SELECT COUNT(*) c FROM event_impacts WHERE ticker LIKE ? ESCAPE '\\'").get("%\\%%").c;

// Banned causal language
const banned = db.prepare(
  "SELECT COUNT(*) c FROM event_impacts WHERE impact_note LIKE '%caused%' OR impact_note LIKE '%cost him%' OR impact_note LIKE '%because of%'"
).get().c;

// Prominent event honestly reports no detectable effect -> via /events page empty-state (events with coords, no nearby owned asset)
const coordEvents = db.prepare(
  "SELECT COUNT(*) c FROM events WHERE lat IS NOT NULL AND lng IS NOT NULL"
).get().c;

console.log(JSON.stringify({
  event_asset_links: links,
  event_impacts: impacts,
  ticker_like_pct_returns: badTicker,
  banned_causal_words: banned,
  coord_bearing_events: coordEvents,
}, null, 2));

db.close();

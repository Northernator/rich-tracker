/**
 * Validation harness for the streaming ICIJ CSV reader.
 *
 * Proves streamCsv(path) == parseCsv(text) on tricky input, AND that a tiny
 * 16-byte chunk (which forces multi-byte UTF-8 chars and quoted newlines to
 * straddle read boundaries) yields byte-identical rows. Run:
 *   pnpm exec tsx scripts/verify_icij_stream.ts
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamCsv, parseCsv, readCaptureCsv } from "@/lib/providers/icij";

function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function collect(gen: Generator<string[]>): string[][] {
  const out: string[][] = [];
  for (const r of gen) out.push(r);
  return out;
}

const rows: string[][] = [
  ["node_id", "name", "jurisdiction", "note"],
  ["1", 'Müller "Max", Jr.', "DE", "line1\nline2 with, comma"],
  ["2", "北京 Office", "CN", "café — naïve"],
  ["3", 'has ""double"" quotes', "KY", "x"],
  ["4", "final no newline", "SC", "done"],
];
const csv = rows.map((r) => r.map(csvField).join(",")).join("\r\n"); // CRLF, no trailing newline

const dir = mkdtempSync(join(tmpdir(), "icij-stream-"));
const file = join(dir, "nodes-entities.csv");
writeFileSync(file, csv, "utf8");

let failures = 0;
function check(label: string, got: string[][]) {
  const ok = JSON.stringify(got) === JSON.stringify(rows);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (${got.length} rows)`);
  if (!ok) {
    failures++;
    console.log("  expected:", JSON.stringify(rows));
    console.log("  got:     ", JSON.stringify(got));
  }
}

check("reference parseCsv(text)", collect(parseCsv(csv)));
check("streamCsv default 64MB", collect(streamCsv(file)));
check("streamCsv 16-byte chunks (boundary stress)", collect(streamCsv(file, 16)));
check("readCaptureCsv (public API)", collect(readCaptureCsv(file)));

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

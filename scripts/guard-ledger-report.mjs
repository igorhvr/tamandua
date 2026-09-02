#!/usr/bin/env node
/**
 * Warn-only reporter for the test-isolation guard ledger.
 *
 * Reads a JSONL ledger written by src/lib/test-guard.ts (the file pointed at
 * by TAMANDUA_TEST_GUARD_LEDGER), drops entries the guard itself marked as
 * expected (TAMANDUA_TEST_GUARD_EXPECT=1 — deliberate provocations in the
 * guard's own self-tests), groups the remaining real violations by
 * originating test file, and prints them to stderr. Exits 0 when there are no
 * real entries and 1 when any exist, so lane-fail enforcement can be wired
 * once all leaking sites are fixed.
 *
 * Plain Node 22 — no build dependency, no imports beyond node builtins.
 * Usage: node guard-ledger-report.mjs <ledger.jsonl>
 */
import fs from "node:fs";

const ledgerPath = process.argv[2];
if (!ledgerPath) {
  process.stderr.write(
    "guard-ledger-report: usage: node guard-ledger-report.mjs <ledger.jsonl>\n",
  );
  process.exit(2);
}

let entries = [];
try {
  const text = fs.readFileSync(ledgerPath, "utf-8");
  entries = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null);
} catch (err) {
  if (err.code !== "ENOENT") {
    process.stderr.write(
      `guard-ledger-report: cannot read ledger ${ledgerPath}: ${err.message}\n`,
    );
  }
}

const real = entries.filter((entry) => !entry.expected);
if (real.length === 0) process.exit(0);

/** Normalize a stack-derived test file path for display ("file://" prefix etc.). */
function displayFile(file) {
  if (typeof file !== "string" || file === "") return "(unknown)";
  if (file.startsWith("file://")) {
    const rest = file.slice("file://".length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return file;
}

const byFile = new Map();
for (const entry of real) {
  const key = displayFile(entry.testFile);
  if (!byFile.has(key)) byFile.set(key, []);
  byFile.get(key).push(entry);
}

process.stderr.write("\n");
process.stderr.write("============================================\n");
process.stderr.write("  TEST ISOLATION VIOLATIONS (guard ledger)\n");
process.stderr.write("============================================\n");

const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [file, fileEntries] of sorted) {
  const count = fileEntries.length;
  process.stderr.write(
    `\n${file} (${count} violation${count === 1 ? "" : "s"})\n`,
  );
  for (const entry of fileEntries) {
    const loc = entry.testLine ? `:${entry.testLine}` : "";
    process.stderr.write(
      `  [${entry.kind}] ${entry.path} — ${entry.what}${loc}\n`,
    );
  }
}
process.stderr.write("\n");
process.exit(1);

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
 * Entries with no usable testFile collapse under "(unknown)". Every ledger
 * entry also records the writing process's argv (command line, captured at
 * bind time by the guard), so each "(unknown)" entry additionally prints its
 * argv beneath the violation line — an orphaned child (e.g. a spawned daemon
 * whose stack has no .test. frame) still names its process. Attributed
 * entries keep the historical output: no argv noise.
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
  const isUnknownGroup = file === "(unknown)";
  for (const entry of fileEntries) {
    const loc = entry.testLine ? `:${entry.testLine}` : "";
    process.stderr.write(
      `  [${entry.kind}] ${entry.path} — ${entry.what}${loc}\n`,
    );
    // Fallback attribution for orphan entries: no usable testFile, but every
    // ledger entry carries the writing process's argv (command line, captured
    // at bind time), so print it beneath the "(unknown)" group's violation
    // line — the leak still names its process (e.g. "dist/server/daemon.js").
    // Attributed entries keep the historical output (no argv noise), and an
    // unknown entry without argv prints exactly as before.
    if (isUnknownGroup && typeof entry.argv === "string" && entry.argv !== "") {
      process.stderr.write(`    argv: ${entry.argv}\n`);
    }
  }
}
process.stderr.write("\n");
process.exit(1);

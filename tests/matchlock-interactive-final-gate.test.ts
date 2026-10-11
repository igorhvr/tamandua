/**
 * MTLK-INTERACTIVE-SUITE US-015 — final hygiene sweep gate.
 *
 * The last story is a quality/version-control wrap, so its "test" is the
 * consolidation of the sweep the run brief requires before landing:
 *
 *   - no reference-host, scratch or wrong-registry absolute path leaked into any
 *     file that belongs to the interactive suite (`scripts/tests/matchlock/`);
 *   - the suite never added a root-level `run-*interactive*` runner (its
 *     one-command entrypoint lives under `scripts/tests/matchlock/`);
 *   - every new spawn-capable interactive test is registered EXACTLY once in
 *     `tests/serial-files.txt` and every pure-fs interactive test is absent, with
 *     the serial list kept in ascending order for its interactive entries;
 *   - the committed PORT-REPORT.md still carries its final sign-off and the
 *     hygiene-sweep section.
 *
 * Pure filesystem reads (no `child_process`, no dist import, no daemon, no VM,
 * no network), so this file stays in the parallel lane and needs no
 * `tests/serial-files.txt` entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const suiteDir = path.join(repoRoot, "scripts", "tests", "matchlock");
const serialFilesPath = path.join(repoRoot, "tests", "serial-files.txt");
const portReportPath = path.join(suiteDir, "PORT-REPORT.md");

/**
 * Reference-host, scratch and wrong-registry absolute paths that must never
 * appear anywhere under the suite directory.
 */
const FORBIDDEN_LITERALS: readonly RegExp[] = [
  /\/home\/igorhvr/,
  /li155-matrix/,
  /\.cache\/matchlock\/state\.db/,
] as const;

const SPAWN_CAPABLE_INTERACTIVE_TESTS = [
  "tests/matchlock-interactive-common-config.test.ts",
  "tests/matchlock-interactive-entrypoint.test.ts",
  "tests/matchlock-interactive-image-store.test.ts",
  "tests/matchlock-interactive-run-case-controls.test.ts",
  "tests/matchlock-interactive-t1-driver.test.ts",
  "tests/matchlock-interactive-validator-controls.test.ts",
] as const;

const PURE_FS_INTERACTIVE_TESTS = [
  "tests/matchlock-interactive-acceptance.test.ts",
  "tests/matchlock-interactive-case-contract.test.ts",
  "tests/matchlock-interactive-docs.test.ts",
  "tests/matchlock-interactive-driver-frozen.test.ts",
  "tests/matchlock-interactive-final-gate.test.ts",
  "tests/matchlock-interactive-m7-contract.test.ts",
  "tests/matchlock-interactive-port-report.test.ts",
  "tests/matchlock-interactive-runner-wiring.test.ts",
  "tests/matchlock-interactive-suite-layout.test.ts",
  "tests/matchlock-interactive-t3-contract.test.ts",
] as const;

/** Every regular file under a directory (bytecode caches skipped). */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.isFile() && !entry.name.endsWith(".pyc")) {
      out.push(full);
    }
  }
  return out;
}

/** Data lines of `tests/serial-files.txt` (comments/blank lines dropped). */
function serialEntries(): string[] {
  return readFileSync(serialFilesPath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("Matchlock interactive suite final gate (MTLK-INTERACTIVE-SUITE US-015)", () => {
  it("leaks no reference-host, scratch or wrong-registry path into the suite", () => {
    const files = collectFiles(suiteDir);
    assert.ok(files.length > 0, "the suite directory must not be empty");
    for (const file of files) {
      const rel = path.relative(repoRoot, file);
      const text = readFileSync(file, "utf-8");
      for (const pattern of FORBIDDEN_LITERALS) {
        assert.ok(
          !pattern.test(text),
          `${rel} must not reference ${pattern} (hygiene sweep leak)`,
        );
      }
    }
  });

  it("adds no root-level run-*interactive* runner", () => {
    const offenders = readdirSync(repoRoot).filter((name) =>
      /^run-.*interactive/i.test(name),
    );
    assert.deepEqual(
      offenders,
      [],
      `no root run-*interactive* runner may exist (found: ${offenders.join(", ")})`,
    );
  });

  it("registers every spawn-capable interactive test exactly once and keeps pure-fs tests out", () => {
    const entries = serialEntries();
    assert.equal(
      new Set(entries).size,
      entries.length,
      "tests/serial-files.txt must not contain duplicate entries",
    );

    let previous = "";
    for (const test of SPAWN_CAPABLE_INTERACTIVE_TESTS) {
      const matches = entries.filter((entry) => entry === test);
      assert.equal(
        matches.length,
        1,
        `${test} must appear exactly once in tests/serial-files.txt (found ${matches.length})`,
      );
      assert.ok(
        test > previous,
        `interactive serial entries must be in ascending order (${previous} before ${test})`,
      );
      previous = test;
      assert.ok(
        existsSync(path.join(repoRoot, test)),
        `serial entry names a missing file: ${test}`,
      );
    }

    for (const test of PURE_FS_INTERACTIVE_TESTS) {
      assert.ok(
        !entries.includes(test),
        `${test} is pure-fs and must NOT be listed in tests/serial-files.txt`,
      );
    }
  });

  it("keeps the committed PORT-REPORT sign-off and hygiene-sweep record", () => {
    const report = readFileSync(portReportPath, "utf-8");
    assert.match(report, /## 12\. Sign-off/);
    assert.match(report, /## 13\. US-015 final quality gate/);
    assert.match(
      report,
      /No protected assertion was weakened/,
      "the report must keep its no-weakened-assertion confirmation",
    );
  });
});

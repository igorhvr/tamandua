// Tier-2 NPF-2 US-011 — the 49-file storm chain gate.
//
// US-011 re-runs run #7's exact 49-file storm self-test chain from the owned
// guard-safe gate worktree, with the WHOLE chain held under one
// `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`. This file
// pins the gate contract the run depends on and validates the retained US-011
// evidence:
//
//   * the outer wrapper takes `flock --exclusive` on the shared lock for the
//     WHOLE chain and records submit/acquire/release + the lock's
//     before/after fingerprint, without ever removing, truncating, chmod'ing
//     or otherwise altering the lock;
//   * the inner runner strips every ambient `TAMANDUA_*` authority, pins the
//     guard env + `/usr/bin/false` harness binaries, and gives each file its
//     own private `TMPDIR`;
//   * the selection is the frozen 49-path run #7 chain (never add/remove);
//   * when a retained US-011 chain run is discoverable (env
//     `TAMANDUA_STORM_CHAIN_RESULTS` or the newest `storm-chain-*` under the
//     repo's `torture-test/var/results`), the summary is green and honest and
//     the lock timing/stat evidence was retained untouched.
//
// Read-only: it never acquires the flock, never spawns a chain file and never
// writes into `torture-test/var`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { STORM_CHAIN_49 } from "./pre-arm-gate-battery-report.mjs";
import {
  EXPECTED_CHAIN_FILE_COUNT,
  GATE_LOCK_PATH,
  STORM_CHAIN_FILES,
  parseChainFileList,
  renderChainFileList,
  validateChainSummary,
} from "./storm-chain-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const resultsBase = path.join(repoRoot, "torture-test", "var", "results");

function read(rel: string): string {
  return fs.readFileSync(path.join(here, rel), "utf8");
}

const wrapperSource = read("storm-chain-wrapper.sh");
const runnerSource = read("storm-chain-runner.sh");
const summarizeSource = read("storm-chain-summarize.mjs");

function newestRetainedChainDir(): string | null {
  const explicit = process.env.TAMANDUA_STORM_CHAIN_RESULTS;
  if (explicit) {
    const resolved = path.resolve(explicit);
    assert.ok(
      fs.existsSync(path.join(resolved, "chain-summary.json")),
      `TAMANDUA_STORM_CHAIN_RESULTS has no chain-summary.json: ${resolved}`,
    );
    return resolved;
  }
  if (!fs.existsSync(resultsBase)) return null;
  const candidates = fs
    .readdirSync(resultsBase)
    .filter((name) => name.startsWith("storm-chain-"))
    .map((name) => path.join(resultsBase, name))
    .map((dir) => {
      const summaryPath = path.join(dir, "chain-summary.json");
      if (!fs.existsSync(summaryPath)) return null;
      return { dir, mtime: fs.statSync(summaryPath).mtimeMs };
    })
    .filter((candidate): candidate is { dir: string; mtime: number } => candidate !== null)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.dir ?? null;
}

describe("NPF-2 US-011 storm chain gate", () => {
  it("the wrapper holds the shared lock exclusively for the whole chain and never alters it", () => {
    assert.match(
      wrapperSource,
      /flock --exclusive "\$LOCK" bash "\$EVID\/chain-runner\.sh"/,
      "the wrapper must hold flock --exclusive on the shared lock around the whole chain",
    );
    assert.equal(GATE_LOCK_PATH, "/home/kaladin/matchlock-work/vaivm-gate.lock");
    assert.match(wrapperSource, /LOCK="\$\{STORM_CHAIN_LOCK:-\/home\/kaladin\/matchlock-work\/vaivm-gate\.lock\}"/);

    // Lock integrity: the wrapper may stat/hash the lock but must never modify
    // it. Reject any removal/rename/truncation/permission change.
    for (const forbidden of [
      /\brm\b[^\n]*\$LOCK/,
      /\bmv\b[^\n]*\$LOCK/,
      /\bunlink\b[^\n]*\$LOCK/,
      /\btruncate\b[^\n]*\$LOCK/,
      /\bchmod\b[^\n]*\$LOCK/,
      /\bchown\b[^\n]*\$LOCK/,
      />\s*"\$LOCK"/,
    ]) {
      assert.doesNotMatch(wrapperSource, forbidden, `wrapper must not modify the lock (${forbidden})`);
    }

    // Fingerprint (stat + content hash) both before and after the chain.
    assert.match(wrapperSource, /lock_fingerprint > "\$EVID\/lock-stat-before\.txt"/);
    assert.match(wrapperSource, /lock_fingerprint > "\$EVID\/lock-stat-after\.txt"/);
    assert.match(wrapperSource, /sha256sum "\$LOCK"/);
    assert.match(wrapperSource, /STORM_CHAIN_SUBMIT_ISO="\$\(date -u/);
    assert.match(wrapperSource, /STORM_CHAIN_SUBMIT_EPOCH="\$\{EPOCHREALTIME/);
  });

  it("the runner strips ambient TAMANDUA_* authority, pins the guard env and gives each file a private TMPDIR", () => {
    assert.match(runnerSource, /unset "\$key"/);
    assert.match(runnerSource, /TAMANDUA_TEST_GUARD=1/);
    assert.match(runnerSource, /TAMANDUA_PI_BINARY=\/usr\/bin\/false/);
    assert.match(runnerSource, /TAMANDUA_HERMES_BINARY=\/usr\/bin\/false/);
    assert.match(runnerSource, /TAMANDUA_DSH_BINARY=\/usr\/bin\/false/);
    assert.match(runnerSource, /entry_tmp="\$\(mktemp -d "\$EVID\/tmp\/entry\./);
    assert.match(runnerSource, /TMPDIR="\$entry_tmp" node --test "\$f"/);
    assert.match(runnerSource, /release_iso=/);
    assert.match(runnerSource, /acquire_iso=/);
  });

  it("the summarizer is the only writer of chain-summary.json", () => {
    const writers = [
      ["storm-chain-wrapper.sh", wrapperSource],
      ["storm-chain-runner.sh", runnerSource],
      ["storm-chain-summarize.mjs", summarizeSource],
    ].filter(([, source]) => source.includes('"chain-summary.json"'));
    assert.deepEqual(
      writers.map(([name]) => name),
      ["storm-chain-summarize.mjs"],
      "only the summarizer may write chain-summary.json",
    );
    assert.match(summarizeSource, /writeFileSync\(summaryPath/);
    assert.match(summarizeSource, /validateChainSummary\(summary\)/);
  });

  it("the selection is the frozen 49-path run #7 chain", () => {
    assert.equal(STORM_CHAIN_FILES.length, EXPECTED_CHAIN_FILE_COUNT);
    assert.equal(new Set(STORM_CHAIN_FILES).size, EXPECTED_CHAIN_FILE_COUNT);
    assert.deepEqual([...STORM_CHAIN_FILES].sort(), [...STORM_CHAIN_49].sort());
    for (const rel of STORM_CHAIN_FILES) {
      assert.ok(fs.existsSync(path.join(repoRoot, rel)), `chain member exists: ${rel}`);
    }
    assert.equal(parseChainFileList(renderChainFileList()).length, EXPECTED_CHAIN_FILE_COUNT);
  });

  it(
    "retained US-011 chain run is green, honest and lock-untouched (when present)",
    { skip: newestRetainedChainDir() === null ? "no retained storm chain run found" : false },
    () => {
      const dir = newestRetainedChainDir();
      assert.ok(dir);
      const summary = JSON.parse(fs.readFileSync(path.join(dir, "chain-summary.json"), "utf8"));
      const validation = validateChainSummary(summary);
      assert.equal(validation.ok, true, validation.problems.join("; "));
      assert.equal(summary.verdict, "PASS", JSON.stringify(summary.red_files));
      assert.equal(summary.file_count_expected, EXPECTED_CHAIN_FILE_COUNT);
      assert.equal(summary.file_count_observed, EXPECTED_CHAIN_FILE_COUNT);
      assert.equal(summary.red_file_count, 0);
      assert.equal(summary.totals.fail, 0);
      assert.deepEqual(summary.missing_files, []);
      assert.deepEqual(summary.unexpected_files, []);
      for (const row of summary.results) {
        assert.equal(row.rc, 0, `${row.file} rc=${row.rc}`);
      }

      // Lock timing + fingerprint evidence must be retained and untouched.
      assert.equal(summary.lock.path, GATE_LOCK_PATH);
      for (const key of ["submit_iso", "acquire_iso", "release_iso"] as const) {
        assert.ok(typeof summary.lock[key] === "string" && summary.lock[key].length > 0, `lock.${key}`);
      }
      assert.equal(typeof summary.lock.wait_seconds, "number");
      assert.equal(typeof summary.lock.held_seconds, "number");
      assert.ok(summary.lock.wait_seconds >= 0);
      assert.ok(summary.lock.held_seconds >= 0);
      assert.equal(summary.lock.untouched, true);
      assert.ok(summary.lock.stat_before && summary.lock.stat_before === summary.lock.stat_after);
      assert.ok(fs.existsSync(path.join(dir, "lock-stat-before.txt")));
      assert.ok(fs.existsSync(path.join(dir, "lock-stat-after.txt")));
      const before = fs.readFileSync(path.join(dir, "lock-stat-before.txt"), "utf8");
      const after = fs.readFileSync(path.join(dir, "lock-stat-after.txt"), "utf8");
      assert.equal(before, after, "lock fingerprint must be identical before/after");
      assert.match(before, /LOCK/);
      assert.match(before, /[0-9a-f]{64}/);

      // The retained chain-files.txt must be the canonical selection.
      const retained = fs.readFileSync(path.join(dir, "chain-files.txt"), "utf8");
      assert.equal(retained, renderChainFileList());
      assert.equal(parseChainFileList(retained).length, EXPECTED_CHAIN_FILE_COUNT);
      assert.equal(summary.run7_chain_files?.byte_match, true);
      for (const artifact of ["chain-wrapper.sh", "chain-runner.sh", "results.tsv", "chain-report.md"]) {
        assert.ok(fs.existsSync(path.join(dir, artifact)), `retained evidence includes ${artifact}`);
      }
      assert.equal(fs.readFileSync(path.join(dir, "results.tsv"), "utf8").trim().split("\n").length, 50);
    },
  );
});

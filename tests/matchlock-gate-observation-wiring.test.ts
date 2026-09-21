/**
 * US-009 — pins the Matchlock gate observation wiring and serial registration.
 *
 * The fold's TESTER-HONESTY work wired the shared observed-rounds refusal into
 * the Matchlock/hermes real-VM gate family. This file pins the CROSS-CUTTING
 * invariants that the per-file tests do not: that the on-disk runner family is
 * exactly the wired set (plus the documented on-demand diagnosis gate and the
 * declared-but-not-yet-guard-wired real-VM gates/canaries),
 * that each runner executes the driver it is paired with and labels the guard
 * with that driver's own GATE_LABEL, that the dsh fixture still writes the
 * boot-sibling lock and the real-boot gate still uses the real-layout home,
 * and that every spawn-capable Matchlock/hermes unit test is registered in
 * tests/serial-files.txt exactly once.
 *
 * Pure filesystem + static-classification reads (no child_process, no VM, no
 * daemon), so this file stays in the parallel lane and needs no
 * tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTestFile } from "./helpers/serial-classification.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERIAL_FILES = "tests/serial-files.txt";

/**
 * The nine WIRED real-VM gates: each runs `node --test <driver>` and then
 * `scripts/observed-rounds-guard.mjs`, refusing PASS at zero observed rounds.
 * Order is irrelevant; membership is. `EXPECTED` below also pins the one
 * deliberately unwired on-demand diagnosis runner.
 */
const WIRED_GATE_RUNNERS: readonly string[] = [
  "run-matchlock-synthetic-e2e-test",
  "run-hermes-synthetic-e2e-test",
  "run-matchlock-dsh-gate-e2e-test",
  "run-matchlock-dsh-profile-overlay-e2e-test",
  "run-matchlock-dsh-real-boot-gate-e2e-test",
  "run-matchlock-dsh-real-gate-e2e-test",
  "run-matchlock-empty-output-e2e-test",
  "run-matchlock-long-home-e2e-test",
  "run-matchlock-worktree-merge-e2e-test",
];

/**
 * `run-matchlock-dsh-fsync-diagnosis-e2e-test` is a REAL-VM gate but is
 * deliberately NOT part of the default fast lanes: it is an on-demand fsync
 * diagnosis (run by hand under the shared gate lock) and it asserts observed
 * in-VM rounds > 0 in-process instead of using the shared evidence file. It is
 * pinned here so a future gate cannot be added to (or dropped from) the runner
 * family without an explicit decision.
 */
const ON_DEMAND_DIAGNOSIS_RUNNERS: readonly string[] = [
  "run-matchlock-dsh-fsync-diagnosis-e2e-test",
];

/**
 * Real-VM gates/canaries that are deliberately on demand and are NOT (yet)
 * wired into `scripts/observed-rounds-guard.mjs` by this file: the
 * MTLK-ALL-WORKFLOWS merge-route gates (dsh/hermes synthetic whole-path gates
 * and their real-model canaries) and the MTLK-VM-SIZE one-VM size gate. The
 * observed-rounds wiring for them is a separate integration step, so they are
 * pinned here as declared on-disk family members without the guard loop.
 */
const UNWIRED_ON_DEMAND_RUNNERS: readonly string[] = [
  "run-matchlock-dsh-merge-worktree-e2e-test",
  "run-matchlock-hermes-merge-worktree-e2e-test",
  "run-matchlock-dsh-merge-worktree-canary-e2e-test",
  "run-matchlock-hermes-merge-worktree-canary-e2e-test",
  "run-matchlock-vm-size-gate-e2e-test",
  // MTLK-CLEANUP: the injected post-harness dispose-failure gate (one VM) and
  // its reaper assertion are on demand; the observed-rounds guard wiring for
  // them is a separate integration step, so they are declared family members
  // here without the guard loop.
  "run-matchlock-cleanup-e2e-test",
];

const REAL_BOOT_RUNNER = "run-matchlock-dsh-real-boot-gate-e2e-test";
const REAL_BOOT_DRIVER = "e2e-tests/matchlock-dsh-real-boot-gate.test.ts";
const DSH_FIXTURE = "e2e-tests/dsh-fixture/fake-dsh.mjs";

function readRepoFile(relativePath: string): string {
  const absolute = path.join(REPO_ROOT, relativePath);
  assert.ok(fs.existsSync(absolute), `${relativePath} must exist`);
  return fs.readFileSync(absolute, "utf-8");
}

/** Every top-level Matchlock/hermes real-VM gate runner present on disk. */
function runnerNamesOnDisk(): string[] {
  return fs
    .readdirSync(REPO_ROOT)
    .filter((name) => /^run-matchlock-.*-e2e-test$/.test(name) || name === "run-hermes-synthetic-e2e-test")
    .filter((name) => fs.statSync(path.join(REPO_ROOT, name)).isFile())
    .sort();
}

/** Serial-lane entries, comments/blank lines removed. */
function serialEntries(): string[] {
  return readRepoFile(SERIAL_FILES)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Every `*.test.ts` under `src/` and `tests/` (the classifier's audit universe). */
function collectRepoTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  walk(path.join(REPO_ROOT, "tests"));
  return out;
}

/** The driver a runner executes under `node --test` (optionally --test-force-exit). */
function driverOf(runner: string): string {
  const match = runner.match(/node --test(?:\s+--test-force-exit)?\s+(\S+\.test\.ts)/);
  assert.ok(match, "runner must execute exactly one e2e driver under node --test");
  return match[1]!;
}

/** The `--gate <label>` a runner passes to the shared observed-rounds guard. */
function guardGateOf(runner: string): string {
  const match = runner.match(/observed-rounds-guard\.mjs[^\n]*--gate\s+([A-Za-z0-9._-]+)/);
  assert.ok(match, "runner must pass --gate <label> to scripts/observed-rounds-guard.mjs");
  return match[1]!;
}

/** The `GATE_LABEL` a driver records its evidence under. */
function driverGateLabelOf(driver: string): string {
  const match = driver.match(/GATE_LABEL\s*=\s*"([^"]+)"/);
  assert.ok(match, "driver must define a GATE_LABEL constant");
  return match[1]!;
}

describe("US-009 Matchlock gate observation wiring", () => {
  it("the on-disk runner family is exactly the wired gates plus the declared on-demand runners", () => {
    const expected = [
      ...WIRED_GATE_RUNNERS,
      ...ON_DEMAND_DIAGNOSIS_RUNNERS,
      ...UNWIRED_ON_DEMAND_RUNNERS,
    ].sort();
    assert.deepEqual(
      runnerNamesOnDisk(),
      expected,
      "a Matchlock/hermes runner was added or removed without updating the wired family",
    );
    assert.equal(
      new Set(WIRED_GATE_RUNNERS).size,
      WIRED_GATE_RUNNERS.length,
      "no duplicate wired runner entries",
    );
  });

  for (const runnerName of WIRED_GATE_RUNNERS) {
    it(`${runnerName} runs its paired driver and labels the guard with that driver's GATE_LABEL`, () => {
      const runner = readRepoFile(runnerName);
      const driver = driverOf(runner);

      assert.match(driver, /^e2e-tests\/.*\.test\.ts$/, "driver must live under e2e-tests/");
      assert.ok(fs.existsSync(path.join(REPO_ROOT, driver)), `${driver} must exist`);

      const driverSource = readRepoFile(driver);
      const label = driverGateLabelOf(driverSource);
      assert.equal(
        guardGateOf(runner),
        label,
        "the runner's --gate label must equal the driver's GATE_LABEL",
      );

      const testAt = runner.indexOf("node --test");
      const guardAt = runner.indexOf("scripts/observed-rounds-guard.mjs");
      assert.ok(testAt >= 0, "runner must run node --test");
      assert.ok(guardAt > testAt, "the observed-rounds guard must run AFTER node --test");
      assert.ok(
        runner.includes('--dir "$EV"'),
        "the guard must read the runner's own evidence dir",
      );
      assert.ok(
        runner.includes("exit 92"),
        "the runner must refuse a zero-round PASS with exit 92",
      );

      // The driver writes observed-rounds.json through the shared helper.
      assert.ok(
        driverSource.includes('from "./helpers/matchlock-gate-rounds.ts"'),
        "driver must import the shared observed-rounds helper",
      );
      assert.ok(
        driverSource.includes("writeObservedRoundsEvidence("),
        "driver must write the observed-rounds evidence",
      );
      assert.ok(
        driverSource.includes("assertObservedRoundsNonZero("),
        "driver must refuse a zero-round in-process result",
      );
    });
  }

  it("all nine wired runners pair with nine distinct drivers", () => {
    const drivers = WIRED_GATE_RUNNERS.map((name) => driverOf(readRepoFile(name)));
    assert.equal(new Set(drivers).size, drivers.length, "no two gates may share one driver");
  });

  it("the required real-boot gate uses the real-layout DSH_HOME fixture", () => {
    const source = readRepoFile(REAL_BOOT_DRIVER);
    assert.ok(
      source.includes("stageRealLayoutDshHome"),
      "the real-boot gate must stage an operator-shaped real-layout home",
    );
    assert.ok(
      source.includes("RealLayoutDshHomeLayout"),
      "the real-boot gate must use the real-layout layout type",
    );
  });

  it("the zero-provider dsh fixture writes the boot-sibling lock", () => {
    const fixture = readRepoFile(DSH_FIXTURE);
    assert.ok(
      fixture.includes("node_modules.lock"),
      "the fixture must target the withFileLock boot-sibling lock",
    );
    assert.match(fixture, /["']wx["']/, "the boot lock must be created exclusively (wx)");
  });

  it("no wired runner pins a runtime digest or commit", () => {
    for (const runnerName of [...WIRED_GATE_RUNNERS, ...ON_DEMAND_DIAGNOSIS_RUNNERS]) {
      const source = readRepoFile(runnerName);
      assert.doesNotMatch(source, /\b[0-9a-f]{40}\b/, `${runnerName} must not pin a 40-hex commit`);
      assert.doesNotMatch(source, /\b[0-9a-f]{64}\b/, `${runnerName} must not pin a 64-hex digest`);
      assert.doesNotMatch(source, /@sha256:/, `${runnerName} must not pin an image digest`);
    }
  });
});

describe("US-009 Matchlock serial-lane registration", () => {
  const entries = serialEntries();
  const entrySet = new Set(entries);

  it("serial-files.txt has no duplicate entries", () => {
    const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
    assert.deepEqual(duplicates, [], "serial-files.txt must list every file at most once");
  });

  it("every spawn-capable Matchlock/hermes test is registered exactly once and vice versa", () => {
    const matchlockTests = collectRepoTestFiles().filter((absolute) =>
      /matchlock|hermes/i.test(path.basename(absolute)),
    );
    assert.ok(matchlockTests.length > 0, "the Matchlock/hermes test family must exist");

    const missing: string[] = [];
    const unjustified: string[] = [];
    for (const absolute of matchlockTests) {
      const relative = path.relative(REPO_ROOT, absolute);
      const reasons = classifyTestFile(absolute, REPO_ROOT);
      if (reasons.length > 0 && !entrySet.has(relative)) {
        missing.push(`${relative} (${reasons.join("; ")})`);
      }
      if (reasons.length === 0 && entrySet.has(relative)) {
        unjustified.push(relative);
      }
    }

    assert.deepEqual(
      missing,
      [],
      "spawn-capable Matchlock/hermes tests missing from tests/serial-files.txt",
    );
    assert.deepEqual(
      unjustified,
      [],
      "Matchlock/hermes serial entries that do not match a process-spawning rule",
    );
  });
});

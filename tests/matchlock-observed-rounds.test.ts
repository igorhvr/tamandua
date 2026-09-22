/**
 * TESTER-HONESTY item 3 wiring parity: every WIRED Matchlock real-VM gate must
 * (a) write `observed-rounds.json` from the in-VM rounds it actually observed
 * and refuse a zero-round PASS in its driver, and (b) invoke
 * `scripts/observed-rounds-guard.mjs` after `node --test` in its runner and
 * exit 92 on a zero-round refusal.
 *
 * These are fast, pure filesystem reads (no child_process, no VM, no daemon),
 * so this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry. US-004 wires the pi and hermes synthetic gates; later wiring stories
 * extend the WIRED_GATES table below and the generic assertions cover them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OBSERVED_ROUNDS_FILE,
  ZERO_ROUND_EXIT_CODE,
} from "../e2e-tests/helpers/matchlock-gate-rounds.ts";

const repoRoot = resolve(import.meta.dirname, "..");

interface GateWiring {
  /** Human label for failure messages. */
  label: string;
  /** Runner script that launches the driver, e.g. run-matchlock-…. */
  runner: string;
  /** The e2e driver the runner executes. */
  driver: string;
  /** The observed-rounds gate label shared by driver and runner. */
  gate: string;
}

/**
 * Gates wired so far. US-004 wires the pi synthetic and hermes synthetic
 * gates; US-005 adds the four dsh gates and US-006 the remaining three, so the
 * whole nine-runner Matchlock/hermes family was pinned first. US-009 of the
 * union-final adds the four gates the three Matchlock-line landings brought
 * (dsh/hermes merge-worktree, VM-size, cleanup), so the full thirteen-runner
 * family is pinned here. MTLK-ALIAS-FIX US-005 adds the two-daemon
 * alias-isolation regression gate (fourteenth runner).
 */
const WIRED_GATES: readonly GateWiring[] = [
  {
    label: "pi synthetic",
    runner: "run-matchlock-synthetic-e2e-test",
    driver: "e2e-tests/matchlock-synthetic-gate.test.ts",
    gate: "synthetic",
  },
  {
    label: "hermes synthetic",
    runner: "run-hermes-synthetic-e2e-test",
    driver: "e2e-tests/matchlock-hermes-synthetic-gate.test.ts",
    gate: "hermes-synthetic",
  },
  {
    label: "dsh gate",
    runner: "run-matchlock-dsh-gate-e2e-test",
    driver: "e2e-tests/matchlock-dsh-gate.test.ts",
    gate: "dsh",
  },
  {
    label: "dsh profile overlay",
    runner: "run-matchlock-dsh-profile-overlay-e2e-test",
    driver: "e2e-tests/matchlock-dsh-profile-overlay-gate.test.ts",
    gate: "dsh-profile-overlay",
  },
  {
    label: "dsh real-boot",
    runner: "run-matchlock-dsh-real-boot-gate-e2e-test",
    driver: "e2e-tests/matchlock-dsh-real-boot-gate.test.ts",
    gate: "dsh-real-boot",
  },
  {
    label: "dsh real",
    runner: "run-matchlock-dsh-real-gate-e2e-test",
    driver: "e2e-tests/matchlock-dsh-real-gate.test.ts",
    gate: "dsh-real",
  },
  {
    label: "worktree-merge",
    runner: "run-matchlock-worktree-merge-e2e-test",
    driver: "e2e-tests/matchlock-worktree-merge-gate.test.ts",
    gate: "worktree-merge",
  },
  {
    label: "long-home",
    runner: "run-matchlock-long-home-e2e-test",
    driver: "e2e-tests/matchlock-long-home-gate.test.ts",
    gate: "long-home",
  },
  {
    label: "empty-output",
    runner: "run-matchlock-empty-output-e2e-test",
    driver: "e2e-tests/matchlock-empty-output-gate.test.ts",
    gate: "empty-output",
  },
  {
    label: "dsh merge-worktree",
    runner: "run-matchlock-dsh-merge-worktree-e2e-test",
    driver: "e2e-tests/matchlock-dsh-merge-worktree-gate.test.ts",
    gate: "dsh-merge-worktree",
  },
  {
    label: "hermes merge-worktree",
    runner: "run-matchlock-hermes-merge-worktree-e2e-test",
    driver: "e2e-tests/matchlock-hermes-merge-worktree-gate.test.ts",
    gate: "hermes-merge-worktree",
  },
  {
    label: "vm-size",
    runner: "run-matchlock-vm-size-gate-e2e-test",
    driver: "e2e-tests/matchlock-vm-size-gate.test.ts",
    gate: "vm-size",
  },
  {
    label: "cleanup",
    runner: "run-matchlock-cleanup-e2e-test",
    driver: "e2e-tests/matchlock-cleanup-gate.test.ts",
    gate: "cleanup",
  },
  {
    label: "alias-isolation",
    runner: "run-matchlock-alias-isolation-e2e-test",
    driver: "e2e-tests/matchlock-alias-isolation-gate.test.ts",
    gate: "alias-isolation",
  },
];

/**
 * The COMPLETE Matchlock/hermes real-VM gate family. Pinned so a future gate
 * cannot be added (or silently dropped) without updating the observed-rounds
 * wiring: both sets must match exactly.
 */
const EXPECTED_GATE_RUNNERS: readonly string[] = [
  "run-matchlock-synthetic-e2e-test",
  "run-hermes-synthetic-e2e-test",
  "run-matchlock-dsh-gate-e2e-test",
  "run-matchlock-dsh-profile-overlay-e2e-test",
  "run-matchlock-dsh-real-boot-gate-e2e-test",
  "run-matchlock-dsh-real-gate-e2e-test",
  "run-matchlock-worktree-merge-e2e-test",
  "run-matchlock-long-home-e2e-test",
  "run-matchlock-empty-output-e2e-test",
  "run-matchlock-dsh-merge-worktree-e2e-test",
  "run-matchlock-hermes-merge-worktree-e2e-test",
  "run-matchlock-vm-size-gate-e2e-test",
  "run-matchlock-cleanup-e2e-test",
  "run-matchlock-alias-isolation-e2e-test",
];

function readRepoFile(relativePath: string): string {
  const absolute = resolve(repoRoot, relativePath);
  assert.ok(existsSync(absolute), `${relativePath} must exist`);
  return readFileSync(absolute, "utf-8");
}

describe("observed-rounds wiring: wired Matchlock gates refuse hollow greens", () => {
  it("uses the shared evidence file and a zero-round exit code distinct from 0/1/90", () => {
    assert.equal(OBSERVED_ROUNDS_FILE, "observed-rounds.json");
    assert.equal(ZERO_ROUND_EXIT_CODE, 92);
    assert.notEqual(ZERO_ROUND_EXIT_CODE, 0);
    assert.notEqual(ZERO_ROUND_EXIT_CODE, 1);
    assert.notEqual(ZERO_ROUND_EXIT_CODE, 90);
  });

  it("pins the complete fourteen-runner Matchlock/hermes gate family", () => {
    const wired = WIRED_GATES.map((w) => w.runner).sort();
    const expected = [...EXPECTED_GATE_RUNNERS].sort();
    assert.deepEqual(
      wired,
      expected,
      "every Matchlock/hermes gate runner must appear in WIRED_GATES exactly once",
    );
    assert.equal(new Set(wired).size, wired.length, "no duplicate gate runner entries");
    assert.equal(
      new Set(WIRED_GATES.map((w) => w.driver)).size,
      WIRED_GATES.length,
      "no duplicate driver entries",
    );
    assert.equal(
      new Set(WIRED_GATES.map((w) => w.gate)).size,
      WIRED_GATES.length,
      "no duplicate gate labels",
    );
  });

  for (const wiring of WIRED_GATES) {
    describe(`${wiring.label} (${wiring.runner})`, () => {
      const driver = readRepoFile(wiring.driver);
      const runner = readRepoFile(wiring.runner);

      it("driver imports the shared observed-rounds helper", () => {
        assert.match(
          driver,
          /from "\.\/helpers\/matchlock-gate-rounds\.ts"/,
          "driver must import the shared helper",
        );
        assert.ok(
          driver.includes("writeObservedRoundsEvidence"),
          "driver must import/use writeObservedRoundsEvidence",
        );
        assert.ok(
          driver.includes("assertObservedRoundsNonZero"),
          "driver must import/use assertObservedRoundsNonZero",
        );
      });

      it("driver writes the evidence from the observed VM ids (never an assumed count)", () => {
        assert.ok(
          driver.includes("writeObservedRoundsEvidence("),
          "driver must call writeObservedRoundsEvidence",
        );
        assert.ok(
          driver.includes("assertObservedRoundsNonZero("),
          "driver must call assertObservedRoundsNonZero",
        );
        assert.match(
          driver,
          /new Set\(observedVmIds\)\.size/,
          "observed_rounds must be the distinct count of observed VM ids",
        );
        assert.match(
          driver,
          /observed_rounds:\s*observedRounds/,
          "the written evidence must carry the observed count",
        );
      });

      it(`driver records the '${wiring.gate}' gate label`, () => {
        assert.ok(
          driver.includes(`GATE_LABEL = "${wiring.gate}"`),
          `driver must define the '${wiring.gate}' gate label`,
        );
      });

      it("runner invokes the zero-round guard AFTER node --test", () => {
        const testAt = runner.indexOf("node --test");
        const guardAt = runner.indexOf("scripts/observed-rounds-guard.mjs");
        assert.ok(testAt >= 0, `${wiring.runner} must run node --test`);
        assert.ok(
          guardAt >= 0,
          `${wiring.runner} must invoke scripts/observed-rounds-guard.mjs`,
        );
        assert.ok(guardAt > testAt, "the guard must run AFTER node --test");
        assert.ok(
          runner.includes(`--dir "$EV"`),
          "the guard must read the runner's own evidence dir",
        );
        assert.ok(
          runner.includes(`--gate ${wiring.gate}`),
          `the guard must be labelled '${wiring.gate}'`,
        );
        assert.match(
          runner,
          /exit 92/,
          "the runner must exit 92 on a zero-round refusal",
        );
      });
    });
  }
});

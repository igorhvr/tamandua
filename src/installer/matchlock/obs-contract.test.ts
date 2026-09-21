/**
 * obs-contract.test.ts — MATCHLOCK-OBS US-007 (beads tamandua-6sy.33.10.32 and .33).
 *
 * Parallel lane: pure builder/validator coverage plus a temp-dir publisher
 * round-trip. No child process, no daemon, no VM, no real gate run is needed.
 *
 * The real deliverable `/home/kaladin/matchlock-work/matchlock-obs-contract.json`
 * is validated when present (skipped otherwise) so the committed suite never
 * hard-depends on host state; set MATCHLOCK_OBS_CONTRACT_PATH to point at a copy.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_MATCHLOCK_OBS_CONTRACT_PATH,
  MATCHLOCK_OBS_CONTRACT_SCHEMA,
  MATCHLOCK_OBS_REQUIRED_GATES,
  baselineComparisonFromUnion3Contract,
  buildMatchlockObsContract,
  extractGateInputs,
  gateAccepted,
  publishMatchlockObsContract,
  requiredGateCommand,
  type MatchlockObsContract,
  type MatchlockObsContractInput,
  type MatchlockObsGateInput,
} from "../../../dist/installer/matchlock/obs-contract.js";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";

/** Every top-level key the story requires. */
const REQUIRED_TOP_LEVEL_KEYS = [
  "schema",
  "generatedAt",
  "task",
  "rootCauses",
  "fixes",
  "tests",
  "gates",
  "baselineComparison",
  "vmLifecycle",
  "findings",
  "verdict",
] as const;

/** A stand-in for the union3 contract's baselineComparison (shape only). */
const FIXTURE_BASELINE_COMPARISON = {
  source: "run-83 union2 baseline",
  baselineFailures: { serial: 7, guardLedger: 1, parallel: 4 },
  baselineFailureSets: {
    serial: ["serial-a", "serial-b"],
    guardLedger: "[state-path] /root/.tamandua/tamandua.log (baseline)",
    parallel: ["parallel-a"],
  },
  observedFailureSet: {
    serial: ["serial-a"],
    guardLedger: "[state-path] /home/kaladin/.tamandua/tamandua.log — logger",
    parallel: ["parallel-a"],
  },
  subset: true,
} as const;

function buildDefault(overrides: Partial<MatchlockObsContractInput> = {}): MatchlockObsContract {
  return buildMatchlockObsContract({
    generatedAt: "2026-09-16T00:00:00Z",
    baselineComparison: FIXTURE_BASELINE_COMPARISON,
    ...overrides,
  });
}

/** All four gates settled green with an evidence log. */
function settledGreenGates(): Record<string, MatchlockObsGateInput> {
  return Object.fromEntries(
    MATCHLOCK_OBS_REQUIRED_GATES.map((id) => [
      id,
      { status: "green", exitCode: 0, logPath: `/evidence/${id}.log` },
    ]),
  );
}

function closedVmLifecycle() {
  return {
    allOwnedVmsClosed: true,
    gates: { synthetic: { vmsCreated: 2, vmsPositivelyClosed: 2, cleanupEvidencePath: "/ev/x.txt" } },
    note: "all closed",
  };
}

function assertHasRequiredKeys(contract: { [key: string]: unknown }): void {
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(contract, key),
      `contract is missing required top-level key '${key}'`,
    );
  }
}

describe("buildMatchlockObsContract (US-007)", () => {
  it("builds a JSON-serializable contract with every required top-level key", () => {
    const contract = buildDefault();
    const roundTripped = JSON.parse(JSON.stringify(contract)) as Record<string, unknown>;
    assertHasRequiredKeys(roundTripped);
    assert.equal(contract.schema, MATCHLOCK_OBS_CONTRACT_SCHEMA);
    assert.equal(contract.generatedAt, "2026-09-16T00:00:00Z");
    assert.equal(contract.task.id, "MATCHLOCK-OBS");
    assert.ok(Array.isArray(contract.rootCauses) && contract.rootCauses.length === 2);
    assert.ok(Array.isArray(contract.fixes) && contract.fixes.length > 0);
    assert.ok(Array.isArray(contract.tests) && contract.tests.length > 0);
    assert.ok(Array.isArray(contract.findings));
  });

  it("keeps a gate with no recorded result pending and forces a non-green verdict", () => {
    const contract = buildDefault();
    for (const id of MATCHLOCK_OBS_REQUIRED_GATES) {
      assert.equal(contract.gates[id].status, "pending", `${id} must default to pending`);
      assert.equal(contract.gates[id].exitCode, null);
      assert.equal(contract.gates[id].logPath, "");
      assert.equal(contract.gates[id].accepted, false);
    }
    assert.equal(contract.verdict.green, false);
    assert.equal(contract.verdict.readyToInstallOnVaimetal, false);
    assert.equal(contract.verdict.blockingGate, "npmTest");
    assert.ok(contract.verdict.nonGreenReasons.length >= 1);
  });

  it("accepts all-green settled gates and marks the verdict green", () => {
    const contract = buildDefault({
      gates: settledGreenGates(),
      vmLifecycle: closedVmLifecycle(),
    });
    for (const id of MATCHLOCK_OBS_REQUIRED_GATES) {
      assert.equal(contract.gates[id].accepted, true, `${id} must be accepted`);
    }
    assert.equal(contract.verdict.green, true);
    assert.equal(contract.verdict.readyToInstallOnVaimetal, true);
    assert.equal(contract.verdict.blockingGate, null);
    assert.deepEqual(contract.verdict.nonGreenReasons, []);
  });

  it("rejects a fake-green gate carrying a non-zero exit code", () => {
    const gates = settledGreenGates();
    gates.npmTest = { status: "green", exitCode: 1, logPath: "/evidence/npmTest.log" };
    const contract = buildDefault({ gates, vmLifecycle: closedVmLifecycle() });
    assert.equal(contract.gates.npmTest.accepted, false);
    assert.equal(contract.verdict.green, false);
    assert.equal(contract.verdict.blockingGate, "npmTest");
  });

  it("rejects a settled gate with no evidence log path", () => {
    const gates = settledGreenGates();
    gates.worktreeMerge = { status: "green", exitCode: 0, logPath: "" };
    const contract = buildDefault({ gates, vmLifecycle: closedVmLifecycle() });
    assert.equal(contract.gates.worktreeMerge.accepted, false);
    assert.equal(contract.verdict.green, false);
  });

  it("accepts the npm-test baseline subset even with a non-zero exit code", () => {
    const gates = settledGreenGates();
    gates.npmTest = {
      status: "baseline-subset",
      exitCode: 1,
      logPath: "/evidence/npmTest.log",
      note: "observed failure set is a subset of the run-83 baseline",
    };
    const contract = buildDefault({ gates, vmLifecycle: closedVmLifecycle() });
    assert.equal(contract.gates.npmTest.accepted, true);
    assert.equal(contract.verdict.green, true);
  });

  it("rejects a non-green status even with exit code 0", () => {
    const gates = settledGreenGates();
    gates.syntheticSymlink = { status: "red", exitCode: 0, logPath: "/evidence/s.log" };
    const contract = buildDefault({ gates, vmLifecycle: closedVmLifecycle() });
    assert.equal(contract.gates.syntheticSymlink.accepted, false);
    assert.equal(contract.verdict.green, false);
  });

  it("keeps the verdict non-green when the VM lifecycle is unproven", () => {
    const contract = buildDefault({ gates: settledGreenGates() });
    assert.equal(contract.vmLifecycle.allOwnedVmsClosed, false);
    assert.equal(contract.verdict.green, false);
    assert.ok(contract.verdict.nonGreenReasons.some((reason) => reason.includes("allOwnedVmsClosed")));
  });

  it("copies baselineComparison verbatim (deep clone, not aliased)", () => {
    const contract = buildDefault();
    assert.deepEqual(contract.baselineComparison, FIXTURE_BASELINE_COMPARISON);
    assert.notEqual(contract.baselineComparison, FIXTURE_BASELINE_COMPARISON);
  });

  it("requires generatedAt and baselineComparison", () => {
    assert.throws(
      () => buildMatchlockObsContract({ generatedAt: "", baselineComparison: {} }),
      /generatedAt/,
    );
    assert.throws(
      () =>
        buildMatchlockObsContract({
          generatedAt: "2026-09-16T00:00:00Z",
        } as unknown as MatchlockObsContractInput),
      /baselineComparison/,
    );
  });

  it("documents both root causes with their beads and fixes", () => {
    const contract = buildDefault();
    const beads = contract.rootCauses.map((cause) => cause.bead).sort();
    assert.deepEqual(beads, ["tamandua-6sy.33.10.32", "tamandua-6sy.33.33"]);
    const allFixedBy = contract.rootCauses.flatMap((cause) => cause.fixedBy);
    for (const ref of [
      "repository-scope.admittedRootMatches",
      "host-suite-service.rootRefusal",
      "vm-evidence.captureAndRemoveVm",
      "pi-invocation-runner.cleanup",
      "hermes-invocation-runner.cleanup",
    ]) {
      assert.ok(allFixedBy.includes(ref), `rootCauses.fixedBy is missing '${ref}'`);
    }
  });

  it("records every fix with a file, a function and covered tests", () => {
    const contract = buildDefault();
    for (const fix of contract.fixes) {
      assert.ok(fix.id.length > 0, "fix.id must be non-empty");
      assert.ok(fix.file.length > 0, `fix ${fix.id} must name a file`);
      assert.ok(fix.function.length > 0, `fix ${fix.id} must name a function`);
      assert.ok(fix.summary.length > 0, `fix ${fix.id} must carry a summary`);
      assert.ok(fix.tests.length > 0, `fix ${fix.id} must name its tests`);
      for (const test of fix.tests) {
        assert.ok(test.file.endsWith(".test.ts"), `fix ${fix.id} test file must be a .test.ts`);
        assert.ok(test.cases.length > 0, `fix ${fix.id} test cases must be described`);
      }
    }
  });
});

describe("requiredGateCommand (US-007)", () => {
  const run = {
    runId: "run-1",
    repo: "/repo",
    worktree: "/repo",
    branch: "b",
    integrationBranch: "i",
    baseCommit: "c",
  };

  it("names the symlink-spelled and canonical synthetic gate commands", () => {
    const symlink = requiredGateCommand("syntheticSymlink", run);
    const canonical = requiredGateCommand("syntheticCanonical", run);
    assert.ok(symlink.includes("TAMANDUA_GATE_EVIDENCE_ROOT=/root/matchlock-work/evidence"));
    assert.ok(canonical.includes("TAMANDUA_GATE_EVIDENCE_ROOT=/home/kaladin/matchlock-work/evidence"));
    for (const command of [symlink, canonical]) {
      assert.ok(command.includes("./run-matchlock-synthetic-e2e-test"));
      assert.ok(command.includes("flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock"));
      assert.ok(command.includes("matchlock-runtime.env"));
    }
  });

  it("names the worktree-merge gate and the tamandua-test shim command", () => {
    const merge = requiredGateCommand("worktreeMerge", run);
    assert.ok(merge.includes("./run-matchlock-worktree-merge-e2e-test"));
    assert.ok(merge.includes("flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock"));
    const npm = requiredGateCommand("npmTest", run);
    assert.ok(npm.includes("tamandua-test"));
    assert.ok(npm.includes("--run 'run-1'"));
    assert.ok(npm.includes("-- 'npm test'"));
    assert.ok(npm.includes("flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock"));
  });

  it("uses the supplied run metadata", () => {
    const command = requiredGateCommand("npmTest", { ...run, repo: "/custom", runId: "r9" });
    assert.ok(command.includes("--repo '/custom'"));
    assert.ok(command.includes("--run 'r9'"));
  });
});

describe("gateAccepted (US-007)", () => {
  it("only accepts settled green (exit 0) and baseline-subset gates", () => {
    assert.equal(gateAccepted("pending", 0, "/log"), false);
    assert.equal(gateAccepted("pending", null, ""), false);
    assert.equal(gateAccepted("green", 0, "/log"), true);
    assert.equal(gateAccepted("green", 1, "/log"), false);
    assert.equal(gateAccepted("green", 0, ""), false);
    assert.equal(gateAccepted("baseline-subset", 1, "/log"), true);
    assert.equal(gateAccepted("baseline-subset", null, "/log"), false);
    assert.equal(gateAccepted("red", 0, "/log"), false);
    assert.equal(gateAccepted("known-pre-existing-blocker", 1, "/log"), false);
  });
});

describe("baselineComparisonFromUnion3Contract (US-007)", () => {
  it("copies the union3 baselineComparison verbatim", () => {
    const union3 = { schema: "matchlock-union3-contract/1", baselineComparison: FIXTURE_BASELINE_COMPARISON };
    const copied = baselineComparisonFromUnion3Contract(union3);
    assert.deepEqual(copied, FIXTURE_BASELINE_COMPARISON);
    assert.notEqual(copied, union3.baselineComparison);
  });

  it("throws when the union3 contract has no baselineComparison", () => {
    assert.throws(() => baselineComparisonFromUnion3Contract({}), /no baselineComparison/);
    assert.throws(() => baselineComparisonFromUnion3Contract(null), /no baselineComparison/);
  });
});

describe("extractGateInputs (US-007)", () => {
  it("accepts both `{ gates: {...} }` and a bare gate map", () => {
    const gates = settledGreenGates();
    assert.deepEqual(extractGateInputs({ gates }).npmTest, gates.npmTest);
    assert.deepEqual(extractGateInputs(gates).npmTest, gates.npmTest);
    assert.deepEqual(extractGateInputs({}), {});
    assert.deepEqual(extractGateInputs(null), {});
  });
});

describe("publishMatchlockObsContract (US-007)", () => {
  it("reads the union3 baseline + gate results, builds and writes the deliverable", () => {
    const dir = tamanduaTempDir("matchlock-obs-contract-");
    try {
      const union3Path = path.join(dir, "union3.json");
      fs.writeFileSync(
        union3Path,
        JSON.stringify({ schema: "matchlock-union3-contract/1", baselineComparison: FIXTURE_BASELINE_COMPARISON }),
        "utf8",
      );
      const gateResultsPath = path.join(dir, "gate-results.json");
      fs.writeFileSync(
        gateResultsPath,
        JSON.stringify({ gates: settledGreenGates(), vmLifecycle: closedVmLifecycle() }),
        "utf8",
      );
      const outputPath = path.join(dir, "obs.json");

      const published = publishMatchlockObsContract({
        outputPath,
        union3ContractPath: union3Path,
        gateResultsPath,
        generatedAt: "2026-09-16T01:02:03Z",
      });

      assert.equal(published.verdict.green, true);
      assert.ok(fs.existsSync(outputPath));

      const written = JSON.parse(fs.readFileSync(outputPath, "utf8")) as Record<string, unknown>;
      assertHasRequiredKeys(written);
      assert.equal(written.schema, MATCHLOCK_OBS_CONTRACT_SCHEMA);
      assert.equal(written.generatedAt, "2026-09-16T01:02:03Z");
      assert.deepEqual(written.baselineComparison, FIXTURE_BASELINE_COMPARISON);
      const rootCauses = written.rootCauses as Array<{ bead: string }>;
      assert.deepEqual(
        rootCauses.map((cause) => cause.bead).sort(),
        ["tamandua-6sy.33.10.32", "tamandua-6sy.33.33"],
      );
      assert.equal((written.verdict as { green: boolean }).green, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a pending, non-green deliverable when no gate results are supplied", () => {
    const dir = tamanduaTempDir("matchlock-obs-contract-pending-");
    try {
      const union3Path = path.join(dir, "union3.json");
      fs.writeFileSync(
        union3Path,
        JSON.stringify({ baselineComparison: FIXTURE_BASELINE_COMPARISON }),
        "utf8",
      );
      const outputPath = path.join(dir, "obs.json");
      const published = publishMatchlockObsContract({
        outputPath,
        union3ContractPath: union3Path,
        generatedAt: "2026-09-16T01:02:03Z",
      });
      assert.equal(published.verdict.green, false);
      assert.equal(published.verdict.blockingGate, "npmTest");
      const written = JSON.parse(fs.readFileSync(outputPath, "utf8")) as Record<string, unknown>;
      assertHasRequiredKeys(written);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("published MATCHLOCK-OBS deliverable (US-007)", () => {
  it(
    "exists, parses as JSON, carries every required key and documents both root causes",
    {
      skip: (() => {
        const file = process.env.MATCHLOCK_OBS_CONTRACT_PATH ?? DEFAULT_MATCHLOCK_OBS_CONTRACT_PATH;
        return fs.existsSync(file) ? false : `deliverable not found at ${file}`;
      })(),
    },
    () => {
      const file = process.env.MATCHLOCK_OBS_CONTRACT_PATH ?? DEFAULT_MATCHLOCK_OBS_CONTRACT_PATH;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      assertHasRequiredKeys(parsed);
      assert.equal(parsed.schema, MATCHLOCK_OBS_CONTRACT_SCHEMA);
      const rootCauses = parsed.rootCauses as Array<{ bead: string; fixedBy: string[]; mechanism: string }>;
      assert.ok(Array.isArray(rootCauses) && rootCauses.length === 2);
      assert.deepEqual(
        rootCauses.map((cause) => cause.bead).sort(),
        ["tamandua-6sy.33.10.32", "tamandua-6sy.33.33"],
      );
      for (const cause of rootCauses) {
        assert.ok(cause.mechanism.length > 0, `root cause ${cause.bead} must describe its mechanism`);
        assert.ok(cause.fixedBy.length > 0, `root cause ${cause.bead} must name its fixes`);
      }
      const gates = parsed.gates as Record<string, { status: string; command: string }>;
      for (const id of MATCHLOCK_OBS_REQUIRED_GATES) {
        assert.ok(gates[id], `published contract is missing gate '${id}'`);
        assert.ok(gates[id].command.length > 0, `gate '${id}' must carry its command`);
      }
      const verdict = parsed.verdict as { green: boolean; nonGreenReasons: string[] };
      assert.equal(typeof verdict.green, "boolean");
      if (!verdict.green) {
        assert.ok(verdict.nonGreenReasons.length > 0, "a non-green verdict must state its reasons");
      }
    },
  );
});

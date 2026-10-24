/**
 * G8 ADMISSION-INTEGRATION US-011 — fast artifact contract for the on-demand
 * admission-qualification gate.
 *
 * The real-VM gate itself is opt-in (it boots fresh Firecracker VMs and is run
 * only by `./run-matchlock-admission-qualification-e2e-test` under the shared
 * gate lock), so this file is a pure filesystem contract: it pins the artifacts
 * the story adds — the driver, the gate file and their wiring — so a rewrite
 * cannot silently drop the lock handshake, the private surroundings, the seeded
 * image store, the zero-round refusal or the no-VM controls. It also proves the
 * gate never leaks into a default fast lane.
 *
 * Pure filesystem reads (no child_process, no dist import), so this file stays
 * in the PARALLEL lane and needs no tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const DRIVER = "run-matchlock-admission-qualification-e2e-test";
const GATE = "e2e-tests/matchlock-admission-qualification-gate.test.ts";
const GATE_LABEL = "admission-qualification";
const LOCK_FILE = "/home/kaladin/matchlock-work/vaivm-gate.lock";

/** Default fast lanes that must remain free of real-VM Matchlock gates. */
const FAST_LANES = [
  "run-all-e2e-tests",
  "run-all-smoke-e2e-tests",
  "run-all-scripted-e2e-tests",
] as const;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

function expectAll(source: string, needles: readonly string[], file: string): void {
  for (const needle of needles) {
    assert.ok(source.includes(needle), `${file} must contain ${needle}`);
  }
}

describe("US-011 admission-qualification gate artifacts", () => {
  it("ships the gate file with the slow-gate header and an opt-in real-VM guard", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT",
        "NOT part of any default fast lane",
        "const REAL_VM_GATE_ENABLED = EVIDENCE_DIR.length > 0 && MATCHLOCK_RPC_BIN.length > 0;",
        "REAL_VM_GATE_ENABLED ? describe : describe.skip",
        `const GATE_LABEL = "${GATE_LABEL}";`,
        "NO-VM CONTROLS",
      ],
      GATE,
    );
  });

  it("keeps the shared gate lock and the exact-owned cleanup in the tier", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      ["MTLK_GATE_LOCK_HELD", "cleanupOwnedVms", "assertNoOwnedVms", "readVmInventory"],
      GATE,
    );
    // The round evidence goes through the SHARED helper, with the shared label
    // the driver passes to the guard.
    expectAll(
      gate,
      [
        'from "./helpers/matchlock-gate-rounds.ts"',
        "writeObservedRoundsEvidence(",
        "assertObservedRoundsNonZero(",
        "new Set(observedVmIds).size",
        "observed_rounds: observedRounds",
      ],
      GATE,
    );
  });

  it("takes the G9 exit-code owner instead of spelling a status", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      ["gate-exit-code.js", "LAUNCH_GATE_REFUSAL_EXIT_CODE"],
      GATE,
    );
    assert.doesNotMatch(
      gate,
      /\bexitCode\s*(?:===|==|=)\s*78\b/,
      `${GATE} must consume LAUNCH_GATE_REFUSAL_EXIT_CODE, never a status literal`,
    );
  });

  it("ships an executable driver that builds first and allocates a fresh evidence dir", () => {
    const driverPath = path.join(repoRoot, DRIVER);
    assert.ok(fs.existsSync(driverPath), `${DRIVER} must exist`);
    fs.accessSync(driverPath, fs.constants.X_OK);

    const driver = read(DRIVER);
    assert.match(driver, /^#!\/usr\/bin\/env bash/, `${DRIVER} must be a bash script`);
    expectAll(
      driver,
      [
        "npm run build",
        "mktemp -d",
        "TAMANDUA_GATE_EVIDENCE_ROOT:-/home/kaladin/matchlock-work/evidence",
        "evidence dir must live OUTSIDE the worktree",
        'export HOME="$EV/home"',
        'export TAMANDUA_STATE_DIR="$EV/state"',
        'export TMPDIR="$EV/tmp"',
        'echo "evidence dir: $EV"',
        "mtlk_image_store_seed",
        path.join("images", "metadata.db"),
      ],
      DRIVER,
    );
  });

  it("resolves the runtime from PATH (unpinned) and records the observed identity", () => {
    const driver = read(DRIVER);
    expectAll(
      driver,
      [
        "command -v matchlock",
        "command -v guest-init",
        "TAMANDUA_MATCHLOCK_RPC_BIN",
        "MATCHLOCK_GUEST_INIT",
        "MATCHLOCK_GUEST_FUSED",
        "--version",
        "sha256sum",
        "runtime-observed.txt",
        "resolved by matchlock",
      ],
      DRIVER,
    );
    // MTLK-UNPIN: no pinned runtime/image identity in the driver.
    assert.doesNotMatch(driver, /\b[0-9a-f]{64}\b/, `${DRIVER} must not pin a sha256 digest`);
    assert.doesNotMatch(driver, /@sha256:/, `${DRIVER} must not pin an image digest`);
  });

  it("holds the shared gate lock through the MTLK_GATE_LOCK_HELD handshake", () => {
    const driver = read(DRIVER);
    expectAll(
      driver,
      [
        `flock --exclusive ${LOCK_FILE}`,
        "scripts/tests/matchlock/lib/lock.sh",
        "mtlk_gate_lock_acquire",
        "mtlk_gate_lock_release",
        "MTLK_GATE_LOCK_HELD",
        LOCK_FILE,
        "trap 'mtlk_gate_lock_release' EXIT",
      ],
      DRIVER,
    );
  });

  it("runs the gate file, propagates its exit code and then the shared zero-round guard", () => {
    const driver = read(DRIVER);
    const testAt = driver.indexOf(`node --test ${GATE}`);
    const guardAt = driver.indexOf("scripts/observed-rounds-guard.mjs");
    assert.ok(testAt >= 0, `${DRIVER} must launch exactly ${GATE} via node --test`);
    assert.ok(guardAt > testAt, "the guard must run AFTER node --test");
    expectAll(
      driver,
      [
        "PIPESTATUS[0]",
        'exit "$RC"',
        '--dir "$EV"',
        `--gate ${GATE_LABEL}`,
        "exit 92",
        "ZERO-ROUND REFUSAL",
      ],
      DRIVER,
    );
  });

  it("carries no pattern-kill text in the driver or the gate", () => {
    const offenders = [DRIVER, GATE].filter((file) =>
      /\bpkill\b|\bkillall\b|\bpgrep\b|kill\s+-9/.test(read(file)),
    );
    assert.deepEqual(offenders, [], "a remedy must name recorded pids, never a pattern kill");
  });

  it("never leaks the gate or the driver into a default fast lane", () => {
    for (const lane of FAST_LANES) {
      const content = read(lane);
      assert.ok(!content.includes(DRIVER), `${lane} must not run the real-VM driver ${DRIVER}`);
      assert.ok(!content.includes(GATE), `${lane} must not run the real-VM gate ${GATE}`);
      assert.ok(
        !/matchlock-[a-z-]*-gate\.test\.ts/.test(content),
        `${lane} must remain smoke + scripted (zero real-VM gates)`,
      );
    }
  });

  it("is enrolled in the shared Matchlock gate families (guard + unpin)", () => {
    const enrollments: Record<string, readonly string[]> = {
      // The guard-wiring family pins the runner AND the driver it launches.
      "tests/matchlock-observed-rounds.test.ts": [DRIVER, GATE],
      // The observation-wiring family enumerates runners only.
      "tests/matchlock-gate-observation-wiring.test.ts": [DRIVER],
      // The unpin family covers every driver and every gate file.
      "tests/matchlock-unpin.test.ts": [DRIVER, GATE],
    };
    for (const [file, needles] of Object.entries(enrollments)) {
      const content = read(file);
      for (const needle of needles) {
        assert.ok(content.includes(needle), `${file} must enroll ${needle}`);
      }
    }
    assert.ok(
      read("tests/matchlock-observed-rounds.test.ts").includes(`gate: "${GATE_LABEL}"`),
      `tests/matchlock-observed-rounds.test.ts must pin the '${GATE_LABEL}' gate label`,
    );
  });

  it("is not a lane-registered unit test (it is an on-demand e2e gate)", () => {
    const serial = read("tests/serial-files.txt");
    assert.ok(!serial.includes(DRIVER), `${DRIVER} is a shell driver, never a serial-lane entry`);
    assert.ok(!serial.includes(GATE), `${GATE} lives under e2e-tests/ and is never npm-test-laned`);
  });
});

/**
 * G8 US-012 — the scenario-A contract: the gate must drive the REAL run path
 * twice (refusal before any VM, admission with a real VM) with disposable
 * profiles, write every required fact into `<evidence>/scenario-a/`, and record
 * a VM-boot-blocked sandbox as ENVIRONMENT instead of a product failure.
 */
describe("US-012 admission-qualification scenario A contract", () => {
  it("drives both scenarios through the real isolated-daemon → hermes Matchlock path", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "runScenarioA1Refusal",
        "runScenarioA2Allow",
        "startIsolatedDaemon",
        "spawnWorkflowRun",
        '"workflow", "run", "do-now"',
        '"--hermes-as-harness"',
        '"--working-directory-for-harness", repoDir',
        '"--matchlock-image", FIXTURE_IMAGE_TAG',
        'prepareScenarioDirectory(evidenceRoot, "A1-refusal")',
        'prepareScenarioDirectory(evidenceRoot, "A2-allow")',
      ],
      GATE,
    );
  });

  it("asserts A1: zero owned VMs, ONE refusal event, a terminal failed run and a parseable receipt", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "run.matchlock_gate_refused",
        "exactly ONE refusal event",
        "findingCodes",
        "readVmInventory(profile.home)",
        "observedVmIds: []",
        "no partial mount",
        'assert.equal(status, "failed"',
      ],
      GATE,
    );
  });

  it("asserts A2: a launched receipt after vmCreated, a closed real VM and the artifact binding", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        'parsed.action === "launched"',
        '"scheduled-attempt"',
        "GATE_QUALIFICATION_RECORD_KIND",
        "qualification.image.digest",
        "qualification.candidate.distRoot",
        "readRunnerVmEvidenceIds(",
        "assertNoOwnedVms(profile.home, \"scenario A2\"",
      ],
      GATE,
    );
  });

  it("records run ids, receipts, digests and the exact commands under <evidence>/scenario-a", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        '"scenario-a"',
        "evidence.json",
        "commands.txt",
        "writeScenarioAEvidence(",
        "distVersionStamp:",
        "sha256: sha256File(MATCHLOCK_RPC_BIN)",
        "runId,",
      ],
      GATE,
    );
  });

  it("records a VM-boot-blocked sandbox as ENVIRONMENT rather than a product failure", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "environment-blocked.json",
        'class: "ENVIRONMENT"',
        "TUNSETIFF: operation not permitted",
        "netlink receive: operation not permitted",
        "sandboxSelfSignature",
        "t.skip(",
        "NOT a product failure and NOT a qualification pass",
        // A cleanup failure must be captured, recorded, and then be FATAL:
        // a retained owned VM is never certified clean and never skipped.
        "retainedVmIds",
        "cleanupFailure",
        "RETAINED",
      ],
      GATE,
    );
  });

  it("uses disposable profiles only and never names the operator home literally", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "assertDisposableProfilePath",
        "operatorHomeSignature",
        "TAMANDUA_GATE_OPERATOR_HOME",
        "the operator profile root must be untouched",
      ],
      GATE,
    );
    // Comment-blind: the prose may NAME the operator home it refuses to touch;
    // the CODE must derive every profile path from the environment.
    const code = gate
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !code.includes("/home/kaladin/.hermes"),
      `${GATE} must never hardcode the operator home (it is only ever a reference via TAMANDUA_GATE_OPERATOR_HOME)`,
    );
    assert.ok(
      code.includes("operatorHermesDir("),
      `${GATE} must derive the operator profile root through operatorHermesDir()`,
    );
    assert.ok(
      code.includes("path.join(operatorHome, \".hermes\")"),
      "operatorHermesDir() is the ONE place the operator profile root is composed",
    );
    assert.ok(
      !/OPERATOR_HOME[^\n]*\.hermes/.test(code),
      `${GATE} must never append a profile path to OPERATOR_HOME outside operatorHermesDir()`,
    );
  });
});

/**
 * G8 US-013 — the scenario-C contract: the mixed native/guest overlap (C1) and
 * the transient rollback-journal refusal (C2). Both must be exercised WITHOUT a
 * VM under `npm test` (the no-VM controls), driven through the REAL run path in
 * the opt-in tier, recorded with the no-lease limitation, and cleaned up by
 * recorded pid only.
 */
describe("US-013 admission-qualification scenario C contract", () => {
  const NATIVE_WRITER = "e2e-tests/helpers/store-native-writer.mjs";

  it("ships the native writer process with a recorded pid and a durable commit ledger", () => {
    const writer = read(NATIVE_WRITER);
    expectAll(
      writer,
      [
        "openE2eDatabase",
        '"--ledger"',
        '"--duration-ms"',
        '"--interval-ms"',
        "SIGTERM",
        "SIGINT",
        "appendLedger",
        'kind: "commit"',
        'kind: "summary"',
        "committed",
        "process.pid",
        "PRIMARY KEY",
      ],
      NATIVE_WRITER,
    );
    // One row per committed transaction, ledgered BEFORE the next attempt.
    assert.match(writer, /PRIMARY KEY \(writer, seq\)/);
    assert.ok(writer.includes("process.stdout.write"), "the writer announces its pid");
  });

  it("adds scenario C to the gate: the mixed overlap and the journal transition", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "SCENARIO C",
        "C1-mixed-overlap",
        "C2-journal-transition",
        "runScenarioC1MixedOverlap",
        "runScenarioC2JournalTransition",
        "startNativeWriter(",
        "stopNativeWriterByPid(",
        "PRAGMA integrity_check",
        "missingRecords",
        "expectedRecords",
        "retainedRecords",
        "sidecar-unresolved",
        "rollback journal, not a write-ahead-log",
        "a checkpoint is NOT a treatment for it",
        "writeNonEmptyRollbackJournal(",
        "journalNeverDeletedByGate",
        "storeIdentityUnchanged",
        "liveWriterPids",
        "NO_LEASE_LIMITATION",
        "C1 ADMITTED OVERLAP",
        "C2 TRANSIENT REFUSAL",
      ],
      GATE,
    );
  });

  it("runs C1 and C2 as no-VM controls (no VM, no model) and in the real-VM tier", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "SCENARIO C NO-VM CONTROLS",
        "two independent writer processes keep every committed record",
        "a nonempty -journal refuses with sidecar-unresolved",
        "scenario C1: overlapping native and guest writers",
        "scenario C2: a nonempty rollback journal refuses through the real run path",
        "the GUEST's sessions row must be retained",
        "the native writer and the guest round must overlap",
      ],
      GATE,
    );
  });

  it("stops every writer by recorded pid and never by name or pattern", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "native-writer-${options.label}.pid",
        "process.kill(handle.pid, \"SIGTERM\")",
        "the recorded pid must be the spawned writer pid",
        "the writer must announce the same pid that was recorded",
      ],
      GATE,
    );
    // The same no-pattern-kill rule the US-011 block pins for the driver.
    for (const file of [GATE, NATIVE_WRITER]) {
      assert.doesNotMatch(
        read(file),
        /\bpkill\b|\bkillall\b|\bpgrep\b|kill\s+-9/,
        `${file} must name recorded pids, never a pattern kill`,
      );
    }
  });

  it("keeps the scenario-C no-VM controls in the default suite (npm test, serial lane)", () => {
    const file = "tests/matchlock-scenario-c-controls.test.ts";
    const content = read(file);
    expectAll(
      content,
      [
        "US-013 C1 native concurrency integrity (no VM)",
        "US-013 C2 transient rollback journal (no VM)",
        "PRAGMA integrity_check",
        "sidecar-unresolved",
        "rollback journal, not a write-ahead-log",
        "a checkpoint is NOT a treatment for it",
        "allows once the journal is gone",
      ],
      file,
    );
    assert.ok(
      read("tests/serial-files.txt").includes(file),
      `${file} starts real writer processes, so it belongs to the serial lane`,
    );
  });

  it("discloses the live operator home's ambient churn instead of treating it as gate evidence", () => {
    const gate = read(GATE);
    expectAll(
      gate,
      [
        "assertOperatorHomeUntouched(",
        "the operator profile root must be untouched",
        "the gate creates, removes and renames NOTHING there",
        "its config must NOT be edited",
        "operatorHomeGateRecord(",
        "ambientDirectoryMtimeChanged",
      ],
      GATE,
    );
  });

  it("refreshes the driver's scenario note now that A and C exist", () => {
    const driver = read(DRIVER);
    expectAll(
      driver,
      [
        "A1 (refusal before any VM)",
        "C1 (the mixed",
        "C2 (the transient",
        "the observed-rounds guard still refuses PASS (exit 92)",
      ],
      DRIVER,
    );
    assert.ok(
      !driver.includes("Until they exist this gate"),
      `${DRIVER} must not keep the stale 'until they exist' scenario note`,
    );
  });
});

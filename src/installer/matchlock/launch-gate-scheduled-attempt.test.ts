/**
 * launch-gate-scheduled-attempt.test.ts — G8 ADMISSION-INTEGRATION US-006.
 *
 * Coverage for the ATTEMPT-time launch gate: the scheduled hermes round
 * re-evaluates the gate from FRESH state immediately before the VM create and
 * hands the resulting binding to the controller backstop, because a queued
 * round can wait hours between its dispatch preflight and its actual launch.
 *
 * What is pinned here, on the REAL production funnel
 * (`runMatchlockSchedulerRound` -> `runProductionMatchlockRound` ->
 * `runProductionHermesRound` + the REAL scheduled gate adapter and the REAL
 * refusal recorder):
 *
 *   - a dispatch-time ALLOW that goes stale (the store becomes a WAL store)
 *     refuses at attempt time: exit 78, a written `scheduled-attempt` receipt,
 *     ONE recorded refusal (event + force-fail) and ZERO Hermes-runner calls
 *     (no VM/RPC construction at all);
 *   - the attempt observation is FRESH, never the dispatch verdict: a store
 *     that APPEARS after the dispatch allow (or one whose inode is replaced at
 *     the same path) refuses operationally;
 *   - the attempt binding has its own invocation id (`...:attempt`), is the
 *     value passed as `RunHermesInvocationOptions.launchGate`, and differs
 *     from the dispatch id — so a dispatch binding can never satisfy the
 *     controller;
 *   - a probe round is gated too (a probe boots a real VM);
 *   - a refused attempt is recorded once: a later tick for an already-terminal
 *     run records nothing (no retry storm);
 *   - a throwing attempt evaluator is a typed `matchlock_gate_evaluation_failed`
 *     infrastructure failure with zero runner calls;
 *   - pi and dsh are not attempt-gated (evaluator returns null with ZERO
 *     observation, and there is exactly one attempt-gate call site, inside the
 *     hermes round runner).
 *
 * Nothing here boots a VM, spawns a harness or touches a real Hermes home:
 * profiles are disposable directories with real (or byte-exact) SQLite stores,
 * the Hermes invocation runner is replaced by the narrow
 * `setMatchlockHermesInvocationRunnerForTest` seam, and the execution-boundary
 * swap probe / short-HOME alias are injected.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import { LAUNCH_GATE_REFUSAL_EXIT_CODE } from "../../../dist/installer/matchlock/gate-exit-code.js";
import {
  NO_LEASE_LIMITATION,
  parseReceipt,
} from "../../../dist/installer/matchlock/gate-receipt.js";
import {
  evaluateScheduledAttemptGate,
  evaluateScheduledDispatchGate,
  scheduledLaunchGateInvocationId,
} from "../../../dist/installer/matchlock/launch-gate-scheduled.js";
import { evaluateGate } from "../../../dist/installer/matchlock/launch-gate.js";
import { observeStore } from "../../../dist/installer/matchlock/store-header.js";
import {
  MatchlockRunnerError,
  runMatchlockSchedulerRound,
  setMatchlockHermesInvocationRunnerForTest,
  setMatchlockHomeAliasResolverForTest,
  setMatchlockScheduledLaunchGateForTest,
  type MatchlockSchedulerRound,
} from "../../../dist/installer/matchlock/scheduler-matchlock.js";
import { setMatchlockExecutionBoundarySeamsForTest } from "../../../dist/installer/matchlock/execution-boundary.js";
import {
  buildMatchlockPolicy,
  MATCHLOCK_NETWORK_POLICY_VERSION,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";

const HERE = path.dirname(import.meta.filename);
const MODULE_PATH = path.join(HERE, "scheduler-matchlock.ts");
const HERMES_RUNNER_PATH = path.join(HERE, "hermes-invocation-runner.ts");

/** Every temp dir this file creates, removed in `after`. */
const temporaryDirectories: string[] = [];

function track(directory: string): string {
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * Private root for the host paths the FAKE runner/seams are handed. Nothing
 * is ever created at them (the seams intercept before any VM), and they are
 * real temp dirs rather than hardcoded system paths.
 */
const FAKE_ROOT = track(tamanduaShortTempDir("tamandua-attempt-gate-fake-"));

/** The short-HOME alias the round is handed. */
const ALIAS = path.join(FAKE_ROOT, "h");

const RUN_ID = "run-7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b";
const BARE_RUN_ID = "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b";
const JOB_ID = "job-feature-dev-merge-worktree_developer";
const ATTEMPT_ID = `run:${BARE_RUN_ID}:round:${JOB_ID}:attempt`;
const DISPATCH_ID = `run:${BARE_RUN_ID}:round:${JOB_ID}:dispatch`;

function newStateDir(): string {
  return track(tamanduaShortTempDir("tamandua-attempt-gate-state-"));
}

function newOperatorHome(): string {
  return track(tamanduaShortTempDir("tamandua-attempt-gate-home-"));
}

/** A disposable Hermes profile home with a `config.yaml` journal mode. */
function newHermesProfile(journalMode: "delete" | "wal"): string {
  const operatorHome = newOperatorHome();
  const hermes = path.join(operatorHome, ".hermes");
  fs.mkdirSync(hermes, { recursive: true });
  fs.writeFileSync(path.join(hermes, "config.yaml"), `database:\n  journal_mode: ${journalMode}\n`);
  return operatorHome;
}

/** A real rollback-format SQLite store (header version pair (1, 1)). */
function writeRollbackStore(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
  database.exec("INSERT INTO t (value) VALUES ('row')");
  database.close();
}

/** A write-ahead-log store: correct SQLite signature, version pair (2, 2). */
function writeWalStore(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(header, 0);
  header[18] = 2;
  header[19] = 2;
  fs.writeFileSync(file, header);
}

function storePathOf(operatorHome: string): string {
  return path.join(operatorHome, ".hermes", "state.db");
}

/** A COMPLIANT profile: config `delete` + a rollback-format store. */
function newCompliantProfile(): string {
  const operatorHome = newHermesProfile("delete");
  writeRollbackStore(storePathOf(operatorHome));
  return operatorHome;
}

/** A persisted harness:"hermes" policy for one frozen operator home. */
function hermesPolicy(operatorHome: string): ExecutionIsolation {
  return buildMatchlockPolicy({
    requestedImage: "vic/hermes:latest",
    identity: {
      digest: `sha256:${"c".repeat(64)}`,
      config_digest: `sha256:${"d".repeat(64)}`,
      tag: "vic/hermes:latest",
    },
    harness: "hermes",
    workingDirectory: "/srv/project",
    originalRepositoryRoot: "/srv/project",
    workMounts: [
      { hostPath: "/srv/project", hostRealPath: "/srv/project", guestPath: "/srv/project" },
    ],
    gitMetadataRoots: [],
    configurationRoot: path.join(operatorHome, ".hermes"),
    configurationProfile: "default",
    guestConfigurationRoot: "/workspace/config/hermes",
    hermes: { homeDir: operatorHome, cwd: "/srv/project", hermesHomeEnv: null },
  });
}

/** A persisted harness:"pi" policy (never gated). */
function piPolicy(): ExecutionIsolation {
  return {
    version: 1,
    backend: "matchlock",
    requestedImage: "tamandua-synthetic-pi:gate-fixture",
    harness: "pi",
    configurationRoot: "/opt/config/pi",
    configurationProfile: "settings.json",
    guestConfigurationRoot: "/workspace/config/pi",
    workPathMode: "host-absolute",
    workingDirectory: "/srv/project",
    workMounts: [
      { hostPath: "/srv/project", hostRealPath: "/srv/project", guestPath: "/srv/project" },
    ],
    originalRepositoryRoot: "/srv/project",
    gitMetadataRoots: ["/srv/project/.git"],
    mountPolicyVersion: 1,
    networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
    resolvedImageDigest: `sha256:${"1".repeat(64)}`,
    resolvedImageConfigDigest: `sha256:${"2".repeat(64)}`,
  } as unknown as ExecutionIsolation;
}

/** A persisted harness:"dsh" policy (never gated). */
function dshPolicy(): ExecutionIsolation {
  return buildMatchlockPolicy({
    requestedImage: "vic/dsh:latest",
    identity: {
      digest: `sha256:${"5".repeat(64)}`,
      config_digest: `sha256:${"6".repeat(64)}`,
      tag: "vic/dsh:latest",
    },
    harness: "dsh",
    configurationRoot: "/home/operator/.dsh",
    submissionHomeDir: "/home/operator",
    submissionCwd: "/srv/project",
    submissionDshHomeEnv: null,
    submissionDshHomeSource: "default",
    workingDirectory: "/srv/project",
    originalRepositoryRoot: "/srv/project",
    workMounts: [
      { hostPath: "/srv/project", hostRealPath: "/srv/project", guestPath: "/srv/project" },
    ],
    gitMetadataRoots: [],
  });
}

/** The fake host-suite wiring: never touched (the runner seam replaces it). */
const FAKE_SUITE = {
  storePath: path.join(FAKE_ROOT, "suite.db"),
  namespace: {
    imageContentId: `sha256:${"9".repeat(64)}`,
    guestPlatform: "linux/amd64",
    helperContract: "guest-helper-test",
    compatibilityFingerprint: "test",
  },
  admittedRoots: ["/srv/project"],
};

/** One scheduled round over a policy (no pack/suite build: both supplied). */
function roundFor(
  policy: ExecutionIsolation,
  over: Partial<MatchlockSchedulerRound> = {},
): MatchlockSchedulerRound {
  return {
    policy,
    identity: {
      runId: RUN_ID,
      agentId: "feature-dev-merge-worktree_developer",
      workflowId: "do-now",
      jobId: JOB_ID,
    },
    kind: "work",
    promptText: "do work",
    workingDirectoryForHarness: policy.workingDirectory,
    timeoutMs: 1000,
    helperPackHostPath: path.join(FAKE_ROOT, "pack"),
    suite: FAKE_SUITE as never,
    ...over,
  };
}

/** A fake Hermes invocation result (the seam never constructs a VM). */
function okHermesResult(): never {
  return {
    output: "STATUS: done\n",
    exitCode: 0,
    signal: null,
    stderrTail: "",
    timedOut: false,
    durationMs: 10,
    truncated: false,
    invocationId: "fake-invocation",
    vmId: "vm-fake",
    kind: "work",
    runId: BARE_RUN_ID,
    cleanupConfirmed: true,
    suiteAbsent: false,
  } as never;
}

/**
 * The subset of a recorded `run.matchlock_gate_refused` event this file reads.
 *
 * Declared LOCALLY on purpose: importing `events.ts` from a `src/**` test file
 * requires the test-isolation guard helpers (`tests/test-isolation-guard.ts`),
 * and this file only asserts the emitted payload's shape.
 */
interface RecordedGateEvent {
  ts: string;
  event: string;
  runId: string;
  invocationId?: string;
  storeSetKey?: string;
  receiptPath?: string;
  findingCodes?: string[];
  exitCode?: number;
  reason?: string;
  detail?: string;
}

/** Deterministic gate deps: hermetic managed scope, pinned receipt state dir. */
function baseGateDeps(stateDir: string): Record<string, unknown> {
  return {
    stateDir,
    configOptions: { managedDir: null },
    // The recorder's default log seam is the real file logger; a test must
    // never emit into the live state dir (test-isolation guard ledger).
    log: () => {},
  };
}

// ---------------------------------------------------------------------------
// production funnel harness
// ---------------------------------------------------------------------------

interface FunnelOptions {
  /** Run-row status the recorder reads (`force-fail` flips it to 'failed'). */
  runStatus?: () => string;
}

/**
 * Install the seams a VM-free production-funnel run needs: the injected
 * execution boundary (no swap probe), the short-HOME alias, and the fake
 * Hermes invocation runner (which counts calls and records its options).
 */
function installFunnelSeams(): {
  runnerCalls: Array<Record<string, unknown>>;
} {
  const runnerCalls: Array<Record<string, unknown>> = [];
  setMatchlockHomeAliasResolverForTest(() => ALIAS);
  setMatchlockExecutionBoundarySeamsForTest({
    swapSupportProbe: (binaryPath: string) => ({ supported: true, binaryPath }),
  });
  setMatchlockHermesInvocationRunnerForTest(async (opts) => {
    runnerCalls.push(opts as unknown as Record<string, unknown>);
    return okHermesResult();
  });
  return { runnerCalls };
}

describe("scheduled ATTEMPT launch gate (US-006)", () => {
  beforeEach(() => {
    setMatchlockHomeAliasResolverForTest(() => ALIAS);
    setMatchlockExecutionBoundarySeamsForTest({
      swapSupportProbe: (binaryPath: string) => ({ supported: true, binaryPath }),
    });
  });

  afterEach(() => {
    setMatchlockScheduledLaunchGateForTest(null);
    setMatchlockHermesInvocationRunnerForTest(null);
    setMatchlockHomeAliasResolverForTest(null);
    setMatchlockExecutionBoundarySeamsForTest(null);
  });

  // ── stale dispatch allow ────────────────────────────────────────────────

  it("refuses at ATTEMPT when the store becomes WAL after a dispatch-time ALLOW (zero runner calls)", async () => {
    const operatorHome = newCompliantProfile();
    const stateDir = newStateDir();
    const { runnerCalls } = installFunnelSeams();

    const events: RecordedGateEvent[] = [];
    const forced: Array<{ runId: string; reason: string }> = [];
    let dispatchAllowed = false;
    let runStatus = "running";

    setMatchlockScheduledLaunchGateForTest({
      // DISPATCH: the real gate, then the world changes the moment it allows.
      evaluate: (round, deps) => {
        const decision = evaluateScheduledDispatchGate(round, deps);
        if (decision !== null && decision.action === "allow") {
          dispatchAllowed = true;
          // Same path, same config: only the STORE changes (delete -> wal).
          writeWalStore(storePathOf(operatorHome));
        }
        return decision;
      },
      // ATTEMPT: the PRODUCTION evaluator — fresh observation, never the
      // dispatch verdict.
      evaluateAttempt: evaluateScheduledAttemptGate,
      gateDeps: {
        ...baseGateDeps(stateDir),
        readRun: () => ({ status: runStatus, scheduling_status: "active" }),
        emit: (evt) => {
          events.push(evt);
        },
        readEvents: () => events,
        forceFail: async (runId: string, reason: string) => {
          forced.push({ runId, reason });
          runStatus = "failed";
          return { ok: true };
        },
      },
    });

    const result = await runMatchlockSchedulerRound(roundFor(hermesPolicy(operatorHome)));

    assert.equal(dispatchAllowed, true, "the dispatch preflight allowed the fresh profile");
    assert.equal(result.gateRefused, true, "the stale dispatch allow is NOT reused");
    assert.equal(String(result.output), "", "nothing ran");
    assert.equal(result.exitCode, null);
    assert.equal(
      runnerCalls.length,
      0,
      "ZERO Hermes-runner invocations: no VM, no RPC, no mount was constructed",
    );

    // Exactly ONE refusal record, bound to the ATTEMPT invocation — never the
    // dispatch one (the dispatch evaluation allowed, so it wrote no receipt).
    assert.equal(events.length, 1, "exactly one run.matchlock_gate_refused event");
    const event = events[0];
    assert.equal(event.event, "run.matchlock_gate_refused");
    assert.equal(event.invocationId, ATTEMPT_ID, "the event is bound to THIS attempt");
    assert.notEqual(event.invocationId, DISPATCH_ID);
    assert.equal(event.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.deepEqual(
      [...(event.findingCodes as string[])].sort(),
      ["wal-header"],
      "the verdict comes from the ATTEMPT's fresh header observation (config still delete)",
    );
    assert.equal(forced.length, 1, "the run was force-failed exactly once");
    assert.match(forced[0].reason, /launch gate refused/i);

    // The receipt FIRST: written by the wiring, for the attempt slot.
    const receiptPath = String(event.receiptPath);
    assert.ok(fs.existsSync(receiptPath), "the refusal receipt exists");
    assert.match(receiptPath, /attempt-[0-9a-f]+\.json$/, "the attempt has its OWN receipt slot");
    const receipt = parseReceipt(fs.readFileSync(receiptPath, "utf8").trimEnd());
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.equal(receipt.invocation.kind, "scheduled-attempt");
    assert.equal(receipt.invocation.runId, RUN_ID);
    assert.equal(receipt.invocation.roundId, JOB_ID);
    assert.equal(String(receipt.storeSetKey), event.storeSetKey, "the event cites the receipt's key");
    assert.equal(
      receipt.holderDetection.limitation,
      NO_LEASE_LIMITATION,
      "the receipt states the no-lease limitation",
    );
    assert.ok(receipt.findings.every((finding) => Array.isArray(finding.remedy)));
  });

  it("a refusal at ATTEMPT is recorded ONCE: a later tick for the now-terminal run records nothing", async () => {
    const operatorHome = newCompliantProfile();
    const stateDir = newStateDir();
    const { runnerCalls } = installFunnelSeams();
    const events: RecordedGateEvent[] = [];
    const forced: string[] = [];
    let runStatus = "running";
    let dispatchCalls = 0;

    setMatchlockScheduledLaunchGateForTest({
      evaluate: (round, deps) => {
        dispatchCalls += 1;
        const decision = evaluateScheduledDispatchGate(round, deps);
        // Only the FIRST dispatch evaluation is allowed; afterwards the store
        // is a WAL store and the attempt must keep refusing from fresh state.
        if (dispatchCalls === 1 && decision !== null && decision.action === "allow") {
          writeWalStore(storePathOf(operatorHome));
        }
        return dispatchCalls === 1 ? decision : { action: "allow", binding: null } as never;
      },
      evaluateAttempt: evaluateScheduledAttemptGate,
      gateDeps: {
        ...baseGateDeps(stateDir),
        readRun: () => ({ status: runStatus, scheduling_status: "active" }),
        emit: (evt) => {
          events.push(evt);
        },
        readEvents: () => events,
        forceFail: async (runId: string, reason: string) => {
          forced.push(reason);
          runStatus = "failed";
          return { ok: true };
        },
      },
    });

    const round = roundFor(hermesPolicy(operatorHome));
    const first = await runMatchlockSchedulerRound(round);
    assert.equal(first.gateRefused, true);
    assert.equal(events.length, 1);
    assert.equal(forced.length, 1);

    // The next scheduled tick re-evaluates and refuses again, but the run row
    // is terminal now: NOTHING further is recorded and no VM is created.
    const second = await runMatchlockSchedulerRound(round);
    assert.equal(second.gateRefused, true);
    assert.equal(events.length, 1, "no second event for an already-terminal run");
    assert.equal(forced.length, 1, "no second force-fail");
    assert.equal(runnerCalls.length, 0, "still zero runner calls across both ticks");
  });

  // ── fresh state, never the dispatch verdict ─────────────────────────────

  it("refuses when a SECOND store APPEARS after the dispatch allow (membership is re-observed)", async () => {
    const operatorHome = newCompliantProfile();
    const stateDir = newStateDir();
    const { runnerCalls } = installFunnelSeams();
    const events: RecordedGateEvent[] = [];

    setMatchlockScheduledLaunchGateForTest({
      evaluate: (round, deps) => {
        const decision = evaluateScheduledDispatchGate(round, deps);
        if (decision !== null && decision.action === "allow") {
          writeWalStore(path.join(operatorHome, ".hermes", "verification_evidence.db"));
        }
        return decision;
      },
      evaluateAttempt: evaluateScheduledAttemptGate,
      gateDeps: {
        ...baseGateDeps(stateDir),
        readRun: () => ({ status: "running", scheduling_status: "active" }),
        emit: (evt) => {
          events.push(evt);
        },
        readEvents: () => events,
        forceFail: async () => ({ ok: true }),
      },
    });

    const result = await runMatchlockSchedulerRound(roundFor(hermesPolicy(operatorHome)));
    assert.equal(result.gateRefused, true, "the appeared store is seen by the attempt");
    assert.equal(runnerCalls.length, 0);
    assert.equal(events.length, 1);

    const receipt = parseReceipt(fs.readFileSync(String(events[0].receiptPath), "utf8").trimEnd());
    assert.equal(receipt.invocation.kind, "scheduled-attempt");
    assert.ok(
      receipt.stores.some((store) => String(store.canonicalPath).endsWith("verification_evidence.db")),
      "the receipt pins the store the dispatch evaluation never saw",
    );
    assert.ok(
      receipt.findings.some((finding) => finding.code === "wal-header"),
      "the appeared WAL store is judged on its own header",
    );
  });

  it("refuses operationally when the store INODE is replaced between the attempt's observation and its create", async () => {
    const operatorHome = newCompliantProfile();
    const stateDir = newStateDir();
    const { runnerCalls } = installFunnelSeams();
    const events: RecordedGateEvent[] = [];
    // The window the revalidation exists to close is INSIDE one evaluation:
    // observe -> evaluate -> revalidate. The dispatch evaluation (call 1) is
    // left alone; the ATTEMPT's own evaluation (call 2) sweeps the store out
    // from under itself AFTER its verdict, so the fresh snapshot it binds to
    // no longer matches the world at revalidation time.
    let gateEvaluations = 0;

    setMatchlockScheduledLaunchGateForTest({
      gateDeps: {
        ...baseGateDeps(stateDir),
        evaluateGate: (input) => {
          const verdict = evaluateGate(input);
          gateEvaluations += 1;
          if (gateEvaluations === 2) {
            // Same canonical path, still a rollback-format store with a delete
            // config — only the IDENTITY changes. The ORIGINAL is renamed away
            // (not deleted) so the replacement is guaranteed a different
            // (dev, ino): many filesystems reuse an inode after a delete.
            fs.renameSync(storePathOf(operatorHome), `${storePathOf(operatorHome)}.old`);
            writeRollbackStore(storePathOf(operatorHome));
          }
          return verdict;
        },
        readRun: () => ({ status: "running", scheduling_status: "active" }),
        emit: (evt) => {
          events.push(evt);
        },
        readEvents: () => events,
        forceFail: async () => ({ ok: true }),
      },
    });

    const result = await runMatchlockSchedulerRound(roundFor(hermesPolicy(operatorHome)));
    assert.equal(gateEvaluations, 2, "dispatch and attempt each evaluated once");
    assert.equal(result.gateRefused, true, "a replaced inode is refused by identity, not by header");
    assert.equal(runnerCalls.length, 0);

    const receipt = parseReceipt(fs.readFileSync(String(events[0].receiptPath), "utf8").trimEnd());
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.invocation.kind, "scheduled-attempt");
    assert.deepEqual(receipt.findings, [], "an operational refusal invents no reason code");
    // The operational class is visible on the recorded evidence: the event
    // carries the operational reason class and the revalidation detail that
    // names the changed field (the receipt itself keeps the closed ten-code
    // vocabulary, so its findings stay empty).
    assert.equal(events[0].reason, "matchlock_launch_gate_operational_refusal");
    assert.match(String(events[0].detail), /store-identity-changed/);
    assert.match(String(events[0].detail), /state\.db/);
  });

  // ── allow path: the ATTEMPT binding reaches the runner/controller ───────

  it("allows a compliant profile and passes the ATTEMPT binding (own id) to the controller seam", async () => {
    const operatorHome = newCompliantProfile();
    const stateDir = newStateDir();
    const { runnerCalls } = installFunnelSeams();
    const events: RecordedGateEvent[] = [];

    setMatchlockScheduledLaunchGateForTest({
      gateDeps: {
        ...baseGateDeps(stateDir),
        readRun: () => ({ status: "running", scheduling_status: "active" }),
        emit: (evt) => {
          events.push(evt);
        },
        readEvents: () => events,
        forceFail: async () => ({ ok: true }),
      },
    });

    const result = await runMatchlockSchedulerRound(roundFor(hermesPolicy(operatorHome)));

    assert.notEqual(result.gateRefused, true);
    assert.equal(runnerCalls.length, 1, "exactly one Hermes invocation");
    const opts = runnerCalls[0] as {
      launchGate?: Record<string, unknown>;
      launchGateDecision?: {
        action?: string;
        binding?: Record<string, unknown>;
        receiptInput?: { verdict?: string; findings?: unknown[]; stores?: unknown[] };
      };
      kind?: string;
      submission?: { homeDir?: string };
    };
    const binding = opts.launchGate;
    assert.ok(binding, "the attempt binding is passed to the runner");
    assert.equal(binding.kind, "scheduled-attempt");
    assert.equal(binding.invocationId, ATTEMPT_ID, "the binding is THIS attempt's verdict");
    assert.notEqual(binding.invocationId, DISPATCH_ID);
    assert.match(String(binding.storeSetKey), /^sha256:[0-9a-f]{64}$/);
    assert.equal(binding.configJournalMode, "delete");
    assert.equal(
      fs.existsSync(String(binding.receiptPath)),
      false,
      "no receipt is written before vmCreated (the launch receipt is post-create)",
    );
    assert.equal(events.length, 0, "an allow records nothing");
    assert.equal(opts.kind, "work");

    // G8 US-012: the FULL allow decision travels too, so the runner can write
    // the `action: "launched"` receipt the instant a VM exists. It is the SAME
    // attempt verdict (never the dispatch one) and carries the pre-create
    // receipt input with an `allow` verdict and no findings.
    const decision = opts.launchGateDecision;
    assert.ok(decision, "the allow decision (binding + receipt input) is passed to the runner");
    assert.equal(decision.action, "allow");
    assert.equal(decision.binding?.invocationId, ATTEMPT_ID);
    assert.equal(decision.binding?.storeSetKey, binding.storeSetKey);
    assert.equal(decision.receiptInput?.verdict, "allow");
    assert.deepEqual(decision.receiptInput?.findings, []);
    assert.equal(
      (decision.receiptInput as { vmCreated?: boolean }).vmCreated,
      undefined,
      "the pre-create receipt input never claims vmCreated",
    );
    assert.equal(
      fs.existsSync(String(binding.receiptPath)),
      false,
      "handing the decision to the runner writes nothing until a VM exists",
    );

    // The runner forwards that binding to the controller backstop (US-004).
    // The controller-level refusal matrix is pinned by launch-gate-backstop.test.ts;
    // this pins that the value the scheduler produced is the one forwarded.
    const runnerSource = fs.readFileSync(HERMES_RUNNER_PATH, "utf8");
    assert.match(
      runnerSource,
      /launchGate:\s*\n\s*opts\.launchGate !== undefined/,
      "hermes-invocation-runner forwards opts.launchGate to the controller",
    );
  });

  it("gates the PROBE round at attempt too (a probe boots a real VM)", async () => {
    const operatorHome = newCompliantProfile();
    const stateDir = newStateDir();
    const { runnerCalls } = installFunnelSeams();

    setMatchlockScheduledLaunchGateForTest({
      gateDeps: {
        ...baseGateDeps(stateDir),
        readRun: () => ({ status: "running", scheduling_status: "active" }),
        emit: () => {},
        readEvents: () => [],
        forceFail: async () => ({ ok: true }),
      },
    });

    const result = await runMatchlockSchedulerRound(
      roundFor(hermesPolicy(operatorHome), { kind: "probe" }),
    );
    assert.notEqual(result.gateRefused, true);
    assert.equal(runnerCalls.length, 1);
    const opts = runnerCalls[0] as { kind?: string; launchGate?: Record<string, unknown> };
    assert.equal(opts.kind, "probe");
    assert.equal(opts.launchGate?.invocationId, ATTEMPT_ID);
  });

  // ── machinery failure ──────────────────────────────────────────────────

  it("a THROWING attempt evaluator is a typed matchlock_gate_evaluation_failed (zero runner calls)", async () => {
    const operatorHome = newCompliantProfile();
    installFunnelSeams();
    setMatchlockScheduledLaunchGateForTest({
      evaluate: () => null,
      evaluateAttempt: () => {
        throw new Error("synthetic attempt evaluator failure");
      },
    });

    const error = await runMatchlockSchedulerRound(roundFor(hermesPolicy(operatorHome))).then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(error instanceof MatchlockRunnerError, "a gate machinery failure is a typed infra error");
    assert.equal((error as InstanceType<typeof MatchlockRunnerError>).code, "matchlock_gate_evaluation_failed");
    assert.match((error as Error).message, /synthetic attempt evaluator failure/);
    assert.match((error as Error).message, /refusing before any VM create/);
  });

  // ── pi / dsh differential ──────────────────────────────────────────────

  it("pi and dsh rounds are NOT attempt-gated: the evaluator returns null with ZERO observation", () => {
    const stateDir = newStateDir();
    const observed: string[] = [];
    const deps = {
      ...baseGateDeps(stateDir),
      observeStore: (storePath: string) => {
        observed.push(storePath);
        return observeStore(storePath);
      },
    };

    assert.equal(evaluateScheduledAttemptGate(roundFor(piPolicy()), deps), null);
    assert.equal(evaluateScheduledAttemptGate(roundFor(dshPolicy()), deps), null);
    assert.deepEqual(observed, [], "no store was observed for an ungated harness");
    assert.equal(
      fs.existsSync(path.join(stateDir, "matchlock", "gate")),
      false,
      "no receipt directory: the gate never evaluated anything",
    );
  });

  it("has exactly ONE attempt-gate call site, inside the hermes round runner", () => {
    const source = fs.readFileSync(MODULE_PATH, "utf8");
    const occurrences = source.split("applyScheduledAttemptGate(").length - 1;
    assert.equal(
      occurrences,
      2,
      "the helper's definition + ONE call site (a second call would let a pi/dsh round be gated)",
    );
    const start = source.indexOf("async function runProductionHermesRound(");
    assert.ok(start > 0, "the hermes round runner exists");
    const body = source.slice(start);
    assert.ok(
      body.includes("applyScheduledAttemptGate(round)"),
      "the single call site is inside runProductionHermesRound (the hermes-only route)",
    );
    // The ids are derived from the round identity, so the attempt slot can
    // never collide with the dispatch slot.
    assert.equal(
      scheduledLaunchGateInvocationId({ runId: RUN_ID, jobId: JOB_ID, phase: "attempt" }),
      ATTEMPT_ID,
    );
    assert.notEqual(ATTEMPT_ID, DISPATCH_ID);
  });
});

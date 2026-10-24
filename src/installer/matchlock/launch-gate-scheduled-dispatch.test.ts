/**
 * launch-gate-scheduled-dispatch.test.ts — G8 ADMISSION-INTEGRATION US-005.
 *
 * Coverage for the SCHEDULED launch-gate adapter
 * (`launch-gate-scheduled.ts`) and the refusal recorder that makes a refusal
 * terminal instead of a retry loop:
 *
 *   - a refusal records the receipt FIRST, returns the G9 exit status (78) and
 *     invokes NOTHING that could create a VM or mount anything (the adapter
 *     has no create/mount code path at all — pinned by a source scan);
 *   - observation AGGREGATES: a second store whose observation throws still
 *     leaves the first store's findings intact and is itself reported as
 *     `path-unresolved` (no short-circuit, no skipped store);
 *   - revalidation refuses a store set that CHANGED between evaluate and
 *     create, by path list and by (dev, ino) replacement at the same path;
 *   - a receipt that cannot be written is an operational refusal (exit 78),
 *     never an allow;
 *   - a refusal is recorded ONCE (event + force-fail) and a later tick for an
 *     already-terminal run records nothing and dispatches nothing — the actual
 *     blocked-equivalent state is `status='failed'` + `scheduling_status=NULL`,
 *     NOT `scheduling_status='error'` (which `reconcileOnce()` re-admits);
 *   - a pi or dsh policy makes NO gate call at all (zero observation);
 *   - the dispatch and attempt evaluations carry DISTINCT invocation kinds and
 *     ids, so a dispatch-time binding can never satisfy the controller
 *     backstop's attempt-time requirement.
 *
 * Nothing here boots a VM or touches a real Hermes home: profiles are
 * disposable directories with real (or byte-exact) SQLite stores, and the
 * controller backstop case runs the existing in-repo fake RPC driver.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import { LAUNCH_GATE_REFUSAL_EXIT_CODE } from "../../../dist/installer/matchlock/gate-exit-code.js";
import {
  GATE_RECEIPT_UNREADABLE,
  NO_LEASE_LIMITATION,
  parseReceipt,
} from "../../../dist/installer/matchlock/gate-receipt.js";
import { MatchlockController, MatchlockControllerError } from "../../../dist/installer/matchlock/controller.js";
import {
  tempTranscriptPath,
  writeFakeRpcDriver,
} from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import {
  evaluateScheduledAttemptGate,
  evaluateScheduledDispatchGate,
  recordScheduledLaunchGateRefusal,
  scheduledLaunchGateInvocationId,
  scheduledLaunchGateKind,
  scheduledLaunchGateMountPlan,
  type ScheduledGateRefusalDeps,
} from "../../../dist/installer/matchlock/launch-gate-scheduled.js";
import { evaluateGate } from "../../../dist/installer/matchlock/launch-gate.js";
import { observeStore } from "../../../dist/installer/matchlock/store-header.js";
import {
  buildMatchlockPolicy,
  MATCHLOCK_NETWORK_POLICY_VERSION,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";
import type { LaunchGateBinding } from "../../../dist/installer/matchlock/launch-gate-wiring.js";
import type { MatchlockSchedulerRound } from "../../../dist/installer/matchlock/scheduler-matchlock.js";

const HERE = path.dirname(import.meta.filename);
const MODULE_PATH = path.join(HERE, "launch-gate-scheduled.ts");

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

/** A private state dir the receipt path is resolved under. */
function newStateDir(): string {
  return track(tamanduaShortTempDir("tamandua-sched-gate-state-"));
}

/** A disposable operator HOME under a short temp root. */
function newOperatorHome(): string {
  return track(tamanduaShortTempDir("tamandua-sched-gate-home-"));
}

/** A write-ahead-log store: correct SQLite signature, version pair (2, 2). */
function writeWalStore(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(header, 0);
  header[18] = 2;
  header[19] = 2;
  fs.writeFileSync(file, header);
  return file;
}

/** A real rollback-format SQLite store (header version pair (1, 1)). */
function writeRollbackStore(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
  database.exec("INSERT INTO t (value) VALUES ('row')");
  database.close();
  return file;
}

/**
 * A disposable Hermes profile home.
 *
 * `journalMode` is what the profile's `config.yaml` asks for; `store` builds
 * the required `state.db` as a rollback-format or write-ahead-log store.
 */
function newHermesProfile(
  journalMode: "delete" | "wal",
  store: "rollback" | "wal",
): string {
  const operatorHome = newOperatorHome();
  const hermes = path.join(operatorHome, ".hermes");
  fs.mkdirSync(hermes, { recursive: true });
  fs.writeFileSync(
    path.join(hermes, "config.yaml"),
    `database:\n  journal_mode: ${journalMode}\n`,
  );
  if (store === "rollback") writeRollbackStore(path.join(hermes, "state.db"));
  else writeWalStore(path.join(hermes, "state.db"));
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

const RUN_ID = "run-9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";
const BARE_RUN_ID = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";
const JOB_ID = "job-feature-dev-merge-worktree_developer";

/** One scheduled work round over a policy. */
function roundFor(policy: ExecutionIsolation, over: Partial<MatchlockSchedulerRound> = {}): MatchlockSchedulerRound {
  return {
    policy,
    identity: {
      runId: RUN_ID,
      agentId: "feature-dev-merge-worktree_developer",
      workflowId: "feature-dev-merge-worktree",
      jobId: JOB_ID,
    },
    kind: "work",
    promptText: "do work",
    workingDirectoryForHarness: "/srv/project",
    timeoutMs: 1000,
    ...over,
  };
}

/** Deterministic gate deps: hermetic managed scope, pinned receipt state dir. */
function gateDeps(stateDir: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stateDir,
    configOptions: { managedDir: null },
    ...over,
  };
}

/** Read and parse the one receipt a refusal recorded. */
function readRefusalReceipt(decision: { refusal: { receiptPath: string } }) {
  const text = fs.readFileSync(decision.refusal.receiptPath, "utf8");
  return parseReceipt(text.trimEnd());
}

// ---------------------------------------------------------------------------
// scope: identity, kind, mount plan
// ---------------------------------------------------------------------------

describe("scheduled launch gate — invocation identity and mount plan (US-005)", () => {
  it("derives the exact dispatch/attempt invocation ids from the bare run id", () => {
    assert.equal(
      scheduledLaunchGateInvocationId({ runId: RUN_ID, jobId: JOB_ID, phase: "dispatch" }),
      `run:${BARE_RUN_ID}:round:${JOB_ID}:dispatch`,
    );
    assert.equal(
      scheduledLaunchGateInvocationId({ runId: BARE_RUN_ID, jobId: JOB_ID, phase: "dispatch" }),
      `run:${BARE_RUN_ID}:round:${JOB_ID}:dispatch`,
      "the bare and run- spellings must produce the SAME id (one evidence slot per dispatch)",
    );
    assert.equal(
      scheduledLaunchGateInvocationId({ runId: RUN_ID, jobId: JOB_ID, phase: "attempt" }),
      `run:${BARE_RUN_ID}:round:${JOB_ID}:attempt`,
      "the attempt evaluation is its own evidence slot, never the dispatch one",
    );
    assert.equal(scheduledLaunchGateKind("dispatch"), "scheduled-dispatch");
    assert.equal(scheduledLaunchGateKind("attempt"), "scheduled-attempt");
  });

  it("builds the identical-path RW mount plan for the approved guest HERMES_HOME", () => {
    assert.deepEqual(
      scheduledLaunchGateMountPlan("/home/op/.hermes", "/workspace/config/hermes"),
      { mounts: { "/workspace/config/hermes": { host_path: "/home/op/.hermes" } } },
    );
    assert.deepEqual(
      scheduledLaunchGateMountPlan("", "/workspace/config/hermes"),
      { mounts: {} },
      "an unresolved host dir yields no mount (never a fabricated source)",
    );
  });

  it("the adapter contains NO create/mount path at all (structural zero-create guarantee)", () => {
    // Scan the CODE only: the module's prose deliberately NAMES the runners it
    // must never call, so comments are stripped before the scan.
    const source = fs
      .readFileSync(MODULE_PATH, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [
      "runMatchlockInvocation",
      "runHermesInvocation",
      "runDshSchedulerRound",
      "prepareAndCreate",
      "MatchlockController",
      "createHostBroker",
      "runMatchlockSchedulerRound(",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `the scheduled gate adapter must never reach ${forbidden}: a refusal must be unable to create a VM or mount anything`,
      );
    }
    // The adapter never allocates a status: the wiring (G9) does, and the
    // recorder copies `refusal.exitCode` into the event verbatim.
    assert.ok(!/\bexitCode\s*=\s*78\b/.test(source), "no literal 78 in the adapter");
    assert.match(source, /exitCode: typeof refusal\?\.exitCode === "number"/, "the G9-allocated status is threaded through");
  });
});

// ---------------------------------------------------------------------------
// allow path
// ---------------------------------------------------------------------------

describe("scheduled launch gate — allow path (US-005)", () => {
  it("allows a compliant disposable profile and writes NO receipt before any VM exists", () => {
    const operatorHome = newHermesProfile("delete", "rollback");
    const stateDir = newStateDir();

    const decision = evaluateScheduledDispatchGate(roundFor(hermesPolicy(operatorHome)), gateDeps(stateDir));
    assert.ok(decision, "a hermes policy is gated");
    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;

    assert.equal(decision.binding.kind, "scheduled-dispatch");
    assert.equal(decision.binding.invocationId, `run:${BARE_RUN_ID}:round:${JOB_ID}:dispatch`);
    assert.match(decision.binding.storeSetKey, /^sha256:[0-9a-f]{64}$/);
    assert.equal(decision.binding.configJournalMode, "delete");
    assert.equal(decision.binding.stores.length, 1, "only the present store has an identity");
    assert.match(decision.binding.stores[0].canonicalPath!, /\.hermes\/state\.db$/);
    assert.equal(
      fs.existsSync(decision.binding.receiptPath),
      false,
      "the launch receipt is written only AFTER vmCreated — never pre-create",
    );
  });

  it("resolves profileHome to the ADMITTED canonical host config dir and records the guest config dir", () => {
    const operatorHome = newHermesProfile("delete", "rollback");
    const stateDir = newStateDir();
    const decision = evaluateScheduledDispatchGate(roundFor(hermesPolicy(operatorHome)), gateDeps(stateDir));
    assert.ok(decision && decision.action === "allow");
    if (decision.action !== "allow") return;
    assert.equal(decision.receiptInput.invocation.profile, "default");
    assert.equal(decision.receiptInput.invocation.guestConfigDir, "/workspace/config/hermes");
    assert.equal(decision.receiptInput.invocation.runId, RUN_ID);
    assert.equal(decision.receiptInput.invocation.roundId, JOB_ID);
    assert.equal(decision.receiptInput.inventoryComplete, true);
  });
});

// ---------------------------------------------------------------------------
// refusal path
// ---------------------------------------------------------------------------

describe("scheduled launch gate — refusal path (US-005)", () => {
  it("refuses a WAL-configured, WAL-header store with exit 78 and a written receipt (zero create calls)", () => {
    const operatorHome = newHermesProfile("wal", "wal");
    const stateDir = newStateDir();

    const decision = evaluateScheduledDispatchGate(roundFor(hermesPolicy(operatorHome)), gateDeps(stateDir));
    assert.ok(decision);
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(decision.refusal.exitCode, 78, "G9 allocates 78 for a launch-gate refusal");
    assert.equal(decision.refusal.kind, "verdict");
    assert.equal(decision.refusal.receiptWritten, true);

    const codes = decision.refusal.findings.map((finding) => finding.code).sort();
    assert.deepEqual(codes, ["not-delete-config", "wal-header"], "every obtainable finding is preserved");

    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.equal(receipt.invocation.kind, "scheduled-dispatch");
    assert.equal(receipt.invocation.runId, RUN_ID);
    assert.equal(receipt.invocation.roundId, JOB_ID);
    assert.match(String(receipt.storeSetKey), /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.holderDetection.limitation, NO_LEASE_LIMITATION, "the receipt states the no-lease limitation");
    assert.ok(receipt.findings.every((finding) => Array.isArray(finding.remedy)), "every refusal is actionable");
  });

  it("aggregates across stores: one failing observation never aborts the others", () => {
    const operatorHome = newHermesProfile("wal", "wal");
    const hermes = path.join(operatorHome, ".hermes");
    // A second, independent store that is also non-compliant.
    writeWalStore(path.join(hermes, "verification_evidence.db"));
    const stateDir = newStateDir();

    const observed: string[] = [];
    const decision = evaluateScheduledDispatchGate(
      roundFor(hermesPolicy(operatorHome)),
      gateDeps(stateDir, {
        observeStore: (storePath: string) => {
          observed.push(storePath);
          return observeStore(storePath);
        },
      }),
    );
    assert.ok(decision && decision.action === "refuse");
    if (decision.action !== "refuse") return;
    // The contract walks ALL four stores (the two absent ones are knowledge,
    // not gaps) — neither PRESENT store may be skipped.
    for (const name of ["state.db", "verification_evidence.db"]) {
      assert.ok(
        observed.some((storePath) => storePath.endsWith(name)),
        `${name} must be observed`,
      );
    }
    assert.equal(observed.length, 4, "every store in the attested contract is observed");
    const byStore = new Map<string, string[]>();
    for (const finding of decision.refusal.findings) {
      if (!finding.store) continue;
      const codes = byStore.get(finding.store) ?? [];
      codes.push(finding.code);
      byStore.set(finding.store, codes);
    }
    assert.deepEqual([...byStore.keys()].length, 2, "both stores carry findings");
    for (const codes of byStore.values()) {
      assert.ok(codes.includes("wal-header"), "each WAL store is judged on its own header");
    }
    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.stores.length, 4, "the receipt pins every contract store it walked");
    for (const name of ["state.db", "verification_evidence.db"]) {
      assert.ok(
        receipt.stores.some((store) => String(store.canonicalPath).endsWith(name)),
        `${name} is pinned in the receipt`,
      );
    }
  });

  it("keeps the findings of a good store when ANOTHER store's observation throws (no short-circuit)", () => {
    // state.db is a real WAL-header store (its own finding), and the SECOND
    // store's observation throws: both outcomes must survive.
    const operatorHome = newHermesProfile("delete", "wal");
    const hermes = path.join(operatorHome, ".hermes");
    writeWalStore(path.join(hermes, "verification_evidence.db"));
    const stateDir = newStateDir();
    const observed: string[] = [];

    const decision = evaluateScheduledDispatchGate(
      roundFor(hermesPolicy(operatorHome)),
      gateDeps(stateDir, {
        observeStore: (storePath: string) => {
          observed.push(storePath);
          if (storePath.endsWith("verification_evidence.db")) {
            throw new Error("synthetic read failure (EIO)");
          }
          return observeStore(storePath);
        },
      }),
    );
    assert.ok(decision && decision.action === "refuse");
    if (decision.action !== "refuse") return;
    assert.ok(
      observed.some((storePath) => storePath.endsWith("verification_evidence.db")),
      "the throwing store was attempted",
    );
    assert.ok(
      observed.some((storePath) => storePath.endsWith("state.db")),
      "the throwing store never stops the walk",
    );
    const codes = decision.refusal.findings.map((finding) => finding.code);
    assert.ok(codes.includes("path-unresolved"), "an unobservable store is ignorance (path-unresolved), never absence");
    assert.ok(
      codes.includes("wal-header"),
      "the OTHER store's real finding survives the failed observation (aggregation, never short-circuit)",
    );
  });

  it("treats an unresolvable profile (no frozen home on disk) as an OPERATIONAL refusal with a receipt", () => {
    const operatorHome = newHermesProfile("delete", "rollback");
    fs.rmSync(path.join(operatorHome, ".hermes"), { recursive: true, force: true });
    const stateDir = newStateDir();

    const decision = evaluateScheduledDispatchGate(roundFor(hermesPolicy(operatorHome)), gateDeps(stateDir));
    assert.ok(decision);
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.deepEqual(decision.refusal.findings, [], "operational refusals invent no reason code");
    assert.equal(decision.refusal.receiptWritten, true, "the refusal is still recorded");
    assert.match(decision.refusal.detail, /could not be resolved/i);
  });

  it("refuses when the receipt itself cannot be written (operational, exit 78, never an allow)", () => {
    const operatorHome = newHermesProfile("wal", "wal");
    const stateDir = newStateDir();

    const decision = evaluateScheduledDispatchGate(
      roundFor(hermesPolicy(operatorHome)),
      gateDeps(stateDir, {
        writeRefusalReceipt: () => ({
          ok: false,
          code: "receipt-write-failed",
          path: "/nonexistent/receipt.json",
          detail: "synthetic disk failure",
        }),
      }),
    );
    assert.ok(decision);
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.receiptWritten, false);
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.match(decision.refusal.detail, /could not be written/);
  });
});

// ---------------------------------------------------------------------------
// revalidation (membership + config by identity)
// ---------------------------------------------------------------------------

describe("scheduled launch gate — revalidation before create (US-005)", () => {
  it("catches a store APPEARING between evaluate and create (path-list change)", () => {
    const operatorHome = newHermesProfile("delete", "rollback");
    const hermes = path.join(operatorHome, ".hermes");
    const stateDir = newStateDir();

    const decision = evaluateScheduledDispatchGate(
      roundFor(hermesPolicy(operatorHome)),
      gateDeps(stateDir, {
        // Mutate the world AFTER the real verdict, i.e. inside the
        // observe-to-create window the revalidation exists to close.
        evaluateGate: (input: unknown) => {
          writeWalStore(path.join(hermes, "kanban.db"));
          return evaluateGate(input);
        },
      }),
    );
    assert.ok(decision);
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.deepEqual(decision.refusal.findings, [], "a revalidation change is operational: no eleventh reason code");
    assert.match(decision.refusal.detail, /store-set-changed/);
    assert.match(decision.refusal.detail, /kanban\.db/);
  });

  it("catches a store REPLACED at the same path (dev/ino change), not just a path list change", () => {
    const operatorHome = newHermesProfile("delete", "rollback");
    const hermes = path.join(operatorHome, ".hermes");
    const storePath = path.join(hermes, "state.db");
    const stateDir = newStateDir();

    const decision = evaluateScheduledDispatchGate(
      roundFor(hermesPolicy(operatorHome)),
      gateDeps(stateDir, {
        evaluateGate: (input: unknown) => {
          // Same canonical path, different inode: a copy swapped in behind the
          // gate's back is exactly the case a path-only check would miss.
          fs.rmSync(storePath, { force: true });
          writeRollbackStore(storePath);
          return evaluateGate(input);
        },
      }),
    );
    assert.ok(decision);
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.match(decision.refusal.detail, /store-identity-changed/);
    assert.match(decision.refusal.detail, /state\.db/);
    assert.equal(decision.refusal.kind, "operational");
  });

  it("catches a config edited to wal between evaluate and create", () => {
    const operatorHome = newHermesProfile("delete", "rollback");
    const configPath = path.join(operatorHome, ".hermes", "config.yaml");
    const stateDir = newStateDir();

    const decision = evaluateScheduledDispatchGate(
      roundFor(hermesPolicy(operatorHome)),
      gateDeps(stateDir, {
        evaluateGate: (input: unknown) => {
          fs.writeFileSync(configPath, "database:\n  journal_mode: wal\n");
          return evaluateGate(input);
        },
      }),
    );
    assert.ok(decision);
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.match(decision.refusal.detail, /config-changed/);
  });
});

// ---------------------------------------------------------------------------
// scope discipline: pi / dsh are untouched
// ---------------------------------------------------------------------------

describe("scheduled launch gate — scope discipline (US-005)", () => {
  it("makes NO gate call and NO observation for a pi policy", () => {
    const stateDir = newStateDir();
    let observed = 0;
    const decision = evaluateScheduledDispatchGate(
      roundFor(piPolicy()),
      gateDeps(stateDir, {
        observeStore: () => {
          observed += 1;
          throw new Error("a pi policy must never be observed");
        },
      }),
    );
    assert.equal(decision, null, "null means 'this policy is not gated' — the pi route is untouched");
    assert.equal(observed, 0);
    assert.equal(
      fs.existsSync(path.join(stateDir, "matchlock", "gate")),
      false,
      "no receipt directory is even created for an ungated policy",
    );
  });

  it("makes NO gate call for a dsh policy", () => {
    const dsh = { ...piPolicy(), harness: "dsh" } as ExecutionIsolation;
    assert.equal(evaluateScheduledDispatchGate(roundFor(dsh), gateDeps(newStateDir())), null);
    assert.equal(evaluateScheduledAttemptGate(roundFor(dsh), gateDeps(newStateDir())), null);
  });
});

// ---------------------------------------------------------------------------
// attempt vs dispatch: distinct evidence, distinct binding
// ---------------------------------------------------------------------------

describe("scheduled launch gate — attempt-time evaluation (US-005/US-006 seam)", () => {
  it("evaluates the SAME stores under its OWN kind + invocation id", () => {
    const operatorHome = newHermesProfile("delete", "rollback");
    const stateDir = newStateDir();
    const dispatch = evaluateScheduledDispatchGate(roundFor(hermesPolicy(operatorHome)), gateDeps(stateDir));
    const attempt = evaluateScheduledAttemptGate(roundFor(hermesPolicy(operatorHome)), gateDeps(stateDir));
    assert.ok(dispatch && dispatch.action === "allow");
    assert.ok(attempt && attempt.action === "allow");
    if (dispatch.action !== "allow" || attempt.action !== "allow") return;
    assert.equal(dispatch.binding.kind, "scheduled-dispatch");
    assert.equal(attempt.binding.kind, "scheduled-attempt");
    assert.notEqual(dispatch.binding.invocationId, attempt.binding.invocationId);
    assert.equal(
      dispatch.binding.storeSetKey,
      attempt.binding.storeSetKey,
      "the same stores hash to the same key: the store set is an identity, not a decision",
    );
    assert.notEqual(dispatch.binding.receiptPath, attempt.binding.receiptPath);
  });

  it("the controller backstop REFUSES a dispatch binding presented for the attempt invocation (zero RPC calls)", async (t) => {
    const operatorHome = newHermesProfile("delete", "rollback");
    const configDir = path.join(operatorHome, ".hermes");
    const stateDir = newStateDir();
    const decision = evaluateScheduledDispatchGate(roundFor(hermesPolicy(operatorHome)), gateDeps(stateDir));
    assert.ok(decision && decision.action === "allow");
    if (decision.action !== "allow") return;

    const tmp = track(tamanduaShortTempDir("tamandua-sched-gate-controller-"));
    const helperPack = path.join(tmp, "runtime");
    fs.mkdirSync(helperPack, { recursive: true });
    fs.writeFileSync(path.join(helperPack, "bin-tamandua"), "#!/bin/sh\n", "utf8");
    const fakeDriver = writeFakeRpcDriver({ dir: path.join(tmp, "driver") });
    const transcriptPath = tempTranscriptPath();
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of ["FAKE_TRANSCRIPT_FILE", "FAKE_IMAGE_TAG", "FAKE_IMAGE_DIGEST", "FAKE_IMAGE_CONFIG_DIGEST"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.FAKE_TRANSCRIPT_FILE = transcriptPath;
    process.env.FAKE_IMAGE_TAG = "vic/hermes:latest";
    process.env.FAKE_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
    process.env.FAKE_IMAGE_CONFIG_DIGEST = `sha256:${"d".repeat(64)}`;
    t.after(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const policy = hermesPolicy(operatorHome);
    const controller = new MatchlockController(
      { ...policy, configurationRoot: configDir },
      {
        rpcBinaryPath: process.execPath,
        rpcArgs: [fakeDriver],
        helperPackHostPath: helperPack,
        onLog: () => {},
        requestTimeoutMs: 10_000,
        // An attempt-time invocation with the DISPATCH binding: the binding's
        // invocation id and the required one differ, so the backstop must
        // refuse before spawning anything.
        launchGate: {
          invocationId: `run:${BARE_RUN_ID}:round:${JOB_ID}:attempt`,
          binding: decision.binding as LaunchGateBinding,
        },
      },
    );
    t.after(() => controller.dispose());

    await assert.rejects(
      controller.prepareAndCreate({
        digest: `sha256:${"c".repeat(64)}`,
        config_digest: `sha256:${"d".repeat(64)}`,
        tag: "vic/hermes:latest",
      }),
      (err: unknown) => {
        assert.ok(err instanceof MatchlockControllerError);
        assert.equal(err.code, "matchlock_gate_verdict_missing");
        assert.match(err.message, /dispatch/, "the message names the foreign (dispatch) verdict");
        return true;
      },
    );
    assert.equal(fs.existsSync(transcriptPath), false, "a refused create spawns no RPC child at all");
    assert.equal(controller.rpcRunning, false);
  });
});

// ---------------------------------------------------------------------------
// refusal recorder: one event, terminal run, no re-dispatch
// ---------------------------------------------------------------------------

describe("scheduled launch gate — refusal recording (US-005)", () => {
  /** A refusal over a WAL profile, plus the seams the recorder needs. */
  function refusalFixture() {
    const operatorHome = newHermesProfile("wal", "wal");
    const stateDir = newStateDir();
    const round = roundFor(hermesPolicy(operatorHome));
    const decision = evaluateScheduledDispatchGate(round, gateDeps(stateDir));
    assert.ok(decision && decision.action === "refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    return { round, decision, stateDir };
  }

  it("emits exactly ONE run.matchlock_gate_refused carrying the receipt's own key and codes, then force-fails the run", async () => {
    const { round, decision } = refusalFixture();
    const events: Array<Record<string, unknown>> = [];
    const forced: Array<{ runId: string; reason: string }> = [];
    const deps: ScheduledGateRefusalDeps = {
      readRun: () => ({ status: "running", scheduling_status: "active" }),
      readEvents: () => [],
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      forceFail: async (runId, reason) => {
        forced.push({ runId, reason });
        return { ok: true };
      },
      now: () => "2026-10-23T00:00:00.000Z",
      log: () => {},
    };

    const record = await recordScheduledLaunchGateRefusal(round, decision.refusal, { phase: "dispatch", ...deps });
    assert.equal(record.recorded, true);
    assert.equal(record.forced, true);
    assert.equal(record.runStatus, "running");

    assert.equal(events.length, 1, "exactly one event");
    const event = events[0];
    assert.equal(event.event, "run.matchlock_gate_refused");
    assert.equal(event.runId, RUN_ID);
    assert.equal(event.workflowId, "feature-dev-merge-worktree");
    assert.equal(event.invocationId, `run:${BARE_RUN_ID}:round:${JOB_ID}:dispatch`);
    assert.equal(event.harness, "hermes");
    assert.equal(event.exitCode, 78);
    assert.equal(event.reason, "matchlock_launch_gate_refused");
    assert.equal(event.receiptPath, decision.refusal.receiptPath);
    assert.match(String(event.storeSetKey), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual([...(event.findingCodes as string[])].sort(), ["not-delete-config", "wal-header"]);
    assert.deepEqual([...(event.findingCodes as string[])].sort(), decision.refusal.findings.map((f) => f.code).sort());
    assert.match(String(event.detail), /No VM was created and no step was dispatched/);

    assert.equal(forced.length, 1, "the run is force-failed exactly once");
    assert.equal(forced[0].runId, RUN_ID);
    assert.match(forced[0].reason, /launch gate refused/i);
  });

  it("an already-terminal run records NOTHING and forces nothing (the durable re-dispatch guard)", async () => {
    const { round, decision } = refusalFixture();
    let emitted = 0;
    let forceCalled = 0;
    const record = await recordScheduledLaunchGateRefusal(round, decision.refusal, {
      phase: "dispatch",
      readRun: () => ({ status: "failed", scheduling_status: null }),
      readEvents: () => [],
      emit: () => {
        emitted += 1;
      },
      forceFail: async () => {
        forceCalled += 1;
        return { ok: true };
      },
      log: () => {},
    });
    assert.equal(record.recorded, false);
    assert.equal(record.reason, "run-not-running");
    assert.equal(record.forced, false);
    assert.equal(emitted, 0, "no second event for an already-refused run");
    assert.equal(forceCalled, 0, "no second terminal transition");
  });

  it("does not emit a duplicate event when this invocation is already in the event stream", async () => {
    const { round, decision } = refusalFixture();
    let emitted = 0;
    let forceCalled = 0;
    const record = await recordScheduledLaunchGateRefusal(round, decision.refusal, {
      phase: "dispatch",
      readRun: () => ({ status: "running", scheduling_status: "active" }),
      readEvents: () => [
        {
          ts: "2026-10-23T00:00:00.000Z",
          event: "run.matchlock_gate_refused",
          runId: RUN_ID,
          invocationId: `run:${BARE_RUN_ID}:round:${JOB_ID}:dispatch`,
        } as never,
      ],
      emit: () => {
        emitted += 1;
      },
      forceFail: async () => {
        forceCalled += 1;
        return { ok: true };
      },
      log: () => {},
    });
    assert.equal(record.recorded, false);
    assert.equal(record.reason, "already-recorded");
    assert.equal(emitted, 0, "the durable event is written once per invocation");
    assert.equal(forceCalled, 1, "the terminal transition is still retried (a crash may have lost it)");
  });

  it("still refuses when the receipt could not be written: the event carries the unreadable sentinel, never a guess", async () => {
    const operatorHome = newHermesProfile("wal", "wal");
    const stateDir = newStateDir();
    const round = roundFor(hermesPolicy(operatorHome));
    const decision = evaluateScheduledDispatchGate(
      round,
      gateDeps(stateDir, {
        writeRefusalReceipt: () => ({ ok: false, code: "receipt-write-failed", path: "", detail: "synthetic" }),
      }),
    );
    assert.ok(decision && decision.action === "refuse");
    if (decision.action !== "refuse") return;

    const events: Array<Record<string, unknown>> = [];
    await recordScheduledLaunchGateRefusal(round, decision.refusal, {
      phase: "dispatch",
      readRun: () => ({ status: "running", scheduling_status: "active" }),
      readEvents: () => [],
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      forceFail: async () => ({ ok: true }),
      log: () => {},
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].storeSetKey, GATE_RECEIPT_UNREADABLE, "no fabricated key when the receipt is missing");
    assert.equal(events[0].reason, "matchlock_launch_gate_operational_refusal");
  });

  it("records the refusal for the ATTEMPT phase under the attempt invocation id", async () => {
    const { round, decision } = refusalFixture();
    const events: Array<Record<string, unknown>> = [];
    await recordScheduledLaunchGateRefusal(round, decision.refusal, {
      phase: "attempt",
      readRun: () => ({ status: "running", scheduling_status: "active" }),
      readEvents: () => [],
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      forceFail: async () => ({ ok: true }),
      log: () => {},
    });
    assert.equal(events[0].invocationId, `run:${BARE_RUN_ID}:round:${JOB_ID}:attempt`);
  });
});

/**
 * prep-state.test.ts — MTLK-ISO-SLICE2 US-005.
 *
 * Covers the PREP-STATE helper (host-controlled writer, reader, ordered
 * classification) and the ATOMIC first-INSERT persistence of the isolation
 * intent + non-schedulable hold, including the SIGKILL window, a reconciler
 * tick across an in-flight admission, the older-binary (legacy-query) case and
 * context-update preservation.
 *
 * Serial-listed (imports run.ts / control-server, both process-spawning).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ISOLATION_INTENT_COLUMN,
  ISOLATION_INTENT_RECORDED,
  NATIVE_SCHEDULING_STATUS,
  PREPARING_SCHEDULING_STATUS,
  DRAINING_PAUSE_SCHEDULING_STATUS,
  PAUSE_DRAIN_CONTEXT_KEY,
  PREP_STATE_DEPLOYMENT_RESTRICTION,
  SCHEDULABLE_SCHEDULING_STATUSES,
  classifyIsolationState,
  initialRunIsolationState,
  isSchedulableSchedulingStatus,
  readIsolationIntent,
  readIsolationState,
} from "../../../dist/installer/matchlock/prep-state.js";
import {
  MATCHLOCK_MOUNT_POLICY_VERSION,
  MATCHLOCK_NETWORK_POLICY_VERSION,
} from "../../../dist/installer/matchlock/policy.js";
import { runWorkflow } from "../../../dist/installer/run.js";
import { _reconcileOnce } from "../../../dist/server/control-server.js";
import { _scheduledJobCountForRun, _scheduledRunIds, removeRunCrons } from "../../../dist/installer/agent-scheduler.js";
import {
  MATCHLOCK_RPC_ARGS_ENV,
  MATCHLOCK_RPC_BIN_ENV,
  MatchlockAdmissionError,
} from "../../../dist/installer/matchlock/admission.js";
import {
  tempTranscriptPath,
  writeFakeRpcDriver,
} from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import type {
  MatchlockSwapSupport,
  MatchlockSwapSupportProbe,
} from "../../../dist/installer/matchlock/swap-support.js";
import { setRunContextKey } from "../../../dist/installer/step-ops.js";
import { RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY } from "../../../dist/installer/run-harness.js";
import { getDb } from "../../../dist/db.js";
import { getRunEvents } from "../../../dist/installer/events.js";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import { cleanChildEnv, removeTestTempDirWithDiagnostics, reservePortHandle } from "../../../tests/helpers/test-env.ts";
import { assertStatePathIsolation } from "../../../dist/lib/test-guard.js";

/**
 * Matchlock work mounts must live at host paths whose exact-path GUEST mounts
 * are allowed: guest /tmp is a protected disposable root, so a fixture work
 * directory under the suite's /tmp temp homes is refused. Captured at module
 * load (before any test mutates HOME).
 */
const MTLK_FIXTURE_BASE = path.join(os.homedir(), ".mtlk-prep-state-test");

/** Minimal valid v2 policy record (normalizes to the current v3 shape). */
function validV2PolicyJson(): string {
  return JSON.stringify({
    version: 2,
    backend: "matchlock",
    requestedImage: "vic/base:latest",
    harness: "pi",
    configurationRoot: "/opt/pi",
    configurationProfile: "settings.json",
    guestConfigurationRoot: "/workspace/config/pi",
    workPathMode: "host-absolute",
    workingDirectory: "/opt/project",
    workMounts: [
      { hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" },
    ],
    originalRepositoryRoot: "/opt/project",
    gitMetadataRoots: [],
    mountPolicyVersion: MATCHLOCK_MOUNT_POLICY_VERSION,
    networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
    resolvedImageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    resolvedImageConfigDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  });
}

function writeMinimalWorkflow(
  homeDir: string,
  workflowId: string,
  workspaceMode: "direct" | "worktree" = "direct",
): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    `id: ${workflowId}\nrun:\n  workspace: ${workspaceMode}\nagents:\n  - id: dev\n    model: fake\n    workspace:\n      baseDir: .\nsteps:\n  - id: implement\n    agent: dev\n    input: Implement the task\n    expects: STATUS, CHANGES, TESTS\n`,
    "utf-8",
  );
}

function runGit(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  runGit(["init", "--initial-branch=main"], dir);
  runGit(["config", "user.email", "test@tamandua.local"], dir);
  runGit(["config", "user.name", "Tamandua Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf-8");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-m", "initial commit"], dir);
}

/** A bounded fake control plane so runWorkflow never spawns a real daemon. */
async function startFakeControlPlane(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/control/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, prepStateCapability: "MTLK-ISO-SLICE2-PREP-STATE" }));
        return;
      }
      if (req.method === "POST" && req.url === "/control/register-run") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: "active" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface HeldProbe {
  probe: MatchlockSwapSupportProbe;
  /** Resolves once the probe has been entered (the SIGKILL window is open). */
  entered: Promise<void>;
  /** Release the probe with an unsupporting result (aborts admission). */
  releaseUnsupported: () => void;
  /** Release the probe with a SUPPORTING result (admission proceeds). */
  releaseSupported: (binaryPath?: string) => void;
}

/** A gated swap probe: enters on first call and blocks until released. */
function makeHeldProbe(): HeldProbe {
  let releaseGate!: (result: MatchlockSwapSupport) => void;
  const gate = new Promise<MatchlockSwapSupport>((resolve) => {
    releaseGate = resolve;
  });
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let lastProbedBinary = "matchlock";
  const probe: MatchlockSwapSupportProbe = async (binaryPath) => {
    lastProbedBinary = binaryPath;
    enteredResolve();
    return gate;
  };
  return {
    probe,
    entered,
    releaseUnsupported: () =>
      releaseGate({ supported: false, binaryPath: "matchlock", reasonCode: "unsupported" }),
    releaseSupported: (binaryPath?: string) =>
      releaseGate({ supported: true, binaryPath: binaryPath ?? lastProbedBinary }),
  };
}

/**
 * Await the held probe's entry, failing fast when the run settles or stalls
 * first: a regression that makes admission exit (or wedge) before ever
 * probing swap support must fail the test promptly, not hang the suite
 * waiting on a probe that never fires.
 */
async function awaitEntered(held: HeldProbe, runP: Promise<unknown>): Promise<void> {
  // No-op handler so a late rejection from a stalled run is never an
  // unhandled rejection; the real await in the test still sees it.
  void runP.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 30_000);
  });
  let outcome: "entered" | "settled" | "timeout";
  try {
    outcome = await Promise.race([
      held.entered.then(() => "entered" as const),
      runP.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (outcome !== "entered") {
    // Never leave the admission wedged on a probe nobody will release.
    held.releaseUnsupported();
  }
  assert.equal(
    outcome,
    "entered",
    "runWorkflow settled or stalled before the swap probe was entered",
  );
}

/** The `exit` promise for a child. ATTACH THIS BEFORE SIGNALLING THE CHILD. */
function childExitPromise(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

type ChildExitChannel = "event" | "esrch";

interface ChildExitOutcome {
  /** Which channel settled the wait: the `exit` event or the ESRCH pid poll. */
  channel: ChildExitChannel;
  waitedMs: number;
  /** Whether `process.kill(pid, 0)` was ever observed to throw ESRCH. */
  esrchSeen: boolean;
}

/**
 * Hang-proof, bounded wait for a child to die.
 *
 * The caller MUST have attached the `exit` listener (via
 * {@link childExitPromise}) BEFORE signalling the child: a SIGKILLed process
 * can be reaped and its `exit` event emitted before a late listener is
 * registered, and that event is then lost forever — the macOS wedge this
 * helper exists to eliminate. The wait therefore never depends on the single
 * event; it races
 *   1. the pre-attached `exit` promise,
 *   2. a `process.kill(pid, 0)` poll observing ESRCH (the pid is gone),
 *   3. a hard deadline.
 * It also seeds from an exit/signal already recorded on the handle, so a child
 * that died before the helper ran resolves immediately. On deadline it throws
 * a loud error naming the pid, the seconds waited and whether ESRCH was ever
 * observed — it FAILS, it never hangs.
 */
async function waitForChildExitBounded(
  child: ChildProcess,
  exitEvent: Promise<void>,
  opts: { label: string; deadlineMs?: number; pollMs?: number },
): Promise<ChildExitOutcome> {
  const deadlineMs = opts.deadlineMs ?? 15_000;
  const pollMs = opts.pollMs ?? 25;
  const started = Date.now();
  const pid = child.pid;
  let esrchSeen = false;
  let settled = false;

  const timeoutError = (): Error =>
    new Error(
      `[${opts.label}] child pid=${pid ?? "unknown"} did not exit within ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `(ESRCH ${esrchSeen ? "observed" : "never observed"})`,
    );

  // Seed: the child may already be dead before this helper is called. The
  // "event" label here is NOT channel proof — nothing observed an exit event;
  // it only records that the termination state was already present, which is
  // all the receipt assertion downstream reads (`signalCode`/`exitCode`).
  if (child.exitCode !== null || child.signalCode !== null) {
    return { channel: "event", waitedMs: 0, esrchSeen: false };
  }

  // Defence-in-depth liveness channel: settles the wait even when the `exit`
  // event was lost. Without a pid (spawn failure) there is no liveness probe,
  // so the channel stays pending and only the deadline can fire.
  const pidDeath = (async (): Promise<ChildExitChannel> => {
    while (!settled && pid !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (settled) break;
      try {
        process.kill(pid, 0);
      } catch (err: unknown) {
        // ESRCH is proof the pid is gone. EPERM (or anything else) means the
        // pid exists but is not ours, i.e. still alive.
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          esrchSeen = true;
          return "esrch";
        }
      }
      if (Date.now() - started >= deadlineMs) throw timeoutError();
    }
    return new Promise<ChildExitChannel>(() => {}); // settled elsewhere
  })();

  const deadline = new Promise<ChildExitChannel>((_resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), deadlineMs);
    timer.unref(); // never hold the test process open for the deadline
  });

  try {
    const channel = await Promise.race([
      exitEvent.then((): ChildExitChannel => "event"),
      pidDeath,
      deadline,
    ]);
    return { channel, waitedMs: Date.now() - started, esrchSeen };
  } finally {
    settled = true;
  }
}

/**
 * H1/F2 — the SINGLE SIGKILL-receipt validation used by every successful wait
 * path in this file (the original creator test, the lost-path positive and the
 * negative control).
 *
 * The bounded wait above proves only that the pid is gone (or that the `exit`
 * event fired); it does not prove HOW the child died. Node records the
 * termination state (`child.signalCode`/`child.exitCode`) on the handle
 * independent of whether `exit` listeners are still attached — the property
 * probes on macOS and Linux confirm the record survives a detached-listener
 * kill — so this helper polls (with a referenced timer, keeping the test
 * alive) until that record appears, then asserts the receipt is EXACTLY a
 * SIGKILL: `signalCode === "SIGKILL"` and `exitCode === null`.
 *
 * It is bounded: a missing record within `deadlineMs` is a loud FAIL naming the
 * pid, the seconds waited and the observed state — never a hang. A mismatched
 * record (e.g. a natural exit with `exitCode=13`, `signalCode=null`) is
 * rejected with the same precise detail. It does NOT signal the child; the
 * caller remains responsible for reaping it.
 */
async function assertSigkillReceipt(
  child: ChildProcess,
  opts: { deadlineMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadlineMs = opts.deadlineMs ?? 5_000;
  const pollMs = opts.pollMs ?? 25;
  const started = Date.now();
  const pid = child.pid;

  // Seed from any already-recorded state, then poll until the handle records
  // the termination. On the ESRCH path the record can trail the pid death by a
  // tick; the referenced timer keeps the event loop (and the test) alive.
  while (child.signalCode === null && child.exitCode === null) {
    if (Date.now() - started >= deadlineMs) {
      throw new Error(
        `[SIGKILL receipt] child pid=${pid ?? "unknown"} has no termination record after ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s ` +
          `(signalCode=${String(child.signalCode)}, exitCode=${String(child.exitCode)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (child.signalCode !== "SIGKILL" || child.exitCode !== null) {
    throw new Error(
      `[SIGKILL receipt] child pid=${pid ?? "unknown"} did not receive SIGKILL after ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `(signalCode=${String(child.signalCode)}, exitCode=${String(child.exitCode)}); ` +
        `expected signalCode="SIGKILL" and exitCode=null`,
    );
  }
}

interface RunRowState {
  id: string;
  status: string;
  scheduling_status: string | null;
  isolation_intent: string | null;
  matchlock_policy: string | null;
  context: string;
}

function readRun(workflowId: string): RunRowState {
  const row = getDb()
    .prepare(
      `SELECT id, status, scheduling_status, isolation_intent, matchlock_policy, context
         FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workflowId) as RunRowState | undefined;
  assert.ok(row, `run row for ${workflowId} should exist`);
  return row;
}

describe("prep-state helper", () => {
  it("host-controlled writer records only a host opt-in", () => {
    assert.equal(initialRunIsolationState(false, "2026-01-01T00:00:00.000Z").isolationIntent, null);
    assert.equal(
      initialRunIsolationState(true, "2026-01-01T00:00:00.000Z").isolationIntent,
      ISOLATION_INTENT_RECORDED,
    );
  });

  it("initial state: opted-in held; native keeps the pre-PREP-STATE shape", () => {
    const now = "2026-02-03T04:05:06.000Z";
    const held = initialRunIsolationState(true, now);
    assert.equal(held.schedulingStatus, DRAINING_PAUSE_SCHEDULING_STATUS);
    assert.equal(held.schedulingRequestedAt, now, "a held run records the hold timestamp");
    assert.equal(held.isolationIntent, ISOLATION_INTENT_RECORDED);
    assert.equal(
      held.contextSeed[PAUSE_DRAIN_CONTEXT_KEY],
      "true",
      "the legacy-honored pause_drain hold is seeded in the first INSERT",
    );

    const native = initialRunIsolationState(false, now);
    assert.equal(native.schedulingStatus, NATIVE_SCHEDULING_STATUS);
    assert.equal(native.schedulingRequestedAt, now);
    assert.equal(native.isolationIntent, null);
    assert.deepEqual(native.contextSeed, {}, "a native run seeds no hold");
  });

  it("reader classifies the marker column explicitly, never by truthiness", () => {
    assert.equal(readIsolationIntent({ isolation_intent: ISOLATION_INTENT_RECORDED }), true);
    for (const raw of [null, undefined, "", "false", "TRUE", "1", "0", "yes"]) {
      assert.equal(
        readIsolationIntent({ isolation_intent: raw as string | null | undefined }),
        false,
        `marker ${JSON.stringify(raw)} must not read as recorded`,
      );
    }
    assert.equal(readIsolationIntent(null), false);
    assert.equal(readIsolationIntent(undefined), false);
  });

  it("ordered classification: non-NULL policy first, then intent, then native", () => {
    const valid = validV2PolicyJson();
    // NULL/absent policy consults the intent.
    assert.equal(classifyIsolationState(false, null), "native");
    assert.equal(classifyIsolationState(false, undefined), "native");
    assert.equal(classifyIsolationState(true, null), "preparing");
    assert.equal(classifyIsolationState(true, undefined), "preparing");
    // Any non-NULL policy is inspected FIRST — even for an intent-recorded row.
    assert.equal(classifyIsolationState(false, valid), "isolated");
    assert.equal(classifyIsolationState(true, valid), "isolated");
    // Every unusable non-NULL value, including the empty string.
    for (const bad of ["", "   ", "not-json", "{}", JSON.stringify({ version: 99 })]) {
      assert.equal(
        classifyIsolationState(false, bad),
        "unusable",
        `policy ${JSON.stringify(bad)} must never render native`,
      );
      assert.equal(classifyIsolationState(true, bad), "unusable");
    }
    // Row-level convenience agrees.
    assert.equal(readIsolationState({ isolation_intent: null, matchlock_policy: null }), "native");
    assert.equal(
      readIsolationState({ isolation_intent: ISOLATION_INTENT_RECORDED, matchlock_policy: null }),
      "preparing",
    );
  });

  it("the initial hold status is not schedulable by the reconciler", () => {
    assert.equal(isSchedulableSchedulingStatus(PREPARING_SCHEDULING_STATUS), false);
    assert.equal(isSchedulableSchedulingStatus(null), true);
    for (const status of SCHEDULABLE_SCHEDULING_STATUSES) {
      assert.equal(isSchedulableSchedulingStatus(status), true);
    }
  });

  it("states the enforced deployment restriction (mixed-version daemons prohibited)", () => {
    assert.match(PREP_STATE_DEPLOYMENT_RESTRICTION, /MTLK-ISO-SLICE2/);
    assert.match(PREP_STATE_DEPLOYMENT_RESTRICTION, /MUST NOT be deployed/);
    assert.match(PREP_STATE_DEPLOYMENT_RESTRICTION, /daemon must be restarted/);
  });
});

describe("PREP-STATE atomic persistence", () => {
  let tempHome: string;
  // Owned, uniquely-allocated (never fixed) port with no listener.
  let unreachableControlPort = 0;
  const savedEnv = new Map<string, string | undefined>();
  const fixtureRoots: string[] = [];

  function setEnv(key: string, value: string | undefined): void {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  function newFixtureRoot(prefix: string): string {
    const root = path.join(MTLK_FIXTURE_BASE, `${prefix}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(root, { recursive: true });
    fixtureRoots.push(root);
    return root;
  }

  before(async () => {
    tempHome = tamanduaTempDir("tamandua-prep-state-");
    const tamanduaDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });
    setEnv("HOME", tempHome);
    setEnv("TAMANDUA_STATE_DIR", tamanduaDir);
    setEnv("TAMANDUA_DB_PATH", path.join(tamanduaDir, "tamandua.db"));
    setEnv("TAMANDUA_WORKTREE_ROOT", path.join(tamanduaDir, "worktrees"));
    // Prove the fixture state is isolated from the real ~/.tamandua BEFORE any
    // code runs against it. This file imports events.js, so the static
    // isolation guard requires the coverage; the assertions are also a real
    // runtime check that the fixture HOME/state stayed under the temp dir.
    assertStatePathIsolation(tamanduaDir, "prep-state test state dir");
    assertStatePathIsolation(path.join(tamanduaDir, "tamandua.db"), "prep-state test database");
    // Held-admission tests deliberately run with NO reachable control plane:
    // reserve an OWNED ephemeral port and release it, so the D pre-INSERT
    // PREP-STATE capability gate is skipped and no fixed 59311/59312-class port
    // (which another lane could own) is ever assumed. Tests that need a peer
    // override this with their own fake port.
    const reserved = await reservePortHandle();
    unreachableControlPort = reserved.port;
    await reserved.close();
    setEnv("TAMANDUA_CONTROL_PORT", String(unreachableControlPort));
  });

  after(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(MTLK_FIXTURE_BASE, { recursive: true, force: true });
    removeTestTempDirWithDiagnostics(tempHome);
  });

  it("in-flight (held-admission) window: the first INSERT atomically records the intent AND the hold", async () => {
    const workflowId = "test-prep-held-window";
    writeMinimalWorkflow(tempHome, workflowId);
    const repoDir = path.join(tempHome, "held-window-repo");
    fs.mkdirSync(repoDir, { recursive: true });

    const held = makeHeldProbe();
    const runP = runWorkflow({
      workflowId,
      taskTitle: "PREP-STATE held window",
      workingDirectoryForHarness: repoDir,
      matchlockImage: "vic/prep-held:latest",
      matchlockSwapSupportProbe: held.probe,
      // A forged --context key must neither set nor clear the host marker.
      context: { [ISOLATION_INTENT_COLUMN]: "false" },
    });

    await awaitEntered(held, runP);
    // Exact post-INSERT/pre-policy state (no policy write has happened yet).
    const row = readRun(workflowId);
    assert.equal(row.isolation_intent, ISOLATION_INTENT_RECORDED, "intent recorded in the first INSERT");
    assert.equal(row.scheduling_status, DRAINING_PAUSE_SCHEDULING_STATUS, "legacy-honored hold in the first INSERT");
    assert.equal(
      JSON.parse(row.context)[PAUSE_DRAIN_CONTEXT_KEY],
      "true",
      "the legacy-honored context marker is seeded atomically",
    );
    assert.equal(row.matchlock_policy, null, "policy has not been persisted yet");
    assert.equal(row.status, "running");
    // Identifiable as intent-recorded and never natively schedulable.
    assert.equal(readIsolationIntent(row), true);
    assert.equal(readIsolationState(row), "preparing");

    // Release with an unsupporting probe: admission refuses without a policy
    // and nothing runs natively; the intent marker survives the refusal.
    held.releaseUnsupported();
    await assert.rejects(runP, (err: unknown) => {
      assert.ok(err instanceof MatchlockAdmissionError, `expected MatchlockAdmissionError, got ${String(err)}`);
      assert.equal(err.code, "matchlock_swap_unsupported");
      return true;
    });
    const refused = readRun(workflowId);
    assert.equal(refused.isolation_intent, ISOLATION_INTENT_RECORDED);
    assert.equal(refused.matchlock_policy, null);
    assert.equal(refused.status, "failed");
  });

  it("real creator SIGKILL: a survivor process reopens the DB and runs the retry remedy", async () => {
    const workflowId = `test-prep-sigkill-${crypto.randomUUID().slice(0, 8)}`;
    writeMinimalWorkflow(tempHome, workflowId);
    const repoDir = path.join(tempHome, `sigkill-repo-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(repoDir, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(tempHome, "sigkill-scratch-"));
    const rendezvous = path.join(scratch, "rendezvous");

    const creatorPath = path.join(scratch, "creator.mjs");
    const survivorPath = path.join(scratch, "survivor.mjs");
    const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist");
    const stateDir = path.join(tempHome, ".tamandua");
    const dbPath = path.join(stateDir, "tamandua.db");

    // Creator: enters the injected swap probe AFTER the intent INSERT commits
    // and BEFORE any policy write, signals the rendezvous, then holds the
    // event loop forever (the harness SIGKILLs this exact test-owned process).
    // The probe must HOLD a loop handle: a bare `new Promise(() => {})` holds
    // none, so once runWorkflow drains Node prints the unsettled-top-level-await
    // warning and exits the child by itself (code 13), racing the parent's kill.
    fs.writeFileSync(
      creatorPath,
      [
        `import fs from "node:fs";`,
        `const [distRoot, rendezvous] = process.argv.slice(2);`,
        `const { runWorkflow } = await import(distRoot + "/installer/run.js");`,
        `await runWorkflow({`,
        `  workflowId: process.env.CRASH_WORKFLOW_ID,`,
        `  taskTitle: "PREP-STATE crash creator",`,
        `  workingDirectoryForHarness: process.env.CRASH_REPO_DIR,`,
        `  matchlockImage: "vic/prep-crash:latest",`,
        `  matchlockSwapSupportProbe: async () => {`,
        `    fs.writeFileSync(rendezvous, "entered");`,
        `    await new Promise(() => { setInterval(() => {}, 1000); });`,
        `  },`,
        `});`,
      ].join("\n"),
      "utf-8",
    );
    // Survivor: a DIFFERENT process reopens the on-disk DB, applies the daemon
    // crash-recovery remedy (mark the orphaned in-flight row failed) and then
    // RUNS the real retry/recreate remedy (`resumeWorkflow`), reporting the
    // before/after rows so the parent can assert the outcome.
    fs.writeFileSync(
      survivorPath,
      [
        `import { DatabaseSync } from "node:sqlite";`,
        `const [dbPath, workflowId, distRoot] = process.argv.slice(2);`,
        `const db = new DatabaseSync(dbPath);`,
        `const rows = db.prepare("SELECT id, status, scheduling_status, isolation_intent, matchlock_policy, context FROM runs WHERE workflow_id = ?").all(workflowId);`,
        `if (rows.length !== 1) { console.log(JSON.stringify({ rows, result: null, after: [] })); db.close(); process.exit(0); }`,
        `db.prepare("UPDATE runs SET status='failed', scheduling_status='error' WHERE id=?").run(rows[0].id);`,
        `db.close();`,
        `const { resumeWorkflow } = await import(distRoot + "/installer/run.js");`,
        `const result = await resumeWorkflow(rows[0].id);`,
        `const db2 = new DatabaseSync(dbPath);`,
        `const after = db2.prepare("SELECT id, status, scheduling_status, isolation_intent, matchlock_policy, context FROM runs WHERE id = ?").all(rows[0].id);`,
        `console.log(JSON.stringify({ rows, result, after }));`,
        `db2.close();`,
      ].join("\n"),
      "utf-8",
    );

    const childEnv: NodeJS.ProcessEnv = cleanChildEnv({
      HOME: tempHome,
      TAMANDUA_STATE_DIR: stateDir,
      TAMANDUA_DB_PATH: dbPath,
      TAMANDUA_WORKTREE_ROOT: path.join(stateDir, "worktrees"),
      // An OWNED, uniquely-allocated port with no listener: the pre-INSERT
      // PREP-STATE capability gate is skipped (no reachable peer) and no fixed
      // 59311-class port is ever assumed.
      TAMANDUA_CONTROL_PORT: String(unreachableControlPort),
      CRASH_WORKFLOW_ID: workflowId,
      CRASH_REPO_DIR: repoDir,
      TAMANDUA_PI_BINARY: "/usr/bin/false",
    });
    const creator = spawn(process.execPath, [creatorPath, distRoot, rendezvous], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let creatorStderr = "";
    creator.stderr?.on("data", (chunk: Buffer) => {
      creatorStderr += chunk.toString();
    });

    try {
      // Deterministic synchronization point: wait for the rendezvous file the
      // probe writes; no arbitrary sleep positions the kill.
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(rendezvous)) {
        if (creator.exitCode !== null) {
          assert.fail(
            `creator exited before the rendezvous (code=${creator.exitCode}): ${creatorStderr}`,
          );
        }
        if (Date.now() > deadline) {
          assert.fail(`timed out waiting for the crash rendezvous: ${creatorStderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const rendezvousEvidence = fs.readFileSync(rendezvous, "utf-8");
      assert.equal(rendezvousEvidence, "entered", "rendezvous open evidence");
      // F2: register the `exit` listener BEFORE the kill. A SIGKILLed child can
      // be reaped and have its `exit` event emitted before a late listener is
      // registered, after which the event is lost forever (the macOS hang). The
      // bounded wait cannot hang even if that still happens: it also polls for
      // ESRCH and fails loudly at the deadline.
      const creatorExited = childExitPromise(creator);
      creator.kill("SIGKILL");
      await waitForChildExitBounded(creator, creatorExited, {
        label: "prep-state creator SIGKILL",
      });
      // SIGKILL RECEIPT (F2): validate the recorded termination state on EVERY
      // successful wait path (event, ESRCH fallback, seed). The channel proves
      // only how the wait settled, never HOW the child died, so the shared
      // helper asserts the full receipt unconditionally. Bounded: a missing
      // record fails loudly rather than hanging.
      await assertSigkillReceipt(creator);
    } finally {
      fs.rmSync(rendezvous, { force: true });
      // Never leave a live child behind (in particular after the deadline path).
      if (creator.exitCode === null && creator.signalCode === null) {
        const cleanupExited = childExitPromise(creator);
        creator.kill("SIGKILL");
        try {
          await waitForChildExitBounded(creator, cleanupExited, {
            label: "prep-state creator cleanup SIGKILL",
            deadlineMs: 5_000,
          });
        } catch {
          // Best-effort cleanup: never mask the test's own failure.
        }
      }
    }

    const survivorOut = spawnSync(process.execPath, [survivorPath, dbPath, workflowId, distRoot], {
      env: childEnv,
      encoding: "utf-8",
    });
    assert.equal(survivorOut.status, 0, `survivor failed: ${survivorOut.stderr}`);
    const payload = JSON.parse(survivorOut.stdout.trim()) as {
      rows: Array<{
        id: string;
        status: string;
        scheduling_status: string | null;
        isolation_intent: string | null;
        matchlock_policy: string | null;
        context: string;
      }>;
      result: { status: string; preparingHeld?: { message: string } } | null;
      after: Array<{
        id: string;
        status: string;
        scheduling_status: string | null;
        isolation_intent: string | null;
        matchlock_policy: string | null;
        context: string;
      }>;
    };
    assert.equal(payload.rows.length, 1, "the held row survives the creator crash");
    const row = payload.rows[0];
    assert.equal(row.isolation_intent, ISOLATION_INTENT_RECORDED, "intent is identifiable after reopen");
    assert.equal(
      row.scheduling_status,
      DRAINING_PAUSE_SCHEDULING_STATUS,
      "the legacy-honored hold survives the crash",
    );
    assert.equal(row.matchlock_policy, null, "no policy was silently written");
    assert.equal(readIsolationState(row), "preparing", "never native after reopen");
    assert.notEqual(row.status, "done", "run status never uses the step-style 'done' vocabulary");
    assert.notEqual(row.status, "completed", "the crashed run is not silently successful");

    // The retry/recreate remedy ran in the DIFFERENT process and re-asserted
    // the new-binary preparing hold without admitting the row natively.
    assert.ok(payload.result, "the survivor must run the retry remedy");
    assert.equal(payload.result!.status, "preparing", "the retry remedy holds the intent-only run");
    assert.ok(payload.result!.preparingHeld, "the remedy surfaces the held/preparing explanation");
    assert.equal(payload.after.length, 1, "the recovered row is identifiable");
    const recovered = payload.after[0];
    assert.equal(recovered.isolation_intent, ISOLATION_INTENT_RECORDED);
    assert.equal(
      recovered.scheduling_status,
      PREPARING_SCHEDULING_STATUS,
      "recovery re-asserts the new-binary preparing hold",
    );
    assert.equal(recovered.matchlock_policy, null, "recovery never invents a policy");
    assert.equal(readIsolationState(recovered), "preparing", "recovery never treats the row as native");
    assert.equal(recovered.status, "failed", "the intent-only retry is held, never resumed native");
  });

  it("a reconciler tick across an in-flight admission produces no native dispatch", async () => {
    const workflowId = "test-prep-reconciler-tick";
    writeMinimalWorkflow(tempHome, workflowId);
    const repoDir = path.join(tempHome, "reconciler-tick-repo");
    fs.mkdirSync(repoDir, { recursive: true });

    const held = makeHeldProbe();
    const runP = runWorkflow({
      workflowId,
      taskTitle: "PREP-STATE reconciler tick",
      workingDirectoryForHarness: repoDir,
      matchlockImage: "vic/prep-tick:latest",
      matchlockSwapSupportProbe: held.probe,
    });

    await awaitEntered(held, runP);
    const before = readRun(workflowId);
    assert.equal(before.scheduling_status, DRAINING_PAUSE_SCHEDULING_STATUS);

    await _reconcileOnce();

    const after = readRun(workflowId);
    assert.equal(after.status, "running", "the reconciler must not silently succeed the held run");
    assert.equal(
      after.scheduling_status,
      DRAINING_PAUSE_SCHEDULING_STATUS,
      "the reconciler must not admit the held run natively",
    );
    assert.equal(after.matchlock_policy, null, "no policy was invented");
    assert.equal(after.isolation_intent, ISOLATION_INTENT_RECORDED);
    assert.equal(
      _scheduledJobCountForRun(after.id),
      0,
      "no native dispatch timers may be created for the held run",
    );

    held.releaseUnsupported();
    await assert.rejects(runP, (err: unknown) => {
      assert.ok(err instanceof MatchlockAdmissionError, `expected MatchlockAdmissionError, got ${String(err)}`);
      assert.equal(err.code, "matchlock_swap_unsupported");
      return true;
    });
  });

  it("the legacy (older-binary) reconciler query does not select the held row", async () => {
    const workflowId = "test-prep-older-binary";
    writeMinimalWorkflow(tempHome, workflowId);
    const repoDir = path.join(tempHome, "older-binary-repo");
    fs.mkdirSync(repoDir, { recursive: true });

    const held = makeHeldProbe();
    const runP = runWorkflow({
      workflowId,
      taskTitle: "PREP-STATE older binary",
      workingDirectoryForHarness: repoDir,
      matchlockImage: "vic/prep-old:latest",
      matchlockSwapSupportProbe: held.probe,
    });

    await awaitEntered(held, runP);
    const row = readRun(workflowId);
    // The EXACT pre-PREP-STATE reconciler predicate, as an older daemon runs it.
    const legacySelected = getDb()
      .prepare(
        `SELECT id FROM runs
          WHERE status IN ('running')
            AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register','active','error','waiting'))`,
      )
      .all() as Array<{ id: string }>;
    assert.ok(
      !legacySelected.some((r) => r.id === row.id),
      "an older binary's reconciler must treat the held row as non-schedulable (hold rides scheduling_status)",
    );

    held.releaseUnsupported();
    await assert.rejects(runP, (err: unknown) => {
      assert.ok(err instanceof MatchlockAdmissionError, `expected MatchlockAdmissionError, got ${String(err)}`);
      assert.equal(err.code, "matchlock_swap_unsupported");
      return true;
    });
  });

  it("every subsequent run-context update preserves the marker", async () => {
    const workflowId = "test-prep-context-preserved";
    writeMinimalWorkflow(tempHome, workflowId);
    const repoDir = path.join(tempHome, "context-preserved-repo");
    fs.mkdirSync(repoDir, { recursive: true });

    const held = makeHeldProbe();
    const runP = runWorkflow({
      workflowId,
      taskTitle: "PREP-STATE context preservation",
      workingDirectoryForHarness: repoDir,
      matchlockImage: "vic/prep-ctx:latest",
      matchlockSwapSupportProbe: held.probe,
    });

    await awaitEntered(held, runP);
    const row = readRun(workflowId);
    // Drive the generic run-context writer (the shared UPDATE path used by
    // step completion, resume and replacement).
    setRunContextKey(row.id, "some_step_key", "value");
    const updated = readRun(workflowId);
    assert.equal(updated.context.includes("some_step_key"), true);
    assert.equal(
      updated.isolation_intent,
      ISOLATION_INTENT_RECORDED,
      "a context rewrite must never clear the dedicated marker",
    );

    held.releaseUnsupported();
    await assert.rejects(runP, (err: unknown) => {
      assert.ok(err instanceof MatchlockAdmissionError, `expected MatchlockAdmissionError, got ${String(err)}`);
      assert.equal(err.code, "matchlock_swap_unsupported");
      return true;
    });
  });

  it("admission success persists the policy and releases the hold in one transition", async () => {
    const workflowId = "test-prep-admitted";
    writeMinimalWorkflow(tempHome, workflowId);
    const fixtureRoot = newFixtureRoot(workflowId);
    const repoDir = path.join(fixtureRoot, "repo");
    initGitRepo(repoDir);
    fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });

    const fake = await startFakeControlPlane();
    setEnv("TAMANDUA_CONTROL_PORT", String(fake.port));
    const savedProbeEnv = new Map<string, string | undefined>();
    const fakeDriver = writeFakeRpcDriver({ dir: path.join(fixtureRoot, "driver") });
    const transcript = tempTranscriptPath();
    const setProbeEnv = (key: string, value: string | undefined): void => {
      savedProbeEnv.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    setProbeEnv(MATCHLOCK_RPC_BIN_ENV, process.execPath);
    setProbeEnv(MATCHLOCK_RPC_ARGS_ENV, JSON.stringify([fakeDriver]));
    setProbeEnv("FAKE_TRANSCRIPT_FILE", transcript);
    setProbeEnv("FAKE_IMAGE_TAG", "vic/prep-admitted:latest");
    setProbeEnv("FAKE_IMAGE_DIGEST", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    setProbeEnv("FAKE_IMAGE_CONFIG_DIGEST", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const supportingProbe: MatchlockSwapSupportProbe = (binaryPath) => ({ supported: true, binaryPath });
    // Snapshot the scheduler jobs BEFORE reconciliation so teardown below
    // removes only jobs created during THIS test.
    const jobsBeforeAdmission = _scheduledRunIds();

    try {
      const result = await runWorkflow({
        workflowId,
        taskTitle: "PREP-STATE admitted",
        workingDirectoryForHarness: repoDir,
        matchlockImage: "vic/prep-admitted:latest",
        matchlockSwapSupportProbe: supportingProbe,
        // An unrelated launch context key must survive the release (the
        // single guarded UPDATE drops ONLY pause_drain).
        context: { custom_launch_key: "kept" },
      });
      assert.equal(result.status, "running");

      const row = readRun(workflowId);
      assert.equal(row.isolation_intent, ISOLATION_INTENT_RECORDED, "intent survives admission");
      assert.equal(row.scheduling_status, NATIVE_SCHEDULING_STATUS, "the hold is released after the policy write");
      assert.ok(row.matchlock_policy, "the validated policy is persisted");
      assert.equal(readIsolationState(row), "isolated");
      const admittedContext = JSON.parse(row.context) as Record<string, string>;
      assert.equal(
        PAUSE_DRAIN_CONTEXT_KEY in admittedContext,
        false,
        "the release drops the host-seeded pause_drain marker in the SAME write",
      );
      assert.equal(
        admittedContext.custom_launch_key,
        "kept",
        "unrelated context keys survive the release",
      );

      // tamandua-crf regression: the durable marker is gone BEFORE the daemon
      // registration path runs. Drive the REAL reconciliation pass (the same
      // handleRegisterRun the daemon runs on register-run/nudge/reconcile) and
      // require the run to reach 'active' WITH dispatch jobs — the original
      // defect left it stranded at pending_register forever with zero jobs.
      await _reconcileOnce();
      const active = readRun(workflowId);
      assert.equal(
        active.scheduling_status,
        "active",
        "the REAL registration path admits the released run",
      );
      assert.ok(
        _scheduledJobCountForRun(active.id) > 0,
        "scheduling is established for the admitted run (crf: it used to be zero forever)",
      );
    } finally {
      // Unconditional teardown: remove EVERY scheduler job created during this
      // test (never leaving dangling timers behind when an assertion throws
      // earlier than expected) — bounded to jobs NOT present at test start.
      for (const scheduledId of _scheduledRunIds()) {
        if (!jobsBeforeAdmission.has(scheduledId)) {
          await removeRunCrons(scheduledId);
        }
      }
      for (const [key, value] of savedProbeEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (fs.existsSync(transcript)) fs.rmSync(transcript, { force: true });
      await fake.close();
    }
  });

  it("operator drain mid-window survives the guarded release (fail-closed; no policy, no failure event, no scheduling)", async () => {
    const workflowId = "test-prep-operator-midwindow";
    writeMinimalWorkflow(tempHome, workflowId);
    const fixtureRoot = newFixtureRoot(workflowId);
    const repoDir = path.join(fixtureRoot, "repo");
    initGitRepo(repoDir);
    fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });

    // A full admission fixture (fake RPC driver + fake image responses): the
    // operator's drain must be what refuses the release, not a broken
    // transport. Mirrors the admitted-run fixture above.
    const savedProbeEnv = new Map<string, string | undefined>();
    const fakeDriver = writeFakeRpcDriver({ dir: path.join(fixtureRoot, "driver") });
    const transcript = tempTranscriptPath();
    const setProbeEnv = (key: string, value: string | undefined): void => {
      savedProbeEnv.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    setProbeEnv(MATCHLOCK_RPC_BIN_ENV, process.execPath);
    setProbeEnv(MATCHLOCK_RPC_ARGS_ENV, JSON.stringify([fakeDriver]));
    setProbeEnv("FAKE_TRANSCRIPT_FILE", transcript);
    setProbeEnv("FAKE_IMAGE_TAG", "vic/prep-operator:latest");
    setProbeEnv("FAKE_IMAGE_DIGEST", "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
    setProbeEnv("FAKE_IMAGE_CONFIG_DIGEST", "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");

    try {
      const held = makeHeldProbe();
      const runP = runWorkflow({
        workflowId,
        taskTitle: "PREP-STATE operator mid-window",
        workingDirectoryForHarness: repoDir,
        matchlockImage: "vic/prep-operator:latest",
        matchlockSwapSupportProbe: held.probe,
      });

      await awaitEntered(held, runP);
      const row = readRun(workflowId);
      // The operator's drain lands WHILE admission is still awaited: record
      // the durable attribution (`paused_by`) the guard must honor, keeping
      // the drain-hold representation the control plane uses.
      setRunContextKey(row.id, "paused_by", "operator");
      getDb()
        .prepare(`UPDATE runs SET scheduling_status = ?, updated_at = ? WHERE id = ?`)
        .run(DRAINING_PAUSE_SCHEDULING_STATUS, new Date().toISOString(), row.id);

      // Admission now completes with a SUPPORTING probe — but the guarded
      // release must refuse to clobber the operator's state.
      held.releaseSupported();
      await assert.rejects(runP, (err: unknown) => {
        assert.equal(
          (err as Error).name,
          "MatchlockAdmissionStateConflictError",
          `expected the ownership-conflict class, got ${String(err)}`,
        );
        assert.match(String((err as Error).message), /changed concurrently/);
        return true;
      });

      const after = readRun(workflowId);
      assert.equal(after.status, "running", "the operator's run-state representation survives");
      assert.equal(after.matchlock_policy, null, "no policy is persisted over operator state");
      assert.equal(after.scheduling_status, DRAINING_PAUSE_SCHEDULING_STATUS, "the drain hold survives");
      const ctx = JSON.parse(after.context) as Record<string, string>;
      assert.equal(ctx[PAUSE_DRAIN_CONTEXT_KEY], "true", "the operator marker survives");
      assert.equal(ctx.paused_by, "operator", "the operator attribution survives");
      assert.equal(_scheduledJobCountForRun(after.id), 0, "no dispatch work is scheduled");
      const events = getRunEvents(after.id);
      assert.equal(
        events.some((event) => event.event === "run.failed"),
        false,
        "no misleading run.failed event is emitted for an ownership conflict",
      );
    } finally {
      for (const [key, value] of savedProbeEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (fs.existsSync(transcript)) fs.rmSync(transcript, { force: true });
    }
  });

  it("worktree-mode context flush MERGES: a concurrent mid-window write survives", async () => {
    const workflowId = "test-prep-wt-flush";
    writeMinimalWorkflow(tempHome, workflowId, "worktree");
    const originDir = path.join(tempHome, "flush-origin");
    initGitRepo(originDir);

    // A post-checkout hook fires DURING `git worktree add` — i.e. between the
    // first INSERT and the launch's context flush — and writes a concurrent
    // key into the run's durable context. The flush must MERGE (json_patch),
    // never rewrite the whole context (which would erase this write).
    const hookDir = path.join(tempHome, "flush-hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    const writerPath = path.join(hookDir, "flush-writer.cjs");
    fs.writeFileSync(
      writerPath,
      `const { DatabaseSync } = require("node:sqlite");\n` +
        `const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);\n` +
        `db.exec("PRAGMA busy_timeout = 5000");\n` +
        `db.prepare("UPDATE runs SET context = json_set(context, '$.hook_key', 'hook-kept') WHERE workflow_id = ?").run(${JSON.stringify(workflowId)});\n` +
        `db.close();\n`,
      "utf-8",
    );
    const hookPath = path.join(hookDir, "post-checkout");
    fs.writeFileSync(hookPath, `#!/bin/sh\nexec "${process.execPath}" "${writerPath}"\n`, "utf-8");
    fs.chmodSync(hookPath, 0o755);
    runGit(["config", "core.hooksPath", hookDir], originDir);

    const fake = await startFakeControlPlane();
    setEnv("TAMANDUA_CONTROL_PORT", String(fake.port));
    try {
      await runWorkflow({
        workflowId,
        taskTitle: "PREP-STATE worktree flush",
        worktreeOriginRepository: originDir,
      });
      const row = readRun(workflowId);
      const ctx = JSON.parse(row.context) as Record<string, string>;
      assert.equal(ctx.hook_key, "hook-kept", "the concurrent mid-window write survives the flush");
      assert.ok(ctx.worktree_path, "the worktree path is flushed");
      assert.equal(ctx.repo, ctx.worktree_path, "repo points at the managed worktree");
      assert.equal(
        ctx[RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY],
        ctx.worktree_path,
        "the harness working directory is flushed",
      );
      assert.equal(ctx.original_branch, "main", "the origin branch is flushed");
      assert.match(String(ctx.base_branch_sha), /^[0-9a-f]{40}$/, "the base branch SHA is flushed");
      assert.match(String(ctx.worktree_origin_sha), /^[0-9a-f]{40}$/, "the origin SHA is flushed");
    } finally {
      await fake.close();
    }
  });

  it("a native run carries no marker and a --context key cannot forge one", async () => {
    const fake = await startFakeControlPlane();
    setEnv("TAMANDUA_CONTROL_PORT", String(fake.port));
    try {
      const cleanId = "test-prep-native-clean";
      writeMinimalWorkflow(tempHome, cleanId);
      const cleanRepo = path.join(tempHome, "native-clean-repo");
      fs.mkdirSync(cleanRepo, { recursive: true });
      await runWorkflow({
        workflowId: cleanId,
        taskTitle: "PREP-STATE native clean",
        workingDirectoryForHarness: cleanRepo,
      });
      const clean = readRun(cleanId);
      assert.equal(clean.isolation_intent, null, "a native run carries no marker");
      assert.equal(clean.scheduling_status, NATIVE_SCHEDULING_STATUS);
      assert.equal(clean.context.includes(ISOLATION_INTENT_COLUMN), false, "no marker key in native context");
      assert.equal(readIsolationState(clean), "native");

      const forgedId = "test-prep-native-forged";
      writeMinimalWorkflow(tempHome, forgedId);
      const forgedRepo = path.join(tempHome, "native-forged-repo");
      fs.mkdirSync(forgedRepo, { recursive: true });
      await runWorkflow({
        workflowId: forgedId,
        taskTitle: "PREP-STATE native forged",
        workingDirectoryForHarness: forgedRepo,
        // A --context key must never be able to set the host marker.
        context: { [ISOLATION_INTENT_COLUMN]: ISOLATION_INTENT_RECORDED },
      });
      const forged = readRun(forgedId);
      assert.equal(
        forged.isolation_intent,
        null,
        "the dedicated column is authoritative; a --context key cannot set it",
      );
      assert.equal(readIsolationState(forged), "native");
    } finally {
      await fake.close();
    }
  });
});

/**
 * F3 — regression coverage for the hang-proof bounded wait itself. These cases
 * are deliberately independent of the full creator/DB fixture: they spawn
 * trivial children to exercise the two properties that remove the macOS hang —
 * the deadline fails loudly (never hangs), and the ESRCH poll settles the wait
 * even when the `exit` event is unavailable.
 */
describe("prep-state SIGKILL bounded wait (F3 regression)", () => {
  it("fails loudly instead of hanging when a live child ignores every signal", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = childExitPromise(child);
    try {
      await assert.rejects(
        waitForChildExitBounded(child, exited, {
          label: "never-dying child",
          deadlineMs: 250,
          pollMs: 25,
        }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /never-dying child/, "the failure names the wait");
          assert.match(message, new RegExp(`pid=${child.pid}`), "the failure names the pid");
          assert.match(message, /did not exit within/, "the failure states how long it waited");
          assert.match(message, /ESRCH never observed/, "the failure states the ESRCH observation");
          return true;
        },
      );
      // The loud deadline failure leaves the child running: not a hang, and the
      // finally below still proves the helper can settle once it is killed.
      assert.equal(child.exitCode, null, "the child is still alive after the loud failure");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildExitBounded(child, exited, {
          label: "never-dying child cleanup",
          deadlineMs: 5_000,
        });
      }
    }
  });

  it("resolves via the pid-death poll when the `exit` event is unavailable", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Reproduce the exact lost-event race from the macOS defect: a live child's
    // `exit` listener is detached before the kill, so the event can never
    // settle the wait.
    const exited = childExitPromise(child);
    try {
      child.removeAllListeners("exit");
      child.kill("SIGKILL");
      const outcome = await waitForChildExitBounded(child, exited, {
        label: "lost-exit child",
        deadlineMs: 5_000,
        pollMs: 20,
      });
      assert.equal(outcome.channel, "esrch", "the wait must fall back to the pid-death poll");
      assert.equal(outcome.esrchSeen, true, "ESRCH must have been observed");
      // POSITIVE COUNTERPART: the SAME shared receipt validation must accept a
      // real SIGKILL that settled over the ESRCH fallback (the original test
      // proves it over the event path). Before H1 this case asserted nothing
      // about the receipt.
      await assertSigkillReceipt(child);
    } finally {
      // `exited` was detached, so this cleanup relies on the bounded ESRCH poll.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        try {
          await waitForChildExitBounded(child, exited, {
            label: "lost-exit child cleanup",
            deadlineMs: 5_000,
          });
        } catch {
          // Best-effort cleanup: never mask the test's own failure.
        }
      }
    }
  });

  it("rejects a natural exit over the ESRCH fallback (receipt negative control)", async () => {
    // RELEASE HANDSHAKE (deterministic — no timing sleep): the child writes
    // `ready`, then exits NATURALLY (code 13) only after the parent creates
    // `release`. The wait therefore starts while the child is PROVABLY alive
    // (release does not exist yet), and the only channel that can settle it is
    // the pid-death poll.
    const handshakeDir = tamanduaTempDir("prep-state-f3-neg-");
    const ready = path.join(handshakeDir, "ready");
    const release = path.join(handshakeDir, "release");
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          `const fs = require("node:fs");`,
          `fs.writeFileSync(process.env.READY, "ready");`,
          `const timer = setInterval(() => {`,
          `  if (fs.existsSync(process.env.RELEASE)) { clearInterval(timer); process.exit(13); }`,
          `}, 10);`,
        ].join("\n"),
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: cleanChildEnv({ READY: ready, RELEASE: release }),
      },
    );
    // Capture the (never-resolving, detached) exit notification BEFORE any
    // assertion that can throw, so the finally always has a cleanup channel.
    const exited = childExitPromise(child);
    try {
      // Bounded wait for `ready`: the child is alive and polling for `release`.
      const readyDeadline = Date.now() + 5_000;
      while (!fs.existsSync(ready)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          assert.fail(
            `natural-exit child died before the release handshake ` +
              `(code=${child.exitCode}, signal=${child.signalCode})`,
          );
        }
        if (Date.now() > readyDeadline) {
          assert.fail("timed out waiting for the natural-exit child `ready` marker");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Make the `exit` notification unavailable (the macOS lost-event race),
      // start the bounded wait while the child is still alive, and only THEN
      // release it to exit naturally.
      child.removeAllListeners("exit");
      const waitP = waitForChildExitBounded(child, exited, {
        label: "natural-exit lost-event child",
        deadlineMs: 5_000,
        pollMs: 20,
      });
      fs.writeFileSync(release, "release");
      const outcome = await waitP;
      assert.equal(outcome.channel, "esrch", "the wait must fall back to the pid-death poll");
      assert.equal(outcome.esrchSeen, true, "ESRCH must have been observed");

      // NEGATIVE CONTROL: the shared validation that accepts a real SIGKILL
      // above must REJECT this natural exit. The rejection must be the
      // RECEIPT-VALIDATION error naming the observed state (signalCode=null,
      // exitCode=13) — NOT the wait's deadline/never-exited error and not an
      // unrelated exception.
      await assert.rejects(assertSigkillReceipt(child), (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /SIGKILL receipt/, "the rejection is the receipt validation");
        assert.match(message, /did not receive SIGKILL/, "the natural exit is rejected");
        assert.match(message, /signalCode=null/, "the rejection names the observed signal");
        assert.match(message, /exitCode=13/, "the rejection names the natural exit code");
        assert.doesNotMatch(
          message,
          /did not exit within/,
          "the rejection must be the receipt error, not the wait deadline",
        );
        return true;
      });
    } finally {
      fs.rmSync(handshakeDir, { recursive: true, force: true });
      // Reap the test-owned child even if an assertion threw. No signal was
      // sent in this arm, so the child may still be alive on the failure path.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        try {
          await waitForChildExitBounded(child, exited, {
            label: "natural-exit child cleanup",
            deadlineMs: 5_000,
          });
        } catch {
          // Best-effort cleanup: never mask the test's own failure.
        }
      }
    }
  });
});

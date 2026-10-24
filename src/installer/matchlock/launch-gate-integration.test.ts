/**
 * launch-gate-integration.test.ts — G8 ADMISSION-INTEGRATION (bead
 * tamandua-7p5.1.8) US-007.
 *
 * The ONE integration test the brief names. Where the per-module suites pin one
 * seam each, this file composes the delivered wiring end to end and asserts the
 * eight properties the brief names, against REAL on-disk SQLite stores:
 *
 *   1. a refusal precedes every create: ZERO create-config builds, ZERO
 *      controller constructions, ZERO RPC frames, no partial mount;
 *   2. aggregation: every discoverable store is observed and every finding is
 *      preserved (one bad store never aborts the others);
 *   3. revalidation by IDENTITY catches a store-set change between evaluate and
 *      create — a path-list change, a (dev, ino) replacement at the same path,
 *      and a config edited from delete to wal;
 *   4. a scheduled round that is refused does NOT re-dispatch: it takes the
 *      blocked-equivalent terminal state (`status='failed'`,
 *      `scheduling_status=NULL`) and a later tick records nothing;
 *   5. the refusal receipt is written FIRST and a receipt-write FAILURE is
 *      itself an operational refusal (exit 78), never an allow;
 *   6. the controller backstop refuses a verdict that belongs to a DIFFERENT
 *      invocation, before any RPC child exists;
 *   7. the hermes-shell variant is its own invocation kind in the receipt;
 *   8. native (pi) runs are unregressed: no gate evaluation, no receipt, and an
 *      ungated create still happens exactly once.
 *
 * LANE NOTE (deliberate, documented in CHANGES). The story's implementation note
 * asked for the parallel lane, but scenarios 1/6/8 are irreducible facts about
 * `MatchlockController` — the only place a VM can be created — and importing it
 * makes this file spawn-capable by the repository's own classification rule
 * (`controller.ts` reaches `rpc-client.ts`). The last test therefore asserts the
 * file IS registered in tests/serial-files.txt WITH the classifier's own reason,
 * which is the mechanical contract the guard enforces; no coverage is weakened
 * to buy a lane. Nothing here boots a VM: every refusal path leaves the fake RPC
 * transcript ABSENT (proof no child ran at all), and the two create-once cases
 * drive the existing fake RPC driver.
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
  interactiveStoreMountPlan,
  LAUNCH_GATE_STORE_CONTRACT,
} from "../../../dist/installer/matchlock/doctor-gate.js";
import { observeStore } from "../../../dist/installer/matchlock/store-header.js";
import { evaluateGate } from "../../../dist/installer/matchlock/launch-gate.js";
import {
  LaunchGateRefusalError,
  evaluateAndRecordLaunchGate,
  resolveLaunchGateReceiptPath,
  type LaunchGateBinding,
} from "../../../dist/installer/matchlock/launch-gate-wiring.js";
import {
  evaluateInteractiveLaunchGate,
  resolveInteractiveAdmissionAnchorPath,
} from "../../../dist/installer/matchlock/launch-gate-interactive.js";
import {
  buildInteractiveSessionRuntime,
  runInteractiveSession,
} from "../../../dist/installer/matchlock/interactive-session-orchestration.js";
import {
  MatchlockController,
  MatchlockControllerError,
} from "../../../dist/installer/matchlock/controller.js";
import { buildMatchlockCreateConfig } from "../../../dist/installer/matchlock/mount-plan.js";
import {
  tempTranscriptPath,
  writeFakeRpcDriver,
} from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import {
  MATCHLOCK_NETWORK_POLICY_VERSION,
  buildMatchlockPolicy,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";
import {
  evaluateScheduledDispatchGate,
  scheduledLaunchGateInvocationId,
} from "../../../dist/installer/matchlock/launch-gate-scheduled.js";
import {
  runMatchlockSchedulerRound,
  setMatchlockHermesInvocationRunnerForTest,
  setMatchlockHomeAliasResolverForTest,
  setMatchlockScheduledLaunchGateForTest,
  type MatchlockSchedulerRound,
} from "../../../dist/installer/matchlock/scheduler-matchlock.js";
import { setMatchlockExecutionBoundarySeamsForTest } from "../../../dist/installer/matchlock/execution-boundary.js";
import { classifyTestFile } from "../../../tests/helpers/serial-classification.ts";

const HERE = path.dirname(import.meta.filename);
const REPO_ROOT = path.resolve(HERE, "../../..");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");
const THIS_FILE_REL = "src/installer/matchlock/launch-gate-integration.test.ts";

// ---------------------------------------------------------------------------
// fixtures: real on-disk state, never a fabricated header
// ---------------------------------------------------------------------------

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

function newDir(prefix: string): string {
  return track(tamanduaShortTempDir(prefix));
}

function newStateDir(): string {
  return newDir("tamandua-lg-int-state-");
}

/** Deterministic stored instants: UTC ISO-Z, one second apart. */
function sequenceNow(): () => string {
  let tick = 0;
  const base = Date.parse("2026-02-03T04:05:06.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

/**
 * A REAL rollback-format SQLite store (`node:sqlite` writes header version pair
 * (1, 1) and no sidecars), so "a genuine delete-mode store passes" is evidence
 * rather than an assumption.
 */
function writeRollbackStore(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
  database.exec("INSERT INTO t (value) VALUES ('row')");
  database.close();
}

/**
 * A byte-exact write-ahead-log store: correct SQLite signature, header version
 * pair (2, 2), no sidecars. The gate reads bytes only, so this is exactly the
 * evidence a WAL store presents in its header.
 */
function writeWalStore(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(header, 0);
  header[18] = 2;
  header[19] = 2;
  fs.writeFileSync(file, header);
}

/** A disposable Hermes profile home: `config.yaml` + a real rollback state.db. */
function newProfileHome(journalMode: "delete" | "wal" = "delete"): string {
  const home = newDir("tamandua-lg-int-home-");
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `database:\n  journal_mode: ${journalMode}\n`,
  );
  writeRollbackStore(storePathOf(home));
  return home;
}

function storePathOf(home: string, name = "state.db"): string {
  return path.join(home, name);
}

/** A disposable operator home whose effective profile is `<home>/.hermes`. */
function newScheduledProfile(): { operatorHome: string; profileHome: string } {
  const operatorHome = newDir("tamandua-lg-int-operator-");
  const profileHome = path.join(operatorHome, ".hermes");
  fs.mkdirSync(profileHome, { recursive: true });
  fs.writeFileSync(path.join(profileHome, "config.yaml"), "database:\n  journal_mode: delete\n");
  writeRollbackStore(storePathOf(profileHome));
  return { operatorHome, profileHome };
}

/** The same disposable operator home, made NON-compliant (a WAL store appears). */
function newNonCompliantScheduledProfile(): { operatorHome: string; profileHome: string } {
  const profile = newScheduledProfile();
  writeWalStore(storePathOf(profile.profileHome, "verification_evidence.db"));
  return profile;
}

// ---------------------------------------------------------------------------
// scheduled round fixtures (policy + round shape)
// ---------------------------------------------------------------------------

const RUN_ID = "run-1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e";
const BARE_RUN_ID = "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e";
const JOB_ID = "job-feature-dev-merge-worktree_developer";
const DISPATCH_ID = `run:${BARE_RUN_ID}:round:${JOB_ID}:dispatch`;
const ATTEMPT_ID = `run:${BARE_RUN_ID}:round:${JOB_ID}:attempt`;

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
    requestedImageSource: "explicit",
    rootUsageConsent: false,
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

/** The fake host-suite wiring: never touched (the runner seam replaces it). */
const FAKE_ROOT = track(tamanduaShortTempDir("tamandua-lg-int-fake-"));
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

/** One scheduled round over a policy (pack + suite supplied, so nothing builds). */
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

// ---------------------------------------------------------------------------
// interactive fixtures
// ---------------------------------------------------------------------------

const ADMITTED_IDENTITY = {
  digest: "sha256:admitted-image-digest",
  config_digest: "sha256:admitted-config-digest",
  tag: "igorhvr/bedlam-ubuntu",
};

function selectionFor(home: string): Record<string, unknown> {
  return {
    profile: "default",
    isNamedProfile: false,
    hostEffectiveDir: home,
    guestHermesHome: "/workspace/config/hermes",
    guestProfilesRoot: "/workspace/config/hermes/profiles",
    hermesHomeEnv: home,
    externalDependencies: [],
  };
}

function interactiveArgs(overrides: Record<string, unknown> = {}): any {
  return {
    subcommand: "hermes",
    harness: "hermes",
    shell: false,
    workingDirectory: "/home/tester/project",
    image: "igorhvr/bedlam-ubuntu",
    imageSource: "standard",
    resourceLimits: {
      cpus: 4,
      memoryMB: 8192,
      diskSizeMB: 20480,
      swapMB: 8192,
      sources: { cpus: "default", memoryMB: "default", diskSizeMB: "default", swapMB: "default" },
    },
    rootUsageOverride: false,
    allowPrivate: [],
    matchlockPrivileged: { privileged: true, source: "default" },
    matchlockDnsPriority: { priority: "ipv4", source: "default" },
    ...overrides,
  };
}

/** Interactive adapter deps: hermetic managed scope, empty holder probe. */
function interactiveGateDeps(
  stateDir: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    now: sequenceNow(),
    stateDir,
    configOptions: { managedDir: null, env: {} },
    holderProbe: () => [],
    admissionIdentity: ADMITTED_IDENTITY,
    ...overrides,
  };
}

/** Run a synchronous gate call and return the typed refusal it threw. */
function captureRefusal(run: () => unknown): LaunchGateRefusalError {
  try {
    run();
  } catch (error) {
    if (error instanceof LaunchGateRefusalError) return error;
    throw error;
  }
  throw new Error("expected the launch gate to refuse, but it returned");
}

/** The REAL gate's binding for one interactive hermes invocation. */
function allowedInteractiveBinding(
  home: string,
  stateDir: string,
  invocationId = "interactive:hermes:pid:4242:start:2026-02-03T04:05:06.000Z",
): LaunchGateBinding {
  const decision = evaluateInteractiveLaunchGate(
    selectionFor(home) as never,
    interactiveArgs(),
    interactiveGateDeps(stateDir, { invocationId }) as never,
  );
  assert.equal(decision.action, "allow");
  if (decision.action !== "allow") throw new Error("unreachable");
  return decision.binding;
}

// ---------------------------------------------------------------------------
// controller fixtures (the fake RPC driver journals every wire request)
// ---------------------------------------------------------------------------

const FAKE_ENV_KEYS = [
  "FAKE_IMAGE_TAG",
  "FAKE_IMAGE_DIGEST",
  "FAKE_IMAGE_CONFIG_DIGEST",
  "FAKE_TRANSCRIPT_FILE",
] as const;

function snapshotFakeEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of FAKE_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreFakeEnv(saved: Record<string, string | undefined>): void {
  for (const key of FAKE_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function readTranscript(transcriptPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(transcriptPath)) return [];
  return fs
    .readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A real host config directory the controller policy points at. */
function newConfigDir(harness: "hermes" | "pi" = "hermes"): string {
  const dir = newDir("tamandua-lg-int-config-");
  fs.writeFileSync(
    path.join(dir, harness === "pi" ? "settings.json" : "config.yaml"),
    "{}\n",
  );
  return dir;
}

/** A host helper-pack directory (the controller requires one by default). */
function newHelperPack(): string {
  const dir = newDir("tamandua-lg-int-pack-");
  fs.writeFileSync(path.join(dir, "bin-tamandua"), "#!/bin/sh\n", "utf8");
  return dir;
}

/** A minimal v3 policy the controller accepts (same shape its own suites use). */
function controllerPolicy(configDir: string, over: Record<string, unknown> = {}): ExecutionIsolation {
  return {
    version: 1,
    backend: "matchlock",
    requestedImage: ADMITTED_IDENTITY.tag,
    requestedImageSource: "explicit",
    rootUsageConsent: false,
    harness: "hermes",
    configurationRoot: configDir,
    configurationProfile: "config.yaml",
    guestConfigurationRoot: "/workspace/config/hermes",
    workPathMode: "host-absolute",
    workingDirectory: "/opt/project",
    workMounts: [
      { hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" },
    ],
    originalRepositoryRoot: "/opt/project",
    gitMetadataRoots: ["/opt/project/.git"],
    mountPolicyVersion: 1,
    networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 0 },
    ...over,
  } as unknown as ExecutionIsolation;
}

interface RpcScaffold {
  driverPath: string;
  transcriptExists: () => boolean;
  methods: () => string[];
  createCount: () => number;
}

/** Fresh transcript + fake image env per test; the driver is the only child. */
function scaffoldRpc(t: { after: (fn: () => unknown) => void }): RpcScaffold {
  const saved = snapshotFakeEnv();
  const transcriptPath = tempTranscriptPath();
  process.env.FAKE_TRANSCRIPT_FILE = transcriptPath;
  process.env.FAKE_IMAGE_TAG = ADMITTED_IDENTITY.tag;
  process.env.FAKE_IMAGE_DIGEST = ADMITTED_IDENTITY.digest;
  process.env.FAKE_IMAGE_CONFIG_DIGEST = ADMITTED_IDENTITY.config_digest;
  t.after(() => restoreFakeEnv(saved));
  const driverPath = writeFakeRpcDriver({ dir: newDir("tamandua-lg-int-driver-") });
  const methods = (): string[] =>
    readTranscript(transcriptPath)
      .map((entry) => (typeof entry.method === "string" ? (entry.method as string) : undefined))
      .filter((method): method is string => typeof method === "string");
  return {
    driverPath,
    transcriptExists: () => fs.existsSync(transcriptPath),
    methods,
    createCount: () => methods().filter((method) => method === "create").length,
  };
}

/**
 * A REAL MatchlockController over the fake RPC transport, with a counting
 * create-config builder that delegates to the production mount-plan builder —
 * so "the create-config builder ran exactly N times" is measured on the code
 * path production uses, not on a stub that stands in for it.
 */
function makeController(input: {
  t: { after: (fn: () => unknown) => void };
  rpc: RpcScaffold;
  configDir: string;
  helperPack: string;
  harness?: "hermes" | "pi";
  launchGate?: { invocationId: string; binding: LaunchGateBinding | null };
  countCreateConfig: () => void;
}): MatchlockController {
  const policy = controllerPolicy(
    input.configDir,
    input.harness === "pi"
      ? {
          harness: "pi",
          configurationProfile: "settings.json",
          guestConfigurationRoot: "/workspace/config/pi",
        }
      : {},
  );
  const controller = new MatchlockController(policy, {
    rpcBinaryPath: process.execPath,
    rpcArgs: [input.rpc.driverPath],
    helperPackHostPath: input.helperPack,
    onLog: () => {},
    requestTimeoutMs: 10_000,
    buildCreateConfig: (scopedPolicy, identity) => {
      input.countCreateConfig();
      return buildMatchlockCreateConfig(scopedPolicy, identity, {
        helperPackHostPath: input.helperPack,
      });
    },
    ...(input.launchGate !== undefined ? { launchGate: input.launchGate } : {}),
  });
  input.t.after(() => controller.dispose());
  return controller;
}

// ---------------------------------------------------------------------------
// receipt helpers
// ---------------------------------------------------------------------------

function readReceiptAt(receiptPath: string) {
  return parseReceipt(fs.readFileSync(receiptPath, "utf8").trimEnd());
}

function codesFor(
  findings: readonly { code: string; store?: string | null }[],
  storePath: string,
): string[] {
  return findings.filter((finding) => finding.store === storePath).map((finding) => finding.code);
}

/** Deterministic wiring deps. Production revalidation is deliberately NOT injected. */
function gateDeps(
  stateDir: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    now: sequenceNow(),
    stateDir,
    hostRevisions: {
      hermesRevision: "hermes:test",
      matchlockRevision: "matchlock:test",
      tamanduaRevision: "tamandua:test",
    },
    ...overrides,
  };
}

/**
 * One wiring scope over a real profile home. The mount plan is the FINAL one
 * the caller would hand the controller (identical-path RW mount), never
 * re-derived here.
 */
function scopeFor(home: string, overrides: Record<string, unknown> = {}): any {
  return {
    kind: "scheduled-dispatch",
    invocationId: DISPATCH_ID,
    runId: RUN_ID,
    roundId: JOB_ID,
    profileHome: home,
    mountPlan: interactiveStoreMountPlan(home),
    configOptions: { managedDir: null, env: {} },
    ...overrides,
  };
}

// ===========================================================================
// 1. a refusal precedes every create
// ===========================================================================

describe("G8 integration 1 — a refusal precedes every create", () => {
  it("refuses before any runtime, controller or create-config exists (hermes interactive path)", async (t) => {
    const home = newProfileHome();
    // One non-compliant store is enough to refuse the whole launch.
    writeWalStore(storePathOf(home, "verification_evidence.db"));
    const stateDir = newStateDir();
    const rpc = scaffoldRpc(t);
    const invocationId = "interactive:hermes:pid:4242:start:2026-02-03T04:05:06.000Z";

    let createConfigCalls = 0;
    let controllerCalls = 0;
    const printed: string[] = [];

    const args = interactiveArgs();
    // The REAL orchestration decides whether the runtime/controller are reached:
    // the plan seam runs the REAL gate (the production caller order) and a
    // refusal throws, so nothing downstream can exist.
    const run = runInteractiveSession(args, {
      plan: async () => {
        evaluateInteractiveLaunchGate(
          selectionFor(home) as never,
          args,
          interactiveGateDeps(stateDir, { invocationId }) as never,
        );
        throw new Error("unreachable: the gate must refuse this store set");
      },
      // The PRODUCTION runtime builder, with the counting create-config seam:
      // on an allow this is the seam a partial mount would have to pass
      // through, so counting it here is a real measurement, not a stub.
      buildRuntime: (plan) =>
        buildInteractiveSessionRuntime(plan, {
          env: {},
          createConfig: () => {
            createConfigCalls += 1;
            throw new Error("unreachable: no create config is built for a refusal");
          },
        }),
      createController: () => {
        controllerCalls += 1;
        return { run: async () => ({ exitCode: 0 }) };
      },
      stdout: (text) => printed.push(text),
      stderr: () => {},
    });

    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof LaunchGateRefusalError, "the gate's own error is thrown unchanged");
      assert.equal(error.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
      assert.equal(error.refusal.kind, "verdict");
      assert.equal(error.refusal.receiptWritten, true);
      return true;
    });

    // ZERO create-config builds, ZERO controllers, ZERO partial mounts: the
    // pre-launch summary (which renders the mount scope) was never printed.
    assert.equal(createConfigCalls, 0, "the create-config builder was never invoked");
    assert.equal(controllerCalls, 0, "no controller was constructed");
    assert.deepEqual(printed, [], "no pre-launch summary: no mount scope was materialised");
    assert.equal(rpc.transcriptExists(), false, "no RPC child was spawned at all");
    assert.equal(rpc.createCount(), 0, "zero create calls");

    // The receipt was written FIRST, for THIS invocation.
    const receiptPath = resolveLaunchGateReceiptPath({ stateDir, invocationId });
    assert.equal(fs.existsSync(receiptPath), true);
    const receipt = readReceiptAt(receiptPath);
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.equal(receipt.invocation.kind, "interactive-hermes");
    assert.ok(receipt.findings.some((finding) => finding.code === "wal-header"));
    assert.equal(receipt.holderDetection.limitation, NO_LEASE_LIMITATION);
  });

  it("an allowed launch reaches the controller and creates EXACTLY once with ONE create-config build", async (t) => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const rpc = scaffoldRpc(t);
    let createConfigCalls = 0;

    // The binding is the REAL gate's verdict for this invocation, so the
    // backstop is satisfied by evidence, never by a fabricated allow.
    const binding = allowedInteractiveBinding(home, stateDir);
    const controller = makeController({
      t,
      rpc,
      configDir: newConfigDir(),
      helperPack: newHelperPack(),
      launchGate: { invocationId: binding.invocationId, binding },
      countCreateConfig: () => {
        createConfigCalls += 1;
      },
    });

    const created = await controller.prepareAndCreate(ADMITTED_IDENTITY as never);
    assert.match(created.vmId, /^vm-/);
    assert.equal(createConfigCalls, 1, "one create-config build");
    assert.equal(rpc.createCount(), 1, "create the VM exactly once");
    assert.deepEqual(rpc.methods(), ["resolve_image", "create"], "the allow adds no extra RPC");
  });
});

// ===========================================================================
// 2. aggregation across stores
// ===========================================================================

describe("G8 integration 2 — aggregation across every discoverable store", () => {
  it("observes every store and keeps every finding (one bad store never short-circuits)", () => {
    const home = newProfileHome();
    const walPath = writeWalStoreAndReturn(storePathOf(home, "verification_evidence.db"));
    const projectsPath = writeWalStoreAndReturn(storePathOf(home, "projects.db"));
    const statePath = storePathOf(home);
    const stateDir = newStateDir();

    const observed: string[] = [];
    const decision = evaluateAndRecordLaunchGate(scopeFor(home), {
      ...gateDeps(stateDir),
      observeStore: (storePath: string) => {
        observed.push(storePath);
        return observeStore(storePath);
      },
    } as never);

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(
      observed.length,
      LAUNCH_GATE_STORE_CONTRACT.entries.length,
      "every contract store was observed, including the absent ones",
    );

    // The compliant store is judged on its OWN evidence…
    assert.deepEqual(codesFor(decision.refusal.findings, statePath), [], "the good store has no finding");
    // …while BOTH bad stores keep their findings (no abort on the first).
    assert.deepEqual(codesFor(decision.refusal.findings, walPath), ["wal-header"]);
    assert.deepEqual(codesFor(decision.refusal.findings, projectsPath), ["wal-header"]);

    const receipt = readReceiptAt(decision.refusal.receiptPath);
    assert.equal(receipt.stores.length, LAUNCH_GATE_STORE_CONTRACT.entries.length);
    const goodStore = receipt.stores.find((store) => store.canonicalPath === statePath);
    assert.ok(goodStore !== undefined);
    assert.equal(goodStore.headerFormat, "rollback");
    assert.deepEqual(goodStore.headerBytes, [1, 1]);
    assert.deepEqual(goodStore.findingCodes, []);
    assert.equal(goodStore.configJournalMode, "delete");
  });

  it("keeps the other stores' findings when one store's observation THROWS", () => {
    const home = newProfileHome();
    const walPath = writeWalStoreAndReturn(storePathOf(home, "verification_evidence.db"));
    const statePath = storePathOf(home);
    const stateDir = newStateDir();

    const observed: string[] = [];
    const decision = evaluateAndRecordLaunchGate(scopeFor(home), {
      ...gateDeps(stateDir),
      observeStore: (storePath: string) => {
        observed.push(storePath);
        if (storePath === statePath) throw new Error("EACCES: permission denied, open the store");
        return observeStore(storePath);
      },
    } as never);

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(observed.length, LAUNCH_GATE_STORE_CONTRACT.entries.length);
    // Cannot-determine is never absence, and never hides the other store.
    assert.ok(codesFor(decision.refusal.findings, statePath).includes("path-unresolved"));
    assert.ok(!codesFor(decision.refusal.findings, statePath).includes("store-missing"));
    assert.deepEqual(codesFor(decision.refusal.findings, walPath), ["wal-header"]);

    const receipt = readReceiptAt(decision.refusal.receiptPath);
    const failedStore = receipt.stores.find((store) =>
      (store.findingCodes as string[]).includes("path-unresolved"),
    );
    assert.ok(failedStore !== undefined, "the failed observation is recorded, not dropped");
    assert.equal(failedStore.readable, "unreadable");
    assert.equal(failedStore.headerFormat, "unreadable");
  });
});

/** Write a byte-exact WAL store and return its path (small readability helper). */
function writeWalStoreAndReturn(file: string): string {
  writeWalStore(file);
  return file;
}

// ===========================================================================
// 3. revalidation by identity between evaluate and create
// ===========================================================================

describe("G8 integration 3 — revalidation catches a store-set change before the create", () => {
  /**
   * Wrap the REAL evaluator and mutate the world the instant its verdict
   * returns: that is exactly the observe -> evaluate -> revalidate window the
   * production revalidation exists to close. The revalidation itself is NOT
   * injected — the production implementation runs.
   */
  function depsMutatingAfterVerdict(stateDir: string, mutate: () => void): Record<string, unknown> {
    let evaluations = 0;
    return {
      ...gateDeps(stateDir),
      evaluateGate: (input: unknown) => {
        const verdict = evaluateGate(input as never);
        evaluations += 1;
        if (evaluations === 1) mutate();
        return verdict;
      },
    };
  }

  it("refuses when a store APPEARS after evaluate (path-list change)", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const appearedPath = storePathOf(home, "projects.db");

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      depsMutatingAfterVerdict(stateDir, () => writeRollbackStore(appearedPath)) as never,
    );

    const refusal = expectOperationalRefusal(decision, /store-set-changed/, /projects\.db/);
    const receipt = readReceiptAt(refusal.receiptPath);
    assert.equal(receipt.verdict, "refuse");
    assert.deepEqual(receipt.findings, [], "no invented reason code: the ten codes stay closed");
    assert.equal(
      receipt.stores.length,
      LAUNCH_GATE_STORE_CONTRACT.entries.length,
      "the receipt keeps the pre-change observation",
    );
  });

  it("refuses when the store INODE is replaced at the same path ((dev, ino) change)", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const statePath = storePathOf(home);

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      depsMutatingAfterVerdict(stateDir, () => {
        // Same canonical path, still a rollback store with a delete config —
        // only the IDENTITY changes. The original is renamed (not deleted) so
        // the replacement is guaranteed a different (dev, ino).
        fs.renameSync(statePath, `${statePath}.old`);
        writeRollbackStore(statePath);
      }) as never,
    );

    const refusal = expectOperationalRefusal(decision, /store-identity-changed/, /state\.db/);
    const receipt = readReceiptAt(refusal.receiptPath);
    assert.deepEqual(receipt.findings, []);
    // The bound identity is the one that was observed, not the replacement.
    const bound = receipt.stores.find((store) => store.canonicalPath === statePath);
    assert.ok(bound !== undefined);
    assert.equal(bound.headerFormat, "rollback");
  });

  it("refuses when the config is edited from delete to wal after evaluate (config change)", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      depsMutatingAfterVerdict(stateDir, () => {
        fs.writeFileSync(path.join(home, "config.yaml"), "database:\n  journal_mode: wal\n");
      }) as never,
    );

    const refusal = expectOperationalRefusal(decision, /config-changed/, /journalMode/);
    const receipt = readReceiptAt(refusal.receiptPath);
    assert.equal(receipt.verdict, "refuse");
    assert.deepEqual(receipt.findings, []);
    // The config recorded is the one the verdict was computed against.
    const bound = receipt.stores.find((store) => store.canonicalPath === storePathOf(home));
    assert.ok(bound !== undefined);
    assert.equal(bound.configJournalMode, "delete");
  });
});

/** Assert a wiring decision is an OPERATIONAL refusal naming the change. */
function expectOperationalRefusal(
  decision: unknown,
  ...patterns: RegExp[]
): { receiptPath: string; detail: string } {
  const typed = decision as
    | { action: "allow" }
    | { action: "refuse"; refusal: { kind: string; detail: string; receiptPath: string; exitCode: number; receiptWritten: boolean; findings: unknown[] } };
  assert.equal(typed.action, "refuse");
  if (typed.action !== "refuse") throw new Error("unreachable");
  assert.equal(typed.refusal.kind, "operational");
  assert.equal(typed.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
  assert.equal(typed.refusal.receiptWritten, true);
  assert.deepEqual(typed.refusal.findings, []);
  for (const pattern of patterns) assert.match(typed.refusal.detail, pattern);
  return { receiptPath: typed.refusal.receiptPath, detail: typed.refusal.detail };
}

// ===========================================================================
// 4. a refused scheduled round does not re-dispatch
// ===========================================================================

describe("G8 integration 4 — a refused scheduled round does not re-dispatch", () => {
  /** The short-HOME alias the round is handed (never created). */
  const alias = path.join(FAKE_ROOT, "h");

  beforeEach(() => {
    setMatchlockHomeAliasResolverForTest(() => alias);
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

  it("takes the blocked-equivalent state (failed / scheduling_status NULL) and a later tick records nothing", async () => {
    const { operatorHome } = newNonCompliantScheduledProfile();
    const stateDir = newStateDir();
    const runnerCalls: unknown[] = [];
    setMatchlockHermesInvocationRunnerForTest(async (opts) => {
      runnerCalls.push(opts);
      throw new Error("unreachable: a refused round must never invoke the hermes runner");
    });

    // The run row the recorder reads / the terminal transition it applies:
    // exactly production's `forceFailRun(runId, reason, true)` shape
    // (`status='failed'`, `scheduling_status=NULL`).
    const row: { status: string; scheduling_status: string | null } = {
      status: "running",
      scheduling_status: "active",
    };
    const events: Array<Record<string, unknown>> = [];
    const forced: string[] = [];

    setMatchlockScheduledLaunchGateForTest({
      // No `evaluate` seam: the PRODUCTION dispatch adapter runs.
      gateDeps: {
        now: sequenceNow(),
        stateDir,
        configOptions: { managedDir: null, env: {} },
        log: () => {},
        readRun: () => ({ ...row }),
        emit: (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
        readEvents: () => events as never,
        forceFail: async (_runId: string, reason: string) => {
          forced.push(reason);
          row.status = "failed";
          row.scheduling_status = null;
          return { ok: true };
        },
      },
    });

    const first = await runMatchlockSchedulerRound(roundFor(hermesPolicy(operatorHome)));

    assert.equal(first.gateRefused, true, "the round is refused, not retried");
    assert.equal(String(first.output), "", "nothing ran");
    assert.equal(runnerCalls.length, 0, "ZERO hermes-runner invocations: no VM, no RPC");

    assert.equal(events.length, 1, "exactly one run.matchlock_gate_refused event");
    const event = events[0];
    assert.equal(event.event, "run.matchlock_gate_refused");
    assert.equal(event.invocationId, DISPATCH_ID, "bound to THIS dispatch invocation");
    assert.equal(event.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.match(String(event.detail), /No VM was created and no step was dispatched/);

    // The state the state machine actually supports for a refusal: the run is
    // terminal. `scheduling_status='error'` is NOT a guard (`reconcileOnce()`
    // re-admits it while the run is running), so a refusal must not use it.
    assert.deepEqual(
      { status: row.status, scheduling_status: row.scheduling_status },
      { status: "failed", scheduling_status: null },
      "the blocked-equivalent is failed / scheduling_status NULL",
    );
    assert.equal(forced.length, 1, "the run was force-failed exactly once");

    // A later tick for the now-terminal run re-evaluates and refuses, but it
    // records nothing and still creates nothing: no 18-round retry loop.
    const second = await runMatchlockSchedulerRound(roundFor(hermesPolicy(operatorHome)));
    assert.equal(second.gateRefused, true);
    assert.equal(events.length, 1, "no second event for an already-terminal run");
    assert.equal(forced.length, 1, "no second force-fail");
    assert.equal(runnerCalls.length, 0, "still zero runner calls across both ticks");
  });
});

// ===========================================================================
// 5. the refusal receipt
// ===========================================================================

describe("G8 integration 5 — the receipt is written first, and a write failure refuses", () => {
  it("writes ONE parseable refused receipt carrying every finding and the no-lease limitation", () => {
    const home = newProfileHome();
    const walPath = writeWalStoreAndReturn(storePathOf(home, "verification_evidence.db"));
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), gateDeps(stateDir) as never);
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(decision.refusal.receiptWritten, true);
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(
      decision.refusal.receiptPath,
      resolveLaunchGateReceiptPath({ stateDir, invocationId: DISPATCH_ID }),
    );

    const receipt = readReceiptAt(decision.refusal.receiptPath);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.action, "refused", "never 'launched' before a VM exists");
    assert.equal(receipt.verdict, "refuse");
    assert.equal(receipt.invocation.kind, "scheduled-dispatch");
    assert.equal(receipt.invocation.runId, RUN_ID);
    assert.equal(receipt.invocation.roundId, JOB_ID);
    assert.match(String(receipt.storeSetKey), /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.findings.length, decision.refusal.findings.length);
    assert.deepEqual(
      receipt.findings.filter((finding) => finding.store === walPath).map((finding) => finding.code),
      ["wal-header"],
    );
    assert.equal(receipt.holderDetection.limitation, NO_LEASE_LIMITATION);
    assert.ok(receipt.inventoryComplete);
  });

  it("a receipt-WRITE FAILURE is itself an operational refusal (exit 78), never an allow", () => {
    const home = newProfileHome();
    const walPath = writeWalStoreAndReturn(storePathOf(home, "verification_evidence.db"));
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), {
      ...gateDeps(stateDir),
      writeRefusalReceipt: () => ({
        ok: false,
        code: "receipt-write-failed",
        path: path.join(stateDir, "unwritable.json"),
        detail: "synthetic receipt write failure",
      }),
    } as never);

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(decision.refusal.kind, "operational", "a machinery failure is never a reason code");
    assert.equal(decision.refusal.receiptWritten, false);
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.match(decision.refusal.detail, /could not be written/);
    assert.match(decision.refusal.detail, /synthetic receipt write failure/);
    // The verdict's findings are preserved even though the receipt is not.
    assert.deepEqual(codesFor(decision.refusal.findings, walPath), ["wal-header"]);
    assert.equal(fs.existsSync(decision.refusal.receiptPath), false);
  });
});

// ===========================================================================
// 6. the controller backstop
// ===========================================================================

describe("G8 integration 6 — the controller backstop is bound to THIS invocation", () => {
  it("refuses a verdict that belongs to a DIFFERENT invocation, with zero RPC calls", async (t) => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const rpc = scaffoldRpc(t);
    let createConfigCalls = 0;

    // A REAL dispatch-time allow for this run/round…
    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home, { invocationId: DISPATCH_ID }),
      gateDeps(stateDir) as never,
    );
    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;

    // …presented to the ATTEMPT invocation: the same run and round, a different
    // resolved invocation. That is the C5 correction, not a lease.
    const controller = makeController({
      t,
      rpc,
      configDir: newConfigDir(),
      helperPack: newHelperPack(),
      launchGate: { invocationId: ATTEMPT_ID, binding: decision.binding },
      countCreateConfig: () => {
        createConfigCalls += 1;
      },
    });

    await assert.rejects(controller.prepareAndCreate(ADMITTED_IDENTITY as never), (error: unknown) => {
      assert.ok(error instanceof MatchlockControllerError);
      assert.equal(error.code, "matchlock_gate_verdict_missing");
      assert.match(error.message, new RegExp(RegExp.escape(ATTEMPT_ID)), "names the required invocation");
      assert.match(
        error.message,
        new RegExp(RegExp.escape(DISPATCH_ID)),
        "names the foreign verdict it found",
      );
      assert.match(error.message, /DIFFERENT invocation/);
      assert.match(error.message, /never re-evaluates/);
      return true;
    });

    assert.equal(createConfigCalls, 0, "the refused create never built a config");
    assert.equal(rpc.transcriptExists(), false, "no RPC child exists at all (not just no create frame)");
    assert.equal(rpc.createCount(), 0);
    assert.equal(controller.rpcRunning, false);
    assert.equal(controller.identity.vmId, null);
  });
});

// ===========================================================================
// 7. the hermes-shell variant
// ===========================================================================

describe("G8 integration 7 — hermes-shell is its own invocation kind", () => {
  it("records 'interactive-hermes-shell' on the allow binding and in the admission anchor", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const invocationId = "interactive:hermes-shell:pid:4242:start:2026-02-03T04:05:06.000Z";

    const decision = evaluateInteractiveLaunchGate(
      selectionFor(home) as never,
      interactiveArgs({ subcommand: "hermes-shell", shell: true }),
      interactiveGateDeps(stateDir, { invocationId }) as never,
    );

    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;
    assert.equal(decision.binding.kind, "interactive-hermes-shell");
    assert.equal(decision.binding.invocationId, invocationId);

    const anchor = JSON.parse(
      fs.readFileSync(resolveInteractiveAdmissionAnchorPath(decision.binding.receiptPath), "utf8"),
    ) as { kind: string; shell: boolean; invocationId: string; image: { digest: string } };
    assert.equal(anchor.kind, "interactive-hermes-shell");
    assert.equal(anchor.shell, true);
    assert.equal(anchor.invocationId, invocationId);
    assert.equal(anchor.image.digest, ADMITTED_IDENTITY.digest, "the admitted image is anchored");
  });

  it("records 'interactive-hermes-shell' in a refusal receipt (distinct from the plain variant)", () => {
    const home = newProfileHome();
    writeWalStore(storePathOf(home, "verification_evidence.db"));
    const stateDir = newStateDir();
    const invocationId = "interactive:hermes-shell:pid:4242:start:2026-02-03T04:05:06.000Z";

    const refusal = captureRefusal(() =>
      evaluateInteractiveLaunchGate(
        selectionFor(home) as never,
        interactiveArgs({ subcommand: "hermes-shell", shell: true }),
        interactiveGateDeps(stateDir, { invocationId }) as never,
      ),
    );

    assert.equal(refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    const receipt = readReceiptAt(refusal.refusal.receiptPath);
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.invocation.kind, "interactive-hermes-shell");
    // The gate receipt schema carries no invocation id field; the id lives in
    // the receipt FILENAME, which must name the variant it was decided for.
    assert.match(
      path.basename(refusal.refusal.receiptPath),
      /hermes-shell/,
      "the receipt slot names the hermes-shell invocation",
    );
    assert.ok(receipt.findings.some((finding) => finding.code === "wal-header"));
  });
});

// ===========================================================================
// 8. native (pi) runs are unregressed
// ===========================================================================

describe("G8 integration 8 — native (pi) runs are unregressed", () => {
  it("an ungated pi controller creates EXACTLY once (no verdict required)", async (t) => {
    const rpc = scaffoldRpc(t);
    let createConfigCalls = 0;

    const controller = makeController({
      t,
      rpc,
      configDir: newConfigDir("pi"),
      helperPack: newHelperPack(),
      harness: "pi",
      // NO launchGate context: the native path is byte-identical.
      countCreateConfig: () => {
        createConfigCalls += 1;
      },
    });

    const created = await controller.prepareAndCreate(ADMITTED_IDENTITY as never);
    assert.match(created.vmId, /^vm-/);
    assert.equal(createConfigCalls, 1);
    assert.equal(rpc.createCount(), 1, "the ungated native path creates exactly once");
    assert.deepEqual(rpc.methods(), ["resolve_image", "create"]);
  });

  it("a pi scheduled policy is never gate-evaluated: null decision, zero observation, no receipt", () => {
    const stateDir = newStateDir();
    const observed: string[] = [];
    const deps = {
      stateDir,
      configOptions: { managedDir: null, env: {} },
      observeStore: (storePath: string) => {
        observed.push(storePath);
        return observeStore(storePath);
      },
    };

    assert.equal(evaluateScheduledDispatchGate(roundFor(piPolicy()), deps as never), null);
    assert.deepEqual(observed, [], "no store was observed for the ungated harness");
    assert.equal(
      fs.existsSync(path.join(stateDir, "matchlock", "gate")),
      false,
      "no receipt directory: the gate never evaluated anything",
    );
  });
});

// ===========================================================================
// lane registration
// ===========================================================================

describe("G8 integration — lane registration", () => {
  it("this file is registered in the serial lane for the classifier's own reason", () => {
    const testFilePath = path.join(HERE, "launch-gate-integration.test.ts");
    const reasons = classifyTestFile(testFilePath, REPO_ROOT);
    assert.ok(
      reasons.length > 0,
      "driving the real MatchlockController makes this file spawn-capable (rpc-client.ts)",
    );
    assert.ok(
      reasons.some((reason) => reason.includes("rpc-client.ts")),
      `the controller's RPC transport must be the classified reason; got ${reasons.join("; ")}`,
    );

    const serialEntries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(
      serialEntries.includes(THIS_FILE_REL),
      `${THIS_FILE_REL} must be listed in tests/serial-files.txt (${reasons.join("; ")})`,
    );
  });

  it("the production backstop is still the code this file exercises", () => {
    const controllerSource = fs.readFileSync(
      path.join(REPO_ROOT, "src/installer/matchlock/controller.ts"),
      "utf8",
    );
    assert.match(
      controllerSource,
      /requireLaunchGateVerdict\(\)/,
      "the controller still guards prepareAndCreate with its launch-gate backstop",
    );
    assert.match(
      controllerSource,
      /matchlock_gate_verdict_missing/,
      "the backstop's typed refusal code is still the one asserted here",
    );
  });
});

/**
 * MTLK-ISO2-TRANSITION-CAS regression battery — deterministic contract tests.
 *
 * Each scenario extracts the ACTUAL production handler (`handleResumeRun` /
 * `resumeWorkflow`) plus (for the capacity arm) the admission helpers from the
 * source via the TypeScript AST, then runs them in a vm sandbox over a REAL
 * in-memory SQLite database with only the external validation / registration
 * dependencies injected. This mirrors the independent #140 acceptance
 * instrument (`accept-iso140.../ops/extended-contract-v2.mjs`).
 *
 * The battery asserts the corrected contract directly, with NO compensator and
 * NO race machinery:
 *   - a competing terminal (`completed` / `canceled`) always survives a refused
 *     resume; a cancellation is never resurrected;
 *   - a refused resume resolves only ITS OWN columns: a foreign writer's
 *     `output`/context/probe/terminal status survives while this request's
 *     status/retry/counters return to their prior values;
 *   - the capacity/admission write can never clobber a concurrent cancellation;
 *   - a step-write fault inside the transition rolls the WHOLE transition back
 *     (no half-transitioned run) and surfaces as an error with no registration;
 *   - a pre-commit CAS conflict performs ZERO writes.
 *
 * A separate section covers the consumer-class fixes: scheduling-error
 * allow-listing, dispatch refusal sanitization, and `isolation_intent`
 * propagation through `resolveRunTarget`.
 *
 * No `node:child_process`: this file belongs to the parallel lane.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const require = createRequire(path.join(REPO, "package.json"));
const ts = require("typescript") as typeof import("typescript");

const policy = await import(path.join(REPO, "dist/installer/matchlock/policy.js"));
const prep = await import(path.join(REPO, "dist/installer/matchlock/prep-state.js"));
const warnings = await import(path.join(REPO, "dist/installer/matchlock/warnings.js"));
const resumePreflight = await import(
  path.join(REPO, "dist/installer/matchlock/resume-preflight.js")
);
const dispatchGuard = await import(
  path.join(REPO, "dist/installer/matchlock/dispatch-guard.js")
);
const schedulingError = await import(
  path.join(REPO, "dist/installer/scheduling-error.js")
);
const runTarget = await import(path.join(REPO, "dist/diagnostics/run-target.js"));

const VALID_POLICY = policy.serializeMatchlockPolicy(
  policy.buildMatchlockPolicy({
    requestedImage: "fixture/image",
    requestedImageSource: "standard",
    identity: {
      digest: "sha256:" + "a".repeat(64),
      config_digest: "sha256:" + "b".repeat(64),
      tag: "fixture/image",
    },
    harness: "pi",
    workingDirectory: "/opt/owned-fixture",
    originalRepositoryRoot: "/opt/owned-fixture",
    workMounts: [
      {
        hostPath: "/opt/owned-fixture",
        hostRealPath: "/opt/owned-fixture",
        guestPath: "/opt/owned-fixture",
      },
    ],
    gitMetadataRoots: [],
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 8192 },
    rootUsageConsent: false,
  }),
);

function extractFunctions(file: string, names: string[]): string {
  const source = fs.readFileSync(path.join(REPO, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const parts: string[] = [];
  for (const name of names) {
    const matches = ast.statements.filter(
      (node): node is import("typescript").FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.equal(matches.length, 1, `${file}:${name} must be declared exactly once`);
    parts.push(matches[0].getText(ast));
  }
  return parts.join("\n");
}

function transpile(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
}

const CONTROL_SOURCE = extractFunctions("src/server/control-server.ts", ["handleResumeRun"]);
const FAILED_SOURCE = extractFunctions("src/installer/run.ts", ["resumeWorkflow"]);
const REGISTRATION_SOURCE = extractFunctions("src/server/control-server.ts", [
  "requiredTimersForRun",
  "admitOrQueueRun",
  "handleRegisterRun",
  "isIntentOnlyHeldRun",
  "holdIntentOnlyRun",
]);
const CONTEXT_SOURCE = extractFunctions("src/installer/step-ops.ts", [
  "parseRunContext",
  "setRunContextKey",
  "removeRunContextKey",
]);

test("no compensation machinery remains in the resume handlers", () => {
  const controlSrc = fs.readFileSync(path.join(REPO, "src/server/control-server.ts"), "utf8");
  const failedSrc = fs.readFileSync(path.join(REPO, "src/installer/run.ts"), "utf8");
  for (const [label, src] of [
    ["control-server.ts", controlSrc],
    ["run.ts", failedSrc],
  ] as const) {
    assert.doesNotMatch(src, /function compensate/, `${label} must not declare a compensator`);
  }
  assert.doesNotMatch(
    CONTROL_SOURCE + FAILED_SOURCE,
    /(compensateControlMatchlockResume|compensateFailedMatchlockResume)\s*\(/,
    "handlers must not call a compensator",
  );
});

interface ScenarioOptions {
  native?: boolean;
  unusable?: boolean;
  root?: boolean;
  noOverride?: boolean;
  preCancel?: boolean;
  lateCancel?: boolean;
  foreign?: boolean;
  partial?: boolean;
  complete?: boolean;
  capacity?: boolean;
  register409?: boolean;
  validation?: boolean;
  consentFault?: boolean;
  stepFault?: boolean;
  actualCapacity?: boolean;
  actualCancel?: boolean;
  /**
   * MTLK-ISO2-SUPERSEDED-RESUME: at A's registration boundary, run the REAL
   * second (control-form) handler to completion so it commits a DISTINCT-token
   * successor transition before A's refusal resolves. A is then refused.
   */
  successor?: boolean;
  /**
   * VARIANT: the successor commits during A's awaited orphan-recovery import,
   * i.e. BEFORE A captures its after-images, so the captured snapshot is
   * contaminated by the successor's commit. Proves the ownership pivot is the
   * request's own minted token, not the captured snapshot.
   */
  successorDuringRecovery?: boolean;
}

interface Snapshot {
  run: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  stories: Array<Record<string, unknown>>;
}

interface Observation {
  before: Snapshot;
  after: Snapshot;
  afterConcurrent: Snapshot | null;
  atRegister: Snapshot | null;
  result: Record<string, unknown>;
  error: { name: string; message: string } | null;
  events: Array<{ event?: string }>;
  /** A's own minted transition token, captured before the successor runs. */
  aToken: string | null;
  /** The real successor handler's return value. */
  successorResult: Record<string, unknown> | null;
  /** The successor's committed state, snapshotted right after it returns. */
  successorCommitted: Snapshot | null;
  /** True once the successor's registration seam was reached. */
  successorRegistrationReached: boolean;
}

async function runScenario(mode: "control" | "failed", options: ScenarioOptions): Promise<Observation> {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE runs(id TEXT PRIMARY KEY,workflow_id TEXT,status TEXT,scheduling_status TEXT,scheduling_requested_at TEXT,scheduling_error TEXT,updated_at TEXT,matchlock_policy TEXT,isolation_intent TEXT,context TEXT,harness_probe_status TEXT,harness_probe_at TEXT);
     CREATE TABLE steps(id TEXT PRIMARY KEY,run_id TEXT,step_id TEXT,step_index INTEGER,agent_id TEXT,status TEXT,retry_count INTEGER,output TEXT,updated_at TEXT);
     CREATE TABLE stories(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,retry_count INTEGER,output TEXT,resume_reset_count INTEGER,updated_at TEXT)`,
  );
  const raw = options.native ? null : options.unusable ? "" : VALID_POLICY;
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "fixture",
    "do-now",
    mode === "control" ? "paused" : "failed",
    mode === "control" ? "paused" : "error",
    "before-time",
    "before-error",
    "fixture-time",
    raw,
    options.native ? null : "true",
    JSON.stringify({ pause_drain: "true", workdir_collision_policy: "queue", keep: "original" }),
    "failed",
    "probe-time",
  );
  db.prepare("INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?)").run(
    "step",
    "fixture",
    "work",
    0,
    "doer",
    mode === "control" ? "waiting" : "failed",
    2,
    "old-output",
    "fixture-time",
  );
  db.prepare("INSERT INTO stories VALUES (?,?,?,?,?,?,?)").run(
    "story",
    "fixture",
    "failed",
    2,
    "old-story",
    3,
    "fixture-time",
  );

  const row = (): Record<string, unknown> =>
    db.prepare("SELECT * FROM runs").get() as Record<string, unknown>;
  const snapshot = (): Snapshot => ({
    run: row(),
    steps: db.prepare("SELECT * FROM steps ORDER BY id").all() as Array<Record<string, unknown>>,
    stories: db.prepare("SELECT * FROM stories ORDER BY id").all() as Array<Record<string, unknown>>,
  });

  db.exec("ALTER TABLE runs ADD COLUMN created_at TEXT DEFAULT 'fixture-time'");
  if (options.actualCapacity) {
    const ctx0 = JSON.parse(String(row().context)) as Record<string, unknown>;
    delete ctx0.pause_drain;
    db.prepare("UPDATE runs SET context=?").run(JSON.stringify(ctx0));
    db.exec(
      "INSERT INTO steps SELECT 'step2',run_id,'work2',1,'doer2',status,retry_count,output,updated_at FROM steps WHERE id='step'",
    );
  }
  if (options.stepFault) {
    db.exec(
      "CREATE TRIGGER step_refusal BEFORE UPDATE OF status ON steps BEGIN SELECT RAISE(FAIL,'owned-step-write-failure'); END",
    );
  }
  if (options.consentFault) {
    db.exec(
      "CREATE TRIGGER refusal BEFORE UPDATE OF matchlock_policy ON runs WHEN NEW.matchlock_policy IS NOT OLD.matchlock_policy BEGIN SELECT RAISE(FAIL,'owned-policy-write-failure'); END",
    );
  }
  if (options.successorDuringRecovery) {
    // A's awaited orphan-recovery seam only runs when a running step exists.
    db.prepare("UPDATE steps SET status='running' WHERE id='step'").run();
  }

  // Controlled clock: every `new Date()` advances so A and B mint DISTINCT
  // transition tokens deterministically, with no timing-sensitive sleeps.
  let clockMs = Date.parse("2026-10-04T00:00:00.000Z");
  class TestDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(clockMs);
        clockMs += 25;
      } else {
        super(...(args as []));
      }
    }
    static now(): number {
      const value = clockMs;
      clockMs += 25;
      return value;
    }
  }

  const before = snapshot();
  const journal: Array<{ stage: string }> = [];
  const events: Array<{ event?: string }> = [];
  let atRegister: Snapshot | null = null;
  let afterConcurrent: Snapshot | null = null;
  let expectedException = false;
  // MTLK-ISO2-SUPERSEDED-RESUME successor-arm state.
  let successorRunner: (() => Promise<unknown>) | null = null;
  let successorResult: Record<string, unknown> | null = null;
  let successorCommitted: Snapshot | null = null;
  let successorRegistrationReached = false;
  let successorInjected = false;
  let aToken: string | null = null;
  let registrationCount = 0;
  // Bound after the sandbox context runs the extracted admission helpers.
  let activeActualReg:
    | ((id: string) => Promise<{ status: number; body: Record<string, unknown> }>)
    | null = null;

  const checkpoint = (stage: string): void => {
    journal.push({ stage });
    assert.equal(db.isTransaction, false, "no transaction across awaited external work");
  };
  const cancel = (): void => {
    db.exec("UPDATE runs SET status='canceled',scheduling_status=NULL WHERE id='fixture'");
  };
  const validate = async (): Promise<Record<string, unknown>> => {
    checkpoint("validate");
    if (
      options.preCancel ||
      (options.actualCancel && journal.filter((j) => j.stage === "validate").length > 1)
    ) {
      cancel();
      afterConcurrent = snapshot();
    }
    if (options.validation) throw new Error("owned validation refusal");
    return {
      workingDirectoryForHarness: "/opt/owned-fixture",
      context: JSON.parse(String(row().context)),
      harness: "pi",
    };
  };
  const register = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    checkpoint("register");
    registrationCount += 1;
    // Capture A's boundary snapshot once; the successor's own registration must
    // not overwrite it.
    if (!atRegister) atRegister = snapshot();
    if (options.successor) {
      if (registrationCount === 1) {
        // A is parked at its registration boundary: A has already committed
        // running/pending_register with its own token. Run the REAL second
        // (control-form) handler to completion so B commits a DISTINCT-token
        // successor transition, then refuse A.
        aToken = String(atRegister.run.scheduling_requested_at);
        assert.ok(successorRunner, "successor arm requires a bound successor runner");
        successorResult = (await successorRunner()) as Record<string, unknown>;
        successorCommitted = snapshot();
        return {
          status: 409,
          body: {
            state: "refused",
            error: "owned registration refusal",
            message: "owned registration refusal",
          },
        };
      }
      if (registrationCount === 2) {
        successorRegistrationReached = true;
        return { status: 200, body: { state: "active" } };
      }
    }
    if (options.successorDuringRecovery) {
      // In this variant B registers first, during A's awaited orphan-recovery
      // import; A's own registration is the second call and is refused.
      if (registrationCount === 1) {
        successorRegistrationReached = true;
        return { status: 200, body: { state: "active" } };
      }
      if (registrationCount === 2) {
        return {
          status: 409,
          body: {
            state: "refused",
            error: "owned registration refusal",
            message: "owned registration refusal",
          },
        };
      }
    }
    if (options.actualCapacity) {
      assert.ok(activeActualReg, "actual capacity arm requires the injected registrar");
      return await activeActualReg("fixture");
    }
    if (options.partial) {
      const context = JSON.parse(String(row().context)) as Record<string, unknown>;
      context.foreign = "concurrent-writer";
      db.prepare("UPDATE runs SET context=?").run(JSON.stringify(context));
      db.exec(
        "UPDATE steps SET output='foreign-output';UPDATE stories SET output='foreign-story';UPDATE runs SET harness_probe_status='ok',harness_probe_at='foreign-probe'",
      );
      afterConcurrent = snapshot();
    }
    if (options.complete) {
      db.exec("UPDATE runs SET status='completed',scheduling_status=NULL");
      afterConcurrent = snapshot();
    }
    if (options.lateCancel) {
      cancel();
      afterConcurrent = snapshot();
    }
    if (options.foreign) {
      const context = JSON.parse(String(row().context)) as Record<string, unknown>;
      context.foreign = "concurrent-writer";
      db.prepare("UPDATE runs SET context=?").run(JSON.stringify(context));
      db.exec("UPDATE steps SET status='done',output='foreign-output'");
      afterConcurrent = snapshot();
    }
    if (options.capacity) {
      db.exec(
        "UPDATE runs SET status='failed',scheduling_status=NULL,scheduling_error='capacity refusal'",
      );
      afterConcurrent = snapshot();
    }
    const refused = Boolean(
      options.register409 || options.lateCancel || options.foreign || options.partial || options.complete,
    );
    return {
      status: refused ? 409 : options.capacity ? 422 : 200,
      body: refused
        ? { state: "refused", error: "owned registration refusal", message: "owned registration refusal" }
        : options.capacity
          ? { error: "capacity refusal" }
          : { state: "active" },
    };
  };

  const mods: Record<string, unknown> = {
    "../installer/agent-scheduler.js": {
      _scheduledJobCount: () => 0,
      _scheduledJobCountForRun: () => 0,
      _runIdForScheduledHarnessWorkdir: () => null,
      removeRunCrons: async () => {},
      setupAgentCrons: async () => {
        throw new Error("instrument-unexpected-schedule");
      },
    },
    "../installer/workflow-spec.js": { loadWorkflowSpec: async () => ({ id: "do-now", agents: [{ id: "doer" }] }) },
    "../installer/paths.js": { resolveWorkflowDir: () => "/owned/workflow" },
    "../installer/step-ops.js": {
      // Orphan recovery resets the running step exactly like production.
      recoverOrphanedStepsForAgent: (_agentId: string, rid: string) => {
        db.prepare(
          "UPDATE steps SET status='pending' WHERE run_id = ? AND status='running'",
        ).run(rid);
      },
    },
  };
  const sandbox: Record<string, unknown> = {
    exports: {},
    Date: TestDate,
    Error,
    Number,
    String,
    JSON,
    Set,
    SQL_NOW_ISO: "'fixture-time'",
    ...policy,
    ...prep,
    ...warnings,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getDb: () => db,
    getRun: () => row(),
    isTerminal: (s: string) => ["completed", "failed", "canceled"].includes(s),
    ok: (body: Record<string, unknown>, status = 200) => ({ status, body }),
    notFound: (e: string) => ({ status: 404, body: { error: e } }),
    conflict: (e: string) => ({ status: 409, body: { error: e } }),
    unprocessable: (e: string) => ({ status: 422, body: { error: e } }),
    currentDaemonEffectiveUid: () => (options.root ? 0 : 1000),
    defaultResumeEffectiveUid: () => (options.root ? 0 : 1000),
    matchlockRootUsageRefusalText: () => "root usage refused",
    MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG:
      "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs",
    emitEvent: (e: { event?: string }) => events.push(e),
    validateRunHarnessForScheduling: validate,
    handleRegisterRun: register,
    registerRunWithDaemon: register,
    ensureDaemonControlAvailable: async () => checkpoint("ensure-daemon"),
    assertDaemonPrepStateCapability: async () => checkpoint("capability"),
    runMatchlockResumePreflight: resumePreflight.runMatchlockResumePreflight,
    resumeInheritedImageVerifierForTest: async () => checkpoint("pin"),
    resumeMatchlockPreflightSeamsForTest: {
      swapSupportProbe: async (binaryPath: string) => ({ supported: true, binaryPath }),
      verifyInheritedImage: async () => checkpoint("pin"),
    },
    WORKDIR_COLLISION_POLICY_KEY: "workdir_collision_policy",
    WORKDIR_REFUSAL_STATE: "refused",
    parseWorkdirCollisionHolder: () => undefined,
    resetFailedHarnessProbeForResume: () =>
      db.exec(
        "UPDATE runs SET harness_probe_status=NULL,harness_probe_at=NULL WHERE harness_probe_status='failed'",
      ),
    resetFailedStoriesForResume: () => {
      const res = db
        .prepare(
          "UPDATE stories SET status='pending',retry_count=0,resume_reset_count=resume_reset_count+1 WHERE status='failed'",
        )
        .run();
      return { resetCount: Number(res.changes) };
    },
    advancePipeline: () => db.exec("UPDATE steps SET status='pending' WHERE status='waiting'"),
    scheduleRunCronTeardown: () => {},
    nudgeWithDaemon: async () => {},
    runsMidTeardown: new Set(),
    getMaxActiveTimers: () => 1,
    resolveWorkdirCollisionPolicy: () => "refuse",
    markActiveAfterAdmission: () => {},
    process: { env: {} },
    require: (n: string) => {
      assert.ok(mods[n], `instrument-unknown-dep:${n}`);
      if (
        n === "../installer/step-ops.js"
        && options.successorDuringRecovery
        && !successorInjected
      ) {
        // VARIANT: A suspends at `await import("../installer/step-ops.js")`; the
        // promise returned here resolves only after the REAL successor handler
        // runs to completion. A's subsequent after-image capture is therefore
        // contaminated by B's committed transition — the minted-token pivot,
        // not the captured snapshot, must keep B's state intact.
        successorInjected = true;
        return (async () => {
          assert.ok(successorRunner, "recovery variant requires a bound successor runner");
          aToken = String(row().scheduling_requested_at);
          successorResult = (await successorRunner()) as Record<string, unknown>;
          successorCommitted = snapshot();
          return mods[n];
        })();
      }
      return mods[n];
    },
  };

  const ctx = vm.createContext(sandbox);
  if (options.actualCapacity) {
    new vm.Script(
      transpile(REGISTRATION_SOURCE + "\nglobalThis.actualReg=handleRegisterRun"),
    ).runInContext(ctx);
    activeActualReg = (ctx as {
      actualReg: (id: string) => Promise<{ status: number; body: Record<string, unknown> }>;
    }).actualReg;
    sandbox.handleRegisterRun = register;
  }
  const handlerCode =
    CONTEXT_SOURCE +
    "\n" +
    CONTROL_SOURCE +
    "\n" +
    FAILED_SOURCE +
    "\nglobalThis.handlerControl=handleResumeRun;globalThis.handlerFailed=resumeWorkflow;";
  new vm.Script(transpile(handlerCode)).runInContext(ctx);

  const handlerControl = (
    ctx as { handlerControl: (...args: unknown[]) => Promise<unknown> }
  ).handlerControl;
  const handlerFailed = (
    ctx as { handlerFailed: (...args: unknown[]) => Promise<unknown> }
  ).handlerFailed;
  if (options.successor || options.successorDuringRecovery) {
    // The successor is the control-form entry in both arms: the same-form case
    // for a control A, and the demonstrated mixed case for a failed A.
    successorRunner = () => handlerControl("fixture", "successor", true);
  }

  let result: Record<string, unknown> = {};
  let error: Observation["error"] = null;
  try {
    if (mode === "control") {
      result = (await handlerControl("fixture", "coordinator", !options.noOverride)) as Record<string, unknown>;
    } else {
      result = (await handlerFailed("fixture", {
        matchlockRootUsageOverride: !options.noOverride,
        effectiveUid: () => (options.root ? 0 : 1000),
        rpcBinaryPath: "/owned/fake-matchlock",
        matchlockSwapSupportProbe: async (binaryPath: string) => ({ supported: true, binaryPath }),
        matchlockInheritedImageVerifier: async () => checkpoint("pin"),
      })) as Record<string, unknown>;
    }
  } catch (err) {
    const e = err as Error;
    error = { name: e.name, message: e.message };
    expectedException =
      Boolean(options.validation || options.capacity || options.actualCapacity || options.stepFault) &&
      e.name === "Error" &&
      !/not defined/.test(e.message);
  }
  const after = snapshot();
  db.close();
  assert.ok(
    error === null || expectedException,
    `handler threw an unexpected instrument error: ${error?.message}`,
  );
  return {
    before,
    after,
    afterConcurrent,
    atRegister,
    result,
    error,
    events,
    aToken,
    successorResult,
    successorCommitted,
    successorRegistrationReached,
  };
}

function assertRestored(obs: Observation): void {
  for (const key of [
    "status",
    "scheduling_status",
    "scheduling_requested_at",
    "scheduling_error",
    "matchlock_policy",
    "context",
    "harness_probe_status",
    "harness_probe_at",
  ]) {
    assert.deepEqual(obs.after.run[key], obs.before.run[key], `run.${key} must be restored`);
  }
  assert.deepEqual(obs.after.steps, obs.before.steps, "steps must be restored");
  assert.deepEqual(obs.after.stories, obs.before.stories, "stories must be restored");
}

const PINNED_RUN_COLUMNS = [
  "status",
  "scheduling_status",
  "scheduling_requested_at",
  "scheduling_error",
  "matchlock_policy",
  "context",
  "harness_probe_status",
  "harness_probe_at",
] as const;

/**
 * Every stage of the successor interleaving must be DEMONSTRATED — A commits
 * and is observed at its registration boundary; B executes, commits and
 * succeeds; a missing/unexpected stage fails rather than vacuously passing.
 */
function assertSuccessorStages(obs: Observation): void {
  assert.ok(obs.atRegister, "stage: A must be observed at the registration boundary");
  assert.equal(obs.atRegister.run.status, "running", "stage: A committed status=running");
  assert.equal(
    obs.atRegister.run.scheduling_status,
    "pending_register",
    "stage: A committed scheduling_status=pending_register",
  );
  assert.ok(obs.aToken, "stage: A's minted transition token must be captured");
  assert.ok(obs.successorRegistrationReached, "stage: B's registration must be reached");
  assert.ok(obs.successorResult, "stage: B must have returned a result");
  assert.ok(
    obs.successorResult!.status === 200 || obs.successorResult!.status === "resumed",
    `stage: B must have returned success, got ${JSON.stringify(obs.successorResult)}`,
  );
  assert.ok(obs.successorCommitted, "stage: B must have committed a snapshot");
  const bToken = obs.successorCommitted!.run.scheduling_requested_at;
  assert.ok(bToken !== null && bToken !== undefined, "stage: B's token must be non-null");
  assert.notEqual(bToken, obs.aToken, "stage: A and B must hold DISTINCT tokens");
}

/**
 * The successor's committed state must survive A's late-refusal resolution
 * byte-exactly across the full pinned column set (run + touched step/story
 * rows), and A must still return its typed refusal.
 */
function assertSuccessorPreserved(obs: Observation): void {
  assertSuccessorStages(obs);
  const committed = obs.successorCommitted!;
  for (const key of PINNED_RUN_COLUMNS) {
    assert.deepEqual(
      obs.after.run[key],
      committed.run[key],
      `superseded resolution must not touch run.${key}`,
    );
  }
  assert.deepEqual(obs.after.steps, committed.steps, "superseded resolution must not touch steps");
  assert.deepEqual(
    obs.after.stories,
    committed.stories,
    "superseded resolution must not touch stories",
  );
}

test("a competing completed run survives a refused resume (both forms)", async () => {
  for (const mode of ["control", "failed"] as const) {
    const obs = await runScenario(mode, { complete: true });
    assert.equal(obs.after.run.status, "completed", `${mode}: completion must survive`);
    assert.equal(
      obs.after.run.matchlock_policy,
      obs.before.run.matchlock_policy,
      `${mode}: owned consent must be resolved`,
    );
    assert.ok(obs.atRegister, `${mode}: registration must have been reached`);
  }
});

test("a competing cancellation survives a refused resume; other columns resolve (both forms)", async () => {
  for (const mode of ["control", "failed"] as const) {
    const obs = await runScenario(mode, { lateCancel: true });
    assert.equal(obs.after.run.status, "canceled", `${mode}: cancellation must survive`);
    assert.equal(
      obs.after.run.matchlock_policy,
      obs.before.run.matchlock_policy,
      `${mode}: owned consent must be resolved`,
    );
    assert.equal(obs.after.run.context, obs.before.run.context, `${mode}: context must be resolved`);
    assert.equal(
      obs.after.run.harness_probe_status,
      obs.before.run.harness_probe_status,
      `${mode}: probe must be resolved`,
    );
    assert.deepEqual(obs.after.steps, obs.before.steps, `${mode}: steps must be resolved`);
    assert.deepEqual(obs.after.stories, obs.before.stories, `${mode}: stories must be resolved`);
  }
});

test("per-column resolution preserves a foreign writer's output (both forms)", async () => {
  for (const mode of ["control", "failed"] as const) {
    const obs = await runScenario(mode, { partial: true });
    assert.equal(
      JSON.parse(String(obs.after.run.context)).foreign,
      "concurrent-writer",
      `${mode}: foreign context must survive`,
    );
    assert.equal(
      (obs.after.steps[0] as { output: string }).output,
      "foreign-output",
      `${mode}: foreign step output must survive`,
    );
    assert.equal(
      (obs.after.stories[0] as { output: string }).output,
      "foreign-story",
      `${mode}: foreign story output must survive`,
    );
    assert.equal(obs.after.run.harness_probe_status, "ok", `${mode}: foreign probe must survive`);
    assert.equal(
      (obs.after.steps[0] as { status: string }).status,
      (obs.before.steps[0] as { status: string }).status,
      `${mode}: owned step status must be resolved`,
    );
    assert.equal(
      (obs.after.steps[0] as { retry_count: number }).retry_count,
      (obs.before.steps[0] as { retry_count: number }).retry_count,
      `${mode}: owned step retry must be resolved`,
    );
    assert.equal(
      (obs.after.stories[0] as { status: string }).status,
      (obs.before.stories[0] as { status: string }).status,
      `${mode}: owned story status must be resolved`,
    );
    assert.equal(
      (obs.after.stories[0] as { resume_reset_count: number }).resume_reset_count,
      (obs.before.stories[0] as { resume_reset_count: number }).resume_reset_count,
      `${mode}: owned story reset count must be resolved`,
    );
    assert.equal(
      obs.after.run.matchlock_policy,
      obs.before.run.matchlock_policy,
      `${mode}: owned consent must be resolved`,
    );
  }
});

test("a late capacity-state refusal restores the prior state byte-exactly (both forms)", async () => {
  for (const mode of ["control", "failed"] as const) {
    assertRestored(await runScenario(mode, { capacity: true }));
  }
});

test("a plain registration refusal performs zero net writes (both forms)", async () => {
  for (const mode of ["control", "failed"] as const) {
    const obs = await runScenario(mode, { register409: true });
    assertRestored(obs);
    assert.ok(obs.atRegister, `${mode}: registration must have been reached`);
    assert.ok(!obs.events.some((e) => e.event === "run.resumed"), `${mode}: no resumed event`);
  }
});

test("a pre-commit CAS conflict writes nothing and never registers (both forms)", async () => {
  for (const mode of ["control", "failed"] as const) {
    const obs = await runScenario(mode, { preCancel: true });
    assert.equal(obs.after.run.status, "canceled", `${mode}: pre-commit cancellation survives`);
    assert.equal(obs.after.run.context, obs.before.run.context, `${mode}: context must be untouched`);
    assert.deepEqual(obs.after.steps, obs.before.steps, `${mode}: steps must be untouched`);
    assert.equal(obs.atRegister, null, `${mode}: must never register`);
  }
});

test("the capacity write cannot clobber a concurrent cancellation (both forms)", async () => {
  for (const mode of ["control", "failed"] as const) {
    const obs = await runScenario(mode, { actualCapacity: true, actualCancel: true });
    assert.equal(obs.after.run.status, "canceled", `${mode}: cancellation must survive capacity`);
    assert.equal(
      obs.after.run.matchlock_policy,
      obs.before.run.matchlock_policy,
      `${mode}: owned consent must be resolved`,
    );
    assert.equal(obs.after.run.context, obs.before.run.context, `${mode}: context must be resolved`);
    assert.ok(obs.atRegister, `${mode}: registration must be entered`);
  }
});

test("a step-write fault rolls the whole failed-resume transition back", async () => {
  const obs = await runScenario("failed", { stepFault: true });
  assertRestored(obs);
  assert.match(obs.error?.message ?? "", /owned-step-write-failure/, "the specific fault surfaces");
  assert.equal(obs.atRegister, null, "a faulted transition must never register");
});

test("a normal consented resume still transitions, grants and registers (controls)", async () => {
  for (const mode of ["control", "failed"] as const) {
    const obs = await runScenario(mode, {});
    assert.equal(obs.after.run.status, "running", `${mode}: must transition`);
    assert.equal(
      policy.parseMatchlockPolicy(String(obs.after.run.matchlock_policy)).rootUsageConsent,
      true,
      `${mode}: must grant consent`,
    );
    assert.ok(obs.atRegister, `${mode}: must reach registration`);
  }
});

test("a rejected consent write never reports success (control)", async () => {
  const obs = await runScenario("control", { consentFault: true });
  assert.ok(
    !obs.error && obs.result.status !== 200,
    "a rejected consent write must not be a success",
  );
  assert.equal(
    obs.after.run.matchlock_policy,
    obs.before.run.matchlock_policy,
    "the rejected policy write must not land",
  );
});

test("a committed distinct-token successor survives a superseded control resume refusal", async () => {
  // MTLK-ISO2-SUPERSEDED-RESUME: A (control form) commits running /
  // pending_register and parks at registration; B (the REAL second control
  // handler) commits a DISTINCT token and returns 2xx; A's registration then
  // returns 409 and A's resolver must NOT revert B's committed transition.
  const obs = await runScenario("control", { successor: true });
  assertSuccessorPreserved(obs);
  assert.equal(obs.result.status, 409, "A must still return its typed refusal");
  assert.notEqual(obs.after.run.status, "paused", "B's running state must survive");
});

test("a committed distinct-token successor survives a superseded failed-resume refusal (mixed entry)", async () => {
  // The demonstrated mixed case: A is the failed form, B is the control form.
  const obs = await runScenario("failed", { successor: true });
  assertSuccessorPreserved(obs);
  assert.equal(obs.result.status, "refused", "A must still return its typed refusal");
  assert.ok(
    (obs.result.workdirRefused as Record<string, unknown> | undefined)?.message,
    "the typed workdir refusal must be present",
  );
  assert.notEqual(obs.after.run.status, "failed", "B's running state must survive");
});

test("ownership is compared against the minted token, not the contaminated after-image", async () => {
  // VARIANT: B commits DURING A's awaited orphan-recovery import, so A's
  // after-image capture is contaminated by B's successor state. A token-only
  // pivot keyed off the captured snapshot would wrongly restore A's prior
  // lifecycle; the request's own minted token keeps B intact.
  const obs = await runScenario("control", { successorDuringRecovery: true });
  assert.ok(
    obs.successorCommitted,
    "stage: the successor must have committed during A's awaited recovery",
  );
  assert.ok(obs.aToken, "stage: A's minted token must be captured at the recovery seam");
  const bToken = obs.successorCommitted!.run.scheduling_requested_at;
  assert.ok(bToken !== null && bToken !== undefined, "stage: B's token must be non-null");
  assert.notEqual(bToken, obs.aToken, "stage: A and B must hold DISTINCT tokens");
  assert.ok(obs.successorRegistrationReached, "stage: B's registration must be reached");
  assert.equal(obs.successorResult?.status, 200, "stage: B must have returned success");
  const committed = obs.successorCommitted!;
  for (const key of PINNED_RUN_COLUMNS) {
    assert.deepEqual(
      obs.after.run[key],
      committed.run[key],
      `contaminated-after-image variant: run.${key} must survive`,
    );
  }
  assert.deepEqual(obs.after.steps, committed.steps, "variant: steps must survive");
  assert.deepEqual(obs.after.stories, committed.stories, "variant: stories must survive");
  assert.equal(obs.result.status, 409, "A must still return its typed refusal");
});

test("scheduling errors are allow-listed, never echoed raw", () => {
  assert.equal(
    schedulingError.sanitizeSchedulingError(
      "waiting",
      "waiting for harness workdir held by run run-holder01: /opt/owned-fixture/held-dir",
    ),
    "waiting for harness workdir held by run run-holder01: /opt/owned-fixture/held-dir",
  );
  assert.equal(
    schedulingError.sanitizeSchedulingError(
      "error",
      "stored Matchlock policy is present but unusable (policy_unsupported_version); refusing to treat the run as native",
    ),
    "stored Matchlock policy is present but unusable (policy_unsupported_version); refusing to treat the run as native",
    "the producer's typed refusal is allow-listed",
  );
  assert.equal(
    schedulingError.sanitizeSchedulingError(
      undefined,
      "Run requires 3 scheduler timer(s), but TAMANDUA_MAX_ACTIVE_TIMERS is 1.",
    ),
    "Run requires 3 scheduler timer(s), but TAMANDUA_MAX_ACTIVE_TIMERS is 1.",
  );
  assert.equal(
    schedulingError.sanitizeSchedulingError(null, "legacy parser BOUNDARY_SENTINEL"),
    null,
    "unclassified stored text must be dropped",
  );
  assert.equal(
    schedulingError.sanitizeSchedulingError("error", "raw parser BOUNDARY_SENTINEL"),
    null,
    "unclassified stored text must be dropped",
  );
});

test("dispatch refusal classifies the parser error and never leaks raw input", () => {
  const sentinel = "BOUNDARY_SENTINEL";
  const decision = dispatchGuard.matchlockDispatchDecision(
    JSON.stringify({ ...JSON.parse(VALID_POLICY), [sentinel]: "fixture" }),
    { workflowId: "do-now", harnessType: "pi", isolationIntent: true },
  );
  assert.equal(decision.refused, true);
  assert.ok(
    !decision.message.includes(sentinel),
    "the raw parser sentinel must never be surfaced",
  );
  assert.match(decision.message, /policy_/, "the typed policy code must be surfaced");
});

test("resolveRunTarget propagates isolation_intent", () => {
  const row = {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    run_number: 7,
    workflow_id: "do-now",
    status: "failed",
    scheduling_status: "paused",
    scheduling_error: null,
    context: JSON.stringify({ harness_type: "pi" }),
    created_at: "2026-09-22T00:00:00.000Z",
    updated_at: "2026-09-22T01:00:00.000Z",
    matchlock_policy: null,
    isolation_intent: "true",
  };
  const db = {
    prepare(sql: string) {
      return {
        get(...params: (string | number | null)[]) {
          if (/FROM runs WHERE id = \?/.test(sql)) {
            return params[0] === row.id ? row : undefined;
          }
          if (/FROM run_worktrees WHERE run_id = \?/.test(sql)) return undefined;
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all() {
          return [];
        },
      };
    },
  };
  const target = runTarget.resolveRunTarget(row.id, db as never);
  assert.equal(target.isolationIntent, "true");
  assert.equal(target.row.isolation_intent, "true");
});

/**
 * legacy-prep-state-exclusion.test.ts — MTLK-ISO2-MEND (Family D) older-binary
 * behavioral demonstration.
 *
 * The acceptance protocol §6.1(a) requires the ACTUAL pre-PREP-STATE reader —
 * not a copied predicate and not a hand-written `WHERE` — to be executed
 * against an intent-only row and shown not to admit it. This test extracts the
 * EXACT handler bodies (`handleRegisterRun`, `handleNudge`, `reconcileOnce` and
 * their transitive helpers) from the immutable pre-PREP source
 * `9f167705250e6c4b453ea4e42caaaddae703530d` with the TypeScript AST,
 * transpiles them, and runs them in a `vm` sandbox over a REAL in-memory
 * SQLite database with only the external scheduling/workflow dependencies
 * injected. Provenance is pinned by SHA-256 below.
 *
 * Arms (assertions named per the task §2a):
 *   - native-control          : a native row is still admitted normally (positive).
 *   - held-register           : the current D-marker intent-only row is NOT admitted.
 *   - held-nudge              : the legacy nudge loop does NOT admit it.
 *   - drifted-reconcile       : a marker row drifted to scheduling_status='error'
 *                               is NOT activated by the legacy reconciler.
 *   - untouched-preparing-... : a plain, untouched 'preparing' hold is not
 *                               selected by the legacy reconciler (positive control).
 *
 * Every intent-only arm asserts the row never reaches scheduling_status
 * 'active' and no scheduler work is set up. On the BASE tree (no D-marker) the
 * held arms go RED: the exact legacy handlers admit the `preparing` row.
 *
 * The legacy source is vendored as a checked-in, hash-pinned fixture
 * (tests/fixtures/mtlk-iso2-mend/control-server-9f167705.fixture) so the test
 * carries no dependency on repository git topology and runs on a fresh clone.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const require = createRequire(path.join(REPO, "package.json"));
const ts = require("typescript") as typeof import("typescript");

// The current tree's marker writer (used to build the row the CANDIDATE
// persists). On the base it returns the plain `preparing` hold + no context
// seed, which is exactly what the red proof exercises.
const prep = (await import(
  path.join(REPO, "dist/installer/matchlock/prep-state.js")
)) as {
  initialRunIsolationState: (
    optedIn: boolean,
    now: string,
  ) => { schedulingStatus: string; contextSeed?: Record<string, string> };
  ISOLATION_INTENT_RECORDED: string;
};

// ── Provenance: the immutable pre-PREP handler source ───────────────────────
// The vendored fixture below holds the byte-exact contents of
// `9f167705250e6c4b453ea4e42caaaddae703530d:src/server/control-server.ts`; the
// commit/file constants are retained as documentation identifiers only.
const LEGACY_COMMIT = "9f167705250e6c4b453ea4e42caaaddae703530d";
const LEGACY_FILE = "src/server/control-server.ts";
const LEGACY_FIXTURE = path.join(
  REPO,
  "tests",
  "fixtures",
  "mtlk-iso2-mend",
  "control-server-9f167705.fixture",
);
/** SHA-256 of the vendored fixture (the full legacy source). */
const LEGACY_SOURCE_SHA256 =
  "efb00081060e759dfa297eca40e21d14fd7bf9a7565faeca716c2621e63d7800";
/** SHA-256 of the concatenated extracted function bodies. */
const LEGACY_BODY_SHA256 =
  "1e5774efc3e5487ab93ddf75a5cf4d1243e7f405cf7c17de2b1ca3add9a880d3";
const LEGACY_FN_NAMES = [
  "ok",
  "notFound",
  "conflict",
  "unprocessable",
  "getRun",
  "isTerminal",
  "requiredTimersForRun",
  "admitOrQueueRun",
  "handleRegisterRun",
  "handleNudge",
  "reconcileOnce",
] as const;

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const legacySource = fs.readFileSync(LEGACY_FIXTURE, "utf8");
assert.equal(
  sha256(legacySource),
  LEGACY_SOURCE_SHA256,
  `provenance: ${LEGACY_COMMIT}:${LEGACY_FILE} (vendored fixture) must hash to the pinned source digest`,
);

const legacyAst = ts.createSourceFile(LEGACY_FILE, legacySource, ts.ScriptTarget.Latest, true);
const legacyBodies: string[] = [];
for (const name of LEGACY_FN_NAMES) {
  const fn = legacyAst.statements.find(
    (node): node is import("typescript").FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(fn, `the legacy source must declare ${name}`);
  legacyBodies.push(fn.getText(legacyAst));
}
const legacyCode = legacyBodies.join("\n");
assert.equal(
  sha256(legacyCode),
  LEGACY_BODY_SHA256,
  "provenance: the extracted legacy handler bodies must hash to the pinned body digest",
);
const legacyJs = ts.transpileModule(legacyCode, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;

type Arm =
  | "native-control"
  | "held-register"
  | "held-nudge"
  | "drifted-reconcile"
  | "untouched-preparing-control";

interface ArmResult {
  after: Record<string, unknown>;
  response: { status: number; body: Record<string, unknown> } | undefined;
  error: string | undefined;
  scheduled: number;
  loggerErrors: unknown[];
}

/**
 * Run ONE arm against the EXACT legacy handlers over real in-memory SQLite.
 * Only external scheduling / workflow dependencies are injected; no daemon,
 * VM, model or product process is launched.
 */
async function runLegacyArm(arm: Arm): Promise<ArmResult> {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE runs(id TEXT, workflow_id TEXT, status TEXT, scheduling_status TEXT, context TEXT,
       created_at TEXT, matchlock_policy TEXT, isolation_intent TEXT, scheduling_requested_at TEXT,
       scheduling_error TEXT, updated_at TEXT);
     CREATE TABLE steps(id TEXT, run_id TEXT, agent_id TEXT, status TEXT)`,
  );

  const now = "2026-01-01T00:00:00.000Z";
  const held = prep.initialRunIsolationState(true, now);
  // The candidate seeds the legacy-honored pause_drain hold; a base tree has no
  // seed (undefined) — deliberately NOT defaulted so the red proof is honest.
  const heldContext = JSON.stringify(held.contextSeed ?? {});
  const intent = prep.ISOLATION_INTENT_RECORDED;

  const rows: Record<Arm, [string | null, string, string | null]> = {
    "native-control": [null, "{}", null],
    "held-register": [held.schedulingStatus, heldContext, intent],
    "held-nudge": [held.schedulingStatus, heldContext, intent],
    "drifted-reconcile": ["error", heldContext, intent],
    "untouched-preparing-control": ["preparing", "{}", intent],
  };
  const [schedulingStatus, rowContext, isolationIntent] = rows[arm];
  db.prepare(
    `INSERT INTO runs (id, workflow_id, status, scheduling_status, context, created_at,
       matchlock_policy, isolation_intent, scheduling_requested_at, scheduling_error, updated_at)
     VALUES ('fixture', 'do-now', 'running', ?, ?, ?, NULL, ?, NULL, NULL, ?)`,
  ).run(schedulingStatus, rowContext, now, isolationIntent, now);

  const calls: Array<Record<string, unknown> | string> = [];
  const loggerErrors: unknown[] = [];
  let scheduled = 0;
  const row = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(db.prepare("SELECT * FROM runs").get()));

  const scheduler = {
    _scheduledJobCount: () => scheduled,
    _scheduledJobCountForRun: () => scheduled,
    _runIdForScheduledHarnessWorkdir: () => null,
    _hasRunScheduled: () => scheduled > 0,
    _scheduledRunIds: () => (scheduled ? ["fixture"] : []),
    getRunTeardownGraceMs: () => 0,
    removeRunCrons: async () => {
      scheduled = 0;
    },
    setupAgentCrons: async () => {
      calls.push("setupAgentCrons");
      scheduled = 1;
    },
    nudgeScheduledRuns: async (ids: string[]) => {
      calls.push({ nudged: ids });
      return { jobs: [], errors: [], launched: 0, skippedInFlight: 0 };
    },
  };
  const modules: Record<string, unknown> = {
    "../installer/agent-scheduler.js": scheduler,
    "../installer/workflow-spec.js": {
      loadWorkflowSpec: async () => ({ id: "do-now", agents: [{ id: "doer" }] }),
    },
    "../installer/paths.js": { resolveWorkflowDir: () => "/owned/workflow" },
    "../installer/run-recovery.js": { recoverStaleLaunchPhantoms: () => ({ recovered: 0 }) },
    "../installer/step-ops.js": { recoverStepsWithDeadWorkers: () => ({ recovered: 0, failed: 0 }) },
    "../db.js": { pruneOldSuiteResults: () => 0 },
  };

  const sandbox: Record<string, unknown> = {
    exports: {},
    require: (name: string) => {
      assert.ok(modules[name], `unexpected injected dependency ${name}`);
      return modules[name];
    },
    Date,
    Error,
    Number,
    String,
    JSON,
    Map,
    Set,
    process: { env: {} },
    ...prep,
    SQL_NOW_ISO: "'fixture-time'",
    getDb: () => db,
    logger: {
      info() {},
      debug() {},
      warn: (...args: unknown[]) => loggerErrors.push(args),
      error: (...args: unknown[]) => loggerErrors.push(args),
    },
    runsMidTeardown: new Set<string>(),
    getMaxActiveTimers: () => 50,
    parseRunContext: (_id: string, raw: string) => JSON.parse(raw),
    resolveWorkdirCollisionPolicy: () => "refuse",
    validateRunHarnessForScheduling: async () => ({
      workingDirectoryForHarness: "/owned/workdir",
    }),
    markActiveAfterAdmission() {},
    emitEvent: (event: unknown) => calls.push({ event }),
    admitQueuedRuns: async () => {},
  };
  const vmContext = vm.createContext(sandbox) as unknown as Record<
    string,
    () => Promise<{ status: number; body: Record<string, unknown> }>
  >;
  new vm.Script(
    `${legacyJs}\nglobalThis.__reg = handleRegisterRun;\nglobalThis.__nudge = handleNudge;\nglobalThis.__reconcile = reconcileOnce;`,
  ).runInContext(vmContext as vm.Context);

  let response: { status: number; body: Record<string, unknown> } | undefined;
  let error: string | undefined;
  try {
    if (arm === "held-nudge") response = await vmContext.__nudge();
    else if (arm === "drifted-reconcile" || arm === "untouched-preparing-control")
      response = await vmContext.__reconcile();
    else response = await vmContext.__reg("fixture");
  } catch (err) {
    error = String(err);
  }
  const after = row();
  db.close();
  return { after, response, error, scheduled, loggerErrors };
}

/** Assert the legacy run neither threw nor swallowed a dependency failure. */
function assertClean(result: ArmResult): void {
  assert.equal(result.error, undefined, `the legacy handler threw: ${result.error}`);
  assert.equal(
    result.loggerErrors.length,
    0,
    `no swallowed dependency errors: ${JSON.stringify(result.loggerErrors)}`,
  );
}

describe("MTLK-ISO2-MEND Family D: exact pre-PREP handlers vs the intent-only row", () => {
  it("provenance: the legacy source and extracted bodies hash to the pinned digests", () => {
    assert.equal(sha256(legacySource), LEGACY_SOURCE_SHA256);
    assert.equal(sha256(legacyCode), LEGACY_BODY_SHA256);
  });

  it("a legacy native control row still admits normally through explicit registration", async () => {
    const result = await runLegacyArm("native-control");
    assertClean(result);
    assert.equal(result.after.scheduling_status, "active", "the native row is admitted");
    assert.equal(result.scheduled, 1, "the native row gets scheduler work");
  });

  it("legacy explicit registration does NOT activate the intent-only row", async () => {
    const result = await runLegacyArm("held-register");
    assertClean(result);
    assert.notEqual(result.after.scheduling_status, "active", "intent-only row must not be admitted");
    assert.equal(result.scheduled, 0, "no scheduler setup for the intent-only row");
  });

  it("legacy nudge does NOT activate the intent-only row", async () => {
    const result = await runLegacyArm("held-nudge");
    assertClean(result);
    assert.notEqual(result.after.scheduling_status, "active", "intent-only row must not be admitted");
    assert.equal(result.scheduled, 0, "no scheduler setup for the intent-only row");
  });

  it("legacy reconcile-after-hold-drift does NOT activate the intent-only row", async () => {
    const result = await runLegacyArm("drifted-reconcile");
    assertClean(result);
    assert.notEqual(result.after.scheduling_status, "active", "drifted intent-only row must not be admitted");
    assert.equal(result.scheduled, 0, "no scheduler setup for the drifted intent-only row");
  });

  it("untouched-preparing positive control: legacy reconcile leaves it held, never activates it", async () => {
    const result = await runLegacyArm("untouched-preparing-control");
    assertClean(result);
    assert.equal(
      result.after.scheduling_status,
      "preparing",
      "the untouched preparing row stays held",
    );
    assert.equal(result.scheduled, 0, "no scheduler setup for the untouched preparing row");
  });
});

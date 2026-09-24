// Tier-2 STORM-REAL calibration gate (in-process; no daemon/harness spawn).
//
// STORM-REAL staged authority — DO/DO-AGAIN phase: the REAL adapters and the
// rehearsal boundary are BUILT here and their effect-free / containment /
// identity semantics are CALIBRATED in-process against REAL fresh SQLite
// files and REAL trivial node children. The full single-daemon scripted
// rehearsal + real chaos require the coordinator safety approval and run in a
// later phase; this file never starts a daemon, never launches a workflow,
// never writes outside owned temp fixtures + the gitignored torture-test/var,
// and never performs filesystem disposal of retained artifacts.
//
// Reviewer feedback (round 2) addressed here:
//   A CRITICAL — parent TAMANDUA authority vars are stripped at the REAL
//     spawn boundary (spawnCapture merge) and a REAL-child calibration proves
//     the child's process.env carries none of them (R6b/R6c);
//   B HIGH — the approve path now enforces gate-hash pinning through the same
//     strict validator as rehearse (R11 CLI negative + R10 pure matrix);
//   C HIGH — the pre-gate 19:40:14Z launch attempt is disclosed in
//     torture-test/cases/tier2-traceability.md, not fabricated away;
//   D MEDIUM — owned exec roots are ALLOCATED at context construction and
//     dev/ino captured then; receipts persist in state and are revalidated
//     (R2/R3/R12);
//   E MEDIUM — every Round B phase marker has an evidence-specific real
//     predicate with per-marker calibration (R8);
//   F MEDIUM — the real MCP streamable-HTTP success path is validated only in
//     the approved rehearsal against the real daemon; refusal paths stay
//     calibrated here (R7);
//   G LOW — engine wait loop keeps evidence_error (UNKNOWN) distinct from
//     not_yet (R13) and the launch-failure save bumps updated_at (R14).
//   Root defect #4 — cleanup accepts only explicit { evidenced:true } results
//     (undefined/{}/ok-only results are refused) (R9).

import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  parseRunKey,
  withRunIdentities,
  withRunParentIdentity,
  REAL_CLOCK,
  REAL_DB,
  spawnCapture,
  stripParentAuthorityEnv,
  isProtectedChildEnvKey,
} from "../bin/tt-storm-shared.mjs";
import {
  TT_EXEC_ESCAPE,
  TT_NOT_OWNED,
  TT_UNKNOWN_BINARY,
  TT_UNRESOLVED_BINARY,
  assertModeContained,
  assertOwnershipUnchanged,
  buildPrivateExecContext,
  makeCampaignCleanupHandlers,
  makeRealMcpTool,
  makeRealProc,
  openCanonicalDb,
  ownershipEvidenceFor,
  persistableExecIdentity,
  probePhaseMarkerReal,
  revalidatePersistedExecIdentity,
  resolveAbsoluteBinary,
  runOwnedCleanup,
  verifyCoordinatorApproval,
  FINALIZE_STEP_IDS,
} from "../bin/tt-storm-real.mjs";

const repoRoot = process.cwd();
const VAR_ROOT = path.join(repoRoot, "torture-test", "var");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const TT_CHAOS_BIN = path.join(repoRoot, "torture-test", "bin", "tt-chaos");
const DC_BIN = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const TT_STORM_CLI = path.join(repoRoot, "torture-test", "bin", "tt-storm");

function hexFor(tag) {
  return createHash("sha256").update(String(tag)).digest("hex");
}

export function makeRunId(tag) {
  const h = hexFor(`storm-real-cal:${tag}`).slice(0, 32);
  return `run-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Owned temp fixture dir (created by THIS test, removed in finally).
function ownedTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `storm-real-cal-${label}-`));
}

// Create a REAL sqlite DB (bare-uuid runs rows like src/installer/run.ts) and
// return { file, bare }. Rows/steps follow the product layout used by the
// canonicalizing seam (bare uuid id, nullable parent_run_id, steps with
// step_id + agent_id + status).
function makeRealDb(file, { runs = [], steps = [] } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT, task TEXT,
      status TEXT, scheduling_status TEXT, tokens_spent INTEGER,
      parent_run_id TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT
    );
  `);
  const bare = (tag) => makeRunId(tag).slice(4);
  const insRun = db.prepare("INSERT INTO runs (id, run_number, workflow_id, task, status, scheduling_status, tokens_spent, parent_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of runs) {
    insRun.run(bare(r.tag), r.runNumber ?? 1, r.workflow ?? "feature-dev-merge-worktree", r.task ?? "t", r.status ?? "running", r.schedulingStatus ?? null, r.tokens ?? 0, r.parentRunId ? bare(r.parentRunId) : null, r.createdAt ?? "2026-01-01T00:00:00Z", r.updatedAt ?? "2026-01-01T00:00:00Z");
  }
  const insStep = db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, status) VALUES (?, ?, ?, ?, ?)");
  for (const s of steps) {
    insStep.run(s.id ?? `step-${s.runTag}-${s.stepId}`, bare(s.runTag), s.stepId, s.agentId ?? "agent", s.status);
  }
  db.close();
  return { file, bare };
}

function defaultRuns() {
  return [
    { tag: "S1", workflow: "feature-dev-merge-worktree", status: "running" },
    { tag: "S2", workflow: "do-now", status: "completed", tokens: 10 },
  ];
}

function bState(overrides = {}) {
  const runs = { B1: {}, B2: {}, B3: {}, B4: {}, B5: {} };
  for (const k of Object.keys(runs)) runs[k] = { runId: makeRunId(k) };
  const base = {
    plan: { fixtureIdentity: { cc1File: "docs/cc1.md", cc2File: "src/shared/area.go", colleagueRepo: "/var/fixtures/colleague", originRepo: "/var/fixtures/origin", parkRepo: "/var/fixtures/park" } },
    rounds: { B: { runs, phases: {} } },
  };
  return { ...base, ...overrides, rounds: { ...base.rounds, ...(overrides.rounds ?? {}), B: { ...base.rounds.B, ...(overrides.rounds?.B ?? {}), runs: { ...base.rounds.B.runs, ...(overrides.rounds?.B?.runs ?? {}) }, phases: { ...(overrides.rounds?.B?.phases ?? {}) } } } };
}

function runRowsForB(state, { statuses = {} } = {}) {
  return ["B1", "B2", "B3", "B4", "B5"].map((rid) => ({
    tag: rid,
    workflow: rid === "B3" || rid === "B4" ? "bug-fix-merge-worktree" : "feature-dev-merge-worktree",
    status: statuses[rid] ?? "running",
  }));
}

// Add claimed/running step rows for a round-B target run.
function stepsFor(state, target, stepIds = ["setup"], status = "claimed") {
  return stepIds.map((sid, i) => ({ id: `step-${target}-${sid}`, runTag: target, stepId: sid, agentId: sid, status }));
}

describe("tt-storm REAL adapters — in-process calibration (no daemon/harness spawn)", () => {
  it("R1: run-id canonicalization at the DB boundary against a REAL sqlite file", () => {
    const tmp = ownedTmpDir("sqlite");
    try {
      const { file, bare } = makeRealDb(path.join(tmp, "campaign.db"), {
        runs: defaultRuns(),
        steps: [
          { runTag: "S1", stepId: "setup", status: "claimed" },
          { runTag: "S1", stepId: "implement", status: "running" },
          { runTag: "S2", stepId: "do", status: "waiting" },
        ],
      });

      const pub = parseRunKey(makeRunId("S1"));
      assert.equal(pub.ok, true);
      assert.equal(pub.source, "public");
      assert.equal(pub.bare, bare("S1"));

      const bareKey = parseRunKey(bare("S1"));
      assert.equal(bareKey.ok, true);
      assert.equal(bareKey.source, "bare");

      const step = parseRunKey(`step-${bare("S1")}`);
      assert.equal(step.ok, false);
      assert.match(step.reason, /step id is not a run scope/);

      const junk = parseRunKey("garbage");
      assert.equal(junk.ok, false);
      assert.match(junk.reason, /not a run-<uuid>/);

      const upper = parseRunKey(makeRunId("S1").toUpperCase());
      assert.equal(upper.ok, true, "uuid casing is canonicalized");

      const decorated = withRunIdentities({ id: bare("S1") }, { publicId: makeRunId("S1") });
      assert.equal(decorated.run_id_bare, bare("S1"));
      assert.equal(decorated.run_id_public, makeRunId("S1"));

      const opened = REAL_DB.open(file);
      assert.equal(opened.ok, true);
      const api = opened.api;
      try {
        const byPublic = api.getRun(makeRunId("S1"));
        assert.ok(byPublic, "public key resolves to the stored row");
        assert.equal(byPublic.run_id_bare, bare("S1"));
        assert.equal(byPublic.run_id_public, makeRunId("S1"));
        assert.equal(byPublic.workflow_id, "feature-dev-merge-worktree");
        const unknown = api.getRun(makeRunId("NOPE"));
        assert.equal(unknown, null);
        assert.throws(() => api.getRun("step-abc"), (e) => e.code === "TT_BAD_RUN_SCOPE");
        assert.throws(() => api.getRun("nonsense"), (e) => e.code === "TT_BAD_RUN_SCOPE");
        assert.throws(() => api.activeStepsForRuns([makeRunId("S1"), "junk"]), (e) => e.code === "TT_BAD_RUN_SCOPE");
        const steps = api.activeStepsForRuns([makeRunId("S1")]);
        assert.equal(steps.length, 2, "S1 has two claimed/running steps");
        // activeStepRows: per-step rows + optional step-id narrowing.
        const rows = api.activeStepRows([makeRunId("S1")]);
        assert.equal(rows.length, 2);
        assert.ok(rows.every((r) => r.step_id && r.run_id === bare("S1") && r.run_id_public === makeRunId("S1")));
        const setupRows = api.activeStepRows([makeRunId("S1")], { stepIds: ["setup"] });
        assert.equal(setupRows.length, 1);
        assert.equal(setupRows[0].step_id, "setup");
        assert.throws(() => api.activeStepRows([makeRunId("S1")], { stepIds: [] }), (e) => e.code === "TT_BAD_STEP_FILTER");
        const list = api.listRuns();
        assert.equal(list.length, 2);
        const missing = REAL_DB.open(path.join(tmp, "absent.db"));
        assert.equal(missing.ok, false);
        assert.ok(missing.error);
      } finally {
        api.close();
      }

      const canonical = openCanonicalDb(file);
      assert.equal(canonical.ok, true);
      try {
        const byPublic = canonical.api.getRun(makeRunId("S2"));
        assert.equal(byPublic.run_id_bare, bare("S2"));
        assert.equal(byPublic.status, "completed");
        const rowArms = canonical.api.activeStepRows([makeRunId("S1")], { stepIds: ["implement"] });
        assert.equal(rowArms.length, 1);
        assert.equal(rowArms[0].step_id, "implement");
      } finally {
        canonical.api.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R2: private exec context — ALLOCATED owned roots, explicit-minimum env, authority stripped, protected extraEnv refused", () => {
    const tmp = ownedTmpDir("exec");
    try {
      // Parent env pollution: authority vars + a provider-credential sentinel +
      // a foreign worktree root. The private context must inherit NONE of them.
      const saved = {};
      for (const k of ["TAMANDUA_RUN_ID", "TAMANDUA_WORKER_PID", "TT_STORM_CAL_CRED", "TAMANDUA_WORKTREE_ROOT", "ANTHROPIC_API_KEY"]) {
        saved[k] = process.env[k];
        process.env[k] = `parent-${k}`;
      }
      try {
        const varRoot = path.join(tmp, "var");
        fs.mkdirSync(varRoot, { recursive: true });
        // NOTE (issue D): the owned roots are NOT pre-created — the context
        // must allocate them itself and capture dev/ino at that allocation.
        const ctx = buildPrivateExecContext({
          varRoot,
          binaries: { tamandua: TAMANDUA_BIN, ttChaos: TT_CHAOS_BIN, daemonControl: DC_BIN },
          extraEnv: { TAMANDUA_MAX_ACTIVE_TIMERS: "52", TT_STORM_OWNER: "cal" },
        });
        assert.equal(ctx.schema_version >= 2, true);
        assert.ok(fs.existsSync(ctx.home_root), "private HOME allocated by the context");
        assert.ok(fs.existsSync(ctx.state_root), "private TAMANDUA_STATE_DIR allocated by the context");
        assert.ok(fs.existsSync(ctx.tmp_root), "private TMPDIR allocated by the context");
        assert.equal(ctx.child_env.HOME, ctx.home_root);
        assert.equal(ctx.child_env.TAMANDUA_STATE_DIR, ctx.state_root);
        assert.equal(ctx.child_env.TAMANDUA_DB_PATH, ctx.db_path);
        assert.equal(ctx.child_env.TMPDIR, ctx.tmp_root);
        assert.equal(ctx.child_env.TAMANDUA_TEST_GUARD, "1");
        assert.equal(ctx.child_env.TAMANDUA_MAX_ACTIVE_TIMERS, "52");
        // Authority vars stripped even when present in the PARENT env.
        assert.equal(ctx.child_env.TAMANDUA_RUN_ID, undefined);
        assert.equal(ctx.child_env.TAMANDUA_WORKER_PID, undefined);
        assert.equal(ctx.child_env.TAMANDUA_WORKER_JOB_ID, undefined);
        assert.equal(ctx.child_env.TAMANDUA_STEP_ID, undefined);
        assert.equal(ctx.child_env.TAMANDUA_WORKTREE_ROOT, undefined);
        // Explicit-minimum env (root defect #1): provider credentials never
        // inherited.
        assert.equal(ctx.child_env.TT_STORM_CAL_CRED, undefined);
        assert.equal(ctx.child_env.ANTHROPIC_API_KEY, undefined);
        // PATH allowlisted (children must be able to resolve runtimes).
        assert.equal(typeof ctx.child_env.PATH, "string");
        // extraEnv may not redirect protected keys.
        assert.throws(
          () => buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN }, extraEnv: { HOME: "/evil" } }),
          (e) => e.code === TT_EXEC_ESCAPE,
        );
        assert.throws(
          () => buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN }, extraEnv: { TAMANDUA_RUN_ID: "run-x" } }),
          (e) => e.code === TT_EXEC_ESCAPE,
        );
        assert.equal(ctx.binaries.tamandua, TAMANDUA_BIN);
        // dev/ino ownership captured at ACTUAL allocation (issue D).
        assert.ok(ctx.ownership.home.ino > 0, "home ino captured (allocated by the context)");
        assert.ok(ctx.ownership.home.dev > 0);
        assert.ok(ctx.ownership.state.ino > 0);
        assert.ok(ctx.ownership.tmp.ino > 0);
        assertOwnershipUnchanged(ctx.ownership);
        // A REMOVED owned root is refused (deterministic; rm + inode reuse on
        // tmpfs could make rm+mkdir look unchanged, so we remove only).
        fs.rmSync(ctx.home_root, { recursive: true, force: true });
        assert.throws(() => assertOwnershipUnchanged(ctx.ownership), (e) => e.code === TT_NOT_OWNED);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }

      // Foreign / escaped roots are refused at construction.
      const varRoot2 = path.join(tmp, "var2");
      fs.mkdirSync(varRoot2, { recursive: true });
      const outside = path.join(tmp, "outside");
      fs.mkdirSync(outside, { recursive: true });
      assert.throws(
        () => buildPrivateExecContext({ varRoot: varRoot2, binaries: { tamandua: TAMANDUA_BIN }, homeRoot: outside }),
        (e) => e.code === TT_EXEC_ESCAPE,
      );
      assert.throws(
        () => buildPrivateExecContext({ varRoot: varRoot2, binaries: { tamandua: TAMANDUA_BIN }, dbPath: path.join(outside, "x.db") }),
        (e) => e.code === TT_EXEC_ESCAPE,
      );
      assert.throws(
        () => buildPrivateExecContext({ varRoot: varRoot2, binaries: { tamandua: "relative-tamandua" } }),
        (e) => e.code === TT_UNRESOLVED_BINARY,
      );
      assert.throws(() => resolveAbsoluteBinary([path.join(tmp, "no-such-bin")]), (e) => e.code === TT_UNRESOLVED_BINARY);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R3: assertModeContained — canonical campaign containment (symlink escapes refused) + persisted-receipt revalidation", () => {
    const tmp = ownedTmpDir("contain");
    try {
      const varRoot = path.join(tmp, "var");
      const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
      const results = path.join(varRoot, "results");
      fs.mkdirSync(results, { recursive: true });
      fs.mkdirSync(path.join(results, "camp"), { recursive: true });

      // contained campaign under var is accepted
      const ok = assertModeContained({ mode: "report", execCtx, campaignDir: path.join(results, "camp") });
      assert.equal(ok.ok, true);

      // a campaign dir whose REAL destination is foreign (symlink escape) is
      // refused even though the lexical path is under var (root defect #3).
      const outside = path.join(tmp, "outside");
      fs.mkdirSync(outside, { recursive: true });
      const linkDir = path.join(results, "sneaky-camp");
      fs.mkdirSync(path.join(outside, "real-camp"), { recursive: true });
      fs.symlinkSync(path.join(outside, "real-camp"), linkDir, "dir");
      assert.throws(
        () => assertModeContained({ mode: "run", execCtx, campaignDir: linkDir }),
        (e) => e.code === TT_EXEC_ESCAPE,
      );

      // campaign outside var refused
      assert.throws(
        () => assertModeContained({ mode: "run", execCtx, campaignDir: path.join(outside, "camp") }),
        (e) => e.code === TT_EXEC_ESCAPE,
      );
      // a REMOVED owned root refuses even a contained campaign.
      fs.rmSync(path.join(varRoot, "home"), { recursive: true, force: true });
      assert.throws(
        () => assertModeContained({ mode: "report", execCtx, campaignDir: path.join(results, "camp") }),
        (e) => e.code === TT_NOT_OWNED,
      );
      // no exec context -> refused
      assert.throws(
        () => assertModeContained({ mode: "run", execCtx: null, campaignDir: path.join(results, "camp") }),
        (e) => e.code === TT_EXEC_ESCAPE,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R4: makeRealProc — argv/cwd/env lockdown + owned-only kill (injected spawn)", async () => {
    const tmp = ownedTmpDir("proc");
    try {
      const varRoot = path.join(tmp, "var");
      const execCtx = buildPrivateExecContext({
        varRoot,
        binaries: { tamandua: TAMANDUA_BIN, ttChaos: TT_CHAOS_BIN, daemonControl: DC_BIN, tamanduaTest: process.execPath },
      });
      let captured = null;
      const proc = makeRealProc({
        execCtx,
        spawn: async (argv, opts) => {
          captured = { argv, env: opts.env, cwd: opts.cwd, mergeParentEnv: opts.mergeParentEnv };
          return { argv, exitCode: 0, signal: null, stdout: "out", stderr: "", pid: 99 };
        },
      });
      await proc.launchWorkflow(["tamandua", "workflow", "run", "do-now", "--task-file", "t.md"], { env: { TAMANDUA_MAX_ACTIVE_TIMERS: "7" } });
      assert.equal(captured.argv[0], TAMANDUA_BIN, "argv[0] rewritten to the absolute tamandua");
      assert.equal(captured.argv[1], "workflow");
      assert.equal(captured.env.TAMANDUA_TEST_GUARD, "1");
      assert.equal(captured.env.TAMANDUA_MAX_ACTIVE_TIMERS, "7", "per-call env override allowed for non-protected keys");
      assert.equal(captured.env.HOME, execCtx.child_env.HOME);
      assert.equal(captured.env.TAMANDUA_RUN_ID, undefined, "parent authority never leaks into a child");
      assert.equal(captured.env.TT_STORM_CAL_CRED, undefined, "credential sentinel never inherited");
      assert.equal(captured.cwd, execCtx.home_root);
      assert.equal(captured.mergeParentEnv, false, "private env path never merges process.env");

      // tamandua-test is a KNOWN binary name (mapped to its absolute path).
      await proc.tamandua(["tamandua-test", "--version"], {});
      assert.equal(captured.argv[0], process.execPath);

      // Unknown executable name -> refused (root defect #2: no argv escape).
      await assert.rejects(() => proc.launchWorkflow(["/bin/sh", "-c", "id"], {}), (e) => e.code === TT_UNKNOWN_BINARY);
      await assert.rejects(() => proc.chaosAction(["curl", "http://evil"], {}), (e) => e.code === TT_UNKNOWN_BINARY);

      // cwd escape -> refused (root defect #2).
      await assert.rejects(
        () => proc.launchWorkflow(["tamandua", "workflow", "run", "do-now", "--task-file", "t.md"], { cwd: "/tmp/foreign" }),
        (e) => e.code === TT_EXEC_ESCAPE,
      );

      // Protected per-call env keys -> refused (root defect #2: no HOME/DB
      // escape through a per-call env).
      await assert.rejects(
        () => proc.launchWorkflow(["tamandua", "workflow", "run", "do-now", "--task-file", "t.md"], { env: { HOME: "/evil" } }),
        (e) => e.code === TT_EXEC_ESCAPE,
      );
      await assert.rejects(
        () => proc.launchWorkflow(["tamandua", "workflow", "run", "do-now", "--task-file", "t.md"], { env: { TAMANDUA_RUN_ID: "run-x" } }),
        (e) => e.code === TT_EXEC_ESCAPE,
      );

      // cwd INSIDE var root is allowed (must exist to be canonical-resolvable).
      fs.mkdirSync(path.join(varRoot, "sub"), { recursive: true });
      await proc.chaosAction(["tt-chaos", "colleague-commit", "--repo", "/owned", "--file", "a.md", "--run", makeRunId("B1"), "--when", "now"], { cwd: path.join(varRoot, "sub") });
      assert.equal(captured.argv[0], TT_CHAOS_BIN);
      assert.equal(captured.cwd, path.join(varRoot, "sub"));

      await proc.daemonControl(["daemon-control", "real", "restart"], {});
      assert.equal(captured.argv[0], DC_BIN);

      // kill of an UNOWNED pid is refused (no generic process.kill endpoint);
      // an owned (registered live child) pid is admitted and signalled.
      const unowned = await proc.kill(999999, "SIGKILL");
      assert.equal(unowned.ok, false);
      assert.equal(unowned.code, TT_NOT_OWNED);
      const live = nodeSpawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], { stdio: "ignore" });
      try {
        proc.registerChild(live.pid, { evidence: "test-owned-live-child" });
        assert.ok(proc.ownedPids().includes(live.pid), "registered child appears in the owned-pid inventory");
        const ownedKill = await proc.kill(live.pid, "SIGKILL");
        assert.equal(ownedKill.ok, true, "owned child pid may be signalled");
        await new Promise((r) => live.on("close", r));
      } finally {
        if (live.exitCode === null && live.signalCode === null) {
          try { live.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R5: REAL_CLOCK.sleep — overlapping sleeps each resolve; no shared-timer replacement; pending inventory", async () => {
    REAL_CLOCK.cancelAll();
    assert.equal(REAL_CLOCK.pendingCount(), 0);
    const started = Date.now();
    const order = [];
    const p1 = REAL_CLOCK.sleep(40, "first").then(() => order.push("first"));
    const p2 = REAL_CLOCK.sleep(10, "second").then(() => order.push("second"));
    assert.equal(REAL_CLOCK.pendingCount(), 2, "both sleeps pending (no shared-timer replacement)");
    assert.deepEqual(REAL_CLOCK.pendingReasons().sort(), ["first", "second"]);
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["second", "first"], "shorter overlapping sleep resolves first");
    assert.equal(REAL_CLOCK.pendingCount(), 0);
    // PORT (US-007): a real setTimeout(40) may fire at the deadline rounded
    // down by the platform's ~1ms timer granularity, so Date.now() can observe
    // 39ms (measured 2/300 samples). Keep the "the sleep really waited" intent
    // with a small tolerance instead of an exact-boundary flake.
    assert.ok(Date.now() - started >= 35, `40ms sleep elapsed ${Date.now() - started}ms (expected >= 35)`);
    const p3 = REAL_CLOCK.sleep(1000, "never");
    assert.equal(REAL_CLOCK.pendingCount(), 1);
    REAL_CLOCK.cancelAll();
    await p3;
    assert.equal(REAL_CLOCK.pendingCount(), 0);
  });

  it("R6: spawnCapture — byte-preserving UTF-8, real close/reap after timeout, authority strip at the REAL merge boundary", async () => {
    // (a) byte preservation across chunk boundaries
    const byteProg = `
      const b = Buffer.from('héllo—wörld ☃', 'utf8');
      process.stdout.write(b.subarray(0, 7));
      setTimeout(() => {
        process.stdout.write(b.subarray(7));
        process.stdout.write('\\n');
      }, 30);
    `;
    const res = await spawnCapture([process.execPath, "-e", byteProg], { timeoutMs: 5000 });
    assert.equal(res.exitCode, 0, `byte child exit 0 (stderr=${res.stderr})`);
    assert.equal(res.stdout, "héllo—wörld ☃\n");
    assert.equal(res.reaped, true, "close observed -> reaped");

    // (b) a sleeping child is killed on timeout and we AWAIT real close
    const sleepProg = "setInterval(() => {}, 1000);";
    const killed = await spawnCapture([process.execPath, "-e", sleepProg], { timeoutMs: 200 });
    assert.equal(killed.signal, "timeout");
    assert.equal(killed.reaped, true, "timeout kill is followed by observed close");

    // (c) REAL-child authority strip (reviewer issue A): spawnCapture builds
    // the merged env as { ...process.env, ...env }; the authority family must
    // be stripped AFTER the merge so a private env that merely OMITS the vars
    // cannot have them resurrected. A REAL child must observe none of them.
    const saved = {};
    for (const k of ["TAMANDUA_RUN_ID", "TAMANDUA_WORKER_PID", "TAMANDUA_WORKER_JOB_ID", "TAMANDUA_STEP_ID", "TAMANDUA_RUN_ID8"]) {
      saved[k] = process.env[k];
      process.env[k] = `parent-${k}`;
    }
    try {
      const probe = `console.log(JSON.stringify({RUN:process.env.TAMANDUA_RUN_ID??null,WORKER:process.env.TAMANDUA_WORKER_PID??null,JOB:process.env.TAMANDUA_WORKER_JOB_ID??null,STEP:process.env.TAMANDUA_STEP_ID??null,RUN8:process.env.TAMANDUA_RUN_ID8??null}))`;
      const child = await spawnCapture([process.execPath, "-e", probe], { timeoutMs: 5000 });
      assert.equal(child.exitCode, 0, child.stderr);
      const observed = JSON.parse(child.stdout.trim());
      assert.deepEqual(observed, { RUN: null, WORKER: null, JOB: null, STEP: null, RUN8: null }, "real child must NOT inherit any parent authority var");

      // mergeParentEnv:false uses ONLY the explicit env (no operator
      // credentials/ports can leak through the merge).
      const withOnly = await spawnCapture([process.execPath, "-e", probe], {
        env: { PATH: process.env.PATH, HOME: "/private-home" },
        mergeParentEnv: false,
        timeoutMs: 5000,
      });
      assert.equal(withOnly.exitCode, 0, withOnly.stderr);
      const observed2 = JSON.parse(withOnly.stdout.trim());
      assert.deepEqual(observed2, { RUN: null, WORKER: null, JOB: null, STEP: null, RUN8: null });

      // stripParentAuthorityEnv pure helper.
      const stripped = stripParentAuthorityEnv({ TAMANDUA_RUN_ID: "x", KEEP: "y", TAMANDUA_STEP_ID: "s" });
      assert.deepEqual(stripped, { KEEP: "y" });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("R7: mcpTool — first-class refusal when endpoint/tool absent; never a fabricated success", async () => {
    const noEndpoint = makeRealMcpTool({ endpointUrl: null });
    const r1 = await noEndpoint({ tool: "runs.list" });
    assert.equal(r1.ok, false);
    assert.equal(r1.code, "TT_MCP_TRANSPORT_NOT_WIRED");

    const badTool = makeRealMcpTool({ endpointUrl: "http://127.0.0.1:1/mcp" });
    const r2 = await badTool({ tool: "" });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, "TT_MCP_BAD_TOOL");

    const noTool = makeRealMcpTool({ endpointUrl: "http://127.0.0.1:1/mcp" });
    const r3 = await noTool({ args: {} });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, "TT_MCP_BAD_TOOL");

    // NOTE (reviewer issue F): the streamable-HTTP initialize/session/
    // tools-call SUCCESS path is protocol-validated ONLY against the real
    // contained daemon in the approved rehearsal; before approval there is no
    // endpoint, so every call here fails first-class — never a fabricated ok.
  });

  it("R8: probePhaseMarkerReal — per-marker mechanical DB/ref predicates (issue E / root defect #6)", async () => {
    const tmp = ownedTmpDir("phase");
    try {
      const dbOpen = (p) => REAL_DB.open(p);
      const probe = (opts) => probePhaseMarkerReal({ dbOpen, dbPath: opts.file, state: opts.state, ph: opts.ph, refs: opts.refs ?? null });
      const runRowRuns = (tags, { statuses = {}, parentOf = {} } = {}) => tags.map((t) => ({
        tag: t, workflow: t === "S1" ? "feature-dev-merge-worktree" : "do-now",
        status: statuses[t] ?? "running", parentRunId: parentOf[t] ?? null,
      }));

      // (a) round-b-launches-registered
      const st0 = bState();
      const f1 = path.join(tmp, "reg.db");
      makeRealDb(f1, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]) });
      const regOk = await probe({ file: f1, state: st0, ph: { waitFor: { kind: "phase", marker: "round-b-launches-registered" } } });
      assert.equal(regOk.satisfied, true);
      const f1b = path.join(tmp, "reg-missing.db");
      makeRealDb(f1b, { runs: runRowRuns(["B1", "B2", "B3"]) });
      const regNo = await probe({ file: f1b, state: st0, ph: { waitFor: { kind: "phase", marker: "round-b-launches-registered" } } });
      assert.equal(regNo.satisfied, false);
      assert.equal(regNo.outcome, "not_yet");

      // (b) B3 mid-flight step claimed + B4 harness claim recorded
      const f2 = path.join(tmp, "claims.db");
      makeRealDb(f2, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]), steps: [...stepsFor(st0, "B3", ["setup"]), ...stepsFor(st0, "B4", ["investigate"], "running")] });
      const b3ok = await probe({ file: f2, state: st0, ph: { waitFor: { kind: "step", marker: "B3 mid-flight step claimed" } } });
      assert.equal(b3ok.satisfied, true, "B3 claim from its OWN rows");
      assert.equal(b3ok.outcome, "marker_satisfied");
      // B3 without steps -> use a fresh db where B3 has none
      const f2b = path.join(tmp, "claims-none.db");
      makeRealDb(f2b, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]) });
      const b3no = await probe({ file: f2b, state: st0, ph: { waitFor: { kind: "step", marker: "B3 mid-flight step claimed" } } });
      assert.equal(b3no.satisfied, false);
      assert.equal(b3no.outcome, "not_yet");
      const b4ok = await probe({ file: f2, state: st0, ph: { waitFor: { kind: "step", marker: "B4 harness claim recorded" } } });
      assert.equal(b4ok.satisfied, true, "B4 harness claim from B4's OWN rows");

      // (c) finalize claim for a Round B merge run — a B3 row with a
      // claimed finalize_merge step satisfies it.
      const f3 = path.join(tmp, "finalize.db");
      makeRealDb(f3, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]), steps: stepsFor(st0, "B3", ["finalize_merge"]) });
      const finOk = await probe({ file: f3, state: st0, ph: { waitFor: { kind: "step", marker: "finalize claim for a Round B merge run" } } });
      assert.equal(finOk.satisfied, true);
      const finNo = await probe({ file: f2b, state: st0, ph: { waitFor: { kind: "step", marker: "finalize claim for a Round B merge run" } } });
      assert.equal(finNo.satisfied, false);

      // (d) B1-B4 pre-finalize — ROOT REGRESSION: with ONLY B1 carrying any
      // active step, the marker must NOT be satisfied.
      const f4 = path.join(tmp, "prefinalize.db");
      makeRealDb(f4, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]), steps: stepsFor(st0, "B1", ["setup"]) });
      const onlyB1 = await probe({ file: f4, state: st0, ph: { waitFor: { kind: "step", marker: "B1-B4 pre-finalize" } } });
      assert.equal(onlyB1.satisfied, false, "one active B1 setup step cannot stand in for four pre-finalize claims");
      assert.equal(onlyB1.outcome, "not_yet");
      // All four mid-flight (each with an active step, none at finalize).
      const f4b = path.join(tmp, "prefinalize-all.db");
      makeRealDb(f4b, {
        runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]),
        steps: [...stepsFor(st0, "B1", ["setup"]), ...stepsFor(st0, "B2", ["plan"]), ...stepsFor(st0, "B3", ["fix"]), ...stepsFor(st0, "B4", ["investigate"])],
      });
      const allMid = await probe({ file: f4b, state: st0, ph: { waitFor: { kind: "step", marker: "B1-B4 pre-finalize" } } });
      assert.equal(allMid.satisfied, true, "all four mid-flight, none at finalize -> mass-rugpull window open");
      // One at finalize -> not satisfied.
      const f4c = path.join(tmp, "prefinalize-one-finalize.db");
      makeRealDb(f4c, {
        runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]),
        steps: [...stepsFor(st0, "B1", ["setup"]), ...stepsFor(st0, "B2", ["plan"]), ...stepsFor(st0, "B3", ["fix"]), ...stepsFor(st0, "B4", ["finalize_merge"])],
      });
      const oneFin = await probe({ file: f4c, state: st0, ph: { waitFor: { kind: "step", marker: "B1-B4 pre-finalize" } } });
      assert.equal(oneFin.satisfied, false, "B4 already at finalize_merge closes the window");
      // One terminal -> not satisfied.
      const f4d = path.join(tmp, "prefinalize-terminal.db");
      makeRealDb(f4d, {
        runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"], { statuses: { B3: "completed" } }),
        steps: [...stepsFor(st0, "B1", ["setup"]), ...stepsFor(st0, "B2", ["plan"]), ...stepsFor(st0, "B3", ["fix"]), ...stepsFor(st0, "B4", ["investigate"])],
      });
      const term = await probe({ file: f4d, state: st0, ph: { waitFor: { kind: "step", marker: "B1-B4 pre-finalize" } } });
      assert.equal(term.satisfied, false, "a terminal B3 cannot be pre-finalize");

      // (e) other-four-mid-flight (B5 is the stop_delete target; B1..B4 must
      // all be genuinely mid-flight).
      const f5 = path.join(tmp, "otherfour.db");
      makeRealDb(f5, {
        runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]),
        steps: [...stepsFor(st0, "B1", ["setup"]), ...stepsFor(st0, "B2", ["plan"]), ...stepsFor(st0, "B3", ["fix"]), ...stepsFor(st0, "B4", ["investigate"])],
      });
      const fourOk = await probe({ file: f5, state: st0, ph: { waitFor: { kind: "phase", marker: "other-four-mid-flight" } } });
      assert.equal(fourOk.satisfied, true);
      const f5b = path.join(tmp, "otherfour-incomplete.db");
      makeRealDb(f5b, {
        runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]),
        steps: [...stepsFor(st0, "B1", ["setup"]), ...stepsFor(st0, "B2", ["plan"])],
      });
      const fourNo = await probe({ file: f5b, state: st0, ph: { waitFor: { kind: "phase", marker: "other-four-mid-flight" } } });
      assert.equal(fourNo.satisfied, false, "only two mid-flight -> not four");

      // (f) pause-b3-acked — requires the daemon ack (row status paused) AND
      // the B-pause dispatch; never an unrelated fired phase.
      const f6 = path.join(tmp, "pause.db");
      makeRealDb(f6, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"], { statuses: { B3: "paused" } }) });
      const firedB3 = bState({ rounds: { B: { phases: { "B-pause": { status: "fired" } } } } });
      const ackOk = await probe({ file: f6, state: firedB3, ph: { waitFor: { kind: "phase", marker: "pause-b3-acked" } } });
      assert.equal(ackOk.satisfied, true, "pause ack = B3 row status paused after B-pause fired");
      const notFired = await probe({ file: f6, state: st0, ph: { waitFor: { kind: "phase", marker: "pause-b3-acked" } } });
      assert.equal(notFired.satisfied, false, "row paused but B-pause never dispatched -> not_yet");
      // Unrelated phase fired but B3 running -> still not an ack.
      const f6b = path.join(tmp, "pause-running.db");
      makeRealDb(f6b, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]) });
      const unrelatedFired = bState({ rounds: { B: { phases: { "B-cc1": { status: "fired" } } } } });
      const ackNo = await probe({ file: f6b, state: unrelatedFired, ph: { waitFor: { kind: "phase", marker: "pause-b3-acked" } } });
      assert.equal(ackNo.satisfied, false, "an unrelated fired phase is NOT a pause ack");

      // (g) b3-fix-area-known — B3's bfmw 'fix' step claimed AND the cc2 file
      // identity owned.
      const f7 = path.join(tmp, "fixarea.db");
      makeRealDb(f7, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]), steps: stepsFor(st0, "B3", ["fix"]) });
      const areaOk = await probe({ file: f7, state: st0, ph: { waitFor: { kind: "phase", marker: "b3-fix-area-known" } } });
      assert.equal(areaOk.satisfied, true, "B3 fix step claimed + cc2File owned");
      // Setup-only claim is not the fix area.
      const f7b = path.join(tmp, "fixarea-setup.db");
      makeRealDb(f7b, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]), steps: stepsFor(st0, "B3", ["setup"]) });
      const areaSetup = await probe({ file: f7b, state: st0, ph: { waitFor: { kind: "phase", marker: "b3-fix-area-known" } } });
      assert.equal(areaSetup.satisfied, false, "an unrelated active setup step cannot stand in for the fix area");
      // Missing cc2 file identity -> not_yet.
      const noCc2 = bState();
      delete noCc2.plan.fixtureIdentity.cc2File;
      const areaNoCc2 = await probe({ file: f7, state: noCc2, ph: { waitFor: { kind: "phase", marker: "b3-fix-area-known" } } });
      assert.equal(areaNoCc2.satisfied, false);

      // (h) cc1-landed — REAL ref evidence: origin main advanced past the
      // pre-cc1 snapshot. No channel -> evidence_error (UNKNOWN); unchanged
      // head -> not_yet.
      const refsStub = (sha) => ({ originRepo: "/var/fixtures/origin", readRef: async () => ({ ok: true, sha, error: null }) });
      const f8 = path.join(tmp, "cc1.db");
      makeRealDb(f8, { runs: runRowRuns(["B1", "B2", "B3", "B4", "B5"]) });
      const cc1State = bState({ rounds: { B: { phases: { "B-cc1": { status: "fired", refs: { originMainBefore: { sha: "a".repeat(40), at: "2026-01-01T00:00:00Z" } } } } } } });
      const landed = await probe({ file: f8, state: cc1State, ph: { waitFor: { kind: "phase", marker: "cc1-landed" } }, refs: refsStub("b".repeat(40)) });
      assert.equal(landed.satisfied, true, "origin main advanced -> cc1 landed");
      const notLanded = await probe({ file: f8, state: cc1State, ph: { waitFor: { kind: "phase", marker: "cc1-landed" } }, refs: refsStub("a".repeat(40)) });
      assert.equal(notLanded.satisfied, false, "origin main unchanged -> not_yet");
      const noRefs = await probe({ file: f8, state: cc1State, ph: { waitFor: { kind: "phase", marker: "cc1-landed" } } });
      assert.equal(noRefs.satisfied, false);
      assert.equal(noRefs.outcome, "evidence_error", "missing git ref channel is UNKNOWN, never satisfied");
      const noSnapshot = await probe({ file: f8, state: st0, ph: { waitFor: { kind: "phase", marker: "cc1-landed" } }, refs: refsStub("b".repeat(40)) });
      assert.equal(noSnapshot.outcome, "not_yet", "no pre-cc1 snapshot -> not dispatched yet");

      // (i) rugpull-recovered — recovery = a child/replacement run row
      // (parent_run_id == target) for EVERY pulled target after B-rugpull
      // fired; never a fired phase alone.
      const rugState = bState({ rounds: { B: { phases: { "B-rugpull": { status: "fired" } } } } });
      const f9 = path.join(tmp, "rugpull.db");
      makeRealDb(f9, {
        runs: [
          ...runRowRuns(["B1", "B2", "B3", "B4", "B5"], { statuses: { B1: "failed", B2: "failed", B3: "failed", B4: "failed" } }),
          { tag: "B1R", workflow: "feature-dev-merge-worktree", status: "running", parentRunId: "B1" },
          { tag: "B2R", workflow: "feature-dev-merge-worktree", status: "running", parentRunId: "B2" },
          { tag: "B3R", workflow: "bug-fix-merge-worktree", status: "running", parentRunId: "B3" },
          { tag: "B4R", workflow: "bug-fix-merge-worktree", status: "running", parentRunId: "B4" },
        ],
      });
      const recovered = await probe({ file: f9, state: rugState, ph: { waitFor: { kind: "phase", marker: "rugpull-recovered" } } });
      assert.equal(recovered.satisfied, true, "every pulled target has a child/replacement run row");
      const f9b = path.join(tmp, "rugpull-partial.db");
      makeRealDb(f9b, {
        runs: [
          ...runRowRuns(["B1", "B2", "B3", "B4", "B5"], { statuses: { B1: "failed", B2: "failed", B3: "failed", B4: "failed" } }),
          { tag: "B1R", workflow: "feature-dev-merge-worktree", status: "running", parentRunId: "B1" },
          { tag: "B2R", workflow: "feature-dev-merge-worktree", status: "running", parentRunId: "B2" },
          { tag: "B3R", workflow: "bug-fix-merge-worktree", status: "running", parentRunId: "B3" },
        ],
      });
      const partial = await probe({ file: f9b, state: rugState, ph: { waitFor: { kind: "phase", marker: "rugpull-recovered" } } });
      assert.equal(partial.satisfied, false, "B4 has no child/replacement -> recovery incomplete");
      const notRug = await probe({ file: f9, state: st0, ph: { waitFor: { kind: "phase", marker: "rugpull-recovered" } } });
      assert.equal(notRug.outcome, "not_yet", "mass rugpull not fired -> nothing to recover");

      // (j) kind none / no marker -> satisfied trivially (no evidence gate).
      const none = await probe({ file: f1, state: st0, ph: { waitFor: { kind: "none", marker: null } } });
      assert.equal(none.satisfied, true);

      // (k) unreadable DB -> evidence_error (UNKNOWN, not fabricated).
      const err = await probe({ file: path.join(tmp, "absent.db"), state: st0, ph: { waitFor: { kind: "step", marker: "B3 mid-flight step claimed" } } });
      assert.equal(err.satisfied, false);
      assert.equal(err.outcome, "evidence_error");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R9: runOwnedCleanup — ONLY explicit { evidenced:true } counts (undefined/{}/ok-only can never PASS)", async () => {
    const tmp = ownedTmpDir("cleanup");
    try {
      const varRoot = path.join(tmp, "var");
      const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });

      const okRun = await runOwnedCleanup({
        execCtx,
        inventory: ["campaign-owned"],
        handlers: { "campaign-owned": async () => ({ evidenced: true }) },
      });
      assert.equal(okRun.ok, true);

      const absent = await runOwnedCleanup({ execCtx, inventory: ["campaign-owned"], handlers: {} });
      assert.equal(absent.ok, false);
      assert.match(absent.failed[0].error, /no handler/);

      // undefined / {} / false / {ok:true} results can never PASS (root
      // defect #4: cleanup returned a promise / an empty object is NOT
      // closed evidence).
      const undefRun = await runOwnedCleanup({
        execCtx, inventory: ["campaign-owned"],
        handlers: { "campaign-owned": async () => undefined },
      });
      assert.equal(undefRun.ok, false);
      assert.match(undefRun.failed[0].error, /no explicit positive evidence/);

      const emptyRun = await runOwnedCleanup({
        execCtx, inventory: ["campaign-owned"],
        handlers: { "campaign-owned": async () => ({}) },
      });
      assert.equal(emptyRun.ok, false);
      assert.match(emptyRun.failed[0].error, /no explicit positive evidence/);

      const okOnlyRun = await runOwnedCleanup({
        execCtx, inventory: ["campaign-owned"],
        handlers: { "campaign-owned": async () => ({ ok: true, pid: 5 }) },
      });
      assert.equal(okOnlyRun.ok, false, "'{ok:true}' without evidenced:true is not positive shutdown evidence");

      const falseRun = await runOwnedCleanup({
        execCtx, inventory: ["campaign-owned"],
        handlers: { "campaign-owned": async () => false },
      });
      assert.equal(falseRun.ok, false);

      const noEvidence = await runOwnedCleanup({
        execCtx, inventory: ["campaign-owned"],
        handlers: { "campaign-owned": async () => ({ evidenced: false, error: "still alive" }) },
      });
      assert.equal(noEvidence.ok, false);

      const throwRun = await runOwnedCleanup({
        execCtx, inventory: ["campaign-owned"],
        handlers: { "campaign-owned": async () => { throw new Error("boom"); } },
      });
      assert.equal(throwRun.ok, false);
      assert.match(throwRun.failed[0].error, /boom/);

      // Real campaign handler: identity unchanged + explicit owned-pid
      // inventory all dead -> PASS; an ALIVE owned pid -> cannot PASS.
      const realHandler = makeCampaignCleanupHandlers(execCtx);
      const realRun = await runOwnedCleanup({ execCtx, inventory: ["campaign-owned"], handlers: realHandler });
      assert.equal(realRun.ok, true);
      assert.ok(realRun.ledger[0].evidence.retained.includes("no-removal"));
      assert.ok(fs.existsSync(execCtx.home_root), "files retained after cleanup");

      const live = nodeSpawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], { stdio: "ignore" });
      try {
        const withLive = await runOwnedCleanup({
          execCtx,
          inventory: ["campaign-owned"],
          handlers: makeCampaignCleanupHandlers(execCtx, { ownedPids: [live.pid] }),
          resources: { ownedPids: [live.pid] },
        });
        assert.equal(withLive.ok, false, "a still-alive owned pid cannot mean cleanup PASS");
        assert.match(withLive.failed[0].error, /still alive/);
      } finally {
        live.kill("SIGKILL");
        await new Promise((r) => live.on("close", r));
      }
      const afterKill = await runOwnedCleanup({
        execCtx,
        inventory: ["campaign-owned"],
        handlers: makeCampaignCleanupHandlers(execCtx, { ownedPids: [live.pid] }),
        resources: { ownedPids: [live.pid] },
      });
      assert.equal(afterKill.ok, true, "dead owned pid -> positive shutdown evidence");

      // Ownership REMOVED -> real handler cannot PASS.
      fs.rmSync(path.join(varRoot, "home"), { recursive: true, force: true });
      const replacedRun = await runOwnedCleanup({ execCtx, inventory: ["campaign-owned"], handlers: makeCampaignCleanupHandlers(execCtx) });
      assert.equal(replacedRun.ok, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R10: coordinator approval gate — one strict validator: non-empty ids/source, COMPLETE hash set (no subset/superset), no synthetic receipts", () => {
    const gateHashes = {
      "torture-test/bin/tt-storm-real.mjs": "a".repeat(64),
      "torture-test/bin/tt-storm-shared.mjs": "b".repeat(64),
      "torture-test/bin/tt-storm-engine.mjs": "c".repeat(64),
      "torture-test/bin/tt-storm": "d".repeat(64),
      "torture-test/self-tests/tier2-storm-real-calibration.test.ts": "e".repeat(64),
    };
    const base = {
      real_launch_allowed: true,
      campaign_id: "storm-camp-1",
      source_commit: "55ac724",
      approval_kind: "SCRIPTED_REHEARSAL",
      gate_hashes: gateHashes,
    };
    const ok = verifyCoordinatorApproval({ approval: base, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes });
    assert.equal(ok.ok, true);

    // no gate_hashes pinned -> synthetic receipt refused
    const unpinned = { ...base };
    delete unpinned.gate_hashes;
    const r1 = verifyCoordinatorApproval({ approval: unpinned, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes });
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /synthetic rehearsal receipt/);

    // MISSING campaign/source ids refused (root defect #5)
    const noCampaign = { ...base };
    delete noCampaign.campaign_id;
    assert.equal(verifyCoordinatorApproval({ approval: noCampaign, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes }).ok, false);
    const noSource = { ...base };
    delete noSource.source_commit;
    assert.equal(verifyCoordinatorApproval({ approval: noSource, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes }).ok, false);
    // empty caller ids refused
    assert.equal(verifyCoordinatorApproval({ approval: base, campaignId: "", sourceCommit: "55ac724", gateHashes }).ok, false);
    assert.equal(verifyCoordinatorApproval({ approval: base, campaignId: "storm-camp-1", sourceCommit: "", gateHashes }).ok, false);

    // wrong campaign / source / kind refused
    assert.equal(verifyCoordinatorApproval({ approval: base, campaignId: "storm-other", sourceCommit: "55ac724", gateHashes }).ok, false);
    assert.equal(verifyCoordinatorApproval({ approval: base, campaignId: "storm-camp-1", sourceCommit: "deadbee", gateHashes }).ok, false);
    assert.equal(verifyCoordinatorApproval({ approval: { ...base, approval_kind: "self-signed" }, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes }).ok, false);

    // PARTIAL hash set (approval omits one gate file) refused — stale approval
    // after gate-code growth can never qualify.
    const partial = { ...base, gate_hashes: { "torture-test/bin/tt-storm-real.mjs": "a".repeat(64) } };
    const rPart = verifyCoordinatorApproval({ approval: partial, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes });
    assert.equal(rPart.ok, false);
    assert.match(rPart.reason, /omits a tested gate file|do not match/);

    // SUPERSET (extra unpinned file) refused.
    const superset = { ...base, gate_hashes: { ...gateHashes, "torture-test/bin/tt-storm-roster.mjs": "f".repeat(64) } };
    const rSup = verifyCoordinatorApproval({ approval: superset, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes });
    assert.equal(rSup.ok, false);
    assert.match(rSup.reason, /outside the tested gate set/);

    // hash mismatch (safety/gate code changed since approval) refused.
    const stale = { ...base, gate_hashes: { ...gateHashes, "torture-test/bin/tt-storm-real.mjs": "f".repeat(64) } };
    const r5 = verifyCoordinatorApproval({ approval: stale, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes });
    assert.equal(r5.ok, false);
    assert.match(r5.reason, /hash mismatch/);

    // real_launch_allowed not true refused
    assert.equal(verifyCoordinatorApproval({ approval: { ...base, real_launch_allowed: false }, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes }).ok, false);

    // expectedProfile enforcement
    const withProfile = { ...base, profile: "SCRIPTED_REHEARSAL" };
    assert.equal(verifyCoordinatorApproval({ approval: withProfile, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes, expectedProfile: "SCRIPTED_REHEARSAL" }).ok, true);
    assert.equal(verifyCoordinatorApproval({ approval: base, campaignId: "storm-camp-1", sourceCommit: "55ac724", gateHashes, expectedProfile: "SCRIPTED_REHEARSAL" }).ok, false);
  });

  it("R11: CLI approve — a no-gate-hash synthetic approval can never qualify a campaign through approve→run", () => {
    const tmp = ownedTmpDir("cli-approve");
    const campaignId = `storm-approve-neg-${Date.now()}`;
    try {
      // Prepare a synthetic campaign UNDER torture-test/var so the CLI's own
      // containment/identity checks see a real prepared campaign with a real
      // exec-identity receipt.
      const results = path.join(VAR_ROOT, "results");
      fs.mkdirSync(results, { recursive: true });
      const campaignDir = path.join(results, campaignId);
      fs.mkdirSync(campaignDir, { recursive: true });
      fs.mkdirSync(path.join(campaignDir, "results"), { recursive: true });
      const execCtx = buildPrivateExecContext({ varRoot: VAR_ROOT, binaries: { tamandua: TAMANDUA_BIN } });
      const state = {
        schema_version: 1,
        campaign_id: campaignId,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        mode: "prepared",
        qualification: { real_launch_allowed: false, note: "not-yet-qualified" },
        exec_identity: persistableExecIdentity(execCtx),
        rounds: { A: { status: "planned", runs: {} }, B: { status: "planned", runs: {} } },
        plan: { launches: [], roundBPhases: [] },
      };
      fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify(state, null, 2));
      fs.writeFileSync(path.join(campaignDir, "ops.jsonl"), "");
      fs.writeFileSync(path.join(campaignDir, "intent.jsonl"), "");

      // Synthetic NO-HASH approval (the exact receipt R10 refuses).
      const fakeApprovalFile = path.join(tmp, "synthetic-no-hashes.json");
      fs.writeFileSync(fakeApprovalFile, JSON.stringify({
        real_launch_allowed: true,
        campaign_id: campaignId,
        source_commit: "whatever",
        approval_kind: "SCRIPTED_REHEARSAL",
      }));

      const r = spawnSync(process.execPath, [TT_STORM_CLI, "approve", "--campaign", campaignDir, "--approval-file", fakeApprovalFile], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, TAMANDUA_TEST_GUARD: "1" },
      });
      assert.equal(r.status, 3, `CLI approve must refuse a no-hash synthetic approval (stdout=${r.stdout}, stderr=${r.stderr})`);
      assert.match(String(r.stderr), /REFUSED/);
      const after = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      assert.equal(after.qualification.real_launch_allowed, false, "campaign stays unqualified after a synthetic approval");
    } finally {
      // Remove ONLY this exact synthetic negative-test campaign dir under
      // var/results (created by THIS test; retained-artifact policy applies
      // to real campaign artifacts, not synthetic negative fixtures).
      fs.rmSync(path.join(VAR_ROOT, "results", campaignId), { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R12: persisted exec-identity receipts — cross-invocation replaced-root detection and re-prepare refusal", async () => {
    const tmp = ownedTmpDir("receipt");
    try {
      const varRoot = path.join(tmp, "var");
      const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
      const receipt = persistableExecIdentity(execCtx);
      assert.equal(receipt.home_root, execCtx.home_root);
      assert.ok(receipt.ownership.home.ino > 0);
      // Revalidation passes while the roots are unchanged.
      assert.equal(revalidatePersistedExecIdentity({ execCtx, persisted: receipt }).ok, true);
      // A context with DRIFTED paths refuses.
      const otherCtx = buildPrivateExecContext({ varRoot: path.join(tmp, "var2"), binaries: { tamandua: TAMANDUA_BIN } });
      assert.throws(
        () => revalidatePersistedExecIdentity({ execCtx: otherCtx, persisted: receipt }),
        (e) => e.code === TT_NOT_OWNED,
      );
      // A REMOVED root refuses against the receipt.
      fs.rmSync(execCtx.home_root, { recursive: true, force: true });
      assert.throws(
        () => revalidatePersistedExecIdentity({ execCtx, persisted: receipt }),
        (e) => e.code === TT_NOT_OWNED,
      );
      // A campaign without a receipt (old prepared state) refuses.
      assert.throws(
        () => revalidatePersistedExecIdentity({ execCtx, persisted: null }),
        (e) => e.code === TT_NOT_OWNED,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R13: engine wait-loop keeps evidence_error (UNKNOWN) distinct from not_yet (reviewer issue G1)", async () => {
    const { waitForPhaseEvidence } = await import("../bin/tt-storm-engine.mjs");
    const campaignDir = "/campaign";
    const ctx = {
      fs: { },
      clock: {
        _now: 0,
        nowMs: () => ctx.clock._now,
        nowUtc: () => new Date(ctx.clock._now).toISOString(),
        sleep: async (n) => { ctx.clock._now += n; },
      },
      opts: { phaseWaitTimeoutMs: 2000 },
      proc: { httpGet: null, mcpTool: null },
    };
    // evidence_error probe (unreadable source) -> final outcome evidence_error
    const evErrCtx = {
      ...ctx,
      opts: {
        phaseWaitTimeoutMs: 2000,
        probePhaseMarker: async () => ({ satisfied: false, outcome: "evidence_error", marker: "x", reason: "db unreadable" }),
      },
    };
    const evRes = await waitForPhaseEvidence(evErrCtx, { rounds: { B: {} } }, { id: "B-x", waitFor: { kind: "phase", marker: "x" } });
    assert.equal(evRes.satisfied, false);
    assert.equal(evRes.outcome, "evidence_error", "UNKNOWN must not collapse into timed_out");
    // not_yet probe -> plain timed_out
    const notYetCtx = {
      ...ctx,
      opts: {
        phaseWaitTimeoutMs: 2000,
        probePhaseMarker: async () => ({ satisfied: false, outcome: "not_yet", marker: "x" }),
      },
    };
    const nyRes = await waitForPhaseEvidence(notYetCtx, { rounds: { B: {} } }, { id: "B-x", waitFor: { kind: "phase", marker: "x" } });
    assert.equal(nyRes.outcome, "timed_out");
    // satisfied boolean adapter still works
    const okCtx = {
      ...ctx,
      opts: { phaseWaitTimeoutMs: 2000, probePhaseMarker: async () => true },
    };
    const okRes = await waitForPhaseEvidence(okCtx, { rounds: { B: {} } }, { id: "B-x", waitFor: { kind: "phase", marker: "x" } });
    assert.equal(okRes.satisfied, true);
  });

  it("R14: launch-failure save bumps state.updated_at (reviewer issue G2)", async () => {
    const tmp = ownedTmpDir("stamp");
    try {
      const campaignDir = path.join(tmp, "c1");
      fs.mkdirSync(campaignDir, { recursive: true });
      const files = new Map();
      let msNow = 1_700_000_000_000;
      const clock = {
        nowMs: () => msNow,
        // each nowUtc read advances the timestamp so persistState stamps are
        // strictly later than the prepare stamp.
        nowUtc: () => { msNow += 1; return new Date(msNow).toISOString(); },
        sleep: async (n) => { msNow += n; },
      };
      const prepareAt = clock.nowUtc();
      const state = {
        campaign_id: "storm-stamp",
        updated_at: prepareAt,
        source: { active_cap: 1 },
        qualification: { real_launch_allowed: true },
        mode: "prepared",
        rounds: {
          A: { status: "planned", runs: {}, pounding: { active: false } },
          B: { status: "planned", runs: {}, pounding: { active: false } },
        },
        sampler: { samples: [] },
        queue: { attempts: [] },
        cleanup: { ledger: [] },
        plan: {
          launches: [{ round: "A", rosterId: "S1", run: "storm-fdmw-1", workflow: "feature-dev-merge-worktree", harness: "pi", timers: 1, demand: 1, queued: false, earliestOffsetMs: 0, targetBranch: "main" }],
          roundBPhases: [],
        },
      };
      const fsx = {
        existsSync: (p) => files.has(String(p)),
        readFileSync: (p) => { const v = files.get(String(p)); if (v === undefined) throw new Error(`no file ${p}`); return v; },
        readFile: async (p) => fsx.readFileSync(p),
        writeFileSync: (p, d) => { files.set(String(p), String(d)); },
        appendFileSync: (p, d) => { const k = String(p); files.set(k, (files.get(k) ?? "") + String(d)); },
        renameSync: (a, b) => { const ka = String(a); const kb = String(b); if (!files.has(ka)) throw new Error(`rename source missing ${ka}`); files.set(kb, files.get(ka)); files.delete(ka); },
        mkdirSync: () => {},
        realpathSync: (p) => String(p),
      };
      files.set(path.join(campaignDir, "state.json"), JSON.stringify(state));
      const { stormRunRoundA } = await import("../bin/tt-storm-engine.mjs");
      const ctx = {
        fs: fsx,
        clock,
        campaignDir,
        varRoot: tmp,
        git: null,
        db: { open: () => ({ ok: false, error: "no db in stamp test" }) },
        proc: {
          launchWorkflow: async () => ({ argv: [], exitCode: null, signal: "spawn-error:enoent", stdout: "", stderr: "", pid: null, reaped: false }),
          httpGet: null,
          mcpTool: null,
        },
        opts: {
          dbPath: path.join(tmp, "absent.db"),
          fixtureIdentity: { colleagueRepo: null, cc1File: null, cc2File: null, parkRepo: null },
          pounding: null,
          launchCwd: campaignDir,
          // SF-12 (fix-6): the fail-closed task-file resolver needs an absolute
          // campaign tasks root rather than a HOME-relative fallback.
          taskFileRoot: path.join(tmp, "tasks"),
        },
      };
      await assert.rejects(() => stormRunRoundA(ctx), (e) => e.code === "TT_MISSING_RUN");
      const saved = JSON.parse(files.get(path.join(campaignDir, "state.json")));
      assert.equal(saved.rounds.A.status, "failed", "round A fail-closed on a runless launch");
      assert.equal(saved.rounds.A.runs.S1.status, "launch_failed");
      assert.ok(saved.updated_at !== prepareAt, `updated_at must advance past prepare on the launch-failure save (${saved.updated_at} vs ${prepareAt})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R15: parent/child identity helpers + refs channel presence (harvest + landing evidence plumbing)", async () => {
    const { runParentMatches, makeRefsChannel } = await import("../bin/tt-storm-engine.mjs");
    // runParentMatches handles BOTH product forms: bare parent_run_id vs a
    // public rec.runId, and the recording gate's public parent_run_id form.
    assert.equal(runParentMatches({ parent_run_id: makeRunId("B1").slice(4) }, makeRunId("B1")), true);
    assert.equal(runParentMatches({ parent_run_id: makeRunId("B1") }, makeRunId("B1")), true);
    assert.equal(runParentMatches({ parent_run_id: makeRunId("B1").toUpperCase() }, makeRunId("B1")), true);
    assert.equal(runParentMatches({ parent_run_id: makeRunId("B2") }, makeRunId("B1")), false);
    // withRunParentIdentity decorates rows with canonical parent identities.
    const row = withRunParentIdentity({ id: makeRunId("B1").slice(4), parent_run_id: makeRunId("B1").slice(4) });
    assert.equal(row.run_id_bare, makeRunId("B1").slice(4));
    assert.equal(row.parent_run_id_bare, makeRunId("B1").slice(4));
    assert.equal(row.parent_run_id_public, makeRunId("B1"));

    // Refs channel: present when git + fixture repos exist; readRef resolves a
    // sha; null without a git adapter.
    const gitRun = async (repo, args) => {
      assert.equal(repo, "/var/fixtures/origin");
      assert.deepEqual(args, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
      return { exitCode: 0, stdout: "c".repeat(40) + "\n", stderr: "" };
    };
    const channel = makeRefsChannel({ git: { run: gitRun } }, bState());
    assert.ok(channel, "refs channel present");
    const read = await channel.readRef("/var/fixtures/origin", "refs/heads/main");
    assert.equal(read.ok, true);
    assert.equal(read.sha, "c".repeat(40));
    assert.equal(makeRefsChannel({ git: { run: gitRun } }, bState({ plan: { fixtureIdentity: { cc1File: null, cc2File: null, colleagueRepo: null, originRepo: null, parkRepo: null } } })), null);
  });

  it("R16: FINALIZE_STEP_IDS constant matches the product merge-workflow finalize step", () => {
    assert.deepEqual(FINALIZE_STEP_IDS, ["finalize_merge"]);
    for (const wf of ["feature-dev-merge-worktree/workflow.yml", "bug-fix-merge-worktree/workflow.yml", "security-audit-merge-worktree/workflow.yml", "quarantine-broken-tests-merge-worktree/workflow.yml"]) {
      const text = fs.readFileSync(path.join(repoRoot, "workflows", wf), "utf8");
      assert.match(text, /^\s*- id: finalize_merge\s*$/m, `${wf} declares the finalize_merge step`);
    }
  });
});

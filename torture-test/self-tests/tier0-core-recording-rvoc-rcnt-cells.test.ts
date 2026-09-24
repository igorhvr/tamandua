/**
 * CORE-CELLS US-004 — original CORE US-006: RVOC same-step recovery/respawn
 * ordering and RCNT class-specific reroute counters.
 *
 * Beads tamandua-6sy.7 / tamandua-6sy.7.4. One isolated RVOC/RCNT
 * recorded-cell regression file that proves, through the REAL isolated motor
 * (real daemon/scheduler/step protocol, owned isolated children, deterministic
 * scripted seams — never live-process hunts), the two source-backed traces:
 *
 *   RVOC — W4.10-kill-daemon run 59e8e12c-2a7e-438d-aa48-6a3b99abb750: two
 *     successful SAME-ROW fixer claims surround step.worker_lost in the
 *     archived event stream (all.jsonl 6114 -> 6116 -> 6117). There was NO
 *     dedicated step.respawned historically — but worker_lost DID exist and is
 *     acknowledged as the connecting event. Current product behavior emits
 *     step.respawned AFTER the recovery event. The fresh corridor drives the
 *     same shape through the current motor: claim #1 -> die-after-claim
 *     (worker claimed, exited without reporting) -> step.worker_lost ->
 *     step.respawned -> claim #2 of the SAME step row -> done; the run
 *     completes with worker_lost_count 1 and the step's retry_count 1.
 *
 *   RCNT — W4.10-restart-recovery run f60941b9-6b36-403d-9730-2c7805c8eb7b:
 *     the native accepted STATUS: retry / REBASED: true verdict identifies an
 *     ORDINARY rebase; the archived finalize_merge row shows reroute_count 1
 *     and terminal_reroute_count 0 with the run completing and landing. The
 *     old all-reroutes-equal-terminal oracle equality rule was WRONG. The
 *     fresh corridors prove the class-specific counters through the real
 *     motor:
 *       (a) ORDINARY rebase reroute: a two-step fixture corridor whose
 *           consumer completes with the recorded retry-verdict shape
 *           (STATUS: retry / REBASED: true) is rerouted to its upstream
 *           producer via on_fail.retry_step; reroute_count becomes 1,
 *           terminal_reroute_count STAYS 0, and the run is NOT failed.
 *       (b) EXPLICITLY LABELED SYNTHETIC TERMINAL CONTROL (apart from
 *           ordinary rebases): a terminal-class refusal
 *           (FAILURE_CLASS: refused_permanent) consumes the one-shot
 *           terminal allowance (terminal_reroute_count 1) and reroutes
 *           without failing the run (resolve corridor); a second terminal
 *           refusal exhausts the allowance and fails the run with NO second
 *           reroute (escalate corridor).
 *
 * Honest limits recorded (never papered over): the RVOC/RCNT corridors use
 * the same do-now / fixture-corridor launch the existing CORE cells use; a
 * real bug-fix-merge-worktree merge-branch landing is NOT claimed here (it
 * stays a merge-gated-corridor obligation). No claim anywhere asserts a
 * dedicated step.respawned existed historically, and no claim asserts there
 * was no connecting event: step.worker_lost existed. No
 * all-reroutes-equal-terminal equality rule appears anywhere in this file.
 * No real credentials/provider/network; every corridor is zero-token
 * (scripted pi); all owned children/listeners close with positive bounded
 * evidence.
 *
 * Isolation/evidence: every actual execution uses private HOME /
 * TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH / TMPDIR, TAMANDUA_TEST_GUARD=1,
 * random control ports and an explicit child env. Sandboxes/evidence are
 * RETAINED under a fresh evidence root in torture-test/var/review-logs/
 * (git-ignored). Nothing is removed.
 *
 * Designated gate: `node --test torture-test/self-tests/tier0-core-recording-rvoc-rcnt-cells.test.ts`
 * on a clean committed tree with dist/ built exits 0.
 */

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

// ── Lazy module loads (mirror tier0-core-recording-*-cells.test.ts) ─
const moduleCache = new Map();
function load(repoRelative: string) {
  const url = pathToFileURL(path.join(repoRoot, repoRelative)).href;
  if (!moduleCache.has(url)) moduleCache.set(url, import(url));
  return moduleCache.get(url);
}

const loadExecutor = () => load("torture-test/bin/core-recording-replay-executor.mjs");
const loadAssets = () => load("torture-test/bin/core-recording-rvoc-rcnt-cell-assets.mjs");

// The do-now corridor agent (RVOC corridor) + the reroute fixture workflow id.
const RVOC_AGENT = "do-now_doer";
const REROUTE_FIXTURE_ID = "core-reroute-corridor";
const REROUTE_AGENT = `${REROUTE_FIXTURE_ID}_doer`;

const CLI = path.join(repoRoot, "dist", "cli", "cli.js");

/** One fresh retained evidence root for this whole file run. */
const EVIDENCE_ROOT = (() => {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(repoRoot, "torture-test", "var", "review-logs", `core-rvoc-rcnt-cells-${now}Z`);
  fs.mkdirSync(root, { recursive: true });
  return root;
})();

/** True when the built dist (needed by the real motor) is present. */
function distBuilt() {
  return (
    fs.existsSync(path.join(repoRoot, "dist", "cli", "cli.js")) &&
    fs.existsSync(path.join(repoRoot, "dist", "server", "daemon.js"))
  );
}

function gitHead() {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" });
    return r.status === 0 ? r.stdout.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalize run/step id prefixes across DB rows / events / journal rows. */
function stripIdPrefix(id: unknown): string {
  return String(id).replace(/^run-/, "").replace(/^step-/, "");
}

/** Read the fresh run's step rows (with reroute counters) read-only. */
async function readSteps(sandbox: any, runId: string): Promise<any[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sandbox.dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, step_id, agent_id, status, retry_count, reroute_count, terminal_reroute_count, output FROM steps WHERE run_id = ? ORDER BY step_index",
      )
      .all(runId);
  } finally {
    db.close();
  }
}

/** Read the fresh run row + system stats read-only. */
async function readRunRow(sandbox: any, runId: string): Promise<{ run: any; stats: any }> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sandbox.dbPath, { readOnly: true });
  try {
    const run = db
      .prepare(
        "SELECT id, status, harness_probe_status, worker_lost_count, tokens_spent FROM runs WHERE id = ?",
      )
      .get(runId);
    const stats = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get() ?? null;
    return { run, stats };
  } finally {
    db.close();
  }
}

/**
 * ── Reroute-corridor fixture workflow ─────────────────────────────
 * Two-step produce -> consume corridor whose consumer models the recorded
 * finalize_merge ordinary-rebase retry verdict (STATUS: retry / REBASED:
 * true) with max_retries 0 and on_fail.retry_step -> produce. Torture-owned;
 * materialized inside each isolated sandbox (never a product workflow edit).
 */
const REROUTE_FIXTURE_YML = `# CORE-CELLS US-004 RVOC/RCNT corridor fixture (torture-owned; materialized
# inside each isolated sandbox only). Two-step produce -> consume corridor
# whose consumer models the recorded finalize_merge ordinary-rebase retry
# verdict (STATUS: retry / REBASED: true) with max_retries 0 and
# on_fail.retry_step -> the upstream producer.
id: ${REROUTE_FIXTURE_ID}
name: Core Reroute Corridor
version: 1
description: |
  Two-step synthetic corridor (produce -> consume) used by the CORE-CELLS
  RVOC/RCNT recorded cell to exercise real product reroute semantics
  (on_fail.retry_step) through the real isolated motor with a canned
  retry-verdict consumer.

agents:
  - id: doer
    name: Doer
    role: coding
    description: Executes the produce and consume steps and reports results.
    workspace:
      baseDir: agents/doer
      files:
        AGENTS.md: agents/doer/AGENTS.md
        SOUL.md: agents/doer/SOUL.md
        IDENTITY.md: agents/doer/IDENTITY.md

steps:
  - id: produce
    agent: doer
    input: |
      Produce the state required by the consume step and report your results.

      TASK:
      {{task}}

      RETRY FEEDBACK (only present if your previous attempt was rejected - read carefully and fix specifically what it complains about):
      {{retry_feedback}}

      Instructions:
      1. Understand the task
      2. Produce the state
      3. Report whether you succeeded or failed

      Reply with:
      STATUS: done
      PRODUCED: <short description of the produced state>
    expects: "STATUS: done"

  - id: consume
    agent: doer
    input: |
      Consume the produced state and land the result.

      TASK:
      {{task}}

      RETRY FEEDBACK (only present if your previous attempt was rejected - read carefully and fix specifically what it complains about):
      {{retry_feedback}}

      When the produced base moved under you, stop before landing and reply:
      STATUS: retry
      REBASED: true
      RETRY_STEP: produce

      Reply on success with:
      STATUS: done
      REBASED: false
      CONSUMED: <result>
    expects: |
      regex:^STATUS:\\s*(done|retry)\\s*$
      regex:^REBASED:\\s*(true|false)\\s*$
    max_retries: 0
    on_fail:
      retry_step: produce
      # Mirrors the recorded bug-fix-merge-worktree finalize_merge budget (8).
      max_reroutes: 8
`;

function materializeRerouteFixture(sandbox: any): string {
  const wfDir = path.join(sandbox.root, "wf-src", REROUTE_FIXTURE_ID);
  const agentDir = path.join(wfDir, "agents", "doer");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "workflow.yml"), REROUTE_FIXTURE_YML, "utf-8");
  // Persona files copied from the product do-now agent (same public files the
  // do-now corridor install copies; scripted runtime never reads them).
  for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md"]) {
    const src = path.join(repoRoot, "workflows", "do-now", "agents", "doer", file);
    fs.copyFileSync(src, path.join(agentDir, file));
  }
  return path.dirname(wfDir); // fixture catalog root (parent of the id dir)
}

/** Install the reroute fixture into the isolated catalog via the REAL installer. */
function installRerouteFixture({ repoRoot, env, catalogRoot }: { repoRoot: string; env: any; catalogRoot: string }): void {
  const installEnv = { ...env, TAMANDUA_WORKFLOWS_SRC: catalogRoot };
  const r = spawnSync(process.execPath, [CLI, "workflow", "install", REROUTE_FIXTURE_ID], {
    encoding: "utf-8",
    env: installEnv,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `reroute fixture install failed (${r.status}): ${(r.stderr ?? r.stdout ?? "").slice(0, 1500)}`,
    );
  }
}

/** Read the daemon log text for a sandbox. */
function daemonLogPath(sandbox: any): string {
  return path.join(sandbox.tamanduaDir, "tamandua.log");
}

async function readLogText(sandbox: any): Promise<string> {
  const p = daemonLogPath(sandbox);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

/** Parse the per-run events file into a JSON array (diagnosed on parse error). */
function readRunEvents(sandbox: any, runId: string): any[] {
  const p = path.join(sandbox.tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(p)) return [];
  const out: any[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`malformed event line in ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Parse the invocation journal into a JSON array. */
function readInvocations(sandbox: any): any[] {
  const p = path.join(sandbox.stateDir, "invocations.jsonl");
  if (!fs.existsSync(p)) return [];
  const out: any[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`malformed invocation line in ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

const STEP_LIFECYCLE_EVENTS = new Set([
  "step.running",
  "step.worker_lost",
  "step.timeout",
  "step.ceiling_expiry",
  "step.respawned",
  "step.done",
  "step.failed",
  "step.retry",
  "step.rerouted",
]);

/**
 * One real isolated RVOC corridor through the do-now workflow: the scripted
 * pi worker claims the execute step and dies AFTER the claim (exit 1, no
 * report); the real scheduler recovers the claimed step (step.worker_lost +
 * step.respawned AFTER the recovery event) and the SAME step row is claimed
 * again and completes. Returns a report with real receipts + closure
 * evidence (mirror of the executor's ownership contract).
 */
async function runRvocCorridor(opts: { taskText: string }): Promise<any> {
  const ex = await loadExecutor();
  const sandbox = ex.createSandbox(EVIDENCE_ROOT, "sandbox-rvoc");
  const env = ex.buildIsolatedEnv({
    homeDir: sandbox.homeDir,
    controlPort: await ex.reserveRandomPort(),
    tmpdir: sandbox.root,
  });
  const controlPort = Number(env.TAMANDUA_CONTROL_PORT);
  const piBinary = ex.materializeRuntimeWrapper(sandbox, repoRoot, "pi");
  const behaviorsPath = path.join(sandbox.root, "behaviors.json");
  fs.writeFileSync(
    behaviorsPath,
    JSON.stringify(
      {
        defaultTokens: 0,
        heartbeatTokens: 0,
        agents: {
          [RVOC_AGENT]: [
            // work index 0: claim the execute step, then die without reporting
            { mode: "die-after-claim", exitCode: 1 },
            // work index 1: claim the SAME re-pended step again and complete
            { mode: "work", output: "STATUS: done\nREPORT: rvoc corridor replay complete" },
          ],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const daemonEnv = {
    ...env,
    TAMANDUA_PI_BINARY: piBinary,
    TAMANDUA_HERMES_BINARY: "/usr/bin/false",
    TAMANDUA_HARNESS_PROBE: "1", // probe enabled — no probe bypass
    TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
    TAMANDUA_SCRIPTED_STATE: sandbox.stateDir,
  };

  const report: any = {
    corridor: "rvoc_current_recovery_ordering",
    sandbox: sandbox.root,
    artifacts: {
      dbPath: sandbox.dbPath,
      stateDir: sandbox.stateDir,
      behaviorsPath,
      logPath: daemonLogPath(sandbox),
      eventsPath: null,
      invocationsPath: path.join(sandbox.stateDir, "invocations.jsonl"),
    },
    freshRunId: null,
    runStatus: null,
    daemonStop: null,
    launchStop: null,
    controlPortProbe: null,
    cleanup: null,
    error: null,
  };
  let daemon: any = null;
  let launch: any = null;
  let launchStopped = false;
  try {
    ex.installCorridorWorkflow({ repoRoot, env });
    daemon = ex.spawnIsolatedDaemon({ repoRoot, env: daemonEnv });
    await daemon.ready;

    launch = ex.launchWorkflowRun({
      repoRoot,
      env,
      taskText: opts.taskText,
      workdir: sandbox.workdir,
    });
    const runInfo = await launch.ready;
    report.freshRunId = await ex.resolveFullRunId(sandbox, runInfo.prefix);
    report.artifacts.eventsPath = path.join(sandbox.tamanduaDir, "events", `${report.freshRunId}.jsonl`);

    const launchStop = await launch.stop();
    launchStopped = true;
    report.launchStop = launchStop;
    if (launchStop.stopError) {
      throw new Error(`run-CLI launcher cleanup failure: ${launchStop.stopError}`);
    }

    report.runStatus = await ex.pollRunToTerminal({ repoRoot, env, runId: report.freshRunId, timeoutMs: 150000, nudgeMs: 600 });
    await sleep(1200);

    const { run, stats } = await readRunRow(sandbox, report.freshRunId);
    report.runRow = run;
    report.stats = stats;
    report.steps = await readSteps(sandbox, report.freshRunId);
    report.events = readRunEvents(sandbox, report.freshRunId);
    report.invocations = readInvocations(sandbox);
    report.logTail = (await readLogText(sandbox)).slice(-4000);
  } catch (e: unknown) {
    report.error = e instanceof Error ? { message: e.message, stack: e.stack } : String(e);
    throw e;
  } finally {
    if (launch && !launchStopped) {
      try {
        report.launchStop = await launch.stop();
        launchStopped = true;
      } catch (e) {
        report.launchStop = { stopError: e instanceof Error ? e.message : String(e) };
      }
    }
    if (daemon) {
      try {
        report.daemonStop = await ex.stopExactChild(daemon.child);
      } catch (e) {
        report.daemonStop = { stopError: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  // ── Cleanup / closure evidence ───────────────────────────────────
  const cleanupFailures: string[] = [];
  if (daemon) {
    if (daemon.spawnError()) {
      // daemon never spawned — no process/listener existed
    } else if (!report.daemonStop || !report.daemonStop.exitObserved || report.daemonStop.stopError) {
      cleanupFailures.push(`daemon shutdown not positively observed (${JSON.stringify(report.daemonStop)})`);
    } else {
      report.controlPortProbe = await ex.probePortClosed(controlPort);
      if (report.controlPortProbe.state !== "released") {
        cleanupFailures.push(
          `control listener release not positively evidenced (${report.controlPortProbe.state}: ${report.controlPortProbe.detail})`,
        );
      }
    }
  }
  if (report.launchStop) {
    if (report.launchStop.stopError) {
      cleanupFailures.push(`run-CLI launcher cleanup failure: ${report.launchStop.stopError}`);
    } else if (report.launchStop.exitObserved !== true && !report.launchStop.spawnError) {
      cleanupFailures.push("run-CLI launcher shutdown not positively observed");
    }
  }
  report.cleanup = { clean: cleanupFailures.length === 0, failures: cleanupFailures };
  if (report.error === null && !report.cleanup.clean) {
    report.error = { message: `cleanup failures: ${cleanupFailures.join("; ")}` };
  }
  return report;
}

/**
 * One real isolated reroute corridor (RCNT ordinary or synthetic terminal
 * control) through the two-step fixture workflow on the scripted pi runtime.
 * Returns a report with real receipts + closure evidence.
 */
async function runRerouteCorridor(opts: {
  corridor: "rcnt_ordinary_rebase_reroute" | "rcnt_synthetic_terminal_resolve" | "rcnt_synthetic_terminal_escalate";
  taskText: string;
}): Promise<any> {
  const ex = await loadExecutor();
  const sandbox = ex.createSandbox(EVIDENCE_ROOT, `sandbox-${opts.corridor}`);
  const env = ex.buildIsolatedEnv({
    homeDir: sandbox.homeDir,
    controlPort: await ex.reserveRandomPort(),
    tmpdir: sandbox.root,
  });
  const controlPort = Number(env.TAMANDUA_CONTROL_PORT);

  // ── Behavior sequences per corridor (per-agent work index) ──────
  // The single fixture agent runs: produce (#0), consume (#1), produce again
  // (#2 after a reroute), consume again (#3).
  const TERMINAL_FIRST =
    "FAILURE_CLASS: refused_permanent\nSynthetic terminal refusal (first) — explicitly synthetic terminal control, never the historical ordinary-rebase shape";
  const TERMINAL_SECOND =
    "FAILURE_CLASS: refused_permanent\nSynthetic terminal refusal (second) — terminal allowance exhausted";
  let behaviors: any[];
  if (opts.corridor === "rcnt_ordinary_rebase_reroute") {
    behaviors = [
      { mode: "work", output: "STATUS: done\nPRODUCED: pre-reroute" },
      // consumer completes with the recorded ordinary-rebase retry-verdict shape
      { mode: "work", output: "STATUS: retry\nREBASED: true\nRETRY_STEP: produce" },
      { mode: "work", output: "STATUS: done\nPRODUCED: post-reroute" },
      { mode: "work", output: "STATUS: done\nREBASED: false\nCONSUMED: landed" },
    ];
  } else if (opts.corridor === "rcnt_synthetic_terminal_resolve") {
    behaviors = [
      { mode: "work", output: "STATUS: done\nPRODUCED: pre-terminal" },
      { mode: "work", stepAction: "fail", failReason: TERMINAL_FIRST },
      { mode: "work", output: "STATUS: done\nPRODUCED: post-terminal" },
      { mode: "work", output: "STATUS: done\nREBASED: false\nCONSUMED: resolved-after-concession" },
    ];
  } else {
    behaviors = [
      { mode: "work", output: "STATUS: done\nPRODUCED: pre-terminal" },
      { mode: "work", stepAction: "fail", failReason: TERMINAL_FIRST },
      { mode: "work", output: "STATUS: done\nPRODUCED: post-terminal" },
      { mode: "work", stepAction: "fail", failReason: TERMINAL_SECOND },
    ];
  }

  const piBinary = ex.materializeRuntimeWrapper(sandbox, repoRoot, "pi");
  const behaviorsPath = path.join(sandbox.root, "behaviors.json");
  fs.writeFileSync(
    behaviorsPath,
    JSON.stringify({ defaultTokens: 0, heartbeatTokens: 0, agents: { [REROUTE_AGENT]: behaviors } }, null, 2),
    "utf-8",
  );

  const report: any = {
    corridor: opts.corridor,
    sandbox: sandbox.root,
    artifacts: {
      dbPath: sandbox.dbPath,
      stateDir: sandbox.stateDir,
      behaviorsPath,
      logPath: daemonLogPath(sandbox),
      eventsPath: null,
      invocationsPath: path.join(sandbox.stateDir, "invocations.jsonl"),
    },
    freshRunId: null,
    runStatus: null,
    daemonStop: null,
    launchStop: null,
    controlPortProbe: null,
    cleanup: null,
    error: null,
  };
  let daemon: any = null;
  let launch: any = null;
  let launchStopped = false;
  try {
    // Materialize + install the fixture corridor (real installer, isolated env).
    const catalogRoot = materializeRerouteFixture(sandbox);
    installRerouteFixture({ repoRoot, env, catalogRoot });
    report.artifacts.catalogRoot = catalogRoot;

    const daemonEnv = {
      ...env,
      TAMANDUA_PI_BINARY: piBinary,
      TAMANDUA_HERMES_BINARY: "/usr/bin/false",
      TAMANDUA_HARNESS_PROBE: "1", // probe enabled — no probe bypass
      TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
      TAMANDUA_SCRIPTED_STATE: sandbox.stateDir,
    };
    daemon = ex.spawnIsolatedDaemon({ repoRoot, env: daemonEnv });
    await daemon.ready;

    // Launch the FIXTURE workflow (same detached `workflow run` shape the
    // do-now corridor uses, but for the fixture id).
    const child = spawn(process.execPath, [
      CLI,
      "workflow", "run", REROUTE_FIXTURE_ID, opts.taskText,
      "--working-directory-for-harness", sandbox.workdir,
    ], { env });
    launch = ex.attachRunCliLifecycle({ child, readyTimeoutMs: 30000 });
    const runInfo = await launch.ready;
    report.freshRunId = await ex.resolveFullRunId(sandbox, runInfo.prefix);
    report.artifacts.eventsPath = path.join(sandbox.tamanduaDir, "events", `${report.freshRunId}.jsonl`);

    const launchStop = await launch.stop();
    launchStopped = true;
    report.launchStop = launchStop;
    if (launchStop.stopError) {
      throw new Error(`run-CLI launcher cleanup failure: ${launchStop.stopError}`);
    }

    report.runStatus = await ex.pollRunToTerminal({ repoRoot, env, runId: report.freshRunId, timeoutMs: 180000, nudgeMs: 600 });
    await sleep(1200);

    const { run, stats } = await readRunRow(sandbox, report.freshRunId);
    report.runRow = run;
    report.stats = stats;
    report.steps = await readSteps(sandbox, report.freshRunId);
    report.events = readRunEvents(sandbox, report.freshRunId);
    report.invocations = readInvocations(sandbox);
    report.logTail = (await readLogText(sandbox)).slice(-4000);
  } catch (e: unknown) {
    report.error = e instanceof Error ? { message: e.message, stack: e.stack } : String(e);
    throw e;
  } finally {
    if (launch && !launchStopped) {
      try {
        report.launchStop = await launch.stop();
        launchStopped = true;
      } catch (e) {
        report.launchStop = { stopError: e instanceof Error ? e.message : String(e) };
      }
    }
    if (daemon) {
      try {
        report.daemonStop = await ex.stopExactChild(daemon.child);
      } catch (e) {
        report.daemonStop = { stopError: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  // ── Cleanup / closure evidence ───────────────────────────────────
  const cleanupFailures: string[] = [];
  if (daemon) {
    if (daemon.spawnError()) {
      // daemon never spawned — no process/listener existed
    } else if (!report.daemonStop || !report.daemonStop.exitObserved || report.daemonStop.stopError) {
      cleanupFailures.push(`daemon shutdown not positively observed (${JSON.stringify(report.daemonStop)})`);
    } else {
      report.controlPortProbe = await ex.probePortClosed(controlPort);
      if (report.controlPortProbe.state !== "released") {
        cleanupFailures.push(
          `control listener release not positively evidenced (${report.controlPortProbe.state}: ${report.controlPortProbe.detail})`,
        );
      }
    }
  }
  if (report.launchStop) {
    if (report.launchStop.stopError) {
      cleanupFailures.push(`run-CLI launcher cleanup failure: ${report.launchStop.stopError}`);
    } else if (report.launchStop.exitObserved !== true && !report.launchStop.spawnError) {
      cleanupFailures.push("run-CLI launcher shutdown not positively observed");
    }
  }
  report.cleanup = { clean: cleanupFailures.length === 0, failures: cleanupFailures };
  if (report.error === null && !report.cleanup.clean) {
    report.error = { message: `cleanup failures: ${cleanupFailures.join("; ")}` };
  }
  return report;
}

describe("CORE-CELLS US-004 — RVOC same-step recovery/respawn ordering and RCNT class-specific reroute counters", () => {
  it("RVOC source facts are preserved: two same-row claims surround worker_lost; no dedicated step.respawned historically (worker_lost acknowledged); no private-source dependency", async () => {
    const assets = await loadAssets();
    const asset = assets.loadRvocAsset();
    assert.equal(asset.caseId, "W4.10-kill-daemon");
    assert.equal(asset.sourceIdentity.runId, "59e8e12c-2a7e-438d-aa48-6a3b99abb750");
    const blob = JSON.stringify(asset);
    const check = assets.assertNoPrivateSourceDependency(blob);
    assert.equal(check.ok, true, `asset depends on a private location (${check.marker ?? "?"})`);
    for (const marker of ["igorhvr", "/home/", "file:///home", "sk-", "ghp_", "BEGIN PRIVATE KEY"]) {
      assert.equal(blob.includes(marker), false, `asset must not contain private marker ${marker}`);
    }

    const h = asset.historical;
    // The archived fix-cell lifecycle: two successful same-row claims
    // surround step.worker_lost; NO dedicated step.respawned in the stream.
    assert.deepEqual(
      h.archivedFixCellEvents.map((e: any) => `${e.event}@${e.ts}`),
      [
        "step.running@2026-09-01T12:15:24.982Z",
        "step.worker_lost@2026-09-01T12:15:31.873Z",
        "step.running@2026-09-01T12:15:34.262Z",
      ],
      "archived fix-cell stream must read running -> worker_lost -> running",
    );
    assert.equal(
      h.archivedFixCellEvents.some((e: any) => e.event === "step.respawned"),
      false,
      "NO dedicated step.respawned exists in the archived stream (source-backed)",
    );
    // worker_lost acknowledged as the connecting event that DID exist.
    assert.equal(
      h.archivedFixCellEvents.some((e: any) => e.event === "step.worker_lost"),
      true,
      "step.worker_lost existed and is acknowledged as the connecting event",
    );
    assert.match(h.interpretation, /step\.worker_lost already existed/);
    assert.match(h.interpretation, /does not erase those recovery events/);
    // The recovered step row + native same-row claim evidence.
    assert.equal(h.archivedStepRow.id, "7ae14b30-1e14-462f-84bf-eb1d8d97f72b");
    assert.equal(h.archivedStepRow.retryCount, 1);
    assert.equal(h.nativeClaims.bothContainSameStepRowAndRun, true);
    assert.equal(h.nativeClaims.sessionFiles.length, 2);
    assert.equal(h.nativeClaims.sessionFiles[0].commandSha256, h.nativeClaims.sessionFiles[1].commandSha256,
      "both archived claims use the identical step-claim command digest");
    // Historical O10 context is recorded, never replayed as an oracle here.
    assert.equal(h.oracleFinding.observed, 2);
    assert.equal(h.oracleFinding.expected, 1);

    // Deterministic source digest.
    assert.equal(asset.sourceSha256.length, 64);
    assert.equal(asset.sourceSha256, assets.rvocSpecimenSourceSha256());

    // Current corridor expected values declared.
    assert.equal(asset.corridors.rvoc_current_recovery_ordering.expected.respawnedAfterRecoveryEvent, true);
    assert.equal(asset.corridors.rvoc_current_recovery_ordering.expected.workerLostCount, 1);
    // No equality-rule / no-connecting-event shorthand language anywhere: the
    // only occurrence of the old shorthand is inside the explicit DISCLAIMER
    // that instructs agents not to repeat it.
    assert.match(h.interpretation, /Do NOT repeat the old shorthand that there was no connecting event at all/);
    const disclaimerOnly = blob.split("Do NOT repeat the old shorthand that there was no connecting event at all").length - 1;
    assert.equal(disclaimerOnly, 1, "the old shorthand must appear only inside the disclaimer, never as a claim");
    assert.equal(/reroute_count\s*===?\s*terminal_reroute_count/.test(blob), false, "no all-reroutes-equal-terminal equality rule in the asset");
  });

  it("RCNT source facts are preserved: ordinary rebase reroute consumed the general count only; terminal allowance intact; no private-source dependency", async () => {
    const assets = await loadAssets();
    const asset = assets.loadRcntAsset();
    assert.equal(asset.caseId, "W4.10-restart-recovery");
    assert.equal(asset.sourceIdentity.runId, "f60941b9-6b36-403d-9730-2c7805c8eb7b");
    const blob = JSON.stringify(asset);
    const check = assets.assertNoPrivateSourceDependency(blob);
    assert.equal(check.ok, true, `asset depends on a private location (${check.marker ?? "?"})`);
    for (const marker of ["igorhvr", "/home/", "file:///home", "sk-", "ghp_", "BEGIN PRIVATE KEY"]) {
      assert.equal(blob.includes(marker), false, `asset must not contain private marker ${marker}`);
    }

    const h = asset.historical;
    // Archived counters: ordinary rebase reroute consumed reroute_count only.
    const fmRow = h.archivedStepRows.find((r: any) => r.stepId === "finalize_merge");
    assert.ok(fmRow, "finalize_merge row must exist");
    assert.equal(fmRow.rerouteCount, 1);
    assert.equal(fmRow.terminalRerouteCount, 0);
    assert.equal(fmRow.status, "done");
    assert.equal(fmRow.landedCommit, "540c3dda56a3e168d5656bf8505b8b3837c18549");
    // Native ordinary-rebase identification.
    assert.deepEqual(h.nativeMergerSource.keyLines, ["STATUS: retry", "REBASED: true"]);
    assert.equal(
      h.nativeMergerSource.toolResultText,
      '{"status":"rerouted","detail":"STATUS: retry verdict — rerouted to upstream producer via on_fail.retry_step"}\nCOMPLETE_EXIT=0',
    );
    // Interpretation: old equality oracle was wrong; terminal allowance preserved.
    assert.match(h.interpretation, /ORDINARY rebase/);
    assert.match(h.interpretation, /all-reroutes-consume-terminal-budget rule/);
    // No equality-rule text anywhere in the serialized asset.
    assert.equal(/reroute_count\s*===?\s*terminal_reroute_count/.test(blob), false, "no all-reroutes-equal-terminal equality rule in the asset");

    assert.equal(asset.sourceSha256.length, 64);
    assert.equal(asset.sourceSha256, assets.rcntSpecimenSourceSha256());

    // Corridor declarations: the synthetic terminal control is EXPLICITLY labeled.
    assert.equal(
      asset.corridors.synthetic_terminal_control.classification,
      "synthetic",
    );
    assert.match(
      asset.corridors.synthetic_terminal_control.label,
      /EXPLICITLY SYNTHETIC TERMINAL CONTROL/,
    );
    assert.equal(asset.corridors.ordinary_rebase_reroute.expected.terminalRerouteCount, 0);
    assert.equal(asset.corridors.ordinary_rebase_reroute.expected.rerouteCount, 1);
  });

  it("RVOC corridor: same-step recovery/respawn ordering through the real isolated motor (two same-row claims surround worker_lost; respawned AFTER the recovery event)", async () => {
    assert.equal(distBuilt(), true, "dist must be built before running the real-daemon designated gate");
    const assets = await loadAssets();
    assert.equal(
      assets.loadRvocAsset().corridors.rvoc_current_recovery_ordering.expected.runStatus,
      "completed",
    );
    const taskText =
      "Synthetic zero-token RVOC corridor replay of W4.10-kill-daemon (source run " +
      "59e8e12c-2a7e-438d-aa48-6a3b99abb750): the scripted pi worker claims the " +
      "execute step and dies after the claim; the real motor recovers the same " +
      "step row (worker_lost + respawned) and it is claimed again and completed. " +
      "No real credentials/provider/network.";
    // eslint-disable-next-line no-console
    console.log(`[rvoc-rcnt-cell] RVOC corridor (evidence root ${EVIDENCE_ROOT})`);
    const report = await runRvocCorridor({ taskText });
    const evidenceDir = path.join(EVIDENCE_ROOT, "rvoc");
    writeJson(path.join(evidenceDir, "case-report.json"), {
      corridor: report.corridor,
      freshRunId: report.freshRunId,
      runStatus: report.runStatus,
      runRow: report.runRow,
      steps: report.steps,
      artifacts: report.artifacts,
      cleanup: report.cleanup,
      daemonStop: report.daemonStop,
      controlPortProbe: report.controlPortProbe,
      error: report.error,
    });

    assert.equal(report.cleanup.clean, true, `RVOC cleanup unclean: ${report.cleanup.failures.join("; ")}`);
    assert.ok(report.freshRunId, "fresh run id missing");
    assert.notEqual(report.freshRunId, assets.loadRvocAsset().sourceIdentity.runId, "fresh run id must never equal the historical uuid");

    // ── Run/DB state.
    assert.equal(report.runStatus, "completed");
    assert.equal(report.runRow.harness_probe_status, "ok", "launch probe must pass");
    assert.equal(report.runRow.worker_lost_count, 1, "exactly one worker_lost recovery");
    assert.equal(report.runRow.tokens_spent, 0, "runs.tokens_spent must be 0");
    assert.equal(report.stats?.system_tokens_spent ?? 0, 0, "tamandua_stats.system_tokens_spent must be 0");
    assert.equal(report.steps.length, 1, "one execute step row");
    const stepRow = report.steps[0];
    assert.equal(stepRow.step_id, "execute");
    assert.equal(stepRow.status, "done");
    assert.equal(stepRow.retry_count, 1, "recovered step retry_count must be 1 (matches the archived fix row)");

    // ── Event ordering: running -> worker_lost -> respawned -> running -> done
    //    on the SAME step (current product adds respawned AFTER the recovery
    //    event; the file never claims respawned existed historically).
    const events = report.events ?? [];
    const probeOk = events.filter((e: any) => e.event === "run.harness_probe_ok");
    assert.equal(probeOk.length, 1, "exactly one run.harness_probe_ok");
    const lifecycle = events
      .filter((e: any) => e.stepId === "execute")
      .filter((e: any) => STEP_LIFECYCLE_EVENTS.has(e.event))
      .map((e: any) => e.event);
    assert.deepEqual(
      lifecycle,
      ["step.running", "step.worker_lost", "step.respawned", "step.running", "step.done"],
      "stream must read step.running -> step.worker_lost -> step.respawned -> step.running -> step.done",
    );
    const workerLost = events.filter((e: any) => e.event === "step.worker_lost");
    assert.equal(workerLost.length, 1);
    assert.equal(workerLost[0].runId, report.freshRunId, "worker_lost must bind the FRESH run");
    const respawned = events.filter((e: any) => e.event === "step.respawned");
    assert.equal(respawned.length, 1, "exactly one step.respawned (current behavior)");
    const r = respawned[0];
    assert.equal(r.runId, report.freshRunId, "respawned must bind the FRESH run");
    assert.equal(r.stepId, "execute");
    assert.equal(r.agentId, RVOC_AGENT);
    assert.equal(r.reason, "worker_lost", "respawned reason must be the recovery class");
    assert.equal(r.retry, 1, "respawned retry must be the new retry count");
    assert.ok(Number.isInteger(r.priorPid) && r.priorPid > 0, "respawned priorPid must be the recovered claim pid");
    assert.ok(typeof r.priorRound === "string" && r.priorRound.length > 0, "respawned priorRound must be the recovered claim round");
    assert.equal(events.filter((e: any) => e.event === "step.failed").length, 0, "no step failure");
    assert.equal(events.filter((e: any) => e.event === "run.failed").length, 0, "run must not fail");

    // ── Same-step identity: both work rounds claimed the SAME fresh step row.
    const invocations = report.invocations ?? [];
    const workRows = invocations.filter((i: any) => i.phase === "work" && i.runId && stripIdPrefix(i.runId) === report.freshRunId);
    assert.equal(workRows.length, 2, "exactly two work rounds (claim#1 and claim#2)");
    assert.deepEqual(workRows.map((i: any) => i.workIndex).sort((a: number, b: number) => a - b), [0, 1], "contiguous work indices");
    assert.deepEqual(workRows.map((i: any) => i.mode), ["die-after-claim", "work"], "round#1 claims then dies; round#2 completes");
    for (const row of workRows) {
      assert.equal(
        stripIdPrefix(row.stepId),
        stripIdPrefix(stepRow.id),
        "every claim must bind the SAME fresh step row (same-step identity)",
      );
    }
    // No event/invocation anywhere binds the historical uuid.
    const normFresh = stripIdPrefix(report.freshRunId);
    const histRun = assets.loadRvocAsset().sourceIdentity.runId;
    assert.equal(events.some((e: any) => stripIdPrefix(e.runId ?? "") === histRun), false, "no event binds the historical run id");
    assert.equal(invocations.some((i: any) => stripIdPrefix(i.runId ?? "") === histRun), false, "no invocation binds the historical run id");
    assert.notEqual(normFresh, histRun);

    writeJson(path.join(evidenceDir, "receipts-summary.json"), {
      runStatus: report.runStatus,
      freshRunId: report.freshRunId,
      workerLostCount: report.runRow.worker_lost_count,
      respawnedEvents: respawned.length,
      stepRetryCount: stepRow.retry_count,
      lifecycle,
      workRows: workRows.map((i: any) => ({ workIndex: i.workIndex, mode: i.mode, stepId: i.stepId })),
      tokens: { runs: report.runRow.tokens_spent, system: report.stats?.system_tokens_spent ?? 0 },
    });
  });

  it("RCNT ordinary rebase corridor: an accepted STATUS: retry / REBASED: true reroute increments reroute_count only (terminal_reroute_count stays 0) and the run is NOT failed", async () => {
    assert.equal(distBuilt(), true, "dist must be built before running the real-daemon designated gate");
    const assets = await loadAssets();
    const asset = assets.loadRcntAsset();
    const corridorSpec = asset.corridors.ordinary_rebase_reroute;
    const taskText =
      "Synthetic zero-token RCNT ordinary-rebase reroute corridor replay of " +
      "W4.10-restart-recovery (source run " +
      "f60941b9-6b36-403d-9730-2c7805c8eb7b): the fixture consumer completes " +
      "with the recorded ordinary-rebase retry-verdict shape (STATUS: retry / " +
      "REBASED: true) and is rerouted to its upstream producer via " +
      "on_fail.retry_step; reroute_count 1 / terminal_reroute_count 0 and the " +
      "run completes. No real credentials/provider/network.";
    // eslint-disable-next-line no-console
    console.log(`[rvoc-rcnt-cell] RCNT ordinary-rebase corridor (evidence root ${EVIDENCE_ROOT})`);
    const report = await runRerouteCorridor({ corridor: "rcnt_ordinary_rebase_reroute", taskText });
    const evidenceDir = path.join(EVIDENCE_ROOT, "rcnt-ordinary");
    writeJson(path.join(evidenceDir, "case-report.json"), {
      corridor: report.corridor,
      freshRunId: report.freshRunId,
      runStatus: report.runStatus,
      runRow: report.runRow,
      steps: report.steps,
      artifacts: report.artifacts,
      cleanup: report.cleanup,
      daemonStop: report.daemonStop,
      controlPortProbe: report.controlPortProbe,
      adaptationNote: corridorSpec.adaptationNote,
      error: report.error,
    });

    assert.equal(report.cleanup.clean, true, `RCNT ordinary cleanup unclean: ${report.cleanup.failures.join("; ")}`);
    assert.ok(report.freshRunId, "fresh run id missing");
    assert.notEqual(report.freshRunId, asset.sourceIdentity.runId, "fresh run id must never equal the historical uuid");

    // ── Run/DB state: run completed, probe ok, zero tokens.
    assert.equal(report.runStatus, "completed", "ordinary rebase reroute must NOT fail the run");
    assert.equal(report.runRow.harness_probe_status, "ok");
    assert.equal(report.runRow.tokens_spent, 0, "runs.tokens_spent must be 0");
    assert.equal(report.stats?.system_tokens_spent ?? 0, 0, "tamandua_stats.system_tokens_spent must be 0");

    // ── Class-specific counters on the fixture steps.
    const produceRow = report.steps.find((s: any) => s.step_id === "produce");
    const consumeRow = report.steps.find((s: any) => s.step_id === "consume");
    assert.ok(produceRow && consumeRow, "produce + consume rows must exist");
    assert.equal(produceRow.status, "done");
    assert.match(produceRow.output ?? "", /PRODUCED: post-reroute/, "the producer must have rerun after the reroute");
    assert.equal(consumeRow.status, "done");
    assert.equal(consumeRow.reroute_count, 1, "ordinary rebase reroute increments the GENERAL counter");
    assert.equal(consumeRow.terminal_reroute_count, 0, "ordinary rebase reroute must NOT consume the terminal allowance");
    assert.equal(consumeRow.retry_count, 0, "reroute resets the consumer retry_count");
    assert.match(consumeRow.output ?? "", /CONSUMED: landed/, "the consumer must complete on its second claim");

    // ── Event-level: exactly one step.rerouted with terminal:false.
    const events = report.events ?? [];
    const rerouted = events.filter((e: any) => e.event === "step.rerouted");
    assert.equal(rerouted.length, 1, "exactly one step.rerouted for the ordinary rebase reroute");
    assert.equal(rerouted[0].stepId, "consume");
    assert.equal(rerouted[0].runId, report.freshRunId, "rerouted event must bind the FRESH run");
    assert.equal(rerouted[0].terminal, false, "ordinary reroute is terminal:false");
    assert.equal(rerouted[0].rerouteMode, "legacy", "no FAILURE_CLASS -> legacy (ordinary) reroute mode");
    // PORT US-008: the base product labels the reroute budget explicitly
    // ("reroute 1/8" / "target-moved reroute N/M" — base commit f685bea9
    // "separate target_moved reroute budget and truthful landing report"),
    // so the detail now reads "Rerouted to produce (reroute 1/8). ...".
    assert.match(rerouted[0].detail ?? "", /Rerouted to produce \(reroute 1\/8\)/, "reroute detail names the upstream producer and budget");
    assert.match(rerouted[0].detail ?? "", /STATUS: retry/, "reroute detail carries the recorded retry-verdict reason");
    assert.equal(events.filter((e: any) => e.event === "step.retry").length, 0, "max_retries 0 -> direct reroute, no in-step retry");
    assert.equal(events.filter((e: any) => e.event === "step.failed").length, 0);
    assert.equal(events.filter((e: any) => e.event === "run.failed").length, 0);

    // ── Real claim sequence: produce, consume, produce (rerun), consume.
    const invocations = report.invocations ?? [];
    const workRows = invocations
      .filter((i: any) => i.phase === "work" && i.runId && stripIdPrefix(i.runId) === report.freshRunId)
      .sort((a: any, b: any) => a.workIndex - b.workIndex);
    assert.equal(workRows.length, 4, "four work rounds total");
    const rowOf = (rowId: string) => stripIdPrefix(rowId);
    assert.deepEqual(
      workRows.map((i: any) => rowOf(i.stepId)),
      [rowOf(produceRow.id), rowOf(consumeRow.id), rowOf(produceRow.id), rowOf(consumeRow.id)],
      "claims must alternate produce -> consume -> produce (rerun) -> consume on the SAME step rows",
    );
    assert.deepEqual(workRows.map((i: any) => i.workIndex), [0, 1, 2, 3], "contiguous work indices");
    const histRun = asset.sourceIdentity.runId;
    assert.equal(events.some((e: any) => stripIdPrefix(e.runId ?? "") === histRun), false, "no event binds the historical run id");
    assert.equal(invocations.some((i: any) => stripIdPrefix(i.runId ?? "") === histRun), false, "no invocation binds the historical run id");

    writeJson(path.join(evidenceDir, "receipts-summary.json"), {
      runStatus: report.runStatus,
      freshRunId: report.freshRunId,
      produceRow: { id: produceRow.id, status: produceRow.status, output: produceRow.output },
      consumeRow: {
        id: consumeRow.id,
        status: consumeRow.status,
        reroute_count: consumeRow.reroute_count,
        terminal_reroute_count: consumeRow.terminal_reroute_count,
        retry_count: consumeRow.retry_count,
        output: consumeRow.output,
      },
      reroutedEvents: rerouted.map((e: any) => ({ stepId: e.stepId, terminal: e.terminal, rerouteMode: e.rerouteMode, detail: e.detail })),
      tokens: { runs: report.runRow.tokens_spent, system: report.stats?.system_tokens_spent ?? 0 },
    });
  });

  it("RCNT synthetic terminal control (resolve): a terminal-class refusal consumes the one-shot terminal allowance and reroutes WITHOUT failing the run", async () => {
    assert.equal(distBuilt(), true, "dist must be built before running the real-daemon designated gate");
    const assets = await loadAssets();
    const asset = assets.loadRcntAsset();
    const terminalSpec = asset.corridors.synthetic_terminal_control;
    assert.equal(terminalSpec.classification, "synthetic");
    const taskText =
      "EXPLICITLY SYNTHETIC terminal control (never the historical ordinary-rebase " +
      "shape): the fixture consumer fails once with FAILURE_CLASS: refused_permanent; " +
      "the terminal-class reroute consumes the one-shot terminal allowance " +
      "(terminal_reroute_count 1) and reroutes to the producer WITHOUT failing the " +
      "run; the producer reruns and the consumer resolves. Source run " +
      "f60941b9-6b36-403d-9730-2c7805c8eb7b is provenance only.";
    // eslint-disable-next-line no-console
    console.log(`[rvoc-rcnt-cell] RCNT synthetic terminal control — resolve (evidence root ${EVIDENCE_ROOT})`);
    const report = await runRerouteCorridor({ corridor: "rcnt_synthetic_terminal_resolve", taskText });
    const evidenceDir = path.join(EVIDENCE_ROOT, "rcnt-terminal-resolve");
    writeJson(path.join(evidenceDir, "case-report.json"), {
      corridor: report.corridor,
      classification: "synthetic",
      freshRunId: report.freshRunId,
      runStatus: report.runStatus,
      runRow: report.runRow,
      steps: report.steps,
      artifacts: report.artifacts,
      cleanup: report.cleanup,
      daemonStop: report.daemonStop,
      controlPortProbe: report.controlPortProbe,
      error: report.error,
    });

    assert.equal(report.cleanup.clean, true, `terminal-resolve cleanup unclean: ${report.cleanup.failures.join("; ")}`);
    assert.ok(report.freshRunId, "fresh run id missing");
    assert.notEqual(report.freshRunId, asset.sourceIdentity.runId);

    // ── Run/DB state: the run was NOT failed by the terminal reroute.
    assert.equal(report.runStatus, "completed", "a terminal-class reroute consumes the allowance and does NOT fail the run");
    assert.equal(report.runRow.harness_probe_status, "ok");
    assert.equal(report.runRow.tokens_spent, 0);
    assert.equal(report.stats?.system_tokens_spent ?? 0, 0);

    const produceRow = report.steps.find((s: any) => s.step_id === "produce");
    const consumeRow = report.steps.find((s: any) => s.step_id === "consume");
    assert.ok(produceRow && consumeRow);
    assert.equal(produceRow.status, "done");
    assert.match(produceRow.output ?? "", /PRODUCED: post-terminal/, "producer reran after the terminal reroute");
    assert.equal(consumeRow.status, "done");
    assert.equal(consumeRow.terminal_reroute_count, 1, "the terminal-class reroute consumes the terminal allowance");
    assert.equal(consumeRow.reroute_count, 1, "terminal reroute also counts against the general counter");
    assert.equal(consumeRow.retry_count, 0);

    const events = report.events ?? [];
    const rerouted = events.filter((e: any) => e.event === "step.rerouted");
    assert.equal(rerouted.length, 1);
    assert.equal(rerouted[0].stepId, "consume");
    assert.equal(rerouted[0].terminal, true, "terminal-class reroute event must be terminal:true");
    assert.equal(rerouted[0].rerouteMode, "terminal");
    assert.match(rerouted[0].detail ?? "", /FAILURE_CLASS: refused_permanent/);
    assert.equal(events.filter((e: any) => e.event === "run.failed").length, 0, "run must not fail after a single terminal refusal");
    assert.equal(events.filter((e: any) => e.event === "step.failed").length, 0);
  });

  it("RCNT synthetic terminal control (escalate): a second terminal refusal exhausts the one-shot allowance and fails the run with NO second reroute", async () => {
    assert.equal(distBuilt(), true, "dist must be built before running the real-daemon designated gate");
    const assets = await loadAssets();
    const asset = assets.loadRcntAsset();
    const taskText =
      "EXPLICITLY SYNTHETIC terminal control (never the historical ordinary-rebase " +
      "shape): the fixture consumer fails twice with FAILURE_CLASS: refused_permanent. " +
      "The first terminal-class reroute consumes the one-shot terminal allowance; " +
      "the second terminal refusal exhausts it and fails the run with NO second " +
      "reroute. Source run f60941b9-6b36-403d-9730-2c7805c8eb7b is provenance only.";
    // eslint-disable-next-line no-console
    console.log(`[rvoc-rcnt-cell] RCNT synthetic terminal control — escalate (evidence root ${EVIDENCE_ROOT})`);
    const report = await runRerouteCorridor({ corridor: "rcnt_synthetic_terminal_escalate", taskText });
    const evidenceDir = path.join(EVIDENCE_ROOT, "rcnt-terminal-escalate");
    writeJson(path.join(evidenceDir, "case-report.json"), {
      corridor: report.corridor,
      classification: "synthetic",
      freshRunId: report.freshRunId,
      runStatus: report.runStatus,
      runRow: report.runRow,
      steps: report.steps,
      artifacts: report.artifacts,
      cleanup: report.cleanup,
      daemonStop: report.daemonStop,
      controlPortProbe: report.controlPortProbe,
      error: report.error,
    });

    assert.equal(report.cleanup.clean, true, `terminal-escalate cleanup unclean: ${report.cleanup.failures.join("; ")}`);
    assert.ok(report.freshRunId, "fresh run id missing");
    assert.notEqual(report.freshRunId, asset.sourceIdentity.runId);

    // ── Run/DB state: failed only on the SECOND terminal refusal.
    assert.equal(report.runStatus, "failed", "the second terminal refusal must fail the run");
    assert.equal(report.runRow.harness_probe_status, "ok");
    assert.equal(report.runRow.tokens_spent, 0);
    assert.equal(report.stats?.system_tokens_spent ?? 0, 0);

    const produceRow = report.steps.find((s: any) => s.step_id === "produce");
    const consumeRow = report.steps.find((s: any) => s.step_id === "consume");
    assert.ok(produceRow && consumeRow);
    assert.equal(produceRow.status, "done", "the producer reran after the first (successful) terminal reroute");
    assert.match(produceRow.output ?? "", /PRODUCED: post-terminal/);
    assert.equal(consumeRow.status, "failed");
    assert.equal(consumeRow.terminal_reroute_count, 1, "terminal allowance consumed exactly once");
    assert.equal(consumeRow.reroute_count, 1, "no second reroute happened after the allowance was exhausted");
    assert.equal(consumeRow.retry_count, 1, "final failure retry_count");
    assert.match(consumeRow.output ?? "", /refused_permanent/);

    // ── Events: exactly ONE step.rerouted (terminal:true); step.failed +
    //    run.failed carry the SECOND refusal.
    const events = report.events ?? [];
    const rerouted = events.filter((e: any) => e.event === "step.rerouted");
    assert.equal(rerouted.length, 1, "no second reroute may occur after the allowance is exhausted");
    assert.equal(rerouted[0].stepId, "consume");
    assert.equal(rerouted[0].terminal, true);
    assert.equal(rerouted[0].rerouteMode, "terminal");
    const stepFailed = events.filter((e: any) => e.event === "step.failed");
    const runFailed = events.filter((e: any) => e.event === "run.failed");
    assert.equal(stepFailed.length, 1, "exactly one step.failed");
    assert.equal(runFailed.length, 1, "exactly one run.failed");
    assert.match(stepFailed[0].detail ?? "", /refused_permanent/);
    assert.match(stepFailed[0].detail ?? "", /second/, "step.failed detail must carry the second refusal");
    assert.match(runFailed[0].detail ?? "", /refused_permanent/);

    writeJson(path.join(evidenceDir, "receipts-summary.json"), {
      runStatus: report.runStatus,
      freshRunId: report.freshRunId,
      consumeRow: {
        status: consumeRow.status,
        reroute_count: consumeRow.reroute_count,
        terminal_reroute_count: consumeRow.terminal_reroute_count,
        retry_count: consumeRow.retry_count,
      },
      reroutedEvents: rerouted.map((e: any) => ({ stepId: e.stepId, terminal: e.terminal, rerouteMode: e.rerouteMode })),
      stepFailedDetails: stepFailed.map((e: any) => e.detail),
      runFailedDetails: runFailed.map((e: any) => e.detail),
      tokens: { runs: report.runRow.tokens_spent, system: report.stats?.system_tokens_spent ?? 0 },
    });
  });

  it("retained evidence root holds real receipts, daemon logs and closure records for every corridor", async () => {
    for (const dir of ["rvoc", "rcnt-ordinary", "rcnt-terminal-resolve", "rcnt-terminal-escalate"]) {
      const caseReportPath = path.join(EVIDENCE_ROOT, dir, "case-report.json");
      assert.ok(fs.existsSync(caseReportPath), `${dir} case report missing`);
      const caseReport = JSON.parse(fs.readFileSync(caseReportPath, "utf-8"));
      assert.equal(caseReport.cleanup.clean, true, `${dir} cleanup not clean`);
      assert.ok(caseReport.freshRunId, `${dir} fresh run id missing`);
      assert.equal(caseReport.runRow.id, caseReport.freshRunId, `${dir} DB run row must bind the fresh run id`);
      const dbPath = caseReport.artifacts?.dbPath;
      assert.ok(dbPath && fs.existsSync(dbPath), `${dir} isolated DB must be retained`);
      const eventsPath = caseReport.artifacts?.eventsPath;
      assert.ok(eventsPath && fs.existsSync(eventsPath), `${dir} per-run events file must be retained`);
      const logPath = caseReport.artifacts?.logPath;
      assert.ok(logPath && fs.existsSync(logPath), `${dir} daemon log must be retained`);
      const eventsText = fs.readFileSync(eventsPath, "utf-8");
      if (dir === "rvoc") {
        assert.match(eventsText, /step\.worker_lost/, "rvoc events must retain the worker_lost receipt");
        assert.match(eventsText, /step\.respawned/, "rvoc events must retain the respawned receipt");
      } else if (dir === "rcnt-ordinary") {
        assert.match(eventsText, /step\.rerouted/, "rcnt-ordinary events must retain the reroute receipt");
      } else {
        assert.match(eventsText, /step\.rerouted/, `${dir} events must retain the terminal reroute receipt`);
      }
    }
  });

  it("evidence summary written with git head, per-corridor results and honesty labels", async () => {
    const assets = await loadAssets();
    const rvocAsset = assets.loadRvocAsset();
    const rcntAsset = assets.loadRcntAsset();
    const summary = {
      evidenceRoot: EVIDENCE_ROOT,
      gitHead: gitHead(),
      rvoc: {
        caseId: rvocAsset.caseId,
        historicalRunId: rvocAsset.sourceIdentity.runId,
        historicallyNoDedicatedRespawned: true, // source-backed
        workerLostAcknowledgedAsConnectingEvent: true, // source-backed
        currentRespawnedAfterRecoveryEvent: true, // current-product corridor expectation
      },
      rcnt: {
        caseId: rcntAsset.caseId,
        historicalRunId: rcntAsset.sourceIdentity.runId,
        ordinaryRebaseRerouteCount: 1,
        ordinaryRebaseTerminalRerouteCount: 0,
        terminalControlLabel: rcntAsset.corridors.synthetic_terminal_control.label,
      },
      corridors: {
        rvoc: "completed",
        "rcnt-ordinary": "completed",
        "rcnt-terminal-resolve": "completed",
        "rcnt-terminal-escalate": "failed (expected)",
      },
    };
    writeJson(path.join(EVIDENCE_ROOT, "cells-summary.json"), summary);
    assert.equal(summary.rvoc.historicalRunId, "59e8e12c-2a7e-438d-aa48-6a3b99abb750");
    assert.equal(summary.rcnt.historicalRunId, "f60941b9-6b36-403d-9730-2c7805c8eb7b");
  });
});

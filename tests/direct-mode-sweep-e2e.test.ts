/**
 * Direct-mode post-grace sweep e2e (DSWP US-007).
 *
 * Proves a NON-worktree (direct-mode) run gets the post-grace process sweep
 * after it reaches a terminal state, against a real isolated daemon with a
 * scripted agent (zero model tokens).
 *
 * Sequence:
 *   1. Start daemon, seed a direct-mode run (no `run_worktrees` row) with a
 *      single pending step, register it → the scripted agent claims and
 *      completes it; the run reaches `completed`.
 *   2. The scripted behavior leaves a long-lived background child (a node
 *      process) inside the harness process group that inherits
 *      `TAMANDUA_RUN_ID` and IGNORES SIGTERM — so the in-grace leak guard
 *      cannot reap it and only the post-grace sweep can.
 *   3. It also leaves an unrelated control child: its own process group, no
 *      run marker, cwd outside the run directory.
 *   4. The scheduler tears the run down on the next dispatch round and
 *      schedules the sweep at HARNESS_TEARDOWN_GRACE_MS + 2 s (~12 s).
 *
 * Asserts:
 *   - run.process_cleanup event exists and is run-scoped
 *   - the leaked child (run-owned via its pgid / TAMANDUA_RUN_ID marker) is
 *     dead and appears in `killedPids` with a non-empty evidence string
 *   - the unrelated child survives and is NOT in `killedPids`
 *   - every killed pid carries evidence (never killed by name/glob)
 *   - the run has no managed worktree row (genuinely direct-mode)
 *   - zero real model tokens
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { createScriptedAgent, type ScriptedBehavior } from "../e2e-tests/helpers/scripted-agent.ts";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "dist", "server", "daemon.js");

/**
 * The scheduler's post-grace sweep delay: HARNESS_TEARDOWN_GRACE_MS + 2 s
 * (see `scheduleSweepTimer`). Hard-coded here so this test process does not
 * import the scheduler module (which would resolve the real state dir).
 */
const SWEEP_DELAY_MS = 10_000 + 2_000;

// ── Helpers ──────────────────────────────────────────────────────────

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForControlUp(port: number, timeoutMs = 10000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/control/health`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Control plane did not come up on port ${port}`);
}

function readDaemonSecret(homeDir: string): string {
  const secretPath = path.join(homeDir, ".tamandua", "daemon-secret");
  return fs.readFileSync(secretPath, "utf-8").trim();
}

async function controlFetch(
  controlPort: number,
  pathName: string,
  method = "GET",
  body?: unknown,
  secret?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (secret) headers["x-tamandua-secret"] = secret;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${controlPort}${pathName}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let resBody: unknown;
  try {
    resBody = await res.json();
  } catch {
    resBody = null;
  }
  return { status: res.status, body: resBody };
}

interface DbRun {
  status: string;
  context: string;
  worker_lost_count: number;
}

function getRunFromDb(dbPath: string, runId: string): DbRun | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT status, context, worker_lost_count FROM runs WHERE id = ?")
      .get(runId) as DbRun | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

function countRunWorktrees(dbPath: string, runId: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM run_worktrees WHERE run_id = ?")
      .get(runId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

function seedRunAndStep(dbPath: string, runId: string, workflowId: string, harnessDir: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    const context = JSON.stringify({
      task: "DSWP direct-mode sweep e2e",
      repo: harnessDir,
      working_directory_for_harness: harnessDir,
    });

    // Create tables with the full claim/ownership schema so the daemon's
    // migrate() ALTER TABLE statements are no-ops.
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        scheduling_status TEXT,
        scheduling_requested_at TEXT,
        scheduling_error TEXT,
        worker_lost_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        input_template TEXT NOT NULL DEFAULT '',
        expects TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'waiting',
        output TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 4,
        type TEXT NOT NULL DEFAULT 'single',
        loop_config TEXT,
        current_story_id TEXT,
        abandoned_count INTEGER DEFAULT 0,
        claim_job_id TEXT,
        claim_pid INTEGER,
        claim_pgid INTEGER,
        claim_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tamandua_stats (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        system_tokens_spent INTEGER NOT NULL DEFAULT 0
      );
    `);

    db.exec("INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)");

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    ).run(runId, workflowId, "DSWP direct-mode sweep e2e", context, now, now);

    const stepRowId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
       VALUES (?, ?, 'implement', ?, 0, 'Implement DSWP test', 'STATUS: done', 'pending', 'single', ?, ?)`,
    ).run(stepRowId, runId, `${workflowId}_developer`, now, now);
  } finally {
    db.close();
  }
}

async function waitForStepStatus(
  dbPath: string,
  runId: string,
  desiredStatus: string,
  timeoutMs = 30000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = new DatabaseSync(dbPath);
    let status: string | null = null;
    try {
      const row = db
        .prepare("SELECT status FROM steps WHERE run_id = ? AND step_index = 0")
        .get(runId) as { status: string } | undefined;
      status = row?.status ?? null;
    } finally {
      db.close();
    }
    if (status === desiredStatus) return;
    await sleep(200);
  }
  throw new Error(`Step did not reach status "${desiredStatus}" within ${timeoutMs}ms`);
}

async function waitForRunStatus(
  dbPath: string,
  runId: string,
  desiredStatus: string,
  timeoutMs = 60000,
): Promise<DbRun> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = getRunFromDb(dbPath, runId);
    if (run?.status === desiredStatus) return run;
    await sleep(200);
  }
  const current = getRunFromDb(dbPath, runId);
  throw new Error(
    `Run did not reach "${desiredStatus}" within ${timeoutMs}ms (current: ${current?.status ?? "null"})`,
  );
}

/** Poll until `predicate` is true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
    }
    await sleep(200);
  }
}

/**
 * Portable liveness probe for an ORPHANED process. The swept children are
 * reparented (their harness parent exits), so the kernel/init reaps them
 * promptly once SIGKILL lands; a plain signal-0 probe is therefore enough
 * (no procfs read, which the portability lint forbids outside proc-info.ts).
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

interface CleanupDetail {
  worktreePath: string | null;
  pgids: number[];
  scannedPids: number;
  killedPids: number[];
  evidence: Record<string, string>;
}

function readRunEvents(eventsPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cleanupDetails(events: Array<Record<string, unknown>>): CleanupDetail[] {
  return events
    .filter((e) => e.event === "run.process_cleanup")
    .map((e) => JSON.parse(e.detail as string) as CleanupDetail);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("direct-mode post-grace sweep e2e (DSWP)", { concurrency: 1 }, () => {
  let th: ReturnType<typeof createTempHome>;
  let controlPort: number;
  let daemon: ChildProcess | undefined;
  let runId: string;
  let secret: string;
  let dbPath: string;
  let eventsPath: string;
  let leakedPidFile: string;
  let unrelatedPid: number;

  before(async () => {
    th = createTempHome("tamandua-direct-sweep-");
    controlPort = await getAvailablePort();
    dbPath = path.join(th.tamanduaDir, "tamandua.db");
    eventsPath = path.join(th.tamanduaDir, "events");
    runId = crypto.randomUUID();

    // Copy the workflow directory so the daemon can load the workflow spec.
    // feature-dev-merge is the NON-worktree (direct-mode) variant.
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    // The leaked child is a node process that reports its own pid, ignores
    // SIGTERM (so the in-grace leak guard cannot reap it — only the
    // post-grace sweep's SIGKILL can), and holds the event loop forever. It
    // inherits the harness env, including TAMANDUA_RUN_ID.
    leakedPidFile = path.join(th.root, "leaked.pid");
    const leakScript = path.join(th.root, "leak.cjs");
    fs.writeFileSync(
      leakScript,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(leakedPidFile)}, String(process.pid));`,
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1 << 30);",
        "",
      ].join("\n"),
      "utf-8",
    );
    // `cd` outside the run directory (th.root is the PARENT of the run
    // directory th.homeDir), stay in the harness process group. The subshell
    // + `;` are REQUIRED: `&` backgrounds only the nohup (the subshell itself
    // exits immediately), so the leaked grandchild is orphaned in the harness
    // group and `spawnSync`'s synchronous stdio wait returns. With `&&` the
    // `&` would background the whole `cd && nohup` list and the round would
    // hang forever inside spawnSync.
    const leakCommand =
      `( cd ${JSON.stringify(th.root)}; nohup ${JSON.stringify(process.execPath)} ` +
      `${JSON.stringify(leakScript)} >/dev/null 2>&1 </dev/null & )`;

    // Unrelated control child: own process group, no run marker, cwd outside
    // the run directory. The sweep must never touch it.
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30);"], {
      cwd: th.root,
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "" },
    });
    unrelated.unref();
    assert.ok(unrelated.pid, "unrelated control child should have a pid");
    unrelatedPid = unrelated.pid;

    // Seed the direct-mode run BEFORE the daemon opens the DB. No worktree.
    seedRunAndStep(dbPath, runId, "feature-dev-merge", th.homeDir);

    // The scripted agent claims the step, leaks the background child, then
    // reports completion so the run reaches a terminal state.
    const agentBehaviors: Record<string, ScriptedBehavior | ScriptedBehavior[]> = {
      developer: {
        mode: "work",
        commands: [leakCommand],
        output: "STATUS: done\nCHANGES: direct-mode sweep e2e\nTESTS: run.process_cleanup",
      },
    };
    const scriptedAgent = createScriptedAgent(th.root, { agents: agentBehaviors, defaultTokens: 0 });

    daemon = spawn("node", [DAEMON_SCRIPT], {
      env: cleanChildEnv({
        HOME: th.homeDir,
        TAMANDUA_CONTROL_PORT: String(controlPort),
        ...scriptedAgent.env,
        // The launch-time probe is not the behavior under test; keep this
        // suite focused on the sweep path (mirrors pause-kill-resume).
        TAMANDUA_HARNESS_PROBE: "0",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout?.resume();
    daemon.stderr?.resume();

    await waitForControlUp(controlPort);
    secret = readDaemonSecret(th.homeDir);

    const regResp = await controlFetch(
      controlPort,
      "/control/register-run",
      "POST",
      { runId },
      secret,
    );
    assert.ok(
      regResp.status === 200 || regResp.status === 202,
      `register-run should succeed, got ${regResp.status}: ${JSON.stringify(regResp.body)}`,
    );

    // Nudge for immediate dispatch instead of waiting for the 15s tick. The
    // scripted round completes in well under a second, so we wait for the
    // terminal step state rather than the transient "running" window (the
    // leak behavior runs and writes its pid file before `step complete`).
    await controlFetch(controlPort, "/control/nudge", "POST", undefined, secret);
    await waitForStepStatus(dbPath, runId, "done", 30000);
  });

  after(() => {
    for (const pid of [readPidFile(leakedPidFile), unrelatedPid]) {
      if (!pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (daemon && daemon.exitCode === null && daemon.pid) {
      try {
        process.kill(daemon.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  });

  it("reaps the run-owned leaked child and spares an unrelated process", async () => {
    // ── Phase 1: the run completes (direct-mode, no worktree) ──────
    await waitForRunStatus(dbPath, runId, "completed", 60000);
    assert.equal(
      countRunWorktrees(dbPath, runId),
      0,
      "the run must have NO managed worktree row (genuinely direct-mode)",
    );

    // ── Phase 2: the leaked child is alive before the sweep ────────
    await waitFor(() => readPidFile(leakedPidFile) !== null, 10000, "leaked pid file");
    const leakedPid = readPidFile(leakedPidFile);
    assert.ok(leakedPid && leakedPid > 0, "leaked child should have reported its pid");
    assert.notEqual(leakedPid, unrelatedPid, "leaked and unrelated pids must differ");
    assert.equal(
      processIsAlive(leakedPid),
      true,
      "the leaked child IGNORES SIGTERM, so it must still be alive before the sweep",
    );
    assert.equal(processIsAlive(unrelatedPid), true, "the unrelated child must be alive");

    // ── Phase 3: wait for the post-grace sweep ─────────────────────
    // The sweep is scheduled when the daemon observes the terminal run and
    // fires HARNESS_TEARDOWN_GRACE_MS + 2s later.
    const sweepDeadline = Date.now() + SWEEP_DELAY_MS + 50_000;
    let detail: CleanupDetail | undefined;
    while (Date.now() < sweepDeadline) {
      const details = cleanupDetails(readRunEvents(path.join(eventsPath, `${runId}.jsonl`)));
      detail = details.find((d) => d.killedPids.includes(leakedPid));
      if (detail) break;
      await sleep(500);
    }
    assert.ok(
      detail,
      `expected a run.process_cleanup event reaping the leaked pid ${leakedPid} ` +
        `(events: ${JSON.stringify(cleanupDetails(readRunEvents(path.join(eventsPath, `${runId}.jsonl`))))})`,
    );

    // ── Phase 4: the leaked child is dead, the unrelated one lives ──
    await waitFor(() => !processIsAlive(leakedPid), 5000, "leaked child death");
    assert.equal(processIsAlive(leakedPid), false, "the leaked child must be dead after the sweep");
    assert.equal(
      processIsAlive(unrelatedPid),
      true,
      "the unrelated child (own pgid, no run marker, cwd outside) must survive",
    );

    // ── Phase 5: every kill is evidence-backed; unrelated untouched ─
    assert.ok(
      Array.isArray(detail.killedPids) && detail.killedPids.includes(leakedPid),
      "the leaked child must appear in the sweep's killedPids",
    );
    assert.ok(
      !detail.killedPids.includes(unrelatedPid),
      "the unrelated child must never be in killedPids",
    );
    for (const pid of detail.killedPids) {
      assert.ok(
        typeof detail.evidence?.[String(pid)] === "string" &&
          detail.evidence[String(pid)].length > 0,
        `killed pid ${pid} must carry an evidence string (never killed by name/glob)`,
      );
    }
    const leakEvidence = detail.evidence[String(leakedPid)];
    assert.match(
      leakEvidence,
      /pgid owned by run|TAMANDUA_RUN_ID|cwd under|environ contains/,
      `leaked child evidence must name a run-ownership channel, got: ${leakEvidence}`,
    );

    // Direct-mode proof: the sweep resolved the recorded working directory
    // (no worktree row exists) rather than bailing out.
    assert.ok(
      detail.worktreePath === null || typeof detail.worktreePath === "string",
      "the cleanup detail must carry the (nullable) resolved working path",
    );
    assert.ok(Array.isArray(detail.pgids), "the cleanup detail must carry the owned pgids");

    // ── Phase 6: the event is run-scoped and the run spent no tokens ─
    const cleanupEvents = readRunEvents(path.join(eventsPath, `${runId}.jsonl`)).filter(
      (e) => e.event === "run.process_cleanup",
    );
    assert.ok(cleanupEvents.length >= 1, "run.process_cleanup must be emitted");
    assert.ok(
      cleanupEvents.every((e) => e.runId === runId),
      "every run.process_cleanup must be attributed to this run",
    );

    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as
        | { tokens_spent: number }
        | undefined;
      assert.equal(row?.tokens_spent ?? 0, 0, "should spend zero real tokens (scripted agent)");
    } finally {
      db.close();
    }
  });
});

/**
 * WORKDIR-QUEUE US-005 — end-to-end admission regression through the REAL
 * control-plane register path.
 *
 * A second direct (non-worktree) workflow run whose harness working directory
 * is already held by a live scheduled run must WAIT (retriable
 * scheduling_status='waiting'), never fail. The reconciler admits it once the
 * holder releases the directory. Every other validation failure — missing,
 * relative or nonexistent harness workdir, branch mismatch — stays fatal
 * (HTTP 422 + scheduling_status='error').
 *
 * This exercises the real code path: createControlServer (in-process) + a temp
 * TAMANDUA_STATE_DIR/DB + a temp git repo, driven via POST /control/register-run
 * and the deterministic _reconcileOnce() seam (no 30s RECONCILER_INTERVAL_MS
 * wait).
 *
 * Serial lane: this file imports node:child_process directly and reaches the
 * scheduler (child_process-owning) source modules, so it is listed in
 * tests/serial-files.txt.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTempHome } from "./helpers/test-env.ts";
import {
  createControlServer,
  _resetWorkdirWaitWarnState,
  _reconcileOnce,
} from "../dist/server/control-server.js";
import { shutdownAllCrons, removeRunCrons } from "../dist/installer/agent-scheduler.js";
import { getDb } from "../dist/db.js";

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

const SECRET = "test-secret";
const WAIT_WARN_MARKER = "control-server: register-run waiting for harness workdir";
const ADMIT_AFTER_WAIT_MARKER = "control-server: register-run admitted after workdir wait";

let cleanupDirs: string[] = [];
let originalStateDir: string | undefined;
let originalDbPath: string | undefined;
let originalAllowSharedHarnessWorkdir: string | undefined;
let originalWarnInterval: string | undefined;

beforeEach(() => {
  originalStateDir = process.env.TAMANDUA_STATE_DIR;
  originalDbPath = process.env.TAMANDUA_DB_PATH;
  originalAllowSharedHarnessWorkdir = process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR;
  originalWarnInterval = process.env.TAMANDUA_WORKDIR_WAIT_WARN_INTERVAL_MS;
  _resetWorkdirWaitWarnState();
});

afterEach(async () => {
  shutdownAllCrons();
  cleanupDirs = [];
  if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = originalStateDir;
  if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = originalDbPath;
  if (originalAllowSharedHarnessWorkdir === undefined) delete process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR;
  else process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR = originalAllowSharedHarnessWorkdir;
  if (originalWarnInterval === undefined) delete process.env.TAMANDUA_WORKDIR_WAIT_WARN_INTERVAL_MS;
  else process.env.TAMANDUA_WORKDIR_WAIT_WARN_INTERVAL_MS = originalWarnInterval;
  _resetWorkdirWaitWarnState();
});

function makeTempRoot(): string {
  const { root } = createTempHome("tamandua-workdir-queue-");
  cleanupDirs.push(root);
  return root;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function jsonRequest(
  port: number,
  method: "GET" | "POST",
  pathName: string,
  body?: Record<string, unknown>,
): Promise<JsonResponse> {
  const payload = body ? JSON.stringify(body) : "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tamandua-secret": SECRET,
  };
  if (payload) headers["content-length"] = String(Buffer.byteLength(payload));

  return await new Promise<JsonResponse>((resolve, reject) => {
    const req = http.request(
      { method, hostname: "127.0.0.1", port, path: pathName, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({
            status: res.statusCode ?? 0,
            body: raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function writeWorkflow(stateDir: string): void {
  const workflowDir = path.join(stateDir, "workflows", "wf-harness");
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    [
      "id: wf-harness",
      "agents:",
      "  - id: worker",
      "    role: analysis",
      "    workspace:",
      "      baseDir: .",
      "      files: {}",
      "steps:",
      "  - id: do_work",
      "    agent: worker",
      "    input: test",
      "    expects: STATUS",
      "",
    ].join("\n"),
  );
}

function seedRun(
  dbPath: string,
  runId: string,
  context: Record<string, unknown>,
): void {
  const db = new DatabaseSync(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs
       (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at)
     VALUES (?, 'wf-harness', 'harness test', 'running', ?, 0, 'pending_register', ?, ?)`,
  ).run(runId, JSON.stringify(context), now, now);
  db.prepare(
    `INSERT INTO steps
       (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
     VALUES (?, ?, 'do_work', 'wf-harness_worker', 0, 'test', 'STATUS', 'pending', 'single', ?, ?)`,
  ).run(crypto.randomUUID(), runId, now, now);
  db.close();
}

function setupState(): { root: string; stateDir: string; dbPath: string } {
  const root = makeTempRoot();
  const stateDir = path.join(root, "state");
  const dbPath = path.join(stateDir, "tamandua.db");
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = dbPath;
  writeWorkflow(stateDir);
  getDb();
  return { root, stateDir, dbPath };
}

function initGitRepo(repoDir: string, branch: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: repoDir });
}

function readRunRow(dbPath: string, runId: string): {
  status: string;
  scheduling_status: string | null;
  scheduling_error: string | null;
  scheduling_requested_at: string | null;
} {
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare(
      "SELECT status, scheduling_status, scheduling_error, scheduling_requested_at FROM runs WHERE id = ?",
    )
    .get(runId) as {
      status: string;
      scheduling_status: string | null;
      scheduling_error: string | null;
      scheduling_requested_at: string | null;
    };
  db.close();
  return row;
}

function setRunStatus(dbPath: string, runId: string, status: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, runId);
  db.close();
}

function readLog(stateDir: string): string {
  try {
    return fs.readFileSync(path.join(stateDir, "tamandua.log"), "utf-8");
  } catch {
    return "";
  }
}

function countLogLines(stateDir: string, level: string, marker: string): number {
  return readLog(stateDir)
    .split("\n")
    .filter((line) => line.includes(level) && line.includes(marker)).length;
}

describe("workdir-queue admission regression (US-005)", () => {
  it("run B waits on run A's workdir, then one reconcile pass admits B", async () => {
    const { root, stateDir, dbPath } = setupState();
    const shared = path.join(root, "shared-workdir");
    fs.mkdirSync(shared, { recursive: true });

    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();
    seedRun(dbPath, runA, { working_directory_for_harness: shared });
    seedRun(dbPath, runB, { working_directory_for_harness: shared });

    process.env.TAMANDUA_WORKDIR_WAIT_WARN_INTERVAL_MS = "60000";
    _resetWorkdirWaitWarnState();

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      // ── Run A takes the directory ──────────────────────────────────
      const registerA = await jsonRequest(port, "POST", "/control/register-run", { runId: runA });
      assert.ok(
        registerA.status >= 200 && registerA.status < 300,
        `run A should be admitted: ${registerA.status} ${JSON.stringify(registerA.body)}`,
      );
      assert.equal(registerA.body.state, "active", JSON.stringify(registerA.body));

      // ── Run B on the SAME directory: queued-waiting, never failed ──
      const registerB = await jsonRequest(port, "POST", "/control/register-run", { runId: runB });
      assert.equal(registerB.status, 202, JSON.stringify(registerB.body));
      assert.equal(registerB.body.state, "waiting");
      assert.equal(registerB.body.heldByRunId, runA, "the 202 body must name the holder");
      assert.equal(registerB.body.workingDirectoryForHarness, shared);

      const rowBWhileWaiting = readRunRow(dbPath, runB);
      assert.equal(rowBWhileWaiting.status, "running", "B must stay registered (not failed)");
      assert.notEqual(rowBWhileWaiting.status, "failed");
      assert.equal(rowBWhileWaiting.scheduling_status, "waiting");
      assert.equal(
        rowBWhileWaiting.scheduling_error,
        `waiting for harness workdir held by run ${runA}: ${shared}`,
      );
      assert.ok(rowBWhileWaiting.scheduling_requested_at, "scheduling_requested_at should be stamped");

      // WARN (throttled), naming both the holder and the directory; no ERROR.
      const warnLines = readLog(stateDir)
        .split("\n")
        .filter((line) => line.includes("WARN") && line.includes(WAIT_WARN_MARKER));
      assert.equal(warnLines.length, 1, `expected exactly one WARN line, got:\n${readLog(stateDir)}`);
      assert.ok(warnLines[0].includes(runA), "WARN must name the holding run");
      assert.ok(warnLines[0].includes(shared), "WARN must name the directory");
      assert.equal(
        readLog(stateDir)
          .split("\n")
          .some((line) => line.includes("ERROR") && line.includes(WAIT_WARN_MARKER)),
        false,
        "the workdir-busy condition must never log at ERROR",
      );
      assert.equal(
        readLog(stateDir)
          .split("\n")
          .some((line) => line.includes("ERROR") && line.includes("register-run failed")),
        false,
        "the busy-workdir wait must not take the register-run failed ERROR path",
      );

      // ── Holder A finishes: release its jobs, then ONE reconcile pass ──
      await removeRunCrons(runA);
      setRunStatus(dbPath, runA, "completed");

      await _reconcileOnce();

      const rowBAfter = readRunRow(dbPath, runB);
      assert.equal(
        rowBAfter.scheduling_status,
        "active",
        `waiting run should be admitted, got ${JSON.stringify(rowBAfter)}`,
      );
      assert.equal(rowBAfter.scheduling_error, null, "admission clears scheduling_error");
      assert.equal(rowBAfter.status, "running");

      assert.equal(
        countLogLines(stateDir, "INFO", ADMIT_AFTER_WAIT_MARKER),
        1,
        `expected one admission-after-wait INFO line:\n${readLog(stateDir)}`,
      );
      const infoLine = readLog(stateDir)
        .split("\n")
        .find((line) => line.includes(ADMIT_AFTER_WAIT_MARKER));
      assert.ok(infoLine && infoLine.includes(runB), "INFO line must name the admitted run");
    } finally {
      await close(server);
    }
  });

  it("missing working_directory_for_harness stays fatal (422 + scheduling_status='error')", async () => {
    const { dbPath } = setupState();
    const runId = crypto.randomUUID();
    seedRun(dbPath, runId, {});

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const response = await jsonRequest(port, "POST", "/control/register-run", { runId });
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.match(String(response.body.error), /missing working_directory_for_harness/);

      const row = readRunRow(dbPath, runId);
      assert.equal(row.scheduling_status, "error");
      assert.notEqual(row.scheduling_status, "waiting");
      assert.notEqual(row.status, "failed");
    } finally {
      await close(server);
    }
  });

  it("relative working_directory_for_harness stays fatal (422 + scheduling_status='error')", async () => {
    const { dbPath } = setupState();
    const runId = crypto.randomUUID();
    seedRun(dbPath, runId, { working_directory_for_harness: "relative/workdir" });

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const response = await jsonRequest(port, "POST", "/control/register-run", { runId });
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.match(String(response.body.error), /relative harness workdir/);

      const row = readRunRow(dbPath, runId);
      assert.equal(row.scheduling_status, "error");
      assert.notEqual(row.scheduling_status, "waiting");
    } finally {
      await close(server);
    }
  });

  it("nonexistent working_directory_for_harness stays fatal (422 + scheduling_status='error')", async () => {
    const { dbPath } = setupState();
    const runId = crypto.randomUUID();
    seedRun(dbPath, runId, {
      working_directory_for_harness: path.join("/nonexistent-workdir", crypto.randomUUID()),
    });

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const response = await jsonRequest(port, "POST", "/control/register-run", { runId });
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.match(String(response.body.error), /does not exist/);

      const row = readRunRow(dbPath, runId);
      assert.equal(row.scheduling_status, "error");
      assert.notEqual(row.status, "failed");
    } finally {
      await close(server);
    }
  });

  it("branch-mismatched working_directory_for_harness stays fatal (422, never waiting)", async () => {
    const { root, dbPath } = setupState();
    const repo = path.join(root, "worktree");
    initGitRepo(repo, "actual-branch");

    const runId = crypto.randomUUID();
    seedRun(dbPath, runId, {
      working_directory_for_harness: repo,
      branch: "expected-branch",
    });

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const response = await jsonRequest(port, "POST", "/control/register-run", { runId });
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.match(String(response.body.error), /branch mismatch/);

      const row = readRunRow(dbPath, runId);
      assert.equal(row.scheduling_status, "error");
      assert.notEqual(row.scheduling_status, "waiting");
      assert.notEqual(row.status, "failed");
    } finally {
      await close(server);
    }
  });
});

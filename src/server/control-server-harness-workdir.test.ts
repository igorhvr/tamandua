import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  createControlServer,
  _resetWorkdirWaitWarnState,
} from "../../dist/server/control-server.js";
import { shutdownAllCrons } from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

const SECRET = "test-secret";
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
  for (const dir of cleanupDirs) {
  }
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
  const { root: root } = createTempHome("tamandua-harness-workdir-");
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
    server.close((err) => err ? reject(err) : resolve());
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
            body: raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {},
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
  status: "paused" | "running",
  context: Record<string, unknown>,
): void {
  const db = new DatabaseSync(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs
       (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at)
     VALUES (?, 'wf-harness', 'harness test', ?, ?, 0, ?, ?, ?)`,
  ).run(runId, status, JSON.stringify(context), status === "paused" ? "paused" : "pending_register", now, now);
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

describe("control-server harness workdir admission", () => {
  it("resumes multiple runs into their distinct stored harness directories", async () => {
    const { root, dbPath } = setupState();
    const repoA = path.join(root, "worktree-a");
    const repoB = path.join(root, "worktree-b");
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();
    seedRun(dbPath, runA, "paused", { working_directory_for_harness: repoA });
    seedRun(dbPath, runB, "paused", { working_directory_for_harness: repoB });

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const resumeA = await jsonRequest(port, "POST", "/control/resume-run", { runId: runA });
      const resumeB = await jsonRequest(port, "POST", "/control/resume-run", { runId: runB });
      assert.ok(resumeA.status >= 200 && resumeA.status < 300, JSON.stringify(resumeA.body));
      assert.ok(resumeB.status >= 200 && resumeB.status < 300, JSON.stringify(resumeB.body));

      const jobsResponse = await jsonRequest(port, "GET", "/control/jobs");
      assert.equal(jobsResponse.status, 200);
      const jobs = jobsResponse.body.jobs as Array<Record<string, unknown>>;
      const byRun = new Map(jobs.map((job) => [job.runId, job.workingDirectoryForHarness]));

      assert.equal(byRun.get(runA), repoA);
      assert.equal(byRun.get(runB), repoB);
      assert.notEqual(byRun.get(runA), byRun.get(runB));
    } finally {
      await close(server);
    }
  });

  it("refuses to resume a run missing working_directory_for_harness", async () => {
    const { dbPath } = setupState();
    const runId = crypto.randomUUID();
    seedRun(dbPath, runId, "paused", {});

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const response = await jsonRequest(port, "POST", "/control/resume-run", { runId });
      assert.equal(response.status, 422);
      assert.match(String(response.body.error), /missing working_directory_for_harness/);

      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as {
        status: string;
        scheduling_status: string | null;
      };
      db.close();
      assert.equal(row.status, "paused");
      assert.equal(row.scheduling_status, "error");
    } finally {
      await close(server);
    }
  });

  it("refuses to resume a run when the harness workdir is on a different branch", async () => {
    const { root, dbPath } = setupState();
    const repo = path.join(root, "worktree");
    initGitRepo(repo, "actual-branch");

    const runId = crypto.randomUUID();
    seedRun(dbPath, runId, "paused", {
      working_directory_for_harness: repo,
      branch: "expected-branch",
    });

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const response = await jsonRequest(port, "POST", "/control/resume-run", { runId });
      assert.equal(response.status, 422);
      assert.match(String(response.body.error), /branch mismatch/);

      const jobsResponse = await jsonRequest(port, "GET", "/control/jobs");
      const jobs = jobsResponse.body.jobs as Array<Record<string, unknown>>;
      assert.equal(jobs.some((job) => job.runId === runId), false);
    } finally {
      await close(server);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-001: busy harness workdir is a RETRIABLE admission condition
// ('waiting'), never a fatal 422 / scheduling_status='error'.
// ══════════════════════════════════════════════════════════════════════

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

function readLog(stateDir: string): string {
  try {
    return fs.readFileSync(path.join(stateDir, "tamandua.log"), "utf-8");
  } catch {
    return "";
  }
}

const WAIT_WARN_MARKER = "control-server: register-run waiting for harness workdir";

describe("control-server busy harness workdir waits (US-001)", () => {
  it("returns 202 waiting (never fails) when the workdir is held by a live run", async () => {
    const { root, stateDir, dbPath } = setupState();
    const shared = path.join(root, "shared-workdir");
    fs.mkdirSync(shared, { recursive: true });

    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();
    seedRun(dbPath, runA, "running", { working_directory_for_harness: shared });
    seedRun(dbPath, runB, "running", { working_directory_for_harness: shared });

    process.env.TAMANDUA_WORKDIR_WAIT_WARN_INTERVAL_MS = "60000";
    _resetWorkdirWaitWarnState();

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const registerA = await jsonRequest(port, "POST", "/control/register-run", { runId: runA });
      assert.ok(
        registerA.status >= 200 && registerA.status < 300,
        `run A should be admitted: ${registerA.status} ${JSON.stringify(registerA.body)}`,
      );
      assert.equal(registerA.body.state, "active");

      const registerB = await jsonRequest(port, "POST", "/control/register-run", { runId: runB });
      assert.equal(registerB.status, 202, JSON.stringify(registerB.body));
      assert.equal(registerB.body.state, "waiting");
      assert.equal(registerB.body.heldByRunId, runA);
      assert.equal(registerB.body.workingDirectoryForHarness, shared);

      const rowB = readRunRow(dbPath, runB);
      assert.equal(rowB.status, "running");
      assert.equal(rowB.scheduling_status, "waiting");
      assert.equal(
        rowB.scheduling_error,
        `waiting for harness workdir held by run ${runA}: ${shared}`,
      );
      assert.ok(rowB.scheduling_requested_at, "scheduling_requested_at should be stamped");

      const log = readLog(stateDir);
      const warnLines = log
        .split("\n")
        .filter((line) => line.includes("WARN") && line.includes(WAIT_WARN_MARKER));
      assert.equal(warnLines.length, 1, `expected exactly one WARN line, got:\n${log}`);
      assert.ok(warnLines[0].includes(runA), "WARN must name the holding run");
      assert.ok(warnLines[0].includes(shared), "WARN must name the directory");
      assert.equal(
        log.split("\n").some((line) => line.includes("ERROR") && line.includes("register-run failed")),
        false,
        "the busy-workdir wait must not log an ERROR",
      );
    } finally {
      await close(server);
    }
  });

  it("throttles repeat WARN lines within the interval and logs again after it", async () => {
    const { root, stateDir, dbPath } = setupState();
    const shared = path.join(root, "shared-workdir");
    fs.mkdirSync(shared, { recursive: true });

    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();
    seedRun(dbPath, runA, "running", { working_directory_for_harness: shared });
    seedRun(dbPath, runB, "running", { working_directory_for_harness: shared });

    // Huge interval: the second refusal must stay silent.
    process.env.TAMANDUA_WORKDIR_WAIT_WARN_INTERVAL_MS = "600000";
    _resetWorkdirWaitWarnState();

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      await jsonRequest(port, "POST", "/control/register-run", { runId: runA });
      await jsonRequest(port, "POST", "/control/register-run", { runId: runB });
      await jsonRequest(port, "POST", "/control/register-run", { runId: runB });

      const countWarns = (): number =>
        readLog(stateDir)
          .split("\n")
          .filter((line) => line.includes("WARN") && line.includes(WAIT_WARN_MARKER)).length;
      assert.equal(countWarns(), 1, "second refusal inside the interval must not re-WARN");

      // Now shrink the interval to 0 and refuse again: it should WARN once more.
      process.env.TAMANDUA_WORKDIR_WAIT_WARN_INTERVAL_MS = "0";
      await jsonRequest(port, "POST", "/control/register-run", { runId: runB });
      assert.equal(countWarns(), 2, "a refusal after the interval must WARN again");
    } finally {
      await close(server);
    }
  });

  it("still admits when TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1", async () => {
    const { root, dbPath } = setupState();
    const shared = path.join(root, "shared-workdir");
    fs.mkdirSync(shared, { recursive: true });

    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();
    seedRun(dbPath, runA, "running", { working_directory_for_harness: shared });
    seedRun(dbPath, runB, "running", { working_directory_for_harness: shared });

    process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR = "1";
    _resetWorkdirWaitWarnState();

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const registerA = await jsonRequest(port, "POST", "/control/register-run", { runId: runA });
      assert.equal(registerA.body.state, "active");

      const registerB = await jsonRequest(port, "POST", "/control/register-run", { runId: runB });
      assert.equal(registerB.status, 202, JSON.stringify(registerB.body));
      assert.equal(registerB.body.state, "active");
      assert.equal(readRunRow(dbPath, runB).scheduling_status, "active");
    } finally {
      await close(server);
    }
  });

  it("keeps a nonexistent harness workdir fatal (422 + scheduling_status=error)", async () => {
    const { dbPath } = setupState();
    const runId = crypto.randomUUID();
    seedRun(dbPath, runId, "running", {
      working_directory_for_harness: path.join("/nonexistent-workdir", crypto.randomUUID()),
    });

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const response = await jsonRequest(port, "POST", "/control/register-run", { runId });
      assert.equal(response.status, 422, JSON.stringify(response.body));
      const row = readRunRow(dbPath, runId);
      assert.equal(row.scheduling_status, "error");
      assert.notEqual(row.scheduling_status, "waiting");
      assert.notEqual(row.status, "failed");
    } finally {
      await close(server);
    }
  });

  it("keeps a branch-mismatched harness workdir fatal (422, never waiting)", async () => {
    const { root, dbPath } = setupState();
    const repo = path.join(root, "worktree");
    initGitRepo(repo, "actual-branch");

    const runId = crypto.randomUUID();
    seedRun(dbPath, runId, "running", {
      working_directory_for_harness: repo,
      branch: "expected-branch",
    });

    const server = createControlServer({ secret: SECRET, listen: false });
    const port = await listen(server);
    try {
      const response = await jsonRequest(port, "POST", "/control/register-run", { runId });
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.match(String(response.body.error), /branch mismatch/);
      assert.equal(readRunRow(dbPath, runId).scheduling_status, "error");
    } finally {
      await close(server);
    }
  });
});

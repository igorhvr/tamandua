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
import { createControlServer } from "../../dist/server/control-server.js";
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

beforeEach(() => {
  originalStateDir = process.env.TAMANDUA_STATE_DIR;
  originalDbPath = process.env.TAMANDUA_DB_PATH;
  originalAllowSharedHarnessWorkdir = process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR;
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

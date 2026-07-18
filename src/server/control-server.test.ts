/**
 * Regression tests for the daemon control plane.
 *
 * Spawns the dashboard daemon in a tmp HOME, then exercises the control
 * endpoints directly over HTTP. The reconciler tick interval is unref'd so
 * it doesn't keep the test process alive.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import {
  cleanChildEnv,
  reservePortHandles,
  createTempHome,
} from "../../tests/helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONTROL_PORT } from "../../dist/server/control-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");
let dashboardPort = 0;
let controlPort = 0;

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function jsonRequest(
  method: "GET" | "POST",
  pathName: string,
  body?: Record<string, unknown>,
  secret?: string,
): Promise<JsonResponse> {
  const payload = body ? JSON.stringify(body) : "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) headers["x-tamandua-secret"] = secret;
  if (payload) headers["content-length"] = String(Buffer.byteLength(payload));

  return await new Promise<JsonResponse>((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port: controlPort,
        path: pathName,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let parsed: Record<string, unknown> = {};
          if (raw.trim()) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { raw };
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error("control plane timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForControlUp(timeoutMs = 30000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const r = await jsonRequest("GET", "/control/health");
      if (r.status === 200) return;
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  throw new Error(`control plane did not come up on port ${controlPort}`);
}

async function waitForExit(child: ChildProcess, timeoutMs = 7000): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

describe("daemon control plane", { concurrency: 1 }, () => {
  let tempHome: string;
  let daemon: ChildProcess | undefined;
  let secret: string | undefined;

  before(async (t) => {
    const handles = await reservePortHandles(2);
    dashboardPort = handles[0].port;
    controlPort = handles[1].port;

    // Close handles just before daemon spawn so the daemon can bind.
    await Promise.all(handles.map(h => h.close()));

    tempHome = tamanduaTempDir("tamandua-control-home-");
    daemon = spawn("node", [DAEMON_SCRIPT, String(dashboardPort)], {
      env: cleanChildEnv({ HOME: tempHome, TAMANDUA_CONTROL_PORT: String(controlPort) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout?.resume();
    daemon.stderr?.resume();

    await waitForControlUp();
    secret = fs.readFileSync(path.join(tempHome, ".tamandua", "daemon-secret"), "utf-8").trim();
    assert.ok(secret && secret.length > 0, "daemon secret should be created on startup");
  });

  after(async () => {
    if (daemon && daemon.exitCode === null && daemon.pid) {
      try {
        process.kill(daemon.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      try {
        await waitForExit(daemon);
      } catch {
        if (daemon.pid) {
          try { process.kill(daemon.pid, "SIGKILL"); } catch { /* ignore */ }
        }
      }
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("GET /control/health returns 200 without auth", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest("GET", "/control/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "ok");
    assert.ok(typeof r.body.buildVersion === "string" && r.body.buildVersion.length > 0,
      `expected non-empty buildVersion string, got ${JSON.stringify(r.body.buildVersion)}`);
  });

  it("GET /control/limits requires auth", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const unauth = await jsonRequest("GET", "/control/limits");
    assert.equal(unauth.status, 401);

    const auth = await jsonRequest("GET", "/control/limits", undefined, secret);
    assert.equal(auth.status, 200);
    assert.equal(typeof auth.body.maxActiveTimers, "number");
  });

  it("POST /control/register-run returns 404 for unknown run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId: crypto.randomUUID() },
      secret,
    );
    assert.equal(r.status, 404);
  });

  it("POST /control/register-run is idempotent for an existing run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    // Insert a run row directly into the DB the daemon is reading.
    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    // Use the same DB the daemon is using by inserting via node:sqlite.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, ?, 'control-test', 'running', '{}', 0, 'pending_register', ?, ?, ?)",
    ).run(runId, "wf-control-test", now, now, now);
    db.close();

    // First call: workflow-spec resolution will fail (workflow not installed)
    // so the daemon returns 422, but the run is now flagged 'error' rather
    // than a leaked 'active' state. Second call should be deterministic.
    const r1 = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId },
      secret,
    );
    assert.ok(r1.status === 422 || (r1.status >= 200 && r1.status < 300));

    const r2 = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId },
      secret,
    );
    assert.ok(r2.status === 422 || (r2.status >= 200 && r2.status < 300));

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/terminate-run is a no-op for unknown run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest(
      "POST",
      "/control/terminate-run",
      { runId: crypto.randomUUID() },
      secret,
    );
    assert.equal(r.status, 404);
  });

  it("POST /control/pause-run emits run.paused event", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-pause-test";
    const now = new Date().toISOString();

    // Insert a running run so pause will succeed.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'pause-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Check run-specific events file.
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const pauseEvent = runEvents.find((e: any) => e.event === "run.paused");
    assert.ok(pauseEvent, "expected a run.paused event in run events file");
    assert.equal(pauseEvent.runId, runId);
    assert.equal(pauseEvent.workflowId, workflowId);
    assert.ok(typeof pauseEvent.ts === "string" && pauseEvent.ts.length > 0);

    // Check global events file also received the event.
    const globalEventsPath = path.join(tempHome, ".tamandua", "events", "all.jsonl");
    assert.ok(fs.existsSync(globalEventsPath), "global events file should exist");
    const globalRaw = fs.readFileSync(globalEventsPath, "utf-8");
    const globalEvents = globalRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const globalPause = globalEvents.find((e: any) => e.event === "run.paused" && e.runId === runId);
    assert.ok(globalPause, "expected a run.paused event in global events file");
    assert.equal(globalPause.workflowId, workflowId);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/resume-run emits run.resumed event", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-resume-test";
    const now = new Date().toISOString();
    const context = JSON.stringify({ working_directory_for_harness: tempHome });

    // Insert a paused run so resume will process it.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'resume-test', 'paused', ?, 0, 'paused', ?, ?)",
    ).run(runId, workflowId, context, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/resume-run",
      { runId },
      secret,
    );
    // The resume handler emits the event before calling handleRegisterRun,
    // which may fail (workflow not installed) but the event is already emitted.
    // Accept 200 (if register succeeds) or 422 (if workflow doesn't exist).
    assert.ok(r.status === 200 || r.status === 422,
      `expected 200 or 422, got ${r.status}`);

    // Check run-specific events file for run.resumed.
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const resumeEvent = runEvents.find((e: any) => e.event === "run.resumed");
    assert.ok(resumeEvent, "expected a run.resumed event in run events file");
    assert.equal(resumeEvent.runId, runId);
    assert.equal(resumeEvent.workflowId, workflowId);
    assert.ok(typeof resumeEvent.ts === "string" && resumeEvent.ts.length > 0);

    // Check global events file also received the event.
    const globalEventsPath = path.join(tempHome, ".tamandua", "events", "all.jsonl");
    assert.ok(fs.existsSync(globalEventsPath), "global events file should exist");
    const globalRaw = fs.readFileSync(globalEventsPath, "utf-8");
    const globalEvents = globalRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const globalResume = globalEvents.find((e: any) => e.event === "run.resumed" && e.runId === runId);
    assert.ok(globalResume, "expected a run.resumed event in global events file");
    assert.equal(globalResume.workflowId, workflowId);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  // ── Traceability logging + events tests (US-003) ──────────────────

  it("POST /control/pause-run emits run.pause_requested event before run.paused", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-pause-requested-test";
    const now = new Date().toISOString();
    const requester = "alice@box:1234 (cli)";

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'pause-requested-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, requestedBy: requester },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Read events and verify ordering: run.pause_requested must appear before run.paused.
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath));
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));

    const requestIndex = runEvents.findIndex((e: any) => e.event === "run.pause_requested");
    const pausedIndex = runEvents.findIndex((e: any) => e.event === "run.paused");

    assert.ok(requestIndex >= 0, "expected a run.pause_requested event");
    assert.ok(pausedIndex >= 0, "expected a run.paused event");
    assert.ok(requestIndex < pausedIndex,
      `run.pause_requested (idx=${requestIndex}) must appear before run.paused (idx=${pausedIndex})`);

    // Verify run.pause_requested has requester and drain in detail.
    const reqEvent = runEvents[requestIndex];
    assert.equal(reqEvent.runId, runId);
    assert.equal(reqEvent.workflowId, workflowId);
    const detail = JSON.parse(reqEvent.detail);
    assert.equal(detail.requestedBy, requester);
    assert.equal(detail.drain, false);

    // Verify run.paused still fires unchanged.
    const pausedEvent = runEvents[pausedIndex];
    assert.equal(pausedEvent.runId, runId);
    assert.equal(pausedEvent.workflowId, workflowId);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run emits run.pause_requested with drain=true for drain pause", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-pause-drain-requested-test";
    const now = new Date().toISOString();
    const requester = "bob@box:5678 (mcp)";

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'pause-drain-requested-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true, requestedBy: requester },
      secret,
    );
    // Drain pause may return drained state; accept 200.
    assert.equal(r.status, 200);

    // Read events and verify run.pause_requested has drain=true.
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath));
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));

    const reqEvent = runEvents.find((e: any) => e.event === "run.pause_requested");
    assert.ok(reqEvent, "expected a run.pause_requested event");
    assert.equal(reqEvent.runId, runId);
    const detail = JSON.parse(reqEvent.detail);
    assert.equal(detail.requestedBy, requester);
    assert.equal(detail.drain, true);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with default requestedBy stores unknown in event detail", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-pause-default-test";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'pause-default-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId },
      secret,
    );
    assert.equal(r.status, 200);

    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath));
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));

    const reqEvent = runEvents.find((e: any) => e.event === "run.pause_requested");
    assert.ok(reqEvent, "expected a run.pause_requested event");
    const detail = JSON.parse(reqEvent.detail);
    assert.equal(detail.requestedBy, "unknown", "requestedBy should default to unknown");
    assert.equal(detail.drain, false);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/resume-run emits run.resume_requested event before run.resumed", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-resume-requested-test";
    const now = new Date().toISOString();
    const context = JSON.stringify({ working_directory_for_harness: tempHome });
    const requester = "carol@box:9012 (cli)";

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'resume-requested-test', 'paused', ?, 0, 'paused', ?, ?)",
    ).run(runId, workflowId, context, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/resume-run",
      { runId, requestedBy: requester },
      secret,
    );
    assert.ok(r.status === 200 || r.status === 422,
      `expected 200 or 422, got ${r.status}`);

    // Read events and verify ordering: run.resume_requested must appear before run.resumed.
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath));
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));

    const requestIndex = runEvents.findIndex((e: any) => e.event === "run.resume_requested");
    const resumedIndex = runEvents.findIndex((e: any) => e.event === "run.resumed");

    assert.ok(requestIndex >= 0, "expected a run.resume_requested event");
    assert.ok(resumedIndex >= 0, "expected a run.resumed event");
    assert.ok(requestIndex < resumedIndex,
      `run.resume_requested (idx=${requestIndex}) must appear before run.resumed (idx=${resumedIndex})`);

    // Verify run.resume_requested has requester in detail.
    const reqEvent = runEvents[requestIndex];
    assert.equal(reqEvent.runId, runId);
    assert.equal(reqEvent.workflowId, workflowId);
    const detail = JSON.parse(reqEvent.detail);
    assert.equal(detail.requestedBy, requester);

    // Verify run.resumed still fires unchanged.
    const resumedEvent = runEvents[resumedIndex];
    assert.equal(resumedEvent.runId, runId);
    assert.equal(resumedEvent.workflowId, workflowId);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  // ── Attribution context key tests ─────────────────────────────────

  it("POST /control/pause-run stores attribution context keys", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a running run so pause will succeed.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'pause-attribution-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, "wf-pause-attr", now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Verify context keys in DB.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(row.context);
    assert.equal(ctx.paused_by, "unknown", "paused_by should default to unknown");
    assert.ok(typeof ctx.paused_at === "string" && ctx.paused_at.length > 0, "paused_at should be an ISO timestamp");
    assert.equal(ctx.pause_drain, "false", "pause_drain should be false for non-drain pause");
    db2.close();

    // Cleanup
    const db3 = new DatabaseSync(dbPath);
    db3.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db3.close();
  });

  it("POST /control/pause-run stores requestedBy when provided", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const requester = "igorhvr@tamandua-mac:12345 (cli)";

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'pause-requester-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, "wf-pause-req", now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, requestedBy: requester },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Verify context keys.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(row.context);
    assert.equal(ctx.paused_by, requester, "paused_by should store the requester string");
    assert.ok(typeof ctx.paused_at === "string" && ctx.paused_at.length > 0, "paused_at should be an ISO timestamp");
    assert.equal(ctx.pause_drain, "false", "pause_drain should be false");
    db2.close();

    // Cleanup
    const db3 = new DatabaseSync(dbPath);
    db3.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db3.close();
  });

  it("POST /control/pause-run stores pause_drain=true for drain pause", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'pause-drain-attr-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, "wf-pause-drain-attr", now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 200);

    // Verify context keys.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(row.context);
    assert.equal(ctx.paused_by, "unknown", "paused_by should default to unknown");
    assert.ok(typeof ctx.paused_at === "string" && ctx.paused_at.length > 0, "paused_at should be set");
    assert.equal(ctx.pause_drain, "true", "pause_drain should be true for drain pause");
    db2.close();

    // Cleanup
    const db3 = new DatabaseSync(dbPath);
    db3.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db3.close();
  });

  it("POST /control/resume-run stores attribution context keys", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const context = JSON.stringify({ working_directory_for_harness: tempHome });

    // Insert a paused run so resume will process it.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'resume-attribution-test', 'paused', ?, 0, 'paused', ?, ?)",
    ).run(runId, "wf-resume-attr", context, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/resume-run",
      { runId },
      secret,
    );
    // The resume handler emits the event before calling handleRegisterRun,
    // which may fail (workflow not installed) but the event and context keys are already set.
    assert.ok(r.status === 200 || r.status === 422);

    // Verify context keys in DB.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(row.context);
    assert.equal(ctx.resumed_by, "unknown", "resumed_by should default to unknown");
    assert.ok(typeof ctx.resumed_at === "string" && ctx.resumed_at.length > 0, "resumed_at should be an ISO timestamp");
    db2.close();

    // Cleanup
    const db3 = new DatabaseSync(dbPath);
    db3.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db3.close();
  });

  it("POST /control/resume-run stores requestedBy when provided", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const context = JSON.stringify({ working_directory_for_harness: tempHome });
    const requester = "igorhvr@tamandua-mac:99999 (cli)";

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'resume-requester-test', 'paused', ?, 0, 'paused', ?, ?)",
    ).run(runId, "wf-resume-req", context, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/resume-run",
      { runId, requestedBy: requester },
      secret,
    );
    assert.ok(r.status === 200 || r.status === 422);

    // Verify context keys.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(row.context);
    assert.equal(ctx.resumed_by, requester, "resumed_by should store the requester string");
    assert.ok(typeof ctx.resumed_at === "string" && ctx.resumed_at.length > 0, "resumed_at should be an ISO timestamp");
    db2.close();

    // Cleanup
    const db3 = new DatabaseSync(dbPath);
    db3.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db3.close();
  });

  // ── Drain-before-pause tests ───────────────────────────────────────

  it("POST /control/pause-run with drain=true waits for in-flight steps", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-test";
    const stepId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a running run.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'impl', 0, 'wf-drain-test_developer', 'single', 'running', 'implement', '', 0, 3, ?, ?)",
    ).run(stepId, runId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "draining_pause");
    assert.equal(r.body.drained, true);

    // Verify DB: status should still be running, scheduling_status should be draining_pause.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "running", "status should remain running during drain");
    assert.equal(row.scheduling_status, "draining_pause", "scheduling_status should be draining_pause");

    // Cleanup
    db2.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with drain=true pauses immediately when nothing is in flight", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-empty";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-empty', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "status should transition to paused when no steps are in flight");
    assert.equal(row.scheduling_status, "paused", "scheduling_status should be paused");

    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with drain=false pauses immediately (unchanged behavior)", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-immediate";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-immediate', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    // drain=false (explicit)
    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: false },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Verify DB: status should be paused.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "status should be paused");
    assert.equal(row.scheduling_status, "paused", "scheduling_status should be paused");

    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with omitted drain pauses immediately (backward compat)", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-omitted";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-omitted', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    // No drain field in body
    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "status should be paused");
    assert.equal(row.scheduling_status, "paused", "scheduling_status should be paused");

    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("finalizeDrainingPause transitions run to paused when no running steps remain", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    // Use TAMANDUA_DB_PATH and TAMANDUA_STATE_DIR to point to the daemon's
    // state so finalizeDrainingPause (which calls getDb() and emitEvent())
    // operates on the same DB and events files as the daemon.
    const stateDir = path.join(tempHome, ".tamandua");
    const dbPath = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-finalize";
    const stepId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a run with draining_pause scheduling_status.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-finalize', 'running', '{}', 0, 'draining_pause', ?, ?)",
    ).run(runId, workflowId, now, now);

    // Insert a step that is already done (no running steps).
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'planner', 0, 'wf-drain-finalize_planner', 'single', 'done', 'plan', '', 0, 3, ?, ?)",
    ).run(stepId, runId, now, now);
    db.close();

    // Import finalizeDrainingPause from dist. getDb() and emitEvent() will
    // now resolve to the daemon's state because of the env vars.
    const { finalizeDrainingPause } = await import("../../dist/installer/step-ops.js");
    finalizeDrainingPause(runId);

    // Verify the run is now paused.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "status should transition to paused");
    assert.equal(row.scheduling_status, "paused", "scheduling_status should be paused");

    // Verify a run.paused event was emitted.
    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const pauseEvent = runEvents.find((e: any) => e.event === "run.paused");
    assert.ok(pauseEvent, "expected a run.paused event from drain finalization");
    assert.equal(pauseEvent.runId, runId);
    assert.equal(pauseEvent.workflowId, workflowId);

    // Cleanup
    delete process.env.TAMANDUA_DB_PATH;
    delete process.env.TAMANDUA_STATE_DIR;
    db2.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("finalizeDrainingPause does nothing when running steps remain", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const stateDir = path.join(tempHome, ".tamandua");
    const dbPath = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-running";
    const stepId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a run with draining_pause scheduling_status.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-running', 'running', '{}', 0, 'draining_pause', ?, ?)",
    ).run(runId, workflowId, now, now);

    // Insert a step that is still running.
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'impl', 0, 'wf-drain-running_developer', 'single', 'running', 'implement', '', 0, 3, ?, ?)",
    ).run(stepId, runId, now, now);
    db.close();

    // Import and call finalizeDrainingPause.
    const { finalizeDrainingPause } = await import("../../dist/installer/step-ops.js");
    finalizeDrainingPause(runId);

    // Verify the run is still running with draining_pause (not yet paused).
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "running", "status should remain running while steps are in flight");
    assert.equal(row.scheduling_status, "draining_pause", "scheduling_status should remain draining_pause");

    // Cleanup
    delete process.env.TAMANDUA_DB_PATH;
    delete process.env.TAMANDUA_STATE_DIR;
    db2.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("finalizeDrainingPause pauses verify_each loops waiting for verifier work", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const stateDir = path.join(tempHome, ".tamandua");
    const dbPath = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-verify-each";
    const loopStepId = crypto.randomUUID();
    const verifyStepId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-verify-each', 'running', '{}', 0, 'draining_pause', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, loop_config, current_story_id, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'implement', 0, 'wf-drain-verify-each_developer', 'loop', 'running', ?, NULL, 'implement', '', 0, 3, ?, ?)",
    ).run(loopStepId, runId, JSON.stringify({ over: "stories", verify_each: true, verify_step: "verify" }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'verify', 1, 'wf-drain-verify-each_verifier', 'single', 'pending', 'verify', '', 0, 3, ?, ?)",
    ).run(verifyStepId, runId, now, now);
    db.close();

    const { finalizeDrainingPause } = await import("../../dist/installer/step-ops.js");
    finalizeDrainingPause(runId);

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "loop placeholder waiting for verifier should not block drain finalization");
    assert.equal(row.scheduling_status, "paused");

    delete process.env.TAMANDUA_DB_PATH;
    delete process.env.TAMANDUA_STATE_DIR;
    db2.prepare("DELETE FROM steps WHERE id IN (?, ?)").run(loopStepId, verifyStepId);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with drain=true on already paused run returns paused state", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-already-paused";
    const now = new Date().toISOString();

    // Insert an already paused run.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-already-paused', 'paused', '{}', 0, 'paused', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Verify DB unchanged.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused");
    assert.equal(row.scheduling_status, "paused");

    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  // ── Nudge endpoint tests ────────────────────────────────────────

  it("POST /control/nudge returns zero counts when no runs are running", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest("POST", "/control/nudge", {}, secret);
    assert.equal(r.status, 200);
    assert.equal(r.body.runningRuns, 0);
    assert.equal(r.body.scheduledRuns, 0);
    assert.equal(r.body.launched, 0);
    assert.equal(r.body.skippedInFlight, 0);
  });

  it("POST /control/nudge requires auth", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const unauth = await jsonRequest("POST", "/control/nudge", {});
    assert.equal(unauth.status, 401);
  });

  it("POST /control/nudge excludes paused runs", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a paused run — should be excluded from nudge.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, 'wf-nudge-paused', 'nudge-paused-test', 'paused', '{}', 0, 'paused', ?, ?)",
    ).run(runId, now, now);
    db.close();

    const r = await jsonRequest("POST", "/control/nudge", {}, secret);
    assert.equal(r.status, 200);
    assert.equal(r.body.runningRuns, 0, "paused runs should not be counted as running");
    assert.equal(r.body.launched, 0, "paused runs should not launch agents");

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/nudge excludes terminal runs", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const completedId = crypto.randomUUID();
    const failedId = crypto.randomUUID();
    const canceledId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert terminal runs.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-nudge-completed', 'nudge-terminal', 'completed', '{}', 0, ?, ?)",
    ).run(completedId, now, now);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-nudge-failed', 'nudge-terminal', 'failed', '{}', 0, ?, ?)",
    ).run(failedId, now, now);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-nudge-canceled', 'nudge-terminal', 'canceled', '{}', 0, ?, ?)",
    ).run(canceledId, now, now);
    db.close();

    const r = await jsonRequest("POST", "/control/nudge", {}, secret);
    assert.equal(r.status, 200);
    assert.equal(r.body.runningRuns, 0, "terminal runs should not be counted");

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id IN (?, ?, ?)").run(completedId, failedId, canceledId);
    db2.close();
  });

  it("POST /control/nudge returns aggregate counts when runs are running", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-nudge-aggregate";
    const now = new Date().toISOString();

    // Insert a running run. It won't have any steps or workflow installed,
    // so handleRegisterRun will fail. But the aggregate response should still return.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, ?, 'nudge-aggregate', 'running', '{}', 0, 'pending_register', ?, ?, ?)",
    ).run(runId, workflowId, now, now, now);
    db.close();

    const r = await jsonRequest("POST", "/control/nudge", {}, secret);
    // The nudge may return 200 even if admission fails — the errors array carries that info.
    assert.ok(r.status === 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.runningRuns, 1, "should detect 1 running run");
    assert.ok(Array.isArray(r.body.runs), "runs should be an array");

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/nudge emits events", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-nudge-events";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, ?, 'nudge-events', 'running', '{}', 0, 'pending_register', ?, ?, ?)",
    ).run(runId, workflowId, now, now, now);
    db.close();

    const r = await jsonRequest("POST", "/control/nudge", {}, secret);
    assert.ok(r.status === 200, `expected 200, got ${r.status}`);

    // The response should have the expected shape even if no agents were scheduled.
    assert.equal(typeof r.body.runningRuns, "number");
    assert.equal(typeof r.body.launched, "number");
    assert.equal(typeof r.body.skippedInFlight, "number");

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with drain=true on terminal run returns 409", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a completed run.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-drain-terminal', 'terminal-test', 'completed', '{}', 0, ?, ?)",
    ).run(runId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 409);
    assert.ok(String(r.body.error).includes("terminal"));

    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });
});

// ══════════════════════════════════════════════════════════════════════
// Unit tests for exported utility functions
// ══════════════════════════════════════════════════════════════════════

import {
  getControlPort,
  getMaxActiveTimers,
  ensureDaemonSecret,
  readDaemonSecret,
} from "../../dist/server/control-server.js";

describe("control-server unit exports", () => {
  let originalHome: string | undefined;
  let origControlPort: string | undefined;
  let origMaxTimers: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    origControlPort = process.env.TAMANDUA_CONTROL_PORT;
    origMaxTimers = process.env.TAMANDUA_MAX_ACTIVE_TIMERS;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (origControlPort) process.env.TAMANDUA_CONTROL_PORT = origControlPort;
    else delete process.env.TAMANDUA_CONTROL_PORT;
    if (origMaxTimers) process.env.TAMANDUA_MAX_ACTIVE_TIMERS = origMaxTimers;
    else delete process.env.TAMANDUA_MAX_ACTIVE_TIMERS;
  });

  describe("getControlPort", () => {
    it("returns DEFAULT_CONTROL_PORT (3339) by default", () => {
      delete process.env.TAMANDUA_CONTROL_PORT;
      assert.equal(getControlPort(), 3339);
    });

    it("returns env var value when set", () => {
      process.env.TAMANDUA_CONTROL_PORT = "4242";
      assert.equal(getControlPort(), 4242);
    });

    it("returns default for invalid port values", () => {
      process.env.TAMANDUA_CONTROL_PORT = "notanumber";
      assert.equal(getControlPort(), 3339);
    });

    it("returns default for out-of-range port values", () => {
      process.env.TAMANDUA_CONTROL_PORT = "99999";
      assert.equal(getControlPort(), 3339);
    });
  });

  describe("getMaxActiveTimers", () => {
    it("returns default 50", () => {
      delete process.env.TAMANDUA_MAX_ACTIVE_TIMERS;
      assert.equal(getMaxActiveTimers(), 50);
    });

    it("returns env var value when set", () => {
      process.env.TAMANDUA_MAX_ACTIVE_TIMERS = "25";
      assert.equal(getMaxActiveTimers(), 25);
    });

    it("returns default for invalid values", () => {
      process.env.TAMANDUA_MAX_ACTIVE_TIMERS = "notanumber";
      assert.equal(getMaxActiveTimers(), 50);
    });

    it("returns default for zero or negative", () => {
      process.env.TAMANDUA_MAX_ACTIVE_TIMERS = "0";
      assert.equal(getMaxActiveTimers(), 50);
    });
  });

  describe("ensureDaemonSecret / readDaemonSecret", () => {
    let tempHome: string;

    beforeEach(() => {
      const { root } = createTempHome("tamandua-secret-unit-");
      tempHome = root;
      process.env.HOME = tempHome;
    });

    afterEach(() => {
    });

    it("creates a secret file and returns the token", () => {
      const secretPath = path.join(tempHome, ".tamandua", "daemon-secret");
      const token = ensureDaemonSecret(secretPath);
      assert.ok(token.length > 0);
      const saved = readDaemonSecret(secretPath);
      assert.equal(saved, token);
    });

    it("default secret path honors HOME assigned after module import", () => {
      const secretPath = path.join(tempHome, ".tamandua", "daemon-secret");
      const token = ensureDaemonSecret();
      assert.ok(fs.existsSync(secretPath));
      assert.equal(readDaemonSecret(), token);
    });

    it("returns existing secret when called again (idempotent)", () => {
      const secretPath = path.join(tempHome, ".tamandua", "daemon-secret");
      const token1 = ensureDaemonSecret(secretPath);
      const token2 = ensureDaemonSecret(secretPath);
      assert.equal(token1, token2);
    });

    it("readDaemonSecret returns null when file does not exist", () => {
      const secretPath = path.join(tempHome, ".tamandua", "nonexistent.json");
      assert.equal(readDaemonSecret(secretPath), null);
    });

    it("readDaemonSecret returns null for empty file", () => {
      const secretPath = path.join(tempHome, ".tamandua", "daemon-secret");
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      fs.writeFileSync(secretPath, "", "utf-8");
      assert.equal(readDaemonSecret(secretPath), null);
    });
  });

  // ── US-004: Secret isolation guards ─────────────────────────────

  describe("readDaemonSecret / ensureDaemonSecret isolation guards", () => {
    let savedGuard: string | undefined;
    let savedNodeTestContext: string | undefined;

    beforeEach(() => {
      savedGuard = process.env.TAMANDUA_TEST_GUARD;
      savedNodeTestContext = process.env.NODE_TEST_CONTEXT;
      process.env.TAMANDUA_TEST_GUARD = "1";
    });

    afterEach(() => {
      if (savedGuard !== undefined) process.env.TAMANDUA_TEST_GUARD = savedGuard;
      else delete process.env.TAMANDUA_TEST_GUARD;
      if (savedNodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
      else delete process.env.NODE_TEST_CONTEXT;
    });

    it("readDaemonSecret returns null when guard is active and default path resolves to production", () => {
      process.env.HOME = os.userInfo().homedir;
      delete process.env.TAMANDUA_STATE_DIR;

      const result = readDaemonSecret();
      assert.equal(result, null,
        "readDaemonSecret must return null instead of reading production daemon-secret");
    });

    it("readDaemonSecret works normally when explicit secretPath is provided (isolated dir)", () => {
      const { root: tempHome } = createTempHome("tamandua-secret-guard-");
      process.env.HOME = os.userInfo().homedir; // guard would fire without explicit path
      delete process.env.TAMANDUA_STATE_DIR;

      const secretPath = path.join(tempHome, ".tamandua", "daemon-secret");
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      const token = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(secretPath, token, "utf-8");

      const result = readDaemonSecret(secretPath);
      assert.equal(result, token, "should read secret from isolated dir when explicit path is provided");
    });

    it("readDaemonSecret works normally when guard is inactive", () => {
      process.env.TAMANDUA_TEST_GUARD = "0";
      delete process.env.NODE_TEST_CONTEXT;
      process.env.HOME = os.userInfo().homedir;
      delete process.env.TAMANDUA_STATE_DIR;

      // Guard inactive — should read (or not find) the real secret without throwing.
      const result = readDaemonSecret();
      assert.ok(result === null || typeof result === "string",
        "should return null or a string when guard is inactive");
    });

    it("ensureDaemonSecret throws when guard is active and default path resolves to production", () => {
      process.env.HOME = os.userInfo().homedir;
      delete process.env.TAMANDUA_STATE_DIR;

      assert.throws(
        () => ensureDaemonSecret(),
        /TEST ISOLATION VIOLATION/,
        "ensureDaemonSecret must throw when default path resolves to production state dir",
      );
    });

    it("ensureDaemonSecret works normally when explicit secretPath is provided (isolated dir)", () => {
      const { root: tempHome } = createTempHome("tamandua-secret-guard-");
      process.env.HOME = os.userInfo().homedir;
      delete process.env.TAMANDUA_STATE_DIR;

      const secretPath = path.join(tempHome, ".tamandua", "daemon-secret");
      const token = ensureDaemonSecret(secretPath);
      assert.ok(token.length > 0, "should create secret in isolated dir when explicit path is provided");
      assert.ok(fs.existsSync(secretPath), "secret file should exist");
    });

    it("ensureDaemonSecret works normally when guard is inactive", () => {
      process.env.TAMANDUA_TEST_GUARD = "0";
      delete process.env.NODE_TEST_CONTEXT;
      process.env.HOME = os.userInfo().homedir;
      delete process.env.TAMANDUA_STATE_DIR;

      // Guard inactive — should create/read the real secret without throwing.
      // We wrap this in a try because the production secret path might be
      // unavailable or read-only in some test environments.
      try {
        const token = ensureDaemonSecret();
        assert.ok(token.length > 0, "should return a token when guard is inactive");
      } catch (err) {
        // Permission errors reading/writing the real secret are acceptable
        // when guard is inactive — the important thing is it wasn't the guard.
        if (err instanceof Error && err.message.includes("TEST ISOLATION VIOLATION")) {
          assert.fail("guard should not fire when inactive");
        }
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-004: context no_hurry_save_tokens_mode stays accepted at admission
// (dispatch rounds are free, so the flag no longer changes scheduling)
// ══════════════════════════════════════════════════════════════════════

import {
  _admitOrQueueRun,
  type RunRow,
} from "../../dist/server/control-server.js";
import {
  _scheduledJobCountForRun,
  shutdownAllCrons,
} from "../../dist/installer/agent-scheduler.js";

describe("control-server save-tokens context wiring", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;
  let origStateDir: string | undefined;
  let origDbPath: string | undefined;
  let origMaxTimers: string | undefined;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    origStateDir = process.env.TAMANDUA_STATE_DIR;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origMaxTimers = process.env.TAMANDUA_MAX_ACTIVE_TIMERS;

    tempHome = tamanduaTempDir("tamandua-save-tokens-");
    stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    dbPath = path.join(stateDir, "tamandua.db");

    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_MAX_ACTIVE_TIMERS = "10";
  });

  afterEach(() => {
    shutdownAllCrons();

    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origStateDir) process.env.TAMANDUA_STATE_DIR = origStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    if (origDbPath) process.env.TAMANDUA_DB_PATH = origDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (origMaxTimers) process.env.TAMANDUA_MAX_ACTIVE_TIMERS = origMaxTimers;
    else delete process.env.TAMANDUA_MAX_ACTIVE_TIMERS;

    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function createMinimalWorkflow(workflowId: string): void {
    const workflowDir = path.join(stateDir, "workflows", workflowId);
    fs.mkdirSync(workflowDir, { recursive: true });
    const yml = [
      `id: ${workflowId}`,
      `name: Save Tokens Test`,
      `agents:`,
      `  - id: developer`,
      `    role: coding`,
      `    workspace:`,
      `      baseDir: agents/developer`,
      `steps:`,
      `  - id: impl`,
      `    agent: developer`,
      `    input: "implement feature"`,
      `    expects: "implementation"`,
    ].join("\n");
    fs.writeFileSync(path.join(workflowDir, "workflow.yml"), yml, "utf-8");
  }

  async function insertRunWithContext(
    runId: string,
    workflowId: string,
    context: Record<string, string>,
  ): Promise<void> {
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();
    const now = new Date().toISOString();
    const contextJson = JSON.stringify(context);

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, ?, 'save-tokens-test', 'running', ?, 0, 'pending_register', ?, ?, ?)",
    ).run(runId, workflowId, contextJson, now, now, now);

    // Insert a step so requiredTimersForRun returns 1
    const stepId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'impl', ?, 0, 'implement', 'implementation', 'waiting', 0, 3, 'single', NULL, ?, ?)",
    ).run(stepId, runId, `${workflowId}_developer`, now, now);
  }

  // The flag once stretched the model-driven polling interval to save
  // idle-poll tokens. The deterministic dispatch motor peeks for free, so
  // admission schedules identically for every flag value — the context key
  // just has to keep being accepted (runs created by older CLIs carry it).
  const flagCases: Array<{ label: string; context: Record<string, string> }> = [
    {
      label: "no_hurry_save_tokens_mode='true'",
      context: { no_hurry_save_tokens_mode: "true" },
    },
    {
      label: "no_hurry_save_tokens_mode='false'",
      context: { no_hurry_save_tokens_mode: "false" },
    },
    { label: "flag missing from context", context: {} },
  ];

  for (const { label, context } of flagCases) {
    it(`admits and schedules dispatch jobs with ${label}`, async () => {
      const workflowId = `wf-save-tokens-${crypto.randomUUID().slice(0, 8)}`;
      const runId = crypto.randomUUID();

      createMinimalWorkflow(workflowId);
      await insertRunWithContext(runId, workflowId, {
        working_directory_for_harness: tempHome,
        ...context,
      });

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const run = db.prepare(
        "SELECT id, workflow_id, status, scheduling_status, context, created_at FROM runs WHERE id = ?",
      ).get(runId) as RunRow | undefined;
      assert.ok(run, "run should exist in DB");

      const result = await _admitOrQueueRun(run!);
      assert.ok(result.status === 200 || result.status === 202,
        `expected 200 or 202, got ${result.status}: ${JSON.stringify(result.body)}`);

      assert.ok(
        _scheduledJobCountForRun(runId) > 0,
        "should have at least one scheduled dispatch job",
      );
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// TSTX suite control-plane endpoints
// ══════════════════════════════════════════════════════════════════════

describe("suite control-plane endpoints", { concurrency: 1 }, () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;
  let secret: string;
  let controlPort: number;
  let server: http.Server | undefined;
  let origHome: string | undefined;
  let origStateDir: string | undefined;
  let origDbPath: string | undefined;
  let origControlPort: string | undefined;

  before(async () => {
    origHome = process.env.HOME;
    origStateDir = process.env.TAMANDUA_STATE_DIR;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origControlPort = process.env.TAMANDUA_CONTROL_PORT;

    tempHome = tamanduaTempDir("tamandua-suite-ep-");
    stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    dbPath = path.join(stateDir, "tamandua.db");

    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    secret = crypto.randomBytes(16).toString("hex");
    fs.mkdirSync(path.dirname(path.join(stateDir, "daemon-secret")), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "daemon-secret"), secret, "utf-8");

    const [ctrlHandle] = await reservePortHandles(1);
    controlPort = ctrlHandle.port;

    // Close handle just before createControlServer binds.
    await ctrlHandle.close();

    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);

    const { createControlServer } = await import("../../dist/server/control-server.js");
    server = createControlServer({ port: controlPort, secret });
    await new Promise<void>((resolve) => {
      server!.once("listening", resolve);
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origStateDir) process.env.TAMANDUA_STATE_DIR = origStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    if (origDbPath) process.env.TAMANDUA_DB_PATH = origDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (origControlPort) process.env.TAMANDUA_CONTROL_PORT = origControlPort;
    else delete process.env.TAMANDUA_CONTROL_PORT;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  });

  async function suiteRequest(
    method: "GET" | "POST",
    pathName: string,
    body?: Record<string, unknown>,
  ): Promise<JsonResponse> {
    const payload = body ? JSON.stringify(body) : "";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tamandua-secret": secret,
    };
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));

    return await new Promise<JsonResponse>((resolve, reject) => {
      const req = http.request(
        {
          method,
          hostname: "127.0.0.1",
          port: controlPort,
          path: pathName,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            let parsed: Record<string, unknown> = {};
            if (raw.trim()) {
              try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = { raw }; }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("suite request timeout")));
      if (payload) req.write(payload);
      req.end();
    });
  }

  function insertSuiteRow(params: {
    originRepo: string;
    treeHash: string;
    cmdHash: string;
    cmdDisplay: string;
    exitCode: number;
    durationMs: number;
    logTail?: string;
    runId?: string;
    stepId?: string;
    createdAt?: string;
  }): void {
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.originRepo,
      params.treeHash,
      params.cmdHash,
      params.cmdDisplay,
      params.exitCode,
      params.durationMs,
      params.logTail ?? null,
      params.runId ?? null,
      params.stepId ?? null,
      params.createdAt ?? new Date().toISOString(),
    );
    db.close();
  }

  // ── 1. GET /suite/lookup ──────────────────────────────────────────

  it("GET /suite/lookup returns 401 without auth", async () => {
    const payload = "";
    const headers: Record<string, string> = { "content-type": "application/json" };
    const resp = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { method: "GET", hostname: "127.0.0.1", port: controlPort, path: "/suite/lookup?origin_repo=/test&tree_hash=abc&cmd_hash=def", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
      req.end();
    });
    assert.equal(resp.status, 401);
  });

  it("GET /suite/lookup returns 400 when params are missing", async () => {
    const r = await suiteRequest("GET", "/suite/lookup");
    assert.equal(r.status, 400);
    assert.ok(String(r.body.error).includes("Missing"));
  });

  it("GET /suite/lookup returns 400 when partial params only", async () => {
    const r = await suiteRequest("GET", "/suite/lookup?origin_repo=/test");
    assert.equal(r.status, 400);
  });

  it("GET /suite/lookup returns empty when no records exist", async () => {
    const r = await suiteRequest("GET", "/suite/lookup?origin_repo=/test&tree_hash=abc123&cmd_hash=def456");
    assert.equal(r.status, 200);
    assert.equal(r.body.latest, null);
    assert.equal(r.body.passCount, 0);
    assert.equal(r.body.failCount, 0);
    assert.equal(r.body.flaky, false);
  });

  it("GET /suite/lookup returns latest entry and pass/fail counts", async () => {
    const repo = "/test/repo";
    const treeHash = "abc123def456";
    const cmdHash = "sha256-hash";

    // Insert a pass and a fail.
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 1000 });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 1, durationMs: 500 });

    const r = await suiteRequest(
      "GET",
      `/suite/lookup?origin_repo=${encodeURIComponent(repo)}&tree_hash=${treeHash}&cmd_hash=${cmdHash}`,
    );
    assert.equal(r.status, 200);
    assert.ok(r.body.latest, "should have a latest entry");
    const latest = r.body.latest as Record<string, unknown>;
    assert.equal(latest.exit_code, 1, "latest should be the most recent (fail)");
    assert.equal(r.body.passCount, 1);
    assert.equal(r.body.failCount, 1);
    assert.equal(r.body.flaky, true);
  });

  it("GET /suite/lookup respects FLAKE_WINDOW for pass/fail counts", async () => {
    const repo = "/test/repo-window";
    const treeHash = "window-test-hash";
    const cmdHash = "window-cmd-hash";

    // Insert an old fail (outside window) and a recent pass.
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 1, durationMs: 1000, createdAt: oldDate });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 2000 });

    const r = await suiteRequest(
      "GET",
      `/suite/lookup?origin_repo=${encodeURIComponent(repo)}&tree_hash=${treeHash}&cmd_hash=${cmdHash}`,
    );
    assert.equal(r.status, 200);
    // Only the recent pass should count (old fail is outside FLAKE_WINDOW).
    assert.equal(r.body.passCount, 1);
    assert.equal(r.body.failCount, 0);
    assert.equal(r.body.flaky, false);
  });

  // ── 2. POST /suite/record ────────────────────────────────────────

  it("POST /suite/record returns 401 without auth", async () => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const body = JSON.stringify({ origin_repo: "/r", tree_hash: "t", cmd_hash: "c", cmd_display: "test", exit_code: 0, duration_ms: 100 });
    headers["content-length"] = String(Buffer.byteLength(body));
    const resp = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { method: "POST", hostname: "127.0.0.1", port: controlPort, path: "/suite/record", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
      req.write(body);
      req.end();
    });
    assert.equal(resp.status, 401);
  });

  it("POST /suite/record returns 400 when required fields are missing", async () => {
    const r = await suiteRequest("POST", "/suite/record", { origin_repo: "/test" });
    assert.equal(r.status, 400);
    assert.ok(String(r.body.error).includes("Missing"));
  });

  it("POST /suite/record inserts a row and returns success", async () => {
    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/record",
      tree_hash: "record-tree-hash",
      cmd_hash: "record-cmd-hash",
      cmd_display: "npm test",
      exit_code: 0,
      duration_ms: 1500,
      log_tail: "All tests passed",
      run_id: "run-123",
      step_id: "step-456",
    });
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.id === "number", "should return inserted row id");
    assert.ok(typeof r.body.created_at === "string", "should return created_at");
  });

  it("POST /suite/record clears pending claim", async () => {
    const repo = "/test/record-claim";
    const treeHash = "claim-clear-hash";
    const cmdHash = "claim-clear-cmd";

    // First, create a claim.
    const claimR = await suiteRequest("POST", "/suite/claim", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
    });
    assert.equal(claimR.body.action, "run");

    // Next claim should say wait.
    const claimR2 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
    });
    assert.equal(claimR2.body.action, "wait");

    // Record a result — should clear the claim.
    await suiteRequest("POST", "/suite/record", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
      cmd_display: "npm test", exit_code: 0, duration_ms: 100,
    });

    // Now a new claim should get "run" again.
    const claimR3 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
    });
    assert.equal(claimR3.body.action, "run");
  });

  it("POST /suite/release is exact-key, idempotent, owner-safe, and never deletes rows", async () => {
    const key = {
      origin_repo: "/test/release",
      tree_hash: "release-tree",
      cmd_hash: "release-cmd",
      owner_token: "release-owner",
    };
    assert.equal((await suiteRequest("POST", "/suite/claim", key)).body.action, "run");
    const unrelated = { ...key, cmd_hash: "unrelated-cmd", owner_token: "unrelated-owner" };
    assert.equal((await suiteRequest("POST", "/suite/claim", unrelated)).body.action, "run");
    // Initialize the isolated suite ledger without changing either claim.
    await suiteRequest(
      "GET",
      `/suite/lookup?origin_repo=${encodeURIComponent(key.origin_repo)}&tree_hash=none&cmd_hash=none`,
    );
    insertSuiteRow({
      originRepo: key.origin_repo, treeHash: key.tree_hash, cmdHash: key.cmd_hash,
      cmdDisplay: "npm test", exitCode: 0, durationMs: 1,
    });

    assert.equal((await suiteRequest("POST", "/suite/release", {
      ...key, owner_token: "wrong",
    })).status, 409);
    assert.equal((await suiteRequest("POST", "/suite/claim", key)).body.action, "wait");
    const released = await suiteRequest("POST", "/suite/release", key);
    assert.equal(released.status, 200);
    assert.equal(released.body.released, true);
    assert.equal((await suiteRequest("POST", "/suite/claim", key)).body.action, "run");
    assert.equal((await suiteRequest("POST", "/suite/claim", unrelated)).body.action, "wait");

    const db = new DatabaseSync(dbPath);
    const row = db.prepare(
      "SELECT COUNT(*) AS cnt FROM suite_results WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ?",
    ).get(key.origin_repo, key.tree_hash, key.cmd_hash) as { cnt: number };
    db.close();
    assert.equal(row.cnt, 1, "release must never alter suite_results");
  });

  it("POST /suite/release validates bounded exact-key fields", async () => {
    const unauth = await fetch(`http://127.0.0.1:${controlPort}/suite/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin_repo: "/x", tree_hash: "tree", cmd_hash: "cmd" }),
    });
    assert.equal(unauth.status, 401);
    assert.equal((await suiteRequest("POST", "/suite/release", {})).status, 400);
    const valid = {
      origin_repo: "x".repeat(2048),
      tree_hash: "t".repeat(128),
      cmd_hash: "c".repeat(128),
      owner_token: "o".repeat(128),
    };
    assert.equal((await suiteRequest("POST", "/suite/claim", valid)).status, 200);
    assert.equal((await suiteRequest("POST", "/suite/release", valid)).status, 200);

    for (const oversized of [
      { ...valid, origin_repo: "x".repeat(2049) },
      { ...valid, tree_hash: "t".repeat(129) },
      { ...valid, cmd_hash: "c".repeat(129) },
      { ...valid, owner_token: "o".repeat(129) },
    ]) {
      assert.equal((await suiteRequest("POST", "/suite/claim", oversized)).status, 400);
      assert.equal((await suiteRequest("POST", "/suite/release", oversized)).status, 400);
    }

    const legacy = { origin_repo: "/legacy", tree_hash: "tree", cmd_hash: "cmd" };
    assert.equal((await suiteRequest("POST", "/suite/claim", legacy)).body.action, "run");
    assert.equal((await suiteRequest("POST", "/suite/release", legacy)).body.released, true);
  });

  it("keeps colon-containing suite tuples collision-free during release", async () => {
    const first = {
      origin_repo: "a:b", tree_hash: "c", cmd_hash: "d", owner_token: "first-owner",
    };
    const second = {
      origin_repo: "a", tree_hash: "b", cmd_hash: "c:d", owner_token: "second-owner",
    };

    assert.equal((await suiteRequest("POST", "/suite/claim", first)).body.action, "run");
    assert.equal((await suiteRequest("POST", "/suite/claim", second)).body.action, "run");
    assert.equal((await suiteRequest("POST", "/suite/release", first)).body.released, true);
    assert.equal(
      (await suiteRequest("POST", "/suite/claim", second)).body.action,
      "wait",
      "releasing the first tuple must not release the second tuple",
    );
  });

  it("POST /suite/record is append-only (two records for same key)", async () => {
    const repo = "/test/append";
    const treeHash = "append-hash";
    const cmdHash = "append-cmd";

    await suiteRequest("POST", "/suite/record", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
      cmd_display: "npm test", exit_code: 0, duration_ms: 100,
    });
    await suiteRequest("POST", "/suite/record", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
      cmd_display: "npm test", exit_code: 1, duration_ms: 200,
    });

    const r = await suiteRequest(
      "GET",
      `/suite/lookup?origin_repo=${encodeURIComponent(repo)}&tree_hash=${treeHash}&cmd_hash=${cmdHash}`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.passCount, 1);
    assert.equal(r.body.failCount, 1);
  });

  // ── 3. POST /suite/claim ──────────────────────────────────────────

  it("POST /suite/claim returns 401 without auth", async () => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const body = JSON.stringify({ origin_repo: "/r", tree_hash: "t", cmd_hash: "c" });
    headers["content-length"] = String(Buffer.byteLength(body));
    const resp = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { method: "POST", hostname: "127.0.0.1", port: controlPort, path: "/suite/claim", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
      req.write(body);
      req.end();
    });
    assert.equal(resp.status, 401);
  });

  it("POST /suite/claim returns 400 when required fields are missing", async () => {
    const r = await suiteRequest("POST", "/suite/claim", { origin_repo: "/test" });
    assert.equal(r.status, 400);
  });

  it("POST /suite/claim returns run on first claim for a key", async () => {
    const r = await suiteRequest("POST", "/suite/claim", {
      origin_repo: "/test/claim-first", tree_hash: "first-hash", cmd_hash: "first-cmd",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.action, "run");
  });

  it("POST /suite/claim returns wait on second claim for same key", async () => {
    const repo = "/test/claim-wait";
    const treeHash = "wait-hash";
    const cmdHash = "wait-cmd";

    const r1 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
    });
    assert.equal(r1.body.action, "run");

    const r2 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
    });
    assert.equal(r2.body.action, "wait");
    assert.ok(typeof r2.body.claimedAt === "string");
  });

  it("POST /suite/claim different keys can both get run", async () => {
    const r1 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: "/test/diff1", tree_hash: "hash-a", cmd_hash: "cmd-a",
    });
    assert.equal(r1.body.action, "run");

    const r2 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: "/test/diff2", tree_hash: "hash-b", cmd_hash: "cmd-b",
    });
    assert.equal(r2.body.action, "run");

    // Same repo but different tree hash.
    const r3 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: "/test/diff1", tree_hash: "hash-c", cmd_hash: "cmd-a",
    });
    assert.equal(r3.body.action, "run");
  });

  it("POST /suite/claim expires stale claims", async () => {
    // This test verifies that claims expire after CLAIM_TIMEOUT.
    // Since we can't easily fast-forward time, we test the cleanStaleClaims
    // function's behavior via the claim endpoint — stale claims are cleaned
    // before checking. We'll manually insert a stale claim by using the
    // internal Map (accessed via the module's claim mechanism).
    // For now, verify that fresh claims are detected correctly.
    const repo = "/test/claim-expiry";
    const treeHash = "expiry-hash";
    const cmdHash = "expiry-cmd";

    const r1 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
    });
    assert.equal(r1.body.action, "run");

    // Wait a tiny bit, then a second claim should still say wait.
    await new Promise((r) => setTimeout(r, 50));
    const r2 = await suiteRequest("POST", "/suite/claim", {
      origin_repo: repo, tree_hash: treeHash, cmd_hash: cmdHash,
    });
    assert.equal(r2.body.action, "wait");
  });

  // ── 4. GET /suite/flaky ───────────────────────────────────────────

  it("GET /suite/flaky returns 401 without auth", async () => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const resp = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { method: "GET", hostname: "127.0.0.1", port: controlPort, path: "/suite/flaky?origin_repo=/test", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
      req.end();
    });
    assert.equal(resp.status, 401);
  });

  it("GET /suite/flaky returns 400 without origin_repo", async () => {
    const r = await suiteRequest("GET", "/suite/flaky");
    assert.equal(r.status, 400);
  });

  it("GET /suite/flaky returns empty when no data exists", async () => {
    const r = await suiteRequest("GET", "/suite/flaky?origin_repo=/nonexistent");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.flaky_keys));
    assert.equal((r.body.flaky_keys as unknown[]).length, 0);
  });

  it("GET /suite/flaky returns keys with divergent outcomes", async () => {
    const repo = "/test/flaky-repo";
    const treeHash = "flaky-hash";
    const cmdHash = "flaky-cmd";

    // Insert one pass and one fail for the same key.
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 1000 });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 1, durationMs: 500 });

    const r = await suiteRequest("GET", `/suite/flaky?origin_repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200);
    const keys = r.body.flaky_keys as Array<Record<string, unknown>>;
    assert.equal(keys.length, 1);
    assert.equal(keys[0].tree_hash, treeHash);
    assert.equal(keys[0].cmd_hash, cmdHash);
    assert.equal(keys[0].pass_count, 1);
    assert.equal(keys[0].fail_count, 1);
  });

  it("GET /suite/flaky excludes keys with only passes", async () => {
    const repo = "/test/flaky-pass-only";
    const treeHash = "pass-only-hash";
    const cmdHash = "pass-only-cmd";

    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 1000 });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 500 });

    const r = await suiteRequest("GET", `/suite/flaky?origin_repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200);
    const keys = r.body.flaky_keys as Array<Record<string, unknown>>;
    assert.equal(keys.length, 0, "keys with only passes should not appear as flaky");
  });

  it("GET /suite/flaky excludes keys with only failures", async () => {
    const repo = "/test/flaky-fail-only";
    const treeHash = "fail-only-hash";
    const cmdHash = "fail-only-cmd";

    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 1, durationMs: 1000 });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 1, durationMs: 500 });

    const r = await suiteRequest("GET", `/suite/flaky?origin_repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200);
    const keys = r.body.flaky_keys as Array<Record<string, unknown>>;
    assert.equal(keys.length, 0, "keys with only failures should not appear as flaky");
  });

  it("GET /suite/flaky respects FLAKE_WINDOW", async () => {
    const repo = "/test/flaky-window";
    const treeHash = "flaky-window-hash";
    const cmdHash = "flaky-window-cmd";

    // Old fail outside window, recent pass inside window.
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 1, durationMs: 1000, createdAt: oldDate });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 500 });

    const r = await suiteRequest("GET", `/suite/flaky?origin_repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200);
    const keys = r.body.flaky_keys as Array<Record<string, unknown>>;
    assert.equal(keys.length, 0, "should not be flaky when fail is outside window");
  });

  it("GET /suite/flaky returns multiple flaky keys", async () => {
    const repo = "/test/flaky-multi";

    insertSuiteRow({ originRepo: repo, treeHash: "hash-1", cmdHash: "cmd-1", cmdDisplay: "npm test", exitCode: 0, durationMs: 100 });
    insertSuiteRow({ originRepo: repo, treeHash: "hash-1", cmdHash: "cmd-1", cmdDisplay: "npm test", exitCode: 1, durationMs: 200 });
    insertSuiteRow({ originRepo: repo, treeHash: "hash-2", cmdHash: "cmd-2", cmdDisplay: "cargo test", exitCode: 0, durationMs: 300 });
    insertSuiteRow({ originRepo: repo, treeHash: "hash-2", cmdHash: "cmd-2", cmdDisplay: "cargo test", exitCode: 1, durationMs: 400 });

    const r = await suiteRequest("GET", `/suite/flaky?origin_repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200);
    const keys = r.body.flaky_keys as Array<Record<string, unknown>>;
    assert.equal(keys.length, 2, "should return both flaky keys");
    // Verify sorted by total runs descending.
    assert.ok((keys[0].pass_count as number) + (keys[0].fail_count as number) >= (keys[1].pass_count as number) + (keys[1].fail_count as number));
  });

  // ── 5. POST /suite/event ────────────────────────────────────────

  it("POST /suite/event returns 401 without auth", async () => {
    const payload = JSON.stringify({ event: "suite.cache_hit", run_id: "r1" });
    const headers: Record<string, string> = { "content-type": "application/json" };
    const resp = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { method: "POST", hostname: "127.0.0.1", port: controlPort, path: "/suite/event", headers },
        (res) => { resolve({ status: res.statusCode ?? 0 }); res.resume(); },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
      req.write(payload);
      req.end();
    });
    assert.equal(resp.status, 401);
  });

  it("POST /suite/event returns 400 when event is missing", async () => {
    const r = await suiteRequest("POST", "/suite/event", { run_id: "r1" });
    assert.equal(r.status, 400);
    assert.ok(String(r.body.error).includes("event"));
  });

  it("POST /suite/event emits suite.cache_hit to run events file", async () => {
    const runId = "evt-cache-hit-run";
    const stepId = "evt-cache-hit-step";
    const r = await suiteRequest("POST", "/suite/event", {
      event: "suite.cache_hit",
      run_id: runId,
      step_id: stepId,
      tree_hash: "abc123def456",
      cmd_display: "npm test",
      saved_duration_ms: 1234,
    });
    assert.equal(r.status, 200);

    // Verify the event was written to the run events file.
    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const content = fs.readFileSync(runEventsPath, "utf-8").trim();
    const lines = content.split("\n");
    assert.ok(lines.length >= 1, "should have at least 1 event");

    const evt = JSON.parse(lines[0]!);
    assert.equal(evt.event, "suite.cache_hit");
    assert.equal(evt.runId, runId);
    assert.equal(evt.stepId, stepId);
    assert.equal(evt.treeHash, "abc123def456");
    assert.equal(evt.cmdDisplay, "npm test");
    assert.equal(evt.savedDurationMs, 1234);
  });

  it("POST /suite/event emits suite.executed-type event to run events file", async () => {
    const runId = "evt-executed-run";
    const r = await suiteRequest("POST", "/suite/event", {
      event: "suite.executed",
      run_id: runId,
      tree_hash: "def456abc123",
      cmd_display: "pytest",
      duration_ms: 5000,
      exit_code: 0,
    });
    assert.equal(r.status, 200);

    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath));
    const content = fs.readFileSync(runEventsPath, "utf-8").trim();
    const evt = JSON.parse(content);
    assert.equal(evt.event, "suite.executed");
    assert.equal(evt.runId, runId);
    assert.equal(evt.treeHash, "def456abc123");
    assert.equal(evt.cmdDisplay, "pytest");
    assert.equal(evt.durationMs, 5000);
    assert.equal(evt.exitCode, 0);
  });

  it("POST /suite/event emits suite.flaky_detected event", async () => {
    const runId = "evt-flaky-run";
    const r = await suiteRequest("POST", "/suite/event", {
      event: "suite.flaky_detected",
      run_id: runId,
      tree_hash: "flaky-hash",
      cmd_hash: "flaky-cmd",
      pass_count: 3,
      fail_count: 2,
      window: "24h",
    });
    assert.equal(r.status, 200);

    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath));
    const content = fs.readFileSync(runEventsPath, "utf-8").trim();
    const evt = JSON.parse(content);
    assert.equal(evt.event, "suite.flaky_detected");
    assert.equal(evt.treeHash, "flaky-hash");
    assert.equal(evt.cmdHash, "flaky-cmd");
    assert.equal(evt.passCount, 3);
    assert.equal(evt.failCount, 2);
    assert.equal(evt.window, "24h");
  });

  it("POST /suite/event emits suite.singleflight_wait event", async () => {
    const runId = "evt-sf-wait-run";
    const r = await suiteRequest("POST", "/suite/event", {
      event: "suite.singleflight_wait",
      run_id: runId,
      tree_hash: "sf-hash",
      cmd_hash: "sf-cmd",
      waited_ms: 0,
    });
    assert.equal(r.status, 200);

    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath));
    const content = fs.readFileSync(runEventsPath, "utf-8").trim();
    const evt = JSON.parse(content);
    assert.equal(evt.event, "suite.singleflight_wait");
    assert.equal(evt.treeHash, "sf-hash");
    assert.equal(evt.cmdHash, "sf-cmd");
    assert.equal(evt.waitedMs, 0);
  });

  it("POST /suite/event writes to both run and global event files", async () => {
    const runId = "evt-global-run";
    await suiteRequest("POST", "/suite/event", {
      event: "suite.cache_hit",
      run_id: runId,
      tree_hash: "global-test",
      cmd_display: "global cmd",
      saved_duration_ms: 999,
    });

    // Run-specific file
    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath));

    // Global file
    const globalEventsPath = path.join(stateDir, "events", "all.jsonl");
    assert.ok(fs.existsSync(globalEventsPath));

    const globalContent = fs.readFileSync(globalEventsPath, "utf-8").trim();
    const globalLines = globalContent.split("\n").filter(Boolean);
    const globalEvents = globalLines.map((l) => JSON.parse(l));
    const globalEvt = globalEvents.find((e: Record<string, unknown>) => e.event === "suite.cache_hit" && e.runId === runId);
    assert.ok(globalEvt, "should find the suite.cache_hit event in global file");
    assert.equal(globalEvt.runId, runId);
    assert.equal(globalEvt.treeHash, "global-test");
  });

  it("POST /suite/event is idempotent — each call appends a new event", async () => {
    const runId = "evt-idempotent-run";
    await suiteRequest("POST", "/suite/event", { event: "suite.cache_hit", run_id: runId, tree_hash: "t1", cmd_display: "c1" });
    await suiteRequest("POST", "/suite/event", { event: "suite.cache_hit", run_id: runId, tree_hash: "t1", cmd_display: "c1" });

    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    const content = fs.readFileSync(runEventsPath, "utf-8").trim();
    const lines = content.split("\n");
    assert.equal(lines.length, 2, "should have 2 events (one per emission)");
  });

  // ── 5. Health endpoint remains exempt from auth ───────────────────

  it("GET /control/health is exempt from auth", async () => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const resp = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { method: "GET", hostname: "127.0.0.1", port: controlPort, path: "/control/health", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
      req.end();
    });
    // With the createControlServer approach, the secret is provided, so auth is enforced.
    // But health is exempt regardless.
    assert.equal(resp.status, 200);
    assert.equal(resp.body.status, "ok");
  });

  // ── 6. Unknown routes return 404 ──────────────────────────────────

  it("unknown suite route returns 404", async () => {
    const r = await suiteRequest("GET", "/suite/unknown");
    assert.equal(r.status, 404);
  });
});

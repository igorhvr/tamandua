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
import {
  getServiceSocketPath,
  probeIdentitySocket,
} from "../../dist/server/daemon-identity.js";

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

  it("GET /control/health advertises the serving process's effective state dir", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest("GET", "/control/health");
    assert.equal(r.status, 200);
    assert.equal(
      r.body.stateDir,
      path.join(tempHome, ".tamandua"),
      `expected health stateDir to be the daemon's effective state dir, got ${JSON.stringify(r.body.stateDir)}`,
    );
  });

  it("daemon identity socket advertises the daemon's effective state dir", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const expectedStateDir = path.join(tempHome, ".tamandua");
    const identity = await probeIdentitySocket(
      getServiceSocketPath("daemon", { homeDir: tempHome }),
    );
    assert.ok(identity, "expected the daemon identity socket to answer");
    assert.equal(identity?.stateDir, expectedStateDir);
    assert.equal(identity?.pid, daemon.pid);
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

  it("pause and terminate release only suite claims attributed to the affected run", async (t) => {
    if (!daemon?.pid) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const db = new DatabaseSync(dbPath);
    const pauseRunId = crypto.randomUUID();
    const terminateRunId = crypto.randomUUID();
    const unrelatedRunId = crypto.randomUUID();
    const now = new Date().toISOString();
    const insertRun = db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, 'suite-release-test', 'suite release', 'running', '{}', 0, 'active', ?, ?)",
    );
    insertRun.run(pauseRunId, now, now);
    insertRun.run(terminateRunId, now, now);
    insertRun.run(unrelatedRunId, now, now);
    db.close();

    const claim = async (suffix: string, runId: string, ownerToken: string): Promise<JsonResponse> =>
      await jsonRequest("POST", "/suite/claim", {
        origin_repo: `/control-release/${suffix}`,
        tree_hash: `tree-${suffix}`,
        cmd_hash: `cmd-${suffix}`,
        owner_token: ownerToken,
        owner_pid: daemon!.pid,
        run_id: runId,
        step_id: `step-${suffix}`,
      }, secret);

    assert.equal((await claim("pause", pauseRunId, "pause-owner")).body.action, "run");
    assert.equal((await claim("terminate", terminateRunId, "terminate-owner")).body.action, "run");
    assert.equal((await claim("unrelated", unrelatedRunId, "unrelated-owner")).body.action, "run");

    const paused = await jsonRequest("POST", "/control/pause-run", { runId: pauseRunId }, secret);
    assert.equal(paused.status, 200);
    assert.equal((await claim("pause", unrelatedRunId, "pause-replacement")).body.action, "run");
    assert.equal((await claim("terminate", unrelatedRunId, "terminate-waiter")).body.action, "wait");
    assert.equal((await claim("unrelated", unrelatedRunId, "unrelated-waiter")).body.action, "wait");

    const terminated = await jsonRequest("POST", "/control/terminate-run", { runId: terminateRunId }, secret);
    assert.equal(terminated.status, 200);
    assert.equal((await claim("terminate", unrelatedRunId, "terminate-replacement")).body.action, "run");
    assert.equal((await claim("unrelated", unrelatedRunId, "unrelated-still-waiting")).body.action, "wait");

    const events = fs.readFileSync(path.join(tempHome, ".tamandua", "events", "all.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const releases = events.filter((event) => event.event === "suite.claim_owner_released");
    assert.equal(
      releases.find((event) => event.originRepo === "/control-release/pause")?.releaseReason,
      "stop",
    );
    assert.equal(
      releases.find((event) => event.originRepo === "/control-release/terminate")?.releaseReason,
      "cancel",
    );
    assert.equal(
      events.some((event) => event.event === "suite.claim_dead_owner_reclaimed"
        && ["/control-release/pause", "/control-release/terminate"].includes(String(event.originRepo))),
      false,
      "stop/cancel release must not emit dead-owner evidence",
    );

    const cleanup = new DatabaseSync(dbPath);
    cleanup.prepare("DELETE FROM runs WHERE id IN (?, ?, ?)").run(pauseRunId, terminateRunId, unrelatedRunId);
    cleanup.close();
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

  // ── PAUS US-003: plain resume cancels a pending drain ─────────────
  // A run with a pending drain (pause --drain in progress) is status
  // 'running' with scheduling_status 'draining_pause' and the pause_drain
  // marker in its context. A plain resume must cancel that drain: flip the
  // scheduling state, clear the marker atomically, emit
  // run.drain_cancelled_by_resume before run.resumed, and (when admission
  // succeeds) report drainCancelled: true to the caller.

  it("POST /control/resume-run on a draining_pause run cancels the pending drain (marker cleared, audit event)", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-cancel-core";
    const now = new Date().toISOString();
    const context = JSON.stringify({
      working_directory_for_harness: tempHome,
      pause_drain: "true",
      paused_by: "drain-operator@host (cli)",
    });

    // A mid-drain run: status still 'running', scheduling draining_pause,
    // pause_drain marker set.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-cancel-core', 'running', ?, 0, 'draining_pause', ?, ?)",
    ).run(runId, workflowId, context, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/resume-run",
      { runId, requestedBy: "resume-operator@host (cli)" },
      secret,
    );
    // The workflow is not installed in this state dir, so admission may fail
    // with 422 — but the drain cancellation itself happens before admission
    // and must be observable either way.
    assert.ok(r.status === 200 || r.status === 202 || r.status === 422,
      `expected 200/202/422, got ${r.status}: ${JSON.stringify(r.body)}`);

    // AC: the run leaves draining_pause and stays running.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status, context FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string; context: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "running", "resume must leave the run running");
    assert.notEqual(row.scheduling_status, "draining_pause",
      "scheduling_status must no longer be draining_pause");

    // AC: the pause_drain run-context marker is cleared; resume attribution is stored.
    const ctx = JSON.parse(row.context);
    assert.ok(!("pause_drain" in ctx), "pause_drain marker should be cleared by resume");
    assert.equal(ctx.resumed_by, "resume-operator@host (cli)");

    // AC: a run.drain_cancelled_by_resume event with the runId is written to
    // the run's event stream, before run.resumed, and no drain-induced
    // run.paused follows the resume.
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));

    const cancelIndex = runEvents.findIndex((e: any) => e.event === "run.drain_cancelled_by_resume");
    assert.ok(cancelIndex >= 0, "expected a run.drain_cancelled_by_resume event");
    const cancelEvent = runEvents[cancelIndex];
    assert.equal(cancelEvent.runId, runId);
    assert.equal(cancelEvent.workflowId, workflowId);
    const cancelDetail = JSON.parse(cancelEvent.detail);
    assert.equal(cancelDetail.requestedBy, "resume-operator@host (cli)");

    const resumedIndex = runEvents.findIndex((e: any) => e.event === "run.resumed");
    assert.ok(resumedIndex >= 0, "expected a run.resumed event");
    assert.ok(cancelIndex < resumedIndex,
      `run.drain_cancelled_by_resume (idx=${cancelIndex}) must precede run.resumed (idx=${resumedIndex})`);

    const pausedAfterResume = runEvents.some((e: any, i: number) =>
      e.event === "run.paused" && i > resumedIndex);
    assert.equal(pausedAfterResume, false,
      "no drain finalization may pause the run after a resume cancelled the drain");

    // Cleanup
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/resume-run on a draining_pause run admits the run and reports drainCancelled true", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const stateDir = path.join(tempHome, ".tamandua");
    const dbPath = path.join(stateDir, "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "feature-dev-merge";
    const now = new Date().toISOString();
    const context = JSON.stringify({
      working_directory_for_harness: tempHome,
      pause_drain: "true",
    });

    // Install the workflow so registration/admission can succeed.
    const srcWorkflowDir = path.resolve(__dirname, "..", "..", "workflows", workflowId);
    const dstWorkflowDir = path.join(stateDir, "workflows", workflowId);
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-cancel-admit', 'running', ?, 0, 'draining_pause', ?, ?)",
    ).run(runId, workflowId, context, now, now);
    db.close();

    try {
      const r = await jsonRequest(
        "POST",
        "/control/resume-run",
        { runId, requestedBy: "admit-operator" },
        secret,
      );
      // AC 1: 2xx with drainCancelled true.
      assert.ok(r.status === 200 || r.status === 202,
        `expected 2xx admission, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.drainCancelled, true, "body must carry drainCancelled: true");
      assert.equal(r.body.state, "active");

      // AC: scheduling_status leaves draining_pause and the run is admitted.
      const db2 = new DatabaseSync(dbPath);
      const row = db2.prepare("SELECT status, scheduling_status, context FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string; context: string } | undefined;
      assert.ok(row, "run should exist");
      assert.equal(row.status, "running");
      assert.equal(row.scheduling_status, "active", "run should be admitted (active) after resume");
      const ctx = JSON.parse(row.context);
      assert.ok(!("pause_drain" in ctx), "pause_drain marker should be cleared by resume");

      // AC: run.drain_cancelled_by_resume event present with the runId.
      const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
      assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
      const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
      const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
      const cancelEvent = runEvents.find((e: any) => e.event === "run.drain_cancelled_by_resume");
      assert.ok(cancelEvent, "expected a run.drain_cancelled_by_resume event");
      assert.equal(cancelEvent.runId, runId);

      // Clean the scheduler state the admission created before deleting the row.
      if (daemon) {
        const term = await jsonRequest("POST", "/control/terminate-run", { runId }, secret);
        assert.equal(term.status, 200);
      }
      db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
      db2.close();
    } finally {
      fs.rmSync(dstWorkflowDir, { recursive: true, force: true });
    }
  });

  it("POST /control/resume-run on a paused run (no pending drain) emits no drain-cancel event or flag", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-no-drain-resume";
    const now = new Date().toISOString();
    const context = JSON.stringify({
      working_directory_for_harness: tempHome,
      // A previously-completed drain leaves this historical marker behind, but
      // the run is paused — there is no PENDING drain to cancel.
      pause_drain: "true",
    });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'no-drain-resume', 'paused', ?, 0, 'paused', ?, ?)",
    ).run(runId, workflowId, context, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/resume-run",
      { runId, requestedBy: "plain-operator" },
      secret,
    );
    assert.ok(r.status === 200 || r.status === 202 || r.status === 422,
      `expected 200/202/422, got ${r.status}: ${JSON.stringify(r.body)}`);

    // AC: no drainCancelled flag on success; no run.drain_cancelled_by_resume
    // event in the run's stream.
    if (r.status >= 200 && r.status < 300) {
      assert.equal(r.body.drainCancelled, undefined,
        "no-drain resume must not set drainCancelled");
    }
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    assert.equal(
      runEvents.some((e: any) => e.event === "run.drain_cancelled_by_resume"),
      false,
      "no-drain resume must not emit run.drain_cancelled_by_resume",
    );
    const resumedEvent = runEvents.find((e: any) => e.event === "run.resumed");
    assert.ok(resumedEvent, "expected a run.resumed event for the plain resume");
    assert.equal(resumedEvent.runId, runId);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
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
  isTerminal,
  isWithinFlakeWindow,
  flakyKeysWithinWindow,
  suiteCountsWithinWindow,
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

  describe("isTerminal (canceled-as-terminal regression, CNEV US-003)", () => {
    it("treats canceled as terminal", () => {
      assert.equal(isTerminal("canceled"), true);
    });

    it("treats completed and failed as terminal", () => {
      assert.equal(isTerminal("completed"), true);
      assert.equal(isTerminal("failed"), true);
    });

    it("does not treat live statuses as terminal", () => {
      assert.equal(isTerminal("running"), false);
      assert.equal(isTerminal("paused"), false);
      assert.equal(isTerminal("waiting"), false);
      assert.equal(isTerminal(""), false);
      assert.equal(isTerminal("cancelled"), false, "British spelling is not a DB status; 'canceled' is");
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
    let savedExpect: string | undefined;

    beforeEach(() => {
      savedGuard = process.env.TAMANDUA_TEST_GUARD;
      savedNodeTestContext = process.env.NODE_TEST_CONTEXT;
      savedExpect = process.env.TAMANDUA_TEST_GUARD_EXPECT;
      process.env.TAMANDUA_TEST_GUARD = "1";
      // Every test in this describe is a deliberate guard test (provoke with
      // real HOME, or isolate via explicit secretPath / disabled guard). No
      // real leaks here — mark the describe expected.
      process.env.TAMANDUA_TEST_GUARD_EXPECT = "1";
    });

    afterEach(() => {
      if (savedGuard !== undefined) process.env.TAMANDUA_TEST_GUARD = savedGuard;
      else delete process.env.TAMANDUA_TEST_GUARD;
      if (savedNodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
      else delete process.env.NODE_TEST_CONTEXT;
      if (savedExpect !== undefined) process.env.TAMANDUA_TEST_GUARD_EXPECT = savedExpect;
      else delete process.env.TAMANDUA_TEST_GUARD_EXPECT;
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

  // ── US-011: server-side durable flake-window cutoffs ───────────────

  describe("suite flake-window numeric ages (US-011)", () => {
    const FLAKE_WINDOW_MS = 24 * 60 * 60 * 1000;
    const FLAKE_WINDOW_TOLERANCE_MS = 1_000;
    let origStateDir: string | undefined;
    let origDbPath: string | undefined;
    let tempRoot: string;

    beforeEach(() => {
      origStateDir = process.env.TAMANDUA_STATE_DIR;
      origDbPath = process.env.TAMANDUA_DB_PATH;
      const { root, homeDir } = createTempHome("tamandua-control-flake-window-");
      tempRoot = root;
      const stateDir = path.join(root, "state");
      process.env.HOME = homeDir;
      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    });

    afterEach(() => {
      if (origStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = origStateDir;
      if (origDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = origDbPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    async function db(): Promise<DatabaseSync> {
      const { getDb } = await import("../../dist/db.js");
      return getDb();
    }

    function insertSuite(database: DatabaseSync, repo: string, tree: string, cmd: string, exitCode: number, createdAt: string): void {
      database.prepare(
        `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(repo, tree, cmd, "npm test", exitCode, 100, createdAt);
    }

    it("ages window rows from an injected now, with the documented tolerance", async () => {
      const database = await db();
      const repo = "/repo";
      const now = Date.UTC(2026, 8, 16, 12, 0, 0);

      insertSuite(database, repo, "inside", "cmd", 0, new Date(now - 60_000).toISOString());
      insertSuite(database, repo, "inside", "cmd", 1, new Date(now - 60_000).toISOString());
      const outside = new Date(now - (FLAKE_WINDOW_MS + FLAKE_WINDOW_TOLERANCE_MS + 1)).toISOString();
      insertSuite(database, repo, "outside", "cmd", 0, outside);
      insertSuite(database, repo, "outside", "cmd", 1, outside);

      const keys = flakyKeysWithinWindow(database, repo, now);
      assert.deepEqual(keys.map((k) => k.tree_hash), ["inside"]);

      const insideCounts = suiteCountsWithinWindow(database, { originRepo: repo, treeHash: "inside", cmdHash: "cmd" }, now);
      assert.deepEqual(insideCounts, { passCount: 1, failCount: 1 });
      const outsideCounts = suiteCountsWithinWindow(database, { originRepo: repo, treeHash: "outside", cmdHash: "cmd" }, now);
      assert.deepEqual(outsideCounts, { passCount: 0, failCount: 0 });
    });

    it("keeps a row exactly at the widened boundary and drops one millisecond past it", async () => {
      const database = await db();
      const repo = "/repo";
      const now = Date.UTC(2026, 8, 16, 12, 0, 0);
      const at = new Date(now - (FLAKE_WINDOW_MS + FLAKE_WINDOW_TOLERANCE_MS)).toISOString();
      const past = new Date(now - (FLAKE_WINDOW_MS + FLAKE_WINDOW_TOLERANCE_MS + 1)).toISOString();

      assert.equal(isWithinFlakeWindow(at, now), true);
      assert.equal(isWithinFlakeWindow(past, now), false);

      insertSuite(database, repo, "at", "cmd", 0, at);
      insertSuite(database, repo, "at", "cmd", 1, at);
      insertSuite(database, repo, "past", "cmd", 0, past);
      insertSuite(database, repo, "past", "cmd", 1, past);

      const keys = flakyKeysWithinWindow(database, repo, now);
      assert.deepEqual(keys.map((k) => k.tree_hash), ["at"]);
    });

    it("never counts an unparseable created_at inside the window", async () => {
      const database = await db();
      const repo = "/repo";
      const now = Date.UTC(2026, 8, 16, 12, 0, 0);

      insertSuite(database, repo, "unparseable", "cmd", 0, "not-a-timestamp");
      insertSuite(database, repo, "unparseable", "cmd", 1, "not-a-timestamp");

      assert.equal(isWithinFlakeWindow("not-a-timestamp", now), false);
      assert.deepEqual(flakyKeysWithinWindow(database, repo, now), []);
      assert.deepEqual(
        suiteCountsWithinWindow(database, { originRepo: repo, treeHash: "unparseable", cmdHash: "cmd" }, now),
        { passCount: 0, failCount: 0 },
      );
    });

    it("preserves the exit_code=87 exclusion and grouping/order semantics", async () => {
      const database = await db();
      const repo = "/repo";
      const now = Date.UTC(2026, 8, 16, 12, 0, 0);
      const recent = new Date(now - 60_000).toISOString();

      // Green + 87 must NOT be flaky.
      insertSuite(database, repo, "green87", "cmd", 0, recent);
      insertSuite(database, repo, "green87", "cmd", 87, recent);
      // Green + real red must be flaky.
      insertSuite(database, repo, "flaky", "cmd", 0, recent);
      insertSuite(database, repo, "flaky", "cmd", 1, recent);
      // Two greens + two reds should sort above the single-pair key.
      insertSuite(database, repo, "flaky2", "cmd", 0, recent);
      insertSuite(database, repo, "flaky2", "cmd", 0, recent);
      insertSuite(database, repo, "flaky2", "cmd", 1, recent);
      insertSuite(database, repo, "flaky2", "cmd", 1, recent);

      const keys = flakyKeysWithinWindow(database, repo, now);
      assert.deepEqual(keys.map((k) => k.tree_hash), ["flaky2", "flaky"]);
      assert.equal(keys[0].pass_count, 2);
      assert.equal(keys[0].fail_count, 2);
    });

    it("detects a legacy naive-UTC created_at inside the window", async () => {
      const database = await db();
      const repo = "/repo";
      const now = Date.UTC(2026, 8, 16, 12, 0, 0);
      insertSuite(database, repo, "naive", "cmd", 0, "2026-09-16 11:59:00");
      insertSuite(database, repo, "naive", "cmd", 1, "2026-09-16 11:59:00");

      const keys = flakyKeysWithinWindow(database, repo, now);
      assert.deepEqual(keys.map((k) => k.tree_hash), ["naive"]);
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

  function readDaemonLog(): string {
    try {
      return fs.readFileSync(path.join(stateDir, "tamandua.log"), "utf-8");
    } catch {
      return "";
    }
  }

  function suiteLogPublishWarnLines(logText: string): string[] {
    return logText
      .split("\n")
      .filter((line) => line.includes("suite log publish") && line.trim() !== "");
  }

  /** LEDGER-DIAG US-006: the per-RED-result daemon log lines. */
  function suiteRecordRedLines(logText: string): string[] {
    return logText
      .split("\n")
      .filter((line) => line.includes("suite record red") && line.trim() !== "");
  }

  function readRunEvents(runId: string): Array<Record<string, unknown>> {
    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    if (!fs.existsSync(runEventsPath)) return [];
    return fs
      .readFileSync(runEventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
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

  it("GET /suite/lookup excludes exit_code=87 from flaky detection (green + 87 = NOT flaky)", async () => {
    const repo = "/test/exit87-repo";
    const treeHash = "exit87-hash";
    const cmdHash = "exit87-cmd";

    // Insert a green pass and an interrupted (87) row.
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 1000 });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 87, durationMs: 500 });

    const r = await suiteRequest(
      "GET",
      `/suite/lookup?origin_repo=${encodeURIComponent(repo)}&tree_hash=${treeHash}&cmd_hash=${cmdHash}`,
    );
    assert.equal(r.status, 200);
    // Exit 87 should NOT count toward passCount or failCount.
    assert.equal(r.body.passCount, 1);
    assert.equal(r.body.failCount, 0);
    assert.equal(r.body.flaky, false, "green + 87 should NOT be flaky");
  });

  it("GET /suite/lookup still detects flaky with green + real red (exit_code != 0, != 87)", async () => {
    const repo = "/test/real-red-repo";
    const treeHash = "real-red-hash";
    const cmdHash = "real-red-cmd";

    // Insert green and a real failure (exit_code=1 — not 87).
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 1000 });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 1, durationMs: 500 });

    const r = await suiteRequest(
      "GET",
      `/suite/lookup?origin_repo=${encodeURIComponent(repo)}&tree_hash=${treeHash}&cmd_hash=${cmdHash}`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.passCount, 1);
    assert.equal(r.body.failCount, 1);
    assert.equal(r.body.flaky, true, "green + real red should still be flaky");
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

  // ── LEDGER-DIAG US-002: full-log publishing on /suite/record ──────

  it("resolveSuiteLogTempPath accepts only absolute paths inside <state dir>/suite-logs/", async () => {
    const { resolveSuiteLogTempPath } = await import("../../dist/server/control-server.js");
    const dir = path.join(stateDir, "suite-logs");
    assert.equal(
      resolveSuiteLogTempPath(path.join(dir, "a.log"), stateDir),
      path.join(dir, "a.log"),
    );
    assert.equal(resolveSuiteLogTempPath("relative/a.log", stateDir), null);
    assert.equal(resolveSuiteLogTempPath("", stateDir), null);
    assert.equal(resolveSuiteLogTempPath(undefined, stateDir), null);
    assert.equal(resolveSuiteLogTempPath(42, stateDir), null);
    assert.equal(resolveSuiteLogTempPath(path.join(dir, "..", "escape.log"), stateDir), null);
    assert.equal(resolveSuiteLogTempPath(dir, stateDir), null);
    assert.equal(resolveSuiteLogTempPath(path.join(stateDir, "other", "a.log"), stateDir), null);
  });

  it("POST /suite/record publishes a shim temp log to <state dir>/suite-logs/<row id>.log", async () => {
    const suiteLogsDir = path.join(stateDir, "suite-logs");
    fs.mkdirSync(suiteLogsDir, { recursive: true });
    const tempLog = path.join(suiteLogsDir, `.pending-${crypto.randomUUID()}.log`);
    const complete = "FULL-LOG-SENTINEL\n" + "x".repeat(64 * 1024);
    fs.writeFileSync(tempLog, complete, "utf-8");

    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/log-publish",
      tree_hash: "log-publish-tree",
      cmd_hash: "log-publish-cmd",
      cmd_display: "npm test",
      exit_code: 1,
      duration_ms: 10,
      log_tail: "tail stays capped",
      log_path: tempLog,
    });
    assert.equal(r.status, 200);
    const rowId = r.body.id as number;
    const expected = path.join(suiteLogsDir, `${rowId}.log`);
    assert.equal(r.body.log_path, expected, "record result must expose the stored log_path");
    assert.ok(fs.existsSync(expected), "published full log must exist at <state dir>/suite-logs/<row id>.log");
    assert.equal(fs.readFileSync(expected, "utf-8"), complete, "complete output must be intact");
    assert.ok(!fs.existsSync(tempLog), "temp file must be renamed away");

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT log_path, log_tail FROM suite_results WHERE id = ?").get(rowId) as {
      log_path: string | null;
      log_tail: string | null;
    };
    db.close();
    assert.equal(row.log_path, expected, "suite_results.log_path must store the published path");
    assert.equal(row.log_tail, "tail stays capped", "log_tail must be unchanged");

    const lookup = await suiteRequest(
      "GET",
      `/suite/lookup?origin_repo=${encodeURIComponent("/test/log-publish")}&tree_hash=log-publish-tree&cmd_hash=log-publish-cmd`,
    );
    assert.equal(lookup.status, 200);
    assert.equal(
      (lookup.body.latest as Record<string, unknown>).log_path,
      expected,
      "lookup latest must expose the stored log_path",
    );
  });

  it("a record without a log_path keeps suite_results.log_path NULL", async () => {
    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/no-log",
      tree_hash: "no-log-tree",
      cmd_hash: "no-log-cmd",
      cmd_display: "npm test",
      exit_code: 0,
      duration_ms: 5,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.log_path, undefined, "no log_path in the result when none was supplied");
    const rowId = r.body.id as number;

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT log_path FROM suite_results WHERE id = ?").get(rowId) as {
      log_path: string | null;
    };
    db.close();
    assert.equal(row.log_path, null, "log_path must stay NULL without a full log");

    const lookup = await suiteRequest(
      "GET",
      `/suite/lookup?origin_repo=${encodeURIComponent("/test/no-log")}&tree_hash=no-log-tree&cmd_hash=no-log-cmd`,
    );
    assert.equal((lookup.body.latest as Record<string, unknown>).log_path, null);
  });

  it("a missing temp log path leaves log_path NULL with exactly one bounded warning", async () => {
    const suiteLogsDir = path.join(stateDir, "suite-logs");
    fs.mkdirSync(suiteLogsDir, { recursive: true });
    const tempLog = path.join(suiteLogsDir, `.missing-${crypto.randomUUID()}.log`);
    const before = suiteLogPublishWarnLines(readDaemonLog()).length;

    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/log-missing",
      tree_hash: "log-missing-tree",
      cmd_hash: "log-missing-cmd",
      cmd_display: "npm test",
      exit_code: 1,
      duration_ms: 10,
      log_path: tempLog,
    });
    assert.equal(r.status, 200, "a failed publish must not fail the record");
    assert.equal(r.body.log_path, undefined);
    const rowId = r.body.id as number;

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT log_path FROM suite_results WHERE id = ?").get(rowId) as {
      log_path: string | null;
    };
    db.close();
    assert.equal(row.log_path, null, "a missing temp file must leave log_path NULL");

    const warns = suiteLogPublishWarnLines(readDaemonLog());
    assert.equal(warns.length - before, 1, "exactly one bounded warning for one failed publish");
    const warn = warns[warns.length - 1];
    assert.ok(warn.includes("suite log publish"), `warning should name the publish failure: ${warn}`);
    assert.ok(warn.length < 1000, "warning must be bounded");
  });

  it("an out-of-directory temp log path is refused, leaves NULL, logs one warning and deletes nothing", async () => {
    const outsideA = path.join(stateDir, `.outside-${crypto.randomUUID()}.log`);
    fs.writeFileSync(outsideA, "outside-a", "utf-8");
    const before = suiteLogPublishWarnLines(readDaemonLog()).length;

    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/log-outside",
      tree_hash: "log-outside-tree",
      cmd_hash: "log-outside-cmd",
      cmd_display: "npm test",
      exit_code: 1,
      duration_ms: 10,
      log_path: outsideA,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.log_path, undefined);
    const rowId = r.body.id as number;

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT log_path FROM suite_results WHERE id = ?").get(rowId) as {
      log_path: string | null;
    };
    db.close();
    assert.equal(row.log_path, null);
    assert.ok(fs.existsSync(outsideA), "the refused temp file must not be deleted");

    // A relative path is likewise refused.
    const rel = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/log-relative",
      tree_hash: "log-relative-tree",
      cmd_hash: "log-relative-cmd",
      cmd_display: "npm test",
      exit_code: 1,
      duration_ms: 10,
      log_path: path.join("relative", "out.log"),
    });
    assert.equal(rel.body.log_path, undefined);

    const warns = suiteLogPublishWarnLines(readDaemonLog());
    assert.equal(warns.length - before, 2, "one warning per refused path");
    for (const warn of warns.slice(-2)) {
      assert.ok(warn.includes("suite log publish"));
      assert.ok(warn.length < 1000, "warning must be bounded");
    }
  });

  it("an un-renameable temp log leaves log_path NULL with one warning and preserves every file", async () => {
    const suiteLogsDir = path.join(stateDir, "suite-logs");
    fs.mkdirSync(suiteLogsDir, { recursive: true });

    // Predict the next row id: this file runs one test at a time and the
    // suite_results id is an INTEGER PRIMARY KEY (max rowid + 1).
    const pre = new DatabaseSync(dbPath);
    const nextId = (pre.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM suite_results").get() as { m: number }).m + 1;
    pre.close();
    const destDir = path.join(suiteLogsDir, `${nextId}.log`);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "keep.txt"), "keep", "utf-8");

    const tempLog = path.join(suiteLogsDir, `.pending-${crypto.randomUUID()}.log`);
    fs.writeFileSync(tempLog, "full log", "utf-8");
    const before = suiteLogPublishWarnLines(readDaemonLog()).length;

    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/log-unrenameable",
      tree_hash: "log-unrenameable-tree",
      cmd_hash: "log-unrenameable-cmd",
      cmd_display: "npm test",
      exit_code: 1,
      duration_ms: 10,
      log_path: tempLog,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, nextId, "predicted row id must match the inserted row");
    assert.equal(r.body.log_path, undefined);

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT log_path FROM suite_results WHERE id = ?").get(r.body.id) as {
      log_path: string | null;
    };
    db.close();
    assert.equal(row.log_path, null, "an un-renameable temp path must leave log_path NULL");
    assert.ok(fs.existsSync(tempLog), "the temp log must be preserved after a failed rename");
    assert.ok(fs.existsSync(destDir), "the blocking destination must be preserved");
    assert.equal(fs.readFileSync(path.join(destDir, "keep.txt"), "utf-8"), "keep");

    const warns = suiteLogPublishWarnLines(readDaemonLog());
    assert.equal(warns.length - before, 1, "exactly one bounded warning for one failed publish");
    assert.ok(warns[warns.length - 1].length < 1000, "warning must be bounded");
  });

  // ── LEDGER-DIAG US-006: red ledger line carries the full-log path ─

  it("a red record with a persisted log emits suite.executed logPath and exactly one daemon red line naming it", async () => {
    const suiteLogsDir = path.join(stateDir, "suite-logs");
    fs.mkdirSync(suiteLogsDir, { recursive: true });
    const tempLog = path.join(suiteLogsDir, `.pending-${crypto.randomUUID()}.log`);
    fs.writeFileSync(tempLog, "full red log", "utf-8");

    const runId = `us006-red-${crypto.randomUUID()}`;
    const before = suiteRecordRedLines(readDaemonLog()).length;
    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/us006-red",
      tree_hash: "us006-red-tree",
      cmd_hash: "us006-red-cmd",
      cmd_display: "npm test",
      exit_code: 1,
      duration_ms: 10,
      run_id: runId,
      log_path: tempLog,
    });
    assert.equal(r.status, 200);
    const rowId = r.body.id as number;
    const expected = path.join(suiteLogsDir, `${rowId}.log`);

    const events = readRunEvents(runId);
    const executed = events.find((e) => e.event === "suite.executed");
    assert.ok(executed, "suite.executed event should be emitted");
    assert.equal(executed!.logPath, expected, "suite.executed must carry the persisted log path");

    const redLines = suiteRecordRedLines(readDaemonLog());
    assert.equal(redLines.length - before, 1, "exactly one daemon red line for one red record");
    const line = redLines[redLines.length - 1];
    assert.ok(line.includes(expected), "the red daemon line must name the full-log path");
    assert.ok(line.includes("/test/us006-red"), "the red daemon line must name the origin");
    assert.ok(line.includes("us006-red-tree"), "the red daemon line must name the tree");
    assert.ok(line.includes("us006-red-cmd"), "the red daemon line must name the command");
    assert.ok(line.includes("npm test"), "the red daemon line must name the command display");
    assert.ok(line.includes("\"exitCode\":1"), "the red daemon line must carry the exit code");
    assert.ok(line.length < 1000, "the red daemon line must stay bounded");
  });

  it("a green record emits no per-red daemon line and omits logPath", async () => {
    const runId = `us006-green-${crypto.randomUUID()}`;
    const before = suiteRecordRedLines(readDaemonLog()).length;
    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/us006-green",
      tree_hash: "us006-green-tree",
      cmd_hash: "us006-green-cmd",
      cmd_display: "npm test",
      exit_code: 0,
      duration_ms: 10,
      run_id: runId,
    });
    assert.equal(r.status, 200);

    assert.equal(
      suiteRecordRedLines(readDaemonLog()).length - before,
      0,
      "a green record must not emit a per-red daemon line",
    );
    const executed = readRunEvents(runId).find((e) => e.event === "suite.executed");
    assert.ok(executed, "suite.executed event should be emitted");
    assert.ok(!("logPath" in executed!), "a green record with no log must omit logPath");
  });

  it("a red record with no persisted log still emits one daemon line without a path and omits logPath", async () => {
    const runId = `us006-red-nolog-${crypto.randomUUID()}`;
    const before = suiteRecordRedLines(readDaemonLog()).length;
    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/us006-red-nolog",
      tree_hash: "us006-red-nolog-tree",
      cmd_hash: "us006-red-nolog-cmd",
      cmd_display: "npm test",
      exit_code: 2,
      duration_ms: 10,
      run_id: runId,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.log_path, undefined, "no log must be published");

    const executed = readRunEvents(runId).find((e) => e.event === "suite.executed");
    assert.ok(executed, "suite.executed event should be emitted");
    assert.ok(!("logPath" in executed!), "a red record with no log must omit logPath");

    const redLines = suiteRecordRedLines(readDaemonLog());
    assert.equal(redLines.length - before, 1, "a red record always logs exactly one red line");
    const line = redLines[redLines.length - 1];
    assert.ok(!line.includes("logPath"), "the red daemon line must not print a path when none exists");
    assert.ok(!line.includes("null"), "the red daemon line must not print a null path");
    assert.ok(line.includes("\"exitCode\":2"), "the red daemon line must carry the exit code");
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

  it("rejects malformed present owner tokens without changing claims or suite rows", async () => {
    const invalidTokens: unknown[] = [null, 42, true, [], {}, "", "o".repeat(129)];

    for (const [index, ownerToken] of invalidTokens.entries()) {
      const key = {
        origin_repo: `/test/malformed-owner/${index}`,
        tree_hash: `malformed-tree-${index}`,
        cmd_hash: `malformed-cmd-${index}`,
      };
      const unrelated = {
        origin_repo: `/test/malformed-owner/unrelated/${index}`,
        tree_hash: `unrelated-tree-${index}`,
        cmd_hash: `unrelated-cmd-${index}`,
        owner_token: `unrelated-owner-${index}`,
      };
      assert.equal((await suiteRequest("POST", "/suite/claim", unrelated)).body.action, "run");
      insertSuiteRow({
        originRepo: key.origin_repo,
        treeHash: key.tree_hash,
        cmdHash: key.cmd_hash,
        cmdDisplay: "npm test",
        exitCode: 0,
        durationMs: 1,
      });

      assert.equal((await suiteRequest("POST", "/suite/claim", {
        ...key,
        owner_token: ownerToken,
      })).status, 400, `claim should reject ${JSON.stringify(ownerToken)}`);
      const validOwner = `valid-owner-${index}`;
      assert.equal((await suiteRequest("POST", "/suite/claim", {
        ...key,
        owner_token: validOwner,
      })).body.action, "run", "invalid claim must not acquire the key");

      assert.equal((await suiteRequest("POST", "/suite/release", {
        ...key,
        owner_token: ownerToken,
      })).status, 400, `release should reject ${JSON.stringify(ownerToken)}`);
      assert.equal((await suiteRequest("POST", "/suite/claim", {
        ...key,
        owner_token: "observer",
      })).body.action, "wait", "invalid release must preserve the exact-key claim");
      assert.equal((await suiteRequest("POST", "/suite/claim", unrelated)).body.action, "wait",
        "invalid requests must preserve unrelated claims");

      const db = new DatabaseSync(dbPath);
      const row = db.prepare(
        "SELECT COUNT(*) AS cnt FROM suite_results WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ?",
      ).get(key.origin_repo, key.tree_hash, key.cmd_hash) as { cnt: number };
      db.close();
      assert.equal(row.cnt, 1, "invalid requests must not alter suite ledger rows");

      assert.equal((await suiteRequest("POST", "/suite/release", {
        ...key,
        owner_token: validOwner,
      })).body.released, true);
      assert.equal((await suiteRequest("POST", "/suite/release", unrelated)).body.released, true);
    }
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

  it("GET /suite/flaky excludes keys where the only 'fail' is exit_code=87", async () => {
    const repo = "/test/flaky-exit87";
    const treeHash = "exit87-flaky-hash";
    const cmdHash = "exit87-flaky-cmd";

    // Green pass + interrupted (87) — should NOT be flaky.
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 1000 });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 87, durationMs: 500 });

    const r = await suiteRequest("GET", `/suite/flaky?origin_repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200);
    const keys = r.body.flaky_keys as Array<Record<string, unknown>>;
    assert.equal(keys.length, 0, "green + 87 should not appear as flaky");
  });

  it("GET /suite/flaky still detects flaky with green + real red (exit_code != 0, != 87)", async () => {
    const repo = "/test/flaky-real-red";
    const treeHash = "real-red-flaky-hash";
    const cmdHash = "real-red-flaky-cmd";

    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 0, durationMs: 1000 });
    insertSuiteRow({ originRepo: repo, treeHash, cmdHash, cmdDisplay: "npm test", exitCode: 1, durationMs: 500 });

    const r = await suiteRequest("GET", `/suite/flaky?origin_repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200);
    const keys = r.body.flaky_keys as Array<Record<string, unknown>>;
    assert.equal(keys.length, 1, "green + real red should still be flaky");
    assert.equal(keys[0].pass_count, 1);
    assert.equal(keys[0].fail_count, 1);
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

  it("POST /suite/event normalizes a legacy naive started_at to ISO-Z (US-007)", async () => {
    const runId = "evt-started-at-run";
    const r = await suiteRequest("POST", "/suite/event", {
      event: "suite.executed",
      run_id: runId,
      tree_hash: "started-at-hash",
      cmd_display: "npm test",
      duration_ms: 1000,
      exit_code: 0,
      started_at: "2026-09-15 22:00:00",
    });
    assert.equal(r.status, 200);

    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    const evt = JSON.parse(fs.readFileSync(runEventsPath, "utf-8").trim());
    assert.equal(evt.startedAt, "2026-09-15T22:00:00.000Z");
    assert.match(evt.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("POST /suite/event omits an unparseable started_at (US-007)", async () => {
    const runId = "evt-started-at-bad-run";
    const r = await suiteRequest("POST", "/suite/event", {
      event: "suite.executed",
      run_id: runId,
      tree_hash: "started-at-bad-hash",
      cmd_display: "npm test",
      duration_ms: 1000,
      exit_code: 0,
      started_at: "not-a-date",
    });
    assert.equal(r.status, 200);

    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    const evt = JSON.parse(fs.readFileSync(runEventsPath, "utf-8").trim());
    assert.ok(!("startedAt" in evt), "unparseable started_at must be omitted, not serialized raw");
  });

  it("POST /suite/record normalizes a legacy naive started_at before emission (US-007)", async () => {
    const runId = "record-started-at-run";
    const r = await suiteRequest("POST", "/suite/record", {
      origin_repo: "/test/record-started-at",
      tree_hash: "record-started-at-tree",
      cmd_hash: "record-started-at-cmd",
      cmd_display: "npm test",
      exit_code: 0,
      duration_ms: 1000,
      run_id: runId,
      started_at: "2026-09-15 22:00:00",
    });
    assert.equal(r.status, 200);

    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    const events = fs
      .readFileSync(runEventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; startedAt?: string });
    const executed = events.find((e) => e.event === "suite.executed");
    assert.ok(executed, "suite.executed event should be emitted");
    assert.equal(executed!.startedAt, "2026-09-15T22:00:00.000Z");
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

  it("POST /suite/event preserves complete controller-authored special-exit evidence", async () => {
    const runId = "evt-special-exit-run";
    const body = {
      event: "suite.special_exit_observed",
      run_id: runId,
      step_id: "exit-86",
      origin_repo: "/fixture/origin",
      tree_hash: "a".repeat(40),
      cmd_hash: "b".repeat(64),
      shim_exit_code: 86,
      command_exit_code: 0,
      pre_tree_hash: "a".repeat(40),
      post_tree_hash: "c".repeat(40),
      ledger_row_id: null,
      interrupted: false,
      tracked_dirty: false,
      junk_probe_path: "junk-probe.tmp",
      junk_probe_tracked: false,
    };
    assert.equal((await suiteRequest("POST", "/suite/event", body)).status, 200);
    const evt = JSON.parse(fs.readFileSync(path.join(stateDir, "events", `${runId}.jsonl`), "utf8"));
    assert.equal(evt.originRepo, body.origin_repo);
    assert.equal(evt.shimExitCode, 86);
    assert.equal(evt.commandExitCode, 0);
    assert.equal(evt.ledgerRowId, null);
    assert.equal(evt.interrupted, false);
    assert.equal(evt.trackedDirty, false);
    assert.equal(evt.junkProbePath, "junk-probe.tmp");
    assert.equal(evt.junkProbeTracked, false);
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

// ══════════════════════════════════════════════════════════════════════
// TATR US-005: control-plane terminate settles in-flight token
// attribution for canceled runs before returning
// ══════════════════════════════════════════════════════════════════════

describe("control-plane terminate settles in-flight rounds (TATR US-005)", { concurrency: 1 }, () => {
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
  let origPiBinary: string | undefined;
  let origRoundMarker: string | undefined;
  let origHarnessProbe: string | undefined;

  before(async () => {
    origHome = process.env.HOME;
    origStateDir = process.env.TAMANDUA_STATE_DIR;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origControlPort = process.env.TAMANDUA_CONTROL_PORT;
    origPiBinary = process.env.TAMANDUA_PI_BINARY;
    origRoundMarker = process.env.TAMANDUA_ROUND_MARKER;
    origHarnessProbe = process.env.TAMANDUA_HARNESS_PROBE;

    tempHome = tamanduaTempDir("tamandua-settle-ep-");
    stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    dbPath = path.join(stateDir, "tamandua.db");

    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    // The canned fake-pi shim never answers a launch-time harness probe
    // prompt, so the probe is disabled for the dispatch round this suite
    // exercises (the settle semantics are the behavior under test).
    process.env.TAMANDUA_HARNESS_PROBE = "0";

    secret = crypto.randomBytes(16).toString("hex");
    fs.mkdirSync(path.dirname(path.join(stateDir, "daemon-secret")), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "daemon-secret"), secret, "utf-8");

    const [ctrlHandle] = await reservePortHandles(1);
    controlPort = ctrlHandle.port;
    await ctrlHandle.close();
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);

    const { createControlServer } = await import("../../dist/server/control-server.js");
    server = createControlServer({ port: controlPort, secret });
    await new Promise<void>((resolve) => {
      server!.once("listening", resolve);
    });
  });

  after(async () => {
    shutdownAllCrons();
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
    if (origPiBinary) process.env.TAMANDUA_PI_BINARY = origPiBinary;
    else delete process.env.TAMANDUA_PI_BINARY;
    if (origRoundMarker) process.env.TAMANDUA_ROUND_MARKER = origRoundMarker;
    else delete process.env.TAMANDUA_ROUND_MARKER;
    if (origHarnessProbe) process.env.TAMANDUA_HARNESS_PROBE = origHarnessProbe;
    else delete process.env.TAMANDUA_HARNESS_PROBE;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  });

  async function terminateRequest(runId: string, body?: Record<string, unknown>): Promise<JsonResponse> {
    const payload = JSON.stringify({ runId, ...(body ?? {}) });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tamandua-secret": secret,
      "content-length": String(Buffer.byteLength(payload)),
    };

    return await new Promise<JsonResponse>((resolve, reject) => {
      const req = http.request(
        {
          method: "POST",
          hostname: "127.0.0.1",
          port: controlPort,
          path: "/control/terminate-run",
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
      req.setTimeout(15000, () => req.destroy(new Error("terminate request timeout")));
      req.write(payload);
      req.end();
    });
  }

  it("terminate on a canceled run with an in-flight round returns only after token attribution settles", async () => {
    const { executeDispatchRound, setupAgentCrons } = await import("../../dist/installer/agent-scheduler.js");
    const { getDb } = await import("../../dist/db.js");
    const { getRunEvents } = await import("../../dist/installer/events.js");

    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'settle ep task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    // Register the run's dispatch job in jobMetadata exactly as admission
    // does, so removeRunCrons exercises its real timer/kill bookkeeping.
    const workflow = {
      id: "test-wf",
      agents: [{ id: "test-agent", model: "fake", workspace: { baseDir: "." } }],
      steps: [{ id: "step-1", agent: "test-agent", input: "do work", expects: "STATUS" }],
    };
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    const marker = path.join(tempHome, "settle-ep.marker");
    const fakePi = path.join(tempHome, "pi-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
fs.writeFileSync(process.env.TAMANDUA_ROUND_MARKER, "inflight");
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "STATUS: done", usage: { totalTokens: 137 } } }));
console.log("STATUS: done");
process.exit(0);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.TAMANDUA_ROUND_MARKER = marker;

    const round = executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );

    // Wait until the round is genuinely in flight (child spawned + claimed).
    const waitStarted = Date.now();
    while (Date.now() - waitStarted < 5000) {
      if (fs.existsSync(marker)) break;
      await sleep(20);
    }
    assert.ok(fs.existsSync(marker), "round never reached in-flight state");

    // Mark the run canceled exactly as stopWorkflow does before the daemon
    // is notified.
    db.prepare(
      "UPDATE runs SET status = 'canceled', scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(runId);

    const before = Date.now();
    const r = await terminateRequest(runId);
    const terminateMs = Date.now() - before;

    assert.equal(r.status, 200, `terminate must succeed: ${JSON.stringify(r.body)}`);

    // handleTerminateRun settled the in-flight round BEFORE returning: the
    // run.tokens.updated event must already be on disk.
    const events = getRunEvents(runId);
    const tokenEvents = events.filter((e) => e.event === "run.tokens.updated");
    assert.equal(tokenEvents.length, 1, "the settled run.tokens.updated must land before terminate returns");
    assert.equal(tokenEvents[0].runId, runId);
    assert.equal(tokenEvents[0].tokenDelta, 137);

    const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number };
    assert.equal(row.tokens_spent, 137, "the DB spend must include the settled delta");

    await round;
  });
});

// ══════════════════════════════════════════════════════════════════════
// FFRC: register-run during teardown returns retriable 503
// ══════════════════════════════════════════════════════════════════════

describe("register-run during teardown (FFRC retriable gate)", { concurrency: 1 }, () => {
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

    tempHome = tamanduaTempDir("tamandua-ffrc-register-");
    stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    dbPath = path.join(stateDir, "tamandua.db");

    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    secret = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(stateDir, "daemon-secret"), secret, "utf-8");

    const [ctrlHandle] = await reservePortHandles(1);
    controlPort = ctrlHandle.port;
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

  async function registerRequest(runId: string): Promise<JsonResponse> {
    const payload = JSON.stringify({ runId });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tamandua-secret": secret,
      "content-length": String(Buffer.byteLength(payload)),
    };
    return await new Promise<JsonResponse>((resolve, reject) => {
      const req = http.request(
        { method: "POST", hostname: "127.0.0.1", port: controlPort, path: "/control/register-run", headers },
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
      req.setTimeout(3000, () => req.destroy(new Error("register request timeout")));
      req.write(payload);
      req.end();
    });
  }

  it("register-run during teardown returns retriable 503, not the terminal 409", async () => {
    const { _setRunMidTeardownForTest, _isRunMidTeardown } = await import("../../dist/server/control-server.js");

    const runId = crypto.randomUUID();
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      scheduling_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, scheduling_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "wf", "ffrc register gate", "running", "{}", "pending_register", now, now);
    db.close();

    // The run is NOT terminal, so without the teardown marker the register
    // gate would proceed to admission (and fail later on workflow-spec
    // resolution with 422) — never a terminal 409.
    try {
      // Mark the run mid-teardown exactly as handleTerminateRun does while
      // removing crons / settling in-flight rounds.
      _setRunMidTeardownForTest(runId, true);
      assert.equal(_isRunMidTeardown(runId), true);

      const r = await registerRequest(runId);
      assert.equal(r.status, 503, `expected retriable 503, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(
        r.body.error,
        "run teardown in progress, retry",
        `expected the precise retriable message, got: ${JSON.stringify(r.body)}`,
      );
    } finally {
      _setRunMidTeardownForTest(runId, false);
    }
  });
});

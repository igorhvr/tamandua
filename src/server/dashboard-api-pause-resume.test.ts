import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createDashboardServer } from "../../dist/server/dashboard.js";

// ── Helpers ──────────────────────────────────────────────────────────

function initDb(dbPath: string, runs: Array<{ id: string; status: string; workflow_id: string; task: string }>): void {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      run_number INTEGER NOT NULL DEFAULT 0,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      scheduling_status TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY,
      worktree_origin_repository TEXT NOT NULL,
      worktree_origin_git_common_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_origin_ref TEXT,
      worktree_origin_sha TEXT,
      original_branch TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_success',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT,
      error TEXT
    )
  `);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)",
  );

  for (const r of runs) {
    insert.run(r.id, r.workflow_id, r.task, r.status);
  }

  db.close();
}

async function startDashboardOnPort(
  port: number,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = createDashboardServer(port);
  if (!server.listening) {
    await once(server, "listening");
  }

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopDashboard(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Start a minimal mock control-plane server that responds to
 * /control/pause-run and /control/resume-run.
 */
async function startMockControl(
  port: number,
): Promise<{ server: http.Server; pauseRequests: Array<{ body: unknown }>; resumeRequests: string[] }> {
  const pauseRequests: Array<{ body: unknown }> = [];
  const resumeRequests: string[] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      res.setHeader("Content-Type", "application/json");

      if (req.url === "/control/pause-run" && req.method === "POST") {
        pauseRequests.push({ body: parsed });
        res.writeHead(200);
        res.end(JSON.stringify({ status: "paused", runId: parsed.runId }));
      } else if (req.url === "/control/resume-run" && req.method === "POST") {
        resumeRequests.push(parsed.runId as string);
        res.writeHead(200);
        res.end(JSON.stringify({ status: "running", runId: parsed.runId }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return { server, pauseRequests, resumeRequests };
}

async function stopMockControl(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("dashboard pause/resume API", () => {
  let root: string;
  let dbPath: string;
  let controlMock: http.Server;
  let controlPort: number;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-pause-"));
    dbPath = path.join(root, "tamandua.db");

    // Start mock control plane on a random port
    controlMock = http.createServer((_req, res) => {
      // Default: error response (will be overridden per-test when control is needed)
      res.writeHead(500);
      res.end(JSON.stringify({ error: "mock not configured" }));
    });
    await new Promise<void>((resolve) => controlMock.listen(0, resolve));
    const addr = controlMock.address();
    assert.ok(addr && typeof addr !== "string");
    controlPort = addr.port;
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);
  });

  after(() => {
    delete process.env.TAMANDUA_CONTROL_PORT;
    controlMock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("POST /api/runs/:id/pause returns 200 for a running run", async () => {
    // Reconfigure mock control to accept pause
    await stopMockControl(controlMock);
    const mock = await startMockControl(controlPort);

    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-001", workflow_id: "wf-a", task: "test", status: "running" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-001/pause`, {
        method: "POST",
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { paused: boolean; runId: string };
      assert.equal(body.paused, true);
      assert.equal(body.runId, "run-001");
      assert.equal(mock.pauseRequests.length, 1);
      assert.deepEqual(mock.pauseRequests[0].body, { runId: "run-001" });
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      await stopMockControl(mock.server);
      // Re-bind default control mock for subsequent tests
      controlMock = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "mock not configured" }));
      });
      await new Promise<void>((resolve) => controlMock.listen(controlPort, resolve));
    }
  });

  it("POST /api/runs/:id/pause returns 409 for a terminal run", async () => {
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-002", workflow_id: "wf-a", task: "test", status: "completed" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-002/pause`, {
        method: "POST",
      });
      assert.equal(response.status, 409);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot pause run in completed state/);
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("POST /api/runs/:id/pause returns 404 for nonexistent run", async () => {
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, []);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/nonexistent/pause`, {
        method: "POST",
      });
      assert.equal(response.status, 404);
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("POST /api/runs/:id/pause with ?drain=true passes drain to control-plane", async () => {
    await stopMockControl(controlMock);
    const mock = await startMockControl(controlPort);

    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-003", workflow_id: "wf-a", task: "test", status: "running" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-003/pause?drain=true`, {
        method: "POST",
      });
      assert.equal(response.status, 200);
      assert.equal(mock.pauseRequests.length, 1);
      assert.deepEqual(mock.pauseRequests[0].body, { runId: "run-003", drain: true });
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      await stopMockControl(mock.server);
      controlMock = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "mock not configured" }));
      });
      await new Promise<void>((resolve) => controlMock.listen(controlPort, resolve));
    }
  });

  it("POST /api/runs/:id/resume returns 200 for a paused run", async () => {
    await stopMockControl(controlMock);
    const mock = await startMockControl(controlPort);

    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-004", workflow_id: "wf-a", task: "test", status: "paused" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-004/resume`, {
        method: "POST",
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { resumed: boolean; runId: string };
      assert.equal(body.resumed, true);
      assert.equal(body.runId, "run-004");
      assert.equal(mock.resumeRequests.length, 1);
      assert.equal(mock.resumeRequests[0], "run-004");
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      await stopMockControl(mock.server);
      controlMock = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "mock not configured" }));
      });
      await new Promise<void>((resolve) => controlMock.listen(controlPort, resolve));
    }
  });

  it("POST /api/runs/:id/resume returns 200 when daemon responds with 202 (queued)", async () => {
    await stopMockControl(controlMock);
    // Create a mock returning 202 for resume (simulating admitOrQueueRun queued response)
    const mock202 = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/control/resume-run" && req.method === "POST") {
          res.writeHead(202);
          res.end(JSON.stringify({ state: "queued", runId: parsed.runId }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
        }
      });
    });
    await new Promise<void>((resolve) => mock202.listen(controlPort, resolve));

    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-resume-202", workflow_id: "wf-a", task: "test", status: "paused" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-resume-202/resume`, {
        method: "POST",
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { resumed: boolean; runId: string };
      assert.equal(body.resumed, true);
      assert.equal(body.runId, "run-resume-202");
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      await stopMockControl(mock202);
      // Re-bind default control mock for subsequent tests
      controlMock = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "mock not configured" }));
      });
      await new Promise<void>((resolve) => controlMock.listen(controlPort, resolve));
    }
  });

  it("POST /api/runs/:id/resume returns 409 for a non-paused run", async () => {
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-005", workflow_id: "wf-a", task: "test", status: "running" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-005/resume`, {
        method: "POST",
      });
      assert.equal(response.status, 409);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot resume run in running state/);
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("POST /api/runs/:id/resume returns 409 for a completed run", async () => {
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-006", workflow_id: "wf-a", task: "test", status: "completed" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-006/resume`, {
        method: "POST",
      });
      assert.equal(response.status, 409);
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("POST /api/runs/:id/resume returns 404 for nonexistent run", async () => {
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, []);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/nonexistent/resume`, {
        method: "POST",
      });
      assert.equal(response.status, 404);
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("DELETE /api/runs/:id deletes a terminal run", async () => {
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-delete-done", workflow_id: "wf-a", task: "test", status: "completed" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-delete-done`, {
        method: "DELETE",
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { ok: boolean; runId: string; status: string };
      assert.deepEqual(body, { ok: true, runId: "run-delete-done", status: "deleted" });

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get("run-delete-done") as { count: number };
        assert.equal(row.count, 0);
      } finally {
        db.close();
      }
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("DELETE /api/runs/:id returns 409 for active runs without force", async () => {
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-delete-active", workflow_id: "wf-a", task: "test", status: "running" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-delete-active`, {
        method: "DELETE",
      });
      assert.equal(response.status, 409);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Use --force/);
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("POST /api/runs/:id/pause returns 502 when daemon is unreachable", async () => {
    // Use an unused port to simulate unreachable daemon
    process.env.TAMANDUA_CONTROL_PORT = "19999";
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-007", workflow_id: "wf-a", task: "test", status: "running" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-007/pause`, {
        method: "POST",
      });
      assert.equal(response.status, 502);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Daemon unreachable/);
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      process.env.TAMANDUA_CONTROL_PORT = String(controlPort);
    }
  });

  it("POST /api/runs/:id/resume returns 502 when daemon is unreachable", async () => {
    process.env.TAMANDUA_CONTROL_PORT = "19999";
    process.env.TAMANDUA_DB_PATH = dbPath;
    initDb(dbPath, [
      { id: "run-008", workflow_id: "wf-a", task: "test", status: "paused" },
    ]);

    const { server, baseUrl } = await startDashboardOnPort(0);

    try {
      const response = await fetch(`${baseUrl}/api/runs/run-008/resume`, {
        method: "POST",
      });
      assert.equal(response.status, 502);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Daemon unreachable/);
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      process.env.TAMANDUA_CONTROL_PORT = String(controlPort);
    }
  });
});

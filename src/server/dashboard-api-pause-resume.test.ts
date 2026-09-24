import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
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

// ── Control-plane mock (PORT-BIND-RACE / bead tamandua-6sy.84) ───────
//
// This file must NEVER pass a remembered port number to a second bind. The
// old shape closed the mock and re-listened on the number it had captured
// earlier, which is racy under the parallel lane: another test file can take
// that number in the window between close and re-listen and the re-listen
// then dies with EADDRINUSE (observed: 4 failures on a Mac fresh clone).
//
// Chosen fix: ONE mock instance stays bound for the whole file lifetime
// (started with listen(0) in before(), closed in after()) and tests swap its
// request handler instead of restarting the listener. Every bind this file
// performs goes through a fresh `listen(0)`; no port number is ever reused.
// `start()`/`stop()` cycles remain available (and are covered by the
// port-lifecycle test below), and each `start()` likewise asks the OS for a
// brand new port.

type ControlMockHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** Bind a server to an OS-assigned port — the only bind shape this file uses. */
function listenFresh(server: http.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected an AddressInfo from listen(0)"));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Bind a server to a specific number — the racy shape the mock never uses. */
function listenSpecific(server: http.Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected an AddressInfo from listen(port)"));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Captured request bodies for the pause/resume mock. */
interface ControlRecorder {
  pauseRequests: Array<{ body: unknown }>;
  resumeRequests: string[];
}

/** Default handler: every request is answered with a 500 "mock not configured". */
const defaultControlHandler: ControlMockHandler = (_req, res) => {
  res.writeHead(500);
  res.end(JSON.stringify({ error: "mock not configured" }));
};

/**
 * Mock control plane that accepts /control/pause-run and /control/resume-run
 * and records the request bodies.
 */
function pauseResumeHandler(recorder: ControlRecorder): ControlMockHandler {
  return (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      res.setHeader("Content-Type", "application/json");

      if (req.url === "/control/pause-run" && req.method === "POST") {
        recorder.pauseRequests.push({ body: parsed });
        res.writeHead(200);
        res.end(JSON.stringify({ status: "paused", runId: parsed.runId }));
      } else if (req.url === "/control/resume-run" && req.method === "POST") {
        recorder.resumeRequests.push(parsed.runId as string);
        res.writeHead(200);
        res.end(JSON.stringify({ status: "running", runId: parsed.runId }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  };
}

/** Mock control plane that answers /control/resume-run with 202 (queued). */
function queuedResumeHandler(): ControlMockHandler {
  return (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
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
  };
}

/**
 * A control-plane mock whose listener never moves.
 *
 * Contract (PORT-BIND-RACE): `start()` always binds a fresh `listen(0)` port
 * and publishes it as TAMANDUA_CONTROL_PORT; `stop()` releases it and leaves
 * the env value alone so the caller decides what to publish next. The history
 * of every port ever bound by the instance is kept in `portHistory`.
 */
class ControlPlaneMock {
  private server: http.Server | null = null;
  private livePort: number | null = null;
  private handler: ControlMockHandler = defaultControlHandler;

  /** Every port this instance has bound, in start order. */
  readonly portHistory: number[] = [];

  /** The port currently bound, or null when the mock is not listening. */
  get port(): number | null {
    return this.livePort;
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Swap the per-test request handler; the listener itself never moves. */
  setHandler(handler: ControlMockHandler): void {
    this.handler = handler;
  }

  /** Restore the default 500 "mock not configured" handler. */
  resetHandler(): void {
    this.handler = defaultControlHandler;
  }

  /** Bind a fresh OS-assigned port and publish it as TAMANDUA_CONTROL_PORT. */
  async start(): Promise<number> {
    if (this.server) throw new Error("ControlPlaneMock is already listening");
    const server = http.createServer((req, res) => this.handler(req, res));
    const port = await listenFresh(server);
    this.server = server;
    this.livePort = port;
    this.portHistory.push(port);
    process.env.TAMANDUA_CONTROL_PORT = String(port);
    return port;
  }

  /** Close the listener. Idempotent; never re-points TAMANDUA_CONTROL_PORT. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.livePort = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Publish the mock's live port. Never a stale number (tamandua-6sy.84). */
function publishLiveControlPort(mock: ControlPlaneMock): void {
  const port = mock.port;
  assert.ok(port !== null, "control mock must be listening");
  process.env.TAMANDUA_CONTROL_PORT = String(port);
}

/** A port nothing binds, used by the "daemon unreachable" cases. */
const UNREACHABLE_CONTROL_PORT = "19999";

// ── Tests ────────────────────────────────────────────────────────────

describe("dashboard pause/resume API", () => {
  let root: string;
  let dbPath: string;
  let controlMock: ControlPlaneMock;

  before(async () => {
    root = tamanduaTempDir("tamandua-dashboard-pause-");
    dbPath = path.join(root, "tamandua.db");

    // ONE mock for the whole file: a fresh listen(0) here, and per-test
    // handler swaps afterwards — never a close/re-listen cycle.
    controlMock = new ControlPlaneMock();
    await controlMock.start();
    process.env.HOME = root;
  });

  after(async () => {
    delete process.env.TAMANDUA_CONTROL_PORT;
    delete process.env.HOME;
    await controlMock.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("POST /api/runs/:id/pause returns 200 for a running run", async () => {
    // Swap in a pause/resume handler; the listener keeps its live port.
    const recorder: ControlRecorder = { pauseRequests: [], resumeRequests: [] };
    controlMock.setHandler(pauseResumeHandler(recorder));

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
      assert.equal(recorder.pauseRequests.length, 1);
      assert.deepEqual(recorder.pauseRequests[0].body, { runId: "run-001" });
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      controlMock.resetHandler();
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
    const recorder: ControlRecorder = { pauseRequests: [], resumeRequests: [] };
    controlMock.setHandler(pauseResumeHandler(recorder));

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
      assert.equal(recorder.pauseRequests.length, 1);
      assert.deepEqual(recorder.pauseRequests[0].body, { runId: "run-003", drain: true });
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      controlMock.resetHandler();
    }
  });

  it("POST /api/runs/:id/resume returns 200 for a paused run", async () => {
    const recorder: ControlRecorder = { pauseRequests: [], resumeRequests: [] };
    controlMock.setHandler(pauseResumeHandler(recorder));

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
      assert.equal(recorder.resumeRequests.length, 1);
      assert.equal(recorder.resumeRequests[0], "run-004");
    } finally {
      await stopDashboard(server);
      delete process.env.TAMANDUA_DB_PATH;
      controlMock.resetHandler();
    }
  });

  it("POST /api/runs/:id/resume returns 200 when daemon responds with 202 (queued)", async () => {
    // Swap in a 202 handler (simulating admitOrQueueRun queued response).
    controlMock.setHandler(queuedResumeHandler());

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
      controlMock.resetHandler();
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
    process.env.TAMANDUA_CONTROL_PORT = UNREACHABLE_CONTROL_PORT;
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
      // Restore the mock's CURRENT live port, never a captured stale number.
      publishLiveControlPort(controlMock);
    }
  });

  it("POST /api/runs/:id/resume returns 502 when daemon is unreachable", async () => {
    process.env.TAMANDUA_CONTROL_PORT = UNREACHABLE_CONTROL_PORT;
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
      publishLiveControlPort(controlMock);
    }
  });
});

describe("control-plane mock port lifecycle", () => {
  it("never reuses a port number across 5 start/stop cycles", async () => {
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    const mock = new ControlPlaneMock();

    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        const port = await mock.start();

        assert.ok(
          Number.isInteger(port) && port > 0,
          `start() must return an OS-assigned port, got ${String(port)}`,
        );
        assert.equal(mock.port, port);
        assert.equal(mock.listening, true);
        assert.equal(
          process.env.TAMANDUA_CONTROL_PORT,
          String(port),
          "the published env value must name the live mock port while it is up",
        );
        assert.equal(mock.portHistory.length, cycle + 1);
        assert.equal(
          new Set(mock.portHistory).size,
          mock.portHistory.length,
          `each start must use a fresh port; history: ${mock.portHistory.join(", ")}`,
        );

        await mock.stop();
        assert.equal(mock.port, null);
        assert.equal(mock.listening, false);
      }

      assert.equal(mock.portHistory.length, 5);
    } finally {
      await mock.stop();
      if (savedPort === undefined) {
        delete process.env.TAMANDUA_CONTROL_PORT;
      } else {
        process.env.TAMANDUA_CONTROL_PORT = savedPort;
      }
    }
  });

  it("red-arming: re-binding a previously used number fails with EADDRINUSE while the mock always asks for a fresh port", async () => {
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    // Stands in for "the parallel lane took the number": a squatter holds it.
    const squatter = http.createServer((_req, res) => res.end());
    const squatterPort = await listenFresh(squatter);
    assert.ok(squatterPort > 0);
    const rerunMock = new ControlPlaneMock();

    try {
      // Pre-fix shape: listen(<remembered number>) — dies with EADDRINUSE as
      // soon as anything else holds the number (the observed Mac failures).
      const stale = http.createServer((_req, res) => res.end());
      await assert.rejects(
        () => listenSpecific(stale, squatterPort),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "EADDRINUSE",
        "re-binding a number that is already bound must fail with EADDRINUSE",
      );

      // Fixed shape: a fresh listen(0) succeeds even while the old number is
      // held, and the OS never hands back the squatted number.
      const freshPort = await rerunMock.start();
      assert.notEqual(freshPort, squatterPort);
      assert.equal(process.env.TAMANDUA_CONTROL_PORT, String(freshPort));
    } finally {
      await rerunMock.stop();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
      if (savedPort === undefined) {
        delete process.env.TAMANDUA_CONTROL_PORT;
      } else {
        process.env.TAMANDUA_CONTROL_PORT = savedPort;
      }
    }
  });

  it("keeps one listener for the whole file and swaps handlers instead of re-binding", async () => {
    const mock = new ControlPlaneMock();
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;

    try {
      const port = await mock.start();
      assert.equal(mock.portHistory.length, 1);

      // Handler swaps must never move the listener or the published port.
      mock.setHandler((_req, res) => {
        res.writeHead(204);
        res.end();
      });
      assert.equal(mock.listening, true);
      assert.equal(mock.port, port);
      assert.equal(process.env.TAMANDUA_CONTROL_PORT, String(port));
      assert.deepEqual(mock.portHistory, [port]);

      mock.resetHandler();
      assert.equal(mock.port, port);
      assert.deepEqual(mock.portHistory, [port]);
    } finally {
      await mock.stop();
      if (savedPort === undefined) {
        delete process.env.TAMANDUA_CONTROL_PORT;
      } else {
        process.env.TAMANDUA_CONTROL_PORT = savedPort;
      }
    }
  });
});
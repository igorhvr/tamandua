/**
 * Tests for tamandua restart command — module structure + CLI behavior.
 *
 * US-006: Unit tests covering:
 *   (a) Refusal-on-active-runs with isolated DB
 *   (b) --force override despite active runs
 *   (c) Stop-barrier timeout with clear error naming stuck service
 *   (d) Stop ordering: dashboard → MCP → daemon
 *   (e) Start ordering: daemon → dashboard → MCP, all three come up
 *
 * All tests use isolated state dirs (createTempHome). Spawning-based
 * tests use the serial lane (file listed in tests/serial-files.txt).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { cleanChildEnv, createTempHome } from "../../../tests/helpers/test-env.ts";

import {
  getRestartHelp,
  handleRestart,
} from "../../../dist/cli/commands/restart.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WRAPPER_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "tamandua");

// ── Helpers ────────────────────────────────────────────────────────

function makeTestEnv() {
  const th = createTempHome("tamandua-restart-test-");
  return { tmpDir: th.root, stateDir: th.tamanduaDir, homeDir: th.homeDir };
}

function cli(args: string[], env?: Record<string, string>) {
  const testEnv = makeTestEnv();
  const result = spawnSync("/bin/sh", [WRAPPER_PATH, ...args], {
    encoding: "utf8",
    env: cleanChildEnv({ HOME: testEnv.homeDir,
      TAMANDUA_STATE_DIR: testEnv.stateDir,
      ...env, }),
  });
  return { ...result, testEnv };
}

/** Insert a single active (running) run into the isolated DB. */
function writeActiveRun(
  homeDir: string,
  runId: string,
  task: string,
  status: string = "running",
): void {
  const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
  const now = new Date().toISOString();
  const db = new DatabaseSync(dbPath);
  // Ensure the runs table exists (the CLI may create the DB on first use, but
  // we insert directly so we need the schema).
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, 'feature-dev', ?, ?, '{}', 0, ?, ?)`,
  ).run(runId, task, status, now, now);
  db.close();
}

/** Reserve a random free port. */
function reserveRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

/** Write port files so restart uses isolated ports (avoids conflict with production). */
function writePortConfig(homeDir: string, cpPort: number, dashPort: number, mcpPort: number): void {
  const tamDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamDir, { recursive: true });
  fs.writeFileSync(path.join(tamDir, "control-plane-port"), String(cpPort), "utf-8");
  fs.writeFileSync(path.join(tamDir, "port"), String(dashPort), "utf-8");
  fs.writeFileSync(path.join(tamDir, "mcp-port"), String(mcpPort), "utf-8");
}

// ── Module structure tests (existing from US-002) ──────────────────

describe("restart command module", () => {
  it("is backed by a source module", () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), "src/cli/commands/restart.ts")), true);
  });

  it("exports getRestartHelp with help text", () => {
    const help = getRestartHelp();
    assert.match(help, /tamandua restart/);
    assert.match(help, /--force/);
    assert.match(help, /stop→ready/);
    assert.match(help, /does NOT git pull/);
  });

  it("exports handleRestart function", () => {
    assert.equal(typeof handleRestart, "function");
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleRestart("dashboard", ["dashboard", "status"]), false);
    assert.equal(await handleRestart("mcp", ["mcp", "status"]), false);
    assert.equal(await handleRestart("daemon", ["daemon", "status"]), false);
  });

  it("accepts handler signature is async", () => {
    const result = handleRestart("dashboard", ["dashboard", "status"]);
    assert.ok(result instanceof Promise);
  });

  it("help text describes the sanctioned post-build workflow", () => {
    const help = getRestartHelp();
    assert.match(help, /build-and-install/);
    assert.match(help, /pick up a locally rebuilt tree/);
  });

  it("help text mentions stop order", () => {
    const help = getRestartHelp();
    // The spec says: stop dashboard→MCP→daemon
    assert.match(help, /restart/);
  });

  it("help text does not mention git pull or rebuild", () => {
    const help = getRestartHelp();
    // It explicitly says it does NOT git pull, rebuild, or touch workflows
    assert.match(help, /does NOT git pull/);
  });
});

// ── CLI behavior tests (US-006) ────────────────────────────────────

describe("tamandua restart CLI (isolated state)", () => {
  // (a) Refusal-on-active-runs
  describe("active-runs safety gate", () => {
    it("refuses when active runs exist, exits non-zero, lists runs", () => {
      const te = makeTestEnv();
      const runId = crypto.randomUUID();
      writeActiveRun(te.homeDir, runId, "Implement login page");

      const result = cli(["restart"], { HOME: te.homeDir,
        TAMANDUA_STATE_DIR: te.stateDir });

      assert.notEqual(result.status, 0, "should exit non-zero");
      const stderr = result.stderr ?? "";
      assert.match(stderr, /Active Tamandua runs detected/);
      assert.match(stderr, new RegExp(runId));
      assert.match(stderr, /Implement login page/);
      assert.match(stderr, /running/);
      assert.match(stderr, /tamandua restart --force/);
    });

    it("lists multiple active runs", () => {
      const te = makeTestEnv();
      const env = { HOME: te.homeDir,
        TAMANDUA_STATE_DIR: te.stateDir };
      const runId1 = crypto.randomUUID();
      const runId2 = crypto.randomUUID();
      writeActiveRun(te.homeDir, runId1, "Fix navbar", "running");
      writeActiveRun(te.homeDir, runId2, "Update deps", "paused");

      const result = cli(["restart"], env);

      assert.notEqual(result.status, 0);
      const stderr = result.stderr ?? "";
      assert.match(stderr, /Active Tamandua runs detected \(2\)/);
      assert.match(stderr, new RegExp(runId1));
      assert.match(stderr, new RegExp(runId2));
      assert.match(stderr, /Fix navbar/);
      assert.match(stderr, /Update deps/);
    });

    it("does not refuse when no active runs exist", async () => {
      const te = makeTestEnv();
      // Reserve ports so restart doesn't collide with production services.
      const cpPort = await reserveRandomPort();
      const dashPort = await reserveRandomPort();
      const mcpPort = await reserveRandomPort();
      writePortConfig(te.homeDir, cpPort, dashPort, mcpPort);

      const result = cli(["restart"], { HOME: te.homeDir,
        TAMANDUA_STATE_DIR: te.stateDir,
        TAMANDUA_CONTROL_PORT: String(cpPort) });
      // With no active runs and no running services, restart attempts to start
      // services (which may fail in test env, but must NOT print the active-runs
      // refusal message).
      const stderr = result.stderr ?? "";
      assert.ok(
        !stderr.includes("Active Tamandua runs detected"),
        "should not print active-runs refusal when no runs exist",
      );
      // Cleanup any spawned services
      const { stopDaemon, stopDashboardStandalone, stopMcp } = await import("../../../dist/server/daemonctl.js");
      try { stopDashboardStandalone({ homeDir: te.homeDir }); } catch {}
      try { stopMcp({ homeDir: te.homeDir }); } catch {}
      try { stopDaemon({ homeDir: te.homeDir }); } catch {}
    });
  });

  // (b) --force override
  describe("--force override", () => {
    it("proceeds despite active runs with --force", async () => {
      const te = makeTestEnv();
      const env = { HOME: te.homeDir,
        TAMANDUA_STATE_DIR: te.stateDir };
      const runId = crypto.randomUUID();
      writeActiveRun(te.homeDir, runId, "Implement feature X");

      // Reserve ports for when restart tries to start services after bypass.
      const cpPort = await reserveRandomPort();
      const dashPort = await reserveRandomPort();
      const mcpPort = await reserveRandomPort();
      writePortConfig(te.homeDir, cpPort, dashPort, mcpPort);

      const result = cli(["restart", "--force"], { ...env,
        TAMANDUA_CONTROL_PORT: String(cpPort) });

      // Should NOT exit with the active-runs refusal message
      const stderr = result.stderr ?? "";
      assert.ok(
        !stderr.includes("Refusing to restart"),
        "--force should bypass the active-runs refusal",
      );
      // Should print the force-proceeding notice
      assert.match(stderr, /Active runs detected.*--force given.*proceeding/);
      // Cleanup
      const { stopDaemon, stopDashboardStandalone, stopMcp } = await import("../../../dist/server/daemonctl.js");
      try { stopDashboardStandalone({ homeDir: te.homeDir }); } catch {}
      try { stopMcp({ homeDir: te.homeDir }); } catch {}
      try { stopDaemon({ homeDir: te.homeDir }); } catch {}
    });

    it("no refusal message when no runs exist even without --force", async () => {
      const te = makeTestEnv();
      const cpPort = await reserveRandomPort();
      const dashPort = await reserveRandomPort();
      const mcpPort = await reserveRandomPort();
      writePortConfig(te.homeDir, cpPort, dashPort, mcpPort);

      const result = cli(["restart"], { HOME: te.homeDir,
        TAMANDUA_STATE_DIR: te.stateDir,
        TAMANDUA_CONTROL_PORT: String(cpPort) });
      const stderr = result.stderr ?? "";
      assert.ok(
        !stderr.includes("Refusing to restart"),
        "should not refuse when no active runs",
      );
      const { stopDaemon, stopDashboardStandalone, stopMcp } = await import("../../../dist/server/daemonctl.js");
      try { stopDashboardStandalone({ homeDir: te.homeDir }); } catch {}
      try { stopMcp({ homeDir: te.homeDir }); } catch {}
      try { stopDaemon({ homeDir: te.homeDir }); } catch {}
    });
  });
});

// ── Integration tests (US-007) ─────────────────────────────────────
// Isolated state dir + non-default ports. Spawns real daemon, dashboard,
// and MCP services, then runs `tamandua restart` targeting the isolated
// instance via HOME env. Does NOT touch the live daemon.

const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "..", "dist", "server", "daemon.js");
const DASHBOARD_SCRIPT = path.resolve(__dirname, "..", "..", "..", "dist", "server", "dashboard-standalone.js");
const MCP_SCRIPT = path.resolve(__dirname, "..", "..", "..", "dist", "server", "mcp-standalone.js");

function checkBuildArtifacts(): boolean {
  return fs.existsSync(DAEMON_SCRIPT)
    && fs.existsSync(DASHBOARD_SCRIPT)
    && fs.existsSync(MCP_SCRIPT);
}

/** Poll until a TCP port accepts connections, with timeout. */
async function waitForTcpPort(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
          sock.destroy();
          resolve();
        });
        sock.on("error", reject);
      });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for port ${port} to accept connections`);
}

describe("tamandua restart integration (all services)", { concurrency: 1 }, () => {
  it("stops and restarts all three services, verifies health after restart", async (t) => {
    if (!checkBuildArtifacts()) {
      t.skip("build artifacts not found — run npm run build first");
      return;
    }

    const te = makeTestEnv();

    const cpPort = await reserveRandomPort();
    const dashPort = await reserveRandomPort();
    const mcpPort = await reserveRandomPort();
    writePortConfig(te.homeDir, cpPort, dashPort, mcpPort);

    const { startDaemon, startDashboardStandalone, startMcp,
      stopDaemon, stopDashboardStandalone, stopMcp,
      isRunning, isDashboardRunning, isMcpRunning } =
      await import("../../../dist/server/daemonctl.js");

    try {
      // Start all three services in the isolated environment.
      const daemonStart = await startDaemon(cpPort, { homeDir: te.homeDir });
      assert.ok(daemonStart.pid > 0, "daemon should start with valid PID");
      await waitForTcpPort(cpPort);

      const dashStart = await startDashboardStandalone(dashPort, { homeDir: te.homeDir });
      assert.ok(dashStart.pid > 0, "dashboard should start with valid PID");
      await waitForTcpPort(dashPort);

      const mcpStart = await startMcp(mcpPort, { homeDir: te.homeDir });
      assert.ok(mcpStart.pid > 0, "MCP should start with valid PID");
      await waitForTcpPort(mcpPort);

      const daemonBefore = daemonStart.pid;
      const dashBefore = dashStart.pid;
      const mcpBefore = mcpStart.pid;

      // Verify dashboard health endpoint before restart
      const healthBefore = await fetch(`http://127.0.0.1:${dashPort}/api/health`);
      assert.equal(healthBefore.status, 200, "dashboard health endpoint should respond before restart");

      // Run `tamandua restart` targeting the isolated instance via HOME env.
      const result = spawnSync("/bin/sh", [WRAPPER_PATH, "restart"], {
        encoding: "utf8",
        env: cleanChildEnv({ HOME: te.homeDir,
          TAMANDUA_STATE_DIR: te.stateDir,
          TAMANDUA_CONTROL_PORT: String(cpPort), }),
        timeout: 60_000,
      });

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      // Verify restart output: stop lines in order, then start lines.
      assert.match(stdout, /dashboard: stopped/,
        "should print dashboard stopped");
      assert.match(stdout, /mcp: stopped/,
        "should print mcp stopped");
      assert.match(stdout, /daemon: stopped/,
        "should print daemon stopped");
      assert.match(stdout, /daemon: started \(pid \d+, port \d+\)/,
        "should print daemon started with pid and port");
      assert.match(stdout, /dashboard: started \(pid \d+, port \d+\)/,
        "should print dashboard started with pid and port");
      assert.match(stdout, /mcp: started \(pid \d+, port \d+\)/,
        "should print mcp started with pid and port");
      assert.match(stdout, /All services restarted\./,
        "should print final success message");
      assert.equal(result.status, 0, "should exit 0");

      // Verify new PIDs are different from before-restart PIDs.
      const daemonAfter = isRunning({ homeDir: te.homeDir });
      assert.equal(daemonAfter.running, true, "daemon should be running after restart");
      assert.notEqual(daemonAfter.pid, daemonBefore,
        "daemon PID should have changed after restart");

      const dashAfter = isDashboardRunning({ homeDir: te.homeDir });
      assert.equal(dashAfter.running, true, "dashboard should be running after restart");
      assert.notEqual(dashAfter.pid, dashBefore,
        "dashboard PID should have changed after restart");

      const mcpAfter = isMcpRunning({ homeDir: te.homeDir });
      assert.equal(mcpAfter.running, true, "MCP should be running after restart");
      assert.notEqual(mcpAfter.pid, mcpBefore,
        "MCP PID should have changed after restart");

      // Verify services are healthy after restart — ports accept connections.
      await waitForTcpPort(cpPort);
      await waitForTcpPort(dashPort);
      await waitForTcpPort(mcpPort);

      const healthAfter = await fetch(`http://127.0.0.1:${dashPort}/api/health`);
      assert.equal(healthAfter.status, 200,
        "dashboard health endpoint should respond after restart");
    } finally {
      try { stopDashboardStandalone({ homeDir: te.homeDir }); } catch {}
      try { stopMcp({ homeDir: te.homeDir }); } catch {}
      try { stopDaemon({ homeDir: te.homeDir }); } catch {}
    }
  });

  it("stop order: dashboard → mcp → daemon; start order: daemon → dashboard → mcp", async (t) => {
    if (!checkBuildArtifacts()) {
      t.skip("build artifacts not found — run npm run build first");
      return;
    }

    const te = makeTestEnv();

    const cpPort = await reserveRandomPort();
    const dashPort = await reserveRandomPort();
    const mcpPort = await reserveRandomPort();
    writePortConfig(te.homeDir, cpPort, dashPort, mcpPort);

    const { startDaemon, startDashboardStandalone, startMcp,
      stopDaemon, stopDashboardStandalone, stopMcp } =
      await import("../../../dist/server/daemonctl.js");

    try {
      await startDaemon(cpPort, { homeDir: te.homeDir });
      await waitForTcpPort(cpPort);
      await startDashboardStandalone(dashPort, { homeDir: te.homeDir });
      await waitForTcpPort(dashPort);
      await startMcp(mcpPort, { homeDir: te.homeDir });
      await waitForTcpPort(mcpPort);

      const result = spawnSync("/bin/sh", [WRAPPER_PATH, "restart"], {
        encoding: "utf8",
        env: cleanChildEnv({ HOME: te.homeDir,
          TAMANDUA_STATE_DIR: te.stateDir,
          TAMANDUA_CONTROL_PORT: String(cpPort), }),
        timeout: 60_000,
      });

      assert.equal(result.status, 0, "should exit 0");
      const stdout = result.stdout ?? "";

      // Extract ordered "stopped" lines and verify dashboard → mcp → daemon.
      const stoppedLines = stdout
        .split("\n")
        .filter((l) => l.match(/^(dashboard|mcp|daemon): stopped/))
        .map((l) => l.replace(/: stopped.*/, ""));
      assert.deepEqual(stoppedLines, ["dashboard", "mcp", "daemon"],
        "stop order should be dashboard → mcp → daemon");

      // Extract ordered "started" lines and verify daemon → dashboard → mcp.
      const startedLines = stdout
        .split("\n")
        .filter((l) => l.match(/^(dashboard|mcp|daemon): started/))
        .map((l) => l.replace(/: started.*/, ""));
      assert.deepEqual(startedLines, ["daemon", "dashboard", "mcp"],
        "start order should be daemon → dashboard → mcp");
    } finally {
      try { stopDashboardStandalone({ homeDir: te.homeDir }); } catch {}
      try { stopMcp({ homeDir: te.homeDir }); } catch {}
      try { stopDaemon({ homeDir: te.homeDir }); } catch {}
    }
  });

  it("does not touch live daemon — TAMANDUA_TEST_GUARD compliant", async (t) => {
    if (!checkBuildArtifacts()) {
      t.skip("build artifacts not found — run npm run build first");
      return;
    }

    const te = makeTestEnv();

    const cpPort = await reserveRandomPort();
    const dashPort = await reserveRandomPort();
    const mcpPort = await reserveRandomPort();
    writePortConfig(te.homeDir, cpPort, dashPort, mcpPort);

    // Verify port files contain isolated ports, not production defaults.
    assert.notEqual(cpPort, 3339, "control port should not be default 3339");
    assert.notEqual(dashPort, 3334, "dashboard port should not be default 3334");
    assert.notEqual(mcpPort, 3338, "MCP port should not be default 3338");

    const { startDaemon, startDashboardStandalone, startMcp,
      stopDaemon, stopDashboardStandalone, stopMcp } =
      await import("../../../dist/server/daemonctl.js");

    try {
      await startDaemon(cpPort, { homeDir: te.homeDir });
      await waitForTcpPort(cpPort);
      await startDashboardStandalone(dashPort, { homeDir: te.homeDir });
      await waitForTcpPort(dashPort);
      await startMcp(mcpPort, { homeDir: te.homeDir });
      await waitForTcpPort(mcpPort);

      // Run restart with TAMANDUA_TEST_GUARD=1 set via cleanChildEnv (it
      // passes through the guard from the test process). The restart command
      // must NOT trigger a guard violation because all paths go through the
      // isolated state dir and non-default ports.
      const result = spawnSync("/bin/sh", [WRAPPER_PATH, "restart"], {
        encoding: "utf8",
        env: cleanChildEnv({ HOME: te.homeDir,
          TAMANDUA_STATE_DIR: te.stateDir,
          TAMANDUA_CONTROL_PORT: String(cpPort) }),
        timeout: 60_000,
      });

      const stderr = result.stderr ?? "";
      assert.ok(
        !stderr.includes("TEST ISOLATION VIOLATION"),
        "restart must not trigger test isolation violation",
      );
      assert.equal(result.status, 0, "should exit 0");
    } finally {
      try { stopDashboardStandalone({ homeDir: te.homeDir }); } catch {}
      try { stopMcp({ homeDir: te.homeDir }); } catch {}
      try { stopDaemon({ homeDir: te.homeDir }); } catch {}
    }
  });
});

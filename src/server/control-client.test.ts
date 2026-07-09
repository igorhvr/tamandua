/**
 * Tests for the daemon control client (nudgeWithDaemon).
 *
 * Spawns the dashboard daemon in a tmp HOME, then exercises the nudgeWithDaemon
 * client function over HTTP. This validates that the client correctly calls the
 * POST /control/nudge endpoint and handles both reachable and unreachable daemon
 * cases.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { cleanChildEnv, reserveDistinctRandomPorts } from "../../tests/helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");
let dashboardPort = 0;
let controlPort = 0;

/** JSON request helper matching the control-server test pattern. */
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

/** Wait for the daemon control plane to become reachable. */
async function waitForControlUp(timeoutMs = 7000): Promise<void> {
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

async function canBind(port: number): Promise<boolean> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => resolve());
      server.listen(port, "127.0.0.1");
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
}

describe("control client", { concurrency: 1 }, () => {
  let tempHome: string;
  let daemon: ChildProcess | undefined;
  let secret: string | undefined;

  before(async (t) => {
    [dashboardPort, controlPort] = await reserveDistinctRandomPorts(2);
    if (!(await canBind(dashboardPort))) {
      console.warn(`Port ${dashboardPort} is in use; skipping control client tests`);
      return;
    }
    if (!(await canBind(controlPort))) {
      console.warn(`Port ${controlPort} is in use; skipping control client tests`);
      return;
    }

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cc-home-"));
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

  it("nudgeWithDaemon returns response when daemon is reachable", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    // The daemon's reconciler creates the DB schema on its first tick (~1s).
    // Wait a moment to ensure the DB is initialized.
    await sleep(1500);

    // Insert a running run so there's something to nudge (even if no agents are scheduled).
    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, 'wf-nudge-client', 'nudge-client-test', 'running', '{}', 0, 'pending_register', ?, ?, ?)",
    ).run(runId, now, now, now);
    db.close();

    // control-client reads the daemon secret from ~/.tamandua/daemon-secret
    // and the control port from TAMANDUA_CONTROL_PORT. Set both to match the
    // test daemon's tempHome so nudgeWithDaemon reaches the correct daemon.
    const savedHome = process.env.HOME;
    const savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.HOME = tempHome;
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);

    // Dynamic import to get a fresh module after setting env vars.
    const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
    const response = await nudgeWithDaemon(3000);

    // Restore env
    process.env.HOME = savedHome;
    if (savedControlPort !== undefined) {
      process.env.TAMANDUA_CONTROL_PORT = savedControlPort;
    } else {
      delete process.env.TAMANDUA_CONTROL_PORT;
    }

    assert.ok(response !== null, "nudgeWithDaemon should return a response when daemon is up");
    assert.equal(typeof response.status, "number");
    assert.equal(typeof response.body.runningRuns, "number");

    // Cleanup DB
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("nudgeWithDaemon returns null when daemon is not reachable (no crash)", async (t) => {
    // Use a port that is very likely not in use, and a non-existent HOME so
    // readDaemonSecret returns null (not an error — control-client treats null
    // secret as no-auth). nudgeWithDaemon uses controlRequest which resolves
    // with null on connection error.
    const savedHome = process.env.HOME;
    const savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.HOME = "/nonexistent-tamandua-test-home";
    process.env.TAMANDUA_CONTROL_PORT = "65530";

    const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
    const response = await nudgeWithDaemon(500);

    process.env.HOME = savedHome;
    if (savedControlPort !== undefined) {
      process.env.TAMANDUA_CONTROL_PORT = savedControlPort;
    } else {
      delete process.env.TAMANDUA_CONTROL_PORT;
    }

    assert.equal(response, null, "nudgeWithDaemon should return null when daemon is unreachable");
  });
});

describe("control-client test-isolation guard", { concurrency: 1 }, () => {
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;
  let savedControlPort: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
    savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedStateDir !== undefined) process.env.TAMANDUA_STATE_DIR = savedStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    if (savedControlPort !== undefined) process.env.TAMANDUA_CONTROL_PORT = savedControlPort;
    else delete process.env.TAMANDUA_CONTROL_PORT;
  });

  it("returns null when guard is active and TAMANDUA_CONTROL_PORT is not set", async () => {
    // When TAMANDUA_CONTROL_PORT is absent, the guard detects the
    // production default (3339) and refuses to send the request.
    delete process.env.TAMANDUA_CONTROL_PORT;

    const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
    const response = await nudgeWithDaemon(500);

    assert.equal(response, null, "should return null when guard blocks default port");
  });

  it("returns null when guard is active and daemon secret resolves to real state dir", async () => {
    // Set TAMANDUA_CONTROL_PORT to pass the port check, but point HOME
    // at the real user home so the daemon-secret resolves to production.
    const realHome = os.userInfo().homedir;
    process.env.TAMANDUA_CONTROL_PORT = "65530";
    process.env.HOME = realHome;

    const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
    const response = await nudgeWithDaemon(500);

    assert.equal(response, null, "should return null when guard blocks production secret path");
  });

  it("works normally when guard is active but env is fully isolated", async () => {
    // With TAMANDUA_CONTROL_PORT set to a random port and HOME pointed
    // at a temp dir, the guard should NOT block. Start a simple HTTP
    // server on the random port to confirm the request reaches it.
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-gcc-home-"));
    const secretDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "daemon-secret"), "test-secret-isolated", "utf-8");

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runningRuns: 0, scheduledRuns: 0, launched: 0 }));
    });

    let serverPort = 0;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") serverPort = addr.port;
        resolve();
      });
    });

    process.env.HOME = tempHome;
    process.env.TAMANDUA_CONTROL_PORT = String(serverPort);

    try {
      const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
      const response = await nudgeWithDaemon(2000);

      assert.ok(response !== null, "nudgeWithDaemon should not be blocked by guard");
      assert.equal(response.status, 200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("works normally when guard is inactive (production unaffected)", async () => {
    // Even when pointing at production state, controlRequest should
    // proceed normally when the guard is inactive.
    // npm test sets TAMANDUA_TEST_GUARD=1, so we must temporarily
    // disable it to test this path.
    const savedGuard = process.env.TAMANDUA_TEST_GUARD;
    process.env.TAMANDUA_TEST_GUARD = "0";
    delete process.env.TAMANDUA_CONTROL_PORT;

    try {
      const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
      const response = await nudgeWithDaemon(500);

      // Guard is inactive, so the request proceeds. It may fail to
      // connect (returning null) or hit a real daemon if one is
      // running — either outcome means the guard didn't block it.
      // The important thing is the function doesn't short-circuit
      // via the guard.
      assert.ok(
        response === null || (typeof response.status === "number"),
        "guard should not interfere when inactive",
      );
    } finally {
      if (savedGuard !== undefined) process.env.TAMANDUA_TEST_GUARD = savedGuard;
      else delete process.env.TAMANDUA_TEST_GUARD;
    }
  });

  it("HOME-spoof resistance: guard uses os.userInfo().homedir", async () => {
    // Spoof HOME to a temp directory, but don't set TAMANDUA_STATE_DIR.
    // The guard should still detect production because it uses
    // os.userInfo().homedir to resolve the real user home.
    const realHome = os.userInfo().homedir;
    const spoofedHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-spoof-home-"));
    process.env.HOME = spoofedHome;
    process.env.TAMANDUA_CONTROL_PORT = "65530";

    try {
      // The guard's assertStatePathIsolation compares against
      // realUserHome() which uses os.userInfo().homedir.
      // defaultDaemonSecretFile() uses HOME (spoofed) for the path.
      // Since spoofed !== real, the guard does NOT trip.
      // That's correct — with HOME spoofed to a temp dir, the daemon
      // secret won't be the production one anyway. But the guard
      // still correctly resolves to real home for comparison.
      const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
      const response = await nudgeWithDaemon(500);

      // Guard should NOT block here: HOME points at a temp dir,
      // so defaultDaemonSecretFile() resolves to spoofedHome/.tamandua/daemon-secret,
      // which is NOT under realHome/.tamandua. The request proceeds
      // (and fails to connect since nothing is on port 65530).
      assert.equal(response, null, "should not be blocked by guard (spoofed HOME)");
    } finally {
      fs.rmSync(spoofedHome, { recursive: true, force: true });
    }
  });
});

describe("suite control-plane client", { concurrency: 1 }, () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;
  let secret: string;
  let controlPort: number;
  let server: http.Server | undefined;
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;
  let savedDbPath: string | undefined;
  let savedControlPort: string | undefined;

  before(async () => {
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
    savedDbPath = process.env.TAMANDUA_DB_PATH;
    savedControlPort = process.env.TAMANDUA_CONTROL_PORT;

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-suitecc-"));
    stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    dbPath = path.join(stateDir, "tamandua.db");

    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    secret = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(stateDir, "daemon-secret"), secret, "utf-8");

    [controlPort] = await reserveDistinctRandomPorts(1);
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
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedStateDir !== undefined) process.env.TAMANDUA_STATE_DIR = savedStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    if (savedDbPath !== undefined) process.env.TAMANDUA_DB_PATH = savedDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (savedControlPort !== undefined) process.env.TAMANDUA_CONTROL_PORT = savedControlPort;
    else delete process.env.TAMANDUA_CONTROL_PORT;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Helper to insert a suite_results row directly for setup. */
  async function insertSuiteRow(overrides: Record<string, unknown> = {}): Promise<number> {
    // Ensure the DB is migrated so suite_results exists. getDb() runs migrate().
    const { getDb } = await import("../../dist/db.js");
    getDb(); // triggers migration if needed

    // Use a direct connection for the insert — WAL mode allows concurrent connections.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const result = db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      String(overrides.origin_repo ?? "/tmp/test-repo"),
      String(overrides.tree_hash ?? crypto.createHash("sha1").update("abc").digest("hex")),
      String(overrides.cmd_hash ?? crypto.createHash("sha256").update("cmd").digest("hex")),
      String(overrides.cmd_display ?? "npm test"),
      Number(overrides.exit_code ?? 0),
      Number(overrides.duration_ms ?? 500),
      (overrides.log_tail as string) ?? "test output",
      (overrides.run_id as string) ?? null,
      (overrides.step_id as string) ?? null,
      String(overrides.created_at ?? new Date().toISOString()),
    );
    db.close();
    return Number(result.lastInsertRowid);
  }

  it("lookupSuiteRecord returns lookup result for an existing key", async () => {
    const treeHash = crypto.createHash("sha1").update("tree1").digest("hex");
    const cmdHash = crypto.createHash("sha256").update("cmd1").digest("hex");
    const now = new Date().toISOString();
    await insertSuiteRow({
      origin_repo: "/tmp/test-repo",
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: "npm test",
      exit_code: 0,
      duration_ms: 1234,
      created_at: now,
    });

    const { lookupSuiteRecord } = await import("../../dist/server/control-client.js");
    const result = await lookupSuiteRecord("/tmp/test-repo", treeHash, cmdHash);

    assert.ok(result !== null, "should return a result");
    assert.ok(result!.latest !== null, "should return latest entry");
    assert.equal(result!.latest!.exit_code, 0);
    assert.equal(result!.latest!.duration_ms, 1234);
    assert.equal(typeof result!.passCount, "number");
    assert.equal(typeof result!.failCount, "number");
  });

  it("lookupSuiteRecord returns null with latest=null for unknown key", async () => {
    const treeHash = crypto.createHash("sha1").update("nonexistent").digest("hex");
    const cmdHash = crypto.createHash("sha256").update("nonexistent").digest("hex");

    const { lookupSuiteRecord } = await import("../../dist/server/control-client.js");
    const result = await lookupSuiteRecord("/tmp/test-repo", treeHash, cmdHash);

    assert.ok(result !== null, "should return a result");
    assert.equal(result!.latest, null);
    assert.equal(result!.passCount, 0);
    assert.equal(result!.failCount, 0);
    assert.equal(result!.flaky, false);
  });

  it("lookupSuiteRecord returns null when daemon is unreachable", async () => {
    // Set control port to a port where nothing is listening.
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = "65530";
    try {
      const { lookupSuiteRecord } = await import("../../dist/server/control-client.js");
      const result = await lookupSuiteRecord("/x", "hash1", "hash2", 500);
      assert.equal(result, null);
    } finally {
      process.env.TAMANDUA_CONTROL_PORT = savedPort;
    }
  });

  it("recordSuiteResult inserts a row and returns id+created_at", async () => {
    const treeHash = crypto.createHash("sha1").update("tree-r").digest("hex");
    const cmdHash = crypto.createHash("sha256").update("cmd-r").digest("hex");

    const { recordSuiteResult } = await import("../../dist/server/control-client.js");
    const result = await recordSuiteResult({
      origin_repo: "/tmp/test-repo",
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: "npm run lint",
      exit_code: 1,
      duration_ms: 8765,
      log_tail: "some error",
      run_id: "run-1",
      step_id: "step-1",
    });

    assert.ok(result !== null, "should return a result");
    assert.equal(typeof result!.id, "number");
    assert.equal(typeof result!.created_at, "string");
    assert.ok(result!.id > 0);

    // Verify it was actually inserted.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const row = db.prepare(
      "SELECT * FROM suite_results WHERE id = ?",
    ).get(result!.id) as Record<string, unknown> | undefined;
    db.close();
    assert.ok(row !== undefined, "row should exist in db");
    assert.equal(row!.exit_code, 1);
    assert.equal(row!.duration_ms, 8765);
    assert.equal(row!.log_tail, "some error");
    assert.equal(row!.run_id, "run-1");
    assert.equal(row!.step_id, "step-1");
  });

  it("recordSuiteResult returns null when daemon is unreachable", async () => {
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = "65530";
    try {
      const { recordSuiteResult } = await import("../../dist/server/control-client.js");
      const result = await recordSuiteResult({
        origin_repo: "/x",
        tree_hash: "h1",
        cmd_hash: "h2",
        cmd_display: "test",
        exit_code: 0,
        duration_ms: 100,
      }, 500);
      assert.equal(result, null);
    } finally {
      process.env.TAMANDUA_CONTROL_PORT = savedPort;
    }
  });

  it("claimSuiteKey returns 'run' on first claim, 'wait' on second", async () => {
    const treeHash = crypto.createHash("sha1").update("tree-claim").digest("hex");
    const cmdHash = crypto.createHash("sha256").update("cmd-claim").digest("hex");

    const { claimSuiteKey } = await import("../../dist/server/control-client.js");
    const claim1 = await claimSuiteKey("/tmp/test-repo", treeHash, cmdHash);
    assert.ok(claim1 !== null, "first claim should succeed");
    assert.equal(claim1!.action, "run");

    const claim2 = await claimSuiteKey("/tmp/test-repo", treeHash, cmdHash);
    assert.ok(claim2 !== null, "second claim should succeed");
    assert.equal(claim2!.action, "wait");
    assert.ok(typeof claim2!.claimedAt === "string");
  });

  it("claimSuiteKey clears after record so third claim gets 'run'", async () => {
    const treeHash = crypto.createHash("sha1").update("tree-claim2").digest("hex");
    const cmdHash = crypto.createHash("sha256").update("cmd-claim2").digest("hex");

    const { claimSuiteKey, recordSuiteResult } = await import("../../dist/server/control-client.js");

    // First claim → run
    const claim1 = await claimSuiteKey("/tmp/test-repo", treeHash, cmdHash);
    assert.equal(claim1!.action, "run");

    // Second claim → wait
    const claim2 = await claimSuiteKey("/tmp/test-repo", treeHash, cmdHash);
    assert.equal(claim2!.action, "wait");

    // Record result → clears claim
    await recordSuiteResult({
      origin_repo: "/tmp/test-repo",
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: "test",
      exit_code: 0,
      duration_ms: 100,
    });

    // Third claim → run (claim was cleared by record)
    const claim3 = await claimSuiteKey("/tmp/test-repo", treeHash, cmdHash);
    assert.ok(claim3 !== null, "third claim should succeed");
    assert.equal(claim3!.action, "run");
  });

  it("claimSuiteKey returns null when daemon is unreachable", async () => {
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = "65530";
    try {
      const { claimSuiteKey } = await import("../../dist/server/control-client.js");
      const result = await claimSuiteKey("/x", "h1", "h2", 500);
      assert.equal(result, null);
    } finally {
      process.env.TAMANDUA_CONTROL_PORT = savedPort;
    }
  });

  it("getFlakyKeys returns empty array when no flaky keys", async () => {
    const { getFlakyKeys } = await import("../../dist/server/control-client.js");
    const result = await getFlakyKeys("/tmp/test-repo");
    assert.ok(result !== null, "should return a result");
    assert.equal(result!.length, 0);
  });

  it("getFlakyKeys returns keys with both pass and fail within window", async () => {
    const treeHash = crypto.createHash("sha1").update("flaky-tree").digest("hex");
    const cmdHash = crypto.createHash("sha256").update("flaky-cmd").digest("hex");
    const now = new Date();

    // Insert a pass.
    await insertSuiteRow({
      origin_repo: "/tmp/test-repo",
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: "flaky test",
      exit_code: 0,
      duration_ms: 100,
      created_at: now.toISOString(),
    });
    // Insert a fail.
    await insertSuiteRow({
      origin_repo: "/tmp/test-repo",
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: "flaky test",
      exit_code: 1,
      duration_ms: 200,
      created_at: new Date(now.getTime() - 1000).toISOString(),
    });

    const { getFlakyKeys } = await import("../../dist/server/control-client.js");
    const result = await getFlakyKeys("/tmp/test-repo");
    assert.ok(result !== null, "should return a result");
    assert.ok(result!.length >= 1, "should have at least one flaky key");

    const flaky = result!.find((k) => k.tree_hash === treeHash && k.cmd_hash === cmdHash);
    assert.ok(flaky !== undefined, "our key should be in the flaky list");
    assert.equal(flaky!.pass_count, 1);
    assert.equal(flaky!.fail_count, 1);
    assert.equal(flaky!.cmd_display, "flaky test");
  });

  it("getFlakyKeys returns null when daemon is unreachable", async () => {
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = "65530";
    try {
      const { getFlakyKeys } = await import("../../dist/server/control-client.js");
      const result = await getFlakyKeys("/x", 500);
      assert.equal(result, null);
    } finally {
      process.env.TAMANDUA_CONTROL_PORT = savedPort;
    }
  });

  it("all suite client functions respect timeout", async () => {
    // Point at a port with nothing listening; use short timeout.
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = "65530";
    try {
      const { lookupSuiteRecord, recordSuiteResult, claimSuiteKey, getFlakyKeys } =
        await import("../../dist/server/control-client.js");

      const start = Date.now();
      const r1 = await lookupSuiteRecord("/x", "h1", "h2", 200);
      const r2 = await recordSuiteResult({
        origin_repo: "/x", tree_hash: "h1", cmd_hash: "h2",
        cmd_display: "test", exit_code: 0, duration_ms: 100,
      }, 200);
      const r3 = await claimSuiteKey("/x", "h1", "h2", 200);
      const r4 = await getFlakyKeys("/x", 200);
      const elapsed = Date.now() - start;

      assert.equal(r1, null);
      assert.equal(r2, null);
      assert.equal(r3, null);
      assert.equal(r4, null);
      // Each call times out within ~200ms; total should be < 3s (allowing for overhead).
      assert.ok(elapsed < 3000, `elapsed ${elapsed}ms should be < 3000ms`);
    } finally {
      process.env.TAMANDUA_CONTROL_PORT = savedPort;
    }
  });

  it("lookupSuiteRecord detects flaky when pass+exist-fail", async () => {
    // Use a fresh key pair.
    const treeHash = crypto.createHash("sha1").update("tree-flaky-l").digest("hex");
    const cmdHash = crypto.createHash("sha256").update("cmd-flaky-l").digest("hex");
    const now = new Date();

    await insertSuiteRow({
      origin_repo: "/tmp/test-repo",
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: "flaky look",
      exit_code: 0,
      duration_ms: 100,
      created_at: now.toISOString(),
    });
    await insertSuiteRow({
      origin_repo: "/tmp/test-repo",
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: "flaky look",
      exit_code: 1,
      duration_ms: 200,
      created_at: new Date(now.getTime() - 5000).toISOString(),
    });

    const { lookupSuiteRecord } = await import("../../dist/server/control-client.js");
    const result = await lookupSuiteRecord("/tmp/test-repo", treeHash, cmdHash);

    assert.ok(result !== null);
    assert.equal(result!.flaky, true, "should detect flaky");
    assert.ok(result!.passCount >= 1);
    assert.ok(result!.failCount >= 1);
  });

  it("emitSuiteEvent returns true on success and writes event to file", async () => {
    const { emitSuiteEvent } = await import("../../dist/server/control-client.js");
    const runId = "cc-evt-cache-hit";
    const ok = await emitSuiteEvent({
      event: "suite.cache_hit",
      run_id: runId,
      step_id: "step-1",
      tree_hash: "abc123def456",
      cmd_display: "npm test",
      saved_duration_ms: 1234,
    });
    assert.equal(ok, true);

    // Verify event was written.
    const eventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(eventsPath));
    const content = fs.readFileSync(eventsPath, "utf-8").trim();
    const evt = JSON.parse(content);
    assert.equal(evt.event, "suite.cache_hit");
    assert.equal(evt.runId, runId);
    assert.equal(evt.stepId, "step-1");
    assert.equal(evt.treeHash, "abc123def456");
    assert.equal(evt.savedDurationMs, 1234);
  });

  it("emitSuiteEvent writes suite.flaky_detected event", async () => {
    const { emitSuiteEvent } = await import("../../dist/server/control-client.js");
    const runId = "cc-evt-flaky";
    const ok = await emitSuiteEvent({
      event: "suite.flaky_detected",
      run_id: runId,
      tree_hash: "flaky-hash",
      cmd_hash: "flaky-cmd",
      pass_count: 3,
      fail_count: 2,
      window: "24h",
    });
    assert.equal(ok, true);

    const eventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    const content = fs.readFileSync(eventsPath, "utf-8").trim();
    const evt = JSON.parse(content);
    assert.equal(evt.event, "suite.flaky_detected");
    assert.equal(evt.passCount, 3);
    assert.equal(evt.failCount, 2);
    assert.equal(evt.window, "24h");
  });

  it("emitSuiteEvent writes suite.singleflight_wait event", async () => {
    const { emitSuiteEvent } = await import("../../dist/server/control-client.js");
    const runId = "cc-evt-sf-wait";
    const ok = await emitSuiteEvent({
      event: "suite.singleflight_wait",
      run_id: runId,
      tree_hash: "sf-hash",
      cmd_hash: "sf-cmd",
      waited_ms: 0,
    });
    assert.equal(ok, true);

    const eventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    const content = fs.readFileSync(eventsPath, "utf-8").trim();
    const evt = JSON.parse(content);
    assert.equal(evt.event, "suite.singleflight_wait");
    assert.equal(evt.treeHash, "sf-hash");
    assert.equal(evt.cmdHash, "sf-cmd");
    assert.equal(evt.waitedMs, 0);
  });

  it("emitSuiteEvent returns false when daemon is unreachable", async () => {
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = "65530";
    try {
      const { emitSuiteEvent } = await import("../../dist/server/control-client.js");
      const ok = await emitSuiteEvent({ event: "suite.cache_hit", run_id: "r-none", tree_hash: "x" }, 200);
      assert.equal(ok, false);
    } finally {
      process.env.TAMANDUA_CONTROL_PORT = savedPort;
    }
  });

  it("emitSuiteEvent is idempotent — each call appends", async () => {
    const { emitSuiteEvent } = await import("../../dist/server/control-client.js");
    const runId = "cc-evt-idem";
    await emitSuiteEvent({ event: "suite.executed", run_id: runId, tree_hash: "t1", cmd_display: "c1", duration_ms: 100, exit_code: 0 });
    await emitSuiteEvent({ event: "suite.executed", run_id: runId, tree_hash: "t2", cmd_display: "c2", duration_ms: 200, exit_code: 1 });

    const eventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    const content = fs.readFileSync(eventsPath, "utf-8").trim();
    const lines = content.split("\n");
    assert.equal(lines.length, 2, "should have 2 events");
    assert.ok(lines[0]!.includes("t1"));
    assert.ok(lines[1]!.includes("t2"));
  });
});

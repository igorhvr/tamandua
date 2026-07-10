/**
 * Test-isolation guard tests for daemonctl path resolution and port
 * read/write functions.
 *
 * Guards added per US-003: getPidFile/getPortFile/getMcpPidFile/
 * getMcpPortFile/getControlPlanePidFile/getControlPlanePortFile assert
 * isolation when no opts.homeDir is provided. readPort/readMcpPort/
 * readControlPlanePort assert before reading port files. writePort/
 * writeMcpPort/writeControlPlanePort assert before writing port files.
 *
 * When guard is active and TAMANDUA_STATE_DIR is not isolating (i.e. HOME
 * resolves to the real user home), these functions must throw
 * "TEST ISOLATION VIOLATION" to prevent touching production state.
 *
 * When opts.homeDir is provided or the guard is inactive, behavior is
 * completely unchanged from before the guard was added.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTempHome } from "../../tests/helpers/test-env.ts";

// Save/restore env vars that affect path resolution and the guard itself.
let savedHome: string | undefined;
let savedStateDir: string | undefined;
let savedGuard: string | undefined;
let savedNodeTestContext: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedGuard = process.env.TAMANDUA_TEST_GUARD;
  savedNodeTestContext = process.env.NODE_TEST_CONTEXT;

  // Activate the guard for all tests in this file. The default npm test env
  // already sets TAMANDUA_TEST_GUARD=1, but be explicit about it.
  process.env.TAMANDUA_TEST_GUARD = "1";
});

afterEach(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  if (savedStateDir !== undefined) process.env.TAMANDUA_STATE_DIR = savedStateDir;
  else delete process.env.TAMANDUA_STATE_DIR;
  if (savedGuard !== undefined) process.env.TAMANDUA_TEST_GUARD = savedGuard;
  else delete process.env.TAMANDUA_TEST_GUARD;
  if (savedNodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
  else delete process.env.NODE_TEST_CONTEXT;
});

// ── Helper ──────────────────────────────────────────────────────────

function importDaemonctl() {
  // Dynamic import so module-level path constants are re-evaluated with
  // the current env, matching the pattern in events.test.ts and
  // control-client.test.ts.
  return import("../../dist/server/daemonctl.js");
}

// ── readPort ────────────────────────────────────────────────────────

describe("daemonctl readPort guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readPort } = await importDaemonctl();

    assert.throws(
      () => readPort(),
      /TEST ISOLATION VIOLATION/,
      "should throw when resolving port file under real ~/.tamandua",
    );
  });

  it("works normally when opts.homeDir is provided (explicit isolation)", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir; // guard would fire without opts

    const { readPort, writePort } = await importDaemonctl();
    const opts = { homeDir: tempHome };

    writePort(4567, opts);
    assert.equal(readPort(opts), 4567, "should read port from isolated dir");
  });

  it("returns default port when guard is inactive (production unaffected)", async () => {
    // Temporarily disable the guard. Even pointing HOME at real user
    // home must not block reads.
    process.env.TAMANDUA_TEST_GUARD = "0";
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readPort } = await importDaemonctl();

    const port = readPort(); // no opts — may or may not find a file
    assert.ok(typeof port === "number" && port > 0 && port < 65536,
      "should return a valid port (default or from file)");
  });
});

// ── readMcpPort ─────────────────────────────────────────────────────

describe("daemonctl readMcpPort guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readMcpPort } = await importDaemonctl();

    assert.throws(
      () => readMcpPort(),
      /TEST ISOLATION VIOLATION/,
      "should throw when resolving MCP port file under real ~/.tamandua",
    );
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;

    const { readMcpPort, writeMcpPort } = await importDaemonctl();
    const opts = { homeDir: tempHome };

    writeMcpPort(5678, opts);
    assert.equal(readMcpPort(opts), 5678, "should read MCP port from isolated dir");
  });
});

// ── readControlPlanePort ────────────────────────────────────────────

describe("daemonctl readControlPlanePort guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readControlPlanePort } = await importDaemonctl();

    assert.throws(
      () => readControlPlanePort(),
      /TEST ISOLATION VIOLATION/,
      "should throw when resolving control plane port file under real ~/.tamandua",
    );
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;

    const { readControlPlanePort, writeControlPlanePort } = await importDaemonctl();
    const opts = { homeDir: tempHome };

    writeControlPlanePort(6789, opts);
    assert.equal(readControlPlanePort(opts), 6789, "should read control plane port from isolated dir");
  });
});

// ── writePort ───────────────────────────────────────────────────────

describe("daemonctl writePort guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { writePort } = await importDaemonctl();

    assert.throws(
      () => writePort(9999),
      /TEST ISOLATION VIOLATION/,
      "writePort must refuse to write to production port file",
    );
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;

    const { writePort, readPort } = await importDaemonctl();
    const opts = { homeDir: tempHome };

    assert.doesNotThrow(() => writePort(9999, opts));
    assert.equal(readPort(opts), 9999, "write + read round-trip should work");
  });
});

// ── writeMcpPort ────────────────────────────────────────────────────

describe("daemonctl writeMcpPort guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { writeMcpPort } = await importDaemonctl();

    assert.throws(
      () => writeMcpPort(9998),
      /TEST ISOLATION VIOLATION/,
      "writeMcpPort must refuse to write to production MCP port file",
    );
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    const { writeMcpPort, readMcpPort } = await importDaemonctl();
    const opts = { homeDir: tempHome };

    assert.doesNotThrow(() => writeMcpPort(8888, opts));
    assert.equal(readMcpPort(opts), 8888);
  });
});

// ── writeControlPlanePort ───────────────────────────────────────────

describe("daemonctl writeControlPlanePort guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { writeControlPlanePort } = await importDaemonctl();

    assert.throws(
      () => writeControlPlanePort(9997),
      /TEST ISOLATION VIOLATION/,
      "writeControlPlanePort must refuse to write to production control plane port file",
    );
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    const { writeControlPlanePort, readControlPlanePort } = await importDaemonctl();
    const opts = { homeDir: tempHome };

    assert.doesNotThrow(() => writeControlPlanePort(7777, opts));
    assert.equal(readControlPlanePort(opts), 7777);
  });
});

// ── Path resolution functions ──────────────────────────────────────

describe("daemonctl path file guards", { concurrency: 1 }, () => {
  it("getPidFile throws when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { getPidFile } = await importDaemonctl();

    assert.throws(
      () => getPidFile(),
      /TEST ISOLATION VIOLATION/,
      "getPidFile must refuse when resolving to production PID file",
    );
  });

  it("getMcpPidFile throws when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { getMcpPidFile } = await importDaemonctl();

    assert.throws(
      () => getMcpPidFile(),
      /TEST ISOLATION VIOLATION/,
      "getMcpPidFile must refuse when resolving to production MCP PID file",
    );
  });

  it("getControlPlanePidFile throws when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { getControlPlanePidFile } = await importDaemonctl();

    assert.throws(
      () => getControlPlanePidFile(),
      /TEST ISOLATION VIOLATION/,
      "getControlPlanePidFile must refuse when resolving to production control plane PID file",
    );
  });

  it("getPortFile throws when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { getPortFile } = await importDaemonctl();

    assert.throws(
      () => getPortFile(),
      /TEST ISOLATION VIOLATION/,
      "getPortFile must refuse when resolving to production port file",
    );
  });

  it("getMcpPortFile throws when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { getMcpPortFile } = await importDaemonctl();

    assert.throws(
      () => getMcpPortFile(),
      /TEST ISOLATION VIOLATION/,
      "getMcpPortFile must refuse when resolving to production MCP port file",
    );
  });

  it("getControlPlanePortFile throws when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { getControlPlanePortFile } = await importDaemonctl();

    assert.throws(
      () => getControlPlanePortFile(),
      /TEST ISOLATION VIOLATION/,
      "getControlPlanePortFile must refuse when resolving to production control plane port file",
    );
  });

  it("path functions work normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;
    const opts = { homeDir: tempHome };

    const { getPidFile, getMcpPidFile, getControlPlanePidFile,
            getPortFile, getMcpPortFile, getControlPlanePortFile } = await importDaemonctl();

    const tamanduaDir = path.join(tempHome, ".tamandua");
    assert.ok(getPidFile(opts).startsWith(tamanduaDir));
    assert.ok(getMcpPidFile(opts).startsWith(tamanduaDir));
    assert.ok(getControlPlanePidFile(opts).startsWith(tamanduaDir));
    assert.ok(getPortFile(opts).startsWith(tamanduaDir));
    assert.ok(getMcpPortFile(opts).startsWith(tamanduaDir));
    assert.ok(getControlPlanePortFile(opts).startsWith(tamanduaDir));
  });

  it("path functions work normally when guard is inactive", async () => {
    process.env.TAMANDUA_TEST_GUARD = "0";
    delete process.env.NODE_TEST_CONTEXT;
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { getPidFile, getMcpPidFile, getControlPlanePidFile,
            getPortFile, getMcpPortFile, getControlPlanePortFile } = await importDaemonctl();

    // No throw expected — guard is inactive. Functions return the paths.
    const tamanduaDir = path.join(os.userInfo().homedir, ".tamandua");
    assert.ok(getPidFile().startsWith(tamanduaDir));
    assert.ok(getMcpPidFile().startsWith(tamanduaDir));
    assert.ok(getControlPlanePidFile().startsWith(tamanduaDir));
    assert.ok(getPortFile().startsWith(tamanduaDir));
    assert.ok(getMcpPortFile().startsWith(tamanduaDir));
    assert.ok(getControlPlanePortFile().startsWith(tamanduaDir));
  });
});

// ── HOME-spoof resistance ──────────────────────────────────────────

describe("daemonctl HOME-spoof resistance", { concurrency: 1 }, () => {
  it("readPort still detects production path when HOME is spoofed", async () => {
    // Spoof HOME to a temp dir but don't set TAMANDUA_STATE_DIR.
    // The guard uses os.userInfo().homedir, not os.homedir(), so it
    // should still detect that the resolved port file is under the
    // real ~/.tamandua.
    // Actually, with spoofed HOME, getTamanduaDir() resolves to
    // spoofedHome/.tamandua — which is NOT under realHome/.tamandua.
    // The guard only blocks when the resolved path IS under the real
    // state dir. So with spoofed HOME, readPort() resolves to a
    // different path and the guard should NOT fire. That's correct:
    // if HOME is spoofed, the port file path doesn't hit production.
    const { root: spoofedHome } = createTempHome("tamandua-spoof-");
    process.env.HOME = spoofedHome;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readPort } = await importDaemonctl();

    // With spoofed HOME, the resolved port file is under spoofedHome,
    // not under real ~/.tamandua, so the guard does NOT fire.
    const port = readPort();
    assert.ok(typeof port === "number" && port > 0 && port < 65536,
      "should not be blocked — sporofed HOME resolves to different path");
  });
});

// ── Lifecycle guards: isRunning / isMcpRunning / isControlPlaneRunning ───

describe("daemonctl isRunning guard", { concurrency: 1 }, () => {
  it("returns {running: false} when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { isRunning } = await importDaemonctl();

    const result = isRunning();
    assert.deepEqual(result, { running: false },
      "isRunning must return {running: false} instead of reading production PID file");
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;
    const opts = { homeDir: tempHome };

    // Create a fake PID file in the temp dir with a PID that doesn't exist
    const pidFile = path.join(tempHome, ".tamandua", "tamandua.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(999999), "utf-8");

    const { isRunning } = await importDaemonctl();
    const result = isRunning(opts);
    assert.equal(result.running, false,
      "should check PID file in isolated dir (fake PID is not a real process)");
  });

  it("works normally when guard is inactive", async () => {
    process.env.TAMANDUA_TEST_GUARD = "0";
    delete process.env.NODE_TEST_CONTEXT;
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { isRunning } = await importDaemonctl();

    // Guard inactive — should check the real PID file. It might exist (real daemon)
    // or not. Either way, it should return a valid result without throwing.
    const result = isRunning();
    assert.ok(typeof result.running === "boolean", "should return a result object");
    if (result.running) {
      assert.ok(result.pid > 0, "if running, pid must be positive");
    }
  });
});

describe("daemonctl isMcpRunning guard", { concurrency: 1 }, () => {
  it("returns {running: false} when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { isMcpRunning } = await importDaemonctl();

    const result = isMcpRunning();
    assert.deepEqual(result, { running: false },
      "isMcpRunning must return {running: false} instead of reading production MCP PID file");
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;
    const opts = { homeDir: tempHome };

    const pidFile = path.join(tempHome, ".tamandua", "mcp.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(999999), "utf-8");

    const { isMcpRunning } = await importDaemonctl();
    const result = isMcpRunning(opts);
    assert.equal(result.running, false);
  });
});

describe("daemonctl isControlPlaneRunning guard", { concurrency: 1 }, () => {
  it("returns {running: false} when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { isControlPlaneRunning } = await importDaemonctl();

    const result = isControlPlaneRunning();
    assert.deepEqual(result, { running: false },
      "isControlPlaneRunning must return {running: false} instead of reading production control plane PID file");
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;
    const opts = { homeDir: tempHome };

    const pidFile = path.join(tempHome, ".tamandua", "control-plane.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(999999), "utf-8");

    const { isControlPlaneRunning } = await importDaemonctl();
    const result = isControlPlaneRunning(opts);
    assert.equal(result.running, false);
  });
});

// ── Lifecycle guards: stopDaemon / stopMcp / stopControlPlane ─────

describe("daemonctl stopDaemon guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { stopDaemon } = await importDaemonctl();

    assert.throws(
      () => stopDaemon(),
      /TEST ISOLATION VIOLATION/,
      "stopDaemon must throw when resolving to production PID file",
    );
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;
    const opts = { homeDir: tempHome };

    // No daemon running in isolated dir — stopDaemon should return false.
    const { stopDaemon } = await importDaemonctl();
    const result = stopDaemon(opts);
    assert.equal(result, false, "stopDaemon should return false when no daemon running");
  });
});

describe("daemonctl stopMcp guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { stopMcp } = await importDaemonctl();

    assert.throws(
      () => stopMcp(),
      /TEST ISOLATION VIOLATION/,
      "stopMcp must throw when resolving to production MCP PID file",
    );
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;
    const opts = { homeDir: tempHome };

    const { stopMcp } = await importDaemonctl();
    const result = stopMcp(opts);
    assert.equal(result, false, "stopMcp should return false when no MCP running");
  });
});

describe("daemonctl stopControlPlane guard", { concurrency: 1 }, () => {
  it("throws TEST ISOLATION VIOLATION when guard is active and HOME is real user home", async () => {
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { stopControlPlane } = await importDaemonctl();

    assert.throws(
      () => stopControlPlane(),
      /TEST ISOLATION VIOLATION/,
      "stopControlPlane must throw when resolving to production control plane PID file",
    );
  });

  it("works normally when opts.homeDir is provided", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-guard-");
    process.env.HOME = os.userInfo().homedir;
    const opts = { homeDir: tempHome };

    const { stopControlPlane } = await importDaemonctl();
    const result = stopControlPlane(opts);
    assert.equal(result, false, "stopControlPlane should return false when no control plane running");
  });
});

// ── HOME-isolation regression (ISFO) ──────────────────────────────
//
// These tests verify that daemonctl path-resolution functions work
// correctly under TAMANDUA_TEST_GUARD=1 when HOME points to an isolated
// temp directory WITHOUT requiring opts.homeDir. This is the pattern
// used by startDashboard() (calls readMcpPort), controlRequest() in
// control-client (resolves daemon-secret via HOME), and runDoctorChecks()
// (calls daemonctl functions). If this had been tested when the ISOL
// guard was added, the fallout (11 test failures across doctor.test.ts,
// dashboard.test.ts, and dashboard-api-pause-resume.test.ts) would have
// been caught before merge.

describe("daemonctl isolation via HOME env (no opts.homeDir)", { concurrency: 1 }, () => {
  it("readMcpPort works when HOME is isolated temp dir", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-home-iso-");
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readMcpPort, writeMcpPort } = await importDaemonctl();

    // Write a port file in the isolated HOME (no opts)
    writeMcpPort(9191);
    const port = readMcpPort();
    assert.equal(port, 9191, "should read MCP port from isolated HOME dir without opts");
  });

  it("readControlPlanePort works when HOME is isolated temp dir", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-home-iso-");
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readControlPlanePort, writeControlPlanePort } = await importDaemonctl();

    writeControlPlanePort(9292);
    const port = readControlPlanePort();
    assert.equal(port, 9292, "should read control plane port from isolated HOME dir without opts");
  });

  it("readPort works when HOME is isolated temp dir", async () => {
    const { root: tempHome } = createTempHome("tamandua-dc-home-iso-");
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readPort, writePort } = await importDaemonctl();

    writePort(9393);
    const port = readPort();
    assert.equal(port, 9393, "should read port from isolated HOME dir without opts");
  });

  it("type guard smoke: readPort throws when HOME is NOT isolated", async () => {
    // Verify the guard still fires when HOME is the real user home —
    // this confirms the guard is active and the isolated-HOME tests
    // above aren't false negatives (guard disabled).
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;

    const { readPort } = await importDaemonctl();

    assert.throws(
      () => readPort(),
      /TEST ISOLATION VIOLATION/,
      "guard must still fire when HOME is real user home",
    );
  });
});

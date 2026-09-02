/**
 * stopDaemonFamily unit coverage: the teardown helper that stops and awaits
 * every daemon-family process recorded in a temp HOME's pid files before the
 * directory is removed.
 *
 * These tests pin the four behaviors the darwin ENOTEMPTY fix relies on:
 *   - every live pid file under the HOME is stopped AND awaited;
 *   - a missing pid file is skipped (reported, never signalled);
 *   - a stale pid (dead process) is skipped and its pid file is cleaned;
 *   - a pid not read from a pid file under the HOME is never signalled.
 *
 * Like daemonctl-self-stop-guard.test.ts, this uses long-lived fake daemon
 * children (node -e 'setInterval(...)') writing pid files into an isolated
 * temp HOME. It spawns OS processes, so it runs in the serial lane.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { spawn, type ChildProcess } from "node:child_process";
import { stopDaemonFamily } from "../../dist/server/daemonctl.js";

let tempHome: string;
let spawnedPids: number[] = [];

beforeEach(() => {
  tempHome = tamanduaTempDir("tamandua-family-stop-");
  fs.mkdirSync(path.join(tempHome, ".tamandua"), { recursive: true });
});

afterEach(async () => {
  const toKill = spawnedPids.splice(0);
  for (const pid of toKill) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const pid of toKill) {
    await waitForExit(pid);
  }
  fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Event-driven pid-exit poll; never a fixed sleep. */
async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid ${pid} did not exit within ${timeoutMs}ms`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Long-lived child standing in for a daemon-family process. When pidFileName
 * is given, the child's pid is written to <tempHome>/.tamandua/<pidFileName>.
 * The child is tracked so afterEach always SIGKILLs it (even if a test fails
 * before stopDaemonFamily runs).
 */
function spawnFakeDaemon(pidFileName?: string): number {
  // HOME must match the isolated homeDir: canSignalPid binds the target to
  // the homeDir via /proc on Linux or pidfile provenance on macOS.
  const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    stdio: "ignore",
    env: { HOME: tempHome, PATH: process.env.PATH ?? "" },
  });
  const pid = child.pid!;
  spawnedPids.push(pid);
  if (pidFileName !== undefined) {
    fs.writeFileSync(path.join(tempHome, ".tamandua", pidFileName), String(pid), "utf-8");
  }
  return pid;
}

/** Spawn a process that exits immediately and return its (now dead) pid. */
function spawnShortLived(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], {
      stdio: "ignore",
      env: { HOME: tempHome, PATH: process.env.PATH ?? "" },
    });
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid!));
  });
}

function stoppedByFile(summary: Awaited<ReturnType<typeof stopDaemonFamily>>): Map<string, number | null> {
  return new Map(summary.stopped.map((entry) => [entry.pidFile, entry.pid]));
}

describe("daemonctl stopDaemonFamily", () => {
  it("stops and awaits every live daemon-family pid recorded under the temp HOME", async () => {
    const daemonPid = spawnFakeDaemon("tamandua.pid");
    const mcpPid = spawnFakeDaemon("mcp.pid");
    const cpPid = spawnFakeDaemon("control-plane.pid");
    const dashPid = spawnFakeDaemon("dashboard.pid");

    const summary = await stopDaemonFamily({ homeDir: tempHome });

    assert.equal(summary.stopped.length, 4);
    assert.equal(summary.skippedMissing.length, 0);
    assert.equal(summary.skippedStale.length, 0);
    assert.equal(summary.skippedNotSignalable.length, 0);
    assert.equal(summary.timedOut.length, 0);

    const byFile = stoppedByFile(summary);
    assert.equal(byFile.get("tamandua.pid"), daemonPid);
    assert.equal(byFile.get("mcp.pid"), mcpPid);
    assert.equal(byFile.get("control-plane.pid"), cpPid);
    assert.equal(byFile.get("dashboard.pid"), dashPid);

    for (const pid of [daemonPid, mcpPid, cpPid, dashPid]) {
      assert.equal(isPidAlive(pid), false, `pid ${pid} should have exited after stopDaemonFamily`);
    }
  });

  it("skips a missing pid file and still stops the rest of the family", async () => {
    const daemonPid = spawnFakeDaemon("tamandua.pid");
    const mcpPid = spawnFakeDaemon("mcp.pid");
    const cpPid = spawnFakeDaemon("control-plane.pid");
    // dashboard.pid is intentionally absent.

    const summary = await stopDaemonFamily({ homeDir: tempHome });

    assert.equal(summary.stopped.length, 3);
    assert.equal(summary.skippedMissing.length, 1);
    assert.deepEqual(summary.skippedMissing[0], { pidFile: "dashboard.pid", pid: null });
    assert.equal(summary.skippedStale.length, 0);

    for (const pid of [daemonPid, mcpPid, cpPid]) {
      assert.equal(isPidAlive(pid), false, `pid ${pid} should have exited`);
    }
  });

  it("skips a stale pid (dead process) and cleans up its pid file", async () => {
    const deadPid = await spawnShortLived();
    const mcpPidFile = path.join(tempHome, ".tamandua", "mcp.pid");
    fs.writeFileSync(mcpPidFile, String(deadPid), "utf-8");

    const daemonPid = spawnFakeDaemon("tamandua.pid");

    const summary = await stopDaemonFamily({ homeDir: tempHome });

    assert.equal(summary.stopped.length, 1);
    assert.equal(summary.skippedStale.length, 1);
    assert.equal(summary.skippedStale[0].pidFile, "mcp.pid");
    assert.equal(summary.skippedStale[0].pid, deadPid);
    assert.equal(fs.existsSync(mcpPidFile), false, "stale pid file should be removed");
    assert.equal(isPidAlive(daemonPid), false, "live daemon should still be stopped");
  });

  it("never kills a pid that was not read from a pid file under the HOME", async () => {
    // Bystander lives in the same temp HOME but is recorded in no pid file.
    const bystanderPid = spawnFakeDaemon(undefined);
    const daemonPid = spawnFakeDaemon("tamandua.pid");
    const mcpPid = spawnFakeDaemon("mcp.pid");
    const cpPid = spawnFakeDaemon("control-plane.pid");
    const dashPid = spawnFakeDaemon("dashboard.pid");

    const summary = await stopDaemonFamily({ homeDir: tempHome });

    assert.equal(summary.stopped.length, 4);
    assert.equal(isPidAlive(bystanderPid), true, "bystander pid must survive: it was not in any pid file");

    for (const pid of [daemonPid, mcpPid, cpPid, dashPid]) {
      assert.equal(isPidAlive(pid), false, `pid ${pid} should have exited`);
    }
  });
});

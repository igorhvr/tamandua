/**
 * Self-stop guard: an agent must not be able to stop the daemon that is
 * scheduling it. Agents inherit TAMANDUA_WORKER_PID (the scheduling
 * daemon's pid) from the harness env; stopDaemon/stopMcp/stopControlPlane
 * refuse to SIGTERM that pid with an actionable error pointing at
 * isolated instances. Any other pid — e.g. an isolated test daemon the
 * agent started itself — is still stoppable.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { spawn } from "node:child_process";
import { stopDaemon, stopMcp, stopControlPlane } from "../../dist/server/daemonctl.js";

let tempHome: string;
let savedWorkerPid: string | undefined;

beforeEach(() => {
  tempHome = tamanduaTempDir("tamandua-self-stop-");
  fs.mkdirSync(path.join(tempHome, ".tamandua"), { recursive: true });
  savedWorkerPid = process.env.TAMANDUA_WORKER_PID;
});

afterEach(() => {
  if (savedWorkerPid === undefined) delete process.env.TAMANDUA_WORKER_PID;
  else process.env.TAMANDUA_WORKER_PID = savedWorkerPid;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** Long-lived child standing in for a daemon; pidfile written by the test. */
function spawnFakeDaemon(pidFileName: string): { pid: number; kill: () => void } {
  // HOME must match the isolated homeDir: canSignalPid verifies the target
  // process's HOME via /proc before the self-stop guard even runs.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    stdio: "ignore",
    env: { HOME: tempHome, PATH: process.env.PATH ?? "" },
  });
  const pid = child.pid!;
  fs.writeFileSync(path.join(tempHome, ".tamandua", pidFileName), String(pid), "utf-8");
  return {
    pid,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}

describe("daemonctl self-stop guard", () => {
  it("stopDaemon refuses when the target is the scheduling daemon (TAMANDUA_WORKER_PID)", () => {
    const fake = spawnFakeDaemon("tamandua.pid");
    try {
      process.env.TAMANDUA_WORKER_PID = String(fake.pid);
      assert.throws(
        () => stopDaemon({ homeDir: tempHome }),
        /Refusing to stop the dashboard daemon .*scheduling\s+.*the current tamandua agent run/s,
      );
      // The daemon must still be alive.
      assert.doesNotThrow(() => process.kill(fake.pid, 0));
    } finally {
      fake.kill();
    }
  });

  it("stopMcp and stopControlPlane refuse the scheduling daemon's pid too", () => {
    const fakeMcp = spawnFakeDaemon("mcp.pid");
    const fakeCp = spawnFakeDaemon("control-plane.pid");
    try {
      process.env.TAMANDUA_WORKER_PID = String(fakeMcp.pid);
      assert.throws(() => stopMcp({ homeDir: tempHome }), /Refusing to stop the MCP server/);

      process.env.TAMANDUA_WORKER_PID = String(fakeCp.pid);
      assert.throws(() => stopControlPlane({ homeDir: tempHome }), /Refusing to stop the control plane/);
    } finally {
      fakeMcp.kill();
      fakeCp.kill();
    }
  });

  it("stopDaemon still stops daemons that are NOT the scheduling daemon", () => {
    const fake = spawnFakeDaemon("tamandua.pid");
    try {
      // Simulate an agent env pointing at a DIFFERENT daemon pid: stopping
      // an isolated instance the agent started itself must keep working.
      process.env.TAMANDUA_WORKER_PID = String(process.pid);
      const stopped = stopDaemon({ homeDir: tempHome });
      assert.equal(stopped, true, "non-scheduling daemon should be stoppable");
    } finally {
      fake.kill();
    }
  });

  it("guard is inert outside agent runs (no TAMANDUA_WORKER_PID)", () => {
    const fake = spawnFakeDaemon("tamandua.pid");
    try {
      delete process.env.TAMANDUA_WORKER_PID;
      const stopped = stopDaemon({ homeDir: tempHome });
      assert.equal(stopped, true, "user-invoked stop must work as always");
    } finally {
      fake.kill();
    }
  });
});

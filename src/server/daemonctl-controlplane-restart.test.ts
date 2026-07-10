/**
 * Tests for restartControlPlane — stop + start lifecycle.
 *
 * Isolated via temporary HOME directories; never touches live state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTempHome as sharedCreateTempHome } from "../../tests/helpers/test-env.ts";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTROL_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "control-standalone.js");

import {
  restartControlPlane,
  startControlPlane,
  stopControlPlane,
  isControlPlaneRunning,
  readControlPlanePort,
  writeControlPlanePort,
  getControlPlanePidFile,
  getControlPlanePortFile,
} from "../../dist/server/daemonctl.js";
import { DEFAULT_CONTROL_PORT } from "../../dist/server/control-server.js";

// ── Helpers ────────────────────────────────────────────────────────

function createTempHome(): string {
  const { root } = sharedCreateTempHome("tamandua-cp-restart-");
  return root;
}

async function getAvailablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("daemonctl restartControlPlane", { concurrency: 1 }, () => {
  it("restartControlPlane is exported and callable — returns { pid, port }", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      stopControlPlane({ homeDir: tempHome });

      const result = await restartControlPlane(port, { homeDir: tempHome });

      assert.equal(typeof result.pid, "number");
      assert.ok(result.pid > 0, "pid should be a positive number");
      assert.equal(typeof result.port, "number");
      assert.equal(result.port, port, "port should match the requested port");
    } finally {
      try { stopControlPlane({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartControlPlane stops running control plane and starts a new one with a different PID", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      stopControlPlane({ homeDir: tempHome });

      // Start control plane first
      const first = await startControlPlane(port, { homeDir: tempHome });
      const firstPid = first.pid;
      assert.ok(firstPid > 0);

      // Restart
      const result = await restartControlPlane(port, { homeDir: tempHome });
      assert.ok(result.pid > 0, "restartControlPlane should return a valid PID");
      assert.equal(result.port, port);
      assert.notEqual(result.pid, firstPid, "restartControlPlane should spawn a new process with a different PID");

      // Verify the pid file has the new PID
      const after = isControlPlaneRunning({ homeDir: tempHome });
      assert.equal(after.running, true);
      assert.equal(after.pid, result.pid);
    } finally {
      try { stopControlPlane({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartControlPlane uses stored port from port file when no port arg given", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      stopControlPlane({ homeDir: tempHome });

      // Write a port to the control plane port file
      writeControlPlanePort(port, { homeDir: tempHome });
      assert.equal(readControlPlanePort({ homeDir: tempHome }), port);

      // Restart without specifying port — should use stored port
      const result = await restartControlPlane(undefined, { homeDir: tempHome });
      assert.equal(result.port, port, "should use the stored port when no port arg given");
      assert.ok(result.pid > 0);
    } finally {
      try { stopControlPlane({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartControlPlane with explicit port overrides stored port file value", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const storedPort = await getAvailablePort();
    const explicitPort = await getAvailablePort();
    // Ensure ports are different
    if (explicitPort === storedPort) {
      t.skip("Could not get two distinct ports");
      return;
    }

    const tempHome = createTempHome();
    try {
      stopControlPlane({ homeDir: tempHome });

      // Write a different port to the port file
      writeControlPlanePort(storedPort, { homeDir: tempHome });

      // Restart with explicit port — should use explicit port, not stored
      const result = await restartControlPlane(explicitPort, { homeDir: tempHome });
      assert.equal(result.port, explicitPort, "explicit --port should override stored port file");
      assert.ok(result.pid > 0);
    } finally {
      try { stopControlPlane({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartControlPlane cleans up old PID file on restart", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      stopControlPlane({ homeDir: tempHome });

      const first = await startControlPlane(port, { homeDir: tempHome });
      const firstPid = first.pid;

      // Verify PID file has first PID
      const pidFile = getControlPlanePidFile({ homeDir: tempHome });
      assert.ok(fs.existsSync(pidFile));
      assert.equal(parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10), firstPid);

      // Restart
      const result = await restartControlPlane(port, { homeDir: tempHome });

      // PID file should have new PID
      assert.ok(fs.existsSync(pidFile));
      assert.equal(parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10), result.pid);
      assert.notEqual(result.pid, firstPid);
    } finally {
      try { stopControlPlane({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartControlPlane starts control plane if not currently running", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      stopControlPlane({ homeDir: tempHome });

      // Verify nothing is running
      const before = isControlPlaneRunning({ homeDir: tempHome });
      assert.equal(before.running, false);

      // Restart when nothing is running — should just start
      const result = await restartControlPlane(port, { homeDir: tempHome });
      assert.ok(result.pid > 0);
      assert.equal(result.port, port);

      // Verify running now
      const after = isControlPlaneRunning({ homeDir: tempHome });
      assert.equal(after.running, true);
      assert.equal(after.pid, result.pid);
    } finally {
      try { stopControlPlane({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartControlPlane return type is callable function", () => {
    // Type-level check: if restartControlPlane were not exported or had a different
    // return type, this import would fail at the module level. This test just
    // confirms the function is callable.
    assert.equal(typeof restartControlPlane, "function");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getPidFile,
  getPortFile,
  getLogFile,
  isRunning,
  getDaemonStatus,
  stopDaemon,
  getDashboardPidFile,
  getDashboardPortFile,
  getDashboardLogFile,
  isDashboardRunning,
  getDashboardStatus,
} from "../../dist/server/daemonctl.js";

describe("daemonctl dashboard helpers", () => {
  let tempHome: string;

  beforeEach(() => {
    const { homeDir } = createTempHome("tamandua-dctl-");
    tempHome = homeDir;
    fs.mkdirSync(path.join(tempHome, ".tamandua"), { recursive: true });
  });

  afterEach(() => {
    try { stopDaemon({ homeDir: tempHome }); } catch {}
  });

  describe("path helpers", () => {
    it("getPidFile returns path ending with tamandua.pid", () => {
      const p = getPidFile({ homeDir: tempHome });
      assert.ok(p.includes(".tamandua"));
      assert.ok(p.endsWith("tamandua.pid"));
      assert.ok(p.startsWith(tempHome));
    });

    it("getPortFile returns path ending with port", () => {
      const p = getPortFile({ homeDir: tempHome });
      assert.ok(p.includes(".tamandua"));
      assert.ok(p.endsWith("port"));
      assert.ok(p.startsWith(tempHome));
    });

    it("getLogFile returns path ending with dashboard.log", () => {
      const p = getLogFile({ homeDir: tempHome });
      assert.ok(p.includes(".tamandua"));
      assert.ok(p.endsWith("dashboard.log"));
      assert.ok(p.startsWith(tempHome));
    });
  });

  describe("isRunning / getDaemonStatus (no daemon running)", () => {
    it("isRunning returns false when no PID file", () => {
      const result = isRunning({ homeDir: tempHome });
      assert.equal(result.running, false);
    });

    it("getDaemonStatus returns not running state", () => {
      const status = getDaemonStatus({ homeDir: tempHome });
      assert.equal(status.running, false);
      assert.equal(status.pid, null);
    });
  });

  // ── Dashboard standalone helpers ────────────────────────────────

  describe("dashboard standalone path helpers", () => {
    it("getDashboardPidFile returns path ending with dashboard.pid", () => {
      const p = getDashboardPidFile({ homeDir: tempHome });
      assert.ok(p.includes(".tamandua"));
      assert.ok(p.endsWith("dashboard.pid"));
      assert.ok(p.startsWith(tempHome));
    });

    it("getDashboardPortFile returns same path as getPortFile", () => {
      const dashPort = getDashboardPortFile({ homeDir: tempHome });
      const daemonPort = getPortFile({ homeDir: tempHome });
      assert.equal(dashPort, daemonPort);
      assert.ok(dashPort.endsWith("port"));
    });

    it("getDashboardLogFile returns path ending with dashboard.log", () => {
      const p = getDashboardLogFile({ homeDir: tempHome });
      assert.ok(p.includes(".tamandua"));
      assert.ok(p.endsWith("dashboard.log"));
      assert.ok(p.startsWith(tempHome));
    });

    it("dashboard PID file is distinct from daemon PID file", () => {
      const dashPid = getDashboardPidFile({ homeDir: tempHome });
      const daemonPid = getPidFile({ homeDir: tempHome });
      assert.notEqual(dashPid, daemonPid);
      assert.ok(dashPid.endsWith("dashboard.pid"));
      assert.ok(daemonPid.endsWith("tamandua.pid"));
    });

    it("dashboard log file is distinct from daemon log file", () => {
      const dashLog = getDashboardLogFile({ homeDir: tempHome });
      const daemonLog = getLogFile({ homeDir: tempHome });
      // Dashboard log is separate (dashboard.log vs tamandua.log for daemon)
      assert.ok(dashLog.includes("dashboard.log"));
    });
  });

  describe("isDashboardRunning / getDashboardStatus (no dashboard running)", () => {
    it("isDashboardRunning returns false when no PID file", () => {
      const result = isDashboardRunning({ homeDir: tempHome });
      assert.equal(result.running, false);
    });

    it("getDashboardStatus returns not running state with default port", () => {
      const status = getDashboardStatus({ homeDir: tempHome });
      assert.equal(status.running, false);
      assert.equal(status.pid, null);
      assert.equal(status.port, 3334);
    });
  });
});
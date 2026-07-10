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
});

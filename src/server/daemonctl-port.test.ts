import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  readPort,
  writePort,
  getPidFile,
  getPortFile,
  getLogFile,
  getDashboardPidFile,
  getDashboardPortFile,
  getDashboardLogFile,
} from "../../dist/server/daemonctl.js";

describe("daemonctl port helpers", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    const { homeDir } = createTempHome("tamandua-daemonctl-");
    tempHome = homeDir;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  const opts = () => ({ homeDir: tempHome });

  it("readPort defaults to 3334 without port file", () => {
    assert.equal(readPort(opts()), 3334);
  });

  it("writePort + readPort round-trips", () => {
    writePort(4567, opts());
    assert.equal(readPort(opts()), 4567);
  });

  it("readPort returns 3334 for invalid port file content", () => {
    const d = path.join(tempHome, ".tamandua");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "port"), "not-a-number", "utf-8");
    assert.equal(readPort(opts()), 3334);
  });

  it("readPort returns 3334 for out-of-range port", () => {
    const d = path.join(tempHome, ".tamandua");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "port"), "99999", "utf-8");
    assert.equal(readPort(opts()), 3334);
  });

  it("writePort creates tamandua dir", () => {
    writePort(8888, opts());
    const d = path.join(tempHome, ".tamandua");
    assert.ok(fs.existsSync(d));
    assert.equal(fs.readFileSync(path.join(d, "port"), "utf-8").trim(), "8888");
  });

  it("getPidFile ends with .pid", () => {
    assert.ok(getPidFile(opts()).endsWith(".pid"));
  });

  it("getPortFile ends with port", () => {
    assert.ok(getPortFile(opts()).endsWith("port"));
  });

  it("getLogFile is a .log file", () => {
    assert.ok(getLogFile(opts()).endsWith(".log"));
  });

  // ── Dashboard standalone port / path helpers ───────────────────

  it("getDashboardPortFile returns same as getPortFile", () => {
    assert.equal(getDashboardPortFile(opts()), getPortFile(opts()));
  });

  it("getDashboardPidFile ends with dashboard.pid", () => {
    const p = getDashboardPidFile(opts());
    assert.ok(p.endsWith("dashboard.pid"));
  });

  it("getDashboardLogFile ends with dashboard.log", () => {
    const p = getDashboardLogFile(opts());
    assert.ok(p.endsWith("dashboard.log"));
  });

  it("dashboard PidFile is distinct from daemon PidFile", () => {
    const dashPid = getDashboardPidFile(opts());
    const daemonPid = getPidFile(opts());
    assert.notEqual(dashPid, daemonPid);
  });

  it("dashboard standalone paths live under .tamandua", () => {
    const dashPid = getDashboardPidFile(opts());
    const dashPort = getDashboardPortFile(opts());
    const dashLog = getDashboardLogFile(opts());

    assert.ok(dashPid.includes(".tamandua"));
    assert.ok(dashPort.includes(".tamandua"));
    assert.ok(dashLog.includes(".tamandua"));

    assert.ok(dashPid.startsWith(tempHome));
    assert.ok(dashPort.startsWith(tempHome));
    assert.ok(dashLog.startsWith(tempHome));
  });
});

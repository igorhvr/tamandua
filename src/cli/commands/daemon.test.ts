import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getControlPlaneHelp,
  getControlPlaneRestartHelp,
  getControlPlaneStartHelp,
  getControlPlaneStatusHelp,
  getControlPlaneStopHelp,
  getDaemonHelp,
  getDaemonRestartHelp,
  getDaemonStartHelp,
  getDaemonStatusHelp,
  getDaemonStopHelp,
  handleDaemon,
} from "../../../dist/cli/commands/daemon.js";

describe("SPL2 daemon and control-plane command module", () => {
  it("is backed by a daemon command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/daemon.ts")), true);
  });

  it("owns daemon group and lifecycle subcommand help", () => {
    assert.match(getDaemonHelp(), /tamandua daemon <start\|stop\|restart\|status>/);
    assert.match(getDaemonStartHelp(), /tamandua daemon start \[--port N\]/);
    assert.match(getDaemonStopHelp(), /tamandua daemon stop/);
    assert.match(getDaemonRestartHelp(), /tamandua daemon restart \[--port N\]/);
    assert.match(getDaemonStatusHelp(), /tamandua daemon status/);
  });

  it("owns alias-specific control-plane help", () => {
    assert.match(getControlPlaneHelp(), /tamandua control-plane <start\|stop\|restart\|status>/);
    assert.match(getControlPlaneStartHelp(), /Alias for tamandua daemon start/);
    assert.match(getControlPlaneStopHelp(), /Alias for tamandua daemon stop/);
    assert.match(getControlPlaneRestartHelp(), /Alias for tamandua daemon restart/);
    assert.match(getControlPlaneStatusHelp(), /Alias for tamandua daemon status/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleDaemon("dashboard", ["dashboard", "status"]), false);
  });
});

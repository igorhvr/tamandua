import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";

import {
  getDashboardHelp,
  getDashboardRestartHelp,
  getDashboardStartHelp,
  getDashboardStatusHelp,
  getDashboardStopHelp,
  handleDashboard,
} from "../../../dist/cli/commands/dashboard.js";

describe("SPL2 dashboard command module", () => {
  it("is backed by a dashboard command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/dashboard.ts")), true);
  });

  it("owns group and lifecycle subcommand help", () => {
    assert.match(getDashboardHelp(), /tamandua dashboard <start\|stop\|restart\|status>/);
    assert.match(getDashboardStartHelp(), /tamandua dashboard start \[--port N\]/);
    assert.match(getDashboardStopHelp(), /tamandua dashboard stop/);
    assert.match(getDashboardRestartHelp(), /tamandua dashboard restart \[--port N\]/);
    assert.match(getDashboardStatusHelp(), /tamandua dashboard status/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleDashboard("mcp", ["mcp", "status"]), false);
  });
});

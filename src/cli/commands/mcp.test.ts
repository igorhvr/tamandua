import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getMcpHelp,
  getMcpRestartHelp,
  getMcpStartHelp,
  getMcpStatusHelp,
  getMcpStopHelp,
  handleMcp,
} from "../../../dist/cli/commands/mcp.js";

describe("SPL2 MCP command module", () => {
  it("owns group and lifecycle subcommand help", () => {
    assert.match(getMcpHelp(), /tamandua mcp <start\|stop\|restart\|status>/);
    assert.match(getMcpStartHelp(), /tamandua mcp start \[--port N\]/);
    assert.match(getMcpStopHelp(), /tamandua mcp stop/);
    assert.match(getMcpRestartHelp(), /tamandua mcp restart \[--port N\]/);
    assert.match(getMcpStatusHelp(), /tamandua mcp status/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleMcp("dashboard", ["dashboard", "status"]), false);
  });
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getLogsHelp,
  getLogsTailHelp,
  handleLogs,
} from "../../../dist/cli/commands/logs.js";

describe("SPL2 logs command module", () => {
  it("is backed by a reachable logs command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/logs.ts")), true);
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /from "\.\/commands\/logs\.js"/);
  });

  it("owns logs and logs-tail help", () => {
    assert.match(getLogsHelp(), /Show recent activity events/);
    assert.match(getLogsHelp(), /events file on\ndisk/);
    assert.match(getLogsTailHelp(), /Follow activity events in real-time/);
    assert.match(getLogsTailHelp(), /TAMANDUA_LOGS_TAIL_POLL_MS/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleLogs("worktree", ["worktree", "list"]), false);
  });
});

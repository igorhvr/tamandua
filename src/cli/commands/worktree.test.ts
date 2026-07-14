import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getWorktreeGroupHelp,
  getWorktreeListHelp,
  getWorktreePruneHelp,
  getWorktreeRemoveHelp,
  getWorktreeStatusHelp,
  handleWorktree,
} from "../../../dist/cli/commands/worktree.js";

describe("SPL2 worktree command module", () => {
  it("is backed by a reachable worktree command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/worktree.ts")), true);
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /from "\.\/commands\/worktree\.js"/);
  });

  it("owns the worktree group and subcommand help", () => {
    assert.match(getWorktreeGroupHelp(), /Manage git worktrees for workflow runs/);
    assert.match(getWorktreeListHelp(), /List all managed worktrees/);
    assert.match(getWorktreeStatusHelp(), /Show detailed worktree info for a run/);
    assert.match(getWorktreeRemoveHelp(), /Allow removal of worktrees in any status/);
    assert.match(getWorktreePruneHelp(), /completed, failed, or orphaned worktrees/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleWorktree("logs", ["logs"]), false);
  });
});

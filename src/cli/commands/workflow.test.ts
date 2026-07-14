import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getWorkflowAutoresearchHelp,
  getWorkflowDeleteHelp,
  getWorkflowGroupHelp,
  getWorkflowInstallHelp,
  getWorkflowListHelp,
  getWorkflowPauseAllHelp,
  getWorkflowPauseHelp,
  getWorkflowResumeAllHelp,
  getWorkflowResumeHelp,
  getWorkflowRunHelp,
  getWorkflowRunsHelp,
  getWorkflowStatusHelp,
  getWorkflowStopHelp,
  getWorkflowUninstallHelp,
  handleWorkflow,
} from "../../../dist/cli/commands/workflow.js";

describe("SPL2 workflow command module", () => {
  it("is backed by a reachable workflow command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/workflow.ts")), true);
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /from "\.\/commands\/workflow\.js"/);
  });

  it("owns the workflow group and every action help route", () => {
    assert.match(getWorkflowGroupHelp(), /Manage workflows and runs/);
    assert.match(getWorkflowListHelp(), /List available bundled workflows/);
    assert.match(getWorkflowRunsHelp(), /List all workflow runs/);
    assert.match(getWorkflowInstallHelp(), /Install a specific workflow/);
    assert.match(getWorkflowUninstallHelp(), /Uninstall one or all workflows/);
    assert.match(getWorkflowRunHelp(), /Start a new workflow run/);
    assert.match(getWorkflowStatusHelp(), /Show detailed run status/);
    assert.match(getWorkflowAutoresearchHelp(), /Show AutoResearch progress/);
    assert.match(getWorkflowDeleteHelp(), /Permanently delete a workflow run/);
    assert.match(getWorkflowStopHelp(), /Cancel a running workflow/);
    assert.match(getWorkflowPauseHelp(), /Pause a running workflow/);
    assert.match(getWorkflowResumeHelp(), /Resume a paused or failed workflow run/);
    assert.match(getWorkflowPauseAllHelp(), /Pause all running workflows/);
    assert.match(getWorkflowResumeAllHelp(), /Resume all paused workflows/);
  });

  it("preserves the exact workflow group help text", () => {
    assert.equal(getWorkflowGroupHelp(), `tamandua workflow — Manage workflows and runs

Usage: tamandua workflow <list|runs|install|uninstall|run|status|autoresearch|stop|delete|pause|resume|pause-all|resume-all>

Commands for managing Tamandua workflows and their runs.

Subcommands:
  list        List available bundled workflows
  runs        List all workflow runs with status, tokens, task preview
  install     Install a specific workflow by name
  uninstall   Uninstall a workflow (--all for all workflows, --force to skip
              active-runs check)
  run         Start a new workflow run with the given task
  status      Show detailed run status with step listing
  autoresearch
              Show AutoResearch progress for a run
  stop        Cancel a running workflow
  delete      Permanently delete a run and all its data (--force for active runs)
  pause       Pause a running workflow via the daemon
  resume      Resume a paused or failed workflow run
  pause-all   Pause all running workflows
  resume-all  Resume all paused workflows

Examples:
  tamandua workflow list
  tamandua workflow runs
  tamandua workflow install feature-dev-merge
  tamandua workflow run feature-dev-merge "Add a new feature"
  tamandua workflow status abc12345
  tamandua workflow autoresearch abc12345
  tamandua workflow pause abc12345 --drain`);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleWorkflow("worktree", ["worktree", "list"], () => {}), false);
  });
});

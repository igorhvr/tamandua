import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

import {
  getLogsHelp,
  getLogsTailHelp,
  handleLogs,
} from "../../../dist/cli/commands/logs.js";
import { cleanChildEnv, createTempHome } from "../../../tests/helpers/test-env.ts";

/** Spawn the tamandua CLI with isolated temp environment. */
function cli(args: string[]) {
  const th = createTempHome("tamandua-logs-test-");
  const wrapperPath = path.resolve("bin/tamandua");
  const result = spawnSync("/bin/sh", [wrapperPath, ...args], {
    encoding: "utf8",
    env: cleanChildEnv({
      HOME: th.homeDir,
      TAMANDUA_STATE_DIR: th.tamanduaDir,
    }),
  });
  return { ...result, testEnv: th };
}

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

  it("getLogsHelp mentions --tail", () => {
    assert.match(getLogsHelp(), /--tail/);
    assert.match(getLogsHelp(), /Follow events in real-time/);
  });
});

describe("tamandua logs --tail and error handling", () => {
  it("tamandua logs tail prints hint and exits 1", () => {
    const result = cli(["logs", "tail"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /Did you mean: tamandua logs-tail\?/);
  });

  it("tamandua logs --unknown-flag prints error and exits 1", () => {
    const result = cli(["logs", "--unknown-flag"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /Unknown option "--unknown-flag" for tamandua logs/);
  });

  it("tamandua logs --tail with no value errors", () => {
    const result = cli(["logs", "--tail"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /Unknown option "--tail" for tamandua logs/);
  });

  it("tamandua logs --tail=bad errors", () => {
    const result = cli(["logs", "--tail=bad"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /Unknown option "--tail=bad" for tamandua logs/);
  });

  it("tamandua logs --some-other-flag errors", () => {
    const result = cli(["logs", "--some-other-flag", "value"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /Unknown option "--some-other-flag" for tamandua logs/);
  });

  it("tamandua logs --tail 30 with bogus run-id prints not-found", () => {
    const result = cli(["logs", "nonexistent-run", "--tail", "30"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout ?? "", /No run found matching "nonexistent-run"/);
  });

  it("tamandua logs --tail=20 with bogus run-id prints not-found", () => {
    const result = cli(["logs", "nonexistent-run", "--tail=20"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout ?? "", /No run found matching "nonexistent-run"/);
  });

  it("tamandua logs with no flags works (no events yet)", () => {
    const result = cli(["logs"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout ?? "", /No events yet\./);
  });
});

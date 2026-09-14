import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("getLogsHelp describes --tail as bounded", () => {
    assert.match(getLogsHelp(), /--tail/);
    assert.match(getLogsHelp(), /Print the last N events and exit/);
    assert.doesNotMatch(getLogsHelp(), /Follow events in real-time/);
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

describe("tamandua logs --tail N bounded (never follows)", () => {
  const wrapperPath = path.resolve("bin/tamandua");

  function makeEvent(runId: string, detail: string) {
    return { ts: new Date().toISOString(), event: "step.pending", runId, detail };
  }

  function appendEvent(filePath: string, event: unknown): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  function setupDbWithRun(stateDir: string, runId: string, runNumber: number): void {
    mkdirSync(stateDir, { recursive: true });
    const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        run_number INTEGER,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at)
      VALUES (?, ?, 'logs-tail-test', 'test run', 'running', '{}', ?, ?)
    `).run(runId, runNumber, now, now);
    db.close();
  }

  function runCli(stateDir: string, homeDir: string, args: string[]) {
    // Hard timeout so a regression to follow-mode fails fast instead of
    // hanging the whole serial test file.
    return spawnSync("/bin/sh", [wrapperPath, ...args], {
      encoding: "utf8",
      env: cleanChildEnv({ HOME: homeDir, TAMANDUA_STATE_DIR: stateDir }),
      timeout: 5000,
    });
  }

  it("global --tail N prints the last N global events and exits 0", () => {
    const th = createTempHome("tamandua-logs-bounded-global-");
    try {
      const globalFile = path.join(th.tamanduaDir, "events", "all.jsonl");
      for (let i = 1; i <= 8; i++) appendEvent(globalFile, makeEvent("run-g", `g-${i}`));

      const result = runCli(th.tamanduaDir, th.homeDir, ["logs", "--tail", "5"]);

      assert.equal(result.error, undefined, `spawn error: ${result.error?.message}`);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout ?? "", /\(g-8\)/);
      assert.match(result.stdout ?? "", /\(g-4\)/);
      assert.doesNotMatch(result.stdout ?? "", /\(g-3\)/);
    } finally {
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("run-id --tail N prints the last N events for that run and exits 0", () => {
    const th = createTempHome("tamandua-logs-bounded-runid-");
    try {
      const runId = "run-bounded-1234";
      setupDbWithRun(th.tamanduaDir, runId, 1);
      const runFile = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
      for (let i = 1; i <= 8; i++) appendEvent(runFile, makeEvent(runId, `r-${i}`));

      const result = runCli(th.tamanduaDir, th.homeDir, ["logs", runId, "--tail", "5"]);

      assert.equal(result.error, undefined, `spawn error: ${result.error?.message}`);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout ?? "", /\(r-8\)/);
      assert.match(result.stdout ?? "", /\(r-4\)/);
      assert.doesNotMatch(result.stdout ?? "", /\(r-3\)/);
    } finally {
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("#N --tail N prints the last N events for run #N and exits 0", () => {
    const th = createTempHome("tamandua-logs-bounded-number-");
    try {
      const runId = "run-number-bounded-5678";
      setupDbWithRun(th.tamanduaDir, runId, 3);
      const runFile = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
      for (let i = 1; i <= 8; i++) appendEvent(runFile, makeEvent(runId, `n-${i}`));

      const result = runCli(th.tamanduaDir, th.homeDir, ["logs", "#3", "--tail", "5"]);

      assert.equal(result.error, undefined, `spawn error: ${result.error?.message}`);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout ?? "", /\(n-8\)/);
      assert.match(result.stdout ?? "", /\(n-4\)/);
      assert.doesNotMatch(result.stdout ?? "", /\(n-3\)/);
    } finally {
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("nonexistent-run --tail N prints not-found and exits 0 (never blocks)", () => {
    const th = createTempHome("tamandua-logs-bounded-notfound-");
    try {
      const result = runCli(th.tamanduaDir, th.homeDir, ["logs", "nonexistent-run", "--tail", "5"]);

      assert.equal(result.error, undefined, `spawn error: ${result.error?.message}`);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout ?? "", /No run found matching "nonexistent-run"/);
    } finally {
      rmSync(th.root, { recursive: true, force: true });
    }
  });
});

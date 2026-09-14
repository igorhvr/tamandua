import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

  it("getLogsHelp describes --tail as bounded and --follow/-f as the follow flag", () => {
    assert.match(getLogsHelp(), /--tail/);
    assert.match(getLogsHelp(), /Print the last N events and exit/);
    assert.match(getLogsHelp(), /--follow, -f\s+Follow events in real-time/);
  });

  it("getLogsHelp documents --follow / -f as blocking follow", () => {
    assert.match(getLogsHelp(), /--follow/);
    assert.match(getLogsHelp(), /-f/);
    assert.match(getLogsHelp(), /Follow events in real-time \(like logs-tail\)/);
    assert.match(getLogsHelp(), /streams until Ctrl-C or until the followed run ends/);
  });

  it("getLogsTailHelp states it streams until Ctrl-C or until the followed run ends", () => {
    assert.match(getLogsTailHelp(), /streams until Ctrl-C/);
    assert.match(getLogsTailHelp(), /until the followed run ends/);
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

describe("tamandua logs-tail follow auto-exit (terminal run)", () => {
  const wrapperPath = path.resolve("bin/tamandua");

  function makeEvent(runId: string, detail: string, event = "step.pending") {
    return { ts: new Date().toISOString(), event, runId, detail };
  }

  function appendEvent(filePath: string, event: unknown): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  function setupFollowDb(stateDir: string, runId: string, runNumber: number, status = "running") {
    mkdirSync(stateDir, { recursive: true });
    const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
    db.exec("PRAGMA journal_mode=WAL");
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
      VALUES (?, ?, 'logs-tail-test', 'test run', ?, '{}', ?, ?)
    `).run(runId, runNumber, status, now, now);
    return db;
  }

  function spawnFollow(stateDir: string, homeDir: string, args: string[], env: Record<string, string> = {}) {
    return spawn("/bin/sh", [wrapperPath, ...args], {
      env: cleanChildEnv({
        HOME: homeDir,
        TAMANDUA_STATE_DIR: stateDir,
        TAMANDUA_LOGS_TAIL_POLL_MS: "20",
        TAMANDUA_LOGS_TAIL_GRACE_MS: "300",
        ...env,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function waitForExit(child: ChildProcess, timeoutMs = 10000) {
    return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(`follow process did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout?.on("data", (d) => { stdout += String(d); });
        child.stderr?.on("data", (d) => { stderr += String(d); });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr });
        });
      },
    );
  }

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Resolves once `needle` appears in the child's stdout, so a test can flip
  // the run status only after the follow has already printed its initial
  // window (and thus passed the "already terminal at start" check).
  function waitForOutput(child: ChildProcess, needle: string, timeoutMs = 10000) {
    return new Promise<void>((resolve, reject) => {
      let buf = "";
      const onData = (d: Buffer) => {
        buf += String(d);
        if (buf.includes(needle)) {
          cleanup();
          resolve();
        }
      };
      const onErr = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`did not see "${needle}" in stdout within ${timeoutMs}ms: ${buf}`));
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("error", onErr);
      }
      child.stdout?.on("data", onData);
      child.on("error", onErr);
    });
  }

  it("exits 0 with closing line and flushes trailing events when run flips to completed", async () => {
    const th = createTempHome("tamandua-logs-follow-completed-");
    const runId = "run-follow-completed-1234";
    const runFile = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
    appendEvent(runFile, makeEvent(runId, "initial-1"));
    appendEvent(runFile, makeEvent(runId, "initial-2"));
    const db = setupFollowDb(th.tamanduaDir, runId, 1, "running");
    const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs-tail", runId]);
    const exitPromise = waitForExit(child, 8000);
    try {
      await waitForOutput(child, "(initial-1)");

      // Now that the follow is past the initial window, flip status and write
      // post-terminal trailing events during the grace window.
      db.prepare("UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(runId);
      await sleep(30);
      appendEvent(runFile, makeEvent(runId, "trailing-tokens", "run.tokens.updated"));
      appendEvent(runFile, makeEvent(runId, "trailing-final", "run.tokens.final"));

      const result = await exitPromise;

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /initial-1/);
      assert.match(result.stdout, /initial-2/);
      assert.match(result.stdout, /trailing-tokens/);
      assert.match(result.stdout, /trailing-final/);
      assert.match(result.stdout, new RegExp(`${runId} completed; stream closed`));
      const closingIdx = result.stdout.indexOf(`${runId} completed; stream closed`);
      const trailingIdx = result.stdout.indexOf("(trailing-final)");
      assert.ok(trailingIdx >= 0 && closingIdx > trailingIdx, "closing line must follow trailing events");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      db.close();
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  for (const status of ["failed", "canceled"]) {
    it(`exits 0 with closing line when run flips to ${status}`, async () => {
      const th = createTempHome(`tamandua-logs-follow-${status}-`);
      const runId = `run-follow-${status}-1234`;
      const runFile = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
      appendEvent(runFile, makeEvent(runId, "initial-1"));
      const db = setupFollowDb(th.tamanduaDir, runId, 1, "running");
      const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs-tail", runId]);
      const exitPromise = waitForExit(child, 8000);
      try {
        await waitForOutput(child, "(initial-1)");
        db.prepare("UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, runId);

        const result = await exitPromise;

        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /initial-1/);
        assert.match(result.stdout, new RegExp(`${runId} ${status}; stream closed`));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        db.close();
        rmSync(th.root, { recursive: true, force: true });
      }
    });
  }

  it("follow on an already-terminal run prints last N events plus closing line and exits", async () => {
    const th = createTempHome("tamandua-logs-follow-terminal-at-start-");
    const runId = "run-follow-terminal-start-1234";
    const runFile = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
    for (let i = 1; i <= 8; i++) appendEvent(runFile, makeEvent(runId, `t-${i}`));
    const db = setupFollowDb(th.tamanduaDir, runId, 1, "completed");
    const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs-tail", runId]);
    try {
      const result = await waitForExit(child, 5000);

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /\(t-8\)/);
      assert.match(result.stdout, /\(t-1\)/);
      assert.match(result.stdout, new RegExp(`${runId} completed; stream closed`));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      db.close();
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("global follow keeps streaming until SIGINT (never auto-exits)", async () => {
    const th = createTempHome("tamandua-logs-follow-global-");
    const globalFile = path.join(th.tamanduaDir, "events", "all.jsonl");
    appendEvent(globalFile, makeEvent("run-g", "g-1"));
    const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs-tail"]);
    const exitPromise = waitForExit(child, 5000);
    try {
      await waitForOutput(child, "(g-1)");

      // Several polls plus a full grace window elapse; a global follow must
      // still be alive because there is no run status to observe.
      await sleep(500);
      assert.equal(child.exitCode, null, "global follow must not auto-exit");

      child.kill("SIGINT");
      const result = await exitPromise;
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /\(g-1\)/);
      assert.doesNotMatch(result.stdout, /stream closed/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("#N selector auto-exits when the resolved run reaches a terminal status", async () => {
    const th = createTempHome("tamandua-logs-follow-number-");
    const runId = "run-follow-number-1234";
    const runFile = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
    appendEvent(runFile, makeEvent(runId, "n-1"));
    const db = setupFollowDb(th.tamanduaDir, runId, 3, "running");
    const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs-tail", "#3"]);
    const exitPromise = waitForExit(child, 8000);
    try {
      await waitForOutput(child, "(n-1)");
      db.prepare("UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(runId);

      const result = await exitPromise;

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /n-1/);
      assert.match(result.stdout, new RegExp(`${runId} completed; stream closed`));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      db.close();
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("grace derives from HARNESS_TEARDOWN_GRACE_MS (no hardcoded 10000 literal)", () => {
    const source = readFileSync(join(process.cwd(), "src/cli/commands/logs.ts"), "utf8");
    assert.match(source, /HARNESS_TEARDOWN_GRACE_MS/);
    assert.match(source, /from "\.\.\/\.\.\/installer\/agent-scheduler\.js"/);
    assert.doesNotMatch(source, /\b10000\b/);
    assert.doesNotMatch(source, /\b10_000\b/);
  });
});

describe("tamandua logs --follow / -f alias (logs-tail parity)", () => {
  const wrapperPath = path.resolve("bin/tamandua");

  function makeEvent(runId: string, detail: string, event = "step.pending") {
    return { ts: new Date().toISOString(), event, runId, detail };
  }

  function appendEvent(filePath: string, event: unknown): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  function setupFollowDb(stateDir: string, runId: string, runNumber: number, status = "running") {
    mkdirSync(stateDir, { recursive: true });
    const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
    db.exec("PRAGMA journal_mode=WAL");
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
      VALUES (?, ?, 'logs-tail-test', 'test run', ?, '{}', ?, ?)
    `).run(runId, runNumber, status, now, now);
    return db;
  }

  function spawnFollow(stateDir: string, homeDir: string, args: string[], env: Record<string, string> = {}) {
    return spawn("/bin/sh", [wrapperPath, ...args], {
      env: cleanChildEnv({
        HOME: homeDir,
        TAMANDUA_STATE_DIR: stateDir,
        TAMANDUA_LOGS_TAIL_POLL_MS: "20",
        TAMANDUA_LOGS_TAIL_GRACE_MS: "300",
        ...env,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function waitForExit(child: ChildProcess, timeoutMs = 10000) {
    return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(`process did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout?.on("data", (d) => { stdout += String(d); });
        child.stderr?.on("data", (d) => { stderr += String(d); });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr });
        });
      },
    );
  }

  function waitForOutput(child: ChildProcess, needle: string, timeoutMs = 10000) {
    return new Promise<void>((resolve, reject) => {
      let buf = "";
      const onData = (d: Buffer) => {
        buf += String(d);
        if (buf.includes(needle)) {
          cleanup();
          resolve();
        }
      };
      const onErr = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`did not see "${needle}" in stdout within ${timeoutMs}ms: ${buf}`));
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("error", onErr);
      }
      child.stdout?.on("data", onData);
      child.on("error", onErr);
    });
  }

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  it("logs --follow follows global events (blocks until SIGINT, no stream-closed line)", async () => {
    const th = createTempHome("tamandua-logs-follow-alias-global-");
    const globalFile = path.join(th.tamanduaDir, "events", "all.jsonl");
    appendEvent(globalFile, makeEvent("run-g", "g-1"));
    const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs", "--follow"]);
    const exitPromise = waitForExit(child, 5000);
    try {
      await waitForOutput(child, "(g-1)");

      // Several polls plus a full grace window elapse; a global follow has no
      // run status to observe and must still be alive.
      await sleep(500);
      assert.equal(child.exitCode, null, "global follow must not auto-exit");

      child.kill("SIGINT");
      const result = await exitPromise;
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /\(g-1\)/);
      assert.doesNotMatch(result.stdout, /stream closed/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("logs -f behaves identically to logs --follow", async () => {
    const th = createTempHome("tamandua-logs-follow-alias-f-");
    const globalFile = path.join(th.tamanduaDir, "events", "all.jsonl");
    appendEvent(globalFile, makeEvent("run-g", "g-1"));
    const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs", "-f"]);
    const exitPromise = waitForExit(child, 5000);
    try {
      await waitForOutput(child, "(g-1)");

      await sleep(500);
      assert.equal(child.exitCode, null, "logs -f must follow (not exit)");

      child.kill("SIGINT");
      const result = await exitPromise;
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /\(g-1\)/);
      assert.doesNotMatch(result.stdout, /stream closed/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("logs --follow --tail N uses N as the initial window", async () => {
    const th = createTempHome("tamandua-logs-follow-alias-tailwin-");
    const globalFile = path.join(th.tamanduaDir, "events", "all.jsonl");
    for (let i = 1; i <= 8; i++) appendEvent(globalFile, makeEvent("run-g", `g-${i}`));
    const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs", "--follow", "--tail", "2"]);
    const exitPromise = waitForExit(child, 5000);
    try {
      // Collect the streamed stdout so we can inspect the initial window
      // before the follow writes anything further.
      let stdout = "";
      child.stdout?.on("data", (d) => { stdout += String(d); });

      for (let i = 0; i < 200 && !stdout.includes("(g-8)"); i++) await sleep(10);
      assert.ok(stdout.includes("(g-8)"), `expected initial window, got: ${stdout}`);
      assert.match(stdout, /\(g-7\)/);
      assert.doesNotMatch(stdout, /\(g-6\)/);

      child.kill("SIGINT");
      const result = await exitPromise;
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(th.root, { recursive: true, force: true });
    }
  });

  it("logs <run-id> --follow auto-exits when the run reaches a terminal status", async () => {
    const th = createTempHome("tamandua-logs-follow-alias-runid-");
    const runId = "run-follow-alias-1234";
    const runFile = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
    appendEvent(runFile, makeEvent(runId, "initial-1"));
    const db = setupFollowDb(th.tamanduaDir, runId, 1, "running");
    const child = spawnFollow(th.tamanduaDir, th.homeDir, ["logs", runId, "--follow"]);
    const exitPromise = waitForExit(child, 8000);
    try {
      await waitForOutput(child, "(initial-1)");
      db.prepare("UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(runId);

      const result = await exitPromise;

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /initial-1/);
      assert.match(result.stdout, new RegExp(`${runId} completed; stream closed`));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      db.close();
      rmSync(th.root, { recursive: true, force: true });
    }
  });
});

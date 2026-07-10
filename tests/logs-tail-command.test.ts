import fs from "node:fs";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

function makeEvent(runId: string, detail: string, event = "step.pending") {
  return {
    ts: new Date().toISOString(),
    event,
    runId,
    detail,
  };
}

function appendEvent(filePath: string, event: ReturnType<typeof makeEvent>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
}

function createTempEnv() {
  const th = createTempHome("tamandua-logs-tail-");
  const root = th.root;
  const stateDir = path.join(root, "state");
  const homeDir = th.homeDir;
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, homeDir };
}

function spawnCli(args: string[], env: Record<string, string>): {
  child: ChildProcessWithoutNullStreams;
  getStdout: () => string;
  getStderr: () => string;
} {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: cleanChildEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function waitForContains(getter: () => string, text: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (getter().includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for output to include: ${text}`);
}

async function stopWithSigint(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGINT");
  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return code;
}

async function runCliOnce(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { child, getStdout, getStderr } = spawnCli(args, env);
  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, stdout: getStdout(), stderr: getStderr() };
}

function countOccurrences(haystack: string, needle: string): number {
  return (haystack.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
}

describe("tamandua logs-tail", () => {
  it("prints an initial global batch, follows appended events, and exits cleanly on Ctrl+C", async () => {
    const env = createTempEnv();
    const globalFile = path.join(env.stateDir, "events", "all.jsonl");
    const runId = "run-global";

    appendEvent(globalFile, makeEvent(runId, "init-1"));
    appendEvent(globalFile, makeEvent(runId, "init-2"));
    appendEvent(globalFile, makeEvent(runId, "init-3"));

    const proc = spawnCli(["logs-tail", "2"], {
      TAMANDUA_STATE_DIR: env.stateDir,
      HOME: env.homeDir,
      TAMANDUA_LOGS_TAIL_POLL_MS: "25",
    });

    try {
      await waitForContains(proc.getStdout, "(init-2)");
      await waitForContains(proc.getStdout, "(init-3)");
      assert.equal(proc.getStdout().includes("(init-1)"), false, "initial limit should hide older events");

      appendEvent(globalFile, makeEvent(runId, "init-4"));
      await waitForContains(proc.getStdout, "(init-4)");

      const output = proc.getStdout();
      assert.equal(countOccurrences(output, "(init-2)"), 1, "should not duplicate initial events");
      assert.equal(countOccurrences(output, "(init-3)"), 1, "should not duplicate initial events");
      assert.equal(countOccurrences(output, "(init-4)"), 1, "should stream each new event once");

      const code = await stopWithSigint(proc.child);
      assert.equal(code, 0);
      assert.equal(proc.getStderr().includes("Error:"), false, "should exit without stack traces");
    } finally {
      if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("supports run-id streams", async () => {
    const env = createTempEnv();
    const runId = "run-abc";
    const runFile = path.join(env.stateDir, "events", `${runId}.jsonl`);

    // prefix expansion now routes through getWorkflowStatus, which needs a DB entry
    const dbDir = env.stateDir;
    const dbPath = path.join(dbDir, "tamandua.db");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
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
      VALUES (?, 1, 'logs-tail-test', 'test run', 'running', '{}', ?, ?)
    `).run(runId, now, now);
    db.close();

    appendEvent(runFile, makeEvent(runId, "run-old"));

    const proc = spawnCli(["logs-tail", runId], {
      TAMANDUA_STATE_DIR: env.stateDir,
      HOME: env.homeDir,
      TAMANDUA_LOGS_TAIL_POLL_MS: "25",
    });

    try {
      await waitForContains(proc.getStdout, "(run-old)");

      appendEvent(runFile, makeEvent(runId, "run-new"));
      await waitForContains(proc.getStdout, "(run-new)");

      const code = await stopWithSigint(proc.child);
      assert.equal(code, 0);
    } finally {
      if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("supports #<run-number> streams", async () => {
    const env = createTempEnv();
    const runId = "run-number-target";
    const dbDir = env.stateDir;
    const dbPath = path.join(dbDir, "tamandua.db");
    fs.mkdirSync(dbDir, { recursive: true });

    const db = new DatabaseSync(dbPath);
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
      VALUES (?, ?, 'feature-dev', 'test run', 'running', '{}', ?, ?)
    `).run(runId, 7, now, now);
    db.close();

    const runFile = path.join(env.stateDir, "events", `${runId}.jsonl`);
    appendEvent(runFile, makeEvent(runId, "num-old"));

    const proc = spawnCli(["logs-tail", "#7"], {
      TAMANDUA_STATE_DIR: env.stateDir,
      HOME: env.homeDir,
      TAMANDUA_LOGS_TAIL_POLL_MS: "25",
    });

    try {
      await waitForContains(proc.getStdout, "(num-old)");

      appendEvent(runFile, makeEvent(runId, "num-new"));
      await waitForContains(proc.getStdout, "(num-new)");

      const code = await stopWithSigint(proc.child);
      assert.equal(code, 0);
    } finally {
      if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("shows logs-tail selector syntax in CLI usage", async () => {
    const env = createTempEnv();
    try {
      const result = await runCliOnce([], {
        TAMANDUA_STATE_DIR: env.stateDir,
        HOME: env.homeDir,
      });

      assert.equal(result.code, 1);
      assert.ok(
        result.stdout.includes("tamandua logs-tail [<lines>|<run-id>|#<run-number>]"),
        "usage should list logs-tail selector syntax",
      );
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });
});

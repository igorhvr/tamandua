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
  const th = createTempHome("tamandua-logs-prefix-");
  const root = th.root;
  const stateDir = path.join(root, "state");
  const homeDir = th.homeDir;
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, homeDir };
}

function setupDbWithRun(stateDir: string, runId: string, runNumber: number): void {
  const dbDir = stateDir;
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
    VALUES (?, ?, 'test-workflow', 'test task', 'running', '{}', ?, ?)
  `).run(runId, runNumber, now, now);
  db.close();
}

async function runCliOnce(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: cleanChildEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
}

async function waitForContains(
  child: ChildProcessWithoutNullStreams,
  getStdout: () => string,
  text: string,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (getStdout().includes(text)) return;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for output to include: ${text}`);
}

describe("tamandua logs prefix expansion", () => {
  it("should resolve an 8-char short prefix to the full UUID and print events", async () => {
    const env = createTempEnv();
    const fullRunId = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001";
    const shortPrefix = fullRunId.slice(0, 8); // "aaaaaaaa"

    setupDbWithRun(env.stateDir, fullRunId, 42);

    const runFile = path.join(env.stateDir, "events", `${fullRunId}.jsonl`);
    appendEvent(runFile, makeEvent(fullRunId, "first-event"));
    appendEvent(runFile, makeEvent(fullRunId, "second-event"));

    try {
      const result = await runCliOnce(["logs", shortPrefix], {
        TAMANDUA_STATE_DIR: env.stateDir,
        HOME: env.homeDir,
      });

      assert.equal(result.code, 0);
      assert.ok(
        result.stdout.includes("(first-event)"),
        `Expected output to contain "(first-event)" but got: ${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("(second-event)"),
        `Expected output to contain "(second-event)" but got: ${result.stdout}`,
      );
      assert.ok(
        !result.stdout.includes("No events for run"),
        `Should not show "No events" message but got: ${result.stdout}`,
      );
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should return a clear error for a prefix that matches no run", async () => {
    const env = createTempEnv();

    try {
      const result = await runCliOnce(["logs", "zzzzzzzz"], {
        TAMANDUA_STATE_DIR: env.stateDir,
        HOME: env.homeDir,
      });

      assert.equal(result.code, 0);
      assert.ok(
        !result.stdout.includes("No events for run"),
        `Should not show misleading "No events" for unknown prefix, got: ${result.stdout}`,
      );
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should resolve a short prefix in logs-tail and stream events", async () => {
    const env = createTempEnv();
    const fullRunId = "bbbbbbbb-1111-2222-3333-444455556666";
    const shortPrefix = fullRunId.slice(0, 8); // "bbbbbbbb"

    setupDbWithRun(env.stateDir, fullRunId, 99);

    const runFile = path.join(env.stateDir, "events", `${fullRunId}.jsonl`);
    appendEvent(runFile, makeEvent(fullRunId, "tail-first"));

    const child = spawn(process.execPath, [cliPath, "logs-tail", shortPrefix], {
      env: cleanChildEnv({ TAMANDUA_STATE_DIR: env.stateDir,
        HOME: env.homeDir,
        TAMANDUA_LOGS_TAIL_POLL_MS: "25", }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });

    try {
      await waitForContains(child, () => stdout, "(tail-first)");

      appendEvent(runFile, makeEvent(fullRunId, "tail-second"));
      await waitForContains(child, () => stdout, "(tail-second)");

      assert.ok(
        !stdout.includes("No run found"),
        `Should not show error for valid prefix, got: ${stdout}`,
      );

      child.kill("SIGINT");
      const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
      assert.equal(code, 0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should still work with a full UUID (no regression)", async () => {
    const env = createTempEnv();
    const fullRunId = "cccccccc-dddd-eeee-ffff-111122223333";

    setupDbWithRun(env.stateDir, fullRunId, 7);

    const runFile = path.join(env.stateDir, "events", `${fullRunId}.jsonl`);
    appendEvent(runFile, makeEvent(fullRunId, "full-uuid-event"));

    try {
      const result = await runCliOnce(["logs", fullRunId], {
        TAMANDUA_STATE_DIR: env.stateDir,
        HOME: env.homeDir,
      });

      assert.equal(result.code, 0);
      assert.ok(
        result.stdout.includes("(full-uuid-event)"),
        `Expected output to contain event, got: ${result.stdout}`,
      );
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should show an error for logs-tail with unknown prefix", async () => {
    const env = createTempEnv();

    try {
      const result = await runCliOnce(["logs-tail", "zzzzzzzz"], {
        TAMANDUA_STATE_DIR: env.stateDir,
        HOME: env.homeDir,
      });

      assert.equal(result.code, 0);
      assert.ok(
        !result.stdout.includes("No events yet."),
        `Should not show "No events yet." for unknown prefix, got: ${result.stdout}`,
      );
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });
});

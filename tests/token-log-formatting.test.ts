import fs from "node:fs";
import { cleanChildEnv } from "./helpers/test-env.ts";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

function appendEvent(filePath: string, event: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
}

function createTempEnv() {
  const root = tamanduaTempDir("tamandua-token-log-format-");
  const stateDir = path.join(root, "state");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
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

async function runCliOnce(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { child, getStdout, getStderr } = spawnCli(args, env);
  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, stdout: getStdout(), stderr: getStderr() };
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

describe("token spend event formatting", () => {
  it("includes token spend details in tamandua logs output", async () => {
    const env = createTempEnv();
    const runId = "run-token-logs";
    const globalFile = path.join(env.stateDir, "events", "all.jsonl");

    try {
      appendEvent(globalFile, {
        ts: new Date().toISOString(),
        event: "run.started",
        runId,
        detail: "Run #9: Track token logs",
      });
      appendEvent(globalFile, {
        ts: new Date().toISOString(),
        event: "run.tokens.updated",
        runId,
        tokenDelta: 80,
        tokensSpent: 80,
      });
      appendEvent(globalFile, {
        ts: new Date().toISOString(),
        event: "run.completed",
        runId,
        tokensSpent: 80,
      });

      const result = await runCliOnce(["logs", "20"], {
        TAMANDUA_STATE_DIR: env.stateDir,
        HOME: env.homeDir,
      });

      assert.equal(result.code, 0);
      assert.equal(result.stderr.includes("Error:"), false);
      assert.match(result.stdout, /Token spend updated/);
      assert.match(result.stdout, /\[tokens: Δ \+80, total 80\]/);
      assert.match(result.stdout, /Run completed.*\[tokens: total 80\]/);
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("renders token spend in logs-tail without changing existing labels", async () => {
    const env = createTempEnv();
    const runId = "run-token-tail";
    const runFile = path.join(env.stateDir, "events", `${runId}.jsonl`);

    appendEvent(runFile, {
      ts: new Date().toISOString(),
      event: "step.pending",
      runId,
      detail: "queued",
    });

    const proc = spawnCli(["logs-tail", runId], {
      TAMANDUA_STATE_DIR: env.stateDir,
      HOME: env.homeDir,
      TAMANDUA_LOGS_TAIL_POLL_MS: "25",
    });

    try {
      await waitForContains(proc.getStdout, "Step pending");
      await waitForContains(proc.getStdout, "(queued)");

      appendEvent(runFile, {
        ts: new Date().toISOString(),
        event: "run.tokens.updated",
        runId,
        tokenDelta: 25,
        tokensSpent: 125,
      });
      await waitForContains(proc.getStdout, "Token spend updated");
      await waitForContains(proc.getStdout, "[tokens: Δ +25, total 125]");

      appendEvent(runFile, {
        ts: new Date().toISOString(),
        event: "run.completed",
        runId,
        tokensSpent: 125,
      });
      await waitForContains(proc.getStdout, "Run completed");
      await waitForContains(proc.getStdout, "[tokens: total 125]");

      const code = await stopWithSigint(proc.child);
      assert.equal(code, 0);
      assert.equal(proc.getStderr().includes("Error:"), false, "should exit cleanly");
    } finally {
      if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });
});

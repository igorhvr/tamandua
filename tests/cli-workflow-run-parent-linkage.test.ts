import fs from "node:fs";
import {
  cleanChildEnv,
  reservePortHandles,
  stopPidfileServiceAndWait,
} from "./helpers/test-env.ts";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { stopDaemon } from "../dist/server/daemonctl.js";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

async function createTempEnv() {
  const handles = await reservePortHandles(2);
  const controlPort = handles[0].port;
  const dashboardPort = handles[1].port;
  const root = tamanduaTempDir("tamandua-cli-run-parent-");
  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(path.join(tamanduaDir, "port"), String(dashboardPort), "utf-8");
  return { root, homeDir, tamanduaDir, controlPort, dashboardPort, portHandles: handles };
}

function writeMinimalWorkflow(homeDir: string, workflowId: string): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    [
      `id: ${workflowId}`,
      "agents:",
      "  - id: dev",
      "    model: fake",
      "    workspace:",
      "      baseDir: .",
      "steps:",
      "  - id: implement",
      "    agent: dev",
      "    input: Implement the task",
      "    expects: STATUS, CHANGES, TESTS",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function runCliUntilOutput(
  args: string[],
  env: Record<string, string>,
  pattern: RegExp,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20000);

    const maybeFinish = (code: number | null) => {
      if (finished) return;
      if (pattern.test(stdout)) {
        finished = true;
        clearTimeout(timeout);
        // workflow run may keep process alive due polling timers; stop once output is observed
        if (!child.killed) {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        }
        resolve({ stdout, stderr, code });
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      maybeFinish(null);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

function readRunEvents(tamanduaDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsFile = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  const content = fs.readFileSync(eventsFile, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("CLI workflow run parent linkage (TATR US-009)", () => {
  it("derives parent_run_id from TAMANDUA_RUN_ID env and carries parentRunId on run.started", async () => {
    const env = await createTempEnv();

    try {
      const workflowId = "cli-run-parent";
      writeMinimalWorkflow(env.homeDir, workflowId);

      const harnessDir = path.join(env.root, "parent-workdir");
      fs.mkdirSync(harnessDir, { recursive: true });

      const parentRunId = "run-parent-0000-0000-0000-000000000000";

      await Promise.all(env.portHandles.map((h) => h.close()));
      const { stdout } = await runCliUntilOutput(
        [
          "workflow",
          "run",
          workflowId,
          "Validate parent linkage",
          "--working-directory-for-harness",
          harnessDir,
        ],
        {
          HOME: env.homeDir,
          TAMANDUA_CONTROL_PORT: String(env.controlPort),
          TAMANDUA_RUN_ID: parentRunId,
        },
        /Run: run-/i,
      );
      assert.match(stdout, /Run: run-/i, `expected run output, got: ${stdout}`);

      // The run row must record the parent.
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db
        .prepare("SELECT id, parent_run_id FROM runs ORDER BY created_at DESC LIMIT 1")
        .get() as { id: string; parent_run_id: string | null } | undefined;
      db.close();

      assert.ok(row, "expected a run row in DB");
      assert.equal(row!.parent_run_id, parentRunId, "parent_run_id should equal TAMANDUA_RUN_ID");

      // run.started must carry parentRunId.
      const events = readRunEvents(env.tamanduaDir, row!.id);
      const started = events.find((e) => e.event === "run.started");
      assert.ok(started, "run.started should be emitted");
      assert.equal(started!.parentRunId, parentRunId, "run.started should carry parentRunId");
    } finally {
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({ pidFile: path.join(env.tamanduaDir, "tamandua.pid"), stop: stopDaemon, label: "daemon", homeDir: env.homeDir });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  it("leaves parent_run_id NULL and omits parentRunId from run.started without TAMANDUA_RUN_ID", async () => {
    const env = await createTempEnv();

    try {
      const workflowId = "cli-run-orphan";
      writeMinimalWorkflow(env.homeDir, workflowId);

      const harnessDir = path.join(env.root, "orphan-workdir");
      fs.mkdirSync(harnessDir, { recursive: true });

      await Promise.all(env.portHandles.map((h) => h.close()));
      const { stdout } = await runCliUntilOutput(
        [
          "workflow",
          "run",
          workflowId,
          "Validate parentless run",
          "--working-directory-for-harness",
          harnessDir,
        ],
        {
          HOME: env.homeDir,
          TAMANDUA_CONTROL_PORT: String(env.controlPort),
        },
        /Run: run-/i,
      );
      assert.match(stdout, /Run: run-/i, `expected run output, got: ${stdout}`);

      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db
        .prepare("SELECT id, parent_run_id FROM runs ORDER BY created_at DESC LIMIT 1")
        .get() as { id: string; parent_run_id: string | null } | undefined;
      db.close();

      assert.ok(row, "expected a run row in DB");
      assert.equal(row!.parent_run_id, null, "parent_run_id should be NULL without TAMANDUA_RUN_ID");

      const events = readRunEvents(env.tamanduaDir, row!.id);
      const started = events.find((e) => e.event === "run.started");
      assert.ok(started, "run.started should be emitted");
      assert.ok(
        !("parentRunId" in started!),
        "run.started must not carry parentRunId for parentless runs",
      );
    } finally {
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({ pidFile: path.join(env.tamanduaDir, "tamandua.pid"), stop: stopDaemon, label: "daemon", homeDir: env.homeDir });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });
});

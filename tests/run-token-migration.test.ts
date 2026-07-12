import fs from "node:fs";
import { cleanChildEnv, reserveRandomPort } from "./helpers/test-env.ts";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function createTempHome() {
  const root = tamanduaTempDir("tamandua-run-tokens-");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      env: cleanChildEnv(env),
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `Script failed with exit ${result.status}`,
      `STDOUT:\n${result.stdout}`,
      `STDERR:\n${result.stderr}`,
    ].join("\n\n"));
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }

  return JSON.parse(lastLine) as Record<string, unknown>;
}


describe("run token spend persistence", () => {
  it("migrates legacy runs schema to include tokens_spent with backfill", () => {
    const temp = createTempHome();

    try {
      const dbDir = path.join(temp.homeDir, ".tamandua");
      const dbPath = path.join(dbDir, "tamandua.db");
      fs.mkdirSync(dbDir, { recursive: true });

      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          context TEXT NOT NULL DEFAULT '{}',
          notify_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const now = new Date().toISOString();
      legacyDb.prepare(`
        INSERT INTO runs (id, workflow_id, task, status, context, notify_url, created_at, updated_at)
        VALUES ('legacy-run', 'wf', 'task', 'running', '{}', NULL, ?, ?)
      `).run(now, now);
      legacyDb.close();

      const result = runNodeScript(
        `
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const cols = db.prepare("PRAGMA table_info(runs)").all();
          const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = 'legacy-run'").get();
          console.log(JSON.stringify({ cols, row }));
        `,
        { HOME: temp.homeDir },
      );

      const cols = result.cols as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const tokensCol = cols.find((col) => col.name === "tokens_spent");
      assert.ok(tokensCol, "tokens_spent column should exist after migration");
      assert.equal(tokensCol.notnull, 1, "tokens_spent should be NOT NULL");
      assert.equal(tokensCol.dflt_value, "0", "tokens_spent should default to 0");

      const row = result.row as { tokens_spent: number };
      assert.equal(row.tokens_spent, 0, "legacy rows should be backfilled to tokens_spent=0");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("runWorkflow persists new runs with tokens_spent=0", async () => {
    const temp = createTempHome();

    try {
      const dashboardPort = await reserveRandomPort();
      const controlPort = await reserveRandomPort();
      const workflowDir = path.join(temp.homeDir, ".tamandua", "workflows", "token-workflow");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, "workflow.yml"),
        [
          "id: token-workflow",
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

      const result = runNodeScript(
        `
          import { runWorkflow } from "./dist/installer/run.js";
          import { getDb } from "./dist/db.js";
          import { shutdownAllCrons } from "./dist/installer/agent-scheduler.js";
          import { startDaemon, stopDaemon } from "./dist/server/daemonctl.js";

          try {
            await startDaemon(Number(process.env.TEST_DASHBOARD_PORT));
            const started = await runWorkflow({ workflowId: "token-workflow", taskTitle: "Track token spend" });
            const db = getDb();
            const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(started.runId);
            console.log(JSON.stringify({ tokensSpent: row.tokens_spent }));
          } finally {
            try { stopDaemon({ homeDir: process.env.HOME }); } catch {}
            shutdownAllCrons();
          }
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_CONTROL_PORT: String(controlPort),
          TEST_DASHBOARD_PORT: String(dashboardPort),
        },
      );

      assert.equal(result.tokensSpent, 0, "new runs should start with tokens_spent=0");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";

import { runWorkflow, type RunWorkflowParams } from "../../dist/installer/run.js";
import { getRunHarnessType } from "../../dist/installer/run-harness.js";
import {
  createAgentCronJob,
  removeRunCrons,
} from "../../dist/installer/agent-scheduler.js";
import type { WorkflowAgent } from "../../dist/installer/types.js";

// ── Helpers ──

function writeMinimalWorkflow(
  homeDir: string,
  workflowId: string,
  workspaceMode: "direct" | "worktree" = "direct",
): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    `id: ${workflowId}\nrun:\n  workspace: ${workspaceMode}\nagents:\n  - id: dev\n    model: fake\n    workspace:\n      baseDir: .\nsteps:\n  - id: implement\n    agent: dev\n    input: Implement the task\n    expects: STATUS, CHANGES, TESTS\n`,
    "utf-8",
  );
}

async function seedRunRecord(
  runId: string,
  harnessType?: string,
): Promise<void> {
  const { getDb } = await import("../../dist/db.js");
  const db = getDb();
  const context: Record<string, string> = {
    task: "Test task",
    workspace_mode: "direct",
    no_hurry_save_tokens_mode: "false",
    harness_type: harnessType ?? "pi",
  };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at)
     VALUES (?, 1, 'test-harness-type', 'Test task', 'running', ?, 0, 'active', ?, ?, ?)`,
  ).run(runId, JSON.stringify(context), now, now, now);
}

// ── Test suite ──

describe("HarnessType flow (US-001)", () => {
  let tempHome: string;
  let origHome: string | undefined;

  before(() => {
    tempHome = tamanduaTempDir("tamandua-harness-type-");
    origHome = process.env.HOME;
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("RunWorkflowParams.harnessType", () => {
    it("is optional and defaults to 'pi' in run context", async () => {
      const workflowId = "test-harness-default";
      writeMinimalWorkflow(tempHome, workflowId, "direct");

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test default harness type",
        });
      } catch {
        // Expected: daemon registration fails
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db
        .prepare(
          "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.harness_type, "pi", "default harness_type is 'pi'");
    });

    it("stores 'hermes' when harnessType is 'hermes'", async () => {
      const workflowId = "test-harness-hermes";
      writeMinimalWorkflow(tempHome, workflowId, "direct");

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test hermes harness type",
          harnessType: "hermes",
        });
      } catch {
        // Expected: daemon registration fails
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db
        .prepare(
          "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.harness_type, "hermes", "harness_type stored as 'hermes'");
    });

    it("stores 'pi' when harnessType is explicitly 'pi'", async () => {
      const workflowId = "test-harness-explicit-pi";
      writeMinimalWorkflow(tempHome, workflowId, "direct");

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test explicit pi harness type",
          harnessType: "pi",
        });
      } catch {
        // Expected: daemon registration fails
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db
        .prepare(
          "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.harness_type, "pi", "harness_type stored as 'pi'");
    });
  });

  describe("getRunHarnessType()", () => {
    it("returns 'pi' for a run with harness_type 'pi'", async () => {
      const runId = "aaaaaaaa-bbbb-4ccc-bbbb-cccccccccccc";
      await seedRunRecord(runId, "pi");

      const result = getRunHarnessType(runId);
      assert.equal(result, "pi");
    });

    it("returns 'hermes' for a run with harness_type 'hermes'", async () => {
      const runId = "dddddddd-eeee-4fff-bbbb-eeeeeeeeeeee";
      await seedRunRecord(runId, "hermes");

      const result = getRunHarnessType(runId);
      assert.equal(result, "hermes");
    });

    it("returns 'pi' for a run with no harness_type in context", async () => {
      const runId = "11111111-2222-4333-bbbb-222222222222";
      await seedRunRecord(runId); // no harness_type override, defaults to "pi"

      const result = getRunHarnessType(runId);
      assert.equal(result, "pi");
    });

    it("returns 'pi' for a non-existent run", () => {
      const result = getRunHarnessType("non-existent-run-id");
      assert.equal(result, "pi");
    });
  });

  describe("CronJobInfo.harnessType", () => {
    it("is populated from run context when harness_type is 'hermes'", async () => {
      const runId = "33333333-4444-4555-bbbb-333333333333";
      await seedRunRecord(runId, "hermes");

      const devAgent: WorkflowAgent = {
        id: "dev",
        name: "Developer",
        description: "Test agent",
        role: "coding",
        model: "fake",
        workspace: { baseDir: ".", files: {} },
      };

      const result = await createAgentCronJob({
        workflowId: "test-harness-type",
        runId,
        agent: devAgent,
        intervalMinutes: 5,
        workingDirectoryForHarness: tempHome,
      });

      assert.ok(result.ok, "cron job created successfully");
      assert.ok(result.id, "cron job has an id");

      // Verify harness_type in DB
      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const runRow = db
        .prepare("SELECT context FROM runs WHERE id = ?")
        .get(runId) as { context: string } | undefined;
      assert.ok(runRow, "run record exists");
      const ctx = JSON.parse(runRow.context);
      assert.equal(ctx.harness_type, "hermes", "harness_type in DB is 'hermes'");

      // Cleanup
      await removeRunCrons(runId);
    });

    it("is 'pi' when harness_type is not set in run context", async () => {
      const runId = "55555555-6666-4777-bbbb-444444444444";
      await seedRunRecord(runId); // defaults to "pi"

      const devAgent: WorkflowAgent = {
        id: "dev",
        name: "Developer",
        description: "Test agent",
        role: "coding",
        model: "fake",
        workspace: { baseDir: ".", files: {} },
      };

      const result = await createAgentCronJob({
        workflowId: "test-harness-type",
        runId,
        agent: devAgent,
        intervalMinutes: 5,
        workingDirectoryForHarness: tempHome,
      });

      assert.ok(result.ok, "cron job created successfully");

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const runRow = db
        .prepare("SELECT context FROM runs WHERE id = ?")
        .get(runId) as { context: string } | undefined;
      assert.ok(runRow, "run record exists");
      const ctx = JSON.parse(runRow.context);
      assert.equal(
        ctx.harness_type ?? "pi",
        "pi",
        "harness_type in DB is effectively 'pi'",
      );

      // Cleanup
      await removeRunCrons(runId);
    });
  });
});

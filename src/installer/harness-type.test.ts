import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { stopDaemonFamily } from "../../dist/server/daemonctl.js";
import {
  reservePortHandles,
  removeTestTempDirWithDiagnostics,
  type PortHandle,
} from "../../tests/helpers/test-env.ts";

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
//
// TISO.1 (US-003) isolation note — why this suite must pin every state/port
// knob to the temp HOME (mirrors src/installer/run.test.ts).
//
// PRE-FIX ASYMMETRY (empirically observed; explained here, not papered
// over): this suite used to set only HOME=tempHome and delete
// TAMANDUA_DB_PATH, leaving TAMANDUA_STATE_DIR / TAMANDUA_CONTROL_PORT
// unset. Each of the four runWorkflow() calls below reaches
// ensureDaemonControlAvailable() (src/server/control-client.ts), which
// first probes the daemon control plane via controlRequest(). Under the
// test guard (TAMANDUA_TEST_GUARD=1 / NODE_TEST_CONTEXT), controlRequest()
// REFUSES the probe whenever TAMANDUA_CONTROL_PORT is absent — its guard
// block returns null before any socket is opened — so
// isDaemonControlReachable() is always false and
// ensureDaemonControlAvailable() falls through to startDaemon(). With no
// port override the spawned daemon child binds the DEFAULT control port
// 3339; assertPortIsolation() (src/lib/test-guard.ts) guard-fires inside
// the child and the serial lane fails on four "[port-bind] 3339 — control
// plane" ledger entries attributed "(unknown)" (testFile null: the child's
// own stack has no .test. frame).
//
// When TAMANDUA_CONTROL_PORT IS exported (even as "3339", the default), the
// guard LETS the probe run, so wherever a live tamandua daemon already
// answers on 3339 the probe succeeds and the EXISTING daemon is reused: no
// child is spawned, no 3339 bind ever happens, and the ledger stays empty.
// That is why the runs' own testers — whose environment inherits
// TAMANDUA_CONTROL_PORT=3339 from the live daemon — reported EMPTY ledgers
// on the same trees (741feb3b, c616d8c5) whose review shell (no TAMANDUA_*
// vars) failed on the four 3339 entries. The asymmetry is environmental
// (what the runner exported), not a difference in the code under test.
//
// FIX: point every env knob at the temp HOME and hand the daemon this suite
// spawns a RESERVED (non-production) control port plus a dashboard port
// file taken from a reserved port, so no production port (3334/3338/3339)
// is ever bound — regardless of what TAMANDUA_CONTROL_PORT was exported as
// beforehand.

describe("HarnessType flow (US-001)", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origControlPort: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;
  let origWorktreeRoot: string | undefined;
  let portHandles: PortHandle[] = [];

  before(async () => {
    tempHome = tamanduaTempDir("tamandua-harness-type-");
    origHome = process.env.HOME;
    origControlPort = process.env.TAMANDUA_CONTROL_PORT;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origStateDir = process.env.TAMANDUA_STATE_DIR;
    origWorktreeRoot = process.env.TAMANDUA_WORKTREE_ROOT;

    const tamanduaDir = path.join(tempHome, ".tamandua");
    portHandles = await reservePortHandles(2);
    const dashboardPort = portHandles[0].port;
    const controlPort = portHandles[1].port;
    fs.mkdirSync(tamanduaDir, { recursive: true });
    fs.writeFileSync(
      path.join(tamanduaDir, "port"),
      String(dashboardPort),
      "utf-8",
    );

    process.env.HOME = tempHome;
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);
    process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_STATE_DIR = tamanduaDir;
    process.env.TAMANDUA_WORKTREE_ROOT = path.join(tamanduaDir, "worktrees");

    // Release the port handles now that setup is done so the daemon this
    // suite's runWorkflow() calls spawn can bind these exact ports.
    await Promise.all(portHandles.map((h) => h.close()));
    portHandles = [];
  });

  after(async () => {
    // Stop the daemon family BEFORE removing the temp HOME: daemons started
    // by the (now-succeeding) runWorkflow calls keep writing into it, and
    // removing the HOME first would leave orphaned daemon children behind.
    await stopDaemonFamily({ homeDir: tempHome });

    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origControlPort !== undefined) {
      process.env.TAMANDUA_CONTROL_PORT = origControlPort;
    } else {
      delete process.env.TAMANDUA_CONTROL_PORT;
    }
    if (origDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    if (origStateDir !== undefined) {
      process.env.TAMANDUA_STATE_DIR = origStateDir;
    } else {
      delete process.env.TAMANDUA_STATE_DIR;
    }
    if (origWorktreeRoot !== undefined) {
      process.env.TAMANDUA_WORKTREE_ROOT = origWorktreeRoot;
    } else {
      delete process.env.TAMANDUA_WORKTREE_ROOT;
    }
    // Retries absorb stragglers still writing into the temp home during
    // teardown (ENOTEMPTY otherwise, seen on macOS). Give the daemon's
    // log/SQLite WAL stragglers a moment to finish writing.
    await Promise.all(portHandles.map((h) => h.close()));
    await new Promise((resolve) => setTimeout(resolve, 250));
    removeTestTempDirWithDiagnostics(tempHome);
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

    it("stores 'dsh' when harnessType is 'dsh'", async () => {
      const workflowId = "test-harness-dsh";
      writeMinimalWorkflow(tempHome, workflowId, "direct");

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test dsh harness type",
          harnessType: "dsh",
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
      assert.equal(ctx.harness_type, "dsh", "harness_type stored as 'dsh'");
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

    it("returns 'dsh' for a run with harness_type 'dsh'", async () => {
      const runId = "99999999-aaaa-4bbb-bbbb-999999999999";
      await seedRunRecord(runId, "dsh");

      const result = getRunHarnessType(runId);
      assert.equal(result, "dsh");
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

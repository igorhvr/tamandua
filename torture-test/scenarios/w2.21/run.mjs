#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = requiredEnv("TT_REPO_ROOT");
const invocationDir = requiredEnv("TT_SCENARIO_STATE_DIR");
const workflowId = requiredEnv("TT_SCENARIO_WORKFLOW_ID");
const scriptedStateDir = requiredEnv("TAMANDUA_STATE_DIR");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");

const accountHome = realAccountHome();
const daemonControl = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const cli = path.join(repoRoot, "bin", "tamandua");

const daemonEnv = {
  ...process.env,
  HOME: accountHome,
  PATH: `${path.join(repoRoot, "bin")}:${process.env.PATH ?? ""}`,
};

const scriptedEnv = { ...process.env };

let evidence;
try {
  // ── Step 1: Stop the scripted daemon for a clean start ──────────
  const stopResult = spawnSync(daemonControl, ["scripted", "stop"], {
    cwd: repoRoot,
    env: daemonEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ok(stopResult.status === 0 || stopResult.stdout.includes("already stopped"),
    `daemon stop failed: ${stopResult.stderr}`);

  // ── Step 2: Launch workflow run ──────────────────────────────────
  // ensureDaemonControlAvailable in the CLI auto-starts a daemon when
  // none is running, so the run goes directly to 'active' (not the
  // older pending_register path). This tests that admission works
  // smoothly even when the daemon is started by the CLI itself.
  const launchResult = spawnSync(cli, ["workflow", "run", workflowId, "Admission edge test task"], {
    cwd: repoRoot,
    env: scriptedEnv,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(launchResult.status, 0,
    `workflow run failed (exit ${launchResult.status}):\n${launchResult.stderr}`);
  const launchOutput = launchResult.stdout;
  assert.ok(launchOutput.includes("Run:"),
    `expected Run identifier in output, got:\n${launchOutput}`);
  const runIdMatch = launchOutput.match(/Run:\s*(run-[a-f0-9-]+)/);
  assert.ok(runIdMatch, `could not parse run ID from output:\n${launchOutput}`);
  const runId = runIdMatch[1];
  const dbRunId = runId.startsWith("run-") ? runId.slice(4) : runId;

  // ── Step 3: Verify run exists and is active ──────────────────────
  // The CLI auto-started the daemon, so the run is immediately 'active'.
  const db = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const runRow = db.prepare(
    "SELECT id, status, scheduling_status FROM runs WHERE id = ?"
  ).get(dbRunId);
  db.close();
  assert.ok(runRow, `run ${dbRunId} not found in database`);
  assert.equal(runRow.status, "running",
    `expected run status 'running', got '${runRow.status}'`);
  assert.equal(runRow.scheduling_status, "active",
    `expected scheduling_status 'active' (CLI auto-started daemon), got '${runRow.scheduling_status}'`);

  // ── Step 4: Restart daemon cleanly (CLI's auto-started daemon ───
  // may have a different PID provenance — restart to ensure clean state.)
  spawnSync(daemonControl, ["scripted", "stop"], {
    cwd: repoRoot, env: daemonEnv, encoding: "utf8", timeout: 30_000,
  });
  const startResult = spawnSync(daemonControl, ["scripted", "start"], {
    cwd: repoRoot,
    env: daemonEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(startResult.status, 0,
    `daemon restart failed: ${startResult.stderr}`);

  // ── Step 5: Poll for terminal state ─────────────────────────────
  let terminalStatus;
  for (let attempt = 0; attempt < 60; attempt++) {
    const pollDb = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
    try {
      const row = pollDb.prepare(
        "SELECT status FROM runs WHERE id = ?"
      ).get(dbRunId);
      if (row && (row.status === "completed" || row.status === "failed" || row.status === "canceled")) {
        terminalStatus = row.status;
        break;
      }
    } finally {
      pollDb.close();
    }
    await sleep(1000);
  }

  assert.ok(terminalStatus, `run ${runId} did not reach terminal state within timeout`);
  assert.equal(terminalStatus, "completed",
    `expected run completed, got ${terminalStatus}`);

  // ── Step 6: Verify token ledgers ─────────────────────────────────
  const finalDb = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const finalRunRow = finalDb.prepare(
    "SELECT tokens_spent FROM runs WHERE id = ?"
  ).get(dbRunId);
  const systemRow = finalDb.prepare(
    "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1"
  ).get();
  finalDb.close();

  assert.equal(finalRunRow?.tokens_spent ?? -1, 0,
    "scripted admission-edge run spent tokens");
  if (systemRow) {
    assert.equal(systemRow.system_tokens_spent, 0,
      "system token tripwire moved");
  }

  evidence = {
    scenario: "W2.21",
    run_id: runId,
    scheduling_status: runRow.scheduling_status,
    terminal_status: terminalStatus,
    tokens_spent: finalRunRow?.tokens_spent ?? 0,
    system_tokens_spent: systemRow?.system_tokens_spent ?? 0,
    result: "PASS",
  };
} finally {
  spawnSync(daemonControl, ["scripted", "stop"], {
    cwd: repoRoot,
    env: daemonEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
}

process.stdout.write(`${JSON.stringify(evidence)}\n`);

// ── Helpers ──────────────────────────────────────────────────────────

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing scenario environment: ${name}`);
  return value;
}

function realAccountHome() {
  const result = spawnSync("bash", ["-c", 'getent passwd "$(id -u)" | cut -d: -f6'], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return process.env.HOME ?? "/home/$(id -un)";
  }
  return result.stdout.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

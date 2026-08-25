#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { realAccountHome } from "../lib/operator-home.mjs";
import { waitForTerminalRun } from "../lib/terminal-wait.mjs";

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
  // ── Step 1: Stop the scripted daemon ─────────────────────────────
  const stopResult = spawnSync(daemonControl, ["scripted", "stop"], {
    cwd: repoRoot,
    env: daemonEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ok(stopResult.status === 0 || stopResult.stdout.includes("already stopped"),
    `daemon stop failed: ${stopResult.stderr}`);

  // ── Step 2: Remove persona files from agent workspace baseDir ───
  // The scenario harness (install-scenario-workflows) has already copied
  // the do-now workflow. We locate its agent source dir and remove the
  // persona files so provisionAgents silently skips them per current
  // behavior (ENOENT → continue). The baseDir (agents/doer) remains an
  // existing directory — it just no longer contains AGENTS.md,
  // IDENTITY.md, or SOUL.md.
  const workflowDir = path.join(scriptedStateDir, "workflows", workflowId);
  assert.ok(fs.statSync(workflowDir).isDirectory(),
    `workflow dir not found: ${workflowDir}`);

  // Read workflow.yml to locate the agent's baseDir
  const ymlPath = path.join(workflowDir, "workflow.yml");
  let yml = fs.readFileSync(ymlPath, "utf8");
  // Extract baseDir from the workspace section of the first agent (do-now has
  // one agent: doer). This is a simple YAML-line parser; we look for
  // `baseDir: <path>` inside the workspace: block.
  const baseDirMatch = yml.match(/^\s*baseDir:\s*(\S+)/m);
  assert.ok(baseDirMatch, "could not find baseDir in workflow.yml");
  const agentBaseDir = path.join(workflowDir, baseDirMatch[1]);
  assert.ok(fs.statSync(agentBaseDir).isDirectory(),
    `agent baseDir not found: ${agentBaseDir}`);

  // Remove persona files from the source agent dir (if they exist).
  // The spec documents: "missing persona files are today silently skipped
  // at provision time". We simulate this by ensuring the agent source dir
  // contains none of the three persona files.
  const personaFiles = ["AGENTS.md", "IDENTITY.md", "SOUL.md"];
  let personasRemoved = 0;
  for (const fileName of personaFiles) {
    const personaPath = path.join(agentBaseDir, fileName);
    try {
      fs.unlinkSync(personaPath);
      personasRemoved++;
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
  }
  assert.ok(personasRemoved > 0,
    `expected persona files in ${agentBaseDir}, but none found to remove`);

  // Verify the directory still exists but persona files are gone
  assert.ok(fs.statSync(agentBaseDir).isDirectory(),
    `agent baseDir should still exist: ${agentBaseDir}`);
  for (const fileName of personaFiles) {
    assert.throws(
      () => fs.statSync(path.join(agentBaseDir, fileName)),
      /ENOENT/,
      `persona file ${fileName} should be absent from ${agentBaseDir}`
    );
  }

  // ── Step 3: Launch workflow run with daemon down ─────────────────
  const launchResult = spawnSync(cli, ["workflow", "run", workflowId, "Missing persona test — agent workspace has no persona files"], {
    cwd: repoRoot,
    env: scriptedEnv,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(launchResult.status, 0,
    `workflow run failed (exit ${launchResult.status}):\n${launchResult.stderr}`);
  const launchOutput = launchResult.stdout;
  const runIdMatch = launchOutput.match(/Run:\s*(run-[a-f0-9-]+)/);
  assert.ok(runIdMatch, `could not parse run ID from output:\n${launchOutput}`);
  const runId = runIdMatch[1];
  const dbRunId = runId.startsWith("run-") ? runId.slice(4) : runId;

  // ── Step 4: Verify the run has pending_register state ────────────
  const checkDb = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const pendingRow = checkDb.prepare(
    "SELECT scheduling_status FROM runs WHERE id = ?"
  ).get(dbRunId);
  assert.ok(pendingRow, `run ${dbRunId} not found in database`);
  assert.ok(
    pendingRow.scheduling_status === "pending_register" || pendingRow.scheduling_status === "active",
    `expected pending_register or active, got ${pendingRow.scheduling_status}`
  );
  checkDb.close();

  // ── Step 5: Start the daemon ────────────────────────────────────
  const startResult = spawnSync(daemonControl, ["scripted", "start"], {
    cwd: repoRoot,
    env: daemonEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(startResult.status, 0,
    `daemon start failed: ${startResult.stderr}`);

  // ── Step 6: Poll for terminal state ─────────────────────────────
  // Shared terminal-wait helper (lib/terminal-wait.mjs, MACP7 US-004): a
  // register-run failure ("harness workdir is already set" class) surfaces
  // immediately as SCRIPTED_RUN_REGISTRATION_FAILED with the daemon's error
  // captured, instead of a generic did-not-reach-terminal timeout.
  // With scripted behaviors producing STATUS: done, the run should reach
  // a terminal state (completed or failed) quickly. Budget 120s.
  const terminalStatus = await waitForTerminalRun({
    dbPath: path.join(scriptedStateDir, "tamandua.db"),
    runId,
    timeoutMs: 120_000,
    pollMs: 1000,
  });

  // ── Step 7: Verify the daemon did not crash ─────────────────────
  // If we got here without an assertion failure, the daemon is alive.
  // Also verify the run row itself doesn't indicate a daemon crash
  // (crashed daemons produce canceled runs, not completed/failed).
  assert.ok(
    terminalStatus === "completed" || terminalStatus === "failed",
    `run reached unexpected terminal state: ${terminalStatus} (crashed daemon?)`
  );

  // ── Step 8: Verify token ledgers ────────────────────────────────
  const finalDb = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const finalRunRow = finalDb.prepare(
    "SELECT tokens_spent FROM runs WHERE id = ?"
  ).get(dbRunId);
  const systemRow = finalDb.prepare(
    "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1"
  ).get();
  finalDb.close();

  assert.equal(finalRunRow?.tokens_spent ?? -1, 0,
    "scripted missing-persona run spent tokens");
  if (systemRow) {
    assert.equal(systemRow.system_tokens_spent, 0,
      "system token tripwire moved");
  }

  // ── Step 9: Document outcome ────────────────────────────────────
  // Per spec §W2.23c: "missing persona files are today silently skipped
  // at provision time". The install succeeded, the run launched, and
  // the run reached a terminal state without any persona instructions.
  //
  // With scripted behaviors the run completed (STATUS: done output
  // satisfies the expects regex). However, the PRODUCT_FAIL flag
  // documents that a real AI agent without persona instructions would
  // lack the CRITICAL STATUS Line Requirement block, making it likely
  // to produce output that fails expects validation mid-execution.
  const productFailCandidate = terminalStatus === "completed";
  const installSilentlySucceeded = true;

  evidence = {
    scenario: "W2.23c",
    run_id: runId,
    terminal_status: terminalStatus,
    personas_removed: personaFiles,
    personas_source_dir: agentBaseDir,
    install_silently_succeeded: installSilentlySucceeded,
    product_fail_candidate: productFailCandidate,
    product_fail_note: productFailCandidate
      ? "Run completed with deterministic output but persona files were absent. "
        + "A real agent without STATUS-line instructions would likely fail expects validation. "
        + "Per spec §W2.23c: 'missing persona files are today silently skipped at provision time' "
        + "— this is the PRODUCT_FAIL candidate: a workflow that installs green and "
        + "dies mid-run at step completion is exactly what a workflow-authoring user hits."
      : `Run reached terminal state ${terminalStatus} without persona files. Behavioral finding documented.`,
    tokens_spent: finalRunRow?.tokens_spent ?? 0,
    system_tokens_spent: systemRow?.system_tokens_spent ?? 0,
    result: "PASS",
  };
} finally {
  // Stop the scripted daemon
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

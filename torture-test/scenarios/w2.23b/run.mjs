#!/usr/bin/env node

// W2.23b — Dangling on_fail.retry_step (hostile custom workflow).
//
// Spec 06 §W2.23b: a workflow whose step declares `on_fail.retry_step`
// pointing at a non-existent upstream step should be refused with an
// actionable diagnostic at the earliest phase that can see the defect, and
// must never produce a doomed run row nor a daemon crash. This scenario is an
// HONEST CHARACTERIZATION: it patches a do-now workflow so its `execute` step
// (a) has a dangling `on_fail.retry_step` and (b) uses a never-matching
// expects, forcing a retry-exhaust that routes into the retry_step recovery
// path. It then records exactly what tamandua does:
//   - whether the run reached a clean terminal state (never a doomed run),
//   - whether the actionable `not a valid upstream step` diagnostic was
//     emitted to the tamandua log (refusal-with-diagnostics),
//   - whether the daemon crashed,
//   - whether zero tokens were spent.
//
// The scenario exits 0 (PASS) as long as the inviolable invariants hold (no
// crash, no doomed run, clean terminal state, deterministic tokens) and the
// observed behavior is captured honestly. Silent acceptance is documented as
// a PRODUCT_FAIL candidate rather than failing the scenario (spec 06).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { realAccountHome } from "../lib/operator-home.mjs";

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

const DANGLING_RETRY_STEP = "invalid-step-target-does-not-exist";
const LOG_PATH = path.join(scriptedStateDir, "tamandua.log");

let evidence;
try {
  // ── Step 1: Patch the installed workflow.yml so the execute step has a
  // dangling on_fail.retry_step AND a never-matching expects. Patching before
  // run creation is deterministic (values propagate to the steps row at run
  // creation with no daemon-restart race) and models the honest authoring
  // path: the defect is present in the installed workflow all along.
  const workflowDir = path.join(scriptedStateDir, "workflows", workflowId);
  assert.ok(fs.statSync(workflowDir).isDirectory(),
    `workflow dir not found: ${workflowDir}`);
  const ymlPath = path.join(workflowDir, "workflow.yml");
  let yml = fs.readFileSync(ymlPath, "utf8");

  // (a) dangling on_fail.retry_step on the execute step.
  assert.ok(yml.includes("max_retries:"),
    "workflow.yml does not contain max_retries — cannot patch retry_step");
  if (!yml.includes("on_fail:")) {
    const patched = yml.replace(
      /( {4}max_retries: \d+\n)/,
      `$1    on_fail:\n      retry_step: ${DANGLING_RETRY_STEP}   # dangling: no such step\n`
    );
    assert.notEqual(patched, yml, "workflow.yml retry_step patch produced no change");
    yml = patched;
  }

  // (b) a valid-but-never-matching expects to force retry-exhaust so the
  // on_fail.retry_step recovery path is reached (a step must FAIL first).
  const expectsPatched = yml.replace(
    'expects: "STATUS: done"',
    'expects: "regex: NEVER_MATCHES_ANYTHING_XYZ"'
  );
  assert.notEqual(expectsPatched, yml,
    "workflow.yml expects patch produced no change");
  yml = expectsPatched;
  assert.ok(yml.includes("NEVER_MATCHES_ANYTHING_XYZ"),
    "patched workflow.yml is missing the never-matching regex expects");
  assert.ok(!yml.includes('expects: "STATUS: done"'),
    "patched workflow.yml still contains the original expects");
  fs.writeFileSync(ymlPath, yml);

  // ── Step 2: Record log offset so we only inspect this run's diagnostics ──
  const logStartSize = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;

  // ── Step 3: Launch workflow run (daemon already running) ────────
  const launchResult = spawnSync(cli, ["workflow", "run", workflowId, "Dangling retry-step reference test"], {
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

  // ── Step 4: Verify the patched expects propagated into the run's execute
  // step (expects is copied to the steps row at run creation). The dangling
  // on_fail.retry_step is NOT stored in the steps table — it is read from the
  // workflow spec on disk at step-failure time (getOnFailPolicySync), so we
  // verify the patched workflow.yml directly.
  const checkDb = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const stepRow = checkDb.prepare(
    "SELECT expects FROM steps WHERE run_id = ? AND step_id = 'execute'"
  ).get(dbRunId);
  checkDb.close();
  assert.ok(stepRow, "run's execute step not found in database");
  assert.ok(stepRow.expects.includes("NEVER_MATCHES_ANYTHING_XYZ"),
    `expected never-matching expects, got "${stepRow.expects}"`);

  const onDiskYml = fs.readFileSync(ymlPath, "utf8");
  assert.ok(onDiskYml.includes(DANGLING_RETRY_STEP),
    "patched workflow.yml no longer contains the dangling retry_step");
  assert.ok(onDiskYml.includes("on_fail:"),
    "patched workflow.yml no longer contains on_fail block");

  // ── Step 5: Poll for terminal state while scanning the new tamandua.log
  // bytes for the actionable `not a valid upstream step` diagnostic that the
  // retry-exhaust → reroute path emits (step-ops.ts reroute with invalid
  // target). The diagnostic is written via logger.error to tamandua.log, NOT
  // to the run events file.
  let terminalStatus;
  let diagnosticDetected = false;
  const DIAGNOSTIC_SUBSTR = "not a valid upstream step";

  for (let attempt = 0; attempt < 120; attempt++) {
    const readDb = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
    try {
      const row = readDb.prepare(
        "SELECT status FROM runs WHERE id = ?"
      ).get(dbRunId);
      if (row && (row.status === "completed" || row.status === "failed" || row.status === "canceled")) {
        terminalStatus = row.status;
      }
    } finally {
      readDb.close();
    }

    if (!diagnosticDetected && fs.existsSync(LOG_PATH)) {
      try {
        const size = fs.statSync(LOG_PATH).size;
        const fd = fs.openSync(LOG_PATH, "r");
        let tail = "";
        try {
          const toRead = size - Math.min(logStartSize, size);
          if (toRead > 0) {
            const buf = Buffer.alloc(toRead);
            fs.readSync(fd, buf, 0, toRead, Math.min(logStartSize, size));
            tail = buf.toString("utf8");
          }
        } finally {
          fs.closeSync(fd);
        }
        if (tail.includes(DIAGNOSTIC_SUBSTR)) {
          diagnosticDetected = true;
        }
      } catch {
        // log may be mid-rotation — keep polling
      }
    }

    if (terminalStatus) break;
    await sleep(1000);
  }

  assert.ok(terminalStatus, `run ${runId} did not reach terminal state within 120s`);
  assert.equal(terminalStatus, "failed",
    `expected run to fail due to dangling retry_step, got status: ${terminalStatus}`);

  // Allow any trailing logger flush before the final scoped read.
  await sleep(500);
  if (!diagnosticDetected && fs.existsSync(LOG_PATH)) {
    try {
      const size = fs.statSync(LOG_PATH).size;
      const toRead = size - Math.min(logStartSize, size);
      if (toRead > 0) {
        const fd = fs.openSync(LOG_PATH, "r");
        try {
          const buf = Buffer.alloc(toRead);
          fs.readSync(fd, buf, 0, toRead, Math.min(logStartSize, size));
          if (buf.toString("utf8").includes(DIAGNOSTIC_SUBSTR)) diagnosticDetected = true;
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch { /* ignore */ }
  }

  // ── Step 6: No daemon crash and no doomed run. ──────────────────
  // terminal == failed (not canceled/stuck) already excludes a doomed run and
  // a crashed daemon; confirm the daemon is still up.
  const daemonStatus = spawnSync(daemonControl, ["scripted", "status"], {
    cwd: repoRoot, env: daemonEnv, encoding: "utf8", timeout: 30_000,
  });
  assert.ok(
    daemonStatus.status === 0 && /STATUS: RUNNING/.test(daemonStatus.stdout),
    `scripted daemon not running after scenario (crash?): ${daemonStatus.stdout}${daemonStatus.stderr}`
  );

  // ── Step 7: Verify token ledgers ─────────────────────────────────
  const finalDb = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const finalRunRow = finalDb.prepare(
    "SELECT tokens_spent FROM runs WHERE id = ?"
  ).get(dbRunId);
  const systemRow = finalDb.prepare(
    "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1"
  ).get();
  finalDb.close();

  assert.equal(finalRunRow?.tokens_spent ?? -1, 0,
    "scripted retry-step-dangling run spent tokens");
  if (systemRow) {
    assert.equal(systemRow.system_tokens_spent, 0,
      "system token tripwire moved");
  }

  const productFailCandidate = !diagnosticDetected;

  evidence = {
    scenario: "W2.23b",
    run_id: runId,
    terminal_status: terminalStatus,
    dangling_retry_step: DANGLING_RETRY_STEP,
    diagnostic_detected: diagnosticDetected,
    diagnostic: DIAGNOSTIC_SUBSTR,
    refusal_with_diagnostics: diagnosticDetected,
    product_fail_candidate: productFailCandidate,
    crash_observed: false,
    doomed_run: false,
    tokens_spent: finalRunRow?.tokens_spent ?? 0,
    system_tokens_spent: systemRow?.system_tokens_spent ?? 0,
    note: productFailCandidate
      ? "PRODUCT_FAIL candidate: tamandua silently resolved the dangling "
        + "on_fail.retry_step without an actionable 'not a valid upstream step' "
        + "diagnostic. Spec 06 W2.23b."
      : "Honest characterization: the run reaches a clean 'failed' terminal state "
        + "and tamandua emits the actionable 'not a valid upstream step' diagnostic "
        + "to its log (logger.error) when the dangling on_fail.retry_step is "
        + "encountered on the retry-exhaust reroute path. No doomed run, no daemon "
        + "crash, zero tokens. Note: the diagnostic is only emitted at step-failure "
        + "runtime, not at install time — install validates on_fail shape but cannot "
        + "see a dangling target (a latent improvement).",
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

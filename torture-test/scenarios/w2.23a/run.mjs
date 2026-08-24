#!/usr/bin/env node

// W2.23a — Non-compiling expects regex (hostile custom workflow).
//
// Spec 06 §W2.23a: a workflow whose step `expects` contains a non-compiling
// regex should be refused with an actionable diagnostic at the earliest phase
// that can see the defect, and must never produce a doomed run row nor a
// daemon crash. This scenario is an HONEST CHARACTERIZATION: it installs a
// do-now workflow whose `execute` step expects is a `regex:` line that cannot
// compile (unmatched paren), runs it through the scripted harness, and records
// exactly what tamandua does:
//   - whether the run reached a clean terminal state (never a doomed run),
//   - whether an actionable `Invalid expects regex pattern` diagnostic was
//     produced (refusal-with-diagnostics) or the defect was silently accepted,
//   - whether the daemon crashed,
//   - whether zero tokens were spent.
//
// The scenario exits 0 (PASS) as long as the inviolable invariants hold (no
// crash, no doomed run, clean terminal state, deterministic tokens) and the
// observed behavior is captured honestly in the evidence payload. Spec 06
// explicitly directs that silent acceptance be *documented* as a PRODUCT_FAIL
// candidate rather than failing the scenario.

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

const BAD_EXPECTS = "regex: STATUS: done(";
const EVENTS_DIR = path.join(scriptedStateDir, "events");

let evidence;
try {
  // ── Step 1: Patch the installed workflow's execute expects to a
  // non-compiling regex BEFORE run creation. The expects value is copied
  // from workflow.yml into the steps row at run creation, so patching the
  // spec first deterministically produces a corrupted expects with no
  // daemon-restart race. This is the honest authoring path: the defect is
  // present in the installed workflow all along and can only surface at
  // step completion (install validates only basic shape).
  const workflowDir = path.join(scriptedStateDir, "workflows", workflowId);
  assert.ok(fs.statSync(workflowDir).isDirectory(),
    `workflow dir not found: ${workflowDir}`);
  const ymlPath = path.join(workflowDir, "workflow.yml");
  let yml = fs.readFileSync(ymlPath, "utf8");
  assert.ok(yml.includes('expects: "STATUS: done"'),
    "workflow.yml does not contain the expected do-now execute expects — cannot patch it");
  const patched = yml.replace(
    'expects: "STATUS: done"',
    `expects: "${BAD_EXPECTS}"`
  );
  assert.notEqual(patched, yml, "workflow.yml patch produced no change");
  fs.writeFileSync(ymlPath, patched);

  // ── Step 2: Launch workflow run (daemon already running) ────────
  const launchResult = spawnSync(cli, ["workflow", "run", workflowId, "Non-compiling expects regex test"], {
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

  // ── Step 3: Verify the run's execute step really has the corrupted
  // expects (proves the spec patch propagated into the steps row).
  const checkDb = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const corrupted = checkDb.prepare(
    "SELECT expects FROM steps WHERE run_id = ? AND step_id = 'execute'"
  ).get(dbRunId);
  checkDb.close();
  assert.ok(corrupted, "run's execute step not found in database");
  assert.equal(corrupted.expects, BAD_EXPECTS,
    `expected patched expects "${BAD_EXPECTS}", got "${corrupted.expects}"`);

  // ── Step 4: Poll for terminal state ─────────────────────────────
  // With a non-compiling regex, every completion is rejected, retries are
  // exhausted, and the run fails — landing on a clean 'failed' status. While
  // polling we also detect whether tamandua produced the actionable
  // `Invalid expects regex pattern` diagnostic (recorded in the run's own
  // events file on each step.retry rejection).
  let terminalStatus;
  let diagnosticDetected = false;
  const eventsPath = path.join(EVENTS_DIR, `${dbRunId}.jsonl`);

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

    if (!diagnosticDetected && fs.existsSync(eventsPath)) {
      try {
        const eventsText = fs.readFileSync(eventsPath, "utf8");
        if (eventsText.includes("Invalid expects regex pattern")) {
          diagnosticDetected = true;
        }
      } catch {
        // events file may not be fully flushed yet — keep polling
      }
    }

    if (terminalStatus) break;
    await sleep(1000);
  }

  assert.ok(terminalStatus, `run ${runId} did not reach terminal state within 120s`);
  // Inviolable invariants: the defect must resolve to a clean failed run, not
  // a hang, a cancel, or a phantom completion.
  assert.equal(terminalStatus, "failed",
    `expected run to fail on non-compiling expects regex, got status: ${terminalStatus}`);

  // ── Step 5: Characterize the diagnostic (record-only, per spec 06) ──
  // Spec 06 directs: "refusal with actionable diagnostics at the EARLIEST
  // phase that can see the defect" and, where behavior is silent acceptance,
  // "the scenario documents it as a PRODUCT_FAIL candidate". The scenario's
  // job is to characterize, not to fail the oracle over tamandua's quality.
  // We therefore RECORD whether the `Invalid expects regex pattern`
  // diagnostic was produced (current behavior: it is — see step-ops.ts
  // validateExpects) and flag product_fail_candidate only if silent. The
  // inviolable invariants (clean terminal, no crash, no doomed run) above
  // are the hard gates.
  assert.ok(fs.existsSync(eventsPath),
    `run events file missing: ${eventsPath}`);
  const productFailCandidate = !diagnosticDetected;

  // ── Step 6: No daemon crash; a crashed daemon would leave the run row
  // stuck or canceled, which we already excluded (terminal == failed).
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
    "scripted expects-regex run spent tokens");
  if (systemRow) {
    assert.equal(systemRow.system_tokens_spent, 0,
      "system token tripwire moved");
  }

  evidence = {
    scenario: "W2.23a",
    run_id: runId,
    terminal_status: terminalStatus,
    bad_expects: BAD_EXPECTS,
    diagnostic_detected: diagnosticDetected,
    diagnostic: "Invalid expects regex pattern",
    refusal_with_diagnostics: diagnosticDetected,
    product_fail_candidate: productFailCandidate,
    crash_observed: false,
    doomed_run: false,
    tokens_spent: finalRunRow?.tokens_spent ?? 0,
    system_tokens_spent: systemRow?.system_tokens_spent ?? 0,
    note: productFailCandidate
      ? "PRODUCT_FAIL candidate: tamandua silently accepted the non-compiling "
        + "expects regex (no 'Invalid expects regex pattern' diagnostic). A workflow "
        + "that installs green and dies mid-run at step completion is exactly what a "
        + "workflow-authoring user hits. Spec 06 W2.23a."
      : "Honest characterization: tamandua detects the non-compiling expects "
        + "regex at step completion and surfaces an actionable 'Invalid expects "
        + "regex pattern' diagnostic before failing cleanly. No doomed run, no "
        + "daemon crash. Per spec 06 W2.23a this is refusal-with-diagnostics, "
        + "not the silent acceptance the spec suspected. Earliest-phase note: "
        + "the defect is only caught at step completion, not install time "
        + "(install validates basic shape only) — a latent improvement.",
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

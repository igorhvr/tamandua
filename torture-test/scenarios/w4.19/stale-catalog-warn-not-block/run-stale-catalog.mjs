#!/usr/bin/env node
/**
 * W4.19 artificially stale catalog stamp — warn-not-block (spec 08 §E).
 *
 * Idle-window, zero-token scripted cell. The scenario writes an ARTIFICIALLY
 * STALE `.catalog-version.json` stamp into the contained scripted daemon's
 * workflows dir (the harness's `workflow install do-now` already wrote a
 * CURRENT stamp; this cell overwrites it with a stale version), then:
 *
 *   (a) launches a real `workflow run` (scripted-pi harness, zero tokens) and
 *       asserts the ONE-LINE LAUNCH WARNING on stderr ("Warning: installed
 *       catalog is older than bundled catalog ...") while the run PROCEEDS
 *       and completes — warn-not-block;
 *   (b) runs `tamandua doctor` and asserts the STALENESS group flags
 *       "Installed catalog vs bundled catalog" with the
 *       "is older than bundled catalog version" message and the
 *       "tamandua update --force" remedy — and that doctor still exits 0
 *       (the stale stamp is a WARN, never a block).
 *
 * Zero tokens: the run is executed by the scripted-pi runtime (the contained
 * daemon's TAMANDUA_PI_BINARY) and the ledger is asserted to carry zero
 * token spend at the end (runs.tokens_spent sum == 0, system tripwire == 0).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function requiredValue(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} must be set`);
  return value;
}
function requiredPath(name) {
  const value = requiredValue(name);
  assert.ok(path.isAbsolute(value), `${name} must be an absolute path`);
  return value;
}

const repoRoot = requiredPath("TT_REPO_ROOT");
const invocationDir = requiredPath("TT_SCENARIO_STATE_DIR");
const scenarioId = requiredValue("TT_SCENARIO_ID");
const workflowId = requiredValue("TT_SCENARIO_WORKFLOW_ID");
const stateDir = requiredPath("TAMANDUA_STATE_DIR");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");
assert.equal(scenarioId, "w4.19-stale-catalog-warn-not-block", "scenario id mismatch");

const cli = path.join(repoRoot, "bin", "tamandua");
const stampPath = path.join(stateDir, "workflows", ".catalog-version.json");
const dbPath = path.join(stateDir, "tamandua.db");
const workDir = path.join(invocationDir, "probe-work");
// An artificial version that can never equal a real build version — the
// injection under test (spec: "artificially stale catalog stamp").
const STALE_VERSION = "20200101T000000Z_artificially-stale";

for (const candidate of [workDir, stampPath]) {
  assert.ok(
    candidate === invocationDir || candidate === stateDir
      || candidate.startsWith(`${invocationDir}${path.sep}`)
      || candidate.startsWith(`${stateDir}${path.sep}`),
    `W4.19 mutable path escaped torture-test/var: ${candidate}`,
  );
}
fs.mkdirSync(workDir, { recursive: true });

assert.ok(fs.existsSync(cli), `tamandua CLI not found: ${cli}`);
assert.ok(fs.existsSync(stampPath),
  "contained catalog stamp missing — the harness's workflow install must have written one");

const env = { ...process.env };

// ── capture the pre-injection stamp (the harness's install wrote it) ──

const currentStamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
assert.ok(typeof currentStamp.version === "string" && currentStamp.version.length > 0,
  "pre-injection catalog stamp has no version");
assert.notEqual(currentStamp.version, STALE_VERSION, "the injected stale version collides with the real build version");

// ── injection: artificially stale the stamp ─────────────────────────

const stale = {
  version: STALE_VERSION,
  sourcePath: currentStamp.sourcePath,
  installedAt: "2020-01-01T00:00:00.000Z",
};
fs.writeFileSync(stampPath, `${JSON.stringify(stale, null, 2)}\n`);
assert.equal(JSON.parse(fs.readFileSync(stampPath, "utf8")).version, STALE_VERSION,
  "stale stamp injection failed");

// ── (a) launch a run against the scenario workflow copy — warn-not-block ──
// The run targets TT_SCENARIO_WORKFLOW_ID (the harness-installed workflow
// COPY whose agent key exists in the materialized behaviors file), so the
// scripted-pi runtime completes the step with zero tokens.

const launch = runAllow(cli, [
  "workflow", "run", workflowId, "W4.19 stale-catalog warn-not-block probe",
  "--working-directory-for-harness", workDir,
  "--wait", "--timeout", "3m", "--json",
], { cwd: workDir, timeout: 4 * 60_000 });
assert.equal(launch.status, 0,
  `workflow run must proceed despite the stale stamp:\n${launch.stdout}\n${launch.stderr}`);
assert.match(launch.stderr, /Warning: installed catalog is older than bundled catalog/,
  `the one-line launch warning must appear on stderr:\n${launch.stderr}`);
assert.match(launch.stderr, /tamandua update --force/,
  `the launch warning must name the remedy:\n${launch.stderr}`);
const payload = JSON.parse(launch.stdout.trim().split("\n").reverse().find((line) => line.trim().startsWith("{")));
const record = Array.isArray(payload.runs) ? payload.runs[0] : payload;
assert.equal(record.status, "completed",
  `the launched run must complete (warn-not-block): ${launch.stdout}`);
const runId = String(record.runId ?? record.run_id ?? "");

// ── (b) doctor — STALENESS flag, warn-not-block ─────────────────────

const doctor = runAllow(cli, ["doctor"], { cwd: workDir, timeout: 60_000 });
assert.equal(doctor.status, 0,
  `doctor must still exit 0 (stale stamp is a warn, never a block):\n${doctor.stdout}\n${doctor.stderr}`);
const combined = `${doctor.stdout}\n${doctor.stderr}`;
assert.match(combined, /─── STALENESS ───/, `doctor must surface the STALENESS group:\n${combined}`);
assert.match(combined, /Installed catalog vs bundled catalog/, `doctor must flag the catalog check:\n${combined}`);
assert.match(combined, /is older than bundled catalog/, `doctor must name the stale stamp:\n${combined}`);
assert.match(combined, /tamandua update --force/, `doctor must carry the update --force remedy:\n${combined}`);

// ── zero-token ledger proof ─────────────────────────────────────────

const db = new DatabaseSync(dbPath, { readOnly: true });
let runTokens = 0;
let systemTokens = 0;
try {
  runTokens = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get().total;
  systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get().system_tokens_spent;
} finally {
  db.close();
}
assert.equal(runTokens, 0, "W4.19 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.19 system token tripwire moved");

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  injected_stale_version: STALE_VERSION,
  pre_injection_version: currentStamp.version,
  launch: {
    run_id: runId,
    status: record.status,
    warning_seen: true,
    remedy_seen: true,
  },
  doctor: {
    staleness_group: true,
    catalog_check: true,
    exit_code: doctor.status,
  },
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
}, null, 2)}\n`);

function runAllow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scenarioDir, "../../..");
const fixture = JSON.parse(fs.readFileSync(path.join(scenarioDir, "fixture.json"), "utf8"));
const operatorHome = resolveOperatorHome();
const daemonControlPath = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const scriptedRuntime = path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-pi");
const git = trustedCommandPath("git");
const hostToolPath = [...new Set([path.dirname(git), "/usr/bin", "/bin"])].join(path.delimiter);
const gitEnv = isolatedGitEnvironment();
const actualPuma = run(git, ["rev-parse", "refs/tags/puma^{commit}"], { cwd: repoRoot, env: gitEnv }).stdout.trim();
const head = run(git, ["rev-parse", "HEAD"], { cwd: repoRoot, env: gitEnv }).stdout.trim();
const ttCommit = String(process.env.TT_COMMIT || head);
assert.equal(actualPuma, fixture.puma_commit, `puma tag moved: expected ${fixture.puma_commit}, got ${actualPuma}`);
assert.equal(ttCommit, head, `TT_COMMIT ${ttCommit} does not match checkout HEAD ${head}`);

if (process.argv.includes("--check")) {
  process.stdout.write(`${JSON.stringify({ scenario: "W4.25", leg: "downgrade-reupgrade", puma_commit: actualPuma, tt_commit: ttCommit, result: "PASS" })}\n`);
  process.exit(0);
}

assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "downgrade/re-upgrade legs must run inside the harness-proven process group");
const invocationDir = requiredContainedEnv("TT_SCENARIO_STATE_DIR");
const scriptedHome = requiredContainedEnv("HOME");
const scriptedStateDir = requiredContainedEnv("TAMANDUA_STATE_DIR");
const varRoot = fs.realpathSync(path.join(repoRoot, "torture-test", "var"));
assert.equal(scriptedHome, path.join(varRoot, "home-scripted"), "HOME must be the exact scripted harness home");
assert.equal(scriptedStateDir, path.join(scriptedHome, ".tamandua"), "TAMANDUA_STATE_DIR must be the exact scripted state directory");
assert.equal(path.dirname(invocationDir), fs.realpathSync(path.join(varRoot, "scenarios")),
  "TT_SCENARIO_STATE_DIR must be a direct scripted-scenario invocation");
assert.ok(path.basename(invocationDir).startsWith("w4.25-aged-state-fixture-"),
  "TT_SCENARIO_STATE_DIR must be owned by W4.25");

const pumaVersionDir = path.join(invocationDir, "versions", "puma");
const ttVersionDir = path.join(invocationDir, "versions", "tt-commit");
const pumaCli = path.join(pumaVersionDir, "bin", "tamandua");
const ttCli = path.join(ttVersionDir, "bin", "tamandua");
const pumaBinDir = path.join(pumaVersionDir, "bin");
const ttBinDir = path.join(ttVersionDir, "bin");
const localBin = path.join(scriptedHome, ".local", "bin");
const installedCli = path.join(localBin, "tamandua");
const customCatalog = path.join(invocationDir, "puma-catalog");
const behaviorsFile = path.join(invocationDir, "upgrade-behaviors.json");
const workCountDir = path.join(invocationDir, "upgrade-work-count");
const doctorToolsDir = path.join(invocationDir, "doctor-tools");
const checkoutStatusBefore = gitStatus();
let pumaTouched = false;
let ttTouched = false;
let evidence;
let primaryError;

try {
  const forwardResult = parseLastJson(run(process.execPath, [path.join(scenarioDir, "run-upgrade.mjs"), "--preserve"], {
    cwd: repoRoot,
    env: process.env,
    timeout: 30 * 60_000,
  }).stdout);
  assert.equal(forwardResult.result, "PASS");
  assert.equal(forwardResult.cleanup.state, "preserved-for-downgrade");

  const forward_boundary = databaseInventory();
  assert.ok(forward_boundary.user_version > 0, "forward migration did not stamp a schema version");
  assert.ok(forward_boundary.migration_evidence.step_columns.includes("ledger_concession_count"),
    "forward migration evidence is missing ledger_concession_count");
  const expectedCustom = assertCustomWorkflowInventory();
  assert.deepEqual(forward_boundary.custom_workflow_inventory, expectedCustom);

  // Field rollback shape: replace the user's contained local-install symlink,
  // then let the puma daemon/CLI open the already-forward-migrated state.
  swapInstalledCli(pumaCli);
  pumaTouched = true;
  const downgradeStart = daemonControl("start", pumaBinDir, false);
  let downgradeProbe = downgradeStart;
  if (downgradeStart.status === 0) {
    downgradeProbe = runAllow(pumaCli, ["workflow", "runs", "--json"], { env: versionEnvironment(pumaVersionDir, customCatalog) });
  }
  const downgradeDiagnostic = `${downgradeStart.stdout}\n${downgradeStart.stderr}\n${downgradeProbe.stdout}\n${downgradeProbe.stderr}`.trim();
  daemonControl("stop", pumaBinDir, true);
  pumaTouched = false;

  const downgrade_boundary = databaseInventory();
  const silent_user_version_reduction = downgrade_boundary.user_version < forward_boundary.user_version;
  const repeated_ddl = downgradeStart.status === 0 && silent_user_version_reduction;
  const lost_migration_evidence = silent_user_version_reduction
    && downgrade_boundary.migration_evidence.step_columns.includes("ledger_concession_count");
  const changed_ddl = !deepEqual(downgrade_boundary.schema_inventory, forward_boundary.schema_inventory);
  const changed_historical_run_rows = !deepEqual(
    downgrade_boundary.historical_run_rows,
    forward_boundary.historical_run_rows,
  );
  const custom_workflow_mutation = !deepEqual(
    downgrade_boundary.custom_workflow_inventory,
    forward_boundary.custom_workflow_inventory,
  );
  const findings = [];
  if (silent_user_version_reduction) findings.push(productFinding(
    "silent_user_version_reduction",
    `puma silently reduced user_version ${forward_boundary.user_version} -> ${downgrade_boundary.user_version}`,
  ));
  if (repeated_ddl) findings.push(productFinding(
    "repeated_ddl",
    "puma entered its full DDL migration path while opening a newer schema",
  ));
  if (lost_migration_evidence) findings.push(productFinding(
    "lost_migration_evidence",
    "the forward-only ledger_concession_count column remains but user_version no longer records its migration",
  ));
  if (changed_ddl) findings.push(productFinding("changed_ddl", "rollback changed sqlite_master schema evidence"));
  if (changed_historical_run_rows) findings.push(productFinding(
    "changed_historical_run_rows",
    "rollback changed historical run-row bytes",
  ));
  if (custom_workflow_mutation) findings.push(productFinding(
    "custom_workflow_mutation",
    "rollback changed installed custom-workflow bytes",
  ));

  const downgradeRefused = downgradeStart.status !== 0 || downgradeProbe.status !== 0;
  let downgradeRoute;
  if (findings.length > 0) {
    downgradeRoute = "PRODUCT_FINDING";
  } else if (downgradeRefused) {
    assert.match(downgradeDiagnostic, /(?:schema|version)/i,
      `downgrade refused without naming the schema/version mismatch:\n${downgradeDiagnostic}`);
    assert.deepEqual(downgrade_boundary, forward_boundary,
      "diagnosable newer-schema refusal mutated forward state");
    downgradeRoute = "diagnosable-newer-schema-refusal";
  } else {
    assert.deepEqual(downgrade_boundary, forward_boundary,
      "read-only-compatible downgrade changed forward state");
    downgradeRoute = "read-only-compatible";
  }

  // Forward recovery must restore the version stamp without replaying DDL,
  // preserve all old rows/custom bytes, and then remain stable on a second open.
  swapInstalledCli(ttCli);
  const ttEnv = versionEnvironment(ttVersionDir, customCatalog);
  run(ttCli, ["workflow", "runs", "--json"], { env: ttEnv });
  const reupgrade_boundary = databaseInventory();
  assert.equal(reupgrade_boundary.user_version, forward_boundary.user_version,
    "re-upgrade did not restore the forward schema version");
  assert.deepEqual(reupgrade_boundary.schema_inventory, forward_boundary.schema_inventory,
    "re-upgrade replayed or changed DDL");
  assert.deepEqual(reupgrade_boundary.historical_run_rows, forward_boundary.historical_run_rows,
    "re-upgrade changed historical run rows");
  assert.deepEqual(reupgrade_boundary.custom_workflow_inventory, forward_boundary.custom_workflow_inventory,
    "re-upgrade changed custom-workflow bytes");

  run(ttCli, ["workflow", "runs", "--json"], { env: ttEnv });
  const idempotenceBoundary = databaseInventory();
  assert.deepEqual(idempotenceBoundary, reupgrade_boundary,
    "a second TT_COMMIT open changed migration evidence");
  const migration_idempotent = true;

  ttTouched = true;
  daemonControl("start", ttBinDir, true);
  const doctor = run(ttCli, ["doctor"], { env: ttEnv });
  assert.match(doctor.stdout, /All checks passed(?:\.| with \d+ warning\(s\) -)/,
    `doctor did not report zero errors after re-upgrade:\n${doctor.stdout}`);

  const listedRuns = JSON.parse(run(ttCli, ["workflow", "runs", "--json"], { env: ttEnv }).stdout.trim());
  for (const historicalRow of forward_boundary.historical_run_rows) {
    const runId = `run-${historicalRow.id}`;
    assert.ok(listedRuns.runs.some((row) => row.runId === runId), `re-upgrade omitted historical run ${runId}`);
    run(ttCli, ["workflow", "status", runId, "--json"], { env: ttEnv });
    const logs = run(ttCli, ["logs", runId], { env: ttEnv }).stdout;
    assert.doesNotMatch(logs, /^No (?:events|run)/m, `re-upgrade did not render logs for ${runId}`);
  }

  const available = JSON.parse(run(ttCli, ["workflow", "list", "--json"], { env: ttEnv }).stdout.trim());
  assert.ok(available.some((row) => row.id === "puma-custom-probe"),
    "re-upgrade did not list the preserved custom workflow");
  run(ttCli, ["workflow", "install", "puma-custom-probe"], { env: ttEnv });
  assert.deepEqual(assertCustomWorkflowInventory(), expectedCustom,
    "re-upgrade custom-workflow validation changed bytes");
  const reupgradeHarness = path.join(invocationDir, "harness-reupgraded-custom");
  fs.mkdirSync(reupgradeHarness, { recursive: true });
  const customLaunch = parseLastJson(run(ttCli, [
    "workflow", "run", "puma-custom-probe", "Complete preserved custom workflow after re-upgrade",
    "--working-directory-for-harness", reupgradeHarness,
    "--wait", "--timeout", "3m", "--json",
  ], { env: ttEnv, timeout: 4 * 60_000 }).stdout);
  const customRecord = Array.isArray(customLaunch.runs) ? customLaunch.runs[0] : customLaunch;
  assert.equal(customRecord.status, "completed");

  const tokens = tokenInventory();
  assert.ok(tokens.runs.every((row) => Number(row.tokens_spent) === 0),
    "downgrade/re-upgrade legs observed run tokens");
  assert.equal(tokens.system_tokens_spent, 0,
    "downgrade/re-upgrade legs moved the system token tripwire");

  evidence = {
    scenario: "W4.25",
    leg: "downgrade-reupgrade",
    puma_commit: actualPuma,
    tt_commit: ttCommit,
    forward_boundary,
    downgrade_boundary,
    reupgrade_boundary,
    downgrade_outcome: {
      route: downgradeRoute,
      diagnostic: downgradeRefused ? downgradeDiagnostic : null,
      silent_user_version_reduction,
      repeated_ddl,
      lost_migration_evidence,
      changed_ddl,
      changed_historical_run_rows,
      custom_workflow_mutation,
      findings,
    },
    migration_idempotent,
    doctor: "zero-errors",
    historical_runs_rendered: forward_boundary.historical_run_rows.length,
    custom_workflow_validated: true,
    custom_workflow_listed: true,
    custom_workflow_completed: true,
    tokens_spent: tokens.runs.reduce((sum, row) => sum + Number(row.tokens_spent), 0),
    system_tokens_spent: tokens.system_tokens_spent,
  };
} catch (error) {
  primaryError = error;
}

const cleanupErrors = [];
if (pumaTouched) {
  try { daemonControl("stop", pumaBinDir, true); } catch (error) { cleanupErrors.push(error); }
}
if (ttTouched) {
  try { daemonControl("stop", ttBinDir, true); } catch (error) { cleanupErrors.push(error); }
}
try { daemonControl("stop", path.join(repoRoot, "bin"), true); } catch (error) { cleanupErrors.push(error); }
try { await assertPortsFree(); } catch (error) { cleanupErrors.push(error); }
try { assert.equal(gitStatus(), checkoutStatusBefore, "downgrade/re-upgrade legs mutated the developer checkout"); } catch (error) { cleanupErrors.push(error); }
if (cleanupErrors.length > 0) {
  throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
    "W4.25 downgrade/re-upgrade cleanup failed; contained evidence was preserved");
}
fs.rmSync(scriptedHome, { recursive: true, force: true });
if (primaryError) throw primaryError;
evidence.cleanup = { daemon: "stopped", ports: "free", version_processes: "stopped", state: "removed", checkout: "unchanged" };
evidence.result = "PASS";
process.stdout.write(`${JSON.stringify(evidence)}\n`);

function versionEnvironment(versionDir, workflowSource) {
  return {
    ...process.env,
    HOME: scriptedHome,
    TAMANDUA_STATE_DIR: scriptedStateDir,
    TAMANDUA_CONTROL_PORT: "5339",
    TAMANDUA_MCP_PORT: "5338",
    TAMANDUA_DASHBOARD_PORT: "5334",
    TAMANDUA_PI_BINARY: scriptedRuntime,
    TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsFile,
    TAMANDUA_SCRIPTED_STATE: workCountDir,
    TAMANDUA_WORKFLOWS_SRC: workflowSource,
    PATH: `${doctorToolsDir}:${localBin}:${path.join(versionDir, "bin")}:${hostToolPath}`,
  };
}

function swapInstalledCli(target) {
  fs.mkdirSync(localBin, { recursive: true });
  fs.rmSync(installedCli, { force: true });
  fs.symlinkSync(target, installedCli, "file");
  assert.equal(fs.realpathSync(installedCli), fs.realpathSync(target),
    `contained local-install symlink did not select ${target}`);
}

function databaseInventory() {
  const db = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const user_version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  const schema_inventory = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  const historical_run_rows = db.prepare(
    "SELECT id, workflow_id, status, tokens_spent, created_at, updated_at FROM runs ORDER BY id",
  ).all();
  const stepColumns = db.prepare("PRAGMA table_info(steps)").all().map((row) => String(row.name)).sort();
  db.close();
  return {
    user_version,
    schema_inventory,
    historical_run_rows,
    migration_evidence: { step_columns: stepColumns },
    custom_workflow_inventory: assertCustomWorkflowInventory(),
  };
}

function tokenInventory() {
  const db = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const runs = db.prepare("SELECT id, tokens_spent FROM runs ORDER BY id").all();
  const system_tokens_spent = Number(db.prepare(
    "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
  ).get()?.system_tokens_spent);
  db.close();
  return { runs, system_tokens_spent };
}

function assertCustomWorkflowInventory() {
  return fs.readFileSync(path.join(scenarioDir, "custom-workflow.sha256"), "utf8").trim().split("\n").map((line) => {
    const match = line.match(/^([0-9a-f]{64})  custom-workflow\/(.+)$/);
    assert.ok(match, `invalid custom-workflow inventory line: ${line}`);
    const installed = path.join(scriptedStateDir, "workflows", "puma-custom-probe", match[2]);
    const actual = createHash("sha256").update(fs.readFileSync(installed)).digest("hex");
    assert.equal(actual, match[1], `custom workflow bytes changed: ${match[2]}`);
    return { path: match[2], sha256: actual };
  });
}

function productFinding(code, finding) {
  return { status: "PRODUCT_FINDING", code, finding };
}

function deepEqual(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function daemonControl(operation, binaryDir, strict) {
  const result = spawnSync(daemonControlPath, ["scripted", operation], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: operatorHome,
      PATH: `${binaryDir}:${hostToolPath}`,
      TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsFile,
      TAMANDUA_SCRIPTED_STATE: workCountDir,
    },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (strict && result.status !== 0) {
    throw new Error(`daemon-control scripted ${operation} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function parseLastJson(output) {
  const line = output.trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
  assert.ok(line, `no JSON object in output:\n${output}`);
  return JSON.parse(line);
}

function gitStatus() {
  return run(git, ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, env: gitEnv }).stdout;
}

function requiredContainedEnv(name) {
  const value = process.env[name];
  assert.ok(value, `missing scenario environment: ${name}`);
  const resolved = path.resolve(value);
  const canonical = fs.realpathSync(resolved);
  const root = fs.realpathSync(path.join(repoRoot, "torture-test", "var"));
  assert.equal(canonical, resolved, `${name} contains a symlinked path component`);
  assert.ok(canonical.startsWith(`${root}${path.sep}`), `${name} escaped torture-test/var`);
  return canonical;
}

function resolveOperatorHome() {
  const getent = fs.existsSync("/usr/bin/getent") ? "/usr/bin/getent" : "/bin/getent";
  const result = spawnSync(getent, ["passwd", String(process.getuid())], { encoding: "utf8" });
  const home = result.status === 0 ? result.stdout.trim().split(":")[5] : "";
  assert.ok(home && path.isAbsolute(home), "could not resolve operator HOME for daemon-control");
  return home;
}

function trustedCommandPath(command) {
  for (const directory of ["/usr/bin", "/bin"]) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error(`${command} is required in a trusted tool directory`);
}

function isolatedGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].includes(key)
        || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runAllow(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function run(command, args, options = {}) {
  const result = runAllow(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function assertPortsFree() {
  for (const port of [5334, 5338, 5339]) {
    assert.equal(await portIsOpen(port), false, `scripted port ${port} leaked after cleanup`);
  }
}

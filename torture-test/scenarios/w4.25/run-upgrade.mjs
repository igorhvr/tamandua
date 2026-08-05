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
const expectedPuma = String(fixture.puma_commit);
const operatorHome = resolveOperatorHome();
const daemonControlPath = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const scriptedRuntime = path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-pi");
const git = trustedCommandPath("git");
const hostToolPath = [...new Set([path.dirname(git), "/usr/bin", "/bin"])].join(path.delimiter);
const gitEnv = isolatedGitEnvironment();
const actualPuma = run(git, ["rev-parse", "refs/tags/puma^{commit}"], { cwd: repoRoot, env: gitEnv }).stdout.trim();
const head = run(git, ["rev-parse", "HEAD"], { cwd: repoRoot, env: gitEnv }).stdout.trim();
const ttCommit = String(process.env.TT_COMMIT || head);
const preserveUpgrade = process.argv.includes("--preserve");
assert.equal(actualPuma, expectedPuma, `puma tag moved: expected ${expectedPuma}, got ${actualPuma}`);
assert.equal(ttCommit, head, `TT_COMMIT ${ttCommit} does not match checkout HEAD ${head}`);

if (process.argv.includes("--check")) {
  process.stdout.write(`${JSON.stringify({ scenario: "W4.25", leg: "forward-upgrade", puma_commit: actualPuma, tt_commit: ttCommit, result: "PASS" })}\n`);
  process.exit(0);
}

assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "upgrade leg must run inside the harness-proven process group");
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

const ttVersionDir = path.join(invocationDir, "versions", "tt-commit");
const ttCli = path.join(ttVersionDir, "bin", "tamandua");
const ttBinDir = path.join(ttVersionDir, "bin");
const customCatalog = path.join(invocationDir, "puma-catalog");
const upgradeBehaviors = path.join(invocationDir, "upgrade-behaviors.json");
const workCountDir = path.join(invocationDir, "upgrade-work-count");
const doctorToolsDir = path.join(invocationDir, "doctor-tools");
const localBin = path.join(scriptedHome, ".local", "bin");
const checkoutStatusBefore = gitStatus();
let daemonTouched = false;
let evidence;
let primaryError;

try {
  const fixtureResult = parseLastJson(run(process.execPath, [path.join(scenarioDir, "prepare-fixture.mjs"), "--preserve"], {
    cwd: repoRoot,
    env: process.env,
    timeout: 25 * 60_000,
  }).stdout);
  assert.equal(fixtureResult.result, "PASS");
  assert.equal(fixtureResult.cleanup.state, "preserved-for-upgrade");

  fs.mkdirSync(workCountDir, { recursive: true });
  fs.copyFileSync(path.join(scenarioDir, "upgrade-behaviors.json"), upgradeBehaviors);
  fs.mkdirSync(doctorToolsDir, { recursive: true });
  fs.symlinkSync(scriptedRuntime, path.join(doctorToolsDir, "pi"), "file");
  fs.symlinkSync("/usr/bin/true", path.join(doctorToolsDir, "gh"), "file");
  const preUpgradeInventory = assertCustomWorkflowInventory();

  // Reproduce the user-facing local install shape: swap the ~/.local/bin link to
  // the already-built TT_COMMIT tree, then refresh every bundled workflow.
  fs.mkdirSync(localBin, { recursive: true });
  fs.symlinkSync(ttCli, path.join(localBin, "tamandua"), "file");
  const ttEnv = ttEnvironment(path.join(ttVersionDir, "workflows"));
  run(path.join(localBin, "tamandua"), ["workflow", "install", "--all"], { env: ttEnv, timeout: 5 * 60_000 });
  const postRefreshInventory = assertCustomWorkflowInventory();
  assert.deepEqual(postRefreshInventory, preUpgradeInventory,
    "TT_COMMIT bundled refresh changed custom-workflow bytes");

  daemonTouched = true;
  daemonControl("start", ttBinDir, true);

  const doctor = run(ttCli, ["doctor"], { env: ttEnv });
  assert.match(doctor.stdout, /All checks passed(?:\.| with \d+ warning\(s\) -)/,
    `doctor did not report zero errors:\n${doctor.stdout}`);

  const historical = {};
  const fixtureHistory = new Map(fixtureResult.history.map((row) => [row.id, row]));
  const timestampFormats = new Set();
  const runsPayload = JSON.parse(run(ttCli, ["workflow", "runs", "--json"], { env: ttEnv }).stdout.trim());
  for (const [kind, runId] of Object.entries(fixtureResult.runs)) {
    const status = parseLastJson(run(ttCli, ["workflow", "status", runId, "--json"], { env: ttEnv }).stdout);
    const listed = runsPayload.runs.find((row) => row.runId === runId);
    assert.ok(listed, `runs --json omitted old ${kind} run ${runId}`);
    assert.equal(listed.status, status.status, `status skew for old ${kind} run`);
    assert.equal(listed.createdAt, status.createdAt, `createdAt skew for old ${kind} run`);
    assert.equal(listed.updatedAt, status.updatedAt, `updatedAt skew for old ${kind} run`);
    const pumaRow = fixtureHistory.get(runId);
    assert.ok(pumaRow, `fixture evidence omitted old ${kind} run ${runId}`);
    assert.equal(status.createdAt, pumaRow.created_at, `upgrade changed old ${kind} created timestamp bytes`);
    assert.equal(status.updatedAt, pumaRow.updated_at, `upgrade changed old ${kind} updated timestamp bytes`);
    timestampFormats.add(assertTimestampConsistent(status.createdAt, `${kind}.createdAt`));
    timestampFormats.add(assertTimestampConsistent(status.updatedAt, `${kind}.updatedAt`));
    const logs = run(ttCli, ["logs", runId], { env: ttEnv }).stdout;
    assert.doesNotMatch(logs, /^No (?:events|run)/m, `logs did not render old ${kind} run`);
    historical[kind] = { status: status.status, created_at: status.createdAt, updated_at: status.updatedAt, logs_rendered: true };
  }

  const resume = runAllow(ttCli, ["workflow", "resume", fixtureResult.runs.paused], { env: ttEnv });
  let resumeOutcome;
  if (resume.status === 0) {
    const resumed = waitForRunState(fixtureResult.runs.paused, "completed");
    resumeOutcome = { route: "completed", status: resumed.status };
  } else {
    const diagnostic = `${resume.stdout}\n${resume.stderr}`;
    assert.match(diagnostic, /(?:compatib|version|schema|workflow definition)/i,
      `paused-run resume failed without a compatibility diagnosis:\n${diagnostic}`);
    assert.equal(workflowStatus(ttCli, fixtureResult.runs.paused, ttEnv).status, "paused",
      "compatibility refusal corrupted the paused run");
    resumeOutcome = { route: "diagnosable-compatibility-refusal", diagnostic: diagnostic.trim() };
  }

  const customEnv = ttEnvironment(customCatalog);
  const available = JSON.parse(run(ttCli, ["workflow", "list", "--json"], { env: customEnv }).stdout.trim());
  assert.ok(available.some((row) => row.id === "puma-custom-probe"), "TT_COMMIT did not list the preserved custom workflow");
  run(ttCli, ["workflow", "install", "puma-custom-probe"], { env: customEnv });
  assert.deepEqual(assertCustomWorkflowInventory(), preUpgradeInventory,
    "TT_COMMIT custom-workflow validation changed installed bytes");
  fs.mkdirSync(path.join(invocationDir, "harness-upgraded-custom"), { recursive: true });
  const customLaunch = parseLastJson(run(ttCli, [
    "workflow", "run", "puma-custom-probe", "Complete preserved custom workflow after forward upgrade",
    "--working-directory-for-harness", path.join(invocationDir, "harness-upgraded-custom"),
    "--wait", "--timeout", "3m", "--json",
  ], { env: customEnv, timeout: 4 * 60_000 }).stdout);
  const customRecord = Array.isArray(customLaunch.runs) ? customLaunch.runs[0] : customLaunch;
  assert.equal(customRecord.status, "completed");

  const db = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const rows = db.prepare("SELECT id, status, tokens_spent, created_at, updated_at FROM runs ORDER BY created_at").all();
  const systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get()?.system_tokens_spent;
  db.close();
  assert.ok(rows.every((row) => Number(row.tokens_spent) === 0), "forward-upgrade leg observed run tokens");
  assert.equal(systemTokens, 0, "forward-upgrade leg moved the system token tripwire");
  let maxLegacyPrecisionSkewMs = 0;
  for (const row of rows) {
    timestampFormats.add(assertTimestampConsistent(row.created_at, `${row.id}.created_at`));
    timestampFormats.add(assertTimestampConsistent(row.updated_at, `${row.id}.updated_at`));
    const precisionSkewMs = parseTimestamp(row.created_at) - parseTimestamp(row.updated_at);
    maxLegacyPrecisionSkewMs = Math.max(maxLegacyPrecisionSkewMs, precisionSkewMs);
    assert.ok(precisionSkewMs < 1000,
      `${row.id} has created_at after updated_at beyond puma's subsecond truncation: ${precisionSkewMs}ms`);
  }

  evidence = {
    scenario: "W4.25",
    leg: "forward-upgrade",
    puma_commit: actualPuma,
    tt_commit: ttCommit,
    install_shape: "contained-local-symlink-plus-bundled-refresh",
    doctor: "zero-errors",
    historical_rendering: historical,
    timestamp_format_inventory: [...timestampFormats].sort(),
    timestamp_upgrade_skew: false,
    max_legacy_precision_skew_ms: maxLegacyPrecisionSkewMs,
    resume_outcome: resumeOutcome,
    bundled_refresh_preserved_custom_bytes: true,
    custom_workflow_validated: true,
    custom_workflow_listed: true,
    custom_workflow_completed: true,
    custom_workflow_inventory: postRefreshInventory,
    tokens_spent: rows.reduce((sum, row) => sum + Number(row.tokens_spent), 0),
    system_tokens_spent: systemTokens,
  };
} catch (error) {
  primaryError = error;
}

const cleanupErrors = [];
if (daemonTouched) {
  try { daemonControl("stop", ttBinDir, true); } catch (error) { cleanupErrors.push(error); }
}
try { daemonControl("stop", path.join(repoRoot, "bin"), true); } catch (error) { cleanupErrors.push(error); }
try { await assertPortsFree(); } catch (error) { cleanupErrors.push(error); }
try { assert.equal(gitStatus(), checkoutStatusBefore, "upgrade leg mutated the developer checkout"); } catch (error) { cleanupErrors.push(error); }
if (cleanupErrors.length > 0) {
  throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
    "W4.25 forward-upgrade cleanup failed; contained evidence was preserved");
}
if (!preserveUpgrade) fs.rmSync(scriptedHome, { recursive: true, force: true });
if (primaryError) throw primaryError;
evidence.cleanup = {
  daemon: "stopped",
  ports: "free",
  version_processes: "stopped",
  state: preserveUpgrade ? "preserved-for-downgrade" : "removed",
  checkout: "unchanged",
};
evidence.result = "PASS";
process.stdout.write(`${JSON.stringify(evidence)}\n`);

function ttEnvironment(workflowSource) {
  return {
    ...process.env,
    HOME: scriptedHome,
    TAMANDUA_STATE_DIR: scriptedStateDir,
    TAMANDUA_CONTROL_PORT: "5339",
    TAMANDUA_MCP_PORT: "5338",
    TAMANDUA_DASHBOARD_PORT: "5334",
    TAMANDUA_PI_BINARY: scriptedRuntime,
    TAMANDUA_SCRIPTED_BEHAVIORS: upgradeBehaviors,
    TAMANDUA_SCRIPTED_STATE: workCountDir,
    TAMANDUA_WORKFLOWS_SRC: workflowSource,
    PATH: `${doctorToolsDir}:${localBin}:${ttBinDir}:${hostToolPath}`,
  };
}

function daemonControl(operation, binaryDir, strict) {
  const result = spawnSync(daemonControlPath, ["scripted", operation], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: operatorHome,
      PATH: `${binaryDir}:${hostToolPath}`,
      TAMANDUA_SCRIPTED_BEHAVIORS: upgradeBehaviors,
      TAMANDUA_SCRIPTED_STATE: workCountDir,
    },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (strict && result.status !== 0) {
    throw new Error(`daemon-control scripted ${operation} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
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

function assertTimestampConsistent(value, label) {
  assert.equal(typeof value, "string", `${label} is not a string timestamp`);
  const format = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ? "iso-8601-utc-ms"
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? "sqlite-utc-seconds"
      : undefined;
  assert.ok(format, `${label} has unrecognized timestamp-format skew: ${value}`);
  assert.ok(Number.isFinite(parseTimestamp(value)), `${label} is not a valid UTC timestamp: ${value}`);
  return format;
}

function parseTimestamp(value) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return Date.parse(normalized);
}

function waitForRunState(runId, expected) {
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    const status = workflowStatus(ttCli, runId, ttEnvironment(path.join(ttVersionDir, "workflows")));
    if (status.status === expected) return status;
    if (["failed", "canceled"].includes(status.status)) throw new Error(`run ${runId} reached ${status.status}, expected ${expected}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

function workflowStatus(cli, runId, env) {
  return parseLastJson(run(cli, ["workflow", "status", runId, "--json"], { env }).stdout);
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

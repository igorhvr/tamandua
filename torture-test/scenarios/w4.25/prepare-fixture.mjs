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
const inventoryFile = path.join(scenarioDir, "custom-workflow.sha256");
const customSource = path.join(scenarioDir, "custom-workflow");
const operatorHome = resolveOperatorHome();
const git = trustedCommandPath("git");
const npm = trustedCommandPath("npm");
const tar = trustedCommandPath("tar");
const cp = trustedCommandPath("cp");
const hostToolPath = [...new Set([
  path.dirname(git),
  path.dirname(npm),
  path.dirname(tar),
  path.dirname(cp),
  "/usr/bin",
  "/bin",
])].join(path.delimiter);
const daemonControlPath = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const scriptedRuntime = path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-pi");
const gitEnvironment = isolatedGitEnvironment({ GIT_ALLOW_PROTOCOL: "file" });
const expectedPuma = String(fixture.puma_commit);
const actualPuma = runGit(["rev-parse", "refs/tags/puma^{commit}"]).stdout.trim();
const head = runGit(["rev-parse", "HEAD"]).stdout.trim();
const ttCommit = String(process.env.TT_COMMIT || head);

assert.equal(actualPuma, expectedPuma, `puma tag moved: expected ${expectedPuma}, got ${actualPuma}`);
assert.equal(ttCommit, head, `TT_COMMIT ${ttCommit} does not match checkout HEAD ${head}`);
assert.equal(runGit(["cat-file", "-t", ttCommit]).stdout.trim(), "commit");
const customWorkflowInventory = verifyInventory();
const preserveFixture = process.argv.includes("--preserve");

if (process.argv[2] === "--check") {
  process.stdout.write(`${JSON.stringify({
    scenario: "W4.25",
    puma_commit: actualPuma,
    tt_commit: ttCommit,
    custom_workflow_inventory: customWorkflowInventory,
    result: "PASS",
  })}\n`);
  process.exit(0);
}

const invocationDir = requiredContainedEnv("TT_SCENARIO_STATE_DIR");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "fixture must run inside the harness-proven process group");
const scriptedStateDir = requiredContainedEnv("TAMANDUA_STATE_DIR");
const scriptedHome = requiredContainedEnv("HOME");
const varRoot = fs.realpathSync(path.join(repoRoot, "torture-test", "var"));
const scenarioMetadata = JSON.parse(fs.readFileSync(path.join(scenarioDir, "scenario.json"), "utf8"));
assert.equal(scriptedHome, path.join(varRoot, "home-scripted"),
  "HOME must be the exact scripted harness home");
assert.equal(scriptedStateDir, path.join(scriptedHome, ".tamandua"),
  "TAMANDUA_STATE_DIR must be the exact scripted harness state directory");
assert.equal(path.dirname(invocationDir), fs.realpathSync(path.join(varRoot, "scenarios")),
  "TT_SCENARIO_STATE_DIR must be a direct scripted-scenario invocation");
assert.ok(path.basename(invocationDir).startsWith(`${scenarioMetadata.id}-`),
  "TT_SCENARIO_STATE_DIR must be owned by this scenario");
const versionsDir = path.join(invocationDir, "versions");
const pumaVersionDir = path.join(versionsDir, "puma");
const ttVersionDir = path.join(versionsDir, "tt-commit");
const catalogDir = path.join(invocationDir, "puma-catalog");
const behaviorsFile = path.join(invocationDir, "puma-behaviors.json");
const workCountDir = path.join(invocationDir, "puma-work-count");
const pumaCli = path.join(pumaVersionDir, "bin", "tamandua");
const pumaBinDir = path.join(pumaVersionDir, "bin");
const harnessDirs = {
  completed: path.join(invocationDir, "harness-completed"),
  paused: path.join(invocationDir, "harness-paused"),
  failed: path.join(invocationDir, "harness-failed"),
};
const checkoutStatusBefore = gitStatus();
let daemonTouched = false;
let evidence;
let primaryError;

try {
  // daemon-control scripted stop: establish an exclusive, listener-free reset barrier.
  daemonControl("stop", path.join(repoRoot, "bin"), true);
  await assertPortsFree();
  resetScriptedHome();
  fs.mkdirSync(versionsDir, { recursive: true });

  // git archive materializes committed bytes without changing the developer checkout.
  materializeVersion(expectedPuma, expectedPuma, pumaVersionDir);
  materializeVersion(ttCommit, ttCommit, ttVersionDir);

  fs.mkdirSync(catalogDir, { recursive: true });
  for (const harnessDir of Object.values(harnessDirs)) fs.mkdirSync(harnessDir, { recursive: true });
  fs.cpSync(path.join(pumaVersionDir, "workflows", "do-now"), path.join(catalogDir, "do-now"), { recursive: true });
  fs.cpSync(customSource, path.join(catalogDir, "puma-custom-probe"), { recursive: true });
  fs.mkdirSync(workCountDir, { recursive: true });
  fs.copyFileSync(path.join(scenarioDir, "puma-behaviors.json"), behaviorsFile);

  const cliEnv = pumaEnvironment();
  // Installation is puma's schema-validation boundary; listing proves the same
  // versioned catalog can discover the custom workflow before state is aged.
  run(pumaCli, ["workflow", "install", "do-now"], { env: cliEnv });
  run(pumaCli, ["workflow", "install", "puma-custom-probe"], { env: cliEnv });
  const listed = JSON.parse(run(pumaCli, ["workflow", "list", "--json"], { env: cliEnv }).stdout.trim());
  assert.ok(listed.some((entry) => entry.id === "puma-custom-probe"),
    "puma workflow list omitted puma-custom-probe");
  assertInstalledCustomBytes();

  // daemon-control scripted start: PATH selects the contained puma binary.
  daemonTouched = true;
  daemonControl("start", pumaBinDir, true);

  const completedLaunch = run(pumaCli, [
    "workflow", "run", "puma-custom-probe", "Complete the puma custom fixture once",
    "--working-directory-for-harness", harnessDirs.completed, "--wait", "--timeout", "3m", "--json",
  ], { env: cliEnv, timeout: 4 * 60_000 });
  const completedWait = parseLastJson(completedLaunch.stdout);
  const completedRecord = Array.isArray(completedWait.runs) ? completedWait.runs[0] : completedWait;
  const completedRunId = String(completedRecord.runId ?? completedRecord.run_id);
  assert.equal(completedRecord.status, "completed"); // status completed

  const pausedLaunch = run(pumaCli, [
    "workflow", "run", "do-now", "Create a mechanically paused puma run",
    "--working-directory-for-harness", harnessDirs.paused,
  ], { env: cliEnv });
  const pausedRunId = parseRunId(pausedLaunch.stdout);
  waitForRunState(pausedRunId, "running", true);
  run(pumaCli, ["workflow", "pause", pausedRunId], { env: cliEnv });
  const pausedStatus = workflowStatus(pumaCli, pausedRunId, cliEnv);
  assert.equal(pausedStatus.status, "paused"); // status paused

  const failedLaunch = run(pumaCli, [
    "workflow", "run", "do-now", "Create a mechanically failed puma run",
    "--working-directory-for-harness", harnessDirs.failed,
  ], { env: cliEnv });
  const failedRunId = parseRunId(failedLaunch.stdout);
  waitForRunState(failedRunId, "running", false);
  run(pumaCli, ["workflow", "fail", failedRunId, "--reason", "W4.25 deterministic aged-state fixture", "--force"], { env: cliEnv });
  const failedStatus = workflowStatus(pumaCli, failedRunId, cliEnv);
  assert.equal(failedStatus.status, "failed"); // status failed

  const db = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const history = db.prepare("SELECT id, workflow_id, status, tokens_spent, created_at, updated_at FROM runs ORDER BY created_at").all();
  const systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get()?.system_tokens_spent;
  db.close();
  assert.deepEqual(history.map((row) => row.status).sort(), ["completed", "failed", "paused"]);
  assert.ok(history.every((row) => row.tokens_spent === 0), "puma aged-state history spent tokens");
  assert.equal(systemTokens, 0, "system token tripwire moved");

  evidence = {
    scenario: "W4.25",
    puma_commit: actualPuma,
    tt_commit: ttCommit,
    version_directories: {
      puma: path.relative(invocationDir, pumaVersionDir),
      tt_commit: path.relative(invocationDir, ttVersionDir),
    },
    custom_workflow_inventory: customWorkflowInventory,
    custom_workflow_listed: true,
    custom_workflow_validated_by_install: true,
    runs: {
      completed: completedRunId,
      paused: pausedRunId,
      failed: failedRunId,
    },
    history: history.map((row) => ({ ...row, id: `run-${row.id}` })),
    tokens_spent: history.reduce((sum, row) => sum + Number(row.tokens_spent), 0),
    system_tokens_spent: systemTokens,
  };
} catch (error) {
  primaryError = error;
}

const cleanupErrors = [];
if (daemonTouched) {
  try { daemonControl("stop", pumaBinDir, true); } catch (error) { cleanupErrors.push(error); }
}
try { daemonControl("stop", path.join(repoRoot, "bin"), true); } catch (error) { cleanupErrors.push(error); }
try { await assertPortsFree(); } catch (error) { cleanupErrors.push(error); }
try {
  assert.equal(gitStatus(), checkoutStatusBefore, "fixture mutated the developer checkout");
} catch (error) {
  cleanupErrors.push(error);
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
    "W4.25 fixture cleanup failed; contained evidence was preserved");
}
if (!preserveFixture) fs.rmSync(scriptedHome, { recursive: true, force: true });
if (primaryError) throw primaryError;
evidence.cleanup = {
  daemon: "stopped",
  ports: "free",
  checkout: "unchanged",
  state: preserveFixture ? "preserved-for-upgrade" : "removed",
};
evidence.result = "PASS";
process.stdout.write(`${JSON.stringify(evidence)}\n`);

function materializeVersion(ref, commit, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const archive = path.join(invocationDir, `${path.basename(destination)}.tar`);
  runGit(["archive", "--format=tar", "--output", archive, ref]);
  run(tar, ["-xf", archive, "-C", destination]);
  fs.rmSync(archive, { force: true });
  const dependencyDir = path.join(destination, "node_modules");
  fs.mkdirSync(dependencyDir, { recursive: true });
  run(cp, ["-a", "--reflink=auto", `${path.join(repoRoot, "node_modules")}${path.sep}.`, dependencyDir], {
    timeout: 5 * 60_000,
  });
  // npm run build executes entirely from the local source/dependency snapshot.
  run(npm, ["run", "build"], {
    cwd: destination,
    env: { ...process.env, PATH: hostToolPath },
    timeout: 10 * 60_000,
  });
  assert.ok(fs.existsSync(path.join(destination, "dist", "cli", "cli.js")), `${ref} did not build a CLI`);
  fs.writeFileSync(path.join(destination, ".tt-source-identity.json"), `${JSON.stringify({ ref, commit })}\n`);
}

function resetScriptedHome() {
  fs.rmSync(scriptedHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(scriptedHome, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(scriptedHome, ".pi", "agent", "settings.json"), "{}\n");
}

function pumaEnvironment() {
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
    TAMANDUA_WORKFLOWS_SRC: catalogDir,
    PATH: `${pumaBinDir}:${hostToolPath}`,
  };
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
  return result;
}

function workflowStatus(cli, runId, env) {
  return parseLastJson(run(cli, ["workflow", "status", runId, "--json"], { env }).stdout);
}

function waitForRunState(runId, expectedStatus, requireRunningStep) {
  const dbPath = path.join(scriptedStateDir, "tamandua.db");
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const bareId = runId.replace(/^run-/, "");
      const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(bareId);
      const runningStep = db.prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ? AND status = 'running'").get(bareId)?.count;
      db.close();
      if (row?.status === expectedStatus && (!requireRunningStep || Number(runningStep) > 0)) return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  const diagnostic = fs.existsSync(dbPath)
    ? (() => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare("SELECT r.status, s.status AS step_status, s.output FROM runs r LEFT JOIN steps s ON s.run_id = r.id WHERE r.id = ?").get(runId.replace(/^run-/, ""));
        db.close();
        return row;
      })()
    : { database: "missing" };
  throw new Error(`run ${runId} did not reach ${expectedStatus}: ${JSON.stringify(diagnostic)}`);
}

function parseRunId(output) {
  const match = output.match(/^Run:\s+(run-[0-9a-f-]+)$/m);
  assert.ok(match, `no run id in puma output:\n${output}`);
  return match[1];
}

function parseLastJson(output) {
  const line = output.trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
  assert.ok(line, `no JSON object in output:\n${output}`);
  return JSON.parse(line);
}

function verifyInventory() {
  const entries = fs.readFileSync(inventoryFile, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^([0-9a-f]{64})  (custom-workflow\/.+)$/);
    assert.ok(match, `invalid custom workflow inventory line: ${line}`);
    const file = path.join(scenarioDir, match[2]);
    const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.equal(actual, match[1], `custom workflow bytes changed: ${match[2]}`);
    return { path: match[2], sha256: actual };
  });
  assert.ok(entries.length >= 2, "custom workflow inventory is incomplete");
  return entries;
}

function assertInstalledCustomBytes() {
  for (const entry of customWorkflowInventory) {
    const relative = entry.path.replace(/^custom-workflow\//, "");
    const installed = path.join(scriptedStateDir, "workflows", "puma-custom-probe", relative);
    assert.equal(createHash("sha256").update(fs.readFileSync(installed)).digest("hex"), entry.sha256,
      `puma installation changed custom workflow bytes: ${relative}`);
  }
}

function gitStatus() {
  return runGit(["status", "--porcelain", "--untracked-files=all"]).stdout;
}

function runGit(args) {
  return run(git, args, { cwd: repoRoot, env: gitEnvironment });
}

function requiredContainedEnv(name) {
  const value = process.env[name];
  assert.ok(value, `missing scenario environment: ${name}`);
  const resolved = path.resolve(value);
  const varRoot = fs.realpathSync(path.join(repoRoot, "torture-test", "var"));
  const canonical = fs.realpathSync(resolved);
  assert.equal(canonical, resolved, `${name} contains a symlinked path component: ${resolved}`);
  assert.ok(canonical.startsWith(`${varRoot}${path.sep}`), `${name} escaped torture-test/var: ${canonical}`);
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
  const trustedRoots = ["/bin", "/usr/bin", "/usr/share/nodejs", "/nix/store"];
  for (const directory of ["/usr/bin", "/bin"]) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const canonical = fs.realpathSync(candidate);
      const inTrustedRoot = (value) => trustedRoots.some((root) =>
        value === root || value.startsWith(`${root}${path.sep}`));
      assert.ok(inTrustedRoot(candidate) && inTrustedRoot(canonical),
        `refusing untrusted ${command} executable: ${candidate} -> ${canonical}`);
      return candidate;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
  }
  throw new Error(`${command} is required in a trusted tool directory`);
}

function isolatedGitEnvironment(extra = {}) {
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
    ...extra,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
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

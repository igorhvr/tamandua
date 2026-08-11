#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = requiredEnv("TT_REPO_ROOT");
const invocationDir = requiredEnv("TT_SCENARIO_STATE_DIR");
const workflowId = requiredValue("TT_SCENARIO_WORKFLOW_ID");
const scriptedStateDir = requiredEnv("TAMANDUA_STATE_DIR");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");

const disposableHome = path.join(invocationDir, "home-disposable");
const operatorHome = resolveOperatorHome();
const remote = path.join(invocationDir, "remote.git");
const seed = path.join(invocationDir, "remote-seed");
const tools = path.join(invocationDir, "tools");
const tempDir = path.join(invocationDir, "tmp");
const gitLog = path.join(invocationDir, "git-commands.log");
const npmLog = path.join(invocationDir, "npm-log.jsonl");
const installRepo = path.join(disposableHome, ".tamandua", "repo");
const installedCli = path.join(disposableHome, ".local", "bin", "tamandua");
const installedStateDir = path.join(disposableHome, ".tamandua");
const daemonControl = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const sourceInstaller = path.join(repoRoot, "scripts", "install.sh");
const realGit = commandPath("git");
const realNpm = commandPath("npm");

for (const candidate of [invocationDir, disposableHome, remote, seed, tools, tempDir]) {
  assert.ok(candidate === invocationDir || candidate.startsWith(`${invocationDir}${path.sep}`),
    `W0.9 mutable path escaped torture-test/var: ${candidate}`);
}
fs.mkdirSync(path.join(disposableHome, ".pi", "agent"), { recursive: true });
fs.mkdirSync(tools, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });
fs.writeFileSync(path.join(disposableHome, ".pi", "agent", "settings.json"), "{}\n");

const baseEnv = {
  ...process.env,
  HOME: disposableHome,
  TAMANDUA_STATE_DIR: installedStateDir,
  NPM_CONFIG_CACHE: path.join(disposableHome, ".npm"),
  TMPDIR: tempDir,
  PATH: `${tools}:${process.env.PATH ?? ""}`,
  TT_W09_REAL_GIT: realGit,
  TT_W09_REAL_NPM: realNpm,
  TT_W09_REMOTE_URL: `file://${remote}`,
  TT_W09_GIT_LOG: gitLog,
  TT_W09_NPM_LOG: npmLog,
};

let evidence;
try {
  createWrappers();
  run(realGit, ["clone", "--bare", "--no-local", repoRoot, remote], { env: process.env });
  const ttCommit = run(realGit, ["rev-parse", "HEAD"], { cwd: repoRoot, env: process.env }).stdout.trim();
  run(realGit, ["--git-dir", remote, "update-ref", "refs/heads/main", ttCommit], { env: process.env });
  run(realGit, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { env: process.env });
  run(realGit, ["clone", `file://${remote}`, seed], { env: process.env });
  run(realGit, ["config", "user.email", "w0.9@tamandua.local"], { cwd: seed });
  run(realGit, ["config", "user.name", "W0.9 Scenario"], { cwd: seed });

  const firstInstall = run("bash", [sourceInstaller], { env: baseEnv, timeout: 20 * 60_000 });
  assert.match(firstInstall.stdout, /Cloning repository/);
  assert.ok(fs.existsSync(path.join(installRepo, ".git", "shallow")),
    "installed checkout must retain the shallow boundary");
  assert.equal(run(realGit, ["rev-list", "--count", "HEAD"], { cwd: installRepo }).stdout.trim(), "1",
    "remote installer must produce a depth-1 checkout");
  assert.ok(fs.existsSync(path.join(installRepo, "dist", "cli", "cli.js")), "dist CLI was not built");
  assert.equal(fs.realpathSync(installedCli), fs.realpathSync(path.join(installRepo, "bin", "tamandua")),
    "~/.local/bin/tamandua does not resolve into the shallow install");
  const npmCommandsAfterInstall = lines(npmLog);
  assert.ok(npmCommandsAfterInstall.includes("install"), "remote installer did not run npm install");
  assert.equal(npmCommandsAfterInstall.includes("ci"), false, "remote installer must not run npm ci");
  const installedWorkflows = fs.readdirSync(path.join(installedStateDir, "workflows"));
  assert.ok(installedWorkflows.includes("do-now"), "bundled workflows were not installed");

  const doctor = run(installedCli, ["doctor"], {
    env: {
      ...baseEnv,
      HOME: process.env.HOME,
      HERMES_HOME: process.env.HERMES_HOME,
      TAMANDUA_STATE_DIR: scriptedStateDir,
    },
    timeout: 60_000,
  });
  assert.doesNotMatch(doctor.stdout, /^\s*FAIL\b/m, `doctor reported errors:\n${doctor.stdout}`);

  const launch = run(installedCli, [
    "workflow", "run", workflowId, "Prove the W0.9 installed symlink path",
    "--working-directory-for-harness", seed,
    "--wait", "--timeout", "3m", "--json",
  ], {
    cwd: repoRoot,
    env: {
      ...baseEnv,
      HOME: process.env.HOME,
      HERMES_HOME: process.env.HERMES_HOME,
      TAMANDUA_STATE_DIR: scriptedStateDir,
    },
    timeout: 4 * 60_000,
  });
  const waitResult = JSON.parse(launch.stdout.trim().split("\n").at(-1));
  const runRecord = Array.isArray(waitResult.runs) ? waitResult.runs[0] : waitResult;
  const runId = String(runRecord?.runId ?? runRecord?.run_id ?? "").replace(/^run-/, "");
  assert.ok(runId, `installed-symlink workflow returned no run id: ${launch.stdout}`);
  assert.equal(runRecord?.status, "completed", `scripted do-now did not complete: ${launch.stdout}`);
  const db = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const runRow = db.prepare("SELECT status, tokens_spent FROM runs WHERE id = ?").get(runId);
  const systemRow = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get();
  db.close();
  assert.equal(runRow?.status, "completed");
  assert.equal(runRow?.tokens_spent, 0, "scripted do-now spent tokens");
  assert.equal(systemRow?.system_tokens_spent, 0, "system token tripwire moved");

  const marker = path.join(seed, "torture-test", "w0.9-update-marker.txt");
  fs.writeFileSync(marker, "W0.9 remote fast-forward marker\n");
  run(realGit, ["add", "torture-test/w0.9-update-marker.txt"], { cwd: seed });
  run(realGit, ["commit", "-m", "test: advance W0.9 local remote"], { cwd: seed });
  run(realGit, ["push", "origin", "main"], { cwd: seed });
  const advancedHead = run(realGit, ["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();

  const beforeUpdate = run(realGit, ["rev-parse", "HEAD"], { cwd: installRepo }).stdout.trim();
  const update = run(installedCli, ["update"], { cwd: installRepo, env: baseEnv, timeout: 20 * 60_000 });
  const afterUpdate = run(realGit, ["rev-parse", "HEAD"], { cwd: installRepo }).stdout.trim();
  assert.notEqual(beforeUpdate, afterUpdate, "update did not advance the shallow install");
  assert.equal(afterUpdate, advancedHead, "update did not reach the local bare's main tip");
  run(realGit, ["merge-base", "--is-ancestor", beforeUpdate, afterUpdate], { cwd: installRepo });
  assert.match(update.stdout, /Source updated:/);

  fs.appendFileSync(path.join(installRepo, "package.json"), "\n");
  const reinstall = run("bash", [sourceInstaller], { env: baseEnv, timeout: 20 * 60_000 });
  assert.match(reinstall.stdout, /Updating existing installation/);
  assert.equal(run(realGit, ["status", "--porcelain"], { cwd: installRepo }).stdout, "",
    "reset-hard reinstall did not restore a clean checkout");
  const gitCommands = fs.readFileSync(gitLog, "utf8");
  assert.match(gitCommands, /^clone\t--depth\t1\t--branch\tmain\thttps:\/\/github\.com\/igorhvr\/tamandua\.git\t/m);
  assert.match(gitCommands, /^pull\t--ff-only\t$/m);
  assert.match(gitCommands, /^reset\t--hard\torigin\/main\t$/m, "reinstall did not exercise reset --hard");

  run(installedCli, ["uninstall", "--force"], { env: baseEnv, timeout: 60_000 });
  const workflowRoot = path.join(installedStateDir, "workflows");
  const remainingWorkflowArtifacts = fs.existsSync(workflowRoot)
    ? fs.readdirSync(workflowRoot).filter((entry) => entry !== ".catalog-version.json")
    : [];
  assert.deepEqual(remainingWorkflowArtifacts, [],
    "tamandua uninstall left installed workflows behind");

  // The product uninstall owns runtime artifacts, not the source checkout or shell
  // links. Remove those scenario-owned delivery artifacts before the harness removes
  // the enclosing disposable HOME.
  fs.rmSync(installRepo, { recursive: true, force: true });
  fs.rmSync(path.join(disposableHome, ".local"), { recursive: true, force: true });
  assert.equal(fs.existsSync(installRepo), false);
  assert.equal(fs.existsSync(installedCli), false);

  evidence = {
    scenario: "W0.9",
    install_head: beforeUpdate,
    updated_head: afterUpdate,
    shallow: true,
    npm_install_observed: true,
    npm_ci_observed: false,
    doctor_errors: 0,
    bundled_workflows: installedWorkflows.length,
    run_id: `run-${runId}`,
    tokens_spent: runRow.tokens_spent,
    system_tokens_spent: systemRow.system_tokens_spent,
    update: "fast-forward",
    reinstall: "reset --hard",
    uninstall: "clean",
    result: "PASS",
  };
} finally {
  // run-scripted-scenario also stops in its EXIT trap; this local barrier makes
  // every W0.9 leg independently stop the sanctioned scripted daemon first.
  // FIX10 US-004: daemon-control must receive the OPERATOR home (like the
  // harness daemon_control() handoff) so its production-guard derivation
  // (REAL_TAMANDUA_STATE, is_production_cwd) can distinguish the real
  // production state from TT state. With the CONTAINED HOME it would refuse
  // every operation (fail closed — safe, but this barrier would silently no-op)
  // and with the real HOME its guard_kind_containment still forces the KIND's
  // spawn env (HOME + TAMANDUA_STATE_DIR) to stay inside torture-test/var, and
  // every daemon child gets the contained env via env -i env_for_kind. No
  // git-identity write can reach the operator home through this chain.
  spawnSync(daemonControl, ["scripted", "stop"], {
    cwd: repoRoot,
    env: { ...process.env, HOME: operatorHome },
    encoding: "utf8",
    timeout: 30_000,
  });
}

process.stdout.write(`${JSON.stringify(evidence)}\n`);

function requiredValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing scenario environment: ${name}`);
  return value;
}

function requiredEnv(name) {
  const value = requiredValue(name);
  return path.resolve(value);
}

function commandPath(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`${command} is required`);
  return result.stdout.trim();
}

// FIX10 US-004: daemon-control's production-guard derivation needs the REAL
// operator home (REAL_TAMANDUA_STATE, is_production_cwd); the daemon children
// still get the contained env via env -i env_for_kind, and daemon-control's
// guard_kind_containment forces HOME/TAMANDUA_STATE_DIR inside torture-test/var.
function resolveOperatorHome() {
  const getent = fs.existsSync("/usr/bin/getent") ? "/usr/bin/getent" : "/bin/getent";
  const result = spawnSync(getent, ["passwd", String(process.getuid())], { encoding: "utf8" });
  const home = result.status === 0 ? result.stdout.trim().split(":")[5] : "";
  assert.ok(home && path.isAbsolute(home), "could not resolve operator HOME for daemon-control");
  return home;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? baseEnv,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}

function createWrappers() {
  const gitWrapper = `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\t' "$@" >>"$TT_W09_GIT_LOG"\nprintf '\\n' >>"$TT_W09_GIT_LOG"\nargs=()\nfor arg in "$@"; do\n  if [ "$arg" = 'https://github.com/igorhvr/tamandua.git' ]; then\n    args+=("$TT_W09_REMOTE_URL")\n  else\n    args+=("$arg")\n  fi\ndone\nexec "$TT_W09_REAL_GIT" "\${args[@]}"\n`;
  const npmWrapper = `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >>"$TT_W09_NPM_LOG"\nexec "$TT_W09_REAL_NPM" "$@"\n`;
  fs.writeFileSync(path.join(tools, "git"), gitWrapper, { mode: 0o755 });
  fs.writeFileSync(path.join(tools, "npm"), npmWrapper, { mode: 0o755 });
}

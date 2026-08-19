#!/usr/bin/env node
/**
 * W4.34 stale CLI vs new daemon (spec 08 §E).
 *
 * Idle-window, zero-token scripted cell. Materializes the `puma`-tag CLI
 * (the tier0 w4.25 materialization shape: git archive at the peeled puma
 * commit + local node_modules copy + npm run build — zero network) and
 * invokes its `status` / `nudge` / `doctor` against the CONTAINED SCRIPTED
 * daemon at TT_COMMIT (current checkout, started by the scenario harness):
 *
 *   daemon status  -> the puma CLI reads the shared contained state dir and
 *                     reports the daemon running — protocol compatible
 *   nudge          -> POST /control/nudge against the TT daemon's control
 *                     plane — succeeds or fails with a named diagnostic,
 *                     NEVER a silent protocol confusion (no hang, no crash,
 *                     no misdirected action)
 *   doctor         -> the STALENESS check "Daemon build version vs
 *                     installed" surfaces the VERSION MISMATCH: the daemon
 *                     reports the TT_COMMIT build while the installed build
 *                     (puma) differs — "Daemon running build X but installed
 *                     build is Y" with the daemon-restart remedy
 *   version        -> the puma CLI reports its own puma-tag version
 *
 * The corridor contract asserted: version mismatch SURFACED (doctor) and
 * the status/nudge verbs stay gracefully compatible — no silent protocol
 * confusion. Zero tokens: no workflow is launched; the ledger is asserted
 * to carry zero spend.
 *
 * MACHINERY NOTE (documented, never silent): the materialization builds the
 * puma tree inside a git-archive extraction that has no .git metadata, so
 * inject-version would resolve git state against the PARENT repo and stamp
 * the CURRENT build version. The cell therefore stamps puma's REAL version
 * string (computed from the repo's puma tag: committer timestamp + peeled
 * commit sha, the inject-version format) into dist/version + the built
 * BUILT_VERSION after the build — the puma CLI then truthfully identifies
 * as the puma build for the mismatch corridor.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
const stateDir = requiredPath("TAMANDUA_STATE_DIR");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");
assert.equal(scenarioId, "w4.34-stale-cli-new-daemon", "scenario id mismatch");

const realGit = trustedCommandPath("git");
const npm = trustedCommandPath("npm");
const tar = trustedCommandPath("tar");
const cp = trustedCommandPath("cp");
const gitEnv = isolatedGitEnvironment({ GIT_ALLOW_PROTOCOL: "file" });

const pumaRef = "refs/tags/puma";
const versionsDir = path.join(invocationDir, "versions");
const pumaVersionDir = path.join(versionsDir, "puma");
const pumaCli = path.join(pumaVersionDir, "bin", "tamandua");
const dbPath = path.join(stateDir, "tamandua.db");
const hostToolPath = [...new Set([
  path.dirname(trustedCommandPath("git")),
  path.dirname(trustedCommandPath("npm")),
  path.dirname(trustedCommandPath("tar")),
  path.dirname(trustedCommandPath("cp")),
  "/usr/bin",
  "/bin",
])].join(path.delimiter);

for (const candidate of [versionsDir, pumaVersionDir, dbPath]) {
  assert.ok(
    candidate === invocationDir || candidate === stateDir
      || candidate.startsWith(`${invocationDir}${path.sep}`)
      || candidate.startsWith(`${stateDir}${path.sep}`),
    `W4.34 mutable path escaped torture-test/var: ${candidate}`,
  );
}

// ── materialize the puma-tag CLI (w4.25 shape, zero network) ────────

const pumaCommit = git(repoRoot, ["rev-parse", `${pumaRef}^{commit}`]).stdout.trim();
assert.ok(/^[0-9a-f]{40}$/.test(pumaCommit), `unexpected puma commit: ${pumaCommit}`);
const pumaVersion = versionFromRef(pumaCommit);
materializeVersion(pumaCommit, pumaVersionDir);
stampPumaVersion(pumaVersionDir, pumaVersion);
fs.writeFileSync(path.join(pumaVersionDir, ".tt-source-identity.json"),
  `${JSON.stringify({ ref: pumaRef, commit: pumaCommit, version: pumaVersion }, null, 2)}\n`);
assert.ok(fs.existsSync(pumaCli), `puma CLI not materialized: ${pumaCli}`);

// ── the TT_COMMIT daemon (started by the harness) must be up ────────

const controlPort = 5339;
const daemonHealth = await controlHealth(controlPort);
assert.ok(daemonHealth, "TT_COMMIT daemon control plane is not reachable (harness must start it)");
assert.ok(typeof daemonHealth.buildVersion === "string" && daemonHealth.buildVersion.length > 0,
  "TT_COMMIT daemon must report its build version");
const ttVersion = daemonHealth.buildVersion;
assert.notEqual(ttVersion, pumaVersion,
  "the puma CLI version must differ from the TT_COMMIT daemon version for the mismatch corridor");

const pumaEnv = {
  ...process.env,
  HOME: process.env.HOME,
  TAMANDUA_STATE_DIR: stateDir,
  TAMANDUA_CONTROL_PORT: String(controlPort),
  TAMANDUA_MCP_PORT: "5338",
  TAMANDUA_DASHBOARD_PORT: "5334",
};

// ── invoke the puma CLI against the TT_COMMIT daemon ───────────────

const version = runAllow(pumaCli, ["version"], { cwd: pumaVersionDir, env: pumaEnv, timeout: 60_000 });
assert.equal(version.status, 0, `puma version must run:\n${version.stdout}\n${version.stderr}`);
assert.equal(version.stdout.trim(), pumaVersion,
  `puma CLI must self-report the puma version (got ${version.stdout.trim()})`);

const status = runAllow(pumaCli, ["daemon", "status"], { cwd: pumaVersionDir, env: pumaEnv, timeout: 60_000 });
assert.equal(status.status, 0,
  `puma daemon status must be protocol-compatible with the TT daemon (exit ${status.status}):\n${status.stdout}\n${status.stderr}`);
assert.match(status.stdout, /running/i,
  `puma daemon status must report the TT daemon running:\n${status.stdout}`);

const nudge = runAllow(pumaCli, ["nudge"], { cwd: pumaVersionDir, env: pumaEnv, timeout: 60_000 });
assert.notEqual(nudge.signal, "SIGKILL", "nudge must not hang (bounded timeout, no silent wedge)");
if (nudge.status === 0) {
  assert.match(`${nudge.stdout}\n${nudge.stderr}`, /No running Tamandua runs to nudge\.|Nudged/,
    `puma nudge succeeded but with unexpected output:\n${nudge.stdout}\n${nudge.stderr}`);
} else {
  // A refused nudge is acceptable ONLY if it names the control plane — never
  // a silent protocol confusion.
  assert.match(`${nudge.stdout}\n${nudge.stderr}`, /Failed to nudge|control plane|Control plane|not reachable/i,
    `puma nudge failed without a named diagnostic (silent protocol confusion?):\n${nudge.stdout}\n${nudge.stderr}`);
}

const doctor = runAllow(pumaCli, ["doctor"], { cwd: pumaVersionDir, env: pumaEnv, timeout: 60_000 });
const doctorCombined = `${doctor.stdout}\n${doctor.stderr}`;
assert.match(doctorCombined, /Daemon build version vs installed/,
  `puma doctor must surface the daemon-vs-installed STALENESS check:\n${doctorCombined}`);
assert.match(doctorCombined, new RegExp(`Daemon running build ${escapeRegExp(ttVersion)}`),
  `puma doctor must name the TT_COMMIT daemon build:\n${doctorCombined}`);
assert.match(doctorCombined, new RegExp(`installed build is ${escapeRegExp(pumaVersion)}`),
  `puma doctor must name the puma installed build (version mismatch surfaced):\n${doctorCombined}`);
assert.match(doctorCombined, /tamandua daemon restart/, `puma doctor must carry the daemon-restart remedy:\n${doctorCombined}`);

// ── zero-token + hygiene ledger proof ──────────────────────────────

const db = new DatabaseSync(dbPath, { readOnly: true });
let runTokens = 0;
let systemTokens = 0;
try {
  runTokens = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get().total;
  systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get().system_tokens_spent;
} finally {
  db.close();
}
assert.equal(runTokens, 0, "W4.34 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.34 system token tripwire moved");

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  puma_commit: pumaCommit,
  puma_version: pumaVersion,
  tt_commit_version: ttVersion,
  invocations: {
    version: { exit: version.status, reported: version.stdout.trim() },
    daemon_status: { exit: status.status, graceful: true },
    nudge: { exit: nudge.status, signal: nudge.signal ?? null },
    doctor: { exit: doctor.status, mismatch_surfaced: true },
  },
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
})}\n`);

// ── materialization helpers ────────────────────────────────────────

function materializeVersion(commit, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const archive = path.join(invocationDir, "puma.tar");
  // git archive MUST run with cwd at the REPO ROOT: from a subdirectory git
  // archives only that subtree (the archive of a gitignored empty subdir is
  // ~10KB of nothing).
  run(realGit, ["archive", "--format=tar", "--output", archive, commit], { cwd: repoRoot, env: gitEnv });
  run(tar, ["-xf", archive, "-C", destination]);
  fs.rmSync(archive, { force: true });
  const dependencyDir = path.join(destination, "node_modules");
  fs.mkdirSync(dependencyDir, { recursive: true });
  run(cp, ["-a", "--reflink=auto", `${path.join(repoRoot, "node_modules")}${path.sep}.`, dependencyDir], {
    timeout: 5 * 60_000,
  });
  run(npm, ["run", "build"], { cwd: destination, env: { ...process.env, PATH: hostToolPath }, timeout: 10 * 60_000 });
  assert.ok(fs.existsSync(path.join(destination, "dist", "cli", "cli.js")),
    `puma commit ${commit} did not build a CLI`);
}

function stampPumaVersion(destination, version) {
  // The build resolves git against the PARENT repo (the extraction has no
  // .git), so inject-version stamped the CURRENT version — overwrite with
  // puma's real version in both dist/version and the built BUILT_VERSION.
  fs.writeFileSync(path.join(destination, "dist", "version"), `${version}\n`);
  const standalonePath = path.join(destination, "dist", "cli", "commands", "standalone.js");
  const source = fs.readFileSync(standalonePath, "utf8");
  const patched = source.replace(/const BUILT_VERSION = "[^"]*"/,
    `const BUILT_VERSION = ${JSON.stringify(version)}`);
  assert.notEqual(patched, source, "BUILT_VERSION placeholder not found for puma version stamping");
  fs.writeFileSync(standalonePath, patched);
}

function versionFromRef(commit) {
  const unixTimestamp = git(repoRoot, ["log", "-1", "--format=%ct", commit]).stdout.trim();
  const date = new Date(parseInt(unixTimestamp, 10) * 1000);
  const Y = date.getUTCFullYear();
  const M = String(date.getUTCMonth() + 1).padStart(2, "0");
  const D = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${Y}${M}${D}T${h}${m}${s}Z_${commit}`;
}

async function controlHealth(port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://127.0.0.1:${port}/control/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(cwd, args) {
  return run(realGit, args, { cwd, env: gitEnv });
}

function run(command, args, options = {}) {
  const result = runAllow(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function runAllow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? { ...process.env },
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
  const result = { ...process.env };
  for (const key of Object.keys(result)) {
    if (["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].includes(key)
        || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete result[key];
  }
  return {
    ...result,
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

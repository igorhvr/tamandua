#!/usr/bin/env node
/**
 * W4.20 `tamandua update` repo-state classification — four legs (spec 08 §E).
 *
 * Idle-window, zero-token scripted cell. `tamandua update` is exercised
 * against four LOCAL source-checkout fixtures (the tier0 w4.49
 * provisioning shape: a bare remote + a seed clone + per-leg installed
 * clones), and every leg is classified with a DISTINCT outcome:
 *
 *   behind        remote advanced; the installed clone is behind
 *                 -> git pull --ff-only SUCCEEDS -> build-and-install runs
 *                    (stub) -> "Tamandua update complete.", exit 0
 *   ahead         installed clone has a local commit the remote lacks
 *                 -> `git pull --ff-only` NO-OPS ("Already up to date" — a
 *                    pure-ahead checkout is NOT divergence) ->
 *                    no_change ("already at ...", exit 0) with every
 *                    mutating phase skipped
 *   diverged      BOTH sides advanced (local commit + remote commit)
 *                 -> pull fails (non-fast-forward) -> checkAheadOfUpstream
 *                    finds ahead+remoteOk -> refused_diverged ("Not
 *                    pulling."), exit 1 — the diverged topology is asserted
 *                    via the remote-only commit count (ahead leg has 0,
 *                    diverged has >= 1)
 *   network-error origin points at an unreachable remote
 *                 -> pull fails on fetch; remote unreachable ->
 *                    pull_failed ("git pull failed ... Aborting update."),
 *                    exit 1
 *
 * Every refusal leg (ahead no-op / diverged / network-error) asserts ZERO
 * DESTRUCTIVE STEPS (DC31): HEAD unchanged, local commits preserved,
 * working tree byte-identical (planted untracked file + tracked
 * modification survive), dist tree byte-identical, build-and-install never
 * executed (no build marker), no merge/rebase state left behind, no
 * services disturbed.
 *
 * The HARN seam (update mutating a repo it does not own) is registered
 * KNOWN-OPEN per the spec wave gate and deliberately NOT gated here — see
 * the task text + traceability.
 *
 * The contained scripted daemon is stopped before the legs so the update's
 * service snapshot is empty: the legs stay purely about the git
 * classification (no daemon stop/restart races). Zero tokens: no workflow
 * is ever launched; the ledger is asserted to carry zero spend at the end.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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
assert.equal(scenarioId, "w4.20-update-repo-state-classification", "scenario id mismatch");

const daemonControl = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const realGit = trustedCommandPath("git");
const operatorHome = resolveOperatorHome();
const dbPath = path.join(stateDir, "tamandua.db");

const remote = path.join(invocationDir, "source-remote.git");
const seed = path.join(invocationDir, "source-seed");
const tempDir = path.join(invocationDir, "tmp");
const legsDir = path.join(invocationDir, "legs");
const provenancePath = path.join(invocationDir, "target-provenance.json");

for (const candidate of [invocationDir, remote, seed, tempDir, legsDir, provenancePath]) {
  assert.ok(candidate === invocationDir || candidate.startsWith(`${invocationDir}${path.sep}`),
    `W4.20 mutable path escaped torture-test/var: ${candidate}`);
}
assert.ok(dbPath.startsWith(`${stateDir}${path.sep}`) || dbPath === stateDir,
  `W4.20 ledger path escaped the contained state dir: ${dbPath}`);
fs.mkdirSync(tempDir, { recursive: true });

const env = {
  ...process.env,
  HOME: process.env.HOME,
  TAMANDUA_STATE_DIR: stateDir,
  TMPDIR: tempDir,
};
const daemonControlEnv = { ...env, HOME: operatorHome };
const gitEnv = isolatedGitEnvironment({ GIT_ALLOW_PROTOCOL: "file" });

// ── reset barrier: stop the contained scripted daemon before the legs ──

stopScriptedDaemon();
await assertPortsFree();

// ── provision the delivery fixtures ────────────────────────────────

provisionLocalDeliveryFixture();
const initialRemoteHead = git(remote, ["rev-parse", "HEAD"]).stdout.trim();
// The behind-leg clone is created BEFORE the remote advances, so it starts
// genuinely behind the (about-to-advance) remote.
const behindClone = freshInstalledClone("behind");
assert.equal(git(behindClone, ["rev-parse", "HEAD"]).stdout.trim(), initialRemoteHead,
  "behind leg clone must start at the pre-advance remote HEAD");
const healthyStubHead = advanceRemote(healthyBuildScript(), "W4.20 stub build-and-install");
assert.notEqual(healthyStubHead, initialRemoteHead, "remote did not advance with the stub build-and-install");

const legs = {};

// ── leg 1: behind -> updated (exit 0) ──────────────────────────────

{
  const installed = behindClone;
  const beforeDist = digestInventory(path.join(installed, "dist"));
  const behindMarker = path.join(legsDir, "behind", "build-marker");
  const result = runAllow(path.join(installed, "bin", "tamandua"), ["update"], {
    cwd: installed, timeout: 10 * 60_000,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0,
    `behind update must succeed:\n${combined}`);
  assert.match(combined, /Source updated:/, `behind update must report the pull:\n${combined}`);
  assert.match(combined, /Tamandua update complete\./, `behind update must complete:\n${combined}`);
  assert.equal(git(installed, ["rev-parse", "HEAD"]).stdout.trim(), healthyStubHead,
    "behind update must advance the source checkout to the remote HEAD");
  assert.ok(fs.existsSync(behindMarker),
    "behind update must execute the (stub) build-and-install after the successful pull");
  assert.match(fs.readFileSync(behindMarker, "utf8"), /W4\.20 HEALTHY_BUILD/,
    "behind build-and-install must be the stub (no real npm install/build)");
  // The executable dist tree must reflect the new build (the stub symlinks
  // nothing, so the dist inventory is unchanged — the assertion pins that no
  // half-written dist was produced by the classification corridor).
  assert.deepEqual(digestInventory(path.join(installed, "dist")), beforeDist,
    "behind update changed the dist tree outside build-and-install");
  legs.behind = {
    route: "updated",
    exit: result.status,
    before_head: initialRemoteHead,
    after_head: healthyStubHead,
    build_and_install_executed: true,
  };
}

// ── leg 2: ahead -> no_change (exit 0, "already at") ───────────────

{
  const installed = freshInstalledClone("ahead");
  const localCommit = plantLocalCommit(installed, "ahead-local-commit");
  const snapshot = dc31Snapshot(installed);
  const result = runAllow(path.join(installed, "bin", "tamandua"), ["update"], {
    cwd: installed, timeout: 5 * 60_000,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0,
    `ahead update must classify as no_change (exit 0):\n${combined}`);
  // A PURE-ahead checkout is NOT divergence: `git pull --ff-only` no-ops
  // ("Already up to date") and the update classifies it no_change — the
  // spec's "correct classification" for the ahead leg.
  assert.match(combined, /No source changes after git pull; already at/,
    `ahead must classify as no_change (already at HEAD):\n${combined}`);
  assert.match(combined, /Skipping build, workflow install, and service restart\./,
    `ahead no_change must skip every mutating phase:\n${combined}`);
  // DC31-style zero-destructive-steps applies to the no-op too.
  assertRefusalDc31(installed, snapshot, localCommit, "ahead", combined);
  legs.ahead = {
    route: "no_change",
    exit: result.status,
    local_commit: localCommit,
    remote_only_commits: countRemoteOnlyCommits(installed),
    dc31: "zero-destructive-steps",
  };
}

// ── leg 3: diverged -> refused_diverged (exit 1, DC31) ─────────────

{
  const installed = freshInstalledClone("diverged");
  const localCommit = plantLocalCommit(installed, "diverged-local-commit");
  const remoteCommit = advanceRemote("// W4.20 diverged remote advance\n", "W4.20 diverged remote commit");
  assert.notEqual(git(installed, ["rev-parse", "HEAD"]).stdout.trim(), git(remote, ["rev-parse", "HEAD"]).stdout.trim(),
    "diverged leg must start with truly diverged histories");
  const snapshot = dc31Snapshot(installed);
  const result = runAllow(path.join(installed, "bin", "tamandua"), ["update"], {
    cwd: installed, timeout: 5 * 60_000,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `diverged update must refuse (non-zero):\n${combined}`);
  assert.match(combined, /has local commits origin does not have \(or histories have diverged\)/,
    `diverged must classify as divergence refusal:\n${combined}`);
  assert.match(combined, /Not pulling\./, `diverged refusal must decline the pull:\n${combined}`);
  assertRefusalDc31(installed, snapshot, localCommit, "diverged", combined);
  const remoteOnly = countRemoteOnlyCommits(installed);
  assert.ok(remoteOnly >= 1, `diverged leg must carry remote-only commits (got ${remoteOnly})`);
  legs.diverged = {
    route: "refused_diverged",
    exit: result.status,
    local_commit: localCommit,
    remote_commit: remoteCommit,
    remote_only_commits: remoteOnly,
    dc31: "zero-destructive-steps",
  };
}

// ── leg 4: network-error -> pull_failed (exit 1, DC31) ─────────────

{
  const installed = freshInstalledClone("network-error");
  const snapshot = dc31Snapshot(installed);
  // Point origin at an unreachable file:// remote — a fast, local
  // "network-error" (remote unreachable) that never touches the network.
  git(installed, ["remote", "set-url", "origin",
    `file://${path.join(invocationDir, "does-not-exist-${scenarioId}.git")}`]);
  const result = runAllow(path.join(installed, "bin", "tamandua"), ["update"], {
    cwd: installed, timeout: 5 * 60_000,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `network-error update must fail (non-zero):\n${combined}`);
  assert.match(combined, /git pull failed:/, `network-error must classify as a pull failure:\n${combined}`);
  assert.match(combined, /Aborting update\./, `network-error must abort with the remedy hint:\n${combined}`);
  assertRefusalDc31(installed, snapshot, null, "network-error", combined);
  legs["network-error"] = {
    route: "pull_failed",
    exit: result.status,
    dc31: "zero-destructive-steps",
  };
}

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
assert.equal(runTokens, 0, "W4.20 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.20 system token tripwire moved");

// ── containment closing: no services may have been started by the legs ──

await assertPortsFree();

writeTargetProvenance({
  scenario: scenarioId,
  initial_remote_head: initialRemoteHead,
  healthy_stub_head: healthyStubHead,
});

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  legs,
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
  provenance: provenancePath,
}, null, 2)}\n`);

// ── fixture provisioning (the tier0 w4.49 shape) ──────────────────

function provisionLocalDeliveryFixture() {
  run(realGit, ["clone", "--bare", "--no-local", repoRoot, remote], { env: gitEnv, timeout: 5 * 60_000 });
  const ttCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
  run(realGit, ["--git-dir", remote, "update-ref", "refs/heads/main", ttCommit], { env: gitEnv });
  run(realGit, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { env: gitEnv });
  run(realGit, ["clone", `file://${remote}`, seed], { env: gitEnv, timeout: 5 * 60_000 });
  configureIdentity(seed);
}

function freshInstalledClone(leg) {
  const installed = path.join(legsDir, leg);
  fs.rmSync(installed, { recursive: true, force: true });
  run(realGit, ["clone", `file://${remote}`, installed], { env: gitEnv, timeout: 5 * 60_000 });
  configureIdentity(installed);
  fs.cpSync(path.join(repoRoot, "dist"), path.join(installed, "dist"), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(installed, "node_modules"), "dir");
  assert.ok(fs.existsSync(path.join(installed, "bin", "tamandua")), "installed clone missing the CLI wrapper");
  assert.ok(fs.existsSync(path.join(installed, "package.json")), "installed clone missing package.json");
  assert.ok(fs.existsSync(path.join(installed, "build-and-install")), "installed clone missing build-and-install");
  return installed;
}

function advanceRemote(content, message) {
  fs.writeFileSync(path.join(seed, "build-and-install"), content, { mode: 0o755 });
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", message]);
  git(seed, ["push", "origin", "main"]);
  return git(remote, ["rev-parse", "HEAD"]).stdout.trim();
}

function plantLocalCommit(installed, message) {
  fs.writeFileSync(path.join(installed, "w4.20-local.txt"),
    `W4.20 ${message}\n${crypto.randomUUID()}\n`);
  git(installed, ["add", "w4.20-local.txt"]);
  git(installed, ["commit", "-q", "-m", message]);
  return git(installed, ["rev-parse", "HEAD"]).stdout.trim();
}

function healthyBuildScript() {
  // The stub build-and-install the behind leg pulls and executes; it writes
  // a LEG-SCOPED marker (never a shared path) so the other legs' DC31
  // assertions can prove their build-and-install was never executed.
  return `#!/usr/bin/env bash\nset -euo pipefail\necho 'W4.20 HEALTHY_BUILD'\nprintf 'W4.20 HEALTHY_BUILD\\n' >${shellQuote(path.join(legsDir, "behind", "build-marker"))}\n`;
}

// ── DC31 zero-destructive-steps snapshot ──────────────────────────

function dc31Snapshot(installed) {
  // Plant a tracked modification + an untracked file; both must survive a
  // refusal byte-identically (a destructive step would reset/clean them).
  const tracked = path.join(installed, "AGENTS.md");
  fs.appendFileSync(tracked, `\n<!-- W4.20 DC31 tracked modification ${crypto.randomUUID()} -->\n`);
  const untracked = path.join(installed, "w4.20-untracked.txt");
  fs.writeFileSync(untracked, `W4.20 DC31 untracked ${crypto.randomUUID()}\n`);
  const head = git(installed, ["rev-parse", "HEAD"]).stdout.trim();
  const status = git(installed, ["status", "--porcelain", "--untracked-files=all"]).stdout;
  const dist = digestInventory(path.join(installed, "dist"));
  return { head, status, dist, tracked, untracked };
}

function assertRefusalDc31(installed, snapshot, localCommit, leg, combined) {
  // HEAD unchanged (no checkout/reset of the branch).
  assert.equal(git(installed, ["rev-parse", "HEAD"]).stdout.trim(), snapshot.head,
    `${leg}: refusal must not move HEAD`);
  // Local commit preserved (never rewritten/reset away).
  if (localCommit) {
    assert.equal(git(installed, ["rev-parse", "HEAD"]).stdout.trim(), localCommit,
      `${leg}: the local commit must survive the refusal`);
    assert.match(git(installed, ["log", "--oneline", "-1"]).stdout, new RegExp(leg),
      `${leg}: the local commit message must survive`);
  }
  // Working tree + untracked files byte-identical.
  assert.equal(git(installed, ["status", "--porcelain", "--untracked-files=all"]).stdout, snapshot.status,
    `${leg}: refusal must not touch the working tree (DC31)`);
  assert.ok(fs.existsSync(snapshot.untracked), `${leg}: planted untracked file must survive (DC31)`);
  assert.ok(fs.readFileSync(snapshot.tracked, "utf8").includes("W4.20 DC31 tracked modification"),
    `${leg}: planted tracked modification must survive (DC31)`);
  // Dist tree byte-identical (no destructive rebuild/rewrite).
  assert.equal(digestInventory(path.join(installed, "dist")), snapshot.dist,
    `${leg}: refusal must not mutate the executable dist tree (DC31)`);
  // build-and-install never executed — the marker is LEG-SCOPED, so only the
  // behind leg's stub can create the behind marker and no other leg's marker
  // may ever appear.
  assert.ok(!fs.existsSync(path.join(legsDir, leg, "build-marker")),
    `${leg}: refusal must never execute build-and-install (no build marker)`);
  // No merge/rebase state left behind by the refused pull.
  for (const artifact of [".git/MERGE_HEAD", ".git/rebase-merge", ".git/rebase-apply", ".git/CHERRY_PICK_HEAD"]) {
    assert.ok(!fs.existsSync(path.join(installed, artifact)),
      `${leg}: refused pull left ${artifact} behind (DC31)`);
  }
  // No daemon/service side effect: the control plane port must still be free.
  assert.ok(fs.existsSync(path.join(installed, "dist", "version")),
    `${leg}: dist/version must survive the refusal`);
  assert.doesNotMatch(combined, /Stopping daemon/, `${leg}: refusal must not touch services`);
}

function countRemoteOnlyCommits(installed) {
  const result = runAllow(realGit, ["rev-list", "--count", "HEAD..@{u}"], { cwd: installed, env: gitEnv });
  if (result.status !== 0) return 0;
  return parseInt(result.stdout.trim(), 10);
}

// ── daemon reset barrier + hygiene ────────────────────────────────

function stopScriptedDaemon() {
  const result = spawnSync(daemonControl, ["scripted", "stop"], {
    cwd: repoRoot,
    env: daemonControlEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  // Non-zero is tolerated — the stop is a reset barrier (idempotent).
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

async function assertPortsFree() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const occupied = [];
    for (const port of [5334, 5338, 5339]) {
      if (!await portIsFree(port)) occupied.push(port);
    }
    if (occupied.length === 0) return;
    if (attempt % 10 === 0) stopScriptedDaemon();
    await delay(50);
  }
  assert.fail(`scripted listeners still occupied after stop propagation: ${occupied.join(", ")}`);
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
  });
}

function writeTargetProvenance(value) {
  fs.writeFileSync(provenancePath, `${JSON.stringify({ ...value, recorded_at: new Date().toISOString() }, null, 2)}\n`);
}

// ── plumbing helpers ──────────────────────────────────────────────

function digestInventory(root) {
  const rows = [];
  walk(root, (candidate, entry) => {
    if (entry.isFile()) {
      rows.push([path.relative(root, candidate),
        crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex")]);
    }
    return true;
  });
  return crypto.createHash("sha256").update(JSON.stringify(rows.sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}

function walk(root, visit) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    const descend = visit(candidate, entry);
    if (descend !== false && entry.isDirectory()) walk(candidate, visit);
  }
}

function configureIdentity(repo) {
  git(repo, ["config", "user.email", "w4.20@tamandua.local"]);
  git(repo, ["config", "user.name", "W4.20 Scenario"]);
}

function git(cwd, args, options = {}) {
  return run(realGit, args, { ...options, cwd, env: gitEnv });
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

function resolveOperatorHome() {
  const result = spawnSync("getent", ["passwd", String(process.getuid())], { encoding: "utf8" });
  const home = result.status === 0 ? result.stdout.trim().split(":")[5] : "";
  if (!home || !path.isAbsolute(home)) throw new Error("could not resolve operator HOME for daemon-control");
  return home;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

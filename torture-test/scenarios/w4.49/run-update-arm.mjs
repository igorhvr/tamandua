#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = requiredPath("TT_REPO_ROOT");
const invocationDir = requiredPath("TT_SCENARIO_STATE_DIR");
const workflowId = requiredValue("TT_SCENARIO_WORKFLOW_ID");
const scenarioId = requiredValue("TT_SCENARIO_ID");
const scriptedStateDir = requiredPath("TAMANDUA_STATE_DIR");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");

const arm = scenarioId.replace(/^w4\.49-/, "");
const supportedArms = new Set([
  "build-fails-after-pull",
  "sigint-mid-build-install",
  "workflow-install-post-stop",
]);
assert.ok(supportedArms.has(arm), `unsupported W4.49 arm: ${arm}`);

const remote = path.join(invocationDir, "source-remote.git");
const seed = path.join(invocationDir, "source-seed");
const installed = path.join(invocationDir, "installed-old-build");
const tempDir = path.join(invocationDir, "tmp");
const marker = path.join(invocationDir, `${arm}.marker`);
const provenancePath = path.join(invocationDir, "target-provenance.json");
const installedCli = path.join(installed, "bin", "tamandua");
const catalogStamp = path.join(scriptedStateDir, "workflows", ".catalog-version.json");
const daemonControl = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const realGit = commandPath("git");
const operatorHome = resolveOperatorHome();

for (const candidate of [invocationDir, remote, seed, installed, tempDir, marker, provenancePath]) {
  assert.ok(candidate === invocationDir || candidate.startsWith(`${invocationDir}${path.sep}`),
    `W4.49 mutable path escaped torture-test/var: ${candidate}`);
}
fs.mkdirSync(tempDir, { recursive: true });

const env = {
  ...process.env,
  HOME: process.env.HOME,
  TAMANDUA_STATE_DIR: scriptedStateDir,
  TMPDIR: tempDir,
  NPM_CONFIG_CACHE: path.join(invocationDir, "npm-cache"),
};
const daemonControlEnv = { ...env, HOME: operatorHome };

let evidence;
try {
  provisionLocalDeliveryFixture();
  const oldHead = git(installed, ["rev-parse", "HEAD"]).stdout.trim();
  const oldDistVersion = fs.readFileSync(path.join(installed, "dist", "version"), "utf8").trim();
  const distInventoryBefore = inventory(path.join(installed, "dist"));
  run(installedCli, ["workflow", "install", "do-now"], { cwd: installed, timeout: 60_000 });
  const catalogBefore = captureCatalogStampEvidence(oldDistVersion);

  if (arm === "build-fails-after-pull") {
    advanceRemote(buildFailureScript(marker), "fault: build fails after pull");
    const targetHead = git(seed, ["rev-parse", "HEAD"]).stdout.trim();
    writeTargetProvenance({ arm, trigger: "BUILD_STARTED", marker, targetHead, installed });

    const failed = runAllow(installedCli, ["update"], { cwd: installed, timeout: 5 * 60_000 });
    assert.notEqual(failed.status, 0, "build-failure update unexpectedly succeeded");
    assert.ok(fs.existsSync(marker),
      `build failure was not marker-triggered:\n${failed.stdout}\n${failed.stderr}`);
    assert.match(fs.readFileSync(marker, "utf8"), /^BUILD_STARTED\n$/);
    assertSourceAdvanced(targetHead);
    assert.deepEqual(inventory(path.join(installed, "dist")), distInventoryBefore,
      "failed build changed the executable dist tree");
    const runEvidence = assertOldBuildUsable();
    assertCatalogStampNotRewritten(catalogBefore);
    const diagnosis = assertStalenessDiagnosis(oldHead, oldDistVersion, catalogBefore);

    const recoveredHead = recoverUpdate("fix: restore build after deterministic failure");
    evidence = baseEvidence({
      old_head: oldHead,
      fault_head: targetHead,
      recovered_head: recoveredHead,
      trigger: "BUILD_STARTED",
      target_provenance: provenancePath,
      old_service_run: runEvidence.run_id,
      diagnosis,
    });
  } else if (arm === "sigint-mid-build-install") {
    advanceRemote(sigintBuildScript(marker), "fault: pause at SIGINT build marker");
    const targetHead = git(seed, ["rev-parse", "HEAD"]).stdout.trim();
    const update = spawn(installedCli, ["update"], {
      cwd: installed,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    update.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    update.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    await waitForFile(marker, update, 30_000);
    assert.equal(processGroup(update.pid), update.pid, "update target is not its own proven process group");
    writeTargetProvenance({
      arm,
      trigger: "SIGINT_READY",
      marker,
      targetHead,
      pid: update.pid,
      pgid: update.pid,
      starttime: processStartTime(update.pid),
    });
    process.kill(-update.pid, "SIGINT");
    const interrupted = await waitForExit(update, 30_000);
    assert.notEqual(interrupted.code, 0, `SIGINT update unexpectedly succeeded:\n${stdout}\n${stderr}`);
    await waitForGroupExit(update.pid, 10_000);
    assertSourceAdvanced(targetHead);
    const distInventoryAfterInterrupt = inventory(path.join(installed, "dist"));
    assert.deepEqual(distInventoryAfterInterrupt, distInventoryBefore,
      "SIGINT marker allowed a half-written dist tree");
    assertCatalogStampNotRewritten(catalogBefore);
    const diagnosis = assertStalenessDiagnosis(oldHead, oldDistVersion, catalogBefore);
    const recoveredHead = recoverUpdate("fix: restore build after SIGINT");

    evidence = baseEvidence({
      old_head: oldHead,
      fault_head: targetHead,
      recovered_head: recoveredHead,
      trigger: "SIGINT_READY",
      signal: "SIGINT",
      target_provenance: provenancePath,
      dist_inventory_before: digestInventory(distInventoryBefore),
      dist_inventory_after_interrupt: digestInventory(distInventoryAfterInterrupt),
      diagnosis,
    });
  } else {
    const workflowFile = path.join(seed, "workflows", "do-now", "workflow.yml");
    const originalWorkflow = fs.readFileSync(workflowFile, "utf8");
    fs.writeFileSync(workflowFile, "id: [invalid\n");
    fs.writeFileSync(path.join(seed, "build-and-install"), healthyBuildScript(), { mode: 0o755 });
    commitAndPush("fault: workflow install fails after service stop");
    const targetHead = git(seed, ["rev-parse", "HEAD"]).stdout.trim();
    writeTargetProvenance({ arm, trigger: "Stopping daemon", targetHead, workflowFile: "workflows/do-now/workflow.yml" });

    const failed = runAllow(installedCli, ["update", "--force"], { cwd: installed, timeout: 10 * 60_000 });
    const combined = `${failed.stdout}\n${failed.stderr}`;
    assert.notEqual(failed.status, 0, "workflow-install failure update unexpectedly succeeded");
    assert.match(combined, /Stopping daemon/,
      `fault did not occur after service stop:\n${combined}`);
    assert.match(combined, /Failed to install bundled workflow/,
      `workflow install failure was not loud:\n${combined}`);
    const stampTransaction = assessCatalogStampWrite(catalogBefore);
    assertDaemonRunning();
    const diagnosis = assertStalenessDiagnosis(oldHead, oldDistVersion, catalogBefore);

    fs.writeFileSync(workflowFile, originalWorkflow);
    fs.writeFileSync(path.join(seed, "build-and-install"), healthyBuildScript(), { mode: 0o755 });
    commitAndPush("fix: restore workflow after post-stop failure");
    const recovery = run(installedCli, ["update", "--force"], { cwd: installed, timeout: 10 * 60_000 });
    assert.match(recovery.stdout, /Tamandua update complete/);
    assert.ok(fs.existsSync(catalogStamp), "recovery did not recreate the catalog stamp");
    assertDaemonRunning();

    evidence = baseEvidence({
      old_head: oldHead,
      fault_head: targetHead,
      recovered_head: git(installed, ["rev-parse", "HEAD"]).stdout.trim(),
      trigger: "Stopping daemon",
      target_provenance: provenancePath,
      finally_restart: "running",
      stamp_after_failure: stampTransaction,
      diagnosis,
      partial_temp_files: assertNoPartialTempFiles(),
    });
  }
} finally {
  spawnSync(daemonControl, ["scripted", "stop"], {
    cwd: repoRoot,
    env: daemonControlEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  stopContainedReplacement();
  await assertScriptedPortsFree();
}

process.stdout.write(`${JSON.stringify(evidence)}\n`);

function provisionLocalDeliveryFixture() {
  run(realGit, ["clone", "--bare", "--no-local", repoRoot, remote], { env: process.env, timeout: 5 * 60_000 });
  const ttCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
  run(realGit, ["--git-dir", remote, "update-ref", "refs/heads/main", ttCommit], { env: process.env });
  run(realGit, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { env: process.env });
  run(realGit, ["clone", `file://${remote}`, seed], { env: process.env, timeout: 5 * 60_000 });
  run(realGit, ["clone", `file://${remote}`, installed], { env: process.env, timeout: 5 * 60_000 });
  git(seed, ["config", "user.email", "w4.49@tamandua.local"]);
  git(seed, ["config", "user.name", "W4.49 Scenario"]);

  fs.cpSync(path.join(repoRoot, "dist"), path.join(installed, "dist"), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(installed, "node_modules"), "dir");
}

function advanceRemote(script, message) {
  fs.writeFileSync(path.join(seed, "build-and-install"), script, { mode: 0o755 });
  commitAndPush(message);
}

function recoverUpdate(message) {
  fs.writeFileSync(path.join(seed, "build-and-install"), healthyBuildScript(), { mode: 0o755 });
  commitAndPush(message);
  const recovery = run(installedCli, ["update", "--force"], { cwd: installed, timeout: 10 * 60_000 });
  assert.match(recovery.stdout, /Tamandua update complete/);
  assertDaemonRunning();
  assert.ok(fs.existsSync(catalogStamp), "recovery did not recreate the catalog stamp");
  return git(installed, ["rev-parse", "HEAD"]).stdout.trim();
}

function commitAndPush(message) {
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", message]);
  git(seed, ["push", "origin", "main"]);
}

function buildFailureScript(markerPath) {
  return `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'BUILD_STARTED\\n' >${shellQuote(markerPath)}\necho 'W4.49 injected build failure after pull' >&2\nexit 49\n`;
}

function sigintBuildScript(markerPath) {
  return `#!/usr/bin/env bash\nset -euo pipefail\ntrap 'exit 130' INT TERM\nprintf 'SIGINT_READY\\n' >${shellQuote(markerPath)}\necho 'W4.49 waiting at build/install SIGINT marker'\nwhile :; do sleep 1; done\n`;
}

function healthyBuildScript() {
  return `#!/usr/bin/env bash\nset -euo pipefail\necho 'W4.49 HEALTHY_BUILD'\nnpm run build\nmkdir -p "$HOME/.local/bin"\nln -sfn "$PWD/bin/tamandua" "$HOME/.local/bin/tamandua"\nln -sfn "$PWD/bin/tamandua-test" "$HOME/.local/bin/tamandua-test"\n`;
}

function assertSourceAdvanced(expectedHead) {
  assert.equal(git(installed, ["rev-parse", "HEAD"]).stdout.trim(), expectedHead,
    "successful pull did not leave source at the faulting new HEAD");
}

function assertOldBuildUsable() {
  const launched = run(installedCli, [
    "workflow", "run", workflowId, "Prove the old W4.49 service remains usable",
    "--working-directory-for-harness", seed,
    "--wait", "--timeout", "3m", "--json",
  ], { cwd: seed, timeout: 4 * 60_000 });
  const payload = JSON.parse(launched.stdout.trim().split("\n").at(-1));
  const record = Array.isArray(payload.runs) ? payload.runs[0] : payload;
  assert.equal(record.status, "completed", `old service workflow failed: ${launched.stdout}`);
  return { run_id: record.runId ?? record.run_id };
}

function captureCatalogStampEvidence(expectedVersion) {
  assert.ok(fs.existsSync(catalogStamp) && fs.statSync(catalogStamp).isFile(),
    "pre-fault workflow install did not create a valid catalog stamp file");
  const bytes = fs.readFileSync(catalogStamp);
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (expectedVersion !== undefined) {
    assert.equal(parsed.version, expectedVersion,
      "catalog stamp does not match the expected executable dist");
  }
  const stat = fs.statSync(catalogStamp, { bigint: true });
  return {
    bytes,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    version: parsed.version,
    source_path: parsed.sourcePath,
    mtime_ns: stat.mtimeNs.toString(),
  };
}

function assertCatalogStampNotRewritten(before) {
  const after = captureCatalogStampEvidence(before.version);
  assert.equal(after.sha256, before.sha256,
    "failed update rewrote the pre-fault catalog stamp");
  assert.equal(after.mtime_ns, before.mtime_ns,
    "failed update touched the pre-fault catalog stamp");
  return after;
}

function assessCatalogStampWrite(before) {
  const after = captureCatalogStampEvidence();
  if (after.sha256 === before.sha256 && after.mtime_ns === before.mtime_ns) {
    return {
      status: "PASS",
      result: "preserved-old-not-rewritten",
      version: after.version,
    };
  }
  return {
    status: "PRODUCT_FINDING",
    finding: "failed update rewrote the catalog stamp before the catalog transaction completed",
    version_before: before.version,
    version_after: after.version,
    sha256_before: before.sha256,
    sha256_after: after.sha256,
  };
}

function assertStalenessDiagnosis(sourceBefore, distVersionBefore, catalogBefore) {
  const sourceAfter = git(installed, ["rev-parse", "HEAD"]).stdout.trim();
  const distVersionAfter = fs.readFileSync(path.join(installed, "dist", "version"), "utf8").trim();
  assert.notEqual(sourceAfter, sourceBefore, "source did not advance before diagnosis");
  const doctor = runAllow(installedCli, ["doctor"], { cwd: installed, timeout: 60_000 });
  const combined = `${doctor.stdout}\n${doctor.stderr}`;
  const sourceDistSkewLabel = "source checkout/dist skew";
  const namesSourceDistSkew = /source[^\n]{0,120}dist|dist[^\n]{0,120}source/i.test(combined)
    && /skew|stale|mismatch|older|newer/i.test(combined);
  const namesCatalogSkew = /Installed catalog vs bundled catalog/.test(combined)
    && /older|mismatch|does not match/i.test(combined);

  if (arm === "workflow-install-post-stop") {
    if (!namesCatalogSkew) {
      return {
        status: "PRODUCT_FINDING",
        finding: "doctor does not flag the incomplete post-stop catalog transaction",
        source_head: sourceAfter,
        dist_version_before: distVersionBefore,
        dist_version_after: distVersionAfter,
        catalog_version_before: catalogBefore.version,
        doctor_output_sha256: crypto.createHash("sha256").update(combined).digest("hex"),
        required_remedy: "tamandua update --force",
      };
    }
    assert.match(combined, /tamandua update --force/);
    return {
      status: "PASS",
      kind: "catalog-stamp-vs-dist",
      source_head: sourceAfter,
      dist_version_before: distVersionBefore,
      dist_version_after: distVersionAfter,
      catalog_version_before: catalogBefore.version,
      remedy: "tamandua update --force",
    };
  }

  if (!namesSourceDistSkew) {
    return {
      status: "PRODUCT_FINDING",
      finding: `doctor does not name ${sourceDistSkewLabel} after a successful pull and failed build`,
      source_head: sourceAfter,
      dist_version_before: distVersionBefore,
      dist_version_after: distVersionAfter,
      catalog_version_before: catalogBefore.version,
      doctor_output_sha256: crypto.createHash("sha256").update(combined).digest("hex"),
      required_remedy: "tamandua update --force",
    };
  }

  assert.match(combined, /tamandua update --force/);
  return {
    status: "PASS",
    kind: "source-dist-skew",
    source_head: sourceAfter,
    dist_version_before: distVersionBefore,
    dist_version_after: distVersionAfter,
    catalog_version_before: catalogBefore.version,
    remedy: "tamandua update --force",
  };
}

function assertDaemonRunning() {
  for (const args of [["daemon", "status"], ["dashboard", "status"], ["mcp", "status"]]) {
    const status = run(installedCli, args, { cwd: installed, timeout: 30_000 });
    assert.match(status.stdout, /running|STATUS: RUNNING/i,
      `${args[0]} was not restarted through the update finally path`);
  }
}

function baseEvidence(extra) {
  const db = new DatabaseSync(path.join(scriptedStateDir, "tamandua.db"), { readOnly: true });
  const runTokens = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get().total;
  const systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get().system_tokens_spent;
  db.close();
  assert.equal(runTokens, 0, "W4.49 observed nonzero run tokens");
  assert.equal(systemTokens, 0, "W4.49 system token tripwire moved");
  return {
    scenario: scenarioId,
    arm,
    ...extra,
    tokens_spent: runTokens,
    system_tokens_spent: systemTokens,
    result: "PASS",
  };
}

function assertNoPartialTempFiles() {
  const status = git(installed, ["status", "--porcelain", "--untracked-files=all"]).stdout;
  const partial = status.split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((relative) => /\.(?:tmp|partial|lock)$/.test(relative));
  assert.deepEqual(partial, [], `partial update files remain: ${partial.join(", ")}`);
  return partial;
}

function inventory(root) {
  const rows = [];
  walk(root, (candidate, entry) => {
    if (entry.isFile()) {
      rows.push([path.relative(root, candidate), crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex")]);
    }
    return true;
  });
  return rows.sort(([a], [b]) => a.localeCompare(b));
}

function digestInventory(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function walk(root, visit) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    const descend = visit(candidate, entry);
    if (descend !== false && entry.isDirectory()) walk(candidate, visit);
  }
}

function writeTargetProvenance(value) {
  fs.writeFileSync(provenancePath, `${JSON.stringify({ ...value, recorded_at: new Date().toISOString() }, null, 2)}\n`);
}

async function waitForFile(file, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("update exited before fault marker");
    await delay(20);
  }
  throw new Error(`timed out waiting for marker: ${file}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    delay(timeoutMs).then(() => { throw new Error("timed out waiting for update exit"); }),
  ]);
}

async function waitForGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(-pgid, 0); } catch { return; }
    await delay(25);
  }
  process.kill(-pgid, "SIGKILL");
  throw new Error(`interrupted update process group ${pgid} leaked`);
}

function processStat(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
}

function processGroup(pid) {
  return Number(processStat(pid)[2]);
}

function processStartTime(pid) {
  return processStat(pid)[19];
}

async function assertScriptedPortsFree() {
  let lastOccupied = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // A successful update stops the daemon and starts its replacement while
    // the first teardown stop may still be observing the old PID. Reissue the
    // sanctioned, provenance-checked stop across that narrow restart race.
    if (attempt > 0 && attempt % 10 === 0) {
      spawnSync(daemonControl, ["scripted", "stop"], {
        cwd: repoRoot,
        env: daemonControlEnv,
        encoding: "utf8",
        timeout: 30_000,
      });
      stopContainedReplacement();
    }
    const occupied = [];
    for (const port of [5334, 5338, 5339]) {
      if (!await portIsFree(port)) occupied.push(port);
    }
    if (occupied.length === 0) return;
    lastOccupied = occupied;
    await delay(50);
  }
  assert.fail(`scripted listeners leaked after stop propagation: ${lastOccupied.join(", ")}`);
}

function stopContainedReplacement() {
  // runUpdate's finally path launches from the installed fixture after the
  // original daemon-control PID has exited. Stop that exact state-bound
  // replacement before the harness removes the fixture; daemon-control still
  // owns and performs the primary lifecycle cleanup.
  if (!fs.existsSync(installedCli)) return;
  spawnSync(installedCli, ["daemon", "stop"], {
    cwd: installed,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  for (const args of [["daemon", "stop"], ["dashboard", "stop"], ["mcp", "stop"]]) {
    spawnSync(installedCli, args, {
      cwd: installed,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  }
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
  });
}

function git(cwd, args) {
  return run(realGit, args, { cwd, env: process.env });
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

function commandPath(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`${command} is required`);
  return result.stdout.trim();
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

function requiredValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing scenario environment: ${name}`);
  return value;
}

function requiredPath(name) {
  return path.resolve(requiredValue(name));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

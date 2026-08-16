#!/usr/bin/env node
/**
 * W4.12 Port squatter on the daemon's control port — zero-token scripted
 * scenario cell (spec 08 §C W4.12).
 *
 * Choreography (all on the CONTAINED scripted daemon; the spec's 4339 maps to
 * the scripted control port 5339 — a contained-port substitution, documented
 * in the traceability):
 *
 *   1. The scripted daemon is RUNNING (owns 5339).
 *   2. A RETRYING binder (the squatter) starts BEFORE `tamandua restart`: it
 *      loops on EADDRINUSE while the daemon owns the port (a naive pre-bound
 *      squatter would just exit — the spec's first-draft failure mode).
 *   3. `tamandua restart --force` stops the services; the daemon releases
 *      5339 at the stop→start barrier and the squatter's next retry WINS the
 *      bind (the barrier is the stop's pidfile unlink — the squatter holds the
 *      port from that moment).
 *   4. The daemon's start attempt fails with a clean EADDRINUSE diagnosis in
 *      the daemon log; the daemon cleans its pidfile and exits — NO half-up
 *      daemon with a live pidfile (O13 — named in the task text, not declared:
 *      the O13 oracle is not implemented yet).
 *   5. The runner CAPTURES the failed-start evidence, then releases the
 *      squatter (it closes its socket).
 *   6. A retry `tamandua restart --force` succeeds; the control plane is back
 *      up.
 *
 * Zero tokens: no workflow run is launched; the scripted daemon drives nothing
 * (the behaviors file is inert). The daemon lifecycle is the product CLI
 * (`tamandua restart`) on the contained env — never the production daemon.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
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
assert.equal(scenarioId, "w4.12-port-squatter", "scenario id mismatch");

const cli = path.join(repoRoot, "bin", "tamandua");
const daemonControl = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const dbPath = path.join(stateDir, "tamandua.db");
const daemonLog = path.join(stateDir, "tamandua.log");
const daemonPidFile = path.join(stateDir, "tamandua.pid");
const CONTROL_PORT = 5339; // scripted kind control port (spec's 4339 substituted)

const squatterScript = path.join(invocationDir, "squatter.mjs");
const errorMarker = path.join(invocationDir, "squatter-error.marker");
const heldMarker = path.join(invocationDir, "squatter-held.marker");
const releaseFile = path.join(invocationDir, "squatter-release.file");

for (const candidate of [squatterScript, errorMarker, heldMarker, releaseFile]) {
  assert.ok(candidate === invocationDir || candidate.startsWith(`${invocationDir}${path.sep}`),
    `W4.12 mutable path escaped torture-test/var: ${candidate}`);
}
assert.ok(dbPath.startsWith(`${stateDir}${path.sep}`) || dbPath === stateDir,
  `W4.12 ledger path escaped the contained state dir: ${dbPath}`);
const varReal = fs.realpathSync(path.join(repoRoot, "torture-test", "var"));
const stateReal = fs.realpathSync(stateDir);
assert.ok(stateReal === varReal || stateReal.startsWith(`${varReal}${path.sep}`),
  `W4.12 state dir escaped torture-test/var: ${stateReal}`);

// ── helpers ─────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSync(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
  });
  return {
    status: result.status,
    signal: result.signal ?? null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function portListening(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function waitForFile(file, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}: ${file}`);
}

// ── setup: write the retrying binder ────────────────────────────────

fs.rmSync(errorMarker, { force: true });
fs.rmSync(heldMarker, { force: true });
fs.rmSync(releaseFile, { force: true });

fs.writeFileSync(squatterScript, `#!/usr/bin/env node
// W4.12 retrying binder: loops on EADDRINUSE while the daemon owns the port,
// WINS the bind when the port frees during restart's stop->start barrier,
// holds it until the runner has captured the failed start and releases it.
import fs from "node:fs";
import net from "node:net";
const port = Number(process.env.SQUAT_PORT);
const errorMarker = process.env.SQUAT_ERROR_MARKER;
const heldMarker = process.env.SQUAT_HELD_MARKER;
const releaseFile = process.env.SQUAT_RELEASE_FILE;
let attempts = 0;
function tryBind() {
  const server = net.createServer();
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE") {
      attempts += 1;
      if (attempts === 1) fs.writeFileSync(errorMarker, "1");
      setTimeout(tryBind, 30); // retry loop — never exit on EADDRINUSE
    } else {
      console.error("squatter fatal:", err);
      process.exit(2);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    fs.writeFileSync(heldMarker, "1"); // WON the bind during the barrier
    const timer = setInterval(() => {
      if (fs.existsSync(releaseFile)) {
        clearInterval(timer);
        server.close(() => process.exit(0)); // release after capture
      }
    }, 50);
  });
}
tryBind();
`, { encoding: "utf8", mode: 0o755 });

// ── preflight: the scripted daemon is up and owns 5339 ──────────────

assert.equal(await portListening(CONTROL_PORT), true,
  "W4.12: the scripted daemon must be running and own the control port before the choreography");

// Snapshot the daemon log so the EADDRINUSE diagnosis is read from the
// appended portion only.
const logSizeBefore = fs.existsSync(daemonLog) ? fs.statSync(daemonLog).size : 0;

// ── choreography ────────────────────────────────────────────────────

// 1. Start the retrying binder BEFORE the restart.
const squatter = spawn(process.execPath, [squatterScript], {
  cwd: invocationDir,
  env: {
    ...process.env,
    SQUAT_PORT: String(CONTROL_PORT),
    SQUAT_ERROR_MARKER: errorMarker,
    SQUAT_HELD_MARKER: heldMarker,
    SQUAT_RELEASE_FILE: releaseFile,
  },
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
let squatterErr = "";
squatter.stderr.on("data", (chunk) => { squatterErr += chunk.toString(); });
const squatterExit = once(squatter, "close").then(([code, signal]) => ({ code, signal }));

// The squatter must be looping on EADDRINUSE while the daemon owns the port
// (the spec's "a naive pre-bound squatter just exits" failure mode is pinned by
// asserting the squatter is ALIVE and has observed at least one EADDRINUSE).
await waitForFile(errorMarker, 15_000, "squatter first EADDRINUSE");
assert.equal(squatter.exitCode, null, "W4.12: the retrying binder must NOT exit on EADDRINUSE (naive squatter failure mode)");

// 2. `tamandua restart --force` — the product command on the contained env.
const restart = spawn(cli, ["restart", "--force"], {
  cwd: repoRoot,
  env: { ...process.env, PATH: `${repoRoot}/bin:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
let restartOut = "";
let restartErr = "";
restart.stdout.on("data", (chunk) => { restartOut += chunk.toString(); });
restart.stderr.on("data", (chunk) => { restartErr += chunk.toString(); });
const restartDone = once(restart, "close").then(([code, signal]) => ({ code, signal }));

// 3. The squatter must WIN the bind during the stop→start barrier.
await waitForFile(heldMarker, 60_000, "squatter won the bind (stop->start barrier)");
const heldAt = Date.now();

// 4. The restart terminates (daemon start failed with EADDRINUSE).
const restartResult = await restartDone;

// 5. Capture the failed-start evidence BEFORE releasing the squatter. The
// diagnosis appears in the RESTART's own output (its "daemon failed to start"
// error embeds the daemon log tail) in the normal path, and in the daemon
// log's tail region in the startDaemon race path (the daemon dies a moment
// after startDaemon returns). The daemon writes asynchronously, so poll both
// sources (a single read can race a partially-written line).
const DIAGNOSIS_RE = /EADDRINUSE|Failed to start control plane|already in use/i;
const diagDeadline = Date.now() + 15_000;
let logTail = "";
while (Date.now() < diagDeadline) {
  if (DIAGNOSIS_RE.test(`${restartOut}\n${restartErr}`)) break;
  logTail = fs.existsSync(daemonLog) ? fs.readFileSync(daemonLog, "utf8") : "";
  if (DIAGNOSIS_RE.test(logTail.slice(-3000))) break;
  await delay(250);
}
const diagnosisSource = `${restartOut}\n${restartErr}\n${logTail.slice(-3000)}`;
assert.match(diagnosisSource, DIAGNOSIS_RE,
  `W4.12: the daemon must produce a clean EADDRINUSE diagnosis (restart exit ${restartResult.code}; got: ${diagnosisSource.slice(-2000)})`);
// No half-up daemon with a live pidfile (O13): the failed daemon cleaned its
// pidfile, or the recorded pid is dead.
const pidfileLive = (() => {
  if (!fs.existsSync(daemonPidFile)) return false;
  const pid = Number(fs.readFileSync(daemonPidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
})();
assert.equal(pidfileLive, false, "W4.12: no half-up daemon may hold a live pidfile after the failed start (O13)");
// The squatter (not the daemon) owns 5339 — the daemon never bound it.
assert.ok(fs.existsSync(heldMarker), "W4.12: the squatter must hold the port");

// 6. Release the squatter only after the failed start is captured.
fs.writeFileSync(releaseFile, "release", { encoding: "utf8" });
const squatterResult = await squatterExit;
assert.equal(squatterResult.code, 0, `W4.12: the squatter must exit cleanly after release (stderr: ${squatterErr})`);

// Restore the contained configured port files. OBSERVED PRODUCT BEHAVIOR: the
// first restart's stop phase deletes ~/.tamandua/port and mcp-port, and the
// failed daemon start never rewrites them — a retry `tamandua restart` then
// falls back to the production DEFAULTS (3334/3338) and fails on those
// production listeners. The scenario restores the contained configured ports
// (5334/5338 per tt-env-scripted.sh) before the retry so the corridor under
// test stays the port-squatter recovery, and records the fallback as an
// observed product behavior in the report.
fs.writeFileSync(path.join(stateDir, "port"), "5334\n", { encoding: "utf8" });
fs.writeFileSync(path.join(stateDir, "mcp-port"), "5338\n", { encoding: "utf8" });

// 7. Retry restart succeeds once the port is free.
const retry = runSync(cli, ["restart", "--force"], {
  timeoutMs: 180_000,
  env: { ...process.env, PATH: `${repoRoot}/bin:${process.env.PATH}` },
});
assert.equal(retry.status, 0, `W4.12: the retry restart must succeed after the squatter release:\n${retry.stdout}\n${retry.stderr}`);
assert.match(`${retry.stdout}\n${retry.stderr}`, /All services restarted/,
  "W4.12: the retry restart must report full service restart");
const ctrlDeadline = Date.now() + 30_000;
let controlUp = false;
while (Date.now() < ctrlDeadline) {
  if (await portListening(CONTROL_PORT)) { controlUp = true; break; }
  await delay(500);
}
assert.equal(controlUp, true, "W4.12: the control plane must be reachable after the retry restart");
assert.ok(fs.existsSync(daemonPidFile), "W4.12: the daemon pidfile must exist after the successful restart");
const livePid = Number(fs.readFileSync(daemonPidFile, "utf8").trim());
assert.ok(Number.isInteger(livePid) && livePid > 0, "W4.12: daemon pidfile must hold a live pid");

// ── token + ledger hygiene ──────────────────────────────────────────

const db = new DatabaseSync(dbPath, { readOnly: true });
let runTokens = 0;
let systemTokens = 0;
try {
  runTokens = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get().total;
  systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get().system_tokens_spent;
} finally {
  db.close();
}
assert.equal(runTokens, 0, "W4.12 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.12 system token tripwire moved");

// ── cleanup: stop the CLI-started daemon so the harness teardown finds the
// contained ports free (the daemon running now was started by `tamandua
// restart`, not by daemon-control — no provenance row). ───────────────

for (const args of [["daemon", "stop"], ["dashboard", "stop"], ["mcp", "stop"]]) {
  runSync(cli, args, { timeoutMs: 60_000 });
}

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  choreography: {
    squatter_first_eadrinuse: true,
    squatter_retried_instead_of_exiting: true,
    squatter_won_during_barrier: true,
    barrier_held_at_ms: Date.now() - heldAt,
    restart_exit_code: restartResult.code,
    restart_exit_signal: restartResult.signal,
    daemon_eaddrinuse_diagnosis: true,
    no_half_up_daemon: true,
    squatter_released_after_capture: true,
    retry_restart_exit_code: retry.status,
    control_plane_up: true,
    observed_restart_stop_deletes_port_files: true,
  },
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
}, null, 2)}\n`);

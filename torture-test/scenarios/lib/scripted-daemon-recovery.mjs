// scripted-daemon-recovery.mjs — scripted-daemon liveness watchdog + recovery
// (T2.1 EMERGENCY, US-008 — the W4.24-serial-lane-concurrent cell).
//
// Campaign evidence (operator run on merged main,
// campaign-20260816T235948135Z): W4.24 exited 1 at
// run-serial-lane-concurrent.mjs:260 (completedRunId `strictEqual 2 vs 0`)
// with stderr `run ... is 'running' but the daemon is down — it may be
// stalled`. Diagnosis from the state-dir lifecycle log + systemd journal:
// the cell's contained scripted daemon (PID 55431, started 00:03:50Z) was
// SIGTERM'd at 00:04:45Z — ONE second after a CONCURRENT campaign in another
// worktree (862-c9ab2422) ran `daemon-control scripted start`. daemon-control
// started the scripted daemon inside a FIXED per-user systemd scope unit name
// `tamandua-tt-scripted`, and its cmd_start clean-slate step ran
// `systemctl --user stop tamandua-tt-scripted.scope` — which killed WHATEVER
// daemon currently owned that scope, including a sibling worktree's live
// daemon. (T2.1 US-009 has since removed the fixed name: daemon-control now
// derives a PER-WORKTREE scope unit `tamandua-tt-<kind>-<repo-root hash>`,
// so a concurrent worktree's clean-slate can no longer kill this worktree's
// daemon — but the same-worktree daemon can still die from other causes, so
// the watchdog below remains the honest recovery path.) The W4.24 TT run
// stalled at 4/6 steps (pending 1, running 0) and
// `workflow run --wait --timeout 6m` timed out (exit 2) because the cell had
// NO recovery orchestration: it assumed the daemon stays up for the whole
// corridor.
//
// The product run-recovery path: on daemon (re)start the reconciler's first
// tick (~1s) re-admits every `running` run (handleRegisterRun) and requeues
// steps claimed by dead workers (recoverStepsWithDeadWorkers) — so a run
// stalled by a daemon-down window RESUMES once the daemon is back. This
// module is the cell-side recovery orchestration that turns that product
// path into a passing corridor: while TT runs are in flight, watch the
// contained daemon; on DOWN, restart it via daemon-control (the sanctioned
// starter) and keep watching until the runs reach a terminal state.
//
// The watchdog is honest: every down window is recorded (detectedAt, whether
// a restart was attempted and succeeded, when the daemon came back), and the
// recovery bound is a tripwire — if the daemon never comes back the runs
// stall and the cell's own run-completion assertions fail (never weakened).
//
// Confined to torture-test/. Zero tokens. Never touches the live daemon
// (daemon-control's production guards apply unchanged).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCaptured(command, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ status: null, stdout, stderr: `${stderr}\n[daemon-control timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}\n[spawn error: ${err.message}]` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

// isDaemonUp(stateDir) — is the contained scripted daemon alive? Mirrors the
// product's own isDaemonRunning (src/cli/commands/wait.ts): read the daemon
// PID file and signal-0 the pid. The pid file is written by `tamandua daemon
// start` and removed on graceful shutdown, so a missing/dead pid is exactly
// the signal the product's `workflow run --wait` uses to print its
// "daemon is down" warning.
export function isDaemonUp(stateDir) {
  const pidFile = path.join(stateDir, "tamandua.pid");
  try {
    if (!fs.existsSync(pidFile)) return false;
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (Number.isNaN(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// recoverScriptedDaemon(options) — restart the contained scripted daemon via
// daemon-control (the ONLY sanctioned starter) and wait until the daemon pid
// file + signal-0 liveness confirm it is up.
//
// env contract: the caller passes its own process env (the scenario cell's
// env — which carries TAMANDUA_SCRIPTED_BEHAVIORS / TAMANDUA_SCRIPTED_STATE
// from run-scripted-scenario). daemon-control's env_for_kind forwards those
// two keys from the caller env into the daemon spawn env at start, so the
// restarted daemon drives the SAME scripted behaviors file the scenario
// harness materialized. HOME is overridden to the operator's account home and
// PATH is prefixed with <repoRoot>/bin exactly like run-scripted-scenario's
// daemon_control wrapper does (the production guards in daemon-control derive
// REAL_TAMANDUA_STATE from getent, and the spawned daemon env comes from
// tt-env-scripted.sh — the operator HOME never reaches a daemon child).
export async function recoverScriptedDaemon({
  stateDir,
  repoRoot,
  daemonControlPath = path.join(repoRoot, "torture-test", "bin", "daemon-control"),
  accountHome,
  env = process.env,
  upTimeoutMs = 30_000,
  spawnTimeoutMs = 120_000,
}) {
  const spawnEnv = {
    ...env,
    HOME: accountHome,
    PATH: `${path.join(repoRoot, "bin")}${path.sep}${env.PATH ?? ""}`,
  };
  const startedAt = Date.now();
  const result = await runCaptured(daemonControlPath, ["scripted", "start"], spawnEnv, spawnTimeoutMs);
  if (result.status !== 0) {
    return {
      ok: false,
      error: `daemon-control scripted start exited ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`,
      exitCode: result.status,
      durationMs: Date.now() - startedAt,
    };
  }
  // Poll for liveness (pid file + signal-0) — daemon-control's own port-wait
  // already returned, but the pid file is the product check the runs' wait
  // CLI uses; confirm it before declaring recovery.
  const deadline = Date.now() + upTimeoutMs;
  while (Date.now() < deadline) {
    if (isDaemonUp(stateDir)) {
      return { ok: true, exitCode: 0, durationMs: Date.now() - startedAt, upAfterMs: Date.now() - startedAt };
    }
    await sleep(250);
  }
  return {
    ok: false,
    error: `daemon-control scripted start exited 0 but the daemon pid never became live at ${stateDir}/tamandua.pid within ${upTimeoutMs}ms`,
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
  };
}

// watchScriptedDaemonLiveness(options) — while isWorkInFlight() is true, poll
// the contained scripted daemon; on DOWN, restart it (bounded by
// maxRecoveries) and keep watching until the daemon comes back. Returns the
// honest evidence:
//   downWindows: [ { detectedAt, restartAttempted, restartOk, error?,
//                    recovered, recoveredAt? } ]
//   recoveries:  number of daemon-control starts this watch performed
//
// A window is one DOWN episode: it opens when liveness fails while work is in
// flight and closes when the daemon is up again (by our restart or, in a
// pathological concurrent-worktree case, an external start). Every window is
// recorded even when recovery is exhausted and the runs time out — the cell's
// run-completion assertions then fail honestly.
export async function watchScriptedDaemonLiveness({
  stateDir,
  repoRoot,
  accountHome,
  env = process.env,
  isWorkInFlight,
  maxRecoveries = 3,
  pollMs = 1000,
  retryBackoffMs = 5000,
  ...recoverOptions
}) {
  const downWindows = [];
  let recoveries = 0;
  let inWindow = false;

  while (isWorkInFlight()) {
    await sleep(pollMs);
    if (isDaemonUp(stateDir)) {
      inWindow = false;
      continue;
    }
    if (!inWindow) {
      inWindow = true;
      downWindows.push({
        detectedAt: new Date().toISOString(),
        restartAttempted: false,
        restartOk: false,
        recovered: false,
      });
    }
    const window = downWindows[downWindows.length - 1];
    if (isDaemonUp(stateDir)) {
      window.recovered = true;
      window.recoveredAt = new Date().toISOString();
      inWindow = false;
      continue;
    }
    // Give a failed restart a moment before retrying the same episode (the
    // start can transiently fail under port/scope contention with a sibling
    // worktree), then try again up to the recovery bound.
    if (window.restartAttempted && Date.now() - window.lastRestartAt < retryBackoffMs) {
      continue;
    }
    if (recoveries >= maxRecoveries) {
      continue; // exhausted — the runs will time out and the cell fails honestly
    }
    recoveries += 1;
    window.restartAttempted = true;
    window.lastRestartAt = Date.now();
    const attempt = await recoverScriptedDaemon({
      stateDir,
      repoRoot,
      accountHome,
      env,
      ...recoverOptions,
    });
    window.restartOk = attempt.ok;
    if (!attempt.ok) {
      window.error = attempt.error;
    }
    if (isDaemonUp(stateDir)) {
      window.recovered = true;
      window.recoveredAt = new Date().toISOString();
      inWindow = false;
    }
  }

  return { downWindows, recoveries };
}

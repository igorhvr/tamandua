#!/usr/bin/env node
/**
 * tamandua-test — Content-Addressed Test-Suite Ledger Shim
 *
 * Intercepts test commands and implements lookup, decision, execute/replay
 * logic with passthrough degradation. Must be STRICTLY MONOTONE: it may
 * only skip work that is provably redundant. On any doubt, error, or
 * unexpected condition it degrades to running the real command unchanged.
 *
 * The one deliberate exception: tracked-dirty refusals (exit 88) are
 * fail-closed even when the control plane is down. TAMANDUA_TSTX=0 is the
 * complete bypass for all shim logic (see printHelp).
 *
 * CLI: tamandua-test --repo <path> --run <runId> --step <stepId> [--force] -- <cmd...>
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  TTL_GREEN_MS,
  RED_CONTEXT_WINDOW_MS,
  CLAIM_TIMEOUT_MS,
  LOG_TAIL_KB,
  isTstxEnabled,
} from "./config.js";

const SINGLEFLIGHT_POLL_INTERVAL_MS = 1000; // 1s
/** Dedicated fail-closed exit when a passing command cannot be attributed. */
const TREE_DRIFT_EXIT_CODE = 86;
/** Dedicated red-ledger exit for executions interrupted by a catchable signal
 *  from the CALLER (e.g., command timeout, external kill). The suite was
 *  terminated before it could finish; no usable evidence was produced. */
const INTERRUPTED_EXIT_CODE = 87;
/** Dedicated refusal when tracked files are already dirty before testing. */
const TREE_DIRTY_EXIT_CODE = 88;
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"];

// Module-level variables so the catch handler at the bottom can reach the
// parsed command even when main() throws after parsing (SHCA fix).
// savedCmdString is used by the SHSH fix (shell semantics via sh -c).
let savedCmdArgs: string[] = [];
let savedCmdString: string = "";

// ── CLI argument parsing ──────────────────────────────────────────────

interface ParsedArgs {
  repo: string;
  runId: string;
  stepId: string;
  force: boolean;
  cmdArgs: string[];
  cmdString: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let repo = "";
  let runId = "";
  let stepId = "";
  let force = false;
  let separatorIdx = -1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      separatorIdx = i;
      break;
    }
    if ((arg === "--repo" || arg === "-r") && i + 1 < argv.length) {
      repo = argv[++i];
      continue;
    }
    if ((arg === "--run" || arg === "-R") && i + 1 < argv.length) {
      runId = argv[++i];
      continue;
    }
    if ((arg === "--step" || arg === "-s") && i + 1 < argv.length) {
      stepId = argv[++i];
      continue;
    }
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  const cmdArgs = separatorIdx >= 0 ? argv.slice(separatorIdx + 1) : [];
  const cmdString = cmdArgs.join(" ");

  return { repo, runId, stepId, force, cmdArgs, cmdString };
}

function printHelp(): void {
  process.stderr.write(`Usage: tamandua-test --repo <path> --run <id> --step <id> [--force] -- <command...>

Options:
  --repo, -r   Path to the git repository (required for caching)
  --run, -R    Run ID for ledger attribution
  --step, -s   Step ID for ledger attribution
  --force, -f  Force execution even when a fresh green cache entry exists
  --help, -h   Show this help

Environment:
  TAMANDUA_TSTX=0   Disable caching entirely (full passthrough)

A content-addressed test-suite ledger that skips re-execution of test
commands against byte-identical working trees, replaying the recorded
result instead. Strictly monotone: degrades to passthrough on any doubt.
Results are recorded only when tracked repository content stays unchanged
through process exit. Tree drift requires a stable-tree rerun and makes an
otherwise passing command exit ${TREE_DRIFT_EXIT_CODE}.
Uncommitted tracked changes are refused before lookup or execution with exit
${TREE_DIRTY_EXIT_CODE}; untracked artifacts do not affect ledger evidence.
Executions interrupted by SIGHUP, SIGINT, SIGQUIT, or SIGTERM terminate their
child process, record red evidence, and exit ${INTERRUPTED_EXIT_CODE}.

Exit codes 86, 87, 88 are meaningful only when accompanied by this shim's
own stderr message. A test command's own 86, 87, or 88 exit code is passed
through verbatim.
`);
}

// ── Passthrough ───────────────────────────────────────────────────────

function passthroughNotice(reason: string): void {
  process.stderr.write(`tamandua-test: passthrough mode — ${reason}\n`);
}

/**
 * Execute the command via a subshell with inherited stdio (R14-R15).
 * Passthrough MUST be indistinguishable from running the raw command
 * except for the single stderr notice already emitted.
 *
 * SHSH: Runs the command string through /bin/sh -c to preserve env
 * prefixes, &&, pipes, quoting — everything the agent's shell would do.
 */
function passthroughExec(cmdString: string): void {
  if (cmdString.length === 0) {
    process.stderr.write("tamandua-test: error: no command to run\n");
    process.exit(1);
  }

  const child = spawn("/bin/sh", ["-c", cmdString], {
    stdio: "inherit",
  });

  child.on("close", (code: number | null) => {
    process.exit(code ?? 1);
  });

  child.on("error", (err: Error) => {
    process.stderr.write(`tamandua-test: failed to spawn command: ${err.message}\n`);
    process.exit(1);
  });
}

function getTrackedDirtyPaths(repoDir: string): string[] | null {
  try {
    const result = spawnSync(
      "git",
      ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"],
      {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    if (result.status !== 0) return null;
    return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

// ── Execute & capture ─────────────────────────────────────────────────

interface ExecuteResult {
  exitCode: number;
  durationMs: number;
  output: string; // combined stdout + stderr
}

/**
 * Spawn the command via a subshell, stream stdout/stderr through
 * unmodified, and capture the complete output for ledger recording (R9).
 *
 * SHSH: Runs the command string through /bin/sh -c to preserve env
 * prefixes, &&, pipes, quoting — everything the agent's shell would do.
 */
function executeAndCapture(cmdString: string): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const child: ChildProcess = spawn("/bin/sh", ["-c", cmdString], {
      stdio: ["ignore", "pipe", "pipe"],
      // Give the shell and its descendants a process group so timeout signals
      // forwarded to the shim terminate the whole suite, not only /bin/sh.
      detached: process.platform !== "win32",
    });

    let captured = "";
    let completed = false;
    let interruptedBy: NodeJS.Signals | null = null;

    const finish = (exitCode: number, output: string = captured): void => {
      if (completed) return;
      completed = true;
      resolve({
        exitCode,
        durationMs: Date.now() - startTime,
        output,
      });
    };

    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (completed || interruptedBy !== null) return;
      interruptedBy = signal;
      const evidence = `tamandua-test: suite KILLED by external ${signal} - this means the caller's command timeout or external signal terminated the suite before it finished. This attempt produced NO USABLE EVIDENCE; the suite must run to completion for results to be recorded in the evidence ledger.
`;
      process.stderr.write(evidence);
      captured += evidence;
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The child may already have closed; its close event still completes
        // this execution exactly once with interrupted evidence.
      }
    };

    for (const signal of FORWARDED_SIGNALS) {
      // Keep handlers through ledger finalization. A duplicate timeout signal
      // after child close must not restore Node's default immediate exit and
      // race the pending suite_results write.
      process.on(signal, () => forwardSignal(signal));
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      captured += text;
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      captured += text;
    });

    child.on("error", (err: Error) => {
      // If the command itself can't be spawned, treat as passthrough-ish failure.
      const evidence = `tamandua-test: failed to spawn command: ${err.message}`;
      process.stderr.write(`${evidence}\n`);
      finish(interruptedBy === null ? 1 : INTERRUPTED_EXIT_CODE, captured + evidence);
    });

    child.on("close", (code: number | null) => {
      finish(interruptedBy === null ? (code ?? 1) : INTERRUPTED_EXIT_CODE);
    });
  });
}

// ── Replay ────────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Print the replay banner and recorded log tail, then exit 0 (R12-R13).
 */
function replay(
  latest: Record<string, unknown>,
  cmdDisplay: string,
  ageMs: number,
): void {
  const treeHashShort = String(latest.tree_hash ?? "").slice(0, 12);
  const runId = latest.run_id ?? "?";
  const stepId = latest.step_id ?? "?";
  const duration = typeof latest.duration_ms === "number"
    ? (latest.duration_ms / 1000).toFixed(1)
    : "?";
  const logTail = typeof latest.log_tail === "string" ? latest.log_tail : "";

  // R12: Replay banner (greppable).
  process.stdout.write(
    `TAMANDUA-TEST CACHED: tree ${treeHashShort} passed ${cmdDisplay} ${formatAge(ageMs)} ago (run #${runId}, step ${stepId}, exit 0, ${duration}s)\n`,
  );

  const tailKB = logTail.length > 0
    ? Math.ceil(logTail.length / 1024)
    : 0;
  process.stdout.write(`--- recorded output (last ${tailKB}KB) ---\n`);
  if (logTail) {
    process.stdout.write(logTail);
  }

  // R13: Replay exits 0.
  process.exit(0);
}

// ── Red context note ──────────────────────────────────────────────────

function printRedContextNote(
  latest: Record<string, unknown>,
  cmdDisplay: string,
  ageMs: number,
): void {
  const minutesAgo = Math.max(1, Math.round(ageMs / 60_000));
  const runId = latest.run_id ?? "?";
  const stepId = latest.step_id ?? "?";
  process.stderr.write(
    `note: this tree failed ${cmdDisplay} ${minutesAgo}m ago (run #${runId}, step ${stepId}) — rerunning\n`,
  );
}

// ── Flaky banner ──────────────────────────────────────────────────────

function printFlakyBanner(
  passCount: number,
  failCount: number,
): void {
  const total = passCount + failCount;
  process.stderr.write(
    `⚠ FLAKY: identical tree produced ${passCount} passes / ${failCount} failures in last 24h (${total} total runs)\n`,
  );
}

// ── Sleep (setTimeout-based with unref) ────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── Single-flight poll (R16-R17) ────────────────────────────────────

interface PollResult {
  action: "replay" | "execute";
  latest?: Record<string, unknown>;
  ageMs?: number;
  ownsClaim?: boolean;
}

interface ClaimOwnership {
  ownerToken: string;
  ownerPid: number;
  runId: string;
  stepId: string;
}

/**
 * Poll the lookup endpoint until the claim owner records a result or
 * CLAIM_TIMEOUT elapses. Returns "replay" with the green result data
 * when a green record appears, or "execute" when a red record appears,
 * the control plane becomes unreachable, or the poll times out.
 */
async function pollForResult(
  originRepo: string,
  treeHash: string,
  cmdHash: string,
  ownership: ClaimOwnership,
  force: boolean,
): Promise<PollResult> {
  const startTime = Date.now();
  // Dynamic import inside poll — by the time we reach here, the module
  // is already loaded via the earlier lookup import.
  const { lookupSuiteRecord, claimSuiteKey } = await import("../server/control-client.js");

  while (Date.now() - startTime < CLAIM_TIMEOUT_MS) {
    await sleep(SINGLEFLIGHT_POLL_INTERVAL_MS);

    const lookup = await lookupSuiteRecord(originRepo, treeHash, cmdHash);
    if (lookup === null) {
      // Control plane unreachable during poll → execute.
      process.stderr.write(
        "tamandua-test: warning: control plane unreachable during single-flight poll — executing\n",
      );
      return { action: "execute", ownsClaim: false };
    }

    const latest = lookup.latest as Record<string, unknown> | null;
    if (latest && typeof latest.exit_code === "number") {
      if (!force && latest.exit_code === 0) {
        // Green result recorded by the claim owner → replay if fresh enough.
        const createdAt = String(latest.created_at ?? "");
        const ageMs = Date.now() - new Date(createdAt).getTime();
        if (!isNaN(ageMs) && ageMs <= TTL_GREEN_MS) {
          return { action: "replay", latest, ageMs };
        }
        // Expired or NaN created_at — continue polling; the owner may be
        // producing a fresher result or the aged record is no longer valid.
      }
      // Red results are never replayed. Its recorder has released the key,
      // so continue below and claim before executing.
    }

    const claim = await claimSuiteKey(originRepo, treeHash, cmdHash, ownership);
    if (claim === null) {
      process.stderr.write(
        "tamandua-test: warning: control plane unreachable during single-flight claim — executing\n",
      );
      return { action: "execute", ownsClaim: false };
    }
    if (claim.action === "run") {
      return { action: "execute", ownsClaim: true };
    }
  }

  // CLAIM_TIMEOUT elapsed → execute (R17).
  process.stderr.write(
    "tamandua-test: single-flight claim poll timed out — executing\n",
  );
  return { action: "execute", ownsClaim: false };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { repo, runId, stepId, force, cmdArgs, cmdString } = parseArgs(process.argv.slice(2));

  // Save parsed command for the catch handler (SHCA fix + SHSH).
  savedCmdArgs = cmdArgs;
  savedCmdString = cmdString;

  // Test-only hook: force an unexpected error after parsing so the
  // SHCA catch-to-passthrough path is exercisable from tests.
  if (process.env.TAMANDUA_SHIM_TEST_THROW === "1") {
    throw new Error("TAMANDUA_SHIM_TEST_THROW: forced unexpected error after parsing");
  }

  // R14: TAMANDUA_TSTX=0 — full passthrough.
  if (!isTstxEnabled()) {
    passthroughNotice("TAMANDUA_TSTX=0 kill switch active");
    passthroughExec(cmdString);
    return;
  }

  // No command → error.
  if (cmdArgs.length === 0) {
    process.stderr.write("tamandua-test: error: no test command provided (use -- to separate args)\n");
    process.exit(1);
  }

  // No repo → passthrough.
  if (!repo) {
    passthroughNotice("no --repo specified");
    passthroughExec(cmdString);
    return;
  }

  // Resolve repo to realpath; if it doesn't exist, passthrough.
  let repoReal: string;
  try {
    repoReal = realpathSync(repo);
  } catch {
    passthroughNotice(`--repo path not found: ${repo}`);
    passthroughExec(cmdString);
    return;
  }

  // ── Dynamic imports for heavy modules (fast startup) ──────────────

  const { committedTreeHash, trackedTreeHash, computeCmdHash, getOriginRepo } = await import("./tree-hash.js");
  const { formatTrackedDirtyList } = await import("./dirty-list.js");

  // R3: Committed or tracked tree hashing failure → passthrough.
  let preTreeHash = committedTreeHash(repoReal);
  if (preTreeHash === null) {
    passthroughNotice("git tree hash failed (non-git directory or git error)");
    passthroughExec(cmdString);
    return;
  }
  if (trackedTreeHash(repoReal) === null) {
    passthroughNotice("git tracked tree hash failed (non-git directory or git error)");
    passthroughExec(cmdString);
    return;
  }

  // A committed-tree green must never replay while tracked content differs
  // from that commit. Ignore untracked files by construction.
  const initialDirtyPaths = getTrackedDirtyPaths(repoReal);
  if (initialDirtyPaths === null) {
    passthroughNotice("git tracked status failed");
    passthroughExec(cmdString);
    return;
  }
  if (initialDirtyPaths.length > 0) {
    process.stderr.write(
      `FAILURE_CLASS: tree_dirty\n`
      + `FAILURE: uncommitted changes to tracked files — commit them before testing\n`
      + `(the merge gate verifies the committed tree: git rev-parse HEAD^{tree}).\n`
      + `${formatTrackedDirtyList(initialDirtyPaths, 32)}\n`
      + `ACTION: commit or discard these, then re-run the suite via the shim.\n`,
    );
    process.exit(TREE_DIRTY_EXIT_CODE);
  }

  const cmdHash = computeCmdHash(cmdString);
  const originRepo = getOriginRepo(repoReal);
  const ownerToken = randomUUID();
  const claimOwnership: ClaimOwnership = {
    ownerToken,
    ownerPid: process.pid,
    runId,
    stepId,
  };

  const {
    lookupSuiteRecord,
    recordSuiteResult,
    claimSuiteKey,
    releaseSuiteKey,
    emitSuiteEvent,
  } = await import("../server/control-client.js");

  const replayCachedResult = async (
    cachedResult: Record<string, unknown>,
    treeHash: string,
    ageMs: number,
  ): Promise<boolean> => {
    // F1: Revalidate the working tree before replaying. Replay corridors
    // (waiter, re-key loop) bypass the owner-only initial checks, so they
    // must verify tracked-dirt and tree-hash independently here.

    // 1. Tracked-dirty: refuse to replay when tracked files are modified.
    const dirtyPaths = getTrackedDirtyPaths(repoReal);
    if (dirtyPaths === null) {
      return false; // can't verify — fall through to execute
    }
    if (dirtyPaths.length > 0) {
      process.stderr.write(
        `FAILURE_CLASS: tree_dirty\n`
        + `FAILURE: uncommitted changes to tracked files — commit them before testing\n`
        + `(the merge gate verifies the committed tree: git rev-parse HEAD^{tree}).\n`
        + `${formatTrackedDirtyList(dirtyPaths, 32)}\n`
        + `ACTION: commit or discard these, then re-run the suite via the shim.\n`,
      );
      process.exit(TREE_DIRTY_EXIT_CODE);
    }

    // 2. Tree-hash match: if HEAD moved, the cached result describes a
    //    different tree — fall through to execute against the current tree.
    const currentTreeHash = committedTreeHash(repoReal);
    if (currentTreeHash === null || currentTreeHash !== treeHash) {
      return false;
    }

    await emitSuiteEvent({
      event: "suite.cache_hit",
      run_id: runId,
      step_id: stepId,
      tree_hash: treeHash.slice(0, 12),
      cmd_display: cmdString.slice(0, 200),
      saved_duration_ms: typeof cachedResult.duration_ms === "number"
        ? cachedResult.duration_ms
        : undefined,
    }).catch(() => {
      // Best-effort — event emission failure must not block replay.
    });
    replay(cachedResult, cmdString.slice(0, 200) || cmdString, ageMs);
    // unreachable — replay() calls process.exit(0)
    return true;
  };

  // R14: Control plane unreachable → passthrough.
  const lookup = await lookupSuiteRecord(originRepo, preTreeHash, cmdHash);
  if (lookup === null) {
    passthroughNotice("control plane unreachable at lookup time");
    passthroughExec(cmdString);
    return;
  }

  // R8: Flaky banner — print before anything else on both replay and execute paths.
  if (lookup.flaky) {
    printFlakyBanner(lookup.passCount, lookup.failCount);
    // US-009: Emit suite.flaky_detected event (best-effort).
    emitSuiteEvent({
      event: "suite.flaky_detected",
      run_id: runId,
      step_id: stepId,
      tree_hash: preTreeHash,
      cmd_hash: cmdHash,
      pass_count: lookup.passCount,
      fail_count: lookup.failCount,
      window: "24h",
    }).catch(() => {
      // Best-effort — event emission failure must not affect the test flow.
    });
  }

  const latest = lookup.latest as Record<string, unknown> | null;

  // R5: Green within TTL and --force absent → replay.
  if (latest && typeof latest.exit_code === "number" && latest.exit_code === 0 && !force) {
    const createdAt = String(latest.created_at ?? "");
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (ageMs <= TTL_GREEN_MS) {
      await replayCachedResult(latest, preTreeHash, ageMs);
    }
  }

  // R6: Red entry → execute (with context note if recent).
  if (latest && typeof latest.exit_code === "number" && latest.exit_code !== 0) {
    const createdAt = String(latest.created_at ?? "");
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (ageMs <= RED_CONTEXT_WINDOW_MS) {
      printRedContextNote(latest, cmdString.slice(0, 200) || cmdString, ageMs);
    }
  }

  // R7: Miss, expired green, red, or --force → execute.
  // R16-R17: Before executing, claim the key for single-flight.
  const claim = await claimSuiteKey(originRepo, preTreeHash, cmdHash, claimOwnership);
  let ownsClaim = claim?.action === "run";

  if (claim && claim.action === "wait") {
    // US-009: Emit suite.singleflight_wait event (best-effort).
    emitSuiteEvent({
      event: "suite.singleflight_wait",
      run_id: runId,
      step_id: stepId,
      tree_hash: preTreeHash,
      cmd_hash: cmdHash,
      waited_ms: 0,
    }).catch(() => {
      // Best-effort — event emission failure must not block the wait loop.
    });
    // Another caller owns the claim — poll until a result is recorded or
    // CLAIM_TIMEOUT elapses.
    const pollResult = await pollForResult(originRepo, preTreeHash, cmdHash, claimOwnership, force);
    if (pollResult.action === "replay" && pollResult.latest) {
      await replayCachedResult(pollResult.latest, preTreeHash, pollResult.ageMs ?? 0);
    }
    // Poll returned "execute" — fall through to execute below.
    ownsClaim = pollResult.ownsClaim === true;
  }
  // If claim is null (control plane down after lookup) or action is "run",
  // proceed to execute below.

  // A promoted waiter may have observed an old key while the prior owner
  // changed the tree and released it. Re-key before execution so the retained
  // pre-run hash describes the tree that this caller actually tests.
  while (ownsClaim) {
    const executionTreeHash = committedTreeHash(repoReal);
    if (executionTreeHash === null || executionTreeHash === preTreeHash) break;

    await releaseSuiteKey(originRepo, preTreeHash, cmdHash, ownerToken).catch(() => false);
    preTreeHash = executionTreeHash;

    const currentLookup = await lookupSuiteRecord(originRepo, preTreeHash, cmdHash);
    const currentLatest = currentLookup?.latest as Record<string, unknown> | null | undefined;
    if (currentLookup?.flaky) {
      printFlakyBanner(currentLookup.passCount, currentLookup.failCount);
      emitSuiteEvent({
        event: "suite.flaky_detected",
        run_id: runId,
        step_id: stepId,
        tree_hash: preTreeHash,
        cmd_hash: cmdHash,
        pass_count: currentLookup.passCount,
        fail_count: currentLookup.failCount,
        window: "24h",
      }).catch(() => {
        // Best-effort — preserve execution when event emission fails.
      });
    }
    if (
      currentLatest
      && currentLatest.exit_code === 0
      && !force
      && Date.now() - new Date(String(currentLatest.created_at ?? "")).getTime() <= TTL_GREEN_MS
    ) {
      await replayCachedResult(
        currentLatest,
        preTreeHash,
        Date.now() - new Date(String(currentLatest.created_at ?? "")).getTime(),
      );
    }
    if (currentLatest && typeof currentLatest.exit_code === "number" && currentLatest.exit_code !== 0) {
      const currentAgeMs = Date.now() - new Date(String(currentLatest.created_at ?? "")).getTime();
      if (currentAgeMs <= RED_CONTEXT_WINDOW_MS) {
        printRedContextNote(currentLatest, cmdString.slice(0, 200) || cmdString, currentAgeMs);
      }
    }

    const currentClaim = await claimSuiteKey(originRepo, preTreeHash, cmdHash, claimOwnership);
    if (currentClaim === null) {
      ownsClaim = false;
      break;
    }
    if (currentClaim.action === "run") continue;

    const currentPoll = await pollForResult(originRepo, preTreeHash, cmdHash, claimOwnership, force);
    if (currentPoll.action === "replay" && currentPoll.latest) {
      await replayCachedResult(currentPoll.latest, preTreeHash, currentPoll.ageMs ?? 0);
    }
    ownsClaim = currentPoll.ownsClaim === true;
  }

  // A promoted waiter may have spent time behind the prior owner. Refuse if
  // tracked content became dirty while it waited, before running anything.
  const executionDirtyPaths = getTrackedDirtyPaths(repoReal);
  if (executionDirtyPaths === null) {
    if (ownsClaim) {
      await releaseSuiteKey(originRepo, preTreeHash, cmdHash, ownerToken).catch(() => false);
    }
    passthroughNotice("git tracked status failed before execution");
    passthroughExec(cmdString);
    return;
  }
  if (executionDirtyPaths.length > 0) {
    if (ownsClaim) {
      await releaseSuiteKey(originRepo, preTreeHash, cmdHash, ownerToken).catch(() => false);
    }
    process.stderr.write(
      `FAILURE_CLASS: tree_dirty\n`
      + `FAILURE: uncommitted changes to tracked files — commit them before testing\n`
      + `(the merge gate verifies the committed tree: git rev-parse HEAD^{tree}).\n`
      + `${formatTrackedDirtyList(executionDirtyPaths, 32)}\n`
      + `ACTION: commit or discard these, then re-run the suite via the shim.\n`,
    );
    process.exit(TREE_DIRTY_EXIT_CODE);
  }

  const trackedPre = trackedTreeHash(repoReal);
  if (trackedPre === null) {
    if (ownsClaim) {
      await releaseSuiteKey(originRepo, preTreeHash, cmdHash, ownerToken).catch(() => false);
    }
    passthroughNotice("git tracked tree hash failed before execution");
    passthroughExec(cmdString);
    return;
  }

  // F3: On ALL execution paths (owner and non-owner), if the HEAD moved
  // during the wait, re-key to the current committed tree so the recorded
  // row's tree_hash describes the tree that was actually tested.
  // On a clean tree trackedTreeHash === committedTreeHash, so
  // trackedPre !== preTreeHash means HEAD^{tree} changed.
  if (trackedPre !== preTreeHash) {
    if (ownsClaim) {
      await releaseSuiteKey(originRepo, preTreeHash, cmdHash, ownerToken).catch(() => false);
    }
    const currentTreeHash = committedTreeHash(repoReal);
    if (currentTreeHash === null) {
      passthroughNotice("git committed tree hash failed during re-key");
      passthroughExec(cmdString);
      return;
    }
    preTreeHash = currentTreeHash;

    // Look up the new key — a fresh green may exist for immediate replay.
    const rekeyLookup = await lookupSuiteRecord(originRepo, preTreeHash, cmdHash);
    if (rekeyLookup === null) {
      passthroughNotice("control plane unreachable during re-key lookup");
      passthroughExec(cmdString);
      return;
    }
    if (rekeyLookup.flaky) {
      printFlakyBanner(rekeyLookup.passCount, rekeyLookup.failCount);
      emitSuiteEvent({
        event: "suite.flaky_detected",
        run_id: runId,
        step_id: stepId,
        tree_hash: preTreeHash,
        cmd_hash: cmdHash,
        pass_count: rekeyLookup.passCount,
        fail_count: rekeyLookup.failCount,
        window: "24h",
      }).catch(() => {
        // Best-effort — event emission failure must not affect the test flow.
      });
    }

    const rekeyLatest = rekeyLookup.latest as Record<string, unknown> | null;
    if (
      rekeyLatest
      && rekeyLatest.exit_code === 0
      && !force
      && Date.now() - new Date(String(rekeyLatest.created_at ?? "")).getTime() <= TTL_GREEN_MS
    ) {
      await replayCachedResult(
        rekeyLatest,
        preTreeHash,
        Date.now() - new Date(String(rekeyLatest.created_at ?? "")).getTime(),
      );
      // unreachable — replayCachedResult calls process.exit(0) on success
    }
    if (rekeyLatest && typeof rekeyLatest.exit_code === "number" && rekeyLatest.exit_code !== 0) {
      const rekeyAgeMs = Date.now() - new Date(String(rekeyLatest.created_at ?? "")).getTime();
      if (rekeyAgeMs <= RED_CONTEXT_WINDOW_MS) {
        printRedContextNote(rekeyLatest, cmdString.slice(0, 200) || cmdString, rekeyAgeMs);
      }
    }

    // Re-claim for the new key.
    const rekeyClaim = await claimSuiteKey(originRepo, preTreeHash, cmdHash, claimOwnership);
    if (rekeyClaim === null) {
      ownsClaim = false;
    } else if (rekeyClaim.action === "run") {
      ownsClaim = true;
    } else {
      // Another caller holds the claim — poll for result.
      emitSuiteEvent({
        event: "suite.singleflight_wait",
        run_id: runId,
        step_id: stepId,
        tree_hash: preTreeHash,
        cmd_hash: cmdHash,
        waited_ms: 0,
      }).catch(() => {
        // Best-effort — event emission failure must not block the wait loop.
      });
      const rekeyPoll = await pollForResult(originRepo, preTreeHash, cmdHash, claimOwnership, force);
      if (rekeyPoll.action === "replay" && rekeyPoll.latest) {
        await replayCachedResult(rekeyPoll.latest, preTreeHash, rekeyPoll.ageMs ?? 0);
        // unreachable — replayCachedResult calls process.exit(0) on success
      }
      ownsClaim = rekeyPoll.ownsClaim === true;
    }
  }

  // US-002: Print prior-duration p50 hint before execution starts.
  // Silent degradation if the control plane is unreachable or no history exists.
  if (!force) {
    try {
      const { lookupSuiteDurationHistory } = await import("../server/control-client.js");
      const durations = await lookupSuiteDurationHistory(originRepo, cmdHash);
      if (durations !== null && durations.length > 0) {
        const sorted = [...durations].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const p50Ms = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        const p50Min = Math.round(p50Ms / 60_000);
        process.stderr.write(
          `TAMANDUA-TEST: expect ~${p50Min}min based on ${durations.length} prior runs — use a timeout comfortably above this\n`,
        );
      }
    } catch {
      // Silent degradation — hint is advisory only.
    }
  }

  // R9: Execute the command verbatim, streaming stdout/stderr through,
  //     preserving the exit code.
  const { exitCode, durationMs, output } = await executeAndCapture(cmdString);

  // Reusable evidence requires byte-identical tracked content from command
  // start through full process exit. Untracked artifacts are irrelevant.
  const trackedPost = trackedTreeHash(repoReal);
  if (trackedPost === null || trackedPost !== trackedPre) {
    const shortPre = trackedPre.slice(0, 12);
    const shortPost = trackedPost?.slice(0, 12) ?? "unavailable";
    const release = ownsClaim
      ? releaseSuiteKey(originRepo, preTreeHash, cmdHash, ownerToken).catch(() => false)
      : Promise.resolve(false);
    const event = emitSuiteEvent({
      event: "suite.tree_drift_detected",
      run_id: runId,
      step_id: stepId,
      pre_tree_hash: shortPre,
      post_tree_hash: shortPost,
      exit_code: exitCode,
    }).catch(() => {
      // Best-effort observability must not change drift handling.
    });
    await Promise.all([release, event]);
    const reason = trackedPost === null
      ? `post-run tree hash unavailable (pre ${shortPre})`
      : `tree changed during test execution (pre ${shortPre}, post ${shortPost})`;
    process.stderr.write(
      `tamandua-test: result could not be attributed: ${reason}; not recorded — stable-tree rerun required\n`,
    );
    process.exit(exitCode === 0 ? TREE_DRIFT_EXIT_CODE : exitCode);
  }

  // R10: Record via control plane. R11: Recording failure MUST NOT affect
  //      exit code or output — log a warning line to stderr and continue.
  try {
    const logTail = output.length > LOG_TAIL_KB * 1024
      ? output.slice(-LOG_TAIL_KB * 1024)
      : output || null;

    await recordSuiteResult({
      origin_repo: originRepo,
      tree_hash: preTreeHash,
      cmd_hash: cmdHash,
      cmd_display: cmdString.slice(0, 200),
      exit_code: exitCode,
      duration_ms: durationMs,
      log_tail: logTail,
      run_id: runId || null,
      step_id: stepId || null,
    });
    if (ownsClaim && exitCode === INTERRUPTED_EXIT_CODE) {
      // Recording normally clears the claim. This exact owner-token release
      // covers partial cancellation writes without touching another owner.
      await releaseSuiteKey(originRepo, preTreeHash, cmdHash, ownerToken).catch(() => false);
    }
  } catch {
    // R11: Recording failure — warn and continue.
    process.stderr.write("tamandua-test: warning: failed to record suite result to control plane\n");
  }

  process.exit(exitCode);
}

// ── Entry point ───────────────────────────────────────────────────────

main().catch((err: unknown) => {
  // Unexpected error — passthrough with the real command (SHCA fix).
  process.stderr.write(
    `tamandua-test: passthrough mode — unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  passthroughExec(savedCmdString);
});

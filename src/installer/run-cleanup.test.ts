import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  collectProcessSnapshot,
  matchDiagnosticRunEvidence,
  matchRunEvidence,
  parseLsofCwdRecords,
  sweepRunProcesses,
} from "../../dist/installer/run-cleanup.js";
import { resolveDaemonInstanceToken } from "../../dist/installer/sweep-ownership.js";
import type { RunCleanupResult } from "../../dist/installer/run-cleanup.js";
import { readEventsFromCursor, emitEvent, type TamanduaEvent } from "../../dist/installer/events.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import { getEnvironText, hasProcfs } from "../../dist/lib/proc-info.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** True on Linux/BSD hosts where procfs (not the bulk lsof table) is the cwd source. */
const procfs = hasProcfs();

/** Quote an absolute path for safe interpolation inside a single-quoted shell string. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Write an executable fake-lsof shim. */
function writeShim(file: string, body: string): string {
  fs.writeFileSync(file, body, "utf-8");
  fs.chmodSync(file, 0o755);
  return file;
}

/** Write a fake lsof that prints the given lines (one per line) and exits 0. */
function writeLsofShim(file: string, lines: string[], argvFile?: string): string {
  const body = [
    "#!/bin/sh",
    ...(argvFile ? [`printf '%s\\n' "$@" > ${shQuote(argvFile)}`] : []),
    ...lines.map((line) => `printf '%s\\n' ${shQuote(line)}`),
    "exit 0",
  ].join("\n");
  return writeShim(file, `${body}\n`);
}

/** Restore a string env var to its previous value (or unset it). */
function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

/** Run `fn` with TAMANDUA_LSOF_BIN/_TIMEOUT_MS pointed at a fake lsof. */
function withLsofEnv<T>(shim: string, timeoutMs: string | undefined, fn: () => T): T {
  const prevBin = process.env.TAMANDUA_LSOF_BIN;
  const prevTimeout = process.env.TAMANDUA_LSOF_TIMEOUT_MS;
  process.env.TAMANDUA_LSOF_BIN = shim;
  if (timeoutMs === undefined) delete process.env.TAMANDUA_LSOF_TIMEOUT_MS;
  else process.env.TAMANDUA_LSOF_TIMEOUT_MS = timeoutMs;
  try {
    return fn();
  } finally {
    restoreEnv("TAMANDUA_LSOF_BIN", prevBin);
    restoreEnv("TAMANDUA_LSOF_TIMEOUT_MS", prevTimeout);
  }
}

/**
 * THIS test process's daemon-instance token. Resolved fresh on every call
 * (beforeEach re-isolates TAMANDUA_STATE_DIR) so a child's injected token and
 * the sweep's expectation always agree.
 */
function daemonInstanceToken(): string {
  const token = resolveDaemonInstanceToken();
  assert.ok(token, "the test process must resolve a daemon-instance token");
  return token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until a child process exits, or resolve after a timeout.
 * Returns true if the process exited (killed), false if it timed out (still alive).
 */
function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Poll a process to see if it is still alive.
 */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 just checks if we can send signals — doesn't actually send one
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a long-lived same-user Node keepalive child.
 *
 * Marker/leak fixtures MUST use this instead of `/bin/sleep`: on macOS
 * `/bin/sleep` is an Apple platform binary whose environment KERN_PROCARGS2
 * does not expose, so its environ is unreadable and the daemon-scoped marker
 * channel correctly matches nothing. A Node child has a readable environ
 * through the native `proc-info env` helper (and procfs on Linux).
 */
function spawnKeepalive(env: NodeJS.ProcessEnv, cwd: string, detached = false): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30);"], {
    cwd,
    env,
    stdio: "ignore",
    detached,
  });
}

/** Marker env for a same-user child, carrying an optional daemon token. */
function keepaliveMarkerEnv(runId: string, daemonInstance?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/bin",
    TAMANDUA_RUN_ID: runId,
  };
  if (daemonInstance !== undefined) env.TAMANDUA_DAEMON_INSTANCE = daemonInstance;
  return env;
}

/**
 * Poll until a keepalive child's environ is readable through the
 * platform-neutral reader, or the deadline expires. The kernel only exposes
 * KERN_PROCARGS2 once the child has exec'd, so a fixed sleep can race a slow
 * start on darwin. Polling also keeps the survival tests honest: they must
 * evaluate a *readable* marker, not pass because the environ was unreadable.
 */
async function waitForReadableEnviron(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let environ = getEnvironText(pid);
  while ((environ === null || !environ.includes("PATH=")) && Date.now() < deadline) {
    await sleep(25);
    environ = getEnvironText(pid);
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("run-cleanup", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalTestGuard: string | undefined;
  let originalWorktreeRoot: string | undefined;

  // We spin up one fake worktree directory per test, plus marker processes.
  let fakeWorktreePath: string;
  let children: ChildProcess[];

  beforeEach(() => {
    // Full isolation
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalTestGuard = process.env.TAMANDUA_TEST_GUARD;
    originalWorktreeRoot = process.env.TAMANDUA_WORKTREE_ROOT;

    stateDir = tamanduaTempDir("tamandua-cleanup-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_TEST_GUARD = "1";
    process.env.TAMANDUA_WORKTREE_ROOT = path.join(stateDir, "worktrees");

    // Ensure we have a DB that emitEvent can use (events module resolves
    // the DB when firing webhooks — but for tests we just need state dir)
    const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT,
        status TEXT,
        notify_url TEXT,
        scheduling_status TEXT,
        updated_at TEXT
      );
    `);
    // Insert a lightweight run row so emitEvent doesn't error on webhook lookup
    db.prepare("INSERT OR REPLACE INTO runs (id, workflow_id, status) VALUES (?, ?, ?)").run(
      "test-run-001",
      "test-workflow",
      "running",
    );
    db.close();

    fakeWorktreePath = path.join(stateDir, "fake-worktree");
    fs.mkdirSync(fakeWorktreePath, { recursive: true });

    children = [];
  });

  afterEach(() => {
    // Restore env
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    if (originalTestGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
    else process.env.TAMANDUA_TEST_GUARD = originalTestGuard;
    if (originalWorktreeRoot === undefined) delete process.env.TAMANDUA_WORKTREE_ROOT;
    else process.env.TAMANDUA_WORKTREE_ROOT = originalWorktreeRoot;

    // Kill all spawned children
    for (const child of children) {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // already dead
      }
    }
    children.length = 0;

    // Clean up state directory
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Basic function shape ──────────────────────────────────────────

  it("sweepRunProcesses returns correct result shape", () => {
    const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
    assert.ok(result, "should return a result");
    assert.equal(result.runId, "test-run-001");
    assert.equal(result.worktreePath, fakeWorktreePath);
    assert.ok(typeof result.scannedPids === "number");
    assert.ok(Array.isArray(result.killedPids));
    assert.ok(typeof result.evidence === "object");
  });

  // ── Skip-own-pid and skip-pid-1 ───────────────────────────────────

  it("never kills pid 1 or own pid", () => {
    const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
    // pid 1 and our own pid should never appear in killedPids
    assert.ok(
      !result.killedPids.includes(1),
      "pid 1 must never be killed",
    );
    assert.ok(
      !result.killedPids.includes(process.pid),
      "our own pid must never be killed",
    );
  });

  // ── Daemon PID exclusion ─────────────────────────────────────────

  it("never kills the daemonPid when provided", async () => {
    // Spawn a marker process that WOULD match the exclusive kill gate, then
    // pass that pid as daemonPid — it must survive on the daemon exclusion
    // alone.
    const markerCwd = path.join(fakeWorktreePath, "daemon-dir");
    fs.mkdirSync(markerCwd, { recursive: true });
    const token = daemonInstanceToken();

    const child = spawnKeepalive(keepaliveMarkerEnv("test-run-001", token), markerCwd);
    children.push(child);

    // Wait until the child's environ is readable so the marker channel is armed.
    await waitForReadableEnviron(child.pid!);
    const daemonPid = child.pid!;
    assert.ok(isAlive(daemonPid), "marker process should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonPid,
      daemonInstance: token,
    });

    // The daemonPid should NOT be in killedPids
    assert.ok(
      !result.killedPids.includes(daemonPid),
      `daemonPid ${daemonPid} must not be killed: killedPids=${JSON.stringify(result.killedPids)}`,
    );

    // Process should still be alive
    assert.ok(isAlive(daemonPid), "daemonPid process should still be alive after sweep");

    child.kill("SIGKILL");
  });

  // ── cwd under worktree alone is NOT evidence (SWEEP-SCOPE) ───────

  it("spares a process whose cwd is under the worktree path (cwd is not evidence)", () => {
    const markerCwd = path.join(fakeWorktreePath, "subdir");
    fs.mkdirSync(markerCwd, { recursive: true });

    // Spawn a process with cwd inside the worktree, without any run env var
    const child = spawn("sleep", ["30"], {
      cwd: markerCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
    });
    children.push(child);

    return sleep(200).then(async () => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "child should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
        daemonInstance: daemonInstanceToken(),
      });
      assert.ok(
        !result.killedPids.includes(pid),
        `pid ${pid} with ONLY cwd under worktree must survive: killedPids=${JSON.stringify(result.killedPids)}`,
      );
      assert.equal(result.evidence[pid], undefined, "no evidence may be manufactured from cwd");
      assert.ok(isAlive(pid), "cwd-only process must still be alive after sweep");
    });
  });

  // ── Environ markers that are NOT exclusive evidence (survival) ───
  //
  // Every env-marker fixture is a Node keepalive, never /bin/sleep: the marker
  // channel resolves each candidate's environ through the platform-neutral
  // reader (procfs on Linux, KERN_PROCARGS2 on macOS), and on darwin /bin/sleep
  // is an Apple platform binary whose environ sysctl does not expose while a
  // same-user Node child's is readable. These survival tests must genuinely
  // evaluate the marker rather than pass because the fixture's environ was
  // unreadable.

  it("spares a process with only TAMANDUA_WORKER_JOB_ID containing runId", async () => {
    // Use a CWD that is NOT under the worktree to isolate the env check.
    const unrelatedCwd = path.join(stateDir, "unrelated");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    const child = spawnKeepalive(
      {
        TAMANDUA_WORKER_JOB_ID: "tamandua-test-workflow-test-run-001_developer",
        PATH: process.env.PATH || "/usr/bin",
      },
      unrelatedCwd,
    );
    children.push(child);

    await waitForReadableEnviron(child.pid!);
    const pid = child.pid!;
    assert.ok(isAlive(pid), "child should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: daemonInstanceToken(),
    });
    assert.ok(
      !result.killedPids.includes(pid),
      `pid ${pid} with ONLY TAMANDUA_WORKER_JOB_ID must survive: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.equal(result.evidence[pid], undefined, "worker job id is not kill evidence");
    assert.ok(isAlive(pid), "worker-job-id-only process must still be alive after sweep");
  });

  it("spares a process with only an exact TAMANDUA_RUN_ID token (no daemon token)", async () => {
    const unrelatedCwd = path.join(stateDir, "unrelated-run-marker");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    const child = spawnKeepalive(keepaliveMarkerEnv("test-run-001"), unrelatedCwd);
    children.push(child);

    await waitForReadableEnviron(child.pid!);
    const pid = child.pid!;
    assert.ok(isAlive(pid), "child should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: daemonInstanceToken(),
    });
    assert.ok(
      !result.killedPids.includes(pid),
      `pid ${pid} with the run id but no daemon token must survive: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.equal(result.evidence[pid], undefined, "the run marker alone is not kill evidence");
    assert.ok(isAlive(pid), "run-marker-only process must still be alive after sweep");
  });

  // ── Exclusive daemon-scoped marker IS kill evidence ──────────────

  it("kills a process carrying the exact daemon-scoped run marker", async () => {
    const unrelatedCwd = path.join(stateDir, "unrelated-daemon-marker");
    fs.mkdirSync(unrelatedCwd, { recursive: true });
    const token = daemonInstanceToken();

    const child = spawnKeepalive(keepaliveMarkerEnv("test-run-001", token), unrelatedCwd);
    children.push(child);

    await waitForReadableEnviron(child.pid!);
    const pid = child.pid!;
    assert.ok(isAlive(pid), "child should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: token,
    });
    assert.ok(
      result.killedPids.includes(pid),
      `pid ${pid} with the exact daemon-scoped marker should be killed: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.equal(
      result.evidence[pid],
      "daemon-scoped run marker: run=test-run-001",
      `evidence should name the daemon-scoped marker: ${JSON.stringify(result.evidence[pid])}`,
    );
    assert.ok(
      (result.evidence[pid] ?? "").length > 0,
      "a kill must always carry a non-empty evidence string",
    );

    const exited = await waitForExit(child, 2000);
    assert.ok(exited, "child should have exited after SIGKILL");
  });

  // ── cwd-independent marker scanning (SWEEP-DARWIN-FIX US-001) ────
  //
  // The marker channel resolves each candidate's environ through the
  // platform-neutral reader (procfs on Linux, KERN_PROCARGS2 on macOS), so a
  // daemon-marked leak is found regardless of cwd and for direct-mode runs.
  // Fixtures are Node keepalives, never /bin/sleep (see spawnKeepalive).

  it("reaps a readable daemon-marked child whose cwd is outside the worktree", async () => {
    const unrelatedCwd = path.join(stateDir, "outside-daemon-marker");
    fs.mkdirSync(unrelatedCwd, { recursive: true });
    const token = daemonInstanceToken();

    const child = spawnKeepalive(keepaliveMarkerEnv("test-run-001", token), unrelatedCwd);
    children.push(child);
    await waitForReadableEnviron(child.pid!);

    const pid = child.pid!;
    assert.ok(isAlive(pid), "child should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: token,
    });
    assert.ok(
      result.killedPids.includes(pid),
      `pid ${pid} with the daemon-scoped marker and a cwd OUTSIDE the worktree must be killed: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.equal(
      result.evidence[pid],
      "daemon-scoped run marker: run=test-run-001",
      `evidence must name the daemon-scoped marker: ${JSON.stringify(result.evidence[pid])}`,
    );

    const exited = await waitForExit(child, 2000);
    assert.ok(exited, "child should have exited after SIGKILL");
  });

  it("reaps a readable daemon-marked child in direct mode (null worktree path)", async () => {
    const unrelatedCwd = path.join(stateDir, "direct-mode-marker");
    fs.mkdirSync(unrelatedCwd, { recursive: true });
    const token = daemonInstanceToken();

    const child = spawnKeepalive(keepaliveMarkerEnv("test-run-001", token), unrelatedCwd);
    children.push(child);
    await waitForReadableEnviron(child.pid!);

    const pid = child.pid!;
    assert.ok(isAlive(pid), "child should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", null, { daemonInstance: token });
    assert.ok(
      result.killedPids.includes(pid),
      `direct-mode marker child ${pid} must be killed with a null worktree path: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.equal(
      result.evidence[pid],
      "daemon-scoped run marker: run=test-run-001",
      `evidence must name the daemon-scoped marker: ${JSON.stringify(result.evidence[pid])}`,
    );

    const exited = await waitForExit(child, 2000);
    assert.ok(exited, "child should have exited after SIGKILL");
  });

  it("never kills a readable child carrying only the exact TAMANDUA_RUN_ID", async () => {
    const unrelatedCwd = path.join(stateDir, "readable-run-id-only");
    fs.mkdirSync(unrelatedCwd, { recursive: true });
    const token = daemonInstanceToken();

    // (1) exact run id but NO daemon token; (2) exact run id with a DIFFERENT
    // (inherited outer) daemon token. Neither is exclusive ownership.
    const noToken = spawnKeepalive(keepaliveMarkerEnv("test-run-001"), unrelatedCwd);
    const outerToken = spawnKeepalive(
      keepaliveMarkerEnv("test-run-001", "inherited-outer-daemon-instance"),
      unrelatedCwd,
    );
    children.push(noToken, outerToken);
    await waitForReadableEnviron(noToken.pid!);
    await waitForReadableEnviron(outerToken.pid!);

    const noTokenPid = noToken.pid!;
    const outerTokenPid = outerToken.pid!;
    assert.ok(isAlive(noTokenPid), "no-token child should be alive before sweep");
    assert.ok(isAlive(outerTokenPid), "outer-token child should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: token,
    });
    assert.ok(
      !result.killedPids.includes(noTokenPid),
      `a readable child with the run id and no daemon token must survive: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.ok(
      !result.killedPids.includes(outerTokenPid),
      `a readable child with an inherited outer daemon token must survive: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.equal(result.evidence[noTokenPid], undefined, "the run id alone is not kill evidence");
    assert.equal(
      result.evidence[outerTokenPid],
      undefined,
      "a different daemon token is not kill evidence",
    );
  });

  it("run-cleanup source reads environ only through the platform-neutral reader", () => {
    // Every sweep environ read must route through src/lib/proc-info.ts
    // (getEnvironText / readProcEnviron), which owns the procfs and
    // KERN_PROCARGS2 platform logic. A direct procfs read here would silently
    // break the marker channel on darwin again. The forbidden token is
    // composed from fragments so this guard file itself carries no contiguous
    // procfs literal (tests/portability-lint.test.ts scans repository sources).
    const forbiddenProcfs = "/" + "proc" + "/";
    const source = fs.readFileSync(new URL("./run-cleanup.ts", import.meta.url), "utf-8");
    assert.ok(
      !source.includes(forbiddenProcfs),
      "src/installer/run-cleanup.ts must not contain a procfs literal; use src/lib/proc-info.ts",
    );
  });

  // ── Cross-run canary: path + another run's marker survives ───────

  it("spares cross-run canaries under the worktree with another run's marker", async () => {
    const token = daemonInstanceToken();

    // (1) cwd under the worktree + ANOTHER run's TAMANDUA_RUN_ID, no daemon
    //     token — the exact shape of the tamandua-6sy.77 cross-run kill.
    const canaryOtherRun = spawnKeepalive(
      { TAMANDUA_RUN_ID: "some-other-run", PATH: process.env.PATH || "/usr/bin" },
      fakeWorktreePath,
    );

    // (2) cwd under the worktree + the CORRECT run id but an inherited OUTER
    //     daemon-instance token.
    const canaryOuterDaemon = spawnKeepalive(
      {
        TAMANDUA_RUN_ID: "test-run-001",
        TAMANDUA_DAEMON_INSTANCE: "inherited-outer-daemon-instance",
        PATH: process.env.PATH || "/usr/bin",
      },
      fakeWorktreePath,
    );
    children.push(canaryOtherRun, canaryOuterDaemon);
    await waitForReadableEnviron(canaryOtherRun.pid!);
    await waitForReadableEnviron(canaryOuterDaemon.pid!);

    const otherRunPid = canaryOtherRun.pid!;
    const outerDaemonPid = canaryOuterDaemon.pid!;
    assert.ok(isAlive(otherRunPid), "other-run canary should be alive before sweep");
    assert.ok(isAlive(outerDaemonPid), "outer-daemon canary should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: token,
    });

    assert.ok(
      !result.killedPids.includes(otherRunPid),
      `other-run canary ${otherRunPid} must survive: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.ok(
      !result.killedPids.includes(outerDaemonPid),
      `outer-daemon canary ${outerDaemonPid} must survive: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.ok(isAlive(otherRunPid), "other-run canary must still be alive after sweep");
    assert.ok(isAlive(outerDaemonPid), "outer-daemon canary must still be alive after sweep");
  });

  // ── matchRunEvidence (exclusive kill gate) ───────────────────────

  it("matchRunEvidence requires the exact run id AND daemon token", () => {
    const token = daemonInstanceToken();
    const entry = {
      cwd: "/outside/the/run",
      environ: `PATH=/usr/bin\0TAMANDUA_RUN_ID=test-run-001\0TAMANDUA_DAEMON_INSTANCE=${token}\0`,
      cmdline: "sleep 30",
    };
    assert.equal(
      matchRunEvidence(entry, "test-run-001", token),
      "daemon-scoped run marker: run=test-run-001",
    );
    // A different run id does not match.
    assert.equal(matchRunEvidence(entry, "other-run", token), null);
    // A different (inherited outer) daemon token does not match.
    assert.equal(matchRunEvidence(entry, "test-run-001", "outer-token"), null);
    // No expected daemon token disables the channel entirely.
    assert.equal(matchRunEvidence(entry, "test-run-001", null), null);
    assert.equal(matchRunEvidence(entry, "test-run-001", ""), null);
  });

  it("matchRunEvidence ignores cwd, path and cmdline channels", () => {
    const token = daemonInstanceToken();
    // cwd under the worktree + cmdline naming the run — but no daemon token.
    const entry = {
      cwd: fakeWorktreePath,
      environ: "PATH=/usr/bin\0TAMANDUA_RUN_ID=test-run-001\0",
      cmdline: "node harness.js --run-id test-run-001",
    };
    assert.equal(matchRunEvidence(entry, "test-run-001", token), null);
  });

  // ── matchDiagnosticRunEvidence (report-only, broad channels) ─────

  it("matchDiagnosticRunEvidence keeps the broad report-only channels", () => {
    const runMarkerEntry = {
      cwd: "/outside/the/run",
      environ: "PATH=/usr/bin\0TAMANDUA_RUN_ID=test-run-001\0",
      cmdline: "sleep 30",
    };
    assert.equal(
      matchDiagnosticRunEvidence(runMarkerEntry, "test-run-001", null),
      "TAMANDUA_RUN_ID=test-run-001",
    );
    assert.equal(matchDiagnosticRunEvidence(runMarkerEntry, "other-run", null), null);

    const cmdlineEntry = {
      cwd: "/outside/the/run",
      environ: null,
      cmdline: "node harness.js --run-id test-run-001",
    };
    assert.equal(
      matchDiagnosticRunEvidence(cmdlineEntry, "test-run-001", null),
      "cmdline contains runId: test-run-001",
    );

    const cwdEntry = {
      cwd: fakeWorktreePath,
      environ: null,
      cmdline: "sleep 30",
    };
    assert.ok(
      (matchDiagnosticRunEvidence(cwdEntry, "test-run-001", fakeWorktreePath) ?? "").startsWith(
        "cwd under worktree",
      ),
      "the diagnostic matcher still reports the cwd channel",
    );
  });

  // ── Pgid ownership (DSWP): owned group reaped, unrelated spared ──

  it("sweepRunProcesses kills a process whose pgid is listed and spares an unrelated one", () => {
    const ownedCwd = path.join(stateDir, "owned-pgid");
    const unrelatedCwd = path.join(stateDir, "unrelated-pgid");
    fs.mkdirSync(ownedCwd, { recursive: true });
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    // detached:true makes the child its own process-group leader, so its
    // pgid === its pid — the harness group shape the scheduler records.
    const owned = spawn("sleep", ["30"], {
      cwd: ownedCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
      detached: true,
    });
    const unrelated = spawn("sleep", ["30"], {
      cwd: unrelatedCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
      detached: true,
    });
    children.push(owned, unrelated);

    return sleep(300).then(async () => {
      const ownedPid = owned.pid!;
      const unrelatedPid = unrelated.pid!;
      assert.ok(isAlive(ownedPid), "owned child should be alive before sweep");
      assert.ok(isAlive(unrelatedPid), "unrelated child should be alive before sweep");

      // No worktree path: the pgid channel alone must carry the sweep.
      const result = sweepRunProcesses("test-run-001", null, { pgids: [ownedPid] });

      assert.equal(result.worktreePath, null, "result should carry the null path");
      assert.ok(
        result.killedPids.includes(ownedPid),
        `owned pgid ${ownedPid} should be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );
      assert.ok(
        result.evidence[ownedPid]?.includes("pgid owned by run") &&
          result.evidence[ownedPid]?.includes(String(ownedPid)),
        `evidence should name the pgid: ${JSON.stringify(result.evidence[ownedPid])}`,
      );
      assert.ok(
        !result.killedPids.includes(unrelatedPid),
        `unrelated pid ${unrelatedPid} must not be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );
      assert.ok(isAlive(unrelatedPid), "unrelated process should still be alive after sweep");

      const ownedExited = await waitForExit(owned, 2000);
      assert.ok(ownedExited, "owned child should have exited after SIGKILL");

      // The event detail records the path (null) and the owned pgids.
      const runEventsFile = path.join(stateDir, "events", "test-run-001.jsonl");
      const lines = fs.readFileSync(runEventsFile, "utf-8").trim().split("\n");
      const lastEvent = JSON.parse(lines[lines.length - 1]) as TamanduaEvent;
      const detail = JSON.parse(lastEvent.detail!);
      assert.equal(detail.worktreePath, null);
      assert.ok(
        Array.isArray(detail.pgids) && detail.pgids.includes(ownedPid),
        `event detail should list owned pgids: ${JSON.stringify(detail.pgids)}`,
      );
    });
  });

  // ── Environ worktree-path mentions are NOT evidence ──────────────

  it("spares a process whose environ merely contains the worktree path string", async () => {
    const unrelatedCwd = path.join(stateDir, "unrelated-env");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    const child = spawnKeepalive(
      {
        SOME_VAR: `path=${fakeWorktreePath}/data`,
        PATH: process.env.PATH || "/usr/bin",
      },
      unrelatedCwd,
    );
    children.push(child);

    await waitForReadableEnviron(child.pid!);
    const pid = child.pid!;
    assert.ok(isAlive(pid), "child should be alive before sweep");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: daemonInstanceToken(),
    });
    assert.ok(
      !result.killedPids.includes(pid),
      `pid ${pid} with only a worktree-path env mention must survive: killedPids=${JSON.stringify(result.killedPids)}`,
    );
    assert.equal(result.evidence[pid], undefined, "a path mention is not kill evidence");
    assert.ok(isAlive(pid), "path-mention process must still be alive after sweep");
  });

  // ── cmdline run-id mentions are NOT evidence ─────────────────────

  it("spares a process whose command line contains the run id", () => {
    const unrelatedCwd = path.join(stateDir, "unrelated-cmdline");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    // The runId appears only in argv (harness children carry run/agent ids
    // in their prompt argv) — formerly the primary macOS evidence channel,
    // now report-only.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)", "marker-test-run-001"],
      {
        cwd: unrelatedCwd,
        env: { PATH: process.env.PATH || "/usr/bin" },
        stdio: "ignore",
      },
    );
    children.push(child);

    return sleep(200).then(() => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "child should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
        daemonInstance: daemonInstanceToken(),
      });
      assert.ok(
        !result.killedPids.includes(pid),
        `pid ${pid} with the run id only in argv must survive: killedPids=${JSON.stringify(result.killedPids)}`,
      );
      assert.equal(result.evidence[pid], undefined, "a cmdline mention is not kill evidence");
      assert.ok(isAlive(pid), "cmdline-only process must still be alive after sweep");
    });
  });

  // ── Unmarked processes survive ───────────────────────────────────

  it("does not kill unmarked processes", () => {
    const unrelatedCwd = path.join(stateDir, "unmarked");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    const child = spawn("sleep", ["30"], {
      cwd: unrelatedCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
    });
    children.push(child);

    return sleep(200).then(async () => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "unmarked child should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
      assert.ok(
        !result.killedPids.includes(pid),
        `unmarked pid ${pid} must not be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );

      assert.ok(isAlive(pid), "unmarked process should still be alive after sweep");
    });
  });

  // ── Event emission ───────────────────────────────────────────────

  it("emits a run.process_cleanup event after sweep", () => {
    const token = daemonInstanceToken();
    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: token,
    });

    assert.equal(result.runId, "test-run-001");
    // Read the run-specific events file
    const runEventsFile = path.join(stateDir, "events", "test-run-001.jsonl");
    assert.ok(fs.existsSync(runEventsFile), "run events file should exist");

    const content = fs.readFileSync(runEventsFile, "utf-8");
    const lines = content.trim().split("\n");
    assert.ok(lines.length > 0, "should have at least one event");

    const lastEvent = JSON.parse(lines[lines.length - 1]) as TamanduaEvent;
    assert.equal(lastEvent.event, "run.process_cleanup");
    assert.equal(lastEvent.runId, "test-run-001");
    assert.ok(lastEvent.detail, "event detail should be populated");

    const detail = JSON.parse(lastEvent.detail!);
    assert.equal(detail.worktreePath, fakeWorktreePath);
    assert.equal(detail.daemonInstance, token, "event detail should carry the daemon instance");
    assert.ok(typeof detail.scannedPids === "number");
    assert.ok(Array.isArray(detail.killedPids));
  });

  // ── Graceful handling of missing /proc entries ───────────────────

  it("handles ENOENT from /proc entries gracefully", () => {
    // This is inherently tested by the sweep — any process that exits
    // between scanning procfs and reading per-pid procfs files will
    // trigger ENOENT, and the code must handle it without throwing.
    // We can also test with a guaranteed-non-existent PID.
    // The function iterates only over pids from readdir, so we can't
    // easily inject a fake PID. Instead, we rely on the fact that
    // reading from nonexistent pids is handled by processBelongsToRun
    // returning null.
    const result = sweepRunProcesses("test-run-999", "/nonexistent/path/for/test");
    assert.ok(result, "should return a result even with nonexistent worktree path");
    assert.equal(result.killedPids.length, 0, "should not find any matches with fake path");
    assert.ok(result.scannedPids >= 0, "should have scanned pids count");
  });

  // ── Multiple process sweep ───────────────────────────────────────

  it("kills multiple daemon-marked processes in one sweep", async () => {
    const markerCwd = path.join(fakeWorktreePath, "multi");
    fs.mkdirSync(markerCwd, { recursive: true });
    const token = daemonInstanceToken();

    const markerEnv = {
      TAMANDUA_RUN_ID: "test-run-001",
      TAMANDUA_DAEMON_INSTANCE: token,
      PATH: process.env.PATH || "/usr/bin",
    };
    const child1 = spawnKeepalive(markerEnv, markerCwd);
    const child2 = spawnKeepalive(markerEnv, markerCwd);
    children.push(child1, child2);
    await waitForReadableEnviron(child1.pid!);
    await waitForReadableEnviron(child2.pid!);

    assert.ok(isAlive(child1.pid!), "child1 should be alive");
    assert.ok(isAlive(child2.pid!), "child2 should be alive");

    const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
      daemonInstance: token,
    });
    assert.equal(
      result.killedPids.length,
      2,
      `should kill 2 processes, killed: ${JSON.stringify(result.killedPids)}`,
    );
    assert.ok(result.killedPids.includes(child1.pid!));
    assert.ok(result.killedPids.includes(child2.pid!));
    assert.equal(
      result.evidence[child1.pid!],
      "daemon-scoped run marker: run=test-run-001",
    );
    assert.equal(
      result.evidence[child2.pid!],
      "daemon-scoped run marker: run=test-run-001",
    );

    const bothExited = await Promise.all([
      waitForExit(child1, 2000),
      waitForExit(child2, 2000),
    ]);
    assert.ok(bothExited[0], "child1 should have exited");
    assert.ok(bothExited[1], "child2 should have exited");
  });

  // ── Bounded bulk cwd snapshot (US-003) ───────────────────────────

  it("parseLsofCwdRecords maps p/n records and ignores malformed output", () => {
    const records = parseLsofCwdRecords(
      ["p10", "fcwd", "n/a", "p0", "n/ignored", "p20", "fcwd", "/not-a-path", "n/c", ""].join(
        "\n",
      ),
    );
    assert.deepEqual(
      [...records.entries()],
      [
        [10, "/a"],
        [20, "/c"],
      ],
    );
  });

  it("routes the bulk cwd probe through the bounded -b -w primitive (macOS)", { skip: procfs }, () => {
    const argvFile = path.join(stateDir, "bulk-argv.txt");
    const shim = writeLsofShim(
      path.join(stateDir, "bulk-ok.sh"),
      ["p4242", "fcwd", `n${fakeWorktreePath}`],
      argvFile,
    );

    const entries = withLsofEnv(shim, "3000", () => collectProcessSnapshot());

    const argv = fs.readFileSync(argvFile, "utf-8").trim().split("\n");
    assert.deepEqual(
      argv,
      ["-b", "-w", "-d", "cwd", "-Fpn"],
      "the bulk snapshot must always carry -b -w (and a timeout) so it cannot wedge",
    );

    const entry = entries.find((e) => e.pid === 4242);
    assert.ok(entry, "the fake pid from the lsof table should be in the snapshot");
    assert.equal(entry.cwd, fakeWorktreePath);
  });

  it("stays bounded and fails closed when the bulk lsof hangs (macOS)", { skip: procfs }, () => {
    const pidFile = path.join(stateDir, "bulk-hang.pid");
    const shim = writeShim(
      path.join(stateDir, "bulk-hang.sh"),
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${shQuote(pidFile)}\nexec sleep 60\n`,
    );
    const logFile = path.join(stateDir, "tamandua.log");
    const logBefore = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";

    const startedAt = Date.now();
    const entries = withLsofEnv(shim, "800", () => collectProcessSnapshot());
    const elapsedMs = Date.now() - startedAt;

    assert.ok(
      elapsedMs < 800 + 1000,
      `bulk snapshot must return within timeout+1000ms, took ${elapsedMs}ms`,
    );
    for (const entry of entries) {
      assert.equal(
        entry.cwd,
        null,
        `cwd evidence must be absent (null), not fabricated, for pid ${entry.pid}`,
      );
    }

    const logAfter = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";
    assert.match(
      logAfter.slice(logBefore.length),
      /bulk lsof cwd snapshot unavailable|timed out/,
      "an unanswered bulk probe must be reported through logger.warn",
    );

    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0, "shim must have recorded its pid");
    try {
      assert.throws(
        () => process.kill(pid, 0),
        (err: NodeJS.ErrnoException) => err.code === "ESRCH",
        "hung bulk lsof shim must be killed and reaped",
      );
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("does not kill an unmarked survivor when cwd evidence is unknown (macOS hang)", { skip: procfs }, () => {
    const unrelatedCwd = path.join(stateDir, "unknown-cwd-survivor");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    const child = spawn("sleep", ["30"], {
      cwd: unrelatedCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
    });
    children.push(child);

    const pidFile = path.join(stateDir, "sweep-hang.pid");
    const shim = writeShim(
      path.join(stateDir, "sweep-hang.sh"),
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${shQuote(pidFile)}\nexec sleep 60\n`,
    );

    return sleep(200).then(async () => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "unmarked child should be alive before sweep");

      const result = withLsofEnv(shim, "800", () =>
        sweepRunProcesses("test-run-001", fakeWorktreePath),
      );

      assert.ok(
        !result.killedPids.includes(pid),
        `unmarked pid ${pid} must not be killed when cwd evidence is unknown: ${JSON.stringify(
          result.killedPids,
        )}`,
      );
      assert.ok(isAlive(pid), "unmarked process should still be alive after sweep");
    });
  });
});

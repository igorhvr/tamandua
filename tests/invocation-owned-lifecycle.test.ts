/**
 * US-003 isolated invocation-ownership lifecycle regression (spawn-capable,
 * serial lane — registered in tests/serial-files.txt).
 *
 * After the US-002 scoped correction, the describe-level after hooks in
 * tests/mcp-lifecycle.test.ts and tests/get-ready-dashboard-port.test.ts
 * delegate every kill decision to the invocation-ownership helper
 * (tests/helpers/invocation-owned-cleanup.ts): a leaked survivor is signalled
 * only when its CURRENT ownership evidence points EXACTLY inside a temp root
 * the current invocation created (never a shared-prefix/substring match), the
 * recorded process identity still matches, and the evidence + identity are
 * re-verified immediately before each signal.
 *
 * This gate proves that ownership semantics with REAL processes:
 *
 *  1. Positive overlap: two controlled synthetic invocations A and B — each
 *     with its OWN createTempHome() root under the SAME prefix (proving the
 *     prefix is not the ownership basis) and each with a live synthetic
 *     service the gate spawned — overlap. Invocation A's owned cleanup (the
 *     real after-hook entry point, whose ownedTempRoots() sees only A's
 *     roots) kills A's survivor, and neighbor B's live service stays healthy
 *     afterwards, verified by endpoint, process liveness AND recorded-identity
 *     match — not inference. A and B run in two OS processes so their owned-
 *     root registries are genuinely disjoint, exactly like concurrent test
 *     invocations.
 *  2. Refusal proof on real processes: unavailable ownership evidence refuses
 *     with nothing killed (refusal is not claimed cleanup), a stale /
 *     PID-reuse recorded identity refuses even when current evidence proves
 *     ownership, and a persisted legacy ps:/proc: recorded identity refuses as
 *     identity-unknown-format (never string-compared). A matching recorded
 *     identity still signals.
 *  3. Failing-path proof: a simulated mid-test assertion failure leaves no
 *     owned survivor behind — owned cleanup still runs on failing paths.
 *
 * Every process and root in this gate is synthetic and created by this test
 * invocation (or by the synthetic-invocation runner it spawns); no real
 * existing run/daemon is ever used as a target. Identities
 * (pid + getProcessStartIdentity(pid)) are recorded at creation for every
 * process. Portability: the gate binds the real platform observers from the
 * US-002 abstraction (linux environ HOME / darwin lsof open files) through
 * realOwnershipObserver()/sweepInvocationOwnedLeakedSurvivors(), so the same
 * file runs on Linux and actual macOS; only the platform(s) actually executed
 * in a run are claimed as passing.
 *
 * The controlled A/B overlap lives entirely INSIDE this isolated file; the
 * file itself is a normal serial-lane member.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanChildEnv,
  createTempHome,
  ownedTempRoots,
  removeTestTempDirWithDiagnostics,
} from "./helpers/test-env.ts";
import {
  cleanupInvocationOwnedSurvivors,
  realOwnershipObserver,
  sigkillSurvivor,
  sweepInvocationOwnedLeakedSurvivors,
} from "./helpers/invocation-owned-cleanup.ts";
import { getProcessStartIdentity } from "../src/lib/process-start-identity.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SERVICE_FIXTURE = path.join(FIXTURES_DIR, "invocation-owned-service.mjs");
const RUNNER_FIXTURE = path.join(FIXTURES_DIR, "invocation-owned-runner.ts");

// BOTH synthetic invocations share this root prefix on purpose: the prefix is
// what the old after hooks matched on, and it must NOT be the ownership basis.
const ROOT_PREFIX = "tamandua-inv-owned-lifecycle-";

// Absolute deadlines for child startup / teardown waits (an exceeded deadline
// fails the test — no unbounded polling anywhere).
const STARTUP_DEADLINE_MS = 30_000;
const TEARDOWN_DEADLINE_MS = 15_000;

// Every service pid this invocation spawned, for the describe-level after
// hook (belt-and-suspenders so even an unexpected failure cannot leak an
// owned survivor).
const trackedOwnedPids: number[] = [];
let trackedRunner: NeighborRunner | null = null;
let spawnCounter = 0;

/**
 * Race `promise` against an absolute deadline. The deadline timer is cleared
 * as soon as the race settles, so a fast resolution never leaves a pending
 * timer holding the test process open.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Deadline exceeded: ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Absolute-deadline wait until `pid` is gone; throws at the deadline. */
async function waitForPidGone(pid: number, what: string): Promise<void> {
  const deadline = Date.now() + TEARDOWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what} (pid ${pid}) to exit`);
}

// ── Owned synthetic service (created by this invocation) ──────────────

interface OwnedService {
  child: ChildProcess;
  pid: number;
  /** getProcessStartIdentity(pid) recorded at creation. */
  identity: string | null;
  root: string;
  homeDir: string;
  port: number;
  label: string;
  token: string;
  /** Resolves when the child exits (listener attached at spawn). */
  exited: Promise<[number | null, NodeJS.Signals | null]>;
}

async function waitForReadyFile(
  readyFile: string,
  child: ChildProcess,
  label: string,
  logPath: string,
): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
        pid?: unknown;
        port?: unknown;
      };
      if (
        Number.isInteger(parsed.pid) &&
        Number.isInteger(parsed.port) &&
        (parsed.port as number) > 0
      ) {
        return { pid: parsed.pid as number, port: parsed.port as number };
      }
    } catch {
      // Not ready yet — keep waiting until the absolute deadline.
    }
    if (child.exitCode !== null) {
      throw new Error(
        `[${label}] service exited (code ${child.exitCode}) before writing its ready file; log tail:\n` +
          logTail(logPath),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `[${label}] timed out waiting for service ready file ${readyFile}; log tail:\n` +
      logTail(logPath),
  );
}

function logTail(logPath: string, lines = 25): string {
  try {
    const all = fs.readFileSync(logPath, "utf8").split("\n");
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  } catch {
    return "(log unreadable)";
  }
}

/**
 * Spawn one live synthetic service under a NEW owned temp root (same shared
 * prefix) and record its exact identity at creation. The service holds HOME=
 * <owned home> (linux evidence) and keeps an open file under it (darwin
 * evidence), and serves /health on an ephemeral loopback port.
 */
async function spawnOwnedService(label: string): Promise<OwnedService> {
  const th = createTempHome(ROOT_PREFIX);
  const token = `tok-${label}-${process.pid}-${spawnCounter++}`;
  const logPath = path.join(th.tamanduaDir, `${label}.log`);
  const readyFile = path.join(th.tamanduaDir, `${label}.ready`);

  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [SERVICE_FIXTURE], {
    env: cleanChildEnv({
      HOME: th.homeDir,
      SERVICE_LABEL: label,
      SERVICE_TOKEN: token,
    }),
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);

  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const ready = await waitForReadyFile(readyFile, child, label, logPath);
  assert.equal(
    ready.pid,
    child.pid,
    `[${label}] ready file pid ${ready.pid} must equal the spawned child pid ${child.pid}`,
  );
  const pid = ready.pid;
  const identity = getProcessStartIdentity(pid);
  trackedOwnedPids.push(pid);
  return {
    child,
    pid,
    identity,
    root: th.root,
    homeDir: th.homeDir,
    port: ready.port,
    label,
    token,
    exited,
  };
}

/** Real after-hook entry sweep over one owned service, then reap + remove root. */
async function cleanupOwnedService(svc: OwnedService): Promise<void> {
  if (pidAlive(svc.pid)) {
    try {
      sweepInvocationOwnedLeakedSurvivors([svc.pid]);
    } catch {
      // best effort
    }
  }
  try {
    await withDeadline(svc.exited, TEARDOWN_DEADLINE_MS, `service ${svc.label} exit during cleanup`);
  } catch {
    // best effort
  }
  try {
    removeTestTempDirWithDiagnostics(svc.root);
  } catch {
    // already removed
  }
}

// ── Health assertions (endpoint + token + pid: identity, not inference) ──

async function fetchHealth(port: number): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: res.status, text: await res.text() };
}

async function assertServiceHealthy(
  port: number,
  token: string,
  pid: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const { status, text } = await fetchHealth(port);
      const body = JSON.parse(text) as { ok?: boolean; token?: string; pid?: number };
      if (status === 200 && body.ok === true && body.token === token && body.pid === pid) {
        return;
      }
      lastError = new Error(`unexpected health body: status ${status}, ${text.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} did not become healthy (pid ${pid}): ${String(lastError)}`);
}

async function assertServiceDown(port: number, what: string): Promise<void> {
  const deadline = Date.now() + TEARDOWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const { status } = await fetchHealth(port);
      if (status !== 200) return;
    } catch {
      return; // connection refused — service is down
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} still answers on port ${port} after teardown`);
}

// ── Synthetic neighbor invocation B (separate OS process, own registry) ──

interface NeighborRunner {
  child: ChildProcess;
  exited: Promise<[number | null, NodeJS.Signals | null]>;
  root: string;
  servicePid: number;
  /** Identity B recorded at creation and reported to this invocation. */
  serviceIdentity: string | null;
  servicePort: number;
  token: string;
  stopped: boolean;
}

async function startNeighborRunner(): Promise<NeighborRunner> {
  const token = `tok-neighbor-${process.pid}-${spawnCounter++}`;
  const child = spawn(process.execPath, [RUNNER_FIXTURE], {
    env: cleanChildEnv({
      INVOCATION_ROOT_PREFIX: ROOT_PREFIX,
      NEIGHBOR_TOKEN: token,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

  const firstLine = new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const newline = stdoutBuffer.indexOf("\n");
      if (!settled && newline >= 0) {
        settled = true;
        resolve(stdoutBuffer.slice(0, newline));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
    });
    child.once("error", (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });
    void exited.then(([code]) => {
      if (!settled) {
        fail(
          new Error(
            `neighbor runner exited before reporting readiness (code ${code}); stderr:\n` +
              stderrBuffer.slice(-2000),
          ),
        );
      }
    });
  });

  let line: string;
  try {
    line = await withDeadline(firstLine, STARTUP_DEADLINE_MS, "neighbor runner readiness");
  } catch (err) {
    // The runner is this invocation's exact child: kill it, then rethrow.
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    throw err;
  }

  let report: {
    ok?: boolean;
    error?: string;
    root?: string;
    servicePid?: number;
    serviceIdentity?: string | null;
    servicePort?: number;
    token?: string;
  };
  try {
    report = JSON.parse(line) as typeof report;
  } catch {
    throw new Error(`neighbor runner returned non-JSON readiness: ${line.slice(0, 500)}`);
  }
  assert.equal(report.ok, true, `neighbor runner failed to start: ${report.error ?? line}`);
  assert.ok(
    typeof report.root === "string" &&
      Number.isInteger(report.servicePid) &&
      Number.isInteger(report.servicePort),
    `neighbor runner readiness incomplete: ${line}`,
  );
  assert.ok(
    path.basename(report.root!).startsWith(ROOT_PREFIX),
    `neighbor root must share the ${ROOT_PREFIX} prefix (got ${report.root})`,
  );

  const runner: NeighborRunner = {
    child,
    exited,
    root: report.root!,
    servicePid: report.servicePid!,
    serviceIdentity: report.serviceIdentity ?? null,
    servicePort: report.servicePort!,
    token,
    stopped: false,
  };
  trackedRunner = runner;
  return runner;
}

/**
 * Tell neighbor B to clean its own survivors and exit. Returns its exit code
 * on success; on timeout performs an exact recorded-identity cleanup of the
 * runner and its service (this invocation spawned both) and rethrows.
 */
async function stopNeighborRunner(runner: NeighborRunner): Promise<number | null> {
  if (runner.stopped) return runner.child.exitCode;
  runner.stopped = true;
  try {
    if (runner.child.stdin !== null && runner.child.stdin.writable) {
      runner.child.stdin.end("stop\n");
    }
    const [code] = await withDeadline(
      runner.exited,
      TEARDOWN_DEADLINE_MS,
      `neighbor runner stop (pid ${runner.child.pid})`,
    );
    return code;
  } catch (err) {
    const runnerPid = runner.child.pid ?? -1;
    if (runnerPid > 0 && pidAlive(runnerPid)) {
      try {
        process.kill(runnerPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (runner.servicePid > 0 && pidAlive(runner.servicePid)) {
      const current = getProcessStartIdentity(runner.servicePid);
      if (current !== null && current === runner.serviceIdentity) {
        try {
          process.kill(runner.servicePid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    try {
      await withDeadline(
        runner.exited,
        TEARDOWN_DEADLINE_MS,
        `neighbor runner exit after kill (pid ${runnerPid})`,
      );
    } catch {
      // best effort
    }
    try {
      removeTestTempDirWithDiagnostics(runner.root);
    } catch {
      // already removed
    }
    throw err;
  }
}

// ── The gate ─────────────────────────────────────────────────────────

describe("invocation-owned lifecycle regression (US-003)", { concurrency: 1 }, () => {
  after(async () => {
    // Belt-and-suspenders: an unexpected mid-file failure must not leak this
    // invocation's owned survivors. Every pid this file spawned is swept
    // through the real after-hook entry point — only survivors whose current
    // evidence points exactly inside an owned root are signalled, so the
    // sweep cannot touch anything this invocation does not own.
    try {
      sweepInvocationOwnedLeakedSurvivors(trackedOwnedPids);
    } catch {
      // best effort
    }
    if (trackedRunner !== null && pidAlive(trackedRunner.child.pid ?? -1)) {
      try {
        await stopNeighborRunner(trackedRunner);
      } catch {
        // best effort
      }
    }
  });

  it("cleans invocation A's survivor while overlapping neighbor B's live service stays healthy", async (t) => {
    t.diagnostic(`US-003 invocation-owned lifecycle gate platform: ${process.platform}`);
    const neighbor = await startNeighborRunner();
    let serviceA: OwnedService | null = null;
    try {
      const svcA = await spawnOwnedService("invA");
      serviceA = svcA; // for the finally cleanup

      // The two synthetic invocations share the SAME root prefix — the old
      // prefix basis could not tell them apart — yet their roots are
      // distinct, and each invocation owns only its own root.
      assert.ok(
        path.basename(svcA.root).startsWith(ROOT_PREFIX),
        `invocation A root should use the shared prefix: ${svcA.root}`,
      );
      assert.notEqual(
        neighbor.root,
        svcA.root,
        "A and B roots must be distinct despite the shared prefix",
      );

      // Exact identities recorded at creation for every process.
      assert.ok(neighbor.serviceIdentity, "neighbor B service identity must be recorded");
      assert.ok(svcA.identity, "invocation A service identity must be recorded");

      // Both live services are healthy before the overlap.
      await assertServiceHealthy(svcA.port, svcA.token, svcA.pid, "invocation A service");
      await assertServiceHealthy(
        neighbor.servicePort,
        neighbor.token,
        neighbor.servicePid,
        "neighbor B service",
      );

      // Invocation A's OWNED cleanup — the exact after-hook entry point,
      // whose ownedTempRoots() sees only A's roots — receives BOTH candidate
      // survivors (what pgrep discovery would return for a shared service
      // pattern). A's survivor is signalled; B's (evidence points into B's
      // root, which A does not own) is refused.
      const dispositions = sweepInvocationOwnedLeakedSurvivors([
        svcA.pid,
        neighbor.servicePid,
      ]);
      assert.deepEqual(
        dispositions.find((d) => d.pid === svcA.pid),
        { pid: svcA.pid, outcome: "signalled" },
        `A's own survivor must be cleaned: ${JSON.stringify(dispositions)}`,
      );
      assert.deepEqual(
        dispositions.find((d) => d.pid === neighbor.servicePid),
        { pid: neighbor.servicePid, outcome: "skipped", reason: "not-owned" },
        `neighbor B's survivor must be refused by A: ${JSON.stringify(dispositions)}`,
      );

      // A's survivor died...
      await waitForPidGone(svcA.pid, "invocation A survivor");
      await assertServiceDown(svcA.port, "invocation A service");
      // ...and its owned root is cleaned (nothing holds files under it now).
      removeTestTempDirWithDiagnostics(svcA.root);
      assert.equal(
        fs.existsSync(svcA.root),
        false,
        "invocation A's owned root must be removed after its survivor died",
      );

      // Neighbor B's live service remains HEALTHY after A's cleanup —
      // verified by endpoint, process liveness AND identity match, not
      // inference.
      await assertServiceHealthy(
        neighbor.servicePort,
        neighbor.token,
        neighbor.servicePid,
        "neighbor B service after A's cleanup",
      );
      assert.ok(pidAlive(neighbor.servicePid), "neighbor B's service process must still be alive");
      assert.equal(
        getProcessStartIdentity(neighbor.servicePid),
        neighbor.serviceIdentity,
        "neighbor B's process identity must be unchanged (no PID reuse)",
      );

      // B wraps up: it cleans its OWN survivors through its own registry and
      // its exit handler removes root B.
      const exitCode = await stopNeighborRunner(neighbor);
      assert.equal(exitCode, 0, `neighbor runner should exit 0, got ${exitCode}`);
      await waitForPidGone(neighbor.servicePid, "neighbor B survivor");
      assert.equal(
        fs.existsSync(neighbor.root),
        false,
        "neighbor B's owned root must be removed when B exits",
      );
      trackedRunner = null;
      serviceA = null; // root already removed on the success path
    } finally {
      if (serviceA !== null) {
        await cleanupOwnedService(serviceA);
      }
      if (trackedRunner !== null && pidAlive(trackedRunner.child.pid ?? -1)) {
        await stopNeighborRunner(trackedRunner);
        trackedRunner = null;
      }
    }
  });

  it("refuses (nothing killed) when ownership evidence is unavailable", async () => {
    const svc = await spawnOwnedService("unreadable");
    try {
      const dispositions = cleanupInvocationOwnedSurvivors([svc.pid], {
        ownedRoots: ownedTempRoots(),
        // Deliberately unavailable evidence on a REAL live owned process: a
        // host cannot be forced to deny its /proc environ or lsof output
        // deterministically, so the evidence read is injected as unreadable
        // while the process, identity and signal binding stay real.
        // Unavailable evidence must be a refusal — never claimed cleanup.
        observe: () => ({ kind: "unreadable" }),
        identityOf: getProcessStartIdentity,
        recordedIdentityOf: () => svc.identity,
        signal: sigkillSurvivor,
      });
      assert.deepEqual(dispositions, [
        { pid: svc.pid, outcome: "skipped", reason: "unreadable-evidence" },
      ]);

      // Nothing was killed...
      assert.ok(pidAlive(svc.pid), "refused process must not be signalled");
      await assertServiceHealthy(svc.port, svc.token, svc.pid, "unreadable-evidence survivor");
      assert.equal(
        getProcessStartIdentity(svc.pid),
        svc.identity,
        "identity unchanged after refusal (no signal, no PID reuse)",
      );

      // ...and refusal is NOT claimed cleanup: the invocation still owns the
      // survivor, so the real sweep (with available evidence) cleans it.
      const cleanupDispositions = sweepInvocationOwnedLeakedSurvivors([svc.pid]);
      assert.deepEqual(cleanupDispositions, [
        { pid: svc.pid, outcome: "signalled" },
      ]);
      await waitForPidGone(svc.pid, "unreadable-evidence survivor");
      removeTestTempDirWithDiagnostics(svc.root);
      assert.equal(
        fs.existsSync(svc.root),
        false,
        "owned root removed after real cleanup",
      );
    } finally {
      await cleanupOwnedService(svc);
    }
  });

  it("refuses a stale/PID-reuse recorded identity even when current evidence proves ownership", async () => {
    const svc = await spawnOwnedService("staleid");
    try {
      const dispositions = cleanupInvocationOwnedSurvivors([svc.pid], {
        ownedRoots: ownedTempRoots(),
        observe: realOwnershipObserver(),
        identityOf: getProcessStartIdentity,
        // Simulate a pid-file record from an EARLIER incarnation: a well-formed
        // v2 value for the SAME pid but a start epoch far outside the
        // documented tolerance (PID reuse) → refusal, never a signal.
        recordedIdentityOf: () => `v2:${svc.pid}:1`,
        signal: sigkillSurvivor,
      });
      assert.deepEqual(dispositions, [
        { pid: svc.pid, outcome: "skipped", reason: "identity-mismatch" },
      ]);

      // Nothing was killed...
      assert.ok(pidAlive(svc.pid), "stale-identity survivor must not be signalled");
      await assertServiceHealthy(svc.port, svc.token, svc.pid, "stale-identity survivor");

      // ...and the invocation still owns it: the real sweep (no record →
      // decision-time identity snapshot) cleans it.
      const cleanupDispositions = sweepInvocationOwnedLeakedSurvivors([svc.pid]);
      assert.deepEqual(cleanupDispositions, [{ pid: svc.pid, outcome: "signalled" }]);
      await waitForPidGone(svc.pid, "stale-identity survivor");
      removeTestTempDirWithDiagnostics(svc.root);
      assert.equal(fs.existsSync(svc.root), false, "owned root removed after real cleanup");
    } finally {
      await cleanupOwnedService(svc);
    }
  });

  it("refuses a persisted legacy recorded identity (unknown format) and never signals", async () => {
    const svc = await spawnOwnedService("legacyid");
    try {
      // Upgrade path: an older build persisted a TZ-dependent ps lstart text
      // (or a boot-relative proc: tick count). The live process is a valid v2
      // incarnation, but the recorded value is not comparable: the matcher
      // must return 'unknown' → identity-unknown-format, NEVER
      // identity-mismatch and NEVER a signal.
      const dispositions = cleanupInvocationOwnedSurvivors([svc.pid], {
        ownedRoots: ownedTempRoots(),
        observe: realOwnershipObserver(),
        identityOf: getProcessStartIdentity,
        recordedIdentityOf: () => "ps:Sun Sep  6 00:26:59 2026",
        signal: sigkillSurvivor,
      });
      assert.deepEqual(dispositions, [
        { pid: svc.pid, outcome: "skipped", reason: "identity-unknown-format" },
      ]);

      // Nothing was killed...
      assert.ok(pidAlive(svc.pid), "legacy-identity survivor must not be signalled");
      await assertServiceHealthy(svc.port, svc.token, svc.pid, "legacy-identity survivor");
      assert.equal(
        getProcessStartIdentity(svc.pid),
        svc.identity,
        "identity unchanged after legacy-format refusal (no signal, no PID reuse)",
      );

      // ...and the invocation still owns it: the real sweep (no record →
      // decision-time identity snapshot) cleans it.
      const cleanupDispositions = sweepInvocationOwnedLeakedSurvivors([svc.pid]);
      assert.deepEqual(cleanupDispositions, [{ pid: svc.pid, outcome: "signalled" }]);
      await waitForPidGone(svc.pid, "legacy-identity survivor");
      removeTestTempDirWithDiagnostics(svc.root);
      assert.equal(fs.existsSync(svc.root), false, "owned root removed after real cleanup");
    } finally {
      await cleanupOwnedService(svc);
    }
  });

  it("signals an owned survivor whose recorded identity still matches", async () => {
    const svc = await spawnOwnedService("idmatch");
    try {
      const dispositions = cleanupInvocationOwnedSurvivors([svc.pid], {
        ownedRoots: ownedTempRoots(),
        observe: realOwnershipObserver(),
        identityOf: getProcessStartIdentity,
        recordedIdentityOf: () => svc.identity, // recorded at creation; still matches
        signal: sigkillSurvivor,
      });
      assert.deepEqual(dispositions, [{ pid: svc.pid, outcome: "signalled" }]);
      await waitForPidGone(svc.pid, "identity-match survivor");
      await assertServiceDown(svc.port, "identity-match service");
      removeTestTempDirWithDiagnostics(svc.root);
      assert.equal(fs.existsSync(svc.root), false, "owned root removed after cleanup");
    } finally {
      await cleanupOwnedService(svc);
    }
  });

  it("failing test paths leave no owned survivors behind (cleanup runs despite a mid-test failure)", async () => {
    const svc = await spawnOwnedService("failpath");
    let simulated: unknown = null;
    try {
      await assertServiceHealthy(svc.port, svc.token, svc.pid, "failpath survivor");
      // Simulate a mid-test assertion failure AFTER the survivor is up and
      // owned — the failing path.
      assert.fail("simulated US-003 mid-test assertion failure");
    } catch (err) {
      simulated = err;
    }
    assert.ok(
      simulated instanceof assert.AssertionError &&
        /simulated US-003 mid-test/.test(simulated.message),
      `expected the simulated mid-test assertion failure, got: ${String(simulated)}`,
    );

    // Owned cleanup runs on the failing path exactly as on the normal path
    // (after-hook semantics): no owned survivor may be left behind.
    const dispositions = sweepInvocationOwnedLeakedSurvivors([svc.pid]);
    assert.deepEqual(dispositions, [{ pid: svc.pid, outcome: "signalled" }]);
    await waitForPidGone(svc.pid, "failing-path survivor");
    await assertServiceDown(svc.port, "failing-path service");
    removeTestTempDirWithDiagnostics(svc.root);
    assert.equal(
      fs.existsSync(svc.root),
      false,
      "owned root removed on the failing path",
    );
  });
});

/**
 * Synthetic "invocation B" runner for the US-003 invocation-owned lifecycle
 * gate (tests/invocation-owned-lifecycle.test.ts). NOT a test file — it is
 * spawned by the gate and stands in for a concurrent second test invocation
 * that overlaps the current one.
 *
 * Why a separate process matters: createTempHome() registers every temp root
 * in the OWNING process's module-level registry, and the after-hook sweep
 * (sweepInvocationOwnedLeakedSurvivors) derives its owned-root basis from
 * ownedTempRoots(). Two synthetic invocations that share the root PREFIX must
 * therefore live in two OS processes so their ownership registries are truly
 * disjoint — exactly like two concurrent test-file processes. This runner
 * creates its own temp home root with the same prefix the orchestrator uses,
 * spawns a live synthetic service under that root, prints one JSON readiness
 * line to stdout, then waits for the orchestrator's "stop" command on stdin
 * (or stdin EOF). On stop it cleans its OWN survivors through the real
 * after-hook entry point and exits; the createTempHome process-exit handler
 * then removes the owned root.
 *
 * Reads from the environment:
 *   INVOCATION_ROOT_PREFIX  shared root prefix (same as invocation A's)
 *   NEIGHBOR_TOKEN          opaque token for the /health identity proof
 *
 * Only exact, recorded-identity operations are used: this process spawns the
 * service, records (pid, getProcessStartIdentity(pid)) at creation, and its
 * fallback cleanup kills only that recorded child — never a pattern/broad
 * kill, and never anything outside its own registry.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome } from "../helpers/test-env.ts";
import {
  sweepInvocationOwnedLeakedSurvivors,
} from "../helpers/invocation-owned-cleanup.ts";
import {
  compareProcessStartIdentities,
  getProcessStartIdentity,
} from "../../src/lib/process-start-identity.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LABEL = "neighborB";
const EXIT_DEADLINE_MS = 10_000;
const STARTUP_DEADLINE_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Absolute-deadline wait for the service's ready file. */
async function waitForReadyFile(
  readyFile: string,
  deadlineMs: number,
): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + deadlineMs;
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
      // File not written yet (or mid-write) — keep waiting until the deadline.
    }
    await sleep(100);
  }
  throw new Error(`[${LABEL}] timed out waiting for service ready file ${readyFile}`);
}

async function main(): Promise<void> {
  const prefix = process.env.INVOCATION_ROOT_PREFIX ?? "tamandua-inv-owned-lifecycle-";
  const token = process.env.NEIGHBOR_TOKEN ?? `tok-${LABEL}-${process.pid}`;

  // Own temp root: registered in THIS process's owned-root registry only, so
  // ownedTempRoots() here never contains invocation A's roots.
  const th = createTempHome(prefix);
  const serviceFixture = path.join(__dirname, "invocation-owned-service.mjs");
  const logPath = path.join(th.tamanduaDir, `${LABEL}.log`);
  const readyFile = path.join(th.tamanduaDir, `${LABEL}.ready`);

  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [serviceFixture], {
    env: cleanChildEnv({
      HOME: th.homeDir,
      SERVICE_LABEL: LABEL,
      SERVICE_TOKEN: token,
    }),
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);

  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));

  const ready = await waitForReadyFile(readyFile, STARTUP_DEADLINE_MS);
  const servicePid = child.pid ?? ready.pid;
  // Recorded at creation, exactly like the orchestrator records its own.
  const serviceIdentity = getProcessStartIdentity(servicePid);

  let stopped = false;
  async function dispose(): Promise<void> {
    if (stopped) return;
    stopped = true;
    // Clean OUR OWN survivors through the real after-hook entry point. B's
    // ownedTempRoots() contains only rootB, so the sweep signals the service.
    const dispositions = sweepInvocationOwnedLeakedSurvivors([servicePid]);
    const signalled = dispositions.some(
      (d) => d.pid === servicePid && d.outcome === "signalled",
    );
    if (!signalled && pidAlive(servicePid)) {
      // Sweep refused (e.g. evidence raced with an exit). This process
      // spawned and recorded the exact child, so an exact recorded-identity
      // kill is the sanctioned fallback — never a pattern/broad kill.
      // The v2 matcher is used (never string equality) so a legacy/unknown
      // identity can only refuse.
      const current = getProcessStartIdentity(servicePid);
      if (compareProcessStartIdentities(serviceIdentity, current) === "same") {
        try {
          process.kill(servicePid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    // Reap the child, then let process exit (exit handler removes rootB).
    await Promise.race([exited, sleep(EXIT_DEADLINE_MS)]);
  }

  try {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        root: th.root,
        homeDir: th.homeDir,
        servicePid,
        serviceIdentity,
        servicePort: ready.port,
        token,
        label: LABEL,
      }) + "\n",
    );

    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      const finish = () => {
        rl.close();
        resolve();
      };
      rl.on("line", (line) => {
        if (line.trim() === "stop") finish();
      });
      // stdin EOF: the orchestrator went away — clean up and exit.
      rl.on("close", finish);
    });

    await dispose();
    process.exit(0);
  } catch (err: unknown) {
    // Any failure path must still clean the owned survivor: the child this
    // process spawned is an exact recorded-identity kill, never a broad one.
    try {
      await dispose();
    } catch {
      // best effort on the error path
    }
    process.stderr.write(`[${LABEL}] runner error: ${String(err)}\n`);
    // exit(1) only after the readiness line has flushed to the pipe.
    process.stdout.write(JSON.stringify({ ok: false, error: String(err) }) + "\n", () => {
      process.exit(1);
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[${LABEL}] runner fatal error: ${String(err)}\n`, () => {
    process.exit(1);
  });
});

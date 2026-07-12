/**
 * Dashboard Crash Isolation Test
 *
 * Proves that killing the dashboard standalone process has zero effect on
 * running workflow runs, scheduling, claims, or the control plane.
 *
 * Uses the scripted agent (fake pi) for zero-token deterministic motor testing.
 * The do-now single-step workflow is used for minimal test complexity.
 *
 * Strategy:
 *   1. Start daemon (control plane + motor) + dashboard standalone
 *   2. Create a run — step is "pending" (ready for dispatch)
 *   3. Kill dashboard with SIGKILL
 *   4. Verify daemon alive, control plane reachable
 *   5. Nudge — prove scheduling completes the run even with dashboard dead
 *   6. Restart dashboard — verify it reattaches to live state
 *   7. Verify run completed successfully
 *
 * TEST ISOLATION: uses temp HOME + random ports. Safe for serial-lane execution.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createTempHome, cleanChildEnv } from "./helpers/test-env.ts";
import {
  createScriptedAgent,
  type ScriptedAgent,
  type ScriptedAgentConfig,
} from "../e2e-tests/helpers/scripted-agent.ts";

const repoRoot = process.cwd();
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");
const daemonScript = path.resolve(repoRoot, "dist", "server", "daemon.js");
const dashboardStandaloneScript = path.resolve(repoRoot, "dist", "server", "dashboard-standalone.js");

const DAEMON_START_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 60_000;

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Bind to port 0 to get an available port, then close it.
 * Safe for serial-lane (concurrency 1) — minor TOCTOU window.
 */
async function getAvailablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** HTTP GET health check helper. */
function httpGet(url: string, timeoutMs = 2000): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0 });
    });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
  });
}

/** Check if a process is alive via kill(0). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Build isolated env for CLI commands. */
function isolatedEnv(homeDir: string, controlPort: number): Record<string, string> {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  return {
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
  };
}

/** Run a tamandua CLI command and assert success. */
function cliMustSucceed(
  args: string[],
  env: Record<string, string>,
  label: string,
): string {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    env: cleanChildEnv(env),
    encoding: "utf-8",
  });
  assert.equal(
    r.status,
    0,
    `${label} failed (exit ${r.status}): ${r.stderr || r.stdout}`,
  );
  return r.stdout;
}

/** Spawn a detached daemon and wait for its control plane to be ready. */
function startDaemonProcess(
  homeDir: string,
  controlPort: number,
  extraEnv: Record<string, string>,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const env = cleanChildEnv({
      ...isolatedEnv(homeDir, controlPort),
      ...extraEnv,
    });
    const child = spawn(
      "node",
      ["--disable-warning=ExperimentalWarning", daemonScript],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Daemon failed to start within ${DAEMON_START_TIMEOUT_MS}ms.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    }, DAEMON_START_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      if (!resolved && output.includes("Tamandua control plane listening")) {
        resolved = true;
        clearTimeout(timeout);
        resolve(child);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Daemon exited with code ${code} before becoming ready.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    });
  });
}

/** Spawn a dashboard standalone process and wait for it to be ready. */
function startDashboardProcess(
  port: number,
  homeDir: string,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const env = cleanChildEnv({ HOME: homeDir });
    const child = spawn(
      "node",
      ["--disable-warning=ExperimentalWarning", dashboardStandaloneScript, String(port)],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Dashboard failed to start within ${DAEMON_START_TIMEOUT_MS}ms.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    }, DAEMON_START_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      if (!resolved && output.includes("Tamandua dashboard server started")) {
        resolved = true;
        clearTimeout(timeout);
        resolve(child);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Dashboard exited with code ${code} before becoming ready.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    });
  });
}

/** Stop a child process: SIGTERM, then SIGKILL after 5s. */
async function killChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (!child.pid) return;

  try {
    process.kill(child.pid, 0);
  } catch {
    return; // already dead
  }

  child.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const forceTimeout = setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try {
          child.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
      }
      resolve();
    }, 5000);

    child.once("exit", () => {
      clearTimeout(forceTimeout);
      resolve();
    });
  });
}

/** Query a single row from the DB. */
function dbRow<T>(tamanduaDir: string, sql: string, ...params: string[]): T | undefined {
  const db = new DatabaseSync(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } finally {
    db.close();
  }
}

/** Run `tamandua nudge` to ask the daemon to dispatch immediately. */
function nudgeDaemon(env: Record<string, string>): void {
  spawnSync(process.execPath, [cliPath, "nudge"], {
    env: cleanChildEnv(env),
    encoding: "utf-8",
  });
}

// ── Test ───────────────────────────────────────────────────────────

describe("Dashboard crash isolation", () => {
  let root: string;
  let homeDir: string;
  let tamanduaDir: string;
  let controlPort: number;
  let dashboardPort: number;
  let daemonChild: ChildProcess | null = null;
  let dashboardChild: ChildProcess | null = null;
  let scripted: ScriptedAgent;
  let env: Record<string, string>;

  before(async () => {
    // Build required: serial lane assumes dist/ is up-to-date.
    assert.ok(
      fs.existsSync(cliPath),
      `dist/cli/cli.js not found — run: npm run build`,
    );
    assert.ok(
      fs.existsSync(daemonScript),
      `dist/server/daemon.js not found — run: npm run build`,
    );
    assert.ok(
      fs.existsSync(dashboardStandaloneScript),
      `dist/server/dashboard-standalone.js not found — run: npm run build`,
    );

    // Isolated temp home.
    const tmpHome = createTempHome("tamandua-crash-iso-");
    root = tmpHome.root;
    homeDir = tmpHome.homeDir;
    tamanduaDir = tmpHome.tamanduaDir;

    // Symlink ~/.pi so the harness working directory logic can resolve
    // pi auth configuration (the scripted agent replaces pi at spawn time
    // via TAMANDUA_PI_BINARY, but some paths may still reference ~/.pi).
    const realPiDir = path.join(process.env.HOME ?? "/tmp", ".pi");
    const isolatedPiLink = path.join(homeDir, ".pi");
    if (fs.existsSync(realPiDir)) {
      fs.symlinkSync(realPiDir, isolatedPiLink, "dir");
    }

    // Get two available, distinct ports.
    controlPort = await getAvailablePort();
    do {
      dashboardPort = await getAvailablePort();
    } while (dashboardPort === controlPort);

    // Write port files so the daemon / CLI resolve them.
    fs.writeFileSync(
      path.join(tamanduaDir, "control-plane-port"),
      String(controlPort),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tamanduaDir, "port"),
      String(dashboardPort),
      "utf-8",
    );

    // Create scripted agent for do-now_doer.
    const doNowDoerConfig: ScriptedAgentConfig = {
      agents: {
        doer: {
          output: [
            "STATUS: done",
            "REPORT: Dashboard crash isolation test — task completed successfully.",
          ].join("\n"),
        },
      },
    };
    scripted = createScriptedAgent(root, doNowDoerConfig);

    env = isolatedEnv(homeDir, controlPort);
  });

  after(async () => {
    // Stop dashboard first.
    if (dashboardChild) {
      try {
        await killChildProcess(dashboardChild);
      } catch {
        // best-effort
      }
      dashboardChild = null;
    }

    // Stop daemon.
    if (daemonChild) {
      try {
        await killChildProcess(daemonChild);
      } catch {
        // best-effort
      }
      daemonChild = null;
    }

    // Clean up temp dir.
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("daemon and scheduling survive dashboard crash", async () => {
    // ── 1. Start the daemon (control plane + motor) ──────────────────
    daemonChild = await startDaemonProcess(homeDir, controlPort, scripted.env);
    assert.ok(daemonChild.pid, "daemon should have a PID");
    assert.ok(isProcessAlive(daemonChild.pid), "daemon should be alive after start");

    // ── 2. Verify control plane is reachable ────────────────────────
    const cpHealthBefore = await httpGet(
      `http://127.0.0.1:${controlPort}/control/health`,
    );
    assert.ok(cpHealthBefore.ok, "control plane health should return 200 before test");

    // ── 3. Start the dashboard standalone ────────────────────────────
    dashboardChild = await startDashboardProcess(dashboardPort, homeDir);
    assert.ok(dashboardChild.pid, "dashboard should have a PID");
    assert.ok(isProcessAlive(dashboardChild.pid), "dashboard should be alive after start");

    // ── 4. Verify dashboard is reachable ─────────────────────────────
    const dashHealthBefore = await httpGet(
      `http://127.0.0.1:${dashboardPort}/api/health`,
    );
    assert.ok(dashHealthBefore.ok, "dashboard health should return 200 before kill");

    // ── 5. Install the do-now workflow and create a run ─────────────
    cliMustSucceed(
      ["workflow", "install", "do-now"],
      env,
      "install do-now workflow",
    );

    const workdir = path.join(root, "do-now-workdir");
    fs.mkdirSync(workdir, { recursive: true });

    // Use spawnSync instead of spawnWorkflowRun so the CLI process
    // completes fully (registration + nudge fire-and-forget).
    const runOutput = cliMustSucceed(
      [
        "workflow",
        "run",
        "do-now",
        "Verify dashboard crash isolation — say hello",
        "--working-directory-for-harness",
        workdir,
      ],
      env,
      "create do-now run",
    );
    const runIdMatch = runOutput.match(/^Run:\s+([0-9a-f]{8,})/im);
    assert.ok(runIdMatch, `could not parse run ID from output: ${runOutput}`);
    const runIdPrefix = runIdMatch[1];

    // Resolve full run ID from DB.
    const fullRunId = (() => {
      const db = new DatabaseSync(path.join(tamanduaDir, "tamandua.db"));
      try {
        const rows = db
          .prepare("SELECT id FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1")
          .all(`${runIdPrefix}%`) as Array<{ id: string }>;
        if (rows.length === 0) {
          throw new Error(`No run found matching prefix "${runIdPrefix}"`);
        }
        return rows[0].id;
      } finally {
        db.close();
      }
    })();
    assert.ok(fullRunId, "run should be resolved from prefix");

    // Verify the step is "pending" (ready for dispatch, not yet claimed).
    const stepBefore = dbRow<{ status: string }>(
      tamanduaDir,
      "SELECT status FROM steps WHERE run_id = ?",
      fullRunId,
    );
    assert.equal(
      stepBefore?.status,
      "pending",
      `step should be 'pending' before kill, got '${stepBefore?.status}'`,
    );

    // Record daemon PID before kill for later verification.
    const daemonPid = daemonChild.pid;
    assert.ok(daemonPid, "daemon must have a pid");

    // ── 6. Kill the dashboard standalone process (SIGKILL) ──────────
    assert.ok(dashboardChild.pid, "dashboard must have a pid before kill");
    const dashboardPid = dashboardChild.pid;
    dashboardChild.kill("SIGKILL");

    // Wait for dashboard to exit.
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
      dashboardChild!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    assert.ok(
      !isProcessAlive(dashboardPid),
      "dashboard process should be dead after SIGKILL",
    );

    // ── 7. Verify daemon is still alive ─────────────────────────────
    assert.ok(isProcessAlive(daemonPid), "daemon should still be alive after dashboard killed");

    // ── 8. Verify control plane is still reachable ──────────────────
    const cpHealthAfter = await httpGet(
      `http://127.0.0.1:${controlPort}/control/health`,
    );
    assert.ok(
      cpHealthAfter.ok,
      "control plane health should still return 200 after dashboard death",
    );

    // ── 9. Prove scheduling works while dashboard is dead ────────────
    // Nudge the daemon so the scripted agent picks up the pending step.
    const runDeadline = Date.now() + RUN_TIMEOUT_MS;
    let runCompleted = false;
    while (Date.now() < runDeadline) {
      nudgeDaemon(env);
      const run = dbRow<{ status: string }>(
        tamanduaDir,
        "SELECT status FROM runs WHERE id = ?",
        fullRunId,
      );
      if (run?.status === "done" || run?.status === "completed") {
        runCompleted = true;
        break;
      }
      await sleep(500);
    }
    assert.ok(runCompleted, "run should complete while dashboard is dead");

    // Verify the step is done.
    const stepAfter = dbRow<{ status: string }>(
      tamanduaDir,
      "SELECT status FROM steps WHERE run_id = ?",
      fullRunId,
    );
    assert.equal(
      stepAfter?.status,
      "done",
      `step should be 'done', got '${stepAfter?.status}'`,
    );

    // ── 10. Restart the dashboard standalone ────────────────────────
    dashboardChild = await startDashboardProcess(dashboardPort, homeDir);
    assert.ok(dashboardChild.pid, "restarted dashboard should have a PID");
    assert.ok(isProcessAlive(dashboardChild.pid), "restarted dashboard should be alive");

    // ── 11. Verify dashboard reattaches to live state ───────────────
    const dashHealthAfter = await httpGet(
      `http://127.0.0.1:${dashboardPort}/api/health`,
    );
    assert.ok(
      dashHealthAfter.ok,
      "restarted dashboard health should return 200",
    );

    // ── 12. Verify the dashboard can still serve content ────────────
    const dashRoot = await httpGet(`http://127.0.0.1:${dashboardPort}/`);
    assert.equal(
      dashRoot.status,
      200,
      "dashboard root should return 200 after restart",
    );

    // ── Final sanity: the run is done with its full state intact ────
    const finalRun = dbRow<{ status: string }>(
      tamanduaDir,
      "SELECT status FROM runs WHERE id = ?",
      fullRunId,
    );
    assert.ok(
      finalRun?.status === "done" || finalRun?.status === "completed",
      `run final status should be done/completed, got '${finalRun?.status}'`,
    );
  });
});

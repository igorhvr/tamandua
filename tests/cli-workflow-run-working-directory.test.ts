import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import {
  cleanChildEnv,
  reservePortHandles,
  stopPidfileServiceAndWait,
} from "./helpers/test-env.ts";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { stopDaemon } from "../dist/server/daemonctl.js";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

async function createTempEnv() {
  const handles = await reservePortHandles(2);
  const controlPort = handles[0].port;
  const dashboardPort = handles[1].port;
  const root = tamanduaTempDir("tamandua-cli-run-cwd-");
  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(path.join(tamanduaDir, "port"), String(dashboardPort), "utf-8");
  return { root, homeDir, tamanduaDir, controlPort, dashboardPort, portHandles: handles };
}

function writeMinimalWorkflow(homeDir: string, workflowId: string): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    [
      `id: ${workflowId}`,
      "agents:",
      "  - id: dev",
      "    model: fake",
      "    workspace:",
      "      baseDir: .",
      "steps:",
      "  - id: implement",
      "    agent: dev",
      "    input: Implement the task",
      "    expects: STATUS, CHANGES, TESTS",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function runCliUntilOutput(args: string[], env: Record<string, string>, pattern: RegExp): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);

    const maybeFinish = (code: number | null) => {
      if (finished) return;
      if (pattern.test(stdout)) {
        finished = true;
        clearTimeout(timeout);
        // workflow run may keep process alive due polling timers; stop once output is observed
        if (!child.killed) {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        }
        resolve({ stdout, stderr, code });
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      maybeFinish(null);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

async function runCliToExit(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/**
 * US-003: a minimal stand-in for the daemon control plane. It answers the
 * liveness probe (/control/health) so runWorkflow never spawns a real daemon,
 * and replies to register-run with a canned response. Everything else (e.g.
 * /control/nudge) gets a benign 200.
 */
async function startFakeControlPlane(response: {
  status: number;
  body: Record<string, unknown>;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/control/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/control/register-run") {
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(JSON.stringify(response.body));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("CLI workflow run working-directory-for-harness", () => {
  it("passes --working-directory-for-harness into run context and cron metadata", async () => {
    const env = await createTempEnv();

    try {
      const workflowId = "cli-run-cwd";
      writeMinimalWorkflow(env.homeDir, workflowId);

      const harnessDir = path.join(env.root, "remote-workdir");
      fs.mkdirSync(harnessDir, { recursive: true });

      await Promise.all(env.portHandles.map(h => h.close()));
      const { stdout, stderr } = await runCliUntilOutput(
        [
          "workflow",
          "run",
          workflowId,
          "Validate harness working directory",
          "--working-directory-for-harness",
          harnessDir,
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(env.controlPort) },
        /Harness CWD:/,
      );

      const meaningfulStderr = stderr
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .filter((line) => !line.includes("ExperimentalWarning: SQLite"))
        .filter((line) => !line.includes("--trace-warnings"))
        .filter((line) => !line.includes("Warning: installed catalog is older than bundled catalog"))
        .filter((line) => !line.includes("Unable to capture original branch at launch"))
        .filter((line) => !line.includes("Unable to capture base branch SHA at launch"))
        .filter((line) => !line.includes("Stopping at filesystem boundary"))
        .filter((line) => !/^run #\d+ \([0-9a-f]{8}\) created; preparing workspace\.\.\.$/.test(line))
        .join("\n");
      assert.equal(meaningfulStderr, "", `expected no meaningful stderr, got: ${stderr}`);
      assert.match(stdout, /Run: run-/i);
      assert.match(stdout, new RegExp(`Harness CWD: ${path.resolve(harnessDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db
        .prepare(
          "SELECT context, scheduling_status, scheduling_requested_at FROM runs ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { context: string; scheduling_status: string | null; scheduling_requested_at: string | null } | undefined;
      db.close();

      assert.ok(row, "expected a run row in DB");
      const context = JSON.parse(row!.context) as Record<string, string>;
      assert.equal(context.working_directory_for_harness, path.resolve(harnessDir));

      // Run-scoped scheduling fields are populated for new runs.
      assert.ok(
        row!.scheduling_status === "active" || row!.scheduling_status === "pending_register",
        `expected scheduling_status to be active or pending_register, got ${row!.scheduling_status}`,
      );
      assert.ok(row!.scheduling_requested_at, "expected scheduling_requested_at to be set");
    } finally {
      try { await Promise.all(env.portHandles.map(h => h.close())); } catch {}
      await stopPidfileServiceAndWait({ pidFile: path.join(env.tamanduaDir, "tamandua.pid"), stop: stopDaemon, label: "daemon", homeDir: env.homeDir });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  it("fails fast when --working-directory-for-harness does not exist", async () => {
    const env = await createTempEnv();

    try {
      const workflowId = "cli-run-cwd-invalid";
      writeMinimalWorkflow(env.homeDir, workflowId);

      const missingDir = path.join(env.root, "missing-dir");
      await Promise.all(env.portHandles.map(h => h.close()));
      const result = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Should fail",
          "--working-directory-for-harness",
          missingDir,
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(env.controlPort) },
      );

      assert.equal(result.code, 1, `expected exit code 1, got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stderr, /working-directory-for-harness does not exist/i);
      assert.ok(!result.stdout.includes("Run:"), "should not print successful run output");
    } finally {
      try { await Promise.all(env.portHandles.map(h => h.close())); } catch {}
      await stopPidfileServiceAndWait({ pidFile: path.join(env.tamanduaDir, "tamandua.pid"), stop: stopDaemon, label: "daemon", homeDir: env.homeDir });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  // Regression: LNCH false failure after run creation (Half A).
  // When the run row is created but the daemon control plane probe
  // times out, the CLI must exit 0 (success) and print the run ID
  // — never report a failure or print "Error".
  it("exits 0 with run-id when probe times out after run creation", async () => {
    const env = await createTempEnv();

    // Reserve a fresh port and bind a dummy listener to it so the
    // daemon cannot bind its control plane there. The probe will
    // always time out because our listener doesn't respond with 200.
    const { reservePortHandle } = await import(
      "./helpers/test-env.ts"
    );
    const blockerPortHandle = await reservePortHandle();
    const blockerPort = blockerPortHandle.port;
    // Start a dummy server that accepts but returns 503 — keeps
    // the port occupied so the daemon cannot bind.
    const http = await import("node:http");
    const dummyServer = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end("blocked");
    });
    await blockerPortHandle.close();
    await new Promise<void>((resolve, reject) => {
      dummyServer.listen(blockerPort, "127.0.0.1", resolve);
      dummyServer.on("error", reject);
    });

    const probeTimeoutMs = "2000";

    try {
      const workflowId = "cli-lnch-probe-timeout";
      writeMinimalWorkflow(env.homeDir, workflowId);

      const result = await runCliToExit(
        ["workflow", "run", workflowId, "Test LNCH probe timeout"],
        {
          HOME: env.homeDir,
          TAMANDUA_CONTROL_PORT: String(blockerPort),
          TAMANDUA_CONTROL_PROBE_TIMEOUT_OVERRIDE: probeTimeoutMs,
        },
      );

      assert.equal(
        result.code,
        0,
        `expected exit code 0 (success), got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(
        result.stdout,
        /Run: run-/i,
        "output should contain the run ID",
      );
      assert.ok(
        !result.stdout.includes("Error:") &&
        !result.stdout.includes("failed") &&
        !result.stdout.includes("failure"),
        `output must NOT contain failure wording; got:\n${result.stdout}`,
      );
      assert.match(
        result.stdout,
        /Run created \(pending admission\)/,
        "output should indicate run was created (pending admission)",
      );
      assert.match(
        result.stdout,
        /tamandua workflow status/,
        "output should include status command hint",
      );

      // Verify the run row exists in the DB
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db
        .prepare(
          "SELECT id, status FROM runs ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { id: string; status: string } | undefined;
      db.close();
      assert.ok(row, "run row should exist in DB");
      assert.equal(row!.status, "running", "run status should be 'running'");
    } finally {
      try { await blockerPortHandle.close(); } catch {}
      try { await Promise.all(env.portHandles.map(h => h.close())); } catch {}
      dummyServer.close();
      await stopPidfileServiceAndWait({ pidFile: path.join(env.tamanduaDir, "tamandua.pid"), stop: stopDaemon, label: "daemon", homeDir: env.homeDir });
      try {
        fs.rmSync(env.root, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
  });

  it("exits 1 when workflow does not exist (fail before run creation)", async () => {
    const env = await createTempEnv();

    try {
      await Promise.all(env.portHandles.map(h => h.close()));
      const result = await runCliToExit(
        ["workflow", "run", "nonexistent-workflow-id", "Should fail"],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(env.controlPort) },
      );

      assert.equal(
        result.code,
        1,
        `expected exit code 1 for invalid workflow, got ${result.code}`,
      );
      // Output should not contain a run ID because no run was created
      assert.ok(
        !result.stdout.includes("Run:"),
        "should not print successful run output for invalid workflow",
      );
    } finally {
      try { await Promise.all(env.portHandles.map(h => h.close())); } catch {}
      await stopPidfileServiceAndWait({ pidFile: path.join(env.tamanduaDir, "tamandua.pid"), stop: stopDaemon, label: "daemon", homeDir: env.homeDir });
      try {
        fs.rmSync(env.root, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
  });

  // US-003: a busy harness workdir is a retriable admission condition, so the
  // synchronous CLI path must exit 0 with a queued-behind explanation (not the
  // old fatal 422), and --wait must still enter the wait loop for the new run.
  it("prints queued-behind and exits 0 when the harness workdir is held", async () => {
    const env = await createTempEnv();
    const holderRunId = crypto.randomUUID();
    const harnessDir = path.join(env.root, "held-workdir");
    fs.mkdirSync(harnessDir, { recursive: true });
    const fake = await startFakeControlPlane({
      status: 202,
      body: {
        state: "waiting",
        heldByRunId: holderRunId,
        workingDirectoryForHarness: path.resolve(harnessDir),
      },
    });

    try {
      const workflowId = "cli-run-queued";
      writeMinimalWorkflow(env.homeDir, workflowId);
      await Promise.all(env.portHandles.map(h => h.close()));

      const result = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Queued run",
          "--working-directory-for-harness",
          harnessDir,
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(fake.port) },
      );

      assert.equal(
        result.code,
        0,
        `expected exit code 0 (queued, not refused), got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(
        result.stdout,
        new RegExp(`Queued behind run ${holderRunId}`),
        `stdout must name the holder run id:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes(path.resolve(harnessDir)),
        `stdout must name the held harness workdir:\n${result.stdout}`,
      );
      assert.ok(
        !result.stdout.includes("Status: running"),
        `the generic status line must not be printed for a queued-behind run:\n${result.stdout}`,
      );
      assert.ok(
        !result.stderr.includes("Failed to register run"),
        `stderr must not report a registration failure:\n${result.stderr}`,
      );
    } finally {
      try { await fake.close(); } catch {}
      try { await Promise.all(env.portHandles.map(h => h.close())); } catch {}
      await stopPidfileServiceAndWait({ pidFile: path.join(env.tamanduaDir, "tamandua.pid"), stop: stopDaemon, label: "daemon", homeDir: env.homeDir });
      try {
        fs.rmSync(env.root, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
  });

  it("still enters the wait loop with --wait when the run is queued behind a holder", async () => {
    const env = await createTempEnv();
    const holderRunId = crypto.randomUUID();
    const harnessDir = path.join(env.root, "held-workdir-wait");
    fs.mkdirSync(harnessDir, { recursive: true });
    const fake = await startFakeControlPlane({
      status: 202,
      body: {
        state: "waiting",
        heldByRunId: holderRunId,
        workingDirectoryForHarness: path.resolve(harnessDir),
      },
    });

    try {
      const workflowId = "cli-run-queued-wait";
      writeMinimalWorkflow(env.homeDir, workflowId);
      await Promise.all(env.portHandles.map(h => h.close()));

      // --timeout 1s bounds the wait: the run stays non-terminal (the fake
      // control plane never admits it), so the loop must time out with exit 2
      // while having entered the wait loop for the newly created run.
      const result = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Queued wait run",
          "--working-directory-for-harness",
          harnessDir,
          "--wait",
          "--timeout",
          "1s",
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(fake.port) },
      );

      assert.equal(
        result.code,
        2,
        `expected wait-timeout exit code 2, got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(
        result.stdout,
        new RegExp(`Queued behind run ${holderRunId}`),
        `stdout must still explain the queue position:\n${result.stdout}`,
      );
      assert.match(
        result.stderr,
        /\[wait /,
        `--wait must enter the wait loop (heartbeat on stderr):\n${result.stderr}`,
      );
      assert.match(result.stdout, /running/, "wait output must describe the queued run");
    } finally {
      try { await fake.close(); } catch {}
      try { await Promise.all(env.portHandles.map(h => h.close())); } catch {}
      await stopPidfileServiceAndWait({ pidFile: path.join(env.tamanduaDir, "tamandua.pid"), stop: stopDaemon, label: "daemon", homeDir: env.homeDir });
      try {
        fs.rmSync(env.root, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
  });
});

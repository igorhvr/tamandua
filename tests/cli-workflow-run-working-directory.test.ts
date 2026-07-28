import fs from "node:fs";
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
});

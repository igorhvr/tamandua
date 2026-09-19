/**
 * SKILL-UX S3 (US-002): `tamandua workflow run` prints resolved launch facts
 * (working directory/origin, clean/dirty, harness path+version, daemon
 * endpoint) as its FIRST output lines, before the run-created line.
 *
 * Uses isolated temp HOME dirs and a fake control plane so the CLI exits
 * cleanly without ever spawning a real daemon.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanChildEnv,
  reservePortHandle,
  reservePortHandles,
  stopPidfileServiceAndWait,
} from "./helpers/test-env.ts";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import { stopDaemon } from "../dist/server/daemonctl.js";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

async function createTempEnv() {
  const handles = await reservePortHandles(1);
  const root = tamanduaTempDir("tamandua-cli-run-resolution-");
  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  return { root, homeDir, tamanduaDir, portHandles: handles };
}

function writeWorkflow(
  homeDir: string,
  workflowId: string,
  workspace: "direct" | "worktree",
): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  const runBlock =
    workspace === "worktree" ? ["run:", "  workspace: worktree"] : [];
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
      ...runBlock,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function initGitRepo(dir: string, branch = "main"): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  git(["init", "-q", "-b", branch]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test Runner"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "hello\n", "utf-8");
  git(["add", "tracked.txt"]);
  git(["commit", "-qm", "init"]);
}

function writeFakePi(root: string): string {
  const script = path.join(root, "fake-pi");
  fs.writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "--version" ]; then',
      '  echo "0.99.0"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(script, 0o755);
  return script;
}

/**
 * Minimal daemon control-plane stand-in: answers /control/health so the
 * resolution probe reports "ok", and register-run with a canned 200 so the
 * run completes without a real daemon.
 */
async function startFakeControlPlane(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/control/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/control/register-run") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: "active", requiredTimers: 1 }));
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

async function runCliToExit(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
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

function stdoutLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("CLI workflow run resolution lines (SKILL-UX S3 / US-002)", () => {
  it("direct mode prints working-directory/harness/daemon before the Run line", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();

    try {
      const workflowId = "res-direct";
      writeWorkflow(env.homeDir, workflowId, "direct");

      const harnessDir = path.join(env.root, "workdir");
      initGitRepo(harnessDir);
      const fakePi = writeFakePi(env.root);
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Resolve launch facts",
          "--working-directory-for-harness",
          harnessDir,
        ],
        {
          HOME: env.homeDir,
          TAMANDUA_CONTROL_PORT: String(fake.port),
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      assert.equal(code, 0, `expected exit 0, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      const lines = stdoutLines(stdout);
      const runIdx = lines.findIndex((l) => l.startsWith("Run: run-"));
      assert.ok(runIdx > 0, `expected a Run: line, got:\n${stdout}`);

      const wdIdx = lines.findIndex((l) => l.startsWith("working-directory:"));
      const harnessIdx = lines.findIndex((l) => l.startsWith("harness:"));
      const daemonIdx = lines.findIndex((l) => l.startsWith("daemon:"));
      assert.ok(wdIdx >= 0, `expected working-directory line, got:\n${stdout}`);
      assert.ok(harnessIdx >= 0, `expected harness line, got:\n${stdout}`);
      assert.ok(daemonIdx >= 0, `expected daemon line, got:\n${stdout}`);

      // All three resolution lines must precede the run-created Run: line.
      assert.ok(wdIdx < runIdx, "working-directory line must precede Run:");
      assert.ok(harnessIdx < runIdx, "harness line must precede Run:");
      assert.ok(daemonIdx < runIdx, "daemon line must precede Run:");

      assert.equal(
        lines[wdIdx],
        `working-directory: ${path.resolve(harnessDir)} clean`,
      );
      assert.equal(lines[harnessIdx], `harness: pi ${fakePi} (0.99.0)`);
      assert.equal(lines[daemonIdx], `daemon: http://127.0.0.1:${fake.port} ok`);
    } finally {
      try { await fake.close(); } catch {}
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({
        pidFile: path.join(env.tamanduaDir, "tamandua.pid"),
        stop: stopDaemon,
        label: "daemon",
        homeDir: env.homeDir,
      });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("reports dirty when the direct working tree has uncommitted changes", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();

    try {
      const workflowId = "res-direct-dirty";
      writeWorkflow(env.homeDir, workflowId, "direct");

      const harnessDir = path.join(env.root, "workdir-dirty");
      initGitRepo(harnessDir);
      fs.writeFileSync(path.join(harnessDir, "tracked.txt"), "changed\n", "utf-8");
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Dirty tree",
          "--working-directory-for-harness",
          harnessDir,
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(fake.port) },
      );

      assert.equal(code, 0, `expected exit 0, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      assert.match(
        stdout,
        new RegExp(
          `working-directory: ${path.resolve(harnessDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} dirty`,
        ),
        `expected a dirty working-directory line, got:\n${stdout}`,
      );
    } finally {
      try { await fake.close(); } catch {}
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({
        pidFile: path.join(env.tamanduaDir, "tamandua.pid"),
        stop: stopDaemon,
        label: "daemon",
        homeDir: env.homeDir,
      });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("worktree mode prints origin line with ref and resolved sha", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();

    try {
      const workflowId = "res-worktree";
      writeWorkflow(env.homeDir, workflowId, "worktree");

      const originRepo = path.join(env.root, "origin-repo");
      initGitRepo(originRepo, "main");
      const sha = spawnSync("git", ["rev-parse", "main"], {
        cwd: originRepo,
        encoding: "utf-8",
      })
        .stdout.trim();
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Worktree launch",
          "--worktree-origin-repository",
          originRepo,
          "--worktree-origin-ref",
          "main",
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(fake.port) },
      );

      assert.equal(code, 0, `expected exit 0, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      const lines = stdoutLines(stdout);
      const originIdx = lines.findIndex((l) => l.startsWith("origin:"));
      const runIdx = lines.findIndex((l) => l.startsWith("Run: run-"));
      assert.ok(originIdx >= 0, `expected origin line, got:\n${stdout}`);
      assert.ok(runIdx > originIdx, "origin line must precede Run:");

      const originPath = fs.realpathSync(originRepo);
      assert.equal(
        lines[originIdx],
        `origin: ${originPath} @ main (${sha}) clean`,
      );
    } finally {
      try { await fake.close(); } catch {}
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({
        pidFile: path.join(env.tamanduaDir, "tamandua.pid"),
        stop: stopDaemon,
        label: "daemon",
        homeDir: env.homeDir,
      });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("reports daemon unreachable when the control plane does not answer", async () => {
    const env = await createTempEnv();

    try {
      const workflowId = "res-direct-unreachable";
      writeWorkflow(env.homeDir, workflowId, "direct");
      const harnessDir = path.join(env.root, "workdir-unreachable");
      fs.mkdirSync(harnessDir, { recursive: true });

      // A free port with nothing listening: the resolution probe must report
      // "unreachable" before runWorkflow proceeds.
      const portHandle = await reservePortHandle();
      const freePort = portHandle.port;
      await portHandle.close();
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Unreachable daemon",
          "--working-directory-for-harness",
          harnessDir,
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(freePort) },
      );

      assert.match(
        stdout,
        new RegExp(`daemon: http://127\\.0\\.0\\.1:${freePort} unreachable`),
        `expected an unreachable daemon line, got:\n${stdout}`,
      );
    } finally {
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({
        pidFile: path.join(env.tamanduaDir, "tamandua.pid"),
        stop: stopDaemon,
        label: "daemon",
        homeDir: env.homeDir,
      });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("CLI workflow run --json resolution fields (SKILL-UX S3 / US-003)", () => {
  it("direct mode emits one JSON object with resolution fields and run fields", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();

    try {
      const workflowId = "json-direct";
      writeWorkflow(env.homeDir, workflowId, "direct");

      const harnessDir = path.join(env.root, "workdir-json");
      initGitRepo(harnessDir);
      const fakePi = writeFakePi(env.root);
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "JSON task",
          "--working-directory-for-harness",
          harnessDir,
          "--json",
        ],
        {
          HOME: env.homeDir,
          TAMANDUA_CONTROL_PORT: String(fake.port),
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      assert.equal(code, 0, `expected exit 0, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      let parsed: Record<string, any>;
      assert.doesNotThrow(
        () => { parsed = JSON.parse(stdout.trim()); },
        `stdout must be a single valid JSON document:\n${stdout}`,
      );

      // Existing JSON run fields are preserved.
      assert.ok(parsed.runId.startsWith("run-"), `runId must be prefixed, got ${parsed.runId}`);
      assert.equal(parsed.workflowId, workflowId);
      assert.equal(parsed.task, "JSON task");
      assert.equal(parsed.status, "running");
      assert.equal(typeof parsed.stepCount, "number");
      assert.equal(parsed.harnessCwd, path.resolve(harnessDir));

      // Resolution fields match the text-mode lines.
      const resolution = parsed.resolution;
      assert.ok(resolution, `expected a resolution object:\n${stdout}`);
      assert.equal(resolution.workspaceMode, "direct");
      assert.equal(resolution.workingDirectory, path.resolve(harnessDir));
      assert.equal(resolution.clean, true);
      assert.equal(resolution.harness.type, "pi");
      assert.equal(resolution.harness.path, fakePi);
      assert.equal(resolution.harness.version, "0.99.0");
      assert.equal(resolution.daemon.endpoint, `http://127.0.0.1:${fake.port}`);
      assert.equal(resolution.daemon.ok, true);

      // JSON mode must not leak the human-readable resolution or Run lines.
      assert.ok(!stdout.includes("working-directory:"), `no text resolution line on stdout:\n${stdout}`);
      assert.ok(!stdout.includes("Run: run-"), `no text Run block on stdout:\n${stdout}`);
    } finally {
      try { await fake.close(); } catch {}
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({
        pidFile: path.join(env.tamanduaDir, "tamandua.pid"),
        stop: stopDaemon,
        label: "daemon",
        homeDir: env.homeDir,
      });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("worktree mode includes origin path/ref/sha and clean", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();

    try {
      const workflowId = "json-worktree";
      writeWorkflow(env.homeDir, workflowId, "worktree");

      const originRepo = path.join(env.root, "origin-json");
      initGitRepo(originRepo, "main");
      const sha = spawnSync("git", ["rev-parse", "main"], {
        cwd: originRepo,
        encoding: "utf-8",
      })
        .stdout.trim();
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "JSON worktree",
          "--worktree-origin-repository",
          originRepo,
          "--worktree-origin-ref",
          "main",
          "--json",
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(fake.port) },
      );

      assert.equal(code, 0, `expected exit 0, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      let parsed: Record<string, any>;
      assert.doesNotThrow(
        () => { parsed = JSON.parse(stdout.trim()); },
        `stdout must be a single valid JSON document:\n${stdout}`,
      );

      const resolution = parsed.resolution;
      assert.ok(resolution, `expected a resolution object:\n${stdout}`);
      assert.equal(resolution.workspaceMode, "worktree");
      assert.equal(resolution.workingDirectory, undefined);
      assert.equal(resolution.origin.path, fs.realpathSync(originRepo));
      assert.equal(resolution.origin.ref, "main");
      assert.equal(resolution.origin.sha, sha);
      assert.equal(resolution.clean, true);
    } finally {
      try { await fake.close(); } catch {}
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({
        pidFile: path.join(env.tamanduaDir, "tamandua.pid"),
        stop: stopDaemon,
        label: "daemon",
        homeDir: env.homeDir,
      });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("--wait --json merges the wait result into the same JSON document", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();

    try {
      const workflowId = "json-wait";
      writeWorkflow(env.homeDir, workflowId, "direct");

      const harnessDir = path.join(env.root, "workdir-json-wait");
      initGitRepo(harnessDir);
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "JSON wait task",
          "--working-directory-for-harness",
          harnessDir,
          "--wait",
          "--timeout",
          "1s",
          "--json",
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(fake.port) },
      );

      // The fake control plane keeps the run non-terminal, so --wait times out.
      assert.equal(code, 2, `expected wait-timeout exit code 2, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      let parsed: Record<string, any>;
      assert.doesNotThrow(
        () => { parsed = JSON.parse(stdout.trim()); },
        `stdout must be a single valid JSON document:\n${stdout}`,
      );

      assert.equal(parsed.workflowId, workflowId);
      assert.equal(parsed.resolution.workspaceMode, "direct");
      assert.equal(parsed.resolution.workingDirectory, path.resolve(harnessDir));
      assert.ok(Array.isArray(parsed.runs), `expected a runs array:\n${stdout}`);
      assert.equal(parsed.timedOut, true);
      assert.equal(parsed.runs.length, 1);
      assert.equal(parsed.runs[0].workflowId, workflowId);

      // One JSON document, one line — never mixed text+JSON on stdout.
      assert.equal(
        stdout.trim().split(/\r?\n/).length,
        1,
        `expected exactly one stdout line, got:\n${stdout}`,
      );
    } finally {
      try { await fake.close(); } catch {}
      try { await Promise.all(env.portHandles.map((h) => h.close())); } catch {}
      await stopPidfileServiceAndWait({
        pidFile: path.join(env.tamanduaDir, "tamandua.pid"),
        stop: stopDaemon,
        label: "daemon",
        homeDir: env.homeDir,
      });
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

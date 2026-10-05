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
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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
import { writeFakeRpcDriver } from "../dist/installer/matchlock/fake-rpc-driver.js";

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
        res.end(JSON.stringify({ ok: true, prepStateCapability: "MTLK-ISO-SLICE2-PREP-STATE" }));
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

/**
 * MTLK-VM-SIZE US-005: the Matchlock VM-size line is fused into the SKILL-UX
 * resolved-launch block (printed once, BEFORE the `run #N ... created` line)
 * and the same facts appear in `workflow run --json`'s resolution object.
 * Matchlock runs are driven through the real admission path against the fake
 * JSON-RPC driver, so no VM is ever created.
 */
describe("CLI workflow run matchlock launch facts (MTLK-VM-SIZE US-005)", () => {
  /**
   * Build the host fixture an opted-in Matchlock run needs: a real host path
   * under the operator home for the harness workdir (guest mounts keep exact
   * host paths), an existing selected pi configuration root, and the fake
   * JSON-RPC driver that stands in for the matchlock runtime.
   */
  function writeMatchlockFixture(): {
    fixtureRoot: string;
    workDir: string;
    driver: string;
    transcript: string;
  } {
    const fixtureRoot = fs.mkdtempSync(path.join(os.homedir(), ".mtlk-cli-us005-"));
    const workDir = path.join(fixtureRoot, "work");
    fs.mkdirSync(workDir, { recursive: true });
    const driver = writeFakeRpcDriver({ dir: path.join(fixtureRoot, "driver") });
    const transcript = path.join(fixtureRoot, "transcript.jsonl");
    return { fixtureRoot, workDir, driver, transcript };
  }

  function matchlockEnv(
    env: { homeDir: string },
    fixture: { driver: string; transcript: string },
    fakePort: number,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      HOME: env.homeDir,
      TAMANDUA_CONTROL_PORT: String(fakePort),
      // MTLK-ISO-SLICE2 US-003: the fake rpc driver doubles as the matchlock
      // CLI and advertises the exact --swap token, so the swap handshake (which
      // probes `<bin> run --help`) passes without a real binary.
      TAMANDUA_MATCHLOCK_RPC_BIN: fixture.driver,
      TAMANDUA_MATCHLOCK_RPC_ARGS: JSON.stringify(["rpc"]),
      FAKE_TRANSCRIPT_FILE: fixture.transcript,
      FAKE_IMAGE_TAG: "vic/matchlock-base:latest",
      FAKE_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
      FAKE_IMAGE_CONFIG_DIGEST: `sha256:${"b".repeat(64)}`,
      ...extra,
    };
  }

  /**
   * MTLK-ISO-SLICE1 US-008: the CLI launch path resolves the swap size and
   * hands it (with the other limits) to run creation, where admission persists
   * it on the run's v3 policy. Read the newest run's persisted swapMB back.
   */
  function readPersistedSwapMB(tamanduaDir: string): number | undefined {
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    if (!fs.existsSync(dbPath)) return undefined;
    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare("SELECT matchlock_policy FROM runs ORDER BY rowid DESC LIMIT 1")
        .get() as { matchlock_policy?: string } | undefined;
      if (!row?.matchlock_policy) return undefined;
      const parsed = JSON.parse(row.matchlock_policy) as {
        resourceLimits?: { swapMB?: number };
      };
      return parsed.resourceLimits?.swapMB;
    } finally {
      db.close();
    }
  }

  it("prints exactly one matchlock line inside the resolved block before the Run: line", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();
    const fixture = writeMatchlockFixture();

    try {
      const workflowId = "res-matchlock-text";
      writeWorkflow(env.homeDir, workflowId, "direct");
      fs.mkdirSync(path.join(env.homeDir, ".pi", "agent"), { recursive: true });
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Matchlock launch facts",
          "--working-directory-for-harness",
          fixture.workDir,
          "--matchlock-image",
          "vic/matchlock-base:latest",
          "--matchlock-cpus",
          "4",
          "--matchlock-memory",
          "4096",
          "--matchlock-disk",
          "20480",
        ],
        matchlockEnv(env, fixture, fake.port),
      );

      assert.equal(code, 0, `expected exit 0, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      const lines = stdoutLines(stdout);
      const runIdx = lines.findIndex((l) => l.startsWith("Run: run-"));
      assert.ok(runIdx > 0, `expected a Run: line, got:\n${stdout}`);

      const wdIdx = lines.findIndex((l) => l.startsWith("working-directory:"));
      const daemonIdx = lines.findIndex((l) => l.startsWith("daemon:"));
      const matchlockLines = lines.filter((l) => l.startsWith("matchlock:"));
      assert.equal(
        matchlockLines.length,
        1,
        `expected EXACTLY one matchlock line, got ${matchlockLines.length}:\n${stdout}`,
      );
      const matchlockIdx = lines.findIndex((l) => l.startsWith("matchlock:"));
      assert.ok(wdIdx >= 0 && daemonIdx >= 0, `expected the resolved block, got:\n${stdout}`);
      // It is part of the SAME resolved block: after the other launch facts
      // and strictly before the synchronous run-created line.
      assert.ok(matchlockIdx > wdIdx, "matchlock line must follow working-directory:");
      assert.ok(matchlockIdx > daemonIdx, "matchlock line must follow daemon:");
      assert.ok(matchlockIdx < runIdx, "matchlock line must precede Run:");
      assert.equal(
        matchlockLines[0],
        "matchlock: vic/matchlock-base:latest cpus=4 memory=4096MB disk=20480MB swap=8192MB",
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
      try { fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true }); } catch {}
    }
  });

  it("--json carries resolution.matchlockResources with the image and limits", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();
    const fixture = writeMatchlockFixture();

    try {
      const workflowId = "res-matchlock-json";
      writeWorkflow(env.homeDir, workflowId, "direct");
      fs.mkdirSync(path.join(env.homeDir, ".pi", "agent"), { recursive: true });
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Matchlock JSON facts",
          "--working-directory-for-harness",
          fixture.workDir,
          "--matchlock-image",
          "vic/matchlock-base:latest",
          "--matchlock-cpus",
          "2",
          "--matchlock-memory",
          "2048",
          "--matchlock-disk",
          "10240",
          "--json",
        ],
        matchlockEnv(env, fixture, fake.port),
      );

      assert.equal(code, 0, `expected exit 0, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      let parsed: Record<string, any>;
      assert.doesNotThrow(
        () => { parsed = JSON.parse(stdout.trim()); },
        `stdout must be a single valid JSON document:\n${stdout}`,
      );

      assert.ok(parsed.resolution, `expected a resolution object:\n${stdout}`);
      assert.deepEqual(
        parsed.resolution.matchlockResources,
        {
          image: "vic/matchlock-base:latest",
          imageSource: "explicit",
          cpus: 2,
          memoryMB: 2048,
          diskSizeMB: 10240,
          swapMB: 8192,
          imageDigest: `sha256:${"a".repeat(64)}`,
          imageConfigDigest: `sha256:${"b".repeat(64)}`,
        },
        `--json must carry the matchlock facts in resolution.matchlockResources:\n${stdout}`,
      );
      // Mirrored at the top level exactly where `workflow status --json` puts
      // them, so the same shape is readable from either command.
      assert.deepEqual(
        parsed.matchlockResources,
        {
          image: "vic/matchlock-base:latest",
          imageSource: "explicit",
          cpus: 2,
          memoryMB: 2048,
          diskSizeMB: 10240,
          swapMB: 8192,
          imageDigest: `sha256:${"a".repeat(64)}`,
          imageConfigDigest: `sha256:${"b".repeat(64)}`,
        },
        `--json must mirror matchlockResources at the top level:\n${stdout}`,
      );
      // JSON mode stays a single document: no human-readable matchlock line.
      assert.ok(
        !stdout.includes("matchlock: vic/"),
        `no text matchlock line on stdout in JSON mode:\n${stdout}`,
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
      try { fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true }); } catch {}
    }
  });

  it("US-013: --json carries the shared root_usage_override warning only when consent is recorded", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();
    const fixture = writeMatchlockFixture();

    try {
      const workflowId = "res-matchlock-warnings";
      writeWorkflow(env.homeDir, workflowId, "direct");
      fs.mkdirSync(path.join(env.homeDir, ".pi", "agent"), { recursive: true });
      const cleanWorkDir = path.join(fixture.fixtureRoot, "work-clean");
      const consentWorkDir = path.join(fixture.fixtureRoot, "work-consent");
      fs.mkdirSync(cleanWorkDir, { recursive: true });
      fs.mkdirSync(consentWorkDir, { recursive: true });
      await Promise.all(env.portHandles.map((h) => h.close()));

      const baseArgs = (workDir: string) => [
        "workflow",
        "run",
        workflowId,
        "Matchlock warnings",
        "--working-directory-for-harness",
        workDir,
        "--matchlock-image",
        "vic/matchlock-base:latest",
        "--matchlock-cpus",
        "2",
        "--matchlock-memory",
        "2048",
        "--matchlock-disk",
        "10240",
      ];

      // A clean launch records no consent: the warnings key is ABSENT (never []).
      const clean = await runCliToExit(
        [...baseArgs(cleanWorkDir), "--json"],
        matchlockEnv(env, fixture, fake.port),
      );
      assert.equal(clean.code, 0, `expected exit 0\nstdout:\n${clean.stdout}\nstderr:\n${clean.stderr}`);
      const cleanParsed = JSON.parse(clean.stdout.trim());
      assert.equal(
        Object.prototype.hasOwnProperty.call(cleanParsed, "warnings"),
        false,
        `a clean launch must not carry the warnings key (absent, never []):\n${clean.stdout}`,
      );

      // A consented launch re-derives root_usage_override from the ADMITTED
      // policy; the warning states root execution is AUTHORIZED and never
      // claims actual root execution.
      const consent = await runCliToExit(
        [
          ...baseArgs(consentWorkDir),
          "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs",
          "--json",
        ],
        matchlockEnv(env, fixture, fake.port),
      );
      assert.equal(consent.code, 0, `expected exit 0\nstdout:\n${consent.stdout}\nstderr:\n${consent.stderr}`);
      const consentParsed = JSON.parse(consent.stdout.trim());
      assert.equal(consentParsed.warnings.length, 1, `expected one warning:\n${consent.stdout}`);
      assert.equal(consentParsed.warnings[0].code, "root_usage_override");
      assert.match(consentParsed.warnings[0].message, /AUTHORIZED/);
      assert.doesNotMatch(consentParsed.warnings[0].message, /executed as root/);
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
      try { fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true }); } catch {}
    }
  });

  it("US-013: text mode prints the shared warning to stderr and the exit code is unchanged", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();
    const fixture = writeMatchlockFixture();

    try {
      const workflowId = "res-matchlock-warnings-text";
      writeWorkflow(env.homeDir, workflowId, "direct");
      fs.mkdirSync(path.join(env.homeDir, ".pi", "agent"), { recursive: true });
      const workDir = path.join(fixture.fixtureRoot, "work-text");
      fs.mkdirSync(workDir, { recursive: true });
      await Promise.all(env.portHandles.map((h) => h.close()));

      const { stdout, stderr, code } = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Matchlock warning text",
          "--working-directory-for-harness",
          workDir,
          "--matchlock-image",
          "vic/matchlock-base:latest",
          "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs",
        ],
        matchlockEnv(env, fixture, fake.port),
      );

      // Advisory only: the warning never changes the exit code.
      assert.equal(code, 0, `expected exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      assert.match(stderr, /warning\[root_usage_override\]: /);
      assert.match(stderr, /AUTHORIZED/);
      assert.doesNotMatch(stderr, /executed as root/);
      // The warning is a bounded one-liner on stderr, never a second
      // `matchlock:` stdout line.
      assert.equal(stdoutLines(stdout).filter((l) => l.startsWith("matchlock:")).length, 1);
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
      try { fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true }); } catch {}
    }
  });

  it("shows the resolved allow-private entries on the launch line and in --json", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();
    const fixture = writeMatchlockFixture();

    try {
      const workflowId = "res-matchlock-allow-private";
      writeWorkflow(env.homeDir, workflowId, "direct");
      fs.mkdirSync(path.join(env.homeDir, ".pi", "agent"), { recursive: true });
      // Separate workdirs so the second launch is not refused by the first
      // (still-registered) run holding the same harness workdir.
      const jsonWorkDir = path.join(fixture.fixtureRoot, "work-json");
      fs.mkdirSync(jsonWorkDir, { recursive: true });
      await Promise.all(env.portHandles.map((h) => h.close()));

      const baseArgs = [
        "workflow",
        "run",
        workflowId,
        "Matchlock allow-private",
        "--matchlock-image",
        "vic/matchlock-base:latest",
        "--matchlock-cpus",
        "2",
        "--matchlock-memory",
        "2048",
        "--matchlock-disk",
        "10240",
        "--matchlock-allow-private",
        "192.168.107.74:8888",
        "--matchlock-allow-private",
        "box.internal",
      ];
      // US-008: an allow-private run probes the resolved matchlock binary for
      // --allow-private support BEFORE the image resolve. The fake rpc driver
      // doubles as that stand-in CLI (it answers `run --help` with the flag),
      // so no real matchlock binary is needed here.
      const allowPrivateEnv = { TAMANDUA_MATCHLOCK_RPC_BIN: fixture.driver };

      const text = await runCliToExit(
        [...baseArgs, "--working-directory-for-harness", fixture.workDir],
        matchlockEnv(env, fixture, fake.port, allowPrivateEnv),
      );
      assert.equal(text.code, 0, `expected exit 0, got ${text.code}\nstdout:\n${text.stdout}\nstderr:\n${text.stderr}`);
      const matchlockLines = stdoutLines(text.stdout).filter((l) => l.startsWith("matchlock:"));
      assert.deepEqual(
        matchlockLines,
        [
          "matchlock: vic/matchlock-base:latest cpus=2 memory=2048MB disk=10240MB swap=8192MB allow-private=192.168.107.74:8888,box.internal",
        ],
        `launch line must carry the resolved allow-private entries:\n${text.stdout}`,
      );

      const json = await runCliToExit(
        [...baseArgs, "--working-directory-for-harness", jsonWorkDir, "--json"],
        matchlockEnv(env, fixture, fake.port, allowPrivateEnv),
      );
      assert.equal(json.code, 0, `expected exit 0, got ${json.code}\nstdout:\n${json.stdout}\nstderr:\n${json.stderr}`);
      const parsed = JSON.parse(json.stdout.trim());
      const expected = {
        image: "vic/matchlock-base:latest",
        imageSource: "explicit",
        cpus: 2,
        memoryMB: 2048,
        diskSizeMB: 10240,
        swapMB: 8192,
        imageDigest: `sha256:${"a".repeat(64)}`,
        imageConfigDigest: `sha256:${"b".repeat(64)}`,
        allowPrivate: ["192.168.107.74:8888", "box.internal"],
      };
      assert.deepEqual(
        parsed.resolution.matchlockResources,
        expected,
        `--json resolution must carry the resolved allow-private entries:\n${json.stdout}`,
      );
      assert.deepEqual(
        parsed.matchlockResources,
        expected,
        `--json top-level matchlockResources must mirror the entries:\n${json.stdout}`,
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
      try { fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true }); } catch {}
    }
  });

  it("a native run prints no matchlock line and its --json resolution stays unchanged", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();

    try {
      const workflowId = "res-native-no-matchlock";
      writeWorkflow(env.homeDir, workflowId, "direct");
      const harnessDir = path.join(env.root, "workdir-native-us005");
      initGitRepo(harnessDir);
      await Promise.all(env.portHandles.map((h) => h.close()));

      const text = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Native launch",
          "--working-directory-for-harness",
          harnessDir,
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(fake.port) },
      );
      assert.equal(text.code, 0, `expected exit 0, got ${text.code}\nstdout:\n${text.stdout}\nstderr:\n${text.stderr}`);
      assert.ok(
        !text.stdout.includes("matchlock:"),
        `native run must print no matchlock line:\n${text.stdout}`,
      );
      assert.ok(
        !text.stdout.includes("matchlock pinned:"),
        `native run must print no pinned line:\n${text.stdout}`,
      );

      const json = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Native JSON launch",
          "--working-directory-for-harness",
          harnessDir,
          "--json",
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(fake.port) },
      );
      assert.equal(json.code, 0, `expected exit 0, got ${json.code}\nstdout:\n${json.stdout}\nstderr:\n${json.stderr}`);
      const parsed = JSON.parse(json.stdout.trim());
      assert.equal(parsed.resolution.matchlockResources, undefined);
      assert.equal(parsed.resolution.workspaceMode, "direct");
      assert.equal(parsed.resolution.workingDirectory, path.resolve(harnessDir));
      assert.ok(
        !("matchlockResources" in parsed),
        `native --json document must not carry a top-level matchlockResources:\n${json.stdout}`,
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

  // MTLK-ISO-SLICE1 US-008: the CLI launch path resolves the swap size through
  // the shared resolver (flag > env > default; --matchlock-no-swap wins) and
  // hands it to run creation, where admission persists it on the run's v3
  // policy. An invalid value exits non-zero BEFORE runWorkflow creates a row
  // (pinned in tests/cli-workflow-run-working-directory.test.ts).
  it("resolves the swap size (default/flag/no-swap/env) before run creation and persists it (US-008)", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();
    const fixture = writeMatchlockFixture();

    try {
      const workflowId = "res-mtlk-swap";
      writeWorkflow(env.homeDir, workflowId, "direct");
      fs.mkdirSync(path.join(env.homeDir, ".pi", "agent"), { recursive: true });
      await Promise.all(env.portHandles.map((h) => h.close()));

      const cases: Array<{
        name: string;
        flagArgs: string[];
        extraEnv: Record<string, string>;
        expectedSwapMB: number;
      }> = [
        { name: "default", flagArgs: [], extraEnv: {}, expectedSwapMB: 8192 },
        { name: "flag-size", flagArgs: ["--matchlock-swap", "32g"], extraEnv: {}, expectedSwapMB: 32768 },
        { name: "flag-equals", flagArgs: ["--matchlock-swap=4096"], extraEnv: {}, expectedSwapMB: 4096 },
        { name: "no-swap", flagArgs: ["--matchlock-no-swap"], extraEnv: {}, expectedSwapMB: 0 },
        { name: "env-size", flagArgs: [], extraEnv: { TAMANDUA_MATCHLOCK_SWAP_MB: "16384" }, expectedSwapMB: 16384 },
        { name: "env-off", flagArgs: [], extraEnv: { TAMANDUA_MATCHLOCK_SWAP_MB: "off" }, expectedSwapMB: 0 },
        {
          name: "flag-beats-env",
          flagArgs: ["--matchlock-swap", "2048"],
          extraEnv: { TAMANDUA_MATCHLOCK_SWAP_MB: "16384" },
          expectedSwapMB: 2048,
        },
        {
          name: "no-swap-beats-env",
          flagArgs: ["--matchlock-no-swap"],
          extraEnv: { TAMANDUA_MATCHLOCK_SWAP_MB: "16384" },
          expectedSwapMB: 0,
        },
      ];

      for (const c of cases) {
        const workDir = path.join(fixture.fixtureRoot, `work-${c.name}`);
        fs.mkdirSync(workDir, { recursive: true });
        const { stdout, stderr, code } = await runCliToExit(
          [
            "workflow",
            "run",
            workflowId,
            `Swap ${c.name}`,
            "--working-directory-for-harness",
            workDir,
            "--matchlock-image",
            "vic/matchlock-base:latest",
            ...c.flagArgs,
          ],
          matchlockEnv(env, fixture, fake.port, c.extraEnv),
        );
        assert.equal(
          code,
          0,
          `case ${c.name}: expected exit 0, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
        assert.equal(
          readPersistedSwapMB(env.tamanduaDir),
          c.expectedSwapMB,
          `case ${c.name}: the resolved swap size must reach the persisted policy`,
        );
      }
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
      try { fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true }); } catch {}
    }
  });

  // MTLK-ISO-SLICE2 US-011: the shared output contract renders the resolved
  // swap size on the single combined line and reports the admitted pin on its
  // own `matchlock pinned:` line (distinct prefix) AFTER admission succeeds.
  // --json folds provenance + swap into matchlockResources and stays a single
  // document (no text pin line).
  it("renders swap= and the pinned line for a swap-flag opt-in (US-011)", async () => {
    const env = await createTempEnv();
    const fake = await startFakeControlPlane();
    const fixture = writeMatchlockFixture();

    try {
      const workflowId = "res-mtlk-output";
      writeWorkflow(env.homeDir, workflowId, "direct");
      fs.mkdirSync(path.join(env.homeDir, ".pi", "agent"), { recursive: true });
      const jsonWorkDir = path.join(fixture.fixtureRoot, "work-json-out");
      fs.mkdirSync(jsonWorkDir, { recursive: true });
      await Promise.all(env.portHandles.map((h) => h.close()));

      const baseArgs = [
        "workflow",
        "run",
        workflowId,
        "Output contract",
        "--matchlock-image",
        "vic/matchlock-base:latest",
        "--matchlock-cpus",
        "2",
        "--matchlock-memory",
        "2048",
        "--matchlock-disk",
        "10240",
        "--matchlock-swap",
        "32g",
      ];

      const text = await runCliToExit(
        [...baseArgs, "--working-directory-for-harness", fixture.workDir],
        matchlockEnv(env, fixture, fake.port),
      );
      assert.equal(text.code, 0, `expected exit 0, got ${text.code}\nstdout:\n${text.stdout}\nstderr:\n${text.stderr}`);
      assert.deepEqual(
        stdoutLines(text.stdout).filter((l) => l.startsWith("matchlock:")),
        [
          "matchlock: vic/matchlock-base:latest cpus=2 memory=2048MB disk=10240MB swap=32768MB",
        ],
        `the launch text must carry the resolved swap size:\n${text.stdout}`,
      );
      const pinnedLines = stdoutLines(text.stdout).filter((l) =>
        l.startsWith("matchlock pinned:"),
      );
      assert.deepEqual(
        pinnedLines,
        [
          `matchlock pinned: digest=sha256:${"a".repeat(64)} config=sha256:${"b".repeat(64)}`,
        ],
        `the admitted pin must be reported once after admission:\n${text.stdout}`,
      );

      const json = await runCliToExit(
        [...baseArgs, "--working-directory-for-harness", jsonWorkDir, "--json"],
        matchlockEnv(env, fixture, fake.port),
      );
      assert.equal(json.code, 0, `expected exit 0, got ${json.code}\nstdout:\n${json.stdout}\nstderr:\n${json.stderr}`);
      const parsed = JSON.parse(json.stdout.trim());
      const expected = {
        image: "vic/matchlock-base:latest",
        imageSource: "explicit",
        cpus: 2,
        memoryMB: 2048,
        diskSizeMB: 10240,
        swapMB: 32768,
        imageDigest: `sha256:${"a".repeat(64)}`,
        imageConfigDigest: `sha256:${"b".repeat(64)}`,
      };
      assert.deepEqual(parsed.resolution.matchlockResources, expected);
      assert.deepEqual(parsed.matchlockResources, expected);
      assert.ok(
        !json.stdout.includes("matchlock pinned:"),
        `--json must stay a single document (no text pin line):\n${json.stdout}`,
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
      try { fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true }); } catch {}
    }
  });
});

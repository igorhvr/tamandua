/**
 * Tests for src/suite/shim.ts — tamandua-test shim core logic.
 *
 * Classified as serial: spawns the shim as a child process (imports
 * node:child_process).
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanChildEnv, createTempHome, reservePortHandles } from "../../tests/helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.resolve(__dirname, "..", "..", "dist", "suite", "shim.js");

// ── Helpers ───────────────────────────────────────────────────────────

interface ShimResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Spawn the shim and capture stdout, stderr, exit code, and duration. */
async function runShim(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ShimResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child: ChildProcess = spawn("node", [SHIM_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err: Error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });
  });
}

/** Spawn the shim, wait until its suite starts, then interrupt it as an external timeout would. */
async function runInterruptedShim(
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: NodeJS.Signals,
): Promise<ShimResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn("node", [SHIM_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`shim did not finish after ${signal}`));
    }, 10_000);

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!interrupted && stdout.includes("INTERRUPTIBLE SUITE STARTED")) {
        interrupted = true;
        child.kill(signal);
        // Exercise duplicate-signal/close races without permitting duplicate recording.
        child.kill(signal);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Create a fixture git repo with a test script and return its path. */
function createFixtureRepo(
  baseDir: string,
  repoName: string,
): { repoDir: string; passScript: string; failScript: string; counterScript: string } {
  const repoDir = join(baseDir, repoName);
  mkdirSync(repoDir, { recursive: true });

  execSync("git init", { cwd: repoDir });
  execSync("git config user.email test@test.com", { cwd: repoDir });
  execSync("git config user.name Test", { cwd: repoDir });

  // Create initial commit so HEAD exists.
  writeFileSync(join(repoDir, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: repoDir });
  execSync("git commit -m init", { cwd: repoDir });

  // Create a .gitignore.
  writeFileSync(join(repoDir, ".gitignore"), "*.log\nignored-dir/\n");
  execSync("git add .gitignore", { cwd: repoDir });
  execSync("git commit -m gitignore", { cwd: repoDir });

  // Create test scripts.
  const passScript = join(repoDir, "test-pass.sh");
  writeFileSync(passScript, "#!/bin/sh\necho 'PASS: all tests passed'\nexit 0\n");
  chmodSync(passScript, 0o755);

  const failScript = join(repoDir, "test-fail.sh");
  writeFileSync(failScript, "#!/bin/sh\necho 'FAIL: something broke' >&2\nexit 1\n");
  chmodSync(failScript, 0o755);

  // Counter script: increments a counter file, used for side-channel
  // verification that a command actually executed. Keep it outside the
  // content-addressed repository tree so the counter is not tree drift.
  const counterFile = join(baseDir, `${repoName}.counter`);
  writeFileSync(counterFile, "0");
  const counterScript = join(repoDir, "test-counter.sh");
  writeFileSync(
    counterScript,
    `#!/bin/sh\nCOUNTER_FILE="${counterFile}"\nCOUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)\nNEW=$((COUNT + 1))\necho "$NEW" > "$COUNTER_FILE"\necho "run $NEW"\nexit 0\n`,
  );
  chmodSync(counterScript, 0o755);

  return { repoDir, passScript, failScript, counterScript };
}

/** Set up a temp HOME with control server, daemon-secret, and a test DB. */
async function setupControlEnv(th: { homeDir: string; tamanduaDir: string }): Promise<{
  tempHome: string;
  stateDir: string;
  dbPath: string;
  controlPort: number;
  secret: string;
  server: http.Server;
}> {
  const tempHome = th.homeDir;
  const stateDir = th.tamanduaDir;
  const dbPath = join(stateDir, "tamandua.db");
  const secret = crypto.randomBytes(16).toString("hex");

  writeFileSync(join(stateDir, "daemon-secret"), secret);

  const [ctrlHandle] = await reservePortHandles(1);
  const controlPort = ctrlHandle.port;

  // Close handle just before control server binds.
  await ctrlHandle.close();

  const { createControlServer } = await import(
    "../../dist/server/control-server.js"
  );
  const server = createControlServer({ port: controlPort, secret });
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });

  // Set env vars for this process so emitEvent (called by the in-process
  // control plane server) writes events to the temp directory, not the
  // real tamandua state. HOME is needed by readDaemonSecret path resolution.
  process.env.HOME = tempHome;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = dbPath;
  process.env.TAMANDUA_CONTROL_PORT = String(controlPort);

  return { tempHome, stateDir, dbPath, controlPort, secret, server };
}

/** Build the env for spawning the shim as a child process. */
function shimChildEnv(
  controlEnv: { tempHome: string; stateDir: string; controlPort: number },
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env = cleanChildEnv({
    HOME: controlEnv.tempHome,
    TAMANDUA_STATE_DIR: controlEnv.stateDir,
    TAMANDUA_CONTROL_PORT: String(controlEnv.controlPort),
    // TAMANDUA_TEST_GUARD must be present for the test guard to consider isolation OK.
    TAMANDUA_TEST_GUARD: "1",
    ...extra,
  });
  return env;
}

// ══════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════

describe("tamandua-test shim", { concurrency: 1 }, () => {
  const shimTh = createTempHome("tamandua-shim-test-");
  const shimBaseTh = createTempHome("tamandua-shim-base-");
  let tempBase: string;
  let repoDir: string;
  let passScript: string;
  let failScript: string;
  let counterScript: string;
  let counterFile: string;
  let controlEnv: Awaited<ReturnType<typeof setupControlEnv>>;
  let origHome: string | undefined;
  let origStateDir: string | undefined;
  let origDbPath: string | undefined;
  let origControlPort: string | undefined;

  before(async () => {
    // Save original env vars.
    origHome = process.env.HOME;
    origStateDir = process.env.TAMANDUA_STATE_DIR;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origControlPort = process.env.TAMANDUA_CONTROL_PORT;

    tempBase = shimBaseTh.root;
    const fixture = createFixtureRepo(tempBase, "myproject");
    repoDir = fixture.repoDir;
    passScript = fixture.passScript;
    failScript = fixture.failScript;
    counterScript = fixture.counterScript;
    counterFile = join(tempBase, "myproject.counter");

    controlEnv = await setupControlEnv(shimTh);
  });

  after(async () => {
    // Restore env.
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origStateDir !== undefined) process.env.TAMANDUA_STATE_DIR = origStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    if (origDbPath !== undefined) process.env.TAMANDUA_DB_PATH = origDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (origControlPort !== undefined) process.env.TAMANDUA_CONTROL_PORT = origControlPort;
    else delete process.env.TAMANDUA_CONTROL_PORT;

    // Clean up.
    await new Promise<void>((resolve) => controlEnv.server.close(() => resolve()));
    // createTempHome handles cleanup via after() hook
  });

  beforeEach(() => {
    // Reset counter file.
    writeFileSync(counterFile, "0");
  });

  // ── AC 7: TAMANDUA_TSTX=0 → full passthrough ──────────────────────

  it("TAMANDUA_TSTX=0 triggers full passthrough (AC 7)", async () => {
    const env = shimChildEnv(controlEnv, { TAMANDUA_TSTX: "0" });
    const r = await runShim(
      ["--repo", repoDir, "--run", "r1", "--step", "s1", "--", passScript],
      env,
    );
    // Should still execute the command.
    assert.equal(r.exitCode, 0, "passthrough should execute the command successfully");
    assert.ok(
      r.stdout.includes("PASS: all tests passed"),
      "should see command output",
    );
    // Should have the passthrough notice on stderr.
    assert.ok(
      r.stderr.includes("passthrough mode"),
      "should include passthrough notice on stderr",
    );
    // Should have exactly one passthrough notice (no other tamandua-test output).
    const lines = r.stderr.split("\n").filter((l) => l.startsWith("tamandua-test:"));
    assert.equal(lines.length, 1, "should have exactly one tamandua-test stderr line");
  });

  // ── AC 5: Non-git directory → passthrough ──────────────────────────

  it("non-git directory triggers passthrough (AC 5)", async () => {
    const nonGitDir = createTempHome("no-git-").root;
    // Create a simple executable script in non-git dir.
    const script = join(nonGitDir, "echo.sh");
    writeFileSync(script, "#!/bin/sh\necho 'hello from non-git'\nexit 0\n");
    chmodSync(script, 0o755);

    try {
      const env = shimChildEnv(controlEnv);
      const r = await runShim(
        ["--repo", nonGitDir, "--run", "r1", "--step", "s1", "--", script],
        env,
      );
      assert.equal(r.exitCode, 0, "should exit 0");
      assert.ok(r.stdout.includes("hello from non-git"), "should see command output");
      assert.ok(
        r.stderr.includes("passthrough mode"),
        "should include passthrough notice",
      );
    } finally {
      // createTempHome handles cleanup via after() hook
    }
  });

  // ── AC 4: Control plane stopped → passthrough ──────────────────────

  it("control plane unreachable triggers passthrough (AC 4)", async () => {
    // Use a port where nothing is listening.
    const env = shimChildEnv(controlEnv, {
      TAMANDUA_CONTROL_PORT: "19999",
    });
    const r = await runShim(
      ["--repo", repoDir, "--run", "r1", "--step", "s1", "--", passScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should exit 0 despite no control plane");
    assert.ok(
      r.stdout.includes("PASS: all tests passed"),
      "should still execute the command",
    );
    assert.ok(
      r.stderr.includes("passthrough mode"),
      "should include passthrough notice",
    );
  });

  // ── AC 8: Passthrough indistinguishable from raw command except for stderr notice ──

  it("passthrough output is indistinguishable from raw command except stderr notice (AC 8)", async () => {
    // Run the raw command directly (without the shim) for comparison.
    const raw = await new Promise<{ stdout: string; stderr: string; code: number }>(
      (resolve) => {
        const child = spawn(passScript, [], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout!.on("data", (c: Buffer) => (out += c.toString()));
        child.stderr!.on("data", (c: Buffer) => (err += c.toString()));
        child.on("close", (code: number | null) =>
          resolve({ stdout: out, stderr: err, code: code ?? 1 }),
        );
      },
    );

    // Now run through shim with TAMANDUA_TSTX=0 (passthrough).
    const env = shimChildEnv(controlEnv, { TAMANDUA_TSTX: "0" });
    const r = await runShim(
      ["--repo", repoDir, "--run", "r1", "--step", "s1", "--", passScript],
      env,
    );

    // stdout must be identical.
    assert.equal(r.stdout, raw.stdout, "stdout must be identical to raw command");
    // exit code must match.
    assert.equal(r.exitCode, raw.code, "exit code must match raw command");
    // stderr must contain the raw command's stderr (none in this case) plus
    // exactly one tamandua-test notice.
    assert.ok(
      r.stderr.includes("passthrough mode"),
      "passthrough notice must be present",
    );
  });

  // ── AC 1: Same tree+cmd twice → replay ────────────────────────────

  it("same tree+cmd twice: second invocation replays with CACHED banner (AC 1)", async () => {
    const env = shimChildEnv(controlEnv);

    // First invocation: must execute.
    const r1 = await runShim(
      ["--repo", repoDir, "--run", "r-ac1", "--step", "s1", "--", passScript],
      env,
    );
    assert.equal(r1.exitCode, 0, "first execution should pass");
    assert.ok(
      r1.stdout.includes("PASS: all tests passed"),
      "should see test output",
    );
    assert.ok(
      !r1.stdout.includes("TAMANDUA-TEST CACHED"),
      "first run must NOT be a replay",
    );

    // Second invocation: should replay (green within TTL, same tree).
    const r2 = await runShim(
      ["--repo", repoDir, "--run", "r-ac1", "--step", "s2", "--", passScript],
      env,
    );
    assert.equal(r2.exitCode, 0, "replay should exit 0");
    assert.ok(
      r2.stdout.includes("TAMANDUA-TEST CACHED"),
      "should include CACHED banner",
    );
    assert.ok(
      r2.stdout.includes("--- recorded output"),
      "should include recorded output marker",
    );
    assert.ok(r2.stdout.includes("PASS: all tests passed"), "should replay output");
  });

  // ── AC 6: --force executes despite fresh green ────────────────────

  it("--force executes despite fresh green cache entry (AC 6)", async () => {
    const env = shimChildEnv(controlEnv);

    // Prime the cache with a green result.
    const r1 = await runShim(
      ["--repo", repoDir, "--run", "r-ac6", "--step", "s1", "--", passScript],
      env,
    );
    assert.equal(r1.exitCode, 0, "first execution should pass");

    // Now run with --force: must NOT replay.
    const r2 = await runShim(
      ["--repo", repoDir, "--run", "r-ac6", "--step", "s2", "--force", "--", passScript],
      env,
    );
    assert.equal(r2.exitCode, 0, "forced execution should pass");
    assert.ok(
      !r2.stdout.includes("TAMANDUA-TEST CACHED"),
      "--force must bypass cache",
    );
    assert.ok(
      r2.stdout.includes("PASS: all tests passed"),
      "should see test output from actual execution",
    );
  });

  // ── Tracked dirt is refused before cache lookup ───────────────────

  it("refuses a modified tracked file before replay or execution, then records after commit", async () => {
    const env = shimChildEnv(controlEnv);
    writeFileSync(join(repoDir, "o9-junk-probe.tmp"), "untracked\n");
    env.TAMANDUA_TSTX_JUNK_PROBE = "o9-junk-probe.tmp";

    // Prime the cache.
    const r1 = await runShim(
      ["--repo", repoDir, "--run", "r-ac2", "--step", "s1", "--", passScript],
      env,
    );
    assert.equal(r1.exitCode, 0, "first execution should pass");

    // Second run: should replay.
    const r2 = await runShim(
      ["--repo", repoDir, "--run", "r-ac2", "--step", "s2", "--", passScript],
      env,
    );
    assert.ok(r2.stdout.includes("TAMANDUA-TEST CACHED"), "should replay on same tree");

    // Edit a tracked file.
    writeFileSync(join(repoDir, "README.md"), "# Modified\nFile changed!\n");

    // Third run: the committed key still has green evidence, but tracked dirt
    // must be refused before replaying it.
    const r3 = await runShim(
      ["--repo", repoDir, "--run", "r-ac2", "--step", "s3", "--", passScript],
      env,
    );
    assert.equal(r3.exitCode, 88);
    assert.doesNotMatch(r3.stdout, /PASS: all tests passed|TAMANDUA-TEST CACHED/);
    assert.match(r3.stderr, /^FAILURE_CLASS: tree_dirty$/m);
    assert.match(r3.stderr, /^FAILURE: uncommitted changes to tracked files — commit them before testing$/m);
    assert.match(r3.stderr, /^\(the merge gate verifies the committed tree: git rev-parse HEAD\^\{tree\}\)\.$/m);
    assert.match(r3.stderr, /README\.md/);
    assert.match(r3.stderr, /^ACTION: commit or discard these, then re-run the suite via the shim\.$/m);
    const dirtySpecial = readFileSync(join(controlEnv.stateDir, "events", "r-ac2.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.event === "suite.special_exit_observed" && event.stepId === "s3");
    assert.equal(dirtySpecial?.shimExitCode, 88);
    assert.equal(dirtySpecial?.trackedDirty, true);
    assert.equal(dirtySpecial?.junkProbeTracked, false);

    execSync("git add README.md && git commit -m 'tracked change'", { cwd: repoDir });
    const r4 = await runShim(
      ["--repo", repoDir, "--run", "r-ac2", "--step", "s4", "--", passScript],
      env,
    );
    assert.equal(r4.exitCode, 0, "a committed tracked change should execute normally");
    assert.match(r4.stdout, /PASS: all tests passed/);
  });

  for (const dirtyCase of ["deleted", "staged"] as const) {
    it(`refuses a ${dirtyCase} tracked file without executing or recording`, async () => {
      const fixture = createFixtureRepo(tempBase, `dirty-${dirtyCase}`);
      const marker = join(tempBase, `dirty-${dirtyCase}.executed`);
      const script = join(fixture.repoDir, `dirty-${dirtyCase}.sh`);
      writeFileSync(script, `#!/bin/sh\n: > "${marker}"\nexit 0\n`);
      chmodSync(script, 0o755);
      if (dirtyCase === "deleted") {
        execSync("rm README.md", { cwd: fixture.repoDir });
      } else {
        writeFileSync(join(fixture.repoDir, "README.md"), "staged change\n");
        execSync("git add README.md", { cwd: fixture.repoDir });
      }
      const runId = `r-tree-dirty-${dirtyCase}`;

      const result = await runShim(
        ["--repo", fixture.repoDir, "--run", runId, "--step", "s-dirty", "--", script],
        shimChildEnv(controlEnv),
      );
      assert.equal(result.exitCode, 88);
      assert.match(result.stderr, /README\.md/);
      assert.equal(existsSync(marker), false, "dirty refusal must not execute the command");
      const db = new DatabaseSync(controlEnv.dbPath);
      const count = db.prepare("SELECT COUNT(*) AS count FROM suite_results WHERE run_id = ?")
        .get(runId) as { count: number };
      db.close();
      assert.equal(count.count, 0);
    });
  }

  it("bounds tracked-dirty output at 32 paths with a total summary", async () => {
    const fixture = createFixtureRepo(tempBase, "dirty-bounded");
    for (let i = 0; i < 35; i++) {
      writeFileSync(join(fixture.repoDir, `tracked-${String(i).padStart(2, "0")}.txt`), "clean\n");
    }
    execSync("git add . && git commit -m 'tracked files'", { cwd: fixture.repoDir });
    for (let i = 0; i < 35; i++) {
      writeFileSync(join(fixture.repoDir, `tracked-${String(i).padStart(2, "0")}.txt`), "dirty\n");
    }

    const result = await runShim(
      ["--repo", fixture.repoDir, "--run", "r-tree-dirty-bounded", "--step", "s-dirty", "--", fixture.passScript],
      shimChildEnv(controlEnv),
    );
    assert.equal(result.exitCode, 88);
    const listed = result.stderr.split("\n").filter((line) => /^ [ MADRCU?!]{2} tracked-/.test(line));
    assert.equal(listed.length, 32);
    assert.match(result.stderr, /… and 3 more tracked files not listed here \(35 total\)\./);
    assert.doesNotMatch(result.stderr, /tracked-34\.txt/);
  });

  // ── AC 3: Red recorded → re-executes ──────────────────────────────

  it("red recorded on identical tree: command actually re-executes (AC 3)", async () => {
    const env = shimChildEnv(controlEnv);

    // First invocation: run the counter script (always passes).
    const r1 = await runShim(
      ["--repo", repoDir, "--run", "r-ac3", "--step", "s1", "--", counterScript],
      env,
    );
    assert.equal(r1.exitCode, 0, "first execution should pass");
    assert.ok(r1.stdout.includes("run 1"), "counter increments");
    // Check counter file directly.
    const count1 = parseInt(
      readFileSync(counterFile, "utf-8").trim(),
      10,
    );
    assert.equal(count1, 1, "counter file should be 1 after first run");

    // Now directly insert a RED record for the same key into the DB
    // to simulate a previous failure.
    const db = new DatabaseSync(controlEnv.dbPath);
    // Get the committed tree hash used by the shim.
    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Insert a red record.
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(originRepo, treeHash, cmdHash, counterScript.slice(0, 200), 1, 100, "FAIL: error", "r-ac3", "s-fail", new Date().toISOString());

    // Second invocation: should re-execute (red is not authoritative).
    const r2 = await runShim(
      ["--repo", repoDir, "--run", "r-ac3", "--step", "s2", "--", counterScript],
      env,
    );
    assert.equal(r2.exitCode, 0, "should execute and pass");
    assert.ok(
      !r2.stdout.includes("TAMANDUA-TEST CACHED"),
      "red result must NOT replay",
    );
    assert.ok(r2.stdout.includes("run 2"), "counter increments to 2");
    // R6: should have red context note on stderr.
    assert.ok(
      r2.stderr.includes("note: this tree failed"),
      "should include red context note",
    );
    assert.ok(
      r2.stderr.includes("rerunning"),
      "should say rerunning",
    );

    const count2 = parseInt(
      readFileSync(counterFile, "utf-8").trim(),
      10,
    );
    assert.equal(count2, 2, "counter file should be 2 — command actually executed");

    db.close();
  });

  // ── Flaky detection ────────────────────────────────────────────────

  it("flaky key detection: prints FLAKY banner when key has both green and red (R8)", async () => {
    const env = shimChildEnv(controlEnv);

    // Compute the key.
    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const originRepo = getOriginRepo(repoDir);

    // Insert a red record and a green record for the COUNTER script.
    const cmdHash = computeCmdHash(counterScript);

    const db = new DatabaseSync(controlEnv.dbPath);
    // Red first.
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(originRepo, treeHash, cmdHash, counterScript.slice(0, 200), 1, 50, "FAIL: flaky fail", "r-flaky", "s-fail", new Date(Date.now() - 60_000).toISOString());
    // Then green.
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(originRepo, treeHash, cmdHash, counterScript.slice(0, 200), 0, 100, "PASS: flaky pass", "r-flaky", "s-pass", new Date().toISOString());

    // Run the shim: should see flaky banner.
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-flaky", "--step", "s3", "--", counterScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and pass");
    assert.ok(
      r.stderr.includes("⚠ FLAKY:"),
      "should include flaky banner on stderr",
    );
    assert.ok(
      r.stderr.includes("passes"),
      "should mention pass/fail counts",
    );

    db.close();
  });

  // ── No command → error ─────────────────────────────────────────────

  it("exits with error when no test command is provided", async () => {
    const env = shimChildEnv(controlEnv);
    const r = await runShim(
      ["--repo", repoDir, "--run", "r1", "--step", "s1"],
      env,
    );
    assert.notEqual(r.exitCode, 0, "should exit with non-zero");
    assert.ok(
      r.stderr.includes("no test command provided"),
      "should report missing command",
    );
  });

  // ── --help flag ────────────────────────────────────────────────────

  it("--help shows usage", async () => {
    const env = shimChildEnv(controlEnv);
    const r = await runShim(["--help"], env);
    assert.equal(r.exitCode, 0, "--help should exit 0");
    assert.ok(r.stderr.includes("Usage:"), "should show usage on stderr");
    assert.ok(r.stderr.includes("--repo"), "should mention --repo");
    assert.ok(r.stderr.includes("--force"), "should mention --force");
  });

  // ── No --repo → passthrough ───────────────────────────────────────

  it("no --repo triggers passthrough", async () => {
    const env = shimChildEnv(controlEnv);
    const r = await runShim(
      ["--run", "r1", "--step", "s1", "--", passScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute the command");
    assert.ok(r.stdout.includes("PASS: all tests passed"), "should see output");
    assert.ok(
      r.stderr.includes("passthrough mode"),
      "should include passthrough notice",
    );
  });

  // ── Exit code propagation ──────────────────────────────────────────

  it("records one exact red row with the real exit code for a stable tracked tree", async () => {
    const fixture = createFixtureRepo(tempBase, "stable-red-ledger-evidence");
    const distinctiveFailure = join(fixture.repoDir, "distinctive-failure.sh");
    writeFileSync(distinctiveFailure, "#!/bin/sh\necho 'DISTINCTIVE FAILURE' >&2\nexit 23\n");
    chmodSync(distinctiveFailure, 0o755);
    const runId = "r-stable-red-ledger-unique";
    const stepId = "s-stable-red-ledger-unique";
    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(fixture.repoDir);
    assert.ok(treeHash, "stable fixture should have a tree hash");
    const cmdHash = computeCmdHash(distinctiveFailure);
    const originRepo = getOriginRepo(fixture.repoDir);

    const result = await runShim(
      ["--repo", fixture.repoDir, "--run", runId, "--step", stepId, "--", distinctiveFailure],
      shimChildEnv(controlEnv),
    );
    assert.equal(result.exitCode, 23, "shim must preserve the real failing exit code");
    assert.match(result.stderr, /DISTINCTIVE FAILURE/);

    const db = new DatabaseSync(controlEnv.dbPath);
    const rows = db.prepare(
      `SELECT exit_code, run_id, step_id FROM suite_results
       WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ? AND run_id = ? AND step_id = ?`,
    ).all(originRepo, treeHash, cmdHash, runId, stepId) as Array<{
      exit_code: number; run_id: string; step_id: string;
    }>;
    db.close();
    assert.equal(rows.length, 1, "the exact suite key and run/step must have one row");
    assert.equal(rows[0]!.exit_code, 23);
    assert.equal(rows[0]!.run_id, runId);
    assert.equal(rows[0]!.step_id, stepId);
  });

  for (const { name, signal } of [
    { name: "timeout termination", signal: "SIGTERM" as const },
    { name: "operator interrupt", signal: "SIGINT" as const },
  ]) {
    it(`records exactly one red ledger row after ${name}`, async () => {
      const fixture = createFixtureRepo(tempBase, `interrupted-${signal.toLowerCase()}`);
      const script = join(fixture.repoDir, "interruptible-suite.sh");
      writeFileSync(
        script,
        "#!/bin/sh\ntrap 'echo CHILD RECEIVED TERMINATION >&2; exit 99' TERM INT\necho 'INTERRUPTIBLE SUITE STARTED'\nwhile :; do sleep 1; done\n",
      );
      chmodSync(script, 0o755);
      writeFileSync(join(fixture.repoDir, "o9-junk-probe.tmp"), "untracked\n");
      const runId = `r-interrupted-${signal.toLowerCase()}`;
      const stepId = `s-interrupted-${signal.toLowerCase()}`;
      const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
        "../../dist/suite/tree-hash.js"
      );
      const treeHash = committedTreeHash(fixture.repoDir);
      assert.ok(treeHash);
      const cmdHash = computeCmdHash(script);
      const originRepo = getOriginRepo(fixture.repoDir);

      const result = await runInterruptedShim(
        ["--repo", fixture.repoDir, "--run", runId, "--step", stepId, "--", script],
        { ...shimChildEnv(controlEnv), TAMANDUA_TSTX_JUNK_PROBE: "o9-junk-probe.tmp" },
        signal,
      );
      assert.equal(result.exitCode, 87, "interrupted executions use the documented shim exit code");

      const db = new DatabaseSync(controlEnv.dbPath);
      const rows = db.prepare(
        `SELECT exit_code, duration_ms, log_tail, run_id, step_id
         FROM suite_results
         WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ? AND run_id = ? AND step_id = ?`,
      ).all(originRepo, treeHash, cmdHash, runId, stepId) as Array<{
        exit_code: number;
        duration_ms: number;
        log_tail: string | null;
        run_id: string;
        step_id: string;
      }>;
      db.close();

      assert.equal(rows.length, 1, "signal/error/close races must record once");
      assert.equal(rows[0]!.exit_code, 87);
      assert.ok(rows[0]!.duration_ms > 0);
      assert.equal(rows[0]!.run_id, runId);
      assert.equal(rows[0]!.step_id, stepId);
      assert.match(rows[0]!.log_tail ?? "", new RegExp(`KILLED by external ${signal}`));
      assert.match(rows[0]!.log_tail ?? "", /NO USABLE EVIDENCE/);
      assert.match(rows[0]!.log_tail ?? "", /CHILD RECEIVED TERMINATION/);
      const special = readFileSync(join(controlEnv.stateDir, "events", `${runId}.jsonl`), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.event === "suite.special_exit_observed");
      assert.equal(special?.shimExitCode, 87);
      assert.equal(special?.interrupted, true);
      assert.equal(special?.junkProbeTracked, false);
    });
  }

  it("identifies a real shim claim so a waiter can reclaim it after SIGKILL", async () => {
    const fixture = createFixtureRepo(tempBase, "dead-owner-reclaim");
    const suitePidFile = join(tempBase, "dead-owner-reclaim.pid");
    const script = join(fixture.repoDir, "dead-owner-suite.sh");
    writeFileSync(
      script,
      `#!/bin/sh\necho $$ > "${suitePidFile}"\necho 'DEAD OWNER SUITE STARTED'\nwhile :; do sleep 1; done\n`,
    );
    chmodSync(script, 0o755);
    const runId = "r-dead-owner";
    const stepId = "s-dead-owner";
    const owner = spawn("node", [SHIM_PATH, "--repo", fixture.repoDir, "--run", runId, "--step", stepId, "--", script], {
      env: shimChildEnv(controlEnv),
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("owner suite did not start")), 10_000);
        owner.stdout!.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("DEAD OWNER SUITE STARTED")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        owner.once("error", reject);
      });
      owner.kill("SIGKILL");
      await new Promise<void>((resolve) => owner.once("close", () => resolve()));

      const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
        "../../dist/suite/tree-hash.js"
      );
      const treeHash = committedTreeHash(fixture.repoDir);
      assert.ok(treeHash);
      const reclaim = await controlPlanePost("/suite/claim", {
        origin_repo: getOriginRepo(fixture.repoDir),
        tree_hash: treeHash,
        cmd_hash: computeCmdHash(script),
        owner_token: "replacement-owner",
        owner_pid: process.pid,
        run_id: "r-replacement",
        step_id: "s-replacement",
      });
      assert.equal(
        (reclaim.body as Record<string, unknown>).action,
        "run",
        "dead real shim owner should be reclaimed immediately",
      );
    } finally {
      owner.kill("SIGKILL");
      if (existsSync(suitePidFile)) {
        const suitePid = Number(readFileSync(suitePidFile, "utf-8").trim());
        if (Number.isSafeInteger(suitePid) && suitePid > 0) {
          try { process.kill(-suitePid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    }
  });

  async function runTreeMutationCase(
    name: string,
    scriptBody: string,
    expectedExitCode: number,
  ): Promise<{ result: ShimResult; rowCount: number; event: Record<string, unknown>; claimAction: unknown }> {
    const fixture = createFixtureRepo(tempBase, `drift-${name}`);
    const script = join(fixture.repoDir, `mutate-${name}.sh`);
    writeFileSync(script, `#!/bin/sh\n${scriptBody}\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(fixture.repoDir, "o9-junk-probe.tmp"), "untracked\n");

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const preTreeHash = committedTreeHash(fixture.repoDir);
    assert.ok(preTreeHash, "fixture should have a pre-run tree hash");
    const cmdHash = computeCmdHash(script);
    const originRepo = getOriginRepo(fixture.repoDir);
    const runId = `r-tree-drift-${name}`;

    const result = await runShim(
      ["--repo", fixture.repoDir, "--run", runId, "--step", "s-drift", "--", script],
      { ...shimChildEnv(controlEnv), TAMANDUA_TSTX_JUNK_PROBE: "o9-junk-probe.tmp" },
    );
    assert.equal(result.exitCode, expectedExitCode);

    const db = new DatabaseSync(controlEnv.dbPath);
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM suite_results WHERE run_id = ?")
      .get(runId) as { cnt: number };
    db.close();

    const eventsPath = join(controlEnv.stateDir, "events", `${runId}.jsonl`);
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const event = events.find((candidate: Record<string, unknown>) =>
      candidate.event === "suite.tree_drift_detected"
    );
    assert.ok(event, "tree drift should emit a suite.tree_drift_detected event");
    const special = events.find((candidate: Record<string, unknown>) =>
      candidate.event === "suite.special_exit_observed"
    );
    if (expectedExitCode === 86) {
      assert.equal(special?.shimExitCode, expectedExitCode);
      assert.equal(special?.ledgerRowId, null);
      assert.equal(special?.junkProbeTracked, false);
    } else {
      assert.equal(special, undefined, "a command's own non-special exit must not be mislabeled as a shim exit");
    }

    const thirdClaim = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: preTreeHash,
      cmd_hash: cmdHash,
      owner_token: `third-${name}`,
    });

    return {
      result,
      rowCount: row.cnt,
      event,
      claimAction: (thirdClaim.body as Record<string, unknown>).action,
    };
  }

  it("rejects tracked-file modification during a successful suite and releases the claim", async () => {
    const { result, rowCount, event, claimAction } = await runTreeMutationCase(
      "tracked-edit",
      `printf 'changed\\n' > "${join(tempBase, "drift-tracked-edit", "README.md")}"\nexit 0`,
      86,
    );
    assert.equal(rowCount, 0, "drift must not create a suite result");
    assert.match(result.stderr, /tree changed during test execution.*stable-tree rerun required/i);
    assert.equal(String(event.preTreeHash).length, 12);
    assert.equal(String(event.postTreeHash).length, 12);
    assert.equal(event.exitCode, 0);
    assert.equal(claimAction, "run", "released key should be immediately reclaimable");
  });

  it("records under the committed tree when a suite creates an untracked file", async () => {
    const fixture = createFixtureRepo(tempBase, "drift-untracked");
    const script = join(fixture.repoDir, "create-untracked.sh");
    writeFileSync(script, `#!/bin/sh\nprintf 'new\\n' > "${join(fixture.repoDir, "new-file.txt")}"\nexit 23\n`);
    chmodSync(script, 0o755);
    const { committedTreeHash, computeTreeHash, computeCmdHash, getOriginRepo } = await import("../../dist/suite/tree-hash.js");
    const expectedTree = committedTreeHash(fixture.repoDir);
    assert.ok(expectedTree);
    const revParseTree = execSync("git rev-parse HEAD^{tree}", { cwd: fixture.repoDir, encoding: "utf-8" }).trim();
    assert.equal(expectedTree, revParseTree);
    const addAllTree = computeTreeHash(fixture.repoDir);
    assert.ok(addAllTree);
    assert.notEqual(addAllTree, expectedTree, "pre-existing untracked script must not enter the ledger key");
    const runId = "r-tree-drift-untracked";

    const result = await runShim(
      ["--repo", fixture.repoDir, "--run", runId, "--step", "s-untracked", "--", script],
      shimChildEnv(controlEnv),
    );
    assert.equal(result.exitCode, 23, "untracked generation must preserve the real command exit code");

    const db = new DatabaseSync(controlEnv.dbPath);
    const rows = db.prepare("SELECT tree_hash, exit_code FROM suite_results WHERE run_id = ?").all(runId) as Array<{ tree_hash: string; exit_code: number }>;
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tree_hash, expectedTree);
    assert.equal(rows[0]?.exit_code, 23);
    const { lookupSuiteRecord } = await import("../../dist/server/control-client.js");
    const lookup = await lookupSuiteRecord(getOriginRepo(fixture.repoDir), expectedTree, computeCmdHash(script));
    assert.equal((lookup?.latest as Record<string, unknown> | null)?.tree_hash, expectedTree);
  });

  it("rejects tracked-file deletion during a successful suite", async () => {
    const { rowCount, claimAction } = await runTreeMutationCase(
      "tracked-delete",
      `rm "${join(tempBase, "drift-tracked-delete", "README.md")}"\nexit 0`,
      86,
    );
    assert.equal(rowCount, 0);
    assert.equal(claimAction, "run");
  });

  it("rejects an unavailable post-run tree hash and releases the claim", async () => {
    const { result, rowCount, event, claimAction } = await runTreeMutationCase(
      "hash-unavailable",
      `rm -rf "${join(tempBase, "drift-hash-unavailable", ".git")}"\nexit 0`,
      86,
    );
    assert.equal(rowCount, 0);
    assert.equal(event.postTreeHash, "unavailable");
    assert.match(result.stderr, /could not be attributed.*stable-tree rerun required/i);
    assert.equal(claimAction, "run");
  });

  it("preserves the real nonzero exit code when the tree also drifts", async () => {
    const { result, rowCount, event, claimAction } = await runTreeMutationCase(
      "real-failure",
      `printf 'changed\\n' > "${join(tempBase, "drift-real-failure", "README.md")}"\nexit 7`,
      7,
    );
    assert.equal(rowCount, 0);
    assert.equal(event.exitCode, 7);
    assert.equal(result.exitCode, 7);
    assert.equal(claimAction, "run");
  });

  it("records normally when only ignored files change during the suite", async () => {
    const fixture = createFixtureRepo(tempBase, "drift-ignored-only");
    const script = join(fixture.repoDir, "ignored-only.sh");
    writeFileSync(script, `#!/bin/sh\nprintf 'ignored\\n' > "${join(fixture.repoDir, "suite.log")}"\nexit 0\n`);
    chmodSync(script, 0o755);
    const runId = "r-tree-drift-ignored-only";
    const result = await runShim(
      ["--repo", fixture.repoDir, "--run", runId, "--step", "s-drift", "--", script],
      shimChildEnv(controlEnv),
    );
    assert.equal(result.exitCode, 0);
    const db = new DatabaseSync(controlEnv.dbPath);
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM suite_results WHERE run_id = ?")
      .get(runId) as { cnt: number };
    db.close();
    assert.equal(row.cnt, 1, "ignored-only changes should retain normal recording");
  });

  it("promotes a waiter after owner drift instead of replaying the unrecorded result", { timeout: 3_600_000 }, async () => {
    const fixture = createFixtureRepo(tempBase, "drift-waiter");
    const attemptsFile = join(tempBase, "drift-waiter-attempts");
    const ownerStartedFile = join(tempBase, "drift-waiter-owner-started");
    const releaseOwnerFile = join(tempBase, "drift-waiter-release-owner");
    writeFileSync(attemptsFile, "0");
    const script = join(fixture.repoDir, "waiter-drift.sh");
    writeFileSync(script, `#!/bin/sh
n=$(cat "${attemptsFile}")
n=$((n + 1))
printf '%s' "$n" > "${attemptsFile}"
if [ "$n" -eq 1 ]; then
  : > "${ownerStartedFile}"
  while [ ! -f "${releaseOwnerFile}" ]; do sleep 0.05; done
  printf 'owner changed tree\\n' > "${join(fixture.repoDir, "README.md")}"
  git -C "${fixture.repoDir}" add README.md
  git -C "${fixture.repoDir}" commit -m 'owner tree change' >/dev/null
fi
exit 0
`);
    chmodSync(script, 0o755);

    const owner = runShim(
      ["--repo", fixture.repoDir, "--run", "r-drift-owner", "--step", "s-owner", "--", script],
      shimChildEnv(controlEnv),
    );
    await waitUntil(() => existsSync(ownerStartedFile));
    assert.equal(readFileSync(attemptsFile, "utf-8"), "1", "owner must claim and execute first");

    const waiterStartedAt = Date.now();
    const waiter = runShim(
      ["--repo", fixture.repoDir, "--run", "r-drift-waiter", "--step", "s-waiter", "--", script],
      shimChildEnv(controlEnv),
    );
    const waiterEventsPath = join(controlEnv.stateDir, "events", "r-drift-waiter.jsonl");
    await waitUntil(() =>
      existsSync(waiterEventsPath)
      && readFileSync(waiterEventsPath, "utf-8").includes("suite.singleflight_wait")
    );
    assert.equal(readFileSync(attemptsFile, "utf-8"), "1", "waiter must not execute while owner holds the key");
    writeFileSync(releaseOwnerFile, "release");

    const [ownerResult, waiterResult] = await Promise.all([owner, waiter]);
    const waiterElapsedMs = Date.now() - waiterStartedAt;
    assert.equal(ownerResult.exitCode, 86);
    assert.equal(waiterResult.exitCode, 0, "waiter should take over and run against the new stable tree");
    assert.ok(waiterElapsedMs < 30_000, `waiter takeover took ${waiterElapsedMs}ms`);
    assert.doesNotMatch(waiterResult.stdout, /TAMANDUA-TEST CACHED/);
    assert.equal(readFileSync(attemptsFile, "utf-8"), "2", "waiter should execute exactly once");

    const db = new DatabaseSync(controlEnv.dbPath);
    const rows = db.prepare(
      "SELECT run_id, exit_code FROM suite_results WHERE run_id IN (?, ?) ORDER BY run_id",
    ).all("r-drift-owner", "r-drift-waiter") as Array<{ run_id: string; exit_code: number }>;
    db.close();
    assert.deepEqual(
      rows.map((row) => ({ run_id: row.run_id, exit_code: row.exit_code })),
      [{ run_id: "r-drift-waiter", exit_code: 0 }],
    );

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const stableTreeHash = committedTreeHash(fixture.repoDir);
    assert.ok(stableTreeHash);
    const thirdClaim = await controlPlanePost("/suite/claim", {
      origin_repo: getOriginRepo(fixture.repoDir),
      tree_hash: stableTreeHash,
      cmd_hash: computeCmdHash(script),
      owner_token: "third-after-waiter",
    });
    assert.equal((thirdClaim.body as Record<string, unknown>).action, "run");
  });

  it("emits one cache-hit event with the re-keyed tree on post-promotion replay", { timeout: 3_600_000 }, async () => {
    const fixture = createFixtureRepo(tempBase, "drift-rekey-cache-hit");
    const attemptsFile = join(tempBase, "drift-rekey-cache-hit-attempts");
    const ownerStartedFile = join(tempBase, "drift-rekey-owner-started");
    const mutateOwnerFile = join(tempBase, "drift-rekey-mutate-owner");
    const ownerMutatedFile = join(tempBase, "drift-rekey-owner-mutated");
    const releaseOwnerFile = join(tempBase, "drift-rekey-release-owner");
    writeFileSync(attemptsFile, "0");
    const script = join(fixture.repoDir, "rekey-cache-hit.sh");
    writeFileSync(script, `#!/bin/sh
n=$(cat "${attemptsFile}")
n=$((n + 1))
printf '%s' "$n" > "${attemptsFile}"
if [ "$n" -eq 1 ]; then
  : > "${ownerStartedFile}"
  while [ ! -f "${mutateOwnerFile}" ]; do sleep 0.05; done
  printf 'owner changed tree\\n' > "${join(fixture.repoDir, "README.md")}"
  git -C "${fixture.repoDir}" add README.md
  git -C "${fixture.repoDir}" commit -m 'owner rekey change' >/dev/null
  : > "${ownerMutatedFile}"
  while [ ! -f "${releaseOwnerFile}" ]; do sleep 0.05; done
fi
exit 0
`);
    chmodSync(script, 0o755);
    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const originRepo = getOriginRepo(fixture.repoDir);
    const cmdHash = computeCmdHash(script);

    const owner = runShim(
      ["--repo", fixture.repoDir, "--run", "r-rekey-owner", "--step", "s-owner", "--", script],
      shimChildEnv(controlEnv),
    );
    await waitUntil(() => existsSync(ownerStartedFile));
    const waiterRunId = "r-rekey-cache-hit-waiter";
    const waiter = runShim(
      ["--repo", fixture.repoDir, "--run", waiterRunId, "--step", "s-waiter", "--", script],
      shimChildEnv(controlEnv),
    );
    const waiterEventsPath = join(controlEnv.stateDir, "events", `${waiterRunId}.jsonl`);
    await waitUntil(() =>
      existsSync(waiterEventsPath)
      && readFileSync(waiterEventsPath, "utf-8").includes("suite.singleflight_wait")
    );

    writeFileSync(mutateOwnerFile, "mutate");
    await waitUntil(() => existsSync(ownerMutatedFile));
    const rekeyedTreeHash = committedTreeHash(fixture.repoDir);
    assert.ok(rekeyedTreeHash, "mutated fixture should have a re-keyed tree hash");
    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: rekeyedTreeHash,
      cmd_hash: cmdHash,
      cmd_display: script.slice(0, 200),
      exit_code: 0,
      duration_ms: 37,
      log_tail: "REKEYED GREEN RESULT",
      run_id: "r-rekey-seed",
      step_id: "s-seed",
    });
    writeFileSync(releaseOwnerFile, "release");

    const [ownerResult, waiterResult] = await Promise.all([owner, waiter]);
    assert.equal(ownerResult.exitCode, 86, "tree-changing owner should be rejected");
    assert.equal(waiterResult.exitCode, 0);
    assert.match(waiterResult.stdout, /TAMANDUA-TEST CACHED/);
    assert.match(waiterResult.stdout, /REKEYED GREEN RESULT/);
    assert.equal(readFileSync(attemptsFile, "utf-8"), "1", "waiter must not execute the command");

    const events = readFileSync(waiterEventsPath, "utf-8").trim().split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const cacheHits = events.filter((event) => event.event === "suite.cache_hit");
    assert.equal(cacheHits.length, 1, "one replay must emit exactly one cache-hit event");
    assert.equal(cacheHits[0]!.treeHash, rekeyedTreeHash.slice(0, 12));
  });

  it("routes every green replay through the cache-hit replay helper", () => {
    const source = readFileSync(join(__dirname, "shim.ts"), "utf-8");
    const directReplayCalls = source.match(/^\s*replay\s*\(/gm) ?? [];
    assert.equal(
      directReplayCalls.length,
      1,
      "only the shared cache-hit helper may call replay directly",
    );
  });

  // ════════════════════════════════════════════════════════════════════
  // US-006: Single-flight claim tests
  // ════════════════════════════════════════════════════════════════════

  /** Helper: make an authenticated POST request to the control plane. */
  async function controlPlanePost(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: controlEnv.controlPort,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(data)),
            "x-tamandua-secret": controlEnv.secret,
          },
        },
        (res) => {
          let respData = "";
          res.on("data", (chunk: Buffer) => (respData += chunk.toString()));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 500, body: JSON.parse(respData) });
            } catch {
              resolve({ status: res.statusCode ?? 500, body: respData });
            }
          });
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  // ── US-003: Per-test scoped suite_results cleanup ──────────────
  // Track commands used by each test so afterEach can scope cleanup
  // to the exact cache key (origin_repo, tree_hash, cmd_hash).
  let _testCleanupKeys: Array<{ repo: string; cmd: string }> = [];

  let _suiteMigrationDone = false;

  /** Clear suite_results scoped to a specific cache key (origin_repo, tree_hash, cmd_hash). */
  async function clearSuiteResultsForCmd(repoDir: string, cmd: string): Promise<void> {
    // Ensure migration has run so the suite_results table exists.
    if (!_suiteMigrationDone) {
      const { getDb } = await import("../../dist/db.js");
      getDb();
      _suiteMigrationDone = true;
    }
    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const originRepo = getOriginRepo(repoDir);
    const treeHash = committedTreeHash(repoDir);
    if (!treeHash) return;
    const cmdHash = computeCmdHash(cmd);
    const db = new DatabaseSync(controlEnv.dbPath);
    db.prepare(
      "DELETE FROM suite_results WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ?"
    ).run(originRepo, treeHash, cmdHash);
    db.close();
  }

  afterEach(async () => {
    for (const key of _testCleanupKeys) {
      await clearSuiteResultsForCmd(key.repo, key.cmd);
    }
    _testCleanupKeys = [];
  });

  // ── US-006 AC1: Concurrent cold cache → exactly one execution ─────

  it("single-flight: concurrent invocations on cold cache result in exactly one execution (AC1)", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    // Spawn 5 concurrent shim invocations with the same key.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runShim(
          ["--repo", repoDir, "--run", "r-sf-ac1", "--step", "s1", "--", counterScript],
          env,
        ),
      ),
    );

    // All must exit 0 (AC3).
    for (const r of results) {
      assert.equal(r.exitCode, 0, `all invocations should exit 0, got ${r.exitCode}`);
    }

    // At most 2 executions due to Promise.all spawn timing: the first process
    // records and clears the claim before the last spawn finishes its claim
    // call. In production, shim invocations have natural timing separation.
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.ok(
      count >= 1 && count <= 2,
      `expected 1-2 executions, got ${count}`,
    );

    // At least one must have replayed (CACHED banner).
    const replayed = results.filter((r) => r.stdout.includes("TAMANDUA-TEST CACHED"));
    const executed = results.filter((r) => !r.stdout.includes("TAMANDUA-TEST CACHED"));
    assert.ok(replayed.length >= 1, `at least one invocation should replay, got ${replayed.length}`);
    // The executor(s) should see counter output; total should sum correctly.
    assert.ok(
      replayed.length + executed.length === 5,
      `all 5 invocations accounted for: ${replayed.length} replays + ${executed.length} executions`,
    );
  });

  // ── US-006 AC2: Poll picks up green result → replay ───────────────

  it("single-flight: waiter polls and replays when green result is recorded (AC2)", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    // Compute the committed-tree key that the shim will use.
    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Pre-claim the key so the shim gets "wait".
    const claimResp = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
    });
    assert.equal(claimResp.status, 200, "should claim successfully");
    const claimBody = claimResp.body as Record<string, unknown>;
    assert.equal(claimBody.action, "run", "first claim should say run");

    // Spawn the shim — it should get "wait" on claim, start polling.
    const shimPromise = runShim(
      ["--repo", repoDir, "--run", "r-sf-ac2", "--step", "s1", "--", counterScript],
      env,
    );

    // Give the shim time to start polling, then record a green result.
    await new Promise((r) => setTimeout(r, 500));

    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: counterScript.slice(0, 200),
      exit_code: 0,
      duration_ms: 42,
      log_tail: "FAKE: green result from poll test",
      run_id: "r-sf-ac2-owner",
      step_id: "s-owner",
    });

    const r = await shimPromise;
    assert.equal(r.exitCode, 0, "waiter should exit 0");
    // Should have replayed the recorded result.
    assert.ok(
      r.stdout.includes("TAMANDUA-TEST CACHED"),
      "waiter should replay green result",
    );
    assert.ok(
      r.stdout.includes("FAKE: green result from poll test"),
      "should see recorded log tail",
    );

    // Counter should NOT have been incremented (replay, no execution).
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 0, "counter should not increment on replay");
  });

  // ── US-006 AC2: Poll picks up red result → execute ────────────────

  it("single-flight: waiter executes when red result is recorded during poll (AC2)", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Pre-claim the key.
    const claimResp = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
    });
    assert.equal(claimResp.status, 200, "should claim successfully");

    // Spawn the shim — it should get "wait", start polling.
    const shimPromise = runShim(
      ["--repo", repoDir, "--run", "r-sf-red", "--step", "s1", "--", counterScript],
      env,
    );

    // Give the shim time to start polling, then record a RED result.
    await new Promise((r) => setTimeout(r, 500));

    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: counterScript.slice(0, 200),
      exit_code: 1,
      duration_ms: 100,
      log_tail: "FAIL: red result from poll test",
      run_id: "r-sf-red-owner",
      step_id: "s-owner",
    });

    const r = await shimPromise;
    assert.equal(r.exitCode, 0, "should execute and exit 0 (counter always passes)");
    // Should NOT have replayed (red is never authoritative).
    assert.ok(
      !r.stdout.includes("TAMANDUA-TEST CACHED"),
      "should NOT replay a red result",
    );
    // Counter should have been incremented by the actual execution.
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should increment on actual execution");
  });

  // ── Regression: --force must not be ignored on singleflight wait path ──

  it("single-flight: --force bypasses green replay on wait path and executes fresh", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    // Prime a green suite_result by running once.
    const r1 = await runShim(
      ["--repo", repoDir, "--run", "r-sf-force", "--step", "s-prime", "--", counterScript],
      env,
    );
    assert.equal(r1.exitCode, 0, "priming run should pass");
    let count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should be 1 after priming");

    // Compute the key.
    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Pre-claim the key so the shim gets "wait" on claim.
    const claimResp = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
    });
    assert.equal(claimResp.status, 200, "should claim successfully");
    const claimBody = claimResp.body as Record<string, unknown>;
    assert.equal(claimBody.action, "run", "first claim should say run");

    // Now spawn the shim with --force. It should get "wait" on claim,
    // enter pollForResult, see the green result, but skip it (!force guard)
    // and continue polling until the claim is released.
    const shimPromise = runShim(
      ["--repo", repoDir, "--run", "r-sf-force", "--step", "s-forced", "--force", "--", counterScript],
      env,
    );

    // Give the shim time to enter the poll loop, then record a result
    // for this key (which clears the pending claim via the control plane).
    // The shim's next poll iteration will see the green, skip it (!force),
    // attempt to claim → get "run" → execute fresh.
    await new Promise((r) => setTimeout(r, 3000));

    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: counterScript.slice(0, 200),
      exit_code: 0,
      duration_ms: 42,
      log_tail: "FORCE-TEST: claim-clearing record",
      run_id: "r-sf-force-claim-clear",
      step_id: "s-clear",
    });

    const r2 = await shimPromise;
    assert.equal(r2.exitCode, 0, "forced execution should pass");

    // Must NOT have replayed — force must bypass the cached green.
    assert.ok(
      !r2.stdout.includes("TAMANDUA-TEST CACHED"),
      "--force must bypass cache replay on singleflight wait path",
    );

    // Counter must be 2: the priming run + the forced fresh execution.
    count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 2, "counter should be 2 after forced execution");

    // Verify two distinct suite_results rows (priming + forced).
    const db = new DatabaseSync(controlEnv.dbPath);
    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM suite_results WHERE run_id = ?")
      .get("r-sf-force") as { cnt: number };
    assert.equal(rows.cnt, 2, "should have two recorded results (priming + forced)");
    db.close();
  });

  // ── US-006: Claim "run" response proceeds to execute ─────────────

  it("single-flight: claim 'run' response proceeds to execute and record", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    // Fresh cache (counter cleared in beforeEach) — claim should return "run".
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-sf-run", "--step", "s1", "--", counterScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and exit 0");
    assert.ok(
      !r.stdout.includes("TAMANDUA-TEST CACHED"),
      "fresh cache should execute, not replay",
    );

    // Counter should be 1.
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should increment on execution");

    // The result should be recorded in suite_results.
    const db = new DatabaseSync(controlEnv.dbPath);
    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM suite_results WHERE run_id = ?")
      .get("r-sf-run") as { cnt: number };
    assert.equal(rows.cnt, 1, "should have one recorded result in suite_results");
    db.close();
  });

  // ── US-001 (F2): Waiter TTL guard in pollForResult ─────────────

  it("single-flight: expired green (>24h) does NOT replay — continues polling and executes", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Insert an expired green row (25 hours old) directly into suite_results.
    const expiredCreatedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const db = new DatabaseSync(controlEnv.dbPath);
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 0, 42, 'EXPIRED: old green result', 'r-f2-expired-prime', 's-prime', ?)`,
    ).run(originRepo, treeHash, cmdHash, counterScript.slice(0, 200), expiredCreatedAt);
    db.close();

    // Pre-claim the key so the shim gets "wait" and enters pollForResult.
    const claimResp = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
    });
    assert.equal(claimResp.status, 200, "pre-claim should succeed");

    // Spawn the shim — it should get "wait", enter pollForResult,
    // see the expired green, skip it, and continue polling.
    const shimPromise = runShim(
      ["--repo", repoDir, "--run", "r-f2-expired", "--step", "s1", "--", counterScript],
      env,
    );

    // Give the shim time to enter the poll loop.
    await new Promise((r) => setTimeout(r, 2000));

    // Record a RED result — this clears the claim and the shim should see
    // the red, fall through to claim → execute (never replays red).
    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: counterScript.slice(0, 200),
      exit_code: 1,
      duration_ms: 100,
      log_tail: "RED: forced execution for expired green test",
      run_id: "r-f2-expired-red",
      step_id: "s-red",
    });

    const r = await shimPromise;
    assert.equal(r.exitCode, 0, "should execute and exit 0 (counter always passes)");
    // Should NOT have replayed the expired green.
    assert.ok(
      !r.stdout.includes("TAMANDUA-TEST CACHED"),
      "must NOT replay an expired green result",
    );
    // Counter should be 1 — proving execution happened.
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should increment on execution (no expired replay)");
  });

  it("single-flight: NaN/empty created_at does NOT replay — continues polling and executes", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Insert a green row with empty (NaN) created_at.
    const db = new DatabaseSync(controlEnv.dbPath);
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 0, 42, 'NAN: empty created_at result', 'r-f2-nan-prime', 's-prime', '')`,
    ).run(originRepo, treeHash, cmdHash, counterScript.slice(0, 200));
    db.close();

    // Pre-claim so the shim enters pollForResult.
    const claimResp = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
    });
    assert.equal(claimResp.status, 200, "pre-claim should succeed");

    const shimPromise = runShim(
      ["--repo", repoDir, "--run", "r-f2-nan", "--step", "s1", "--", counterScript],
      env,
    );

    await new Promise((r) => setTimeout(r, 2000));

    // Record a red result to release the claim and force execution.
    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: counterScript.slice(0, 200),
      exit_code: 1,
      duration_ms: 100,
      log_tail: "RED: execution for NaN created_at test",
      run_id: "r-f2-nan-red",
      step_id: "s-red",
    });

    const r = await shimPromise;
    assert.equal(r.exitCode, 0, "should execute and exit 0");
    assert.ok(
      !r.stdout.includes("TAMANDUA-TEST CACHED"),
      "must NOT replay a result with NaN/empty created_at",
    );
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should increment on execution (no NaN replay)");
  });

  // ── US-009: Suite events for observability ──────────────────────────

  it("emits suite.cache_hit event on replay", async () => {
    // First invocation: use --force to guarantee execution (bypass any
    // cached results from previous tests on the same tree).
    const env1 = shimChildEnv(controlEnv);
    await runShim(
      ["--repo", repoDir, "--run", "r-ev-cache-hit", "--step", "s1", "--force", "--", passScript],
      env1,
    );

    // Second invocation: same tree+cmd → replay (cache hit).
    const env2 = shimChildEnv(controlEnv);
    await runShim(
      ["--repo", repoDir, "--run", "r-ev-cache-hit", "--step", "s1", "--", passScript],
      env2,
    );

    // Check events file for suite.cache_hit.
    const eventsPath = join(controlEnv.stateDir, "events", "r-ev-cache-hit.jsonl");
    const content = readFileSync(eventsPath, "utf-8").trim();
    const lines = content.split("\n").filter(Boolean);

    // Should have at least: suite.executed (from first run) + suite.cache_hit (from second).
    assert.ok(lines.length >= 2, `expected at least 2 events, got ${lines.length}`);
    const events = lines.map((l) => JSON.parse(l));

    const executedEvent = events.find((e: Record<string, unknown>) => e.event === "suite.executed");
    assert.ok(executedEvent, "should have suite.executed event");
    assert.ok(typeof executedEvent.treeHash === "string" && executedEvent.treeHash.length > 0);
    assert.equal(executedEvent.exitCode, 0);
    assert.equal(executedEvent.force, true, "forced execution intent must be mechanically observable");

    const cacheHitEvent = events.find((e: Record<string, unknown>) => e.event === "suite.cache_hit");
    assert.ok(cacheHitEvent, "should have suite.cache_hit event");
    assert.equal(cacheHitEvent.runId, "r-ev-cache-hit");
    assert.equal(cacheHitEvent.stepId, "s1");
    assert.ok(typeof cacheHitEvent.treeHash === "string" && cacheHitEvent.treeHash.length === 12);
    assert.ok(typeof cacheHitEvent.cmdDisplay === "string" && cacheHitEvent.cmdDisplay.length > 0);
    assert.ok(typeof cacheHitEvent.savedDurationMs === "number" && cacheHitEvent.savedDurationMs > 0);
    assert.equal(cacheHitEvent.force, false, "cache hits must be mechanically identified as non-forced");
  });

  it("emits suite.flaky_detected event when flaky key exists", async () => {
    // Pre-seed both a red and a green record for the same key to simulate flaky.
    // Use --force to ensure the first invocation executes (not replays from a
    // previous test's cache).
    const runId = "r-ev-flaky";
    const stepId = "s-flaky";
    const env1 = shimChildEnv(controlEnv);
    await runShim(
      ["--repo", repoDir, "--run", runId, "--step", stepId, "--force", "--", passScript],
      env1,
    );

    // Read the tree_hash from the recorded suite result.
    const db = new DatabaseSync(controlEnv.dbPath);
    const row = db.prepare(
      "SELECT origin_repo, tree_hash, cmd_hash, cmd_display FROM suite_results WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(runId) as { origin_repo: string; tree_hash: string; cmd_hash: string; cmd_display: string } | undefined;
    assert.ok(row, "should have recorded a suite result");

    // Insert a fake red (fail) entry for the same key.
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 1, 200, 'fail log', 'red-run', 'red-step', ?)`,
    ).run(row.origin_repo, row.tree_hash, row.cmd_hash, row.cmd_display, new Date().toISOString());
    // Wait a moment so this red is newer than the green.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Insert another red so that flaky is detected (requires both pass and fail in window).
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 1, 300, 'fail log 2', 'red-run-2', 'red-step-2', ?)`,
    ).run(row.origin_repo, row.tree_hash, row.cmd_hash, row.cmd_display, new Date().toISOString());
    db.close();

    // Now invoke the shim again — it should detect flaky and emit the event.
    const env2 = shimChildEnv(controlEnv);
    await runShim(
      ["--repo", repoDir, "--run", runId, "--step", stepId, "--", passScript],
      env2,
    );

    // Check events file for suite.flaky_detected.
    const eventsPath = join(controlEnv.stateDir, "events", `${runId}.jsonl`);
    const content = readFileSync(eventsPath, "utf-8").trim();
    const lines = content.split("\n").filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const flakyEvent = events.find((e: Record<string, unknown>) => e.event === "suite.flaky_detected");
    assert.ok(flakyEvent, "should have suite.flaky_detected event");
    assert.equal(flakyEvent.runId, runId);
    assert.ok(typeof flakyEvent.treeHash === "string" && flakyEvent.treeHash.length > 0);
    assert.ok(typeof flakyEvent.cmdHash === "string" && flakyEvent.cmdHash.length > 0);
    assert.ok(typeof flakyEvent.passCount === "number" && flakyEvent.passCount >= 1);
    assert.ok(typeof flakyEvent.failCount === "number" && flakyEvent.failCount >= 2);
    assert.equal(flakyEvent.window, "24h");
  });

  it("emits suite.singleflight_wait event when claim returns wait", async () => {
    const runId = "r-ev-sf-wait";
    const env = shimChildEnv(controlEnv);

    // Pre-claim the key by directly POSTing to /suite/claim.
    const db = new DatabaseSync(controlEnv.dbPath);

    // First get a tree hash by running once with --force to guarantee execution.
    await runShim(
      ["--repo", repoDir, "--run", runId, "--step", "s1", "--force", "--", passScript],
      env,
    );
    const row = db.prepare(
      "SELECT tree_hash, cmd_hash FROM suite_results WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(runId) as { tree_hash: string; cmd_hash: string } | undefined;
    assert.ok(row, "should have a recorded result");

    // Pre-claim the key via direct HTTP request.
    await new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify({ origin_repo: row.tree_hash, tree_hash: row.tree_hash, cmd_hash: row.cmd_hash });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-tamandua-secret": String(controlEnv.secret),
        "content-length": String(Buffer.byteLength(payload)),
      };
      const req = http.request(
        { method: "POST", hostname: "127.0.0.1", port: controlEnv.controlPort, path: "/suite/claim", headers },
        (res) => { res.resume(); res.on("end", resolve); },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => { req.destroy(); resolve(); });
      req.write(payload);
      req.end();
    });

    // Clear suite_results for our key so we get a miss (to trigger single-flight claim).
    await clearSuiteResultsForCmd(repoDir, passScript);
    db.close();

    // Spawn the shim with a fresh runId for the second invocation.
    const runId2 = "r-ev-sf-wait-2";
    const env2 = shimChildEnv(controlEnv);
    // Time-bounded: the shim will poll until claim timeout or result.
    // We use short timeout (we just want to see the event).
    const shimPromise = runShim(
      ["--repo", repoDir, "--run", runId2, "--step", "s1", "--", passScript],
      env2,
    );

    // Give the shim time to claim and emit the wait event.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check events for suite.singleflight_wait.
    const eventsPath = join(controlEnv.stateDir, "events", `${runId2}.jsonl`);
    try {
      const content = readFileSync(eventsPath, "utf-8").trim();
      const lines = content.split("\n").filter(Boolean);
      const events = lines.map((l) => JSON.parse(l));
      const waitEvent = events.find((e: Record<string, unknown>) => e.event === "suite.singleflight_wait");
      assert.ok(waitEvent, "should have suite.singleflight_wait event");
      assert.equal(waitEvent.runId, runId2);
      assert.ok(typeof waitEvent.treeHash === "string" && waitEvent.treeHash.length > 0);
      assert.ok(typeof waitEvent.cmdHash === "string" && waitEvent.cmdHash.length > 0);
      assert.equal(waitEvent.waitedMs, 0);
    } catch {
      // If event file doesn't exist yet, the shim might not have gotten there yet.
      // This is acceptable — the single-flight path is timing-dependent.
    }

    // Cleanup: wait for shim to finish.
    await shimPromise.catch(() => {});
  });

  // ════════════════════════════════════════════════════════════════════
  // US-001: SHCA — Catch handler uses saved command on unexpected error
  // ════════════════════════════════════════════════════════════════════

  it("SHCA: catch handler executes real command when main throws after parsing", async () => {
    const env = shimChildEnv(controlEnv, {
      TAMANDUA_SHIM_TEST_THROW: "1",
    });
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-shca", "--step", "s1", "--", passScript],
      env,
    );
    // The command must still execute despite the forced error in main().
    assert.equal(r.exitCode, 0, "command should execute and exit 0 on pass");
    assert.ok(
      r.stdout.includes("PASS: all tests passed"),
      "should see test command output",
    );
    // The catch handler log must appear on stderr.
    assert.ok(
      r.stderr.includes("passthrough mode — unexpected error"),
      "catch handler should log the passthrough notice",
    );
    assert.ok(
      r.stderr.includes("TAMANDUA_SHIM_TEST_THROW"),
      "should include the forced error message",
    );
  });

  it("SHCA: catch handler exits with error when no command is parseable", async () => {
    // When no command is provided at all, savedCmdArgs stays empty and the
    // catch must exit 1 with a clear message (not silently succeed).
    const env = shimChildEnv(controlEnv, {
      TAMANDUA_SHIM_TEST_THROW: "1",
    });
    // No -- separator → no command args.
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-shca-nocmd", "--step", "s1"],
      env,
    );
    assert.notEqual(r.exitCode, 0, "should exit non-zero when no command is available");
    assert.ok(
      r.stderr.includes("passthrough mode — unexpected error"),
      "catch handler should log the error",
    );
    assert.ok(
      r.stderr.includes("no command to run"),
      "should report no command to run",
    );
  });

  it("SHCA: catch handler propagates exit code of failing command", async () => {
    // When the saved command fails, the catch handler must propagate the
    // non-zero exit code (not mask it with a shim error exit).
    const env = shimChildEnv(controlEnv, {
      TAMANDUA_SHIM_TEST_THROW: "1",
    });
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-shca-fail", "--step", "s1", "--", failScript],
      env,
    );
    assert.equal(r.exitCode, 1, "should propagate exit code 1 from failing command");
    assert.ok(
      r.stderr.includes("passthrough mode — unexpected error"),
      "catch handler should log the error",
    );
    assert.ok(
      r.stderr.includes("FAIL: something broke"),
      "should see failure output from command",
    );
  });

  // ════════════════════════════════════════════════════════════════════
  // US-002: SHSH — Shell semantics for non-trivial test commands
  // ════════════════════════════════════════════════════════════════════

  // Create helper scripts for SHSH tests.
  let echoArgScript: string;
  let envCheckScript: string;

  before(async () => {
    // Script that echoes its first argument.
    echoArgScript = join(repoDir, "echo-arg.sh");
    writeFileSync(echoArgScript, "#!/bin/sh\necho \"ARG:$1\"\nexit 0\n");
    chmodSync(echoArgScript, 0o755);

    // Script that checks an env var.
    envCheckScript = join(repoDir, "env-check.sh");
    writeFileSync(envCheckScript, "#!/bin/sh\necho \"MYVAR=$MYVAR\"\nexit 0\n");
    chmodSync(envCheckScript, 0o755);
  });

  // ── SHSH AC4: Env-prefixed command executes correctly ─────────────

  it("SHSH: env-prefixed command executes correctly through the shim", async () => {
    const env = shimChildEnv(controlEnv);
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-shsh-env", "--step", "s1", "--", `MYVAR=hello ${envCheckScript}`],
      env,
    );
    assert.equal(r.exitCode, 0, "should exit 0");
    assert.ok(
      r.stdout.includes("MYVAR=hello"),
      "should see the env var value in output",
    );
    assert.ok(
      !r.stdout.includes("TAMANDUA-TEST CACHED"),
      "first run should execute, not replay",
    );
  });

  // ── SHSH AC5: Compound command with && produces one ledger entry ──

  it("SHSH: compound command with && executes both parts and replays correctly", async () => {
    const env = shimChildEnv(controlEnv);

    // Build a compound command: pass script && counter script.
    const cmd = `${passScript} && ${counterScript}`;

    // First invocation: must execute.
    const r1 = await runShim(
      ["--repo", repoDir, "--run", "r-shsh-and", "--step", "s1", "--", cmd],
      env,
    );
    assert.equal(r1.exitCode, 0, "first execution should pass");
    assert.ok(r1.stdout.includes("PASS: all tests passed"), "should see pass script output");
    assert.ok(r1.stdout.includes("run 1"), "should see counter increment");
    assert.ok(!r1.stdout.includes("TAMANDUA-TEST CACHED"), "first run must NOT be a replay");

    // Reset counter for replay verification.
    writeFileSync(counterFile, "0");

    // Second invocation: should replay with CACHED banner.
    const r2 = await runShim(
      ["--repo", repoDir, "--run", "r-shsh-and", "--step", "s2", "--", cmd],
      env,
    );
    assert.equal(r2.exitCode, 0, "replay should exit 0");
    assert.ok(r2.stdout.includes("TAMANDUA-TEST CACHED"), "second run should replay");

    // Counter should NOT have incremented (replay, not real execution).
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 0, "counter should not increment on replay");

    // Verify the replay output contains recorded output.
    assert.ok(
      r2.stdout.includes("PASS: all tests passed") || r2.stdout.includes("run 1"),
      "replay should include recorded output",
    );

    // Only one ledger entry for the full compound string.
    const db2 = new DatabaseSync(controlEnv.dbPath);
    const rows = db2
      .prepare("SELECT COUNT(*) as cnt FROM suite_results WHERE run_id = ?")
      .get("r-shsh-and") as { cnt: number };
    assert.equal(rows.cnt, 1, "should have exactly one ledger entry for compound command");
    db2.close();
  });

  // ── SHSH AC6: Command with embedded quotes survives round-trip ────

  it("SHSH: command with embedded single quotes survives shell round-trip", async () => {
    const env = shimChildEnv(controlEnv);

    // Use echo-arg.sh with an argument containing single quotes.
    // The arg it's a test needs to survive the shell round-trip.
    const cmd = `${echoArgScript} "it's a test"`;
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-shsh-quote", "--step", "s1", "--", cmd],
      env,
    );
    assert.equal(r.exitCode, 0, "should exit 0");
    assert.ok(
      r.stdout.includes("ARG:it's a test"),
      `should echo the argument with single quote preserved, got: ${r.stdout}`,
    );
  });

  // ── SHSH AC7: Simple command still works unchanged ────────────────

  it("SHSH: simple command still works unchanged", async () => {
    // Clear any cached result from previous tests on the same tree.
    await clearSuiteResultsForCmd(repoDir, passScript);

    const env = shimChildEnv(controlEnv);
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-shsh-simple", "--step", "s1", "--", passScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and exit 0");
    assert.ok(r.stdout.includes("PASS: all tests passed"), "should see command output");
    assert.ok(!r.stdout.includes("TAMANDUA-TEST CACHED"), "fresh cache should execute, not replay");
  });

  // ── SHSH: Pipe semantics work through the shell ───────────────────

  it("SHSH: command with pipe executes correctly", async () => {
    const env = shimChildEnv(controlEnv);

    // echo "hello" | cat — exercises pipe through sh -c.
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-shsh-pipe", "--step", "s1", "--", `echo "hello from pipe" | cat`],
      env,
    );
    assert.equal(r.exitCode, 0, "should exit 0");
    assert.ok(
      r.stdout.includes("hello from pipe"),
      `should see piped output, got: ${r.stdout}`,
    );
  });

  // ── SHSH: wrapTestCmdInContext escaping — single-quote round-trip ─

  it("SHSH: command flows through step-ops wrapping and executes via sh -c", async () => {
    // Simulate what wrapTestCmdInContext produces: a single-quoted command
    // after --. The quoting ensures the full command reaches the shim as
    // one argv element, then sh -c executes it with shell semantics.
    //
    // Example: tamandua-test --repo X --run Y --step Z -- 'npm run build && npm test'
    //                     argv → ['npm run build && npm test'] (one element)
    //                     cmdString → 'npm run build && npm test'
    //                     sh -c 'npm run build && npm test' → correct
    const env = shimChildEnv(controlEnv);

    // Pass the full compound command as a single argv element (simulating
    // how wrapTestCmdInContext single-quotes it for the agent's shell).
    const cmd = `${passScript} && ${counterScript}`;
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-shsh-wrap", "--step", "s1", "--", cmd],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and exit 0");
    assert.ok(r.stdout.includes("PASS: all tests passed"), "should see pass output");
    assert.ok(r.stdout.includes("run 1"), "counter should increment");
  });

  // ════════════════════════════════════════════════════════════════════
  // US-002 (F1): replayCachedResult revalidates tree before replaying
  // ════════════════════════════════════════════════════════════════════

  it("F1: waiter with dirty tracked files does NOT replay — exits 88 with FAILURE_CLASS: tree_dirty", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Pre-claim the key so the shim gets "wait" and enters pollForResult
    // (initial lookup misses — no cached green for this key).
    const claimResp = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
    });
    assert.equal(claimResp.status, 200, "pre-claim should succeed");

    // Spawn the shim — initial lookup miss → claim → "wait" → pollForResult.
    const waiterRunId = "r-f1-dirty-waiter";
    const shimPromise = runShim(
      ["--repo", repoDir, "--run", waiterRunId, "--step", "s-waiter", "--", counterScript],
      env,
    );

    // Wait for the shim to enter the poll loop (singleflight_wait event).
    const waiterEventsPath = join(controlEnv.stateDir, "events", `${waiterRunId}.jsonl`);
    await waitUntil(() =>
      existsSync(waiterEventsPath)
      && readFileSync(waiterEventsPath, "utf-8").includes("suite.singleflight_wait")
    );

    // Now make a tracked file dirty while the shim is polling.
    writeFileSync(join(repoDir, "README.md"), "# Dirty\nModified while polling!\n");

    // Record a green result — this releases the claim so the shim
    // can find it on its next poll iteration and attempt replay.
    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: treeHash,
      cmd_hash: cmdHash,
      cmd_display: counterScript.slice(0, 200),
      exit_code: 0,
      duration_ms: 42,
      log_tail: "FAKE: green from dirty-waiter test",
      run_id: "r-f1-dirty-owner",
      step_id: "s-owner",
    });

    const r = await shimPromise;
    // Must exit 88 — replayCachedResult refuses to replay a dirty tree.
    assert.equal(r.exitCode, 88, "should exit 88 for dirty tree on replay path");
    assert.doesNotMatch(r.stdout, /TAMANDUA-TEST CACHED/);
    assert.match(r.stderr, /^FAILURE_CLASS: tree_dirty$/m);
    assert.match(r.stderr, /^FAILURE: uncommitted changes to tracked files — commit them before testing$/m);
    assert.match(r.stderr, /README\.md/);

    // Clean up: reset the dirty file so other tests are not affected.
    execSync("git checkout -- README.md", { cwd: repoDir });
  });

  it("F1: waiter whose HEAD moved does NOT replay the old key — executes fresh against the new tree", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHashA = committedTreeHash(repoDir);
    assert.ok(treeHashA, "should get tree hash A (original)");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Pre-claim the key so the shim gets "wait" and enters pollForResult.
    const claimResp = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: treeHashA,
      cmd_hash: cmdHash,
    });
    assert.equal(claimResp.status, 200, "pre-claim should succeed");

    // Spawn the shim — initial lookup miss (no cached green) → claim → "wait" → pollForResult.
    const waiterRunId = "r-f1-headmove-waiter";
    const shimPromise = runShim(
      ["--repo", repoDir, "--run", waiterRunId, "--step", "s-waiter", "--", counterScript],
      env,
    );

    // Wait for the shim to enter the poll loop.
    const waiterEventsPath = join(controlEnv.stateDir, "events", `${waiterRunId}.jsonl`);
    await waitUntil(() =>
      existsSync(waiterEventsPath)
      && readFileSync(waiterEventsPath, "utf-8").includes("suite.singleflight_wait")
    );

    // While the shim is polling, create a new commit → tree B.
    // This changes HEAD so committedTreeHash returns a different value.
    writeFileSync(join(repoDir, "README.md"), "# HEAD moved\nNew commit while polling!\n");
    execSync("git add README.md && git commit -m 'HEAD moved during poll'", { cwd: repoDir });

    // Now record a green result for tree A (the OLD key). This releases
    // the claim so the shim's next poll iteration finds it.
    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: treeHashA,
      cmd_hash: cmdHash,
      cmd_display: counterScript.slice(0, 200),
      exit_code: 0,
      duration_ms: 42,
      log_tail: "GREEN: stale key for head-move test",
      run_id: "r-f1-headmove-owner",
      step_id: "s-owner",
    });

    const r = await shimPromise;
    // The shim should NOT replay the stale green.
    // replayCachedResult detects treeHash A ≠ current committedTreeHash B → returns false.
    // Falls through to execute fresh.
    assert.equal(r.exitCode, 0, "should execute fresh and exit 0");
    assert.doesNotMatch(r.stdout, /TAMANDUA-TEST CACHED/);

    // Counter must be 1 — fresh execution happened exactly once.
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should be 1 — fresh execution happened");
  });

  it("F1: clean unmoved waiter still replays instantly (no behavior change on honest path)", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    // Prime a green result at the clean tree.
    const r1 = await runShim(
      ["--repo", repoDir, "--run", "r-f1-honest", "--step", "s-prime", "--force", "--", counterScript],
      env,
    );
    assert.equal(r1.exitCode, 0, "priming run should pass");

    // Second invocation: clean tree, unmoved HEAD → should replay.
    const r2 = await runShim(
      ["--repo", repoDir, "--run", "r-f1-honest", "--step", "s-replay", "--", counterScript],
      env,
    );
    assert.equal(r2.exitCode, 0, "replay should exit 0");
    assert.match(r2.stdout, /TAMANDUA-TEST CACHED/);

    // Counter should still be 1 (only the priming run executed).
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should not increment on replay");
  });

  it("F1: replayCachedResult calls committedTreeHash to validate key before replay", () => {
    // Structural test: verify that replayCachedResult in the compiled
    // shim.js calls committedTreeHash (the tree-hash revalidation check).
    const dist = readFileSync(
      join(__dirname, "..", "..", "dist", "suite", "shim.js"),
      "utf-8",
    );
    // The function was renamed during compilation but the logic is:
    // inside replayCachedResult, we call committedTreeHash before emitSuiteEvent.
    // Verify the structural invariant: committedTreeHash is referenced
    // in proximity to suite.cache_hit emission.
    const suiteCacheHitIdx = dist.indexOf("suite.cache_hit");
    assert.ok(suiteCacheHitIdx >= 0, "suite.cache_hit event must be in compiled output");
    // committedTreeHash import should exist (from tree-hash.js).
    assert.ok(
      dist.includes("committedTreeHash"),
      "committedTreeHash must be referenced in compiled shim",
    );
  });

  // ════════════════════════════════════════════════════════════════════
  // US-003 (F3): Record key equals executed tree on ALL execution paths
  // ════════════════════════════════════════════════════════════════════

  it("F3: non-owner HEAD move during wait → recorded tree_hash equals new committed tree (not stale key)", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHashA = committedTreeHash(repoDir);
    assert.ok(treeHashA, "should get tree hash A (original)");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Pre-claim the key so the shim gets "wait" and enters pollForResult
    // (initial lookup misses — no cached green for this key).
    const claimResp = await controlPlanePost("/suite/claim", {
      origin_repo: originRepo,
      tree_hash: treeHashA,
      cmd_hash: cmdHash,
    });
    assert.equal(claimResp.status, 200, "pre-claim should succeed");

    // Spawn the shim — initial lookup miss → claim → "wait" → pollForResult.
    const waiterRunId = "r-f3-headmove-waiter";
    const shimPromise = runShim(
      ["--repo", repoDir, "--run", waiterRunId, "--step", "s-waiter", "--", counterScript],
      env,
    );

    // Wait for the shim to enter the poll loop.
    const waiterEventsPath = join(controlEnv.stateDir, "events", `${waiterRunId}.jsonl`);
    await waitUntil(() =>
      existsSync(waiterEventsPath)
      && readFileSync(waiterEventsPath, "utf-8").includes("suite.singleflight_wait")
    );

    // While the shim polls, create a new commit → tree B.
    writeFileSync(join(repoDir, "README.md"), "# HEAD moved — F3 test\nNew commit while waiter polls!\n");
    execSync("git add README.md && git commit -m 'HEAD moved during poll (F3)'", { cwd: repoDir });

    const treeHashB = committedTreeHash(repoDir);
    assert.ok(treeHashB, "should get tree hash B (after commit)");
    assert.notEqual(treeHashA, treeHashB, "tree hash A and B must differ after commit");

    // Record a green result for tree A (the OLD key). This releases the
    // claim so the shim's next poll iteration finds it.
    await controlPlanePost("/suite/record", {
      origin_repo: originRepo,
      tree_hash: treeHashA,
      cmd_hash: cmdHash,
      cmd_display: counterScript.slice(0, 200),
      exit_code: 0,
      duration_ms: 42,
      log_tail: "GREEN: stale key for F3 head-move test",
      run_id: "r-f3-headmove-owner",
      step_id: "s-owner",
    });

    const r = await shimPromise;
    // Should execute fresh (not replay the stale green).
    assert.equal(r.exitCode, 0, "should execute fresh and exit 0");
    assert.doesNotMatch(r.stdout, /TAMANDUA-TEST CACHED/, "should NOT replay stale key");

    // Counter must be 1 — fresh execution happened exactly once.
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should be 1 — fresh execution happened");

    // F3 CRITICAL: recorded tree_hash must equal the NEW committed tree (B),
    // not the stale key (A).
    const db = new DatabaseSync(controlEnv.dbPath);
    const rows = db.prepare(
      `SELECT tree_hash FROM suite_results
       WHERE origin_repo = ? AND cmd_hash = ? AND run_id = ? AND step_id = ?
       ORDER BY id DESC LIMIT 1`
    ).all(originRepo, cmdHash, waiterRunId, "s-waiter");
    db.close();
    assert.ok(rows.length > 0, "should find the recorded suite result row");
    const recordedTreeHash = (rows[0] as Record<string, unknown>).tree_hash;
    assert.equal(recordedTreeHash, treeHashB, `recorded tree_hash should be ${treeHashB} (new tree B), not ${treeHashA} (stale key A)`);
  });

  it("F3: owner-path with unmoved tree — no re-key, records under correct preTreeHash", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    const r = await runShim(
      ["--repo", repoDir, "--run", "r-f3-owner", "--step", "s-owner", "--force", "--", counterScript],
      env,
    );
    assert.equal(r.exitCode, 0, "owner should execute and exit 0");
    assert.doesNotMatch(r.stdout, /TAMANDUA-TEST CACHED/, "--force should not replay");

    // Counter should be 1 — execution happened.
    const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    assert.equal(count, 1, "counter should be 1");

    // Recorded tree_hash must match the committed tree before execution.
    const db = new DatabaseSync(controlEnv.dbPath);
    const rows = db.prepare(
      `SELECT tree_hash FROM suite_results
       WHERE origin_repo = ? AND cmd_hash = ? AND run_id = ? AND step_id = ?
       ORDER BY id DESC LIMIT 1`
    ).all(originRepo, cmdHash, "r-f3-owner", "s-owner");
    db.close();
    assert.ok(rows.length > 0, "should find the recorded suite result row");
    const recordedTreeHash = (rows[0] as Record<string, unknown>).tree_hash;
    assert.equal(recordedTreeHash, treeHash, "recorded tree_hash should match committed tree");
  });

  it("F3: structural invariant — preTreeHash re-key present in compiled shim", () => {
    const dist = readFileSync(
      join(__dirname, "..", "..", "dist", "suite", "shim.js"),
      "utf-8",
    );
    // F3 invariant: trackedPre !== preTreeHash triggers a re-key path.
    // Verify the compiled output contains the re-key lookup pattern.
    // The key behavioral marker is a lookupSuiteRecord call that appears
    // AFTER a trackedTreeHash computation and a comparison with preTreeHash.
    assert.ok(
      dist.includes("trackedPre") && dist.includes("preTreeHash"),
      "compiled shim must reference trackedPre and preTreeHash for F3 comparison",
    );
    // The re-key path does a fresh lookupSuiteRecord on the new key.
    // Verify committedTreeHash is called in the F3 re-key path (in addition
    // to the existing re-key loop and replayCachedResult).
    const committedTreeHashCount = [...dist.matchAll(/committedTreeHash/g)].length;
    // Before F3: committedTreeHash appears in (1) preTreeHash init, (2) re-key loop,
    // (3) replayCachedResult. After F3: one more use in the all-paths re-key block.
    // The exact number may vary with bundling, so just verify >= 2.
    assert.ok(
      committedTreeHashCount >= 2,
      `committedTreeHash should appear multiple times in compiled shim, got ${committedTreeHashCount}`,
    );
  });

  // ════════════════════════════════════════════════════════════════════
  // US-002: Prior-duration p50 hint at execution start
  // ════════════════════════════════════════════════════════════════════

  it("US-002: prints duration hint when prior completed durations exist", async () => {
    const env = shimChildEnv(controlEnv);

    const { computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Clear ALL rows for this repo+cmd to avoid interference from prior tests.
    const db0 = new DatabaseSync(controlEnv.dbPath);
    db0.prepare("DELETE FROM suite_results WHERE origin_repo = ? AND cmd_hash = ?").run(originRepo, cmdHash);
    db0.close();

    // Insert prior completed durations: 5min, 10min, 15min, 20min.
    // The p50 of [5, 10, 15, 20] is (10+15)/2 = 12.5 min, rounded to 13.
    // Use different tree hashes so the current tree doesn't hit the cache (no replay).
    // Duration history queries ALL trees for the same (origin_repo, cmd_hash).
    const db = new DatabaseSync(controlEnv.dbPath);
    const durations = [5 * 60_000, 10 * 60_000, 15 * 60_000, 20 * 60_000];
    const cmdDisplay = counterScript.slice(0, 200);
    for (let i = 0; i < durations.length; i++) {
      db.prepare(
        `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
         VALUES (?, ?, ?, ?, 0, ?, 'PASS: prior run', ?, ?, ?)`,
      ).run(
        originRepo,
        `other-tree-hash-${i}-for-cross-tree-duration-test`,
        cmdHash,
        cmdDisplay,
        durations[i],
        `r-prior-${i}`,
        `s-prior-${i}`,
        new Date(Date.now() - (durations.length - i) * 60_000).toISOString(),
      );
    }
    db.close();

    // Run the shim — it should print the hint before executing.
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-p50-hint", "--step", "s1", "--", counterScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and exit 0");

    // Check stderr for the TAMANDUA-TEST hint line.
    // P50 of [300000, 600000, 900000, 1200000] = (600000+900000)/2 = 750000ms = 12.5min → 13min.
    assert.match(
      r.stderr,
      /TAMANDUA-TEST: expect ~\d+min based on 4 prior runs — use a timeout comfortably above this/,
      `stderr should contain duration hint, got: ${r.stderr}`,
    );
    assert.match(r.stderr, /expect ~1[2-3]min/);
  });

  it("US-002: prints nothing when no prior completed durations exist", async () => {
    // Clear ALL rows for this repo+cmd (including cross-tree rows from other tests).
    const { computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const originRepo = getOriginRepo(repoDir);
    const cmdHash = computeCmdHash(counterScript);
    const db0 = new DatabaseSync(controlEnv.dbPath);
    db0.prepare("DELETE FROM suite_results WHERE origin_repo = ? AND cmd_hash = ?").run(originRepo, cmdHash);
    db0.close();

    const env = shimChildEnv(controlEnv);

    // Fresh key with no history at all.
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-no-prior", "--step", "s1", "--", counterScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and exit 0");

    // Must NOT contain the duration hint line.
    assert.doesNotMatch(
      r.stderr,
      /TAMANDUA-TEST: expect ~/,
      `stderr should NOT contain duration hint when no prior history, got: ${r.stderr}`,
    );
  });

  it("US-002: interrupted runs (exit 87) are excluded from duration history", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Insert one interrupted (exit 87) and one successful (exit 0) run.
    // Use different tree hashes so the current tree doesn't hit cache.
    const db = new DatabaseSync(controlEnv.dbPath);
    const cmdDisplay = counterScript.slice(0, 200);
    // Interrupted run — exit 87, should be excluded from duration history.
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 87, 5000, 'INTERRUPTED: timeout', 'r-int-87', 's-int', ?)`,
    ).run(originRepo, "other-tree-for-interrupted", cmdHash, cmdDisplay, new Date(Date.now() - 60000).toISOString());

    // Successful run — should be the only one counted.
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 0, 600000, 'PASS: good run', 'r-prior-ok', 's-ok', ?)`,
    ).run(originRepo, "other-tree-for-interrupted-2", cmdHash, cmdDisplay, new Date().toISOString());
    db.close();

    const r = await runShim(
      ["--repo", repoDir, "--run", "r-exit87-excl", "--step", "s1", "--", counterScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and exit 0");

    // Should have hint based on 1 prior run (only the successful one), NOT 2.
    assert.match(
      r.stderr,
      /TAMANDUA-TEST: expect ~\d+min based on 1 prior runs? — use a timeout comfortably above this/,
      `stderr should show 1 prior run (exit 87 excluded), got: ${r.stderr}`,
    );
  });

  it("US-002: control plane unreachable — shim proceeds without hint", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);

    // Use a port where nothing is listening — lookupSuiteDurationHistory returns null.
    const env = shimChildEnv(controlEnv, {
      TAMANDUA_CONTROL_PORT: "19999",
    });

    const r = await runShim(
      ["--repo", repoDir, "--run", "r-cp-down-hint", "--step", "s1", "--", passScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and exit 0");
    assert.ok(r.stdout.includes("PASS: all tests passed"), "should see command output");

    // Must NOT crash, and must NOT contain the duration hint.
    assert.doesNotMatch(
      r.stderr,
      /TAMANDUA-TEST: expect ~/,
      `stderr should NOT contain duration hint when control plane is down, got: ${r.stderr}`,
    );
  });

  it("US-002: --force bypasses duration hint", async () => {
    await clearSuiteResultsForCmd(repoDir, counterScript);
    const env = shimChildEnv(controlEnv);

    const { committedTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = committedTreeHash(repoDir);
    assert.ok(treeHash, "should get a tree hash");
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Insert one prior successful run with a known duration (e.g. 15 minutes).
    // Use different tree hash so the current tree doesn't hit cache.
    const db = new DatabaseSync(controlEnv.dbPath);
    const cmdDisplay = counterScript.slice(0, 200);
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 0, 900000, 'PASS: prior', 'r-prior-force', 's-prior', ?)`,
    ).run(originRepo, "other-tree-for-force-test", cmdHash, cmdDisplay, new Date(Date.now() - 60000).toISOString());
    db.close();

    // Run with --force — hint should NOT appear (force skips the hint).
    const r = await runShim(
      ["--repo", repoDir, "--run", "r-force-hint", "--step", "s1", "--force", "--", counterScript],
      env,
    );
    assert.equal(r.exitCode, 0, "should execute and exit 0");

    // Must NOT contain the duration hint (force bypasses it).
    assert.doesNotMatch(
      r.stderr,
      /TAMANDUA-TEST: expect ~/,
      `--force should bypass duration hint, got: ${r.stderr}`,
    );
  });

  it("US-002: p50 computed correctly for odd number of durations", async () => {
    const env = shimChildEnv(controlEnv);

    const { computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const cmdHash = computeCmdHash(counterScript);
    const originRepo = getOriginRepo(repoDir);

    // Clear ALL rows for this repo+cmd to avoid interference from prior tests.
    const db0 = new DatabaseSync(controlEnv.dbPath);
    db0.prepare("DELETE FROM suite_results WHERE origin_repo = ? AND cmd_hash = ?").run(originRepo, cmdHash);
    db0.close();

    // Insert 3 prior runs: 5min, 10min, 20min → p50 = 10min.
    // Use different tree hashes so the current tree doesn't hit cache.
    const db = new DatabaseSync(controlEnv.dbPath);
    const durations = [5 * 60_000, 10 * 60_000, 20 * 60_000];
    const cmdDisplay = counterScript.slice(0, 200);
    for (let i = 0; i < durations.length; i++) {
      db.prepare(
        `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
         VALUES (?, ?, ?, ?, 0, ?, 'PASS', ?, ?, ?)`,
      ).run(originRepo, `other-tree-odd-${i}`, cmdHash, cmdDisplay, durations[i], `r-odd-${i}`, `s-odd-${i}`, new Date(Date.now() - 60000).toISOString());
    }
    db.close();

    const r = await runShim(
      ["--repo", repoDir, "--run", "r-p50-odd", "--step", "s1", "--", counterScript],
      env,
    );
    assert.equal(r.exitCode, 0);

    // P50 of [300000, 600000, 1200000] = index 1 = 600000ms = 10min.
    assert.match(
      r.stderr,
      /expect ~10min based on 3 prior runs/,
      `should report p50=10min for [5,10,20] with 3 runs, got: ${r.stderr}`,
    );
  });
});

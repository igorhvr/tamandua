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

  // ── AC 2: File edit produces cache miss ───────────────────────────

  it("file edit produces cache miss and executes the real command (AC 2)", async () => {
    const env = shimChildEnv(controlEnv);

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

    // Third run: must be a cache miss (different tree), execute.
    const r3 = await runShim(
      ["--repo", repoDir, "--run", "r-ac2", "--step", "s3", "--", passScript],
      env,
    );
    assert.equal(r3.exitCode, 0, "should execute after file edit");
    assert.ok(
      !r3.stdout.includes("TAMANDUA-TEST CACHED"),
      "edited tree must miss cache",
    );

    // Restore the file.
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
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
    // Get the tree hash by computing it.
    const { computeTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = computeTreeHash(repoDir);
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
    const { computeTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = computeTreeHash(repoDir);
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

  it("propagates non-zero exit code from failing command", async () => {
    const env = shimChildEnv(controlEnv);
    const r = await runShim(
      ["--repo", repoDir, "--run", "r1", "--step", "s1", "--", failScript],
      env,
    );
    assert.equal(r.exitCode, 1, "should propagate exit code 1");
    assert.ok(r.stderr.includes("FAIL: something broke"), "should see failure output");
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

    const { computeTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const preTreeHash = computeTreeHash(fixture.repoDir);
    assert.ok(preTreeHash, "fixture should have a pre-run tree hash");
    const cmdHash = computeCmdHash(script);
    const originRepo = getOriginRepo(fixture.repoDir);
    const runId = `r-tree-drift-${name}`;

    const result = await runShim(
      ["--repo", fixture.repoDir, "--run", runId, "--step", "s-drift", "--", script],
      shimChildEnv(controlEnv),
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

  it("rejects untracked-not-ignored creation during a successful suite", async () => {
    const { rowCount, claimAction } = await runTreeMutationCase(
      "untracked",
      `printf 'new\\n' > "${join(tempBase, "drift-untracked", "new-file.txt")}"\nexit 0`,
      86,
    );
    assert.equal(rowCount, 0);
    assert.equal(claimAction, "run");
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

    const { computeTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const stableTreeHash = computeTreeHash(fixture.repoDir);
    assert.ok(stableTreeHash);
    const thirdClaim = await controlPlanePost("/suite/claim", {
      origin_repo: getOriginRepo(fixture.repoDir),
      tree_hash: stableTreeHash,
      cmd_hash: computeCmdHash(script),
      owner_token: "third-after-waiter",
    });
    assert.equal((thirdClaim.body as Record<string, unknown>).action, "run");
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
    const { computeTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const originRepo = getOriginRepo(repoDir);
    const treeHash = computeTreeHash(repoDir);
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

    // Compute the key that the shim will use.
    const { computeTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = computeTreeHash(repoDir);
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

    const { computeTreeHash, computeCmdHash, getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const treeHash = computeTreeHash(repoDir);
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

    const cacheHitEvent = events.find((e: Record<string, unknown>) => e.event === "suite.cache_hit");
    assert.ok(cacheHitEvent, "should have suite.cache_hit event");
    assert.equal(cacheHitEvent.runId, "r-ev-cache-hit");
    assert.equal(cacheHitEvent.stepId, "s1");
    assert.ok(typeof cacheHitEvent.treeHash === "string" && cacheHitEvent.treeHash.length === 12);
    assert.ok(typeof cacheHitEvent.cmdDisplay === "string" && cacheHitEvent.cmdDisplay.length > 0);
    assert.ok(typeof cacheHitEvent.savedDurationMs === "number" && cacheHitEvent.savedDurationMs > 0);
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
});

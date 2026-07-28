import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import { claimStep, completeStep } from "../dist/installer/step-ops.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(__dirname, "..");

// ══════════════════════════════════════════════════════════════════════
// TSTX-PQ: Shell execution test — verifies the POSIX quoting of the
// generated tamandua-test wrapper by executing it through /bin/sh -c
// in a repository path that contains spaces, quotes, and shell
// metacharacters.
// ══════════════════════════════════════════════════════════════════════

describe("TSTX-PQ shell execution (POSIX quoting)", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  const th = createTempHome("tamandua-tstx-pq-shell-");

  let repoPath: string;
  let fakeBinDir: string;
  let sideEffectFile: string;

  before(() => {
    process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
    process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");

    // Create a temporary directory that will serve as our fake "repo" with
    // a path that exercises every shell-quoting hazard: spaces, single quotes,
    // and filename-safe shell metacharacters (;, $(), &).
    // We use a subdirectory of the temp home so we control the full path.
    const repoName = "repo with spaces & semi; and dollar$(touch repo-name-injected) and quote'here";
    repoPath = path.join(th.homeDir, repoName);
    fs.mkdirSync(repoPath, { recursive: true });
    // Initialize it as a git repo so the production code can compute hashes etc.
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repoPath, stdio: "pipe" });
    // Create a minimal file and commit so git doesn't complain about empty repo
    fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });

    // Create a fake tamandua-test executable that records its argv losslessly
    // and executes the raw payload after --.
    fakeBinDir = path.join(th.homeDir, "fake-bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });

    sideEffectFile = path.join(th.homeDir, "fake-test-side-effect.txt");

    const fakeShim = path.join(fakeBinDir, "tamandua-test");
    // This script:
    // 1. Records argv ($@ only, 8 parts) NUL-delimited to a known file
    // 2. Finds the raw command after --
    // 3. Executes it via /bin/sh -c (direct invocation, no eval pass)
    fs.writeFileSync(fakeShim, `#!/bin/sh
# Fake tamandua-test: record argv and execute raw command after --
RECORD_FILE="\${TSTX_PQ_ARGV_FILE:?TSTX_PQ_ARGV_FILE is required}"

# Record args NUL-delimited ($@ only — 8 parts matching production shim)
printf '%s\\0' "\$@" > "\$RECORD_FILE"

# Find and execute the raw command after --
cmd=""
found_dash=0
for arg in "\$@"; do
  if [ "\$found_dash" = "1" ]; then
    cmd="\$arg"
    break
  fi
  if [ "\$arg" = "--" ]; then
    found_dash=1
  fi
done

if [ -n "\$cmd" ]; then
  # Execute via separate shell invocation (no eval pass, matching production semantics)
  /bin/sh -c "\$cmd"
fi
exit 0
`);
    fs.chmodSync(fakeShim, 0o755);
  });

  after(() => {
    // Cleanup env
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    // Cleanup temp files
    try { fs.unlinkSync(sideEffectFile); } catch { /* ok */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("produced wrapper survives real /bin/sh -c with metacharacter-rich repo path", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const stepIdStr = "fixer";
    const now = ts();

    // Raw command: embedded single quotes, env prefix, &&, pipeline, real newline.
    // The backslash-newline is a shell line continuation so the pipeline is valid.
    const rawCmd = "X=hello && echo \"it's working\" \\\n| grep \"it's\"";
    assert.ok(rawCmd.includes("\n"), "test fixture must contain a real newline byte");
    // Side effect: append marker line (>> not >, to catch double-execution)
    const fullRawCmd = `${rawCmd} && echo "done-ok" >> "${sideEffectFile}"`;

    const seededContext = JSON.stringify({
      task: "shell quoting test",
      repo: repoPath,
      test_cmd: fullRawCmd,
      build_cmd: "echo build",
    });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'tstx-pq-shell', 'shell quoting test', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, ?, 'tstx-pq-shell_fixer', 0, 'Run: {{test_cmd}} | Raw: {{test_cmd_raw}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(stepUuid, runId, stepIdStr, now, now);

    // Obtain the generated wrapper through normal production claim/render path
    const claim = claimStep("tstx-pq-shell_fixer", runId);
    assert.ok(claim.found, "claimStep should find the pending step");
    const resolvedInput = claim!.resolvedInput!;

    // The resolved input should contain the wrapper. Extract it.
    // The input template is "Run: {{test_cmd}} | Raw: {{test_cmd_raw}}"
    // So the wrapper is after "Run: " and before " | Raw:"
    const prefix = "Run: ";
    const suffix = " | Raw:";
    const prefixIdx = resolvedInput.indexOf(prefix);
    const suffixIdx = resolvedInput.indexOf(suffix);
    assert.ok(prefixIdx !== -1, `resolved input should contain "${prefix}"`);
    assert.ok(suffixIdx !== -1, `resolved input should contain "${suffix}"`);
    const wrapper = resolvedInput.slice(prefixIdx + prefix.length, suffixIdx);

    // Verify the wrapper contains POSIX-quoted arguments
    assert.ok(wrapper.startsWith("tamandua-test"), `wrapper should start with tamandua-test, got: ${wrapper.slice(0, 100)}`);
    assert.ok(wrapper.includes("'"), "wrapper should contain single-quoted arguments");

    // Execute the wrapper via /bin/sh -c
    const argvFile = path.join(th.homeDir, "recorded-argv.txt");
    const env = cleanChildEnv({
      HOME: th.homeDir,
      TAMANDUA_STATE_DIR: th.tamanduaDir,
      TAMANDUA_DB_PATH: path.join(th.tamanduaDir, "tamandua.db"),
      PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
      TSTX_PQ_ARGV_FILE: argvFile,
    });

    try {
      // Use argument-vector API (matching production harness), not string interpolation.
      // No test-side re-escaping — the wrapper is passed verbatim as argv[2] to /bin/sh.
      execFileSync("/bin/sh", ["-c", wrapper], {
        cwd: repoPath,
        env,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      const stderr = err.stderr?.toString() || "";
      const stdout = err.stdout?.toString() || "";
      assert.fail(
        `Shell execution failed with: ${stderr || stdout || String(e)}. Wrapper: ${wrapper.slice(0, 200)}`
      );
    }

    // Read the recorded argv file (NUL-delimited)
    assert.ok(fs.existsSync(argvFile), "recorded argv file should exist after execution");
    const argvRaw = fs.readFileSync(argvFile);
    const argvParts = argvRaw.toString().split("\0").filter((s) => s.length > 0);

    // Expected: tamandua-test --repo <repoPath> --run <runId> --step <stepId> -- <rawCmd>
    // $@ only (8 parts: --repo, repo, --run, runId, --step, stepId, --, rawCmd)
    assert.equal(argvParts.length, 8, `argv should have 8 parts, got ${argvParts.length}: ${argvParts.join(" | ")}`);
    assert.equal(argvParts[0], "--repo", "argv[0] is --repo");
    // argv[1] must be exactly the repo path (byte-for-byte)
    assert.equal(argvParts[1], repoPath, `argv[1] repo must be exact byte-for-byte match. Expected: "${repoPath}", got: "${argvParts[1]}"`);
    assert.equal(argvParts[2], "--run", "argv[2] is --run");
    assert.equal(argvParts[3], runId, "argv[3] is the run ID");
    assert.equal(argvParts[4], "--step", "argv[4] is --step");
    assert.equal(argvParts[5], stepIdStr, "argv[5] is the step ID");
    assert.equal(argvParts[6], "--", "argv[6] is --");
    // argv[7] must be exactly the raw command (byte-for-byte)
    assert.equal(argvParts[7], fullRawCmd, `argv[7] raw command must be exact byte-for-byte match`);

    // Injection sentinel: if posixQuoteArg were broken and the repo path were
    // interpolated unquoted, $(touch repo-name-injected) would create this file.
    assert.ok(
      !fs.existsSync(path.join(repoPath, "repo-name-injected")),
      "injection side-effect must not exist — repo-name-injected should not be created"
    );

    // Verify the side effect: the fake shim should have executed the raw command
    assert.ok(fs.existsSync(sideEffectFile), "side effect file should exist — raw command was executed");
    const sideEffectContent = fs.readFileSync(sideEffectFile, "utf-8").trim();
    const sideEffectLines = sideEffectContent.split("\n").filter((l) => l.length > 0);
    assert.equal(sideEffectLines.length, 1, `side effect file should contain exactly one line (append semantics), got ${sideEffectLines.length}: ${sideEffectContent}`);
    assert.equal(sideEffectLines[0], "done-ok", `side effect content should be "done-ok", got: "${sideEffectLines[0]}"`);

    // Cleanup the step
    completeStep(claim!.stepId!, "STATUS: done\nCHANGES: shell quoting verified\nTESTS: pass");
  });
});

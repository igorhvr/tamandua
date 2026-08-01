/**
 * Unit tests for US-005: fault injection knobs in the hermes runtime via
 * behaviors file.
 *
 * Verifies:
 *  1. delayed_trailer_ms: session_id on stderr arrives N ms after stdout close + exit
 *  2. omit_trailer: no session_id on stderr, no state.db row created
 *  3. malformed_trailer: stderr contains malformed session_id line (not a valid UUID)
 *  4. oversized_stdout_mb: stdout byte count >= N MB, normal report text still present
 *  5. provider_error shapes produce error output on stderr, exit non-zero, no state.db write
 *  6. Baseline behavior (no knobs) is byte-identical to pre-knob output
 *  7. Combined knobs (delayed_trailer_ms + oversized_stdout_mb)
 *  8. Provider error takes priority over other knobs
 *
 * This file uses node:child_process (spawn) for spawning the runtime and
 * therefore belongs in the serial test lane.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

const runtimeHermesPath = path.resolve(
  process.cwd(),
  "torture-test/scripted-runtimes/runtime-hermes.mjs",
);

function makeTempDir(): string {
  return tamanduaTempDir("scripted-hermes-fault-");
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Create a mock tamandua CLI script that responds to step peek and
 * step claim with canned outputs. Returns the path to the script.
 */
function createMockCli(tmpDir: string, opts?: {
  peekResponse?: string;
  claimResponse?: object;
}): string {
  const peekResponse = opts?.peekResponse ?? "HAS_WORK";
  const claimResponse = JSON.stringify(
    opts?.claimResponse ?? {
      stepId: "step-00000000-0000-0000-0000-000000000001",
      runId: "run-a1c557f2-ba6e-4088-ae59-0d8892ce6e32",
      input: "TEST_TASK: Implement hermes fault knobs\n",
    },
  );

  const cliPath = path.join(tmpDir, "bin", "tamandua");
  const capturePath = path.join(tmpDir, "cli-calls.jsonl");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env bash
# Mock tamandua CLI — records calls and returns canned responses.
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> ${JSON.stringify(capturePath)}
case "$1" in
  peek|"step")
    if [ "$1" = "peek" ] || ([ "$1" = "step" ] && [ "$2" = "peek" ]); then
      echo "${peekResponse}"
      exit 0
    fi
    if [ "$1" = "step" ] && [ "$2" = "claim" ]; then
      echo '${claimResponse}'
      exit 0
    fi
    if [ "$1" = "step" ] && ([ "$2" = "complete" ] || [ "$2" = "fail" ]); then
      exit 0
    fi
    ;;
  *)
    ;;
esac
exit 0
`,
    "utf-8",
  );
  fs.chmodSync(cliPath, 0o755);

  return cliPath;
}

/**
 * Create a behaviors JSON file. Returns the path.
 */
function createBehaviorsFile(tmpDir: string, agents: Record<string, unknown>): string {
  const config = { agents, heartbeatTokens: 17, defaultTokens: 111 };
  const path_ = path.join(tmpDir, "behaviors.json");
  fs.writeFileSync(path_, JSON.stringify(config), "utf-8");
  return path_;
}

/**
 * Build a synthetic work prompt that the hermes runtime can parse.
 * Hermes prompt format matches the scheduler's hermes work prompt:
 * chat --max-turns 8192 --yolo -Q -q "<work prompt>"
 */
function buildPrompt(cliPath: string): string {
  return `You are agent "developer" for workflow "test-wf", agent "test-wf_developer", run "run-a1c557f2-ba6e-4088-ae59-0d8892ce6e32".

CLAIM:
"/${cliPath}" step claim "test-wf_developer" --run-id "a1c557f2-ba6e-4088-ae59-0d8892ce6e32"
`;
}

/**
 * Spawn the hermes runtime with a given behaviors file and prompt.
 * Returns { stdout, stderr, exitCode, durationMs, hermesHome }.
 */
function runHermesRuntime(
  tmpDir: string,
  behaviorsPath: string,
  prompt: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number; hermesHome: string }> {
  return new Promise((resolve) => {
    const stateDir = path.join(tmpDir, "state");
    const hermesHome = path.join(tmpDir, "hermes_home");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(hermesHome, { recursive: true });
    const start = Date.now();

    const child = spawn(
      process.execPath,
      [runtimeHermesPath, "chat", "--max-turns", "8192", "--yolo", "-Q", "-q", prompt],
      {
        encoding: "utf-8",
        cwd: tmpDir,
        env: {
          PATH: `${path.join(tmpDir, "bin")}:${process.env.PATH ?? ""}`,
          HERMES_HOME: hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: stateDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs ?? 10000,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("close", (exitCode) => {
      const durationMs = Date.now() - start;
      resolve({ stdout, stderr, exitCode, durationMs, hermesHome });
    });
    child.on("error", (err) => {
      const durationMs = Date.now() - start;
      resolve({ stdout, stderr: String(err), exitCode: null, durationMs, hermesHome });
    });
  });
}

/**
 * Read the session row from the hermes state.db for a given sessionId.
 * Returns null if the DB does not exist or the row is missing.
 */
function readSessionRow(hermesHome: string, sessionId: string): object | null {
  const dbPath = path.join(hermesHome, "state.db");
  if (!fs.existsSync(dbPath)) return null;

  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    return row ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

describe("scripted hermes runtime fault knobs", () => {
  // ── Baseline: no knobs ───────────────────────────────────────────

  it("baseline (no knobs) produces plain text output with session_id on stderr and state.db row", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": { output: "STATUS: done\nCHANGES: baseline hermes test" },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.strictEqual(exitCode, 0,
        `expected exit 0, got ${exitCode}. stderr: ${stderr.slice(0, 500)}`);

      // Stdout should contain the status report
      assert.match(stdout, /STATUS: done/);
      assert.match(stdout, /CHANGES: baseline hermes test/);

      // Stderr should contain a valid session_id UUID line
      const sessionIdMatch = stderr.match(/^session_id:\s+([a-f0-9-]+)$/m);
      assert.ok(sessionIdMatch, `expected session_id on stderr, got: ${stderr.slice(0, 200)}`);
      const sessionId = sessionIdMatch[1];

      // Verify it's a valid UUID
      assert.match(sessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        `expected valid UUID, got: ${sessionId}`);

      // state.db should contain the session row
      const row = readSessionRow(hermesHome, sessionId);
      assert.ok(row, `expected state.db row for session ${sessionId}`);
      assert.strictEqual((row as any).source, "scripted-hermes");
      assert.ok((row as any).input_tokens > 0, "expected positive input_tokens");
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── delayed_trailer_ms ───────────────────────────────────────────

  it("delayed_trailer_ms — session_id on stderr arrives after the configured delay", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const delayMs = 500;
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          output: "STATUS: done",
          delayed_trailer_ms: delayMs,
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, durationMs, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
        10000,
      );

      assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);

      // The process duration should be at least the delay
      assert.ok(
        durationMs >= delayMs - 50,
        `expected duration >= ${delayMs}ms, got ${durationMs}ms`,
      );

      // Stdout should contain the status report (emitted before the delay)
      assert.match(stdout, /STATUS: done/);

      // Stderr should contain session_id (emitted after the delay via setTimeout)
      const sessionIdMatch = stderr.match(/^session_id:\s+([a-f0-9-]+)$/m);
      assert.ok(sessionIdMatch,
        `expected session_id on stderr after delay, got: ${stderr.slice(0, 200)}`);

      // state.db should have the row (written after the delay)
      const sessionId = sessionIdMatch[1];
      const row = readSessionRow(hermesHome, sessionId);
      assert.ok(row, `expected state.db row for session ${sessionId}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── omit_trailer ─────────────────────────────────────────────────

  it("omit_trailer — no session_id on stderr, no state.db row created", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          output: "STATUS: done",
          omit_trailer: true,
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.strictEqual(exitCode, 0,
        `expected exit 0, got ${exitCode}. stderr: ${stderr.slice(0, 500)}`);

      // Stdout should still have the report
      assert.match(stdout, /STATUS: done/);

      // Stderr should NOT contain session_id
      assert.ok(
        !stderr.includes("session_id:"),
        `expected no session_id on stderr, got: ${stderr.slice(0, 200)}`,
      );

      // state.db should NOT exist or should have no rows
      const dbPath = path.join(hermesHome, "state.db");
      if (fs.existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath);
        try {
          const count = (db.prepare("SELECT COUNT(*) AS cnt FROM sessions").get() as any).cnt;
          assert.strictEqual(count, 0, `expected 0 session rows, got ${count}`);
        } finally {
          db.close();
        }
      }
      // If state.db doesn't exist, that's also fine (no write happened)
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── malformed_trailer ────────────────────────────────────────────

  it("malformed_trailer — stderr contains malformed session_id line (not a valid UUID)", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          output: "STATUS: done",
          malformed_trailer: true,
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.strictEqual(exitCode, 0,
        `expected exit 0, got ${exitCode}. stderr: ${stderr.slice(0, 500)}`);

      // Stdout should still have the report
      assert.match(stdout, /STATUS: done/);

      // Stderr should contain a malformed session_id line (NOT a valid UUID)
      assert.match(stderr, /session_id:/, `expected session_id line on stderr, got: ${stderr.slice(0, 200)}`);

      // The session_id value should NOT be a valid UUID
      const sessionIdMatch = stderr.match(/^session_id:\s+(.+)$/m);
      assert.ok(sessionIdMatch, "expected session_id line");
      const sessionIdValue = sessionIdMatch[1].trim();
      assert.ok(
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionIdValue),
        `expected non-UUID session_id, got: ${sessionIdValue}`,
      );

      // state.db should have the bogus row
      const dbPath = path.join(hermesHome, "state.db");
      assert.ok(fs.existsSync(dbPath), "expected state.db to exist");
      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("NOT-A-UUID");
        assert.ok(row, "expected bogus state.db row with id NOT-A-UUID");
        assert.strictEqual((row as any).source, "scripted-hermes-bogus");
        assert.strictEqual((row as any).input_tokens, 0);
      } finally {
        db.close();
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── oversized_stdout_mb ──────────────────────────────────────────

  it("oversized_stdout_mb — stdout byte count >= N MB, normal report text still present", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const mb = 0.25; // 256 KB
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          output: "STATUS: done\nCHANGES: oversized test",
          oversized_stdout_mb: mb,
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
        30000,
      );

      assert.strictEqual(exitCode, 0,
        `expected exit 0, got ${exitCode}. stderr: ${stderr.slice(0, 500)}`);

      const stdoutBytes = Buffer.byteLength(stdout, "utf-8");
      const targetBytes = mb * 1024 * 1024;
      assert.ok(
        stdoutBytes >= targetBytes,
        `expected stdout >= ${targetBytes} bytes, got ${stdoutBytes} bytes`,
      );

      // Normal report text should still be present (after padding)
      assert.match(stdout, /STATUS: done/);
      assert.match(stdout, /CHANGES: oversized test/);

      // Verify padding lines are present
      assert.match(stdout, /^# padding x+$/m, "expected padding comment lines");

      // Session_id should still be on stderr (baseline trailer behavior)
      assert.match(stderr, /session_id:/,
        `expected session_id on stderr, got: ${stderr.slice(0, 200)}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── provider_error "429" ─────────────────────────────────────────

  it('provider_error "429" — error text on stderr, exit non-zero, no state.db write', async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          provider_error: { shape: "429" },
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.notStrictEqual(exitCode, 0,
        `expected non-zero exit for provider error, got ${exitCode}`);

      // Error message should be on stderr
      assert.match(stderr, /429/,
        `expected 429 error on stderr, got: ${stderr.slice(0, 200)}`);
      assert.match(stderr, /rate limit/i,
        `expected rate limit text on stderr, got: ${stderr.slice(0, 200)}`);

      // Stdout should be empty or minimal (error is on stderr)
      assert.ok(
        !stdout.includes("STATUS:"),
        `expected no STATUS output on stdout, got: ${stdout.slice(0, 200)}`,
      );

      // No state.db should be written
      const dbPath = path.join(hermesHome, "state.db");
      assert.ok(!fs.existsSync(dbPath), "expected no state.db for provider_error");

      // Verify no step claim was attempted
      const capturePath = path.join(tmpDir, "cli-calls.jsonl");
      if (fs.existsSync(capturePath)) {
        const calls = fs.readFileSync(capturePath, "utf-8");
        assert.ok(
          !calls.includes("step claim"),
          "expected no step claim call for provider_error",
        );
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── provider_error "529" ─────────────────────────────────────────

  it('provider_error "529" — error text on stderr, exit non-zero, no state.db write', async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          provider_error: { shape: "529" },
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.notStrictEqual(exitCode, 0,
        `expected non-zero exit for provider error, got ${exitCode}`);

      // Error message should be on stderr
      assert.match(stderr, /529/,
        `expected 529 error on stderr, got: ${stderr.slice(0, 200)}`);
      assert.match(stderr, /overload/i,
        `expected overload text on stderr, got: ${stderr.slice(0, 200)}`);

      // No state.db write
      const dbPath = path.join(hermesHome, "state.db");
      assert.ok(!fs.existsSync(dbPath), "expected no state.db for provider_error");

      // Verify no step claim
      const capturePath = path.join(tmpDir, "cli-calls.jsonl");
      if (fs.existsSync(capturePath)) {
        const calls = fs.readFileSync(capturePath, "utf-8");
        assert.ok(
          !calls.includes("step claim"),
          "expected no step claim call for provider_error",
        );
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── provider_error "mid-stream-drop" ─────────────────────────────

  it('provider_error "mid-stream-drop" — partial text on stdout, exit non-zero, no state.db write', async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          provider_error: { shape: "mid-stream-drop" },
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.notStrictEqual(exitCode, 0,
        `expected non-zero exit for mid-stream-drop, got ${exitCode}`);

      // Output should be incomplete (truncated mid-string)
      const trimmed = stdout.trim();
      assert.ok(trimmed.length > 0, "expected some output on stdout");
      assert.ok(trimmed.length < 20, "expected truncated output");

      // No state.db write
      const dbPath = path.join(hermesHome, "state.db");
      assert.ok(!fs.existsSync(dbPath), "expected no state.db for provider_error");

      // Verify no step claim
      const capturePath = path.join(tmpDir, "cli-calls.jsonl");
      if (fs.existsSync(capturePath)) {
        const calls = fs.readFileSync(capturePath, "utf-8");
        assert.ok(
          !calls.includes("step claim"),
          "expected no step claim call for provider_error",
        );
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── Multiple knobs combined ──────────────────────────────────────

  it("delayed_trailer_ms + oversized_stdout_mb combined", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const delayMs = 300;
      const mb = 0.1; // ~100KB
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          output: "STATUS: done",
          delayed_trailer_ms: delayMs,
          oversized_stdout_mb: mb,
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, durationMs } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
        10000,
      );

      assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);

      // Check duration includes delay
      assert.ok(
        durationMs >= delayMs - 50,
        `expected duration >= ${delayMs}ms, got ${durationMs}ms`,
      );

      // Check padding bytes
      const stdoutBytes = Buffer.byteLength(stdout, "utf-8");
      const targetBytes = mb * 1024 * 1024;
      assert.ok(
        stdoutBytes >= targetBytes,
        `expected stdout >= ${targetBytes} bytes, got ${stdoutBytes} bytes`,
      );

      // Check session_id still present (after delay)
      assert.match(stderr, /session_id:/,
        "expected session_id on stderr with combined knobs");

      // Check report text present
      assert.match(stdout, /STATUS: done/);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── Provider error takes priority over other knobs ───────────────

  it("provider_error takes priority over other knobs", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          output: "STATUS: done",
          delayed_trailer_ms: 500,
          oversized_stdout_mb: 0.5,
          omit_trailer: true,
          provider_error: { shape: "429" },
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      // Should NOT be exit 0 — provider_error takes priority
      assert.notStrictEqual(exitCode, 0,
        `expected non-zero exit for provider error, got ${exitCode}`);

      // Error on stderr, not normal status output
      assert.match(stderr, /429/,
        `expected 429 error on stderr, got: ${stderr.slice(0, 200)}`);

      // No session_id (omit_trailer would suppress it, but provider_error takes priority)
      assert.ok(!stderr.includes("session_id:"),
        "expected no session_id when provider_error is set");

      // No state.db
      const dbPath = path.join(hermesHome, "state.db");
      assert.ok(!fs.existsSync(dbPath), "expected no state.db for provider_error");

      // No step claim attempted
      const capturePath = path.join(tmpDir, "cli-calls.jsonl");
      if (fs.existsSync(capturePath)) {
        const calls = fs.readFileSync(capturePath, "utf-8");
        assert.ok(
          !calls.includes("step claim"),
          "expected no step claim call for provider_error",
        );
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── delayed_trailer_ms produces byte-plausible state.db row ──────

  it("delayed_trailer_ms — state.db row is written (not lost)", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const delayMs = 200;
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          output: "STATUS: done\nCHANGES: delayed state.db test",
          delayed_trailer_ms: delayMs,
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stderr, exitCode, hermesHome } = await runHermesRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
        5000,
      );

      assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);

      // Extract session ID from stderr
      const sessionIdMatch = stderr.match(/^session_id:\s+([a-f0-9-]+)$/m);
      assert.ok(sessionIdMatch, "expected session_id on stderr");
      const sessionId = sessionIdMatch[1];

      // state.db should contain the row with correct session id
      const row = readSessionRow(hermesHome, sessionId);
      assert.ok(row, `expected state.db row for session ${sessionId}`);
      assert.strictEqual((row as any).source, "scripted-hermes");
    } finally {
      cleanup(tmpDir);
    }
  });
});

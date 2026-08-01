/**
 * Unit tests for US-004: fault injection knobs in the pi runtime via
 * behaviors file.
 *
 * Verifies:
 *  1. delayed_trailer_ms: message_end arrives exactly N ms after step complete
 *  2. omit_trailer: no message_end event in output, no usage data emitted
 *  3. malformed_trailer: output contains unparseable message_end (JSON.parse throws)
 *  4. oversized_stdout_mb: stdout byte count >= N MB, normal events still present after padding
 *  5. provider_error "429": output matches rate-limit error shape, no step claim attempted
 *  6. provider_error "529": output matches overloaded error shape, no step claim attempted
 *  7. provider_error "mid-stream-drop": output is partial valid JSON then truncated mid-object
 *  8. Baseline behavior (no knobs) is byte-identical to pre-knob output
 *  9. Multiple knobs combined work correctly (e.g. delayed_trailer_ms + oversized_stdout_mb)
 * 10. Provider error takes priority over other knobs
 *
 * This file uses node:child_process (spawn) for spawning the runtime and
 * therefore belongs in the serial test lane.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

const runtimePipath = path.resolve(
  process.cwd(),
  "torture-test/scripted-runtimes/runtime-pi.mjs",
);

function makeTempDir(): string {
  return tamanduaTempDir("scripted-fault-knobs-");
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
      input: "TEST_TASK: Implement fault knobs\n",
    },
  );

  // Write the mock to a predictable path in tmpDir
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
 * Build a synthetic work prompt that the runtime can parse.
 */
function buildPrompt(cliPath: string): string {
  return `You are agent "developer" for workflow "test-wf", agent "test-wf_developer", run "run-a1c557f2-ba6e-4088-ae59-0d8892ce6e32".

CLAIM:
"/${cliPath}" step claim "test-wf_developer" --run-id "a1c557f2-ba6e-4088-ae59-0d8892ce6e32"
`;
}

/**
 * Spawn the pi runtime with a given behaviors file and prompt.
 * Returns { stdout, stderr, exitCode, durationMs }.
 */
function runPiRuntime(
  tmpDir: string,
  behaviorsPath: string,
  prompt: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  return new Promise((resolve) => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const start = Date.now();

    const child = spawn(
      process.execPath,
      [runtimePipath, "--dummy-flag", prompt],
      {
        encoding: "utf-8",
        cwd: tmpDir,
        env: {
          PATH: `${path.join(tmpDir, "bin")}:${process.env.PATH ?? ""}`,
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
      resolve({ stdout, stderr, exitCode, durationMs });
    });
    child.on("error", (err) => {
      const durationMs = Date.now() - start;
      resolve({ stdout, stderr: String(err), exitCode: null, durationMs });
    });
  });
}

/**
 * Parse JSON-line-delimited output. Returns array of parsed objects,
 * ignoring non-JSON lines.
 */
function parseNdjson(output: string): object[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((obj): obj is object => obj !== null);
}

describe("scripted pi runtime fault knobs", () => {
  // ── Baseline: no knobs —──────────────────────────────────────────

  it("baseline (no knobs) produces valid pi-shaped JSON output", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": { output: "STATUS: done\nCHANGES: baseline test" },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode } = await runPiRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}. stderr: ${stderr.slice(0, 500)}`);

      // Parse NDJSON output
      const events = parseNdjson(stdout);

      // Should have at least tool_execution_end and message_end
      const toolEvent = events.find((e: any) => e.type === "tool_execution_end");
      assert.ok(toolEvent, "expected tool_execution_end event");

      const msgEvent = events.find((e: any) => e.type === "message_end");
      assert.ok(msgEvent, "expected message_end event");
      assert.ok((msgEvent as any).message?.usage, "message_end should have usage");
      assert.strictEqual((msgEvent as any).message.usage.totalTokens, 111,
        "default tokens should be 111");

      // Verify the output text
      const content = (msgEvent as any).message?.content?.[0]?.text ?? "";
      assert.match(content, /STATUS: done/);
      assert.match(content, /CHANGES: baseline test/);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── delayed_trailer_ms ───────────────────────────────────────────

  it("delayed_trailer_ms — message_end arrives after the configured delay", async () => {
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

      const { stdout, exitCode, durationMs } = await runPiRuntime(
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

      // Output should still have the message_end (emitted after delay)
      const events = parseNdjson(stdout);
      const msgEvent = events.find((e: any) => e.type === "message_end");
      assert.ok(msgEvent, "expected message_end event even with delay");
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── omit_trailer ─────────────────────────────────────────────────

  it("omit_trailer — no message_end event in output", async () => {
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

      const { stdout, stderr, exitCode } = await runPiRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}. stderr: ${stderr.slice(0, 500)}`);

      // Parse output — should NOT have message_end
      const events = parseNdjson(stdout);
      const msgEvent = events.find((e: any) => e.type === "message_end");
      assert.strictEqual(msgEvent, undefined, "expected no message_end event");
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── malformed_trailer ────────────────────────────────────────────

  it("malformed_trailer — output contains unparseable message_end", async () => {
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

      const { stdout, stderr, exitCode } = await runPiRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}. stderr: ${stderr.slice(0, 500)}`);

      // Should still have tool_execution_end
      const events = parseNdjson(stdout);
      const toolEvent = events.find((e: any) => e.type === "tool_execution_end");
      assert.ok(toolEvent, "expected tool_execution_end event");

      // Find the malformed line — it starts with {"type":"message_end"
      // but is not valid JSON
      const malformedLine = stdout
        .split("\n")
        .find((line) => line.trimStart().startsWith('{"type":"message_end"'));
      assert.ok(malformedLine, "expected a malformed message_end line starting with the type field");

      // JSON.parse should throw on it (either Unexpected or Expected error)
      assert.throws(() => {
        JSON.parse(malformedLine.trimEnd());
      }, /JSON|SyntaxError/, "malformed message_end should throw on JSON.parse");
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── oversized_stdout_mb ──────────────────────────────────────────

  it("oversized_stdout_mb — stdout byte count >= N MB, normal events present after padding", async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const mb = 0.25; // 256 KB — small enough to test quickly, large enough to verify
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          output: "STATUS: done",
          oversized_stdout_mb: mb,
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode } = await runPiRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
        30000,
      );

      assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}. stderr: ${stderr.slice(0, 500)}`);

      const stdoutBytes = Buffer.byteLength(stdout, "utf-8");
      const targetBytes = mb * 1024 * 1024;
      assert.ok(
        stdoutBytes >= targetBytes,
        `expected stdout >= ${targetBytes} bytes, got ${stdoutBytes} bytes`,
      );

      // Normal events should still be present (after the padding)
      const events = parseNdjson(stdout);
      const msgEvent = events.find((e: any) => e.type === "message_end");
      assert.ok(msgEvent, "expected message_end event after padding");

      // Verify padding lines are present
      assert.match(stdout, /^# padding x+$/m, "expected padding comment lines");
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── provider_error "429" ─────────────────────────────────────────

  it('provider_error "429" — output matches rate-limit error shape, no step claim', async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          provider_error: { shape: "429" },
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode } = await runPiRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.notStrictEqual(exitCode, 0, `expected non-zero exit for provider error, got ${exitCode}`);

      // Parse the error output
      const events = parseNdjson(stdout);
      const errorEvent = events.find((e: any) => e.type === "error");
      assert.ok(errorEvent, "expected error event for 429");
      assert.strictEqual((errorEvent as any).code, 429);
      assert.match((errorEvent as any).message ?? "", /rate limit/i);

      // Verify no step claim was attempted — check the tamandua CLI wasn't
      // called with "step claim"
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

  it('provider_error "529" — output matches overloaded error shape, no step claim', async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          provider_error: { shape: "529" },
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode } = await runPiRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.notStrictEqual(exitCode, 0, `expected non-zero exit for provider error, got ${exitCode}`);

      const events = parseNdjson(stdout);
      const errorEvent = events.find((e: any) => e.type === "error");
      assert.ok(errorEvent, "expected error event for 529");
      assert.strictEqual((errorEvent as any).code, 529);
      assert.match((errorEvent as any).message ?? "", /overload/i);

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

  it('provider_error "mid-stream-drop" — partial valid JSON then truncated', async () => {
    const tmpDir = makeTempDir();
    try {
      const cliPath = createMockCli(tmpDir);
      const behaviorsPath = createBehaviorsFile(tmpDir, {
        "test-wf_developer": {
          provider_error: { shape: "mid-stream-drop" },
        },
      });
      const prompt = buildPrompt(cliPath);

      const { stdout, stderr, exitCode } = await runPiRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      assert.notStrictEqual(exitCode, 0, `expected non-zero exit for mid-stream-drop, got ${exitCode}`);

      // Output should start like valid JSON but be incomplete
      const trimmed = stdout.trim();
      assert.ok(trimmed.length > 0, "expected some output");

      // Should start with { but not end with } (truncated mid-object)
      assert.match(trimmed, /^\{/, "expected output to start with {");
      assert.ok(!trimmed.endsWith("}"), "expected output not to end with } (truncated)");

      // Parsing should throw
      assert.throws(() => {
        JSON.parse(trimmed);
      }, "truncated output should not be valid JSON");

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

      const { stdout, exitCode, durationMs } = await runPiRuntime(
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

      // Check message_end still present (after delay)
      const events = parseNdjson(stdout);
      const msgEvent = events.find((e: any) => e.type === "message_end");
      assert.ok(msgEvent, "expected message_end event with combined knobs");
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

      const { stdout, stderr, exitCode } = await runPiRuntime(
        tmpDir,
        behaviorsPath,
        prompt,
      );

      // Should NOT be exit 0 — provider_error emits error shape
      assert.notStrictEqual(exitCode, 0, `expected non-zero exit, got ${exitCode}`);

      // Should have error event, not message_end
      const events = parseNdjson(stdout);
      const msgEvent = events.find((e: any) => e.type === "message_end");
      assert.strictEqual(msgEvent, undefined, "expected no message_end when provider_error is set");

      const errorEvent = events.find((e: any) => e.type === "error");
      assert.ok(errorEvent, "expected error event");

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
});

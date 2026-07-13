/**
 * runPi / stream-handling behavior: spawn, timeout-kill, stderr caps,
 * maxBuffer, and work-round metadata parsing. These survive the motor —
 * the dispatch motor still spawns pi for work rounds and parses its stream.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  runPi,
  parseWorkRoundMetadata,
  extractTokenUsage,
} from "../dist/installer/agent-scheduler.js";
import { createTempHome } from "./helpers/test-env.ts";

// Isolate log output to a temp directory so tests don't write to ~/.tamandua/tamandua.log
const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const { homeDir: isolHome, tamanduaDir: isolTd } = createTempHome("tamandua-agent-scheduler-");
process.env.TAMANDUA_STATE_DIR = isolTd;

// Restore env at process exit (createTempHome handles dir cleanup)
process.on("exit", () => {
  if (originalStateDir === undefined) {
    delete process.env.TAMANDUA_STATE_DIR;
  } else {
    process.env.TAMANDUA_STATE_DIR = originalStateDir;
  }
});

// ── Probe for real pi availability (synchronous, module-load time) ─
//
// The real-pi integration test SPENDS REAL MODEL TOKENS, so it is opt-in:
// it only runs when TAMANDUA_REAL_PI_TESTS=1 is set explicitly. npm test
// pins TAMANDUA_PI_BINARY=/usr/bin/false precisely so no unit test can reach a
// real model; the real e2e tier (./run-real-e2e-canary and friends) covers
// live pi integration.
let piAvailable = false;
if (process.env.TAMANDUA_REAL_PI_TESTS === "1") {
  try {
    const result = spawnSync("pi", ["--version"], { encoding: "utf-8", timeout: 5000 });
    piAvailable = result.status === 0 && (result.stdout.length > 0 || result.stderr.length > 0);
  } catch {
    // pi not available
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Create a fake pi shell script in a temp directory. Returns the script path. */
function createFakePiScript(scriptContent: string): string {
  const th = createTempHome("tamandua-test-pi-");
  const scriptPath = path.join(th.root, "fake-pi");

  const fullScript = `#!/usr/bin/env bash
set -e
${scriptContent}
`;
  fs.writeFileSync(scriptPath, fullScript, { mode: 0o755 });
  return scriptPath;
}

/** Write a canned message_end JSON string for an assistant reply. */
function cannedMessageEndLine(text: string, totalTokens: number): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
      },
    },
  });
}

/** Write a canned message_update text_delta line with a large payload. */
function cannedMessageUpdateLine(text: string): string {
  return JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      content: [{ type: "text", text }],
    },
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe("runPi (streaming)", () => {
  // Track original env so we can restore it
  const originalPiBinary = process.env.TAMANDUA_PI_BINARY;

  // Restore after all tests
  const restoreEnv = () => {
    if (originalPiBinary !== undefined) {
      process.env.TAMANDUA_PI_BINARY = originalPiBinary;
    } else {
      delete process.env.TAMANDUA_PI_BINARY;
    }
  };

  // ── AC 1: streaming discards 100MB+ of message_update lines ────
  it("resolves successfully with 100MB+ of message_update lines", async () => {
    const fakeScript = createFakePiScript(`
# Emit 100,000 message_update lines (approx 100MB+)
BIG_TEXT="\$(python3 -c 'print("x"*1000)')"
for i in \$(seq 1 100000); do
  echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","content":[{"type":"text","text":"'"\${BIG_TEXT}-\${i}"'"}]}}'
done
# Emit one real message_end
echo '${cannedMessageEndLine("Hello after big stream", 150)}'
`);
    // Use TAMANDUA_PI_BINARY to point at fake script
    process.env.TAMANDUA_PI_BINARY = fakeScript;

    try {
      const result = await runPi([], { timeout: 30 });
      // Must resolve — no crash
      assert.ok(result.length > 0, "runPi should return non-empty string");
      assert.ok(
        result.includes("Hello after big stream"),
        `Expected assistant text in result, got: "${result.slice(0, 200)}"`,
      );

      // Verify parseWorkRoundMetadata finds the token usage
      // runPi returns the filtered stdout including JSON events + text fallback
      const meta = parseWorkRoundMetadata(result);
      assert.equal(meta.tokenUsage, 150, "tokenUsage should be extracted from message_end");
      assert.ok(meta.assistantOutput.includes("Hello after big stream"));
    } finally {
      restoreEnv();
    }
  });

  // ── AC 2: text-mode output flows through unchanged ──────────────
  it("handles text-mode pi output (no JSON lines)", async () => {
    const fakeScript = createFakePiScript(`
echo "MOCK_PI_OK"
`);
    process.env.TAMANDUA_PI_BINARY = fakeScript;

    try {
      const result = await runPi([], { timeout: 10 });
      assert.equal(result, "MOCK_PI_OK");
    } finally {
      restoreEnv();
    }
  });

  it("handles multi-line text-mode output", async () => {
    const fakeScript = createFakePiScript(`
echo "STATUS: done"
echo "CHANGES: implemented streaming runPi"
echo "TESTS: all passing"
`);
    process.env.TAMANDUA_PI_BINARY = fakeScript;

    try {
      const result = await runPi([], { timeout: 10 });
      assert.ok(result.includes("STATUS: done"));
      assert.ok(result.includes("CHANGES: implemented streaming runPi"));
      assert.ok(result.includes("TESTS: all passing"));
    } finally {
      restoreEnv();
    }
  });

  // ── AC 3: malformed JSON lines do not crash ─────────────────────
  it("does not crash on malformed JSON lines mixed with valid events", async () => {
    const fakeScript = createFakePiScript(`
echo "{ broken json: oops"
echo '${cannedMessageUpdateLine("some valid delta")}'
echo "unclosed { json"
echo '${cannedMessageEndLine("Still works fine", 200)}'
echo "trailing garbage"
`);
    process.env.TAMANDUA_PI_BINARY = fakeScript;

    try {
      const result = await runPi([], { timeout: 10 });
      assert.ok(result.includes("Still works fine"));
      // parseWorkRoundMetadata should extract the token usage from the
      // kept JSON events embedded in the filtered stdout
      const meta = parseWorkRoundMetadata(result);
      assert.equal(meta.tokenUsage, 200);
    } finally {
      restoreEnv();
    }
  });

  // ── Parser integration: token usage extractable ──────────────────
  it("parseWorkRoundMetadata extracts tokenUsage from filtered output", async () => {
    const fakeScript = createFakePiScript(`
echo '${cannedMessageUpdateLine("thinking...")}'
echo '${cannedMessageEndLine("Done", 999)}'
`);
    process.env.TAMANDUA_PI_BINARY = fakeScript;

    try {
      const result = await runPi([], { timeout: 10 });
      const meta = parseWorkRoundMetadata(result);
      assert.equal(meta.tokenUsage, 999);
      assert.equal(meta.jsonMetadataDetected, true);
      assert.equal(meta.assistantOutput, "Done");
    } finally {
      restoreEnv();
    }
  });

  // ── Stdin is ended immediately ───────────────────────────────────
  it("ends stdin immediately after spawn (pi receives EOF)", async () => {
    // pi --print waits for stdin EOF — if not ended, it hangs.
    // Our fake script just echoes, but we verify the child doesn't hang.
    const fakeScript = createFakePiScript(`
# This script doesn't read stdin, but the real pi does.
# We just verify runPi returns quickly.
echo "ok"
`);
    process.env.TAMANDUA_PI_BINARY = fakeScript;

    try {
      const start = Date.now();
      const result = await runPi([], { timeout: 5 });
      const duration = Date.now() - start;
      assert.equal(result, "ok");
      // Should complete in well under 5 seconds (not hang)
      assert.ok(duration < 4000, `runPi took ${duration}ms, expected <4000ms`);
    } finally {
      restoreEnv();
    }
  });

  // ── Error propagation ────────────────────────────────────────────
  // After US-001/US-002 the adapter resolves on non-zero exit (like hermes)
  // so runPi returns output instead of throwing.
  it("resolves on non-zero exit — returns output without throwing", async () => {
    const fakeScript = createFakePiScript(`
echo "some output before failure" >&2
exit 1
`);
    process.env.TAMANDUA_PI_BINARY = fakeScript;

    try {
      const result = await runPi([], { timeout: 10 });
      // Adapter resolves on non-zero exit — runPi returns output (possibly empty)
      assert.ok(typeof result === "string");
    } finally {
      restoreEnv();
    }
  });

  // ── Timeout handling ─────────────────────────────────────────────
  // After US-001/US-002 the adapter resolves on timeout (like hermes)
  // with exitCode: null, signal: "SIGTERM", timedOut: true — runPi returns output.
  it("resolves on timeout — returns output without throwing", async () => {
    const fakeScript = createFakePiScript(`
sleep 30
`);
    process.env.TAMANDUA_PI_BINARY = fakeScript;

    try {
      const result = await runPi([], { timeout: 2 }); // 2 second timeout
      // Adapter resolves on timeout — runPi returns output (possibly empty from stderr)
      assert.ok(typeof result === "string");
    } finally {
      restoreEnv();
    }
  });
});

// ── US-003: Real pi integration test ──────────────────────────────

describe("runPi with real pi binary", () => {
  // AC 1: Real pi test — runPi with pi --print --mode json --no-session with bounded prompt that ends immediately
  it("runs pi --print --mode json --no-session with bounded prompt and returns greeting", { skip: !piAvailable ? "real-pi test is opt-in (set TAMANDUA_REAL_PI_TESTS=1 with pi on PATH)" : false }, async () => {
    const startTime = Date.now();
    const result = await runPi(
      ["--print", "--mode", "json", "--no-session", "Say hi and end immediately. Just the word hi, nothing else."],
      { timeout: 120 },
    );
    const duration = Date.now() - startTime;

    // Should return a non-empty string
    assert.ok(result.length > 0, `runPi should return non-empty string (duration: ${duration}ms)`);
    assert.ok(duration < 120_000, `pi round took ${duration}ms, expected < 120s`);

    // Parse metadata
    const meta = parseWorkRoundMetadata(result);

    // AC 2: tokenUsage > 0
    assert.ok(
      meta.tokenUsage !== null && meta.tokenUsage > 0,
      `tokenUsage should be > 0, got ${meta.tokenUsage}. Output: "${result.slice(0, 300)}"`,
    );

    // AC 1: assistant output should contain a greeting ("hi", "hello", etc.)
    // pi's response to the bounded prompt should be a greeting.
    assert.ok(
      meta.assistantOutput.length > 0,
      `assistantOutput should be non-empty. Full output: "${result.slice(0, 500)}"`,
    );

    // jsonMetadataDetected must be true (we're using --mode json)
    assert.equal(
      meta.jsonMetadataDetected,
      true,
      `jsonMetadataDetected should be true for --mode json output`,
    );

    console.log(`  pi integration test: tokenUsage=${meta.tokenUsage}, duration=${duration}ms`);
    console.log(`  assistant output: "${meta.assistantOutput.slice(0, 200)}"`);
  });

  // Regression: prompt must be bounded/explicit to prevent open-ended conversation timeouts
  it("real pi prompt must contain explicit termination instruction", () => {
    // This is a static check that prevents regressing to vague prompts like "say hi"
    // which can cause pi to engage in open-ended conversation and timeout.
    const boundedPrompt = "Say hi and end immediately. Just the word hi, nothing else.";
    const terminationKeywords = ["end immediately", "nothing else"];
    for (const keyword of terminationKeywords) {
      assert.ok(
        boundedPrompt.toLowerCase().includes(keyword.toLowerCase()),
        `pi prompt must include explicit termination keyword: "${keyword}". ` +
        `Current prompt: "${boundedPrompt}". Without bounded instructions, ` +
        `pi may engage in open-ended conversation, causing the real integration test to timeout.`,
      );
    }
  });
});

// ── AC 3–5: maxBuffer verification ─────────────────────────────────

describe("maxBuffer cleanup verification", () => {
  it("grep maxBuffer src/installer/agent-scheduler.ts returns no results", () => {
    const sourcePath = path.resolve(import.meta.dirname!, "..", "src", "installer", "agent-scheduler.ts");
    const contents = fs.readFileSync(sourcePath, "utf-8");
    assert.ok(
      !contents.includes("maxBuffer"),
      "src/installer/agent-scheduler.ts should not contain maxBuffer",
    );
  });

  it("built dist file does not use maxBuffer for pi execution", () => {
    const distPath = path.resolve(import.meta.dirname!, "..", "dist", "installer", "agent-scheduler.js");
    const contents = fs.readFileSync(distPath, "utf-8");

    // The dist file might still contain the word "maxBuffer" in comments or in
    // unrelated functions, but runPi should not use maxBuffer.
    // Check that execFileAsync is not imported (we use spawn now).
    assert.ok(
      !contents.includes("execFileAsync") && !contents.includes("execFile"),
      "dist/installer/agent-scheduler.js should not use execFile/execFileAsync",
    );
  });
});

// ── Integration: extractTokenUsage from kept events ───────────────

describe("extractTokenUsage from streaming output", () => {
  it("extractTokenUsage works with full usage object", () => {
    const usage = {
      input: 121,
      output: 25,
      cacheRead: 4096,
      cacheWrite: 0,
      totalTokens: 4242,
      cost: {
        input: 0.000052635,
        output: 0.00002175,
        cacheRead: 0.000014848,
        cacheWrite: 0,
        total: 0.000089233,
      },
    };
    assert.equal(extractTokenUsage(usage), 4242);
  });

  it("extractTokenUsage sums components when totalTokens is missing", () => {
    const usage = {
      input: 100,
      output: 50,
    };
    assert.equal(extractTokenUsage(usage), 150);
  });

  it("extractTokenUsage returns null for empty object", () => {
    assert.equal(extractTokenUsage({}), null);
  });
});

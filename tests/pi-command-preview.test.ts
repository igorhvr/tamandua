import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTempHome } from "./helpers/test-env.ts";
import { formatPiCommandPreview } from "../dist/installer/pi-command-preview.js";
import { runPi } from "../dist/installer/agent-scheduler.js";
import { logger } from "../dist/lib/logger.js";

describe("formatPiCommandPreview", () => {
  it("redacts polling prompt payloads and exposes metadata", () => {
    const preview = formatPiCommandPreview("/usr/bin/pi", ["--print", "--no-session", "VERY_SECRET_PROMPT"]);

    assert.equal(preview.argvPreview[2], "<prompt elided>");
    assert.deepEqual(preview.redactedIndices, [2]);
    assert.equal(preview.promptElided, true);
    assert.ok(preview.commandPreview.includes("<prompt elided>"));
    assert.ok(!preview.commandPreview.includes("VERY_SECRET_PROMPT"));
  });

  it("supports --prompt=value form and truncates long args", () => {
    const longArg = "x".repeat(200);
    const preview = formatPiCommandPreview("/usr/bin/pi", ["--prompt=top-secret", "--model", longArg]);

    assert.equal(preview.argvPreview[0], "--prompt=<prompt elided>");
    assert.deepEqual(preview.redactedIndices, [0]);
    assert.deepEqual(preview.truncatedIndices, [2]);
    assert.ok(preview.argvPreview[2].endsWith("…"));
  });

  it("redacts -p flag value (prompt as separate arg)", () => {
    const preview = formatPiCommandPreview("/usr/bin/pi", ["--print", "-p", "secret content"]);

    assert.equal(preview.argvPreview[2], "<prompt elided>");
    assert.deepEqual(preview.redactedIndices, [2]);
    assert.equal(preview.promptElided, true);
  });

  it("redacts --prompt flag value (prompt as separate arg)", () => {
    const preview = formatPiCommandPreview("/usr/bin/pi", ["--print", "--prompt", "secret content"]);

    assert.equal(preview.argvPreview[2], "<prompt elided>");
    assert.deepEqual(preview.redactedIndices, [2]);
    assert.equal(preview.promptElided, true);
  });

  it("redacts prompt with -- separator (forcePositional path)", () => {
    const preview = formatPiCommandPreview("/usr/bin/pi", ["--print", "--", "final positional prompt"]);

    assert.equal(preview.argvPreview[2], "<prompt elided>");
    assert.deepEqual(preview.redactedIndices, [2]);
    assert.equal(preview.promptElided, true);
  });

  it("redacts --prompt=value with -- separator", () => {
    const preview = formatPiCommandPreview("/usr/bin/pi", ["--print", "--", "--prompt=secret"]);

    // After --, all args are positional; last positional is redacted
    assert.equal(preview.promptElided, true);
    assert.ok(preview.commandPreview.includes("<prompt elided>"));
  });

  it("collects -m flag value as non-redacted option value", () => {
    const preview = formatPiCommandPreview("/usr/bin/pi", ["--print", "-m", "claude-sonnet", "prompt here"]);

    // -m flag value should NOT be redacted, but the prompt should be
    assert.ok(preview.argvPreview[2] === "-m" || preview.argvPreview[1] === "-m");
    assert.equal(preview.promptElided, true);
  });

  it("handles CLI flags that take values without redacting flag values", () => {
    // --session takes a value, it should not be redacted
    const preview = formatPiCommandPreview("/usr/bin/pi", [
      "--print", "--session", "my-session-id", "--model", "gpt-4", "prompt text",
    ]);

    assert.equal(preview.promptElided, true);
    // prompt text should be redacted
    assert.ok(preview.argvPreview[5] === "<prompt elided>");
  });

  it("truncates command preview when total length exceeds max", () => {
    // Use very short maxCommandPreviewLength and many args to ensure truncation
    const longPath = "/very/long/path/to/pi/binary/that/is/sixty/chars/!".repeat(3);
    const preview = formatPiCommandPreview(longPath, ["--print", "prompt"], {
      maxCommandPreviewLength: 50,
    });

    assert.equal(preview.commandTruncated, true);
    assert.ok(preview.commandPreview.endsWith("…"));
    assert.ok(preview.commandPreview.length <= 53); // 50 + "…"
  });

  it("returns empty redactedIndices when no prompts present", () => {
    const preview = formatPiCommandPreview("/usr/bin/pi", ["--model", "gpt-4", "--session", "sess1"]);

    assert.deepEqual(preview.redactedIndices, []);
    assert.equal(preview.promptElided, false);
  });
});

describe("runPi logging", () => {
  it("logs pi pre-launch, launch, and completion metadata", async () => {
    const tempDir = createTempHome("tamandua-pi-preview-").root;
    const fakePi = path.join(tempDir, "pi");
    fs.writeFileSync(fakePi, "#!/usr/bin/env node\nprocess.stdout.write('ok-from-fake-pi');\n", "utf-8");
    fs.chmodSync(fakePi, 0o755);

    const secretPrompt = "SENSITIVE_PROMPT_PAYLOAD";
    const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
    process.env.TAMANDUA_PI_BINARY = fakePi;

    const calls: Array<{ level: "info" | "warn" | "error"; message: string; extra?: Record<string, unknown> }> = [];
    const mutableLogger = logger as unknown as {
      info: (message: string, extra?: Record<string, unknown>) => void;
      warn: (message: string, extra?: Record<string, unknown>) => void;
      error: (message: string, extra?: Record<string, unknown>) => void;
    };
    const originalInfo = mutableLogger.info;
    const originalWarn = mutableLogger.warn;
    const originalError = mutableLogger.error;
    mutableLogger.info = (message: string, extra?: Record<string, unknown>) => {
      calls.push({ level: "info", message, extra });
    };
    mutableLogger.warn = (message: string, extra?: Record<string, unknown>) => {
      calls.push({ level: "warn", message, extra });
    };
    mutableLogger.error = (message: string, extra?: Record<string, unknown>) => {
      calls.push({ level: "error", message, extra });
    };

    try {
      const output = await runPi(["--print", "--no-session", secretPrompt], { timeout: 3, workdir: tempDir });
      assert.equal(output, "ok-from-fake-pi");

      const preLaunchLog = calls.find((entry) => entry.level === "info" && entry.message === "pi pre-launch");
      const launchedLog = calls.find((entry) => entry.level === "info" && entry.message === "pi launched");
      const completedLog = calls.find((entry) => entry.level === "info" && entry.message === "pi completed");

      assert.ok(preLaunchLog, "expected a pi pre-launch log entry");
      assert.ok(launchedLog, "expected a pi launched log entry");
      assert.ok(completedLog, "expected a pi completed log entry");

      const serializedPreLaunch = JSON.stringify(preLaunchLog?.extra ?? {});
      assert.ok(serializedPreLaunch.includes("<prompt elided>"));
      assert.ok(!serializedPreLaunch.includes(secretPrompt));
      assert.ok(Object.hasOwn(preLaunchLog?.extra ?? {}, "commandPreview"));
      assert.ok(Object.hasOwn(preLaunchLog?.extra ?? {}, "redactedIndices"));

      assert.equal(typeof launchedLog?.extra?.pid, "number");
      assert.equal(completedLog?.extra?.pid, launchedLog?.extra?.pid);
      assert.equal(typeof completedLog?.extra?.durationMs, "number");
      assert.equal(completedLog?.extra?.exitCode, 0);
      assert.equal(completedLog?.extra?.signal, null);
      assert.equal(completedLog?.extra?.stdoutBytes, Buffer.byteLength("ok-from-fake-pi", "utf-8"));
    } finally {
      mutableLogger.info = originalInfo;
      mutableLogger.warn = originalWarn;
      mutableLogger.error = originalError;
      if (originalPiBinary === undefined) {
        delete process.env.TAMANDUA_PI_BINARY;
      } else {
        process.env.TAMANDUA_PI_BINARY = originalPiBinary;
      }
    }
  });

  it("logs bounded failure metadata with pid and exit outcome", async () => {
    const tempDir = createTempHome("tamandua-pi-failure-").root;
    const fakePi = path.join(tempDir, "pi");
    const longStderr = "E".repeat(800);
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(longStderr)});\nprocess.exit(7);\n`,
      "utf-8",
    );
    fs.chmodSync(fakePi, 0o755);

    const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
    process.env.TAMANDUA_PI_BINARY = fakePi;

    const calls: Array<{ level: "info" | "warn" | "error"; message: string; extra?: Record<string, unknown> }> = [];
    const mutableLogger = logger as unknown as {
      info: (message: string, extra?: Record<string, unknown>) => void;
      warn: (message: string, extra?: Record<string, unknown>) => void;
      error: (message: string, extra?: Record<string, unknown>) => void;
    };
    const originalInfo = mutableLogger.info;
    const originalWarn = mutableLogger.warn;
    const originalError = mutableLogger.error;
    mutableLogger.info = (message: string, extra?: Record<string, unknown>) => {
      calls.push({ level: "info", message, extra });
    };
    mutableLogger.warn = (message: string, extra?: Record<string, unknown>) => {
      calls.push({ level: "warn", message, extra });
    };
    mutableLogger.error = (message: string, extra?: Record<string, unknown>) => {
      calls.push({ level: "error", message, extra });
    };

    try {
      await assert.rejects(() => runPi(["--print", "--no-session", "work"], { timeout: 3, workdir: tempDir }), /pi failed:/);

      const launchedLog = calls.find((entry) => entry.level === "info" && entry.message === "pi launched");
      const failureLog = calls.find((entry) => entry.level === "error" && entry.message === "pi execution failed");
      assert.ok(launchedLog, "expected a pi launched log entry");
      assert.ok(failureLog, "expected a pi execution failed log entry");

      assert.equal(typeof launchedLog?.extra?.pid, "number");
      assert.equal(failureLog?.extra?.pid, launchedLog?.extra?.pid);
      assert.equal(failureLog?.extra?.exitCode, 7);
      assert.equal(failureLog?.extra?.signal, null);
      assert.equal(typeof failureLog?.extra?.durationMs, "number");
      assert.equal(typeof failureLog?.extra?.stderrBytes, "number");

      const stderrPreview = failureLog?.extra?.stderrPreview;
      assert.equal(typeof stderrPreview, "string");
      assert.ok((stderrPreview as string).length <= 201, "stderr preview should be truncated in logs");
      assert.ok((failureLog?.extra?.stderrBytes as number) > (stderrPreview as string).length);
      assert.equal(failureLog?.extra?.stderrTruncated, true);
    } finally {
      mutableLogger.info = originalInfo;
      mutableLogger.warn = originalWarn;
      mutableLogger.error = originalError;
      if (originalPiBinary === undefined) {
        delete process.env.TAMANDUA_PI_BINARY;
      } else {
        process.env.TAMANDUA_PI_BINARY = originalPiBinary;
      }
    }
  });
});

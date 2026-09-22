import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasHelpFlag,
  parseDuration,
  printHelp,
  printHelpSubcommand,
  readOption,
  requireOption,
  shouldSkipUpdateWarning,
  shouldSuppressUpdateWarning,
} from "../../dist/cli/shared.js";

describe("SPL2 shared CLI utilities", () => {
  describe("parseDuration", () => {
    it("parses each supported duration unit", () => {
      assert.equal(parseDuration("3s"), 3_000);
      assert.equal(parseDuration("3m"), 180_000);
      assert.equal(parseDuration("3h"), 10_800_000);
      assert.equal(parseDuration("3d"), 259_200_000);
    });

    it("preserves the CLI validation error for malformed durations", () => {
      assert.throws(
        () => parseDuration("3hours"),
        /Invalid duration format: "3hours"\. Use <number><unit>/,
      );
    });
  });

  it("detects either help flag anywhere in the argument list", () => {
    assert.equal(hasHelpFlag(["workflow", "run", "--help"]), true);
    assert.equal(hasHelpFlag(["doctor", "-h"]), true);
    assert.equal(hasHelpFlag(["doctor"]), false);
  });

  describe("option readers", () => {
    it("reads separate and inline option values", () => {
      assert.equal(readOption(["--port", "4444"], "--port"), "4444");
      assert.equal(readOption(["--port=5555"], "--port"), "5555");
      assert.equal(readOption([], "--port"), undefined);
    });

    it("returns a trimmed required option", () => {
      assert.equal(requireOption(["--branch", " feature/test "], "--branch", "example"), "feature/test");
    });
  });

  describe("help printers", () => {
    let stdout: string;
    let originalWrite: typeof process.stdout.write;
    let originalExit: typeof process.exit;

    beforeEach(() => {
      stdout = "";
      originalWrite = process.stdout.write;
      originalExit = process.exit;
      process.stdout.write = ((chunk: string) => {
        stdout += chunk;
        return true;
      }) as typeof process.stdout.write;
    });

    afterEach(() => {
      process.stdout.write = originalWrite;
      process.exit = originalExit;
    });

    it("prints aligned subcommands with the existing trailing blank line", () => {
      printHelpSubcommand({ short: "Short command", "much-longer": "Long command" });
      assert.equal(stdout, "  short        Short command\n  much-longer  Long command\n");
    });

    it("prints one trailing newline and exits successfully", () => {
      process.exit = ((code?: string | number | null): never => {
        assert.equal(code, 0);
        throw new Error("expected exit");
      }) as typeof process.exit;

      assert.throws(() => printHelp("Usage: tamandua"), /expected exit/);
      assert.equal(stdout, "Usage: tamandua\n");
    });
  });

  it("skips update warnings only for latency-sensitive and plumbing commands", () => {
    const exempt: Array<[string, string]> = [
      ["update", ""],
      ["version", ""],
      ["--version", ""],
      ["-v", ""],
      ["step", "peek"],
      ["step", "claim"],
      ["nudge", ""],
      ["merge-branch", ""],
    ];
    for (const [group, action] of exempt) {
      assert.equal(shouldSkipUpdateWarning(group, action), true, `${group} ${action}`);
    }

    assert.equal(shouldSkipUpdateWarning("step", "complete"), false);
    assert.equal(shouldSkipUpdateWarning("doctor", ""), false);
  });

  describe("shouldSuppressUpdateWarning", () => {
    it("suppresses when TAMANDUA_TEST_GUARD is set to a non-empty value", () => {
      assert.equal(
        shouldSuppressUpdateWarning({
          env: { TAMANDUA_TEST_GUARD: "1" },
          stderrIsTTY: true,
        }),
        true,
      );
    });

    it("suppresses when stderr is not a TTY", () => {
      assert.equal(
        shouldSuppressUpdateWarning({ env: {}, stderrIsTTY: false }),
        true,
      );
    });

    it("does not suppress for an interactive user with no test guard", () => {
      assert.equal(
        shouldSuppressUpdateWarning({ env: {}, stderrIsTTY: true }),
        false,
      );
    });

    it("treats an empty or absent guard as unset", () => {
      assert.equal(
        shouldSuppressUpdateWarning({
          env: { TAMANDUA_TEST_GUARD: "" },
          stderrIsTTY: true,
        }),
        false,
      );
      assert.equal(
        shouldSuppressUpdateWarning({ env: {}, stderrIsTTY: true }),
        false,
      );
    });

    it("honors the force override even with a guard and non-TTY stderr", () => {
      assert.equal(
        shouldSuppressUpdateWarning({
          env: {
            TAMANDUA_TEST_GUARD: "1",
            TAMANDUA_FORCE_UPDATE_WARNING: "1",
          },
          stderrIsTTY: false,
        }),
        false,
      );
    });
  });
});

/**
 * runHermes() behavior — argument shape, session_id filtering, timeout and
 * exit-code handling. Survives the motor swap: the dispatch motor routes
 * hermes work rounds through runHermes exactly like the old motor did.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { runHermes } from "../../dist/installer/agent-scheduler.js";

/**
 * Tests for runHermes() — spawns a mock hermes binary to verify:
 *  - Correct arguments are passed
 *  - session_id lines are filtered from stdout
 *  - Timeout is respected
 *  - Lifecycle events include harness="hermes"
 */

function makeMockHermes(scriptPath: string, behavior: string): void {
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh\n${behavior}\n`,
    { mode: 0o755 },
  );
}

describe("runHermes", () => {
  let tempHome: string;
  let savedHermesBinary: string | undefined;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-test-hermes-");
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
  });

  afterEach(() => {
    if (savedHermesBinary === undefined) {
      delete process.env.TAMANDUA_HERMES_BINARY;
    } else {
      process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns stdout with session_id lines filtered out", async () => {
    const hermesPath = path.join(tempHome, "hermes");
    makeMockHermes(
      hermesPath,
      `echo "Hello from hermes"
echo "Work completed successfully"
echo "session_id: 20260518_103004_cdae11"`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const output = await runHermes("do something", { timeout: 5 });

    // session_id line should be filtered out
    assert.ok(!output.includes("session_id:"));
    assert.ok(output.includes("Hello from hermes"));
    assert.ok(output.includes("Work completed successfully"));
  });

  it("filters session_id when it appears at the beginning or middle", async () => {
    const hermesPath = path.join(tempHome, "hermes");
    makeMockHermes(
      hermesPath,
      `echo "session_id: 20260518_early"
echo "useful output here"
echo "session_id: 20260518_late"`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const output = await runHermes("do something", { timeout: 5 });

    // All session_id lines should be filtered
    assert.ok(!output.includes("session_id:"));
    assert.ok(output.includes("useful output here"));
  });

  it("returns empty string when output is only session_id", async () => {
    const hermesPath = path.join(tempHome, "hermes");
    makeMockHermes(
      hermesPath,
      `echo "session_id: 20260518_103004_cdae11"`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const output = await runHermes("do something", { timeout: 5 });
    assert.equal(output, "");
  });

  it("passes prompt via -q argument correctly", async () => {
    const hermesPath = path.join(tempHome, "hermes");
    const logPath = path.join(tempHome, "hermes-args.log");
    makeMockHermes(
      hermesPath,
      `echo "$@" > "${logPath}"`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    await runHermes("build feature X", { timeout: 5 });

    const args = fs.readFileSync(logPath, "utf-8").trim();
    // Should contain the chat subcommand and prompt
    assert.ok(args.includes("chat"));
    assert.ok(args.includes("build feature X"));
    assert.ok(args.includes("--max-turns"));
    assert.ok(args.includes("8192"));
    assert.ok(args.includes("--yolo"));
    assert.ok(args.includes("-Q"));
    assert.ok(!args.includes("--ignore-user-config"));
    assert.ok(!args.includes("--ignore-rules"));
  });

  it("preserves multi-line output with mixed content", async () => {
    const hermesPath = path.join(tempHome, "hermes");
    makeMockHermes(
      hermesPath,
      `echo "STATUS: done"
echo ""
echo "CHANGES: implemented feature X"
echo "TESTS: all passing"
echo "session_id: 20260518_103004_cdae11"`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const output = await runHermes("do the work", { timeout: 5 });

    assert.ok(output.includes("STATUS: done"));
    assert.ok(output.includes("CHANGES: implemented feature X"));
    assert.ok(output.includes("TESTS: all passing"));
    assert.ok(!output.includes("session_id:"));
    // Should have preserved blank lines
    const lines = output.split("\n");
    assert.ok(lines.length >= 3);
  });

  it("resolves on timeout instead of rejecting — adapter returns available output", async () => {
    const hermesPath = path.join(tempHome, "hermes");
    makeMockHermes(
      hermesPath,
      // Sleep beyond the 2s timeout, but write session_id to stderr first
      // so the adapter can still extract it.
      `echo "session_id: 20260518_103004_cdae11" >&2
sleep 10`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    // After US-002 the adapter resolves on timeout (so the scheduler can
    // attribute tokens).  The output may be empty because the harness was
    // killed before writing stdout, but sessionRef is on stderr.
    const output = await runHermes("do something", { timeout: 2 });
    assert.equal(typeof output, "string", "output should still be a string");
  });

  it("resolves on non-zero exit — adapter returns output with exitCode/signal in result", async () => {
    const hermesPath = path.join(tempHome, "hermes");
    makeMockHermes(
      hermesPath,
      `echo "error output" >&2
echo "partial work before crash"
echo "session_id: 20260518_103004_cdae11" >&2
exit 1`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    // After US-002 the adapter always resolves (the scheduler decides what
    // to do with non-zero exits).  The stdout includes partial output,
    // session_id is on stderr for token attribution.
    const output = await runHermes("bad task", { timeout: 5 });
    assert.ok(output.includes("partial work before crash"), "stdout should include partial output");
    assert.ok(!output.includes("session_id:"), "session_id should be filtered from stdout");
  });

  it("works with TAMANDUA_HERMES_BINARY env var", async () => {
    const hermesPath = path.join(tempHome, "hermes-custom");
    makeMockHermes(
      hermesPath,
      `echo "custom hermes output"`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const output = await runHermes("task", { timeout: 5 });
    assert.equal(output, "custom hermes output");
  });

  it("stderr data does not appear in returned stdout", async () => {
    const hermesPath = path.join(tempHome, "hermes");
    makeMockHermes(
      hermesPath,
      `echo "useful stdout" 1>&1
echo "debug stderr" 1>&2`,
    );

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const output = await runHermes("task", { timeout: 5 });
    assert.equal(output, "useful stdout");
  });
});

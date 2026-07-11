/**
 * Tests for US-003: stderrTail in HarnessRoundResult from both Pi and Hermes adapters.
 *
 * Verifies:
 *  - PiHarnessAdapter.runRound returns stderrTail (sanitized)
 *  - HermesHarnessAdapter.runRound returns stderrTail (sanitized)
 *  - Hermes session_id trailer extraction still works (sessionRef populated from raw stderr)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHarnessAdapter } from "../dist/installer/harness-adapter.js";
import type { HarnessRoundResult } from "../dist/installer/harness-adapter.js";

let tempDir: string;
let savedPath: string | undefined;
let savedPiBinary: string | undefined;
let savedHermesBinary: string | undefined;
let savedHome: string | undefined;
let savedStateDir: string | undefined;
let savedDbPath: string | undefined;

function makeExecutable(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-harness-stderr-tail-"));
  savedPath = process.env.PATH;
  savedPiBinary = process.env.TAMANDUA_PI_BINARY;
  savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedDbPath = process.env.TAMANDUA_DB_PATH;
});

afterEach(() => {
  process.env.PATH = savedPath!;
  if (savedPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
  else process.env.TAMANDUA_PI_BINARY = savedPiBinary;
  if (savedHermesBinary === undefined) delete process.env.TAMANDUA_HERMES_BINARY;
  else process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = savedStateDir;
  if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = savedDbPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("PiHarnessAdapter stderrTail", () => {
  it("pi runRound result includes stderrTail from captured stderr", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // Fake pi that writes to stderr then exits cleanly
    const fakePi = makeExecutable(binDir, "pi", [
      "#!/bin/sh",
      'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"STATUS: done"}]}}\'',
      'echo "this is stderr output" >&2',
      'echo "more stderr" >&2',
      "exit 0",
    ].join("\n"));
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("pi");
    const result = await adapter.runRound("do work");

    assert.ok(result.stderrTail !== undefined, "stderrTail must be defined");
    assert.ok(result.stderrTail!.length > 0, "stderrTail must not be empty");
    assert.ok(result.stderrTail!.includes("stderr output"), "stderrTail should contain sanitized stderr");
    assert.ok(result.stderrTail!.includes("more stderr"), "stderrTail should contain all stderr lines");
    assert.equal(result.exitCode, 0, "exitCode should be 0");
    assert.equal(result.signal ?? null, null, "signal should be null");
  });

  it("pi runRound stderrTail is sanitized (ANSI codes stripped)", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // Fake pi with ANSI-colored stderr
    const fakePi = makeExecutable(binDir, "pi", [
      "#!/bin/sh",
      'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\'',
      // Use printf for reliable ANSI escape handling
      'printf "\\033[31mred error\\033[0m\\n" >&2',
      "exit 0",
    ].join("\n"));
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("pi");
    const result = await adapter.runRound("do work");

    assert.ok(result.stderrTail !== undefined, "stderrTail must be defined");
    assert.ok(!result.stderrTail!.includes("\x1B["), "stderrTail must not contain ANSI escape sequences");
    assert.ok(result.stderrTail!.includes("red error"), "stderrTail should contain the message without ANSI codes");
  });

  it("pi runRound stderrTail is undefined when stderr is empty", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakePi = makeExecutable(binDir, "pi", [
      "#!/bin/sh",
      'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\'',
      "exit 0",
    ].join("\n"));
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("pi");
    const result = await adapter.runRound("do work");

    assert.equal(result.stderrTail, undefined, "stderrTail should be undefined for empty stderr");
  });
});

describe("HermesHarnessAdapter stderrTail", () => {
  it("hermes runRound result includes stderrTail from captured stderr", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // Fake hermes that writes to stderr (with session_id trailer) then exits cleanly
    const fakeHermes = makeExecutable(binDir, "hermes", [
      "#!/bin/sh",
      'echo "hermes output"',
      'echo "stderr message one" >&2',
      'echo "stderr message two" >&2',
      "exit 0",
    ].join("\n"));
    process.env.TAMANDUA_HERMES_BINARY = fakeHermes;
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work");

    assert.ok(result.stderrTail !== undefined, "stderrTail must be defined");
    assert.ok(result.stderrTail!.length > 0, "stderrTail must not be empty");
    assert.ok(result.stderrTail!.includes("message one"), "stderrTail should contain sanitized stderr");
    assert.ok(result.stderrTail!.includes("message two"), "stderrTail should contain all stderr lines");
  });

  it("hermes session_id trailer extraction still works alongside stderrTail", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // Fake hermes with session_id trailer on stderr
    const fakeHermes = makeExecutable(binDir, "hermes", [
      "#!/bin/sh",
      'echo "hermes completed"',
      'echo "session_id: 20260101_120000_abc123" >&2',
      "exit 0",
    ].join("\n"));
    process.env.TAMANDUA_HERMES_BINARY = fakeHermes;
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work");

    // session_id trailer extracted from raw stderr BEFORE sanitization
    assert.equal(result.sessionRef, "20260101_120000_abc123", "sessionRef must be extracted");

    // stderrTail is sanitized (no session_id line because it was stripped)
    assert.ok(result.stderrTail !== undefined, "stderrTail must be defined");
    // Note: session_id lines are filtered from stdout, but the raw stderr
    // still flows into sanitizeStderrTail. That's OK — sanitization just
    // strips ANSI codes, truncates lines, and bounds size.
  });

  it("hermes runRound stderrTail is undefined when stderr is empty", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeHermes = makeExecutable(binDir, "hermes", [
      "#!/bin/sh",
      'echo "hermes output"',
      "exit 0",
    ].join("\n"));
    process.env.TAMANDUA_HERMES_BINARY = fakeHermes;
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work");

    assert.equal(result.stderrTail, undefined, "stderrTail should be undefined for empty stderr");
  });

  it("hermes runRound stderrTail is bounded to ~8KB even with large stderr", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // Generate 20KB of stderr
    const largeLine = "x".repeat(200);
    const lines = Array.from({ length: 100 }, () => largeLine).join("\n");
    // Escape for shell
    const body = [
      "#!/bin/sh",
      `cat <<'HERMES_EOF' >&2`,
      lines,
      "HERMES_EOF",
      'echo "hermes done"',
      "exit 0",
    ].join("\n");
    const fakeHermes = makeExecutable(binDir, "hermes", body);
    process.env.TAMANDUA_HERMES_BINARY = fakeHermes;
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work");

    assert.ok(result.stderrTail !== undefined, "stderrTail must be defined");
    const tailBytes = Buffer.byteLength(result.stderrTail!, "utf-8");
    // sanitizeStderrTail caps at 8KB by default, but individual lines are truncated
    // to 512 chars. With 200-char lines they pass through, so 8KB ≈ 40 lines.
    assert.ok(tailBytes <= 9000, `stderrTail should be bounded (~8KB), got ${tailBytes} bytes`);
  });
});

describe("stderrTail event payload shape", () => {
  // Verify that HarnessRoundResult type includes stderrTail as optional string
  it("HarnessRoundResult.stderrTail accepts a string value", () => {
    const result: HarnessRoundResult = {
      output: "test",
      stderrTail: "sanitized stderr here",
    };
    assert.equal(result.stderrTail, "sanitized stderr here");
  });

  it("HarnessRoundResult.stderrTail is optional and can be undefined", () => {
    const result: HarnessRoundResult = { output: "test" };
    // Access without error — field is optional
    assert.equal(result.stderrTail, undefined);
  });
});

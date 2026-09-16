/**
 * Tests for src/lib/lsof-probe.ts — the bounded lsof probe primitive.
 *
 * The story requires that no lsof invocation can block forever: probes carry
 * `-b -w`, a hard SIGKILL timeout, and a timed-out probe is reported as
 * `kind: "timeout"` rather than an empty `ok`.
 *
 * Classified as serial: the probe module imports node:child_process and the
 * tests spawn fake lsof shims (one deliberately hangs).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  LSOF_DEFAULT_TIMEOUT_MS,
  LSOF_MAX_TIMEOUT_MS,
  LSOF_MIN_TIMEOUT_MS,
  clampLsofTimeoutMs,
  lsofProbeArgv,
  lsofTimeoutMsFromEnv,
  parseLsofTimeoutMs,
  resolveLsofBinary,
  runLsof,
} from "../../dist/lib/lsof-probe.js";

const tmpDir = tamanduaTempDir("tamandua-lsof-probe-");

// runLsof logs a warning on timeout/unavailable. Point TAMANDUA_STATE_DIR at
// this test's temp dir BEFORE any probe runs so those log lines land in an
// isolated file instead of the real ~/.tamandua/tamandua.log (the test
// isolation guard records a ledger violation for the latter and fails the
// serial lane even when every assertion passes).
const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const stateDir = path.join(tmpDir, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.TAMANDUA_STATE_DIR = stateDir;

after(() => {
  if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = originalStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Quote an absolute path for safe interpolation inside a single-quoted shell string. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Write an executable fake-lsof shim. */
function writeShim(name: string, body: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, body, "utf-8");
  fs.chmodSync(file, 0o755);
  return file;
}

/** Restore a string env var to its previous value (or unset it). */
function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

describe("lsofProbeArgv", () => {
  it("always prepends -b and -w", () => {
    assert.deepEqual(lsofProbeArgv(["-p", "1"]), ["-b", "-w", "-p", "1"]);
  });

  it("prepends the flags even when the caller passes no args", () => {
    assert.deepEqual(lsofProbeArgv([]), ["-b", "-w"]);
  });

  it("does not mutate the caller's argument array", () => {
    const input = ["-d", "cwd", "-Fn"];
    lsofProbeArgv(input);
    assert.deepEqual(input, ["-d", "cwd", "-Fn"]);
  });
});

describe("lsof timeout configuration", () => {
  it("defaults to 5000ms when unset or blank", () => {
    assert.equal(parseLsofTimeoutMs(undefined), LSOF_DEFAULT_TIMEOUT_MS);
    assert.equal(parseLsofTimeoutMs(null), LSOF_DEFAULT_TIMEOUT_MS);
    assert.equal(parseLsofTimeoutMs(""), LSOF_DEFAULT_TIMEOUT_MS);
    assert.equal(parseLsofTimeoutMs("   "), LSOF_DEFAULT_TIMEOUT_MS);
  });

  it("defaults when the value is not a finite number", () => {
    assert.equal(parseLsofTimeoutMs("abc"), LSOF_DEFAULT_TIMEOUT_MS);
    assert.equal(parseLsofTimeoutMs("Infinity"), LSOF_DEFAULT_TIMEOUT_MS);
  });

  it("clamps into [1, 60000]", () => {
    assert.equal(parseLsofTimeoutMs("0"), LSOF_MIN_TIMEOUT_MS);
    assert.equal(parseLsofTimeoutMs("-10"), LSOF_MIN_TIMEOUT_MS);
    assert.equal(parseLsofTimeoutMs("999999"), LSOF_MAX_TIMEOUT_MS);
    assert.equal(parseLsofTimeoutMs("2500"), 2500);
    assert.equal(clampLsofTimeoutMs(0), LSOF_MIN_TIMEOUT_MS);
    assert.equal(clampLsofTimeoutMs(120000), LSOF_MAX_TIMEOUT_MS);
  });

  it("reads TAMANDUA_LSOF_TIMEOUT_MS from the environment", () => {
    const previous = process.env.TAMANDUA_LSOF_TIMEOUT_MS;
    try {
      process.env.TAMANDUA_LSOF_TIMEOUT_MS = "1234";
      assert.equal(lsofTimeoutMsFromEnv(), 1234);
      process.env.TAMANDUA_LSOF_TIMEOUT_MS = "0";
      assert.equal(lsofTimeoutMsFromEnv(), LSOF_MIN_TIMEOUT_MS);
    } finally {
      restoreEnv("TAMANDUA_LSOF_TIMEOUT_MS", previous);
    }
  });
});

describe("resolveLsofBinary", () => {
  it("prefers the explicit override", () => {
    assert.equal(resolveLsofBinary("/custom/lsof"), "/custom/lsof");
  });

  it("falls back to TAMANDUA_LSOF_BIN, then plain lsof", () => {
    const previous = process.env.TAMANDUA_LSOF_BIN;
    try {
      delete process.env.TAMANDUA_LSOF_BIN;
      assert.equal(resolveLsofBinary(), "lsof");
      process.env.TAMANDUA_LSOF_BIN = "/env/lsof";
      assert.equal(resolveLsofBinary(), "/env/lsof");
      assert.equal(resolveLsofBinary("/explicit/lsof"), "/explicit/lsof");
      process.env.TAMANDUA_LSOF_BIN = "   ";
      assert.equal(resolveLsofBinary(), "lsof");
    } finally {
      restoreEnv("TAMANDUA_LSOF_BIN", previous);
    }
  });
});

describe("runLsof", () => {
  it("returns ok with the shim stdout and forwards -b -w to the child", () => {
    const argvFile = path.join(tmpDir, "ok-lsof.argv");
    const shim = writeShim(
      "ok-lsof.sh",
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${shQuote(argvFile)}\nprintf 'fake-lsof-stdout\\n'\nexit 0\n`,
    );

    const result = runLsof(["-p", "1", "-Fn"], { binary: shim, timeoutMs: 3000 });
    assert.ok(result.kind === "ok", `expected ok, got ${result.kind}`);
    assert.equal(result.stdout, "fake-lsof-stdout\n");

    const argv = fs.readFileSync(argvFile, "utf-8").trim().split("\n");
    assert.deepEqual(argv, ["-b", "-w", "-p", "1", "-Fn"]);
  });

  it("returns a timeout (never ok) for a hanging shim using TAMANDUA_LSOF_BIN, and SIGKILLs it", () => {
    const pidFile = path.join(tmpDir, "hang-lsof.pid");
    const shim = writeShim(
      "hang-lsof.sh",
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${shQuote(pidFile)}\nprintf 'partial-stdout-before-hang\\n'\nexec sleep 60\n`,
    );

    const prevBin = process.env.TAMANDUA_LSOF_BIN;
    const prevTimeout = process.env.TAMANDUA_LSOF_TIMEOUT_MS;
    process.env.TAMANDUA_LSOF_BIN = shim;
    process.env.TAMANDUA_LSOF_TIMEOUT_MS = "1200";

    let result: ReturnType<typeof runLsof>;
    const startedAt = Date.now();
    try {
      result = runLsof(["-p", "1", "-Fn"]);
    } finally {
      restoreEnv("TAMANDUA_LSOF_BIN", prevBin);
      restoreEnv("TAMANDUA_LSOF_TIMEOUT_MS", prevTimeout);
    }
    const elapsedMs = Date.now() - startedAt;

    assert.ok(result.kind === "timeout", `expected timeout, got ${result.kind}`);
    assert.equal(result.timeoutMs, 1200);
    assert.ok(
      elapsedMs < 1200 + 1000,
      `hung probe must return within timeout+1000ms, took ${elapsedMs}ms`,
    );

    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0, "shim must have recorded its pid");
    try {
      assert.throws(
        () => process.kill(pid, 0),
        (err: NodeJS.ErrnoException) => err.code === "ESRCH",
        "hung shim must be killed and reaped, not left running",
      );
    } finally {
      // Safety net if the assertion above failed: never leave a 60s sleeper.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("returns unavailable (not ok) when the binary does not exist", () => {
    const result = runLsof(["-p", "1", "-Fn"], {
      binary: path.join(tmpDir, "definitely-not-a-real-lsof"),
      timeoutMs: 1000,
    });
    assert.ok(result.kind === "unavailable", `expected unavailable, got ${result.kind}`);
    assert.ok(result.error.length > 0, "unavailable must carry an error description");
  });

  it("returns error (not ok) for a non-zero exit status", () => {
    const shim = writeShim(
      "fail-lsof.sh",
      "#!/bin/sh\necho 'lsof: no match' >&2\nexit 1\n",
    );
    const result = runLsof(["-p", "1", "-Fn"], { binary: shim, timeoutMs: 3000 });
    assert.ok(result.kind === "error", `expected error, got ${result.kind}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no match/);
  });
});

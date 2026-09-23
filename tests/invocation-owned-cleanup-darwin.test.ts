/**
 * LSOF-EVTA US-005 — behavioral proof that the Darwin ownership observer
 * (`observeDarwinPid` in tests/helpers/invocation-owned-cleanup.ts) runs a
 * BOUNDED lsof probe.
 *
 * The after-hook survivor sweep uses this observer on macOS; a stale FUSE
 * mount can block `lsof` inside the kernel forever, so the probe must carry
 * `-b -w`, a hard timeout and `killSignal: "SIGKILL"`. This suite shims the
 * `lsof` binary on PATH (no real lsof) to prove:
 *   - the child receives exactly `-b -w -p <pid> -Fn` and its output parses;
 *   - a hanging shim makes the observer return "unreadable" within the bound
 *     and the shim is SIGKILLed and reaped (never a leaked blocked lsof).
 *
 * Serial lane: it exercises a helper that spawns a child process.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DARWIN_LSOF_TIMEOUT_MS_DEFAULT,
  darwinLsofTimeoutMs,
  observeDarwinPid,
} from "./helpers/invocation-owned-cleanup.ts";

/** Run `fn` with `dir` prepended to PATH (the lsof shim seam). */
function withShimOnPath<T>(dir: string, fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${prev ? `:${prev}` : ""}`;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
}

/**
 * Bounded poll for the shim's recorded pid. The spawned shell writes `$$` to
 * the pid file asynchronously, so under host load that write can land after the
 * observer's bounded probe returns; poll for the file's presence and parseable
 * positive-integer content (same deadline style as the reap check below)
 * instead of a one-shot read that can throw ENOENT.
 */
function waitForRecordedPid(pidFile: string, timeoutMs = 1000): number {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const parsed = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    } catch {
      /* not written yet — keep polling until the deadline */
    }
    if (Date.now() >= deadline) return 0;
  }
}

/** Run `fn` with the observer's timeout env seam set (undefined clears it). */
function withObserverTimeout<T>(ms: number | undefined, fn: () => T): T {
  const prev = process.env.TAMANDUA_DARWIN_LSOF_TIMEOUT_MS;
  if (ms === undefined) delete process.env.TAMANDUA_DARWIN_LSOF_TIMEOUT_MS;
  else process.env.TAMANDUA_DARWIN_LSOF_TIMEOUT_MS = String(ms);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TAMANDUA_DARWIN_LSOF_TIMEOUT_MS;
    else process.env.TAMANDUA_DARWIN_LSOF_TIMEOUT_MS = prev;
  }
}

describe("LSOF-EVTA US-005 — bounded Darwin ownership observer", () => {
  it("passes -b -w -p <pid> -Fn to the child and parses its n<path> rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "tamandua-observer-ok-"));
    const argsFile = join(dir, "argv");
    const logPath = join(dir, "home", ".tamandua", "mcp.log");
    const shim = join(dir, "lsof");
    writeFileSync(
      shim,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" > ${JSON.stringify(argsFile)}`,
        `printf 'p%s\\nf1\\nn%s\\n' "$$" ${JSON.stringify(logPath)}`,
      ].join("\n"),
    );
    chmodSync(shim, 0o755);
    try {
      // Precondition: the shim is a working executable and prints the rows we
      // expect. That decouples a later parsing failure from shim breakage.
      const shimOut = execFileSync(
        shim,
        ["-b", "-w", "-p", "4242", "-Fn"],
        { encoding: "utf8" },
      );
      assert.ok(
        shimOut.includes(logPath),
        "the recording shim must emit the expected n<path> row",
      );

      const result = withShimOnPath(dir, () => observeDarwinPid(4242));
      assert.equal(result.kind, "ok");
      assert.deepEqual(
        result.kind === "ok" ? [...result.paths] : [],
        [logPath],
        "the observer must parse the lsof n<path> rows",
      );
      const argv = readFileSync(argsFile, "utf8").trim();
      assert.equal(
        argv,
        "-b -w -p 4242 -Fn",
        "the observer must always bound the probe with -b -w and pid-scope it",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a hanging lsof makes the observer return unreadable within the bound and the shim is SIGKILLed/reaped", () => {
    const dir = mkdtempSync(join(tmpdir(), "tamandua-observer-hang-"));
    const pidFile = join(dir, "shim.pid");
    const shim = join(dir, "lsof");
    writeFileSync(
      shim,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$$" > ${JSON.stringify(pidFile)}`,
        "exec sleep 60",
      ].join("\n"),
    );
    chmodSync(shim, 0o755);
    const TIMEOUT_MS = 300;
    let shimPid = 0;
    try {
      const started = Date.now();
      // process.pid is alive, so a failed/timed-out probe is "unreadable"
      // (not "gone") — the fail-closed refusal the sweep relies on.
      const result = withShimOnPath(dir, () =>
        withObserverTimeout(TIMEOUT_MS, () => observeDarwinPid(process.pid)),
      );
      const elapsed = Date.now() - started;
      assert.equal(
        result.kind,
        "unreadable",
        "a timed-out observer must fail closed, never report a readable empty proof",
      );
      assert.ok(
        elapsed < TIMEOUT_MS + 1000,
        `the bounded probe must return within timeout+1000ms, took ${elapsed}ms`,
      );
      shimPid = waitForRecordedPid(pidFile);
      assert.ok(
        Number.isInteger(shimPid) && shimPid > 0,
        "the hanging shim must have recorded its pid",
      );
      let gone = false;
      const deadline = Date.now() + 1000;
      do {
        try {
          process.kill(shimPid, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") {
            gone = true;
            break;
          }
        }
      } while (Date.now() < deadline);
      assert.equal(
        gone,
        true,
        `the hanging shim (pid ${shimPid}) must be SIGKILLed and reaped`,
      );
    } finally {
      if (shimPid > 0) {
        try {
          process.kill(shimPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the timeout env seam is defensive: default, blank/non-numeric fallback, clamp", () => {
    assert.equal(
      withObserverTimeout(undefined, () => darwinLsofTimeoutMs()),
      DARWIN_LSOF_TIMEOUT_MS_DEFAULT,
    );
    for (const bad of ["", "   ", "abc", "0", "-5", "Infinity"]) {
      assert.equal(
        withObserverTimeout(bad as unknown as number, () => darwinLsofTimeoutMs()),
        DARWIN_LSOF_TIMEOUT_MS_DEFAULT,
        `invalid override ${JSON.stringify(bad)} must fall back to the default`,
      );
    }
    assert.equal(withObserverTimeout(1, () => darwinLsofTimeoutMs()), 1);
    assert.equal(withObserverTimeout(300, () => darwinLsofTimeoutMs()), 300);
    assert.equal(
      withObserverTimeout(99_999, () => darwinLsofTimeoutMs()),
      60_000,
      "an oversized override must be clamped to 60s",
    );
  });
});

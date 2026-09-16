/**
 * Tests for src/lib/process-start-identity.ts — the canonical, TZ-independent
 * v2 process-start identity (TZPI US-002) plus the live-host regressions
 * (US-003).
 *
 * Coverage:
 *  - the live reader returns a v2 string for the current process (linux and
 *    darwin), stable across calls, and null for an absurd pid;
 *  - fixture-driven unit tests for BOTH platform code paths through the pure
 *    parsers (linux stat + boot-time text; darwin helper stdout);
 *  - the comparison contract: same / tolerance-close -> 'same', pid mismatch
 *    or beyond-tolerance -> 'different', and every legacy/fallback/malformed
 *    value -> 'unknown' (never reclaim);
 *  - LIVE-HOST regressions (US-003): the real darwin reader for self and a
 *    spawned live child, TZ invariance across spawned children (TZ=UTC vs a
 *    non-UTC zone) and an in-process TZ flip, and running the real compiled
 *    reader INSIDE the bundled Seatbelt signal profile (the sandbox in which
 *    /bin/ps is EPERM) with the documented two-tier honest-skip rule;
 *  - LIVE-HOST identity-stability regressions (US-004): a live Linux child's
 *    v2 identity is byte-stable across re-reads ~100 ms apart, becomes null
 *    once the child is SIGKILLed and reaped, and a second child yields a
 *    different identity that compares as 'different';
 *  - a source-contract check that the module never shells out to ps(1) for
 *    identity.
 *
 * Classified as serial: imports node:child_process (spawn/spawnSync) for the
 * certainly-dead-pid case and the live-host child/sandbox regressions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";
import {
  SANDBOX_EXEC_PATH,
  buildProtectedLaunchArgv,
  probeBackend,
} from "../installer/native-signal-backend.ts";
import {
  AUXV_AT_CLKTCK,
  DEFAULT_CLOCK_TICKS_PER_SECOND,
  PROCESS_START_IDENTITY_TOLERANCE_MS,
  compareProcessStartIdentities,
  formatProcessStartIdentity,
  getProcessStartIdentity,
  parseAuxvClockTicksPerSecond,
  parseDarwinStartIdentity,
  parseLinuxStartIdentity,
  parseProcessStartIdentity,
  resolveClockTicksPerSecond,
} from "./process-start-identity.ts";

// ── Fixtures (no literal procfs paths: the portability lint bans them in test
//     files, so we feed the exact TEXT a reader would have read instead). ──

/** A realistic per-pid stat line; token index 19 after the comm is 987654. */
const LINUX_STAT_FIXTURE =
  "42 (node) S 1 42 42 1 42 4194304 100 0 0 0 5 6 0 0 20 0 1 0 987654 1000 18446744073709551615";

/** Same field layout, but the comm itself contains spaces and parentheses. */
const LINUX_STAT_WEIRD_COMM_FIXTURE =
  "7 (my )weird( proc) S 1 7 7 1 7 4194304 100 0 0 0 5 6 0 0 20 0 1 0 987654 1000 1";

/** System stat text with a boot-time (btime) line. */
const LINUX_PROC_STAT_FIXTURE =
  "cpu  1 2 3 4 5 6 7 8 9 10\nbtime 1700000000\nprocesses 12345\n";

const BOOT_EPOCH_SECONDS = 1700000000;
const START_TICKS = 987654;
const LINUX_EXPECTED_MS = BOOT_EPOCH_SECONDS * 1000 + START_TICKS * 10;

/**
 * Build a raw auxv image of (type, value) native-word pairs. `wordSize` is 8
 * on 64-bit kernels and 4 on 32-bit; `littleEndian` selects the byte order.
 * No literal procfs path: the parser is fed the exact bytes a reader would see.
 */
function auxvBuffer(
  entries: Array<[number, number]>,
  wordSize: 4 | 8,
  littleEndian: boolean,
): Buffer {
  const buf = Buffer.alloc(entries.length * wordSize * 2);
  let offset = 0;
  for (const [type, value] of entries) {
    if (wordSize === 8) {
      if (littleEndian) {
        buf.writeBigUInt64LE(BigInt(type), offset);
        buf.writeBigUInt64LE(BigInt(value), offset + 8);
      } else {
        buf.writeBigUInt64BE(BigInt(type), offset);
        buf.writeBigUInt64BE(BigInt(value), offset + 8);
      }
    } else if (littleEndian) {
      buf.writeUInt32LE(type, offset);
      buf.writeUInt32LE(value, offset + 4);
    } else {
      buf.writeUInt32BE(type, offset);
      buf.writeUInt32BE(value, offset + 4);
    }
    offset += wordSize * 2;
  }
  return buf;
}

// ── Live-host regression helpers (US-003) ─────────────────────────────
//
// The spawned children import the COMPILED reader (dist/lib/…) exactly as a
// production caller would; when dist is absent (a direct `node --test` run
// without a prior `npm run build`) they fall back to the TypeScript source so
// the test still exercises the real reader. `npm test` always builds first.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_READER_PATH = path.join(REPO_ROOT, "dist", "lib", "process-start-identity.js");

function readerModuleHref(): string {
  return existsSync(DIST_READER_PATH)
    ? pathToFileURL(DIST_READER_PATH).href
    : new URL("./process-start-identity.ts", import.meta.url).href;
}

interface ChildRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Spawn a child that prints `getProcessStartIdentity(<pid>)` from the reader. */
function runIdentityChild(targetPid: number, env: Record<string, string | undefined>): ChildRun {
  const script =
    `import { getProcessStartIdentity } from ${JSON.stringify(readerModuleHref())};\n` +
    `const id = getProcessStartIdentity(Number(process.argv[1]));\n` +
    `if (id === null) { console.error("null-identity"); process.exit(3); }\n` +
    `process.stdout.write(id + "\\n");\n`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, String(targetPid)],
    {
      encoding: "utf-8",
      timeout: 20_000,
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/** Spawn a long-lived owned child and resolve once it has actually spawned. */
async function spawnLongLivedChild(): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    env: cleanChildEnv(),
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 0, "long-lived child must have a pid");
  return { child, pid };
}

/** Poll the reader until the freshly spawned pid is readable (bounded). */
async function waitForIdentity(pid: number, deadlineMs = 5000): Promise<string | null> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const identity = getProcessStartIdentity(pid);
    if (identity !== null) return identity;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Poll the reader until the pid has no identity (gone/reaped), bounded. */
async function waitForIdentityGone(pid: number, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (getProcessStartIdentity(pid) !== null) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Wait for the child to exit, bounded — a best-effort reaping aid. */
async function waitForExit(child: ChildProcess, deadlineMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
  ]);
}

/** Await a wall-clock delay; used to separate two identity re-reads. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One-line, length-bounded diagnostic tail for an assertion message. */
function summarizeOutput(text: string | undefined, max = 300): string {
  const tail = (text ?? "").trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, max);
  return tail === "" ? "(no output)" : tail;
}

describe("getProcessStartIdentity", () => {
  it("reads a non-null, stable v2 start identity for the current process", {
    skip: process.platform !== "linux" && process.platform !== "darwin",
  }, () => {
    const first = getProcessStartIdentity(process.pid);
    assert.ok(first !== null, "start identity must be computable for the current process");
    assert.match(first, new RegExp(`^v2:${process.pid}:\\d+$`));
    assert.equal(getProcessStartIdentity(process.pid), first, "identity must be stable");
  });

  it("returns null for a non-positive or absurd pid", {
    skip: process.platform !== "linux" && process.platform !== "darwin",
  }, () => {
    assert.equal(getProcessStartIdentity(0), null);
    assert.equal(getProcessStartIdentity(-1), null);
    assert.equal(getProcessStartIdentity(Number.MAX_SAFE_INTEGER), null);
  });

  it("returns null for a certainly-dead pid", { skip: process.platform !== "linux" }, () => {
    const child = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(child.status, 0, "short-lived child must exit cleanly");
    assert.equal(getProcessStartIdentity(child.pid), null, "procfs entry is gone after exit");
  });
});

describe("parseLinuxStartIdentity", () => {
  it("composes the documented v2 value from stat + btime fixtures", () => {
    assert.equal(
      parseLinuxStartIdentity(42, LINUX_STAT_FIXTURE, LINUX_PROC_STAT_FIXTURE),
      `v2:42:${LINUX_EXPECTED_MS}`,
    );
  });

  it("uses an explicit 1000 Hz tick rate when supplied", () => {
    assert.equal(
      parseLinuxStartIdentity(42, LINUX_STAT_FIXTURE, LINUX_PROC_STAT_FIXTURE, 1000),
      `v2:42:${BOOT_EPOCH_SECONDS * 1000 + START_TICKS}`,
    );
  });

  it("uses an explicit 250 Hz tick rate when supplied", () => {
    assert.equal(
      parseLinuxStartIdentity(42, LINUX_STAT_FIXTURE, LINUX_PROC_STAT_FIXTURE, 250),
      `v2:42:${BOOT_EPOCH_SECONDS * 1000 + START_TICKS * 4}`,
    );
  });

  it("rejects a non-positive or non-finite tick rate", () => {
    assert.equal(parseLinuxStartIdentity(42, LINUX_STAT_FIXTURE, LINUX_PROC_STAT_FIXTURE, 0), null);
    assert.equal(parseLinuxStartIdentity(42, LINUX_STAT_FIXTURE, LINUX_PROC_STAT_FIXTURE, -100), null);
    assert.equal(
      parseLinuxStartIdentity(42, LINUX_STAT_FIXTURE, LINUX_PROC_STAT_FIXTURE, Number.NaN),
      null,
    );
  });

  it("parses by slicing after the LAST ')' of the comm field", () => {
    assert.equal(
      parseLinuxStartIdentity(7, LINUX_STAT_WEIRD_COMM_FIXTURE, LINUX_PROC_STAT_FIXTURE),
      `v2:7:${LINUX_EXPECTED_MS}`,
    );
  });

  it("rejects a stat line with no comm terminator", () => {
    assert.equal(parseLinuxStartIdentity(42, "42 node S 1", LINUX_PROC_STAT_FIXTURE), null);
  });

  it("rejects a non-numeric starttime field", () => {
    const bad = LINUX_STAT_FIXTURE.replace(" 987654 ", " not-a-number ");
    assert.equal(parseLinuxStartIdentity(42, bad, LINUX_PROC_STAT_FIXTURE), null);
  });

  it("rejects text with no btime line", () => {
    assert.equal(parseLinuxStartIdentity(42, LINUX_STAT_FIXTURE, "cpu 1 2 3\n"), null);
  });

  it("rejects a non-positive pid", () => {
    assert.equal(parseLinuxStartIdentity(0, LINUX_STAT_FIXTURE, LINUX_PROC_STAT_FIXTURE), null);
  });
});

describe("parseAuxvClockTicksPerSecond", () => {
  it("reads AT_CLKTCK from a 64-bit little-endian auxv frame", () => {
    const frame = auxvBuffer(
      [
        [0, 0],
        [AUXV_AT_CLKTCK, 100],
        [23, 0],
      ],
      8,
      true,
    );
    assert.equal(parseAuxvClockTicksPerSecond(frame, 8, true), 100);
  });

  it("reads AT_CLKTCK from a 32-bit auxv frame", () => {
    const frame = auxvBuffer(
      [
        [0, 0],
        [AUXV_AT_CLKTCK, 250],
      ],
      4,
      true,
    );
    assert.equal(parseAuxvClockTicksPerSecond(frame, 4, true), 250);
  });

  it("honors big-endian 64-bit frames", () => {
    const frame = auxvBuffer([[AUXV_AT_CLKTCK, 333]], 8, false);
    assert.equal(parseAuxvClockTicksPerSecond(frame, 8, false), 333);
    assert.notEqual(parseAuxvClockTicksPerSecond(frame, 8, true), 333);
  });

  it("returns null when AT_CLKTCK is absent, zero, or the buffer is empty", () => {
    assert.equal(parseAuxvClockTicksPerSecond(auxvBuffer([[0, 0]], 8, true), 8, true), null);
    assert.equal(
      parseAuxvClockTicksPerSecond(auxvBuffer([[AUXV_AT_CLKTCK, 0]], 8, true), 8, true),
      null,
    );
    assert.equal(parseAuxvClockTicksPerSecond(Buffer.alloc(0), 8, true), null);
  });

  it("ignores a trailing partial word pair", () => {
    const withTail = Buffer.concat([
      auxvBuffer([[AUXV_AT_CLKTCK, 100]], 8, true),
      Buffer.alloc(8),
    ]);
    assert.equal(parseAuxvClockTicksPerSecond(withTail, 8, true), 100);
  });
});

describe("resolveClockTicksPerSecond", () => {
  it("returns a positive integer matching the kernel's CLK_TCK on linux", {
    skip: process.platform !== "linux",
  }, () => {
    const resolved = resolveClockTicksPerSecond();
    assert.ok(
      Number.isInteger(resolved) && resolved > 0,
      `tick rate must be a positive integer; got ${String(resolved)}`,
    );
    const expected = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf-8" });
    assert.equal(
      expected.status,
      0,
      `getconf CLK_TCK must answer: ${summarizeOutput(expected.stderr)}`,
    );
    assert.equal(resolved, Number((expected.stdout ?? "").trim()));
  });

  it("caches the resolved value so repeated calls are byte-identical", {
    skip: process.platform !== "linux",
  }, () => {
    assert.equal(resolveClockTicksPerSecond(), resolveClockTicksPerSecond());
  });

  it("documents the portable USER_HZ fallback", () => {
    assert.equal(DEFAULT_CLOCK_TICKS_PER_SECOND, 100);
  });
});

describe("parseDarwinStartIdentity", () => {
  it("converts helper stdout '<sec>.<usec>' into the documented v2 value", () => {
    assert.equal(parseDarwinStartIdentity(42, "1700000000.123456"), "v2:42:1700000000123");
  });

  it("tolerates surrounding whitespace/newlines from the helper", () => {
    assert.equal(parseDarwinStartIdentity(42, "1700000000.123456\n"), "v2:42:1700000000123");
    assert.equal(parseDarwinStartIdentity(42, "  1700000000.123456  "), "v2:42:1700000000123");
  });

  it("floors sub-millisecond precision", () => {
    assert.equal(parseDarwinStartIdentity(42, "1700000000.000999"), "v2:42:1700000000000");
    assert.equal(parseDarwinStartIdentity(42, "1700000000.999999"), "v2:42:1700000000999");
  });

  it("rejects malformed, empty, and zero-time helper output", () => {
    assert.equal(parseDarwinStartIdentity(42, ""), null);
    assert.equal(parseDarwinStartIdentity(42, "not-a-time"), null);
    assert.equal(parseDarwinStartIdentity(42, "1700000000"), null);
    assert.equal(parseDarwinStartIdentity(42, "1700000000.1234567"), null);
    assert.equal(parseDarwinStartIdentity(42, "0.000000"), null);
  });

  it("rejects a non-positive pid", () => {
    assert.equal(parseDarwinStartIdentity(0, "1700000000.123456"), null);
  });
});

describe("format/parse round-trip", () => {
  it("formats the documented shape and truncates fractional ms", () => {
    assert.equal(formatProcessStartIdentity(42, 1700000000123), "v2:42:1700000000123");
    assert.equal(formatProcessStartIdentity(42, 1700000000123.9), "v2:42:1700000000123");
  });

  it("parses a formatted value back to pid + epoch ms", () => {
    assert.deepEqual(parseProcessStartIdentity(formatProcessStartIdentity(42, 1700000000123)), {
      pid: 42,
      startEpochMs: 1700000000123,
    });
  });

  it("returns null for every non-comparable shape", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      "garbage",
      "v2:42",
      "v2:abc:123",
      "v2:42:abc",
      "v2:0:1700000000123",
      "v2u:42",
      "ps:Sun Sep  6 00:26:59 2026",
      "proc:987654",
    ]) {
      assert.equal(parseProcessStartIdentity(value as string | null | undefined), null, `expected null for ${String(value)}`);
    }
  });
});

describe("compareProcessStartIdentities", () => {
  const base = "v2:42:1700000000000";

  it("returns same for identical v2 values", () => {
    assert.equal(compareProcessStartIdentities(base, base), "same");
  });

  it("returns same at exactly the documented tolerance", () => {
    const drift = String(1700000000000 + PROCESS_START_IDENTITY_TOLERANCE_MS);
    assert.equal(compareProcessStartIdentities(base, `v2:42:${drift}`), "same");
    assert.equal(compareProcessStartIdentities(`v2:42:${drift}`, base), "same");
  });

  it("returns different just beyond the tolerance", () => {
    const drift = String(1700000000000 + PROCESS_START_IDENTITY_TOLERANCE_MS + 1);
    assert.equal(compareProcessStartIdentities(base, `v2:42:${drift}`), "different");
  });

  it("returns different for a pid mismatch", () => {
    assert.equal(compareProcessStartIdentities(base, "v2:43:1700000000000"), "different");
  });

  it("returns unknown for legacy ps:/proc: values", () => {
    assert.equal(compareProcessStartIdentities("ps:Sun Sep  6 00:26:59 2026", base), "unknown");
    assert.equal(compareProcessStartIdentities(base, "proc:987654"), "unknown");
  });

  it("returns unknown for v2u fallback values", () => {
    assert.equal(compareProcessStartIdentities("v2u:42", base), "unknown");
    assert.equal(compareProcessStartIdentities(base, "v2u:42"), "unknown");
    assert.equal(compareProcessStartIdentities("v2u:42", "v2u:42"), "unknown");
  });

  it("returns unknown for missing, empty, and malformed values", () => {
    for (const value of [null, undefined, "", "garbage", "v2:42", "v2:42:-1", "v2:42:1.5"]) {
      assert.equal(compareProcessStartIdentities(base, value as string | null | undefined), "unknown", `actual=${String(value)}`);
      assert.equal(compareProcessStartIdentities(value as string | null | undefined, base), "unknown", `expected=${String(value)}`);
    }
  });
});

// ── Live-host regressions (US-003) ────────────────────────────────────

const LIVE_HOST_SUPPORTED = process.platform === "linux" || process.platform === "darwin";

describe("live host: real reader regressions", () => {
  it("reads a v2 identity for self and a live child through the real kernel source", {
    skip: !LIVE_HOST_SUPPORTED,
  }, async () => {
    const self = getProcessStartIdentity(process.pid);
    assert.ok(self !== null, "self identity must be computable from the real kernel source");
    assert.match(self, new RegExp(`^v2:${process.pid}:\\d+$`), "self identity must have the v2 shape");
    assert.equal(getProcessStartIdentity(process.pid), self, "self identity must be stable across calls");

    const { child, pid } = await spawnLongLivedChild();
    try {
      const childIdentity = await waitForIdentity(pid);
      assert.ok(childIdentity !== null, "a live child's identity must be computable");
      assert.match(childIdentity, new RegExp(`^v2:${pid}:\\d+$`), "child identity must have the v2 shape");
      assert.equal(getProcessStartIdentity(pid), childIdentity, "child identity must be stable across calls");
      assert.notEqual(childIdentity, self, "a different process must have a different identity");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("computes the SAME identity across caller timezones (in-process and spawned children)", {
    skip: !LIVE_HOST_SUPPORTED,
  }, async () => {
    const savedTZ = process.env.TZ;
    const selfBefore = getProcessStartIdentity(process.pid);
    assert.ok(selfBefore !== null, "self identity must be computable");
    try {
      process.env.TZ = "UTC";
      const selfUTC = getProcessStartIdentity(process.pid);
      process.env.TZ = "America/Los_Angeles";
      const selfLA = getProcessStartIdentity(process.pid);
      assert.equal(selfUTC, selfBefore, "TZ=UTC must not change the in-process identity");
      assert.equal(selfLA, selfBefore, "TZ=America/Los_Angeles must not change the in-process identity");
    } finally {
      if (savedTZ === undefined) delete process.env.TZ;
      else process.env.TZ = savedTZ;
    }

    const { child, pid } = await spawnLongLivedChild();
    try {
      const targetIdentity = await waitForIdentity(pid);
      assert.ok(targetIdentity !== null, "the long-lived target's identity must be computable");

      const utcChild = runIdentityChild(pid, { TZ: "UTC" });
      const laChild = runIdentityChild(pid, { TZ: "America/Los_Angeles" });
      assert.equal(utcChild.status, 0, `TZ=UTC child must exit 0: ${summarizeOutput(utcChild.stderr)}`);
      assert.equal(laChild.status, 0, `TZ=America/Los_Angeles child must exit 0: ${summarizeOutput(laChild.stderr)}`);
      assert.equal(
        utcChild.stdout,
        laChild.stdout,
        "the SAME live pid must yield byte-equal identities under different child timezones",
      );
      assert.equal(
        utcChild.stdout.trim(),
        targetIdentity,
        "a spawned child must agree with the in-process reader for the same pid",
      );
    } finally {
      child.kill("SIGKILL");
    }
  });
});

// ── Live-host identity stability (US-004) ─────────────────────────────
//
// Pin the exact property the TZPI kernel identity depends on: for a LIVE pid
// the derived string is byte-stable across re-reads (the linux reader composes
// two clocks — the system boot-time line plus the per-pid starttime tick
// count — so a rounding drift would surface here), and the identity only
// changes once the pid is gone and a different process occupies it.

describe("live host: Linux identity stability (US-004)", () => {
  it("returns byte-equal v2 identities for a live child re-read 100 ms apart", {
    skip: process.platform !== "linux",
  }, async () => {
    const { child, pid } = await spawnLongLivedChild();
    try {
      const first = await waitForIdentity(pid);
      assert.ok(first !== null, "a live child's identity must be computable");
      assert.match(first, new RegExp(`^v2:${pid}:\\d+$`), "first read must have the v2 shape");

      await delay(100);

      const second = getProcessStartIdentity(pid);
      assert.notEqual(second, null, "the child must still be live after 100 ms");
      assert.match(second as string, new RegExp(`^v2:${pid}:\\d+$`), "second read must have the v2 shape");
      assert.equal(
        second,
        first,
        "the SAME live pid must yield a byte-identical identity across re-reads 100 ms apart",
      );
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("returns null once a SIGKILLed child has exited and been reaped", {
    skip: process.platform !== "linux",
  }, async () => {
    const { child, pid } = await spawnLongLivedChild();
    const before = await waitForIdentity(pid);
    assert.ok(before !== null, "a live child's identity must be computable before the kill");

    child.kill("SIGKILL");
    await waitForExit(child);
    await waitForIdentityGone(pid);

    assert.equal(
      getProcessStartIdentity(pid),
      null,
      "a killed and reaped pid must have no identity (procfs entry is gone)",
    );
  });

  it("reports a different identity for a second child and compares 'different'", {
    skip: process.platform !== "linux",
  }, async () => {
    const first = await spawnLongLivedChild();
    const second = await spawnLongLivedChild();
    try {
      // Keep the first child alive while the second spawns so the kernel cannot
      // hand the same pid to both: this pins the different-pid case exactly.
      const firstIdentity = await waitForIdentity(first.pid);
      assert.ok(firstIdentity !== null, "the first child's identity must be computable");

      const secondIdentity = await waitForIdentity(second.pid);
      assert.ok(secondIdentity !== null, "the second child's identity must be computable");

      assert.notEqual(second.pid, first.pid, "two live children must have different pids");
      assert.notEqual(
        secondIdentity,
        firstIdentity,
        "a second live child must have a different identity string",
      );
      assert.equal(
        compareProcessStartIdentities(firstIdentity, secondIdentity),
        "different",
        "two distinct live pids must compare as 'different'",
      );
    } finally {
      first.child.kill("SIGKILL");
      second.child.kill("SIGKILL");
    }
  });
});

// ── Seatbelt sandbox availability (US-003) ────────────────────────────
//
// The signal profile denies signals but allows everything else; the point of
// this regression is that the identity probe does not depend on /bin/ps,
// which is EPERM inside the sandbox. The worker round itself already runs
// under that profile, so nested sandbox_apply is refused there; the
// documented two-tier rule keeps that an honest skip while a genuine
// present-but-unusable host is still distinguished from a real regression.
const SEATBELT_TRIVIAL_PROFILE = "(version 1) (allow default)";
const SEATBELT_PROBE_WALL_MS = 20_000;

/**
 * The bundled profile lives under dist/native after a build; fall back to the
 * source `native/` copy so a direct `node --test` run still finds it. Passing
 * the directory explicitly avoids depending on which copy of
 * native-signal-backend.ts (source vs dist) the test imported.
 */
const DIST_NATIVE_DIR = path.join(REPO_ROOT, "dist", "native");
const SOURCE_NATIVE_DIR = path.join(REPO_ROOT, "native");

function seatbeltArtifactsDir(): string {
  return existsSync(path.join(DIST_NATIVE_DIR, "seatbelt-signal.sb"))
    ? DIST_NATIVE_DIR
    : SOURCE_NATIVE_DIR;
}

describe("seatbelt sandbox availability", () => {
  it("reads a v2 identity inside the bundled Seatbelt signal profile", {
    skip: process.platform !== "darwin",
  }, (t) => {
    const backend = probeBackend({ artifactDir: seatbeltArtifactsDir() });
    if (backend.kind !== "seatbelt") {
      const reason = backend.kind === "unavailable" ? backend.reason : backend.kind;
      t.skip(`no seatbelt backend on this host (${reason}) usable by ${SANDBOX_EXEC_PATH}`);
      return;
    }

    // Tier 1: a trivial known-good profile. A NORMAL nonzero exit proves a
    // present-but-unusable sandbox-exec (e.g. the already-sandboxed worker,
    // where nested sandbox_apply is EPERM) — an honest capability skip. A
    // signal death is unexpected and fails RED, never a blanket skip.
    const trivial = spawnSync(
      backend.sandboxExec,
      ["-p", SEATBELT_TRIVIAL_PROFILE, "/bin/sh", "-c", "exit 0"],
      { encoding: "utf-8", timeout: SEATBELT_PROBE_WALL_MS, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (trivial.signal !== null) {
      assert.fail(
        `sandbox-exec died by ${trivial.signal} on a trivial known-good profile; stderr: ${summarizeOutput(trivial.stderr)}`,
      );
    }
    if (trivial.error) {
      assert.fail(`sandbox-exec trivial probe could not run: ${trivial.error.message}`);
    }
    if (trivial.status !== 0) {
      t.skip(
        `sandbox-exec present but unusable at startup (trivial profile exit ${trivial.status}): ${summarizeOutput(trivial.stderr)}`,
      );
      return;
    }

    // Tier 2: the machinery just worked, so run the REAL compiled reader
    // under the REAL bundled signal profile. Any failure here is a genuine
    // regression and must be RED.
    const script =
      `import { getProcessStartIdentity } from ${JSON.stringify(readerModuleHref())};\n` +
      `const id = getProcessStartIdentity(process.pid);\n` +
      `if (id === null) { console.error("null-identity"); process.exit(3); }\n` +
      `process.stdout.write(id + "\\n");\n`;
    const launch = buildProtectedLaunchArgv(
      [process.execPath, "--input-type=module", "-e", script],
      { backend },
    );
    assert.ok(launch !== null, "buildProtectedLaunchArgv must produce a seatbelt launch");
    assert.equal(launch.spec.kind, "seatbelt", "the launch must use the seatbelt backend");

    const real = spawnSync(launch.spec.argv[0], launch.spec.argv.slice(1), {
      encoding: "utf-8",
      timeout: SEATBELT_PROBE_WALL_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(real.error, undefined, `sandboxed reader could not spawn: ${real.error?.message ?? ""}`);
    assert.equal(
      real.signal,
      null,
      `sandboxed reader died by ${real.signal}; stderr: ${summarizeOutput(real.stderr)}`,
    );
    assert.equal(
      real.status,
      0,
      `sandboxed reader must exit 0 (exit ${real.status}); stderr: ${summarizeOutput(real.stderr)}; stdout: ${summarizeOutput(real.stdout)}`,
    );
    assert.match(
      (real.stdout ?? "").trim(),
      /^v2:\d+:\d+$/,
      "the sandboxed reader must report a v2 identity",
    );
  });
});

describe("source contract", () => {
  it("never invokes ps(1) for identity", () => {
    const source = readFileSync(new URL("./process-start-identity.ts", import.meta.url), "utf-8");
    assert.doesNotMatch(
      source,
      /(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["']ps["']/,
      "the identity module must not shell out to ps for start identity",
    );
  });
});

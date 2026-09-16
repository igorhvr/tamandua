/**
 * Tests for src/lib/proc-info.ts — the sandbox-safe process-metadata layer
 * (MPSX follow-on to the TZPI process-start identity) and the bounded,
 * tri-state process probes (US-002).
 *
 * Coverage:
 *  - helper resolution: the TAMANDUA_PROC_INFO_HELPER env override wins; the
 *    packaged dist layout is discovered on macOS;
 *  - live self introspection through the public API (state / pgid / cmdline /
 *    elapsed / bulk table) without ever needing /bin/ps;
 *  - same-user environment reading (procfs on Linux; KERN_PROCARGS2 via the
 *    native helper's `env` subcommand on macOS) including the NUL-entry
 *    membership test;
 *  - absent pids degrade to null/empty (never throw);
 *  - a source-contract check that the module never shells out to ps for the
 *    data the native helper supplies;
 *  - bounded, tri-state process probes: on macOS the cwd/open-file probes
 *    shell out to lsof, which can block forever on a host with a stale FUSE
 *    mount. These tests pin that every probe is routed through the bounded
 *    `src/lib/lsof-probe.ts` primitive (`-b -w`, pid-scoped, hard SIGKILL
 *    timeout) and that a probe which could not answer is reported as "unknown"
 *    — never silently as "no open files".
 *
 * Classified as serial: proc-info reaches node:child_process (the native
 * helper + ps fallback) and these tests spawn fake lsof shims (one
 * deliberately hangs).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync } from "node:fs";
import { uptime } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROC_INFO_HELPER_BASENAME,
  environHasEntry,
  getCmdline,
  getElapsedSeconds,
  getEnvironText,
  getPgid,
  getProcessCwd,
  getProcessState,
  hasProcfs,
  listProcessDetails,
  probeProcessCwd,
  processHasOpenFileUnder,
  resolveProcInfoHelperPath,
} from "../../dist/lib/proc-info.js";
import { tamanduaTempDir, tamanduaTempRoot } from "../../dist/lib/temp-dir.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** An absurd pid that cannot exist (above the kernel's pid ceiling). */
const ABSENT_PID = 2147483647;

describe("proc-info — native helper resolution", () => {
  it("honors the TAMANDUA_PROC_INFO_HELPER env override", () => {
    const helper = resolveProcInfoHelperPath(
      { TAMANDUA_PROC_INFO_HELPER: "/opt/tamandua/proc-info" },
      MODULE_DIR,
      process.cwd(),
    );
    assert.equal(helper, "/opt/tamandua/proc-info");
  });

  it("resolves the packaged dist/native layout when it exists", () => {
    const packaged = path.resolve(MODULE_DIR, "..", "native", PROC_INFO_HELPER_BASENAME);
    const helper = resolveProcInfoHelperPath({}, MODULE_DIR, process.cwd());
    if (existsSync(packaged)) {
      assert.equal(helper, packaged);
    } else {
      // Source layout: the compiled helper lives under <cwd>/dist/native.
      const distCandidate = path.resolve(
        process.cwd(),
        "dist",
        "native",
        PROC_INFO_HELPER_BASENAME,
      );
      assert.equal(helper, existsSync(distCandidate) ? distCandidate : null);
    }
  });

  it("returns null when no candidate is executable", () => {
    const helper = resolveProcInfoHelperPath({}, "/nonexistent/module/dir", "/nonexistent/cwd");
    assert.equal(helper, null);
  });
});

describe("proc-info — live self introspection (no ps required)", () => {
  it("reports the current process's live state, pgid and command line", () => {
    const state = getProcessState(process.pid);
    assert.ok(state !== null, "self state must be readable");
    assert.notEqual(state, "Z", "self must not be a zombie");
    assert.notEqual(state, "X", "self must not be dead");

    const pgid = getPgid(process.pid);
    assert.ok(pgid !== null && pgid > 0, `self pgid must be positive; got ${String(pgid)}`);

    const cmdline = getCmdline(process.pid);
    assert.ok(cmdline.length > 0, "self command line must be readable");
    assert.match(cmdline, /node/i, "the node test runner must appear in its own cmdline");

    const elapsed = getElapsedSeconds(process.pid);
    assert.ok(elapsed !== null && elapsed >= 0, `self elapsed must be non-negative; got ${String(elapsed)}`);
    assert.ok(elapsed! < 24 * 3600, "self elapsed must be plausible for a test process");
    // The resolved CLK_TCK keeps the elapsed scale and the v2 start identity
    // in agreement; a wrong tick rate would put a live process's elapsed time
    // beyond the host's own uptime.
    assert.ok(
      elapsed! < uptime() + 1,
      `self elapsed ${String(elapsed)} must be below host uptime ${String(uptime())}`,
    );
  });

  it("lists the current process in the bulk process table", () => {
    const details = listProcessDetails();
    assert.ok(details.length > 0, "the process table must not be empty");
    const self = details.find((d) => d.pid === process.pid);
    assert.ok(self !== undefined, "the current process must appear in the table");
    assert.ok(self!.pgid > 0, "table entries must carry a positive pgid");
    assert.notEqual(self!.state, "Z");
    assert.ok(self!.cmdline.length > 0, "table entries must carry the command line");
  });

  it("degrades to null/empty for an absent pid instead of throwing", () => {
    assert.equal(getProcessState(ABSENT_PID), null);
    assert.equal(getPgid(ABSENT_PID), null);
    assert.equal(getCmdline(ABSENT_PID), "");
    assert.equal(getElapsedSeconds(ABSENT_PID), null);
  });
});

/**
 * Environment reading: procfs on Linux, the native helper's `env` subcommand
 * (sysctl KERN_PROCARGS2) on macOS. The helper must be preferred over ps,
 * which cannot see another process's environment at all.
 */
describe("proc-info — same-user environment reading", () => {
  const helperAvailable = resolveProcInfoHelperPath() !== null;
  // Without procfs the env reader depends on the compiled helper; skip
  // honestly when a source checkout was never built.
  const canReadEnv = process.platform !== "darwin" || helperAvailable;

  it("reads HOME / TAMANDUA_STATE_DIR from a same-user child", async (t) => {
    if (!canReadEnv) {
      return t.skip("honest capability skip: proc-info helper not built on darwin");
    }
    const home = tamanduaTempDir("proc-info-home-");
    const stateDir = `${home}/.tamandua`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TAMANDUA_STATE_DIR: stateDir,
      },
      stdio: "ignore",
    });
    const pid = child.pid;
    assert.ok(typeof pid === "number" && pid > 0, "child must have a pid");
    try {
      // The kernel only exposes KERN_PROCARGS2 once the child has exec'd.
      const deadline = Date.now() + 3000;
      let environ = getEnvironText(pid);
      while ((environ === null || !environ.includes(`HOME=${home}`)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        environ = getEnvironText(pid);
      }
      assert.ok(environ !== null, "the child environ must be readable");
      const entries = environ!.split("\0");
      assert.ok(entries.includes(`HOME=${home}`), `HOME=${home} must be present`);
      assert.ok(entries.includes(`TAMANDUA_STATE_DIR=${stateDir}`), "state dir entry must be present");
      assert.equal(environHasEntry(pid, "HOME", home), true);
      assert.equal(environHasEntry(pid, "TAMANDUA_STATE_DIR", stateDir), true);
      assert.equal(environHasEntry(pid, "HOME", `${home}-other`), false);
      // KERN_PROCARGS2 may append the kernel's private apple string vector
      // after the environ (no reliable delimiter), but exact NAME=value
      // membership is unaffected. Assert a couple of real entries survive.
      assert.ok(
        entries.some((entry) => entry.startsWith("HOME=")),
        "the HOME entry must be a clean NUL-separated entry",
      );
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("degrades to null/false for an absent pid instead of throwing", () => {
    assert.equal(getEnvironText(ABSENT_PID), null);
    assert.equal(
      environHasEntry(ABSENT_PID, "HOME", path.join(tamanduaTempRoot(), "whatever")),
      false,
    );
    assert.equal(getEnvironText(-1), null);
    assert.equal(getEnvironText(0), null);
  });
});

const tmpDir = tamanduaTempDir("tamandua-proc-info-");

// Point the logger at an isolated state dir BEFORE any probe runs: runLsof and
// processHasOpenFileUnder warn through logger, and an unisolated logger under
// the test guard records a ledger violation that fails the serial lane even
// when every assertion passes.
const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const stateDir = path.join(tmpDir, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.TAMANDUA_STATE_DIR = stateDir;

/** True on Linux/BSD hosts where the procfs cwd link is the cwd source. */
const procfs = hasProcfs();
/** Far above any live pid — used to exercise the gone-process paths. */
const missingPid = 2147483647;

after(() => {
  if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = originalStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Quote an absolute path for safe interpolation inside a single-quoted shell string. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

let shimSeq = 0;
/** Write an executable fake-lsof shim. */
function writeShim(name: string, body: string): string {
  const file = path.join(tmpDir, `${shimSeq++}-${name}`);
  fs.writeFileSync(file, body, "utf-8");
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * Write an executable fake lsof that prints the given lines (one per line) and
 * exits 0. When `argvFile` is given it also records the argv it received, so a
 * test can assert the exact bounded/pid-scoped flag contract.
 */
function writeLsofShim(name: string, lines: string[], argvFile?: string): string {
  const body = [
    "#!/bin/sh",
    ...(argvFile ? [`printf '%s\\n' "$@" > ${shQuote(argvFile)}`] : []),
    ...lines.map((line) => `printf '%s\\n' ${shQuote(line)}`),
    "exit 0",
  ].join("\n");
  return writeShim(name, `${body}\n`);
}

/** Restore a string env var to its previous value (or unset it). */
function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

/** Run `fn` with TAMANDUA_LSOF_BIN/_TIMEOUT_MS pointed at a fake lsof. */
function withLsofEnv<T>(shim: string, timeoutMs: string | undefined, fn: () => T): T {
  const prevBin = process.env.TAMANDUA_LSOF_BIN;
  const prevTimeout = process.env.TAMANDUA_LSOF_TIMEOUT_MS;
  process.env.TAMANDUA_LSOF_BIN = shim;
  if (timeoutMs === undefined) delete process.env.TAMANDUA_LSOF_TIMEOUT_MS;
  else process.env.TAMANDUA_LSOF_TIMEOUT_MS = timeoutMs;
  try {
    return fn();
  } finally {
    restoreEnv("TAMANDUA_LSOF_BIN", prevBin);
    restoreEnv("TAMANDUA_LSOF_TIMEOUT_MS", prevTimeout);
  }
}

// ── processHasOpenFileUnder (tri-state) ─────────────────────────────

describe("processHasOpenFileUnder (bounded, tri-state)", () => {
  it("returns true when the fake lsof lists a path under the dir, with a -b -w pid-scoped argv", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "open-dir-"));
    const realDir = fs.realpathSync(dir);
    const argvFile = path.join(tmpDir, "argv-true.txt");
    const shim = writeLsofShim(
      "list-under.sh",
      ["p4242", "fcwd", `n${path.join(realDir, "held.log")}`],
      argvFile,
    );

    const result = withLsofEnv(shim, "3000", () => processHasOpenFileUnder(4242, dir));
    assert.equal(result, true);

    const argv = fs.readFileSync(argvFile, "utf-8").trim().split("\n");
    assert.deepEqual(
      argv,
      ["-b", "-w", "-p", "4242", "-Fn"],
      "the probe must be bounded (-b -w) and pid-scoped",
    );
  });

  it("returns true when the dir itself is the open path (exact boundary)", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "open-self-"));
    const realDir = fs.realpathSync(dir);
    const shim = writeLsofShim("list-self.sh", [`n${realDir}`]);
    const result = withLsofEnv(shim, "3000", () => processHasOpenFileUnder(4242, dir));
    assert.equal(result, true);
  });

  it("returns false only when the fake lsof answered OK with no path under the dir", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "closed-dir-"));
    const shim = writeLsofShim("list-other.sh", [
      "p4243",
      "fcwd",
      "n/definitely/elsewhere.log",
    ]);
    const result = withLsofEnv(shim, "3000", () => processHasOpenFileUnder(4243, dir));
    assert.equal(result, false);
  });

  it("returns 'unknown' (never false) for a hanging probe, warns, and SIGKILLs the shim", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "hang-dir-"));
    const pidFile = path.join(tmpDir, "hang-lsof.pid");
    const shim = writeShim(
      "hang-lsof.sh",
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${shQuote(pidFile)}\nprintf 'n/partial\\n'\nexec sleep 60\n`,
    );

    // The bounded probe must REPORT the timeout. runLsof and
    // processHasOpenFileUnder both logger.warn, and the log lives under the
    // isolated TAMANDUA_STATE_DIR, so assert on the appended delta.
    const logFile = path.join(stateDir, "tamandua.log");
    const logBefore = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";

    const startedAt = Date.now();
    const result = withLsofEnv(shim, "800", () => processHasOpenFileUnder(4244, dir));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(
      result,
      "unknown",
      "a timed-out probe must never be reported as 'no open files'",
    );
    assert.ok(
      elapsedMs < 800 + 1000,
      `hung probe must return within timeout+1000ms, took ${elapsedMs}ms`,
    );

    const logAfter = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";
    assert.match(
      logAfter.slice(logBefore.length),
      /timed out|evidence unknown/,
      "a timed-out probe must be reported through logger.warn, not silently swallowed",
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

  it("returns 'unknown' when the lsof binary is unavailable", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "unavail-dir-"));
    const result = withLsofEnv(
      path.join(tmpDir, "definitely-not-a-real-lsof"),
      "1000",
      () => processHasOpenFileUnder(4245, dir),
    );
    assert.equal(result, "unknown");
  });

  it("returns 'unknown' when the directory cannot be resolved", () => {
    const result = processHasOpenFileUnder(
      4246,
      path.join(tmpDir, "does-not-exist", "nested"),
    );
    assert.equal(result, "unknown");
  });
});

// ── probeProcessCwd / getProcessCwd ─────────────────────────────────

describe("probeProcessCwd", () => {
  it("getProcessCwd is null for a nonexistent pid (both platforms)", () => {
    assert.equal(getProcessCwd(missingPid), null);
  });

  it("is ok for the current process via procfs (Linux)", { skip: !procfs }, () => {
    const probe = probeProcessCwd(process.pid);
    assert.equal(probe.status, "ok");
    if (probe.status === "ok") {
      const expected = fs.realpathSync(process.cwd());
      assert.equal(probe.cwd, expected);
    }
  });

  it("is missing for a nonexistent pid via procfs (Linux)", { skip: !procfs }, () => {
    assert.equal(probeProcessCwd(missingPid).status, "missing");
  });

  it("is ok from the fake lsof cwd answer with a -b -w -a -p <pid> -d cwd -Fn argv (macOS)", { skip: procfs }, () => {
    const argvFile = path.join(tmpDir, "cwd-argv.txt");
    const shim = writeLsofShim(
      "cwd-ok.sh",
      ["p4247", "fcwd", "n/Users/example/work"],
      argvFile,
    );

    const probe = withLsofEnv(shim, "3000", () => probeProcessCwd(4247));
    assert.deepEqual(probe, { status: "ok", cwd: "/Users/example/work" });

    const argv = fs.readFileSync(argvFile, "utf-8").trim().split("\n");
    assert.deepEqual(argv, ["-b", "-w", "-a", "-p", "4247", "-d", "cwd", "-Fn"]);
  });

  it("getProcessCwd returns the fake lsof cwd (macOS)", { skip: procfs }, () => {
    const shim = writeLsofShim("cwd-get.sh", ["p4250", "fcwd", "n/canonical/cwd"]);
    const cwd = withLsofEnv(shim, "3000", () => getProcessCwd(4250));
    assert.equal(cwd, "/canonical/cwd");
  });

  it("is missing when the fake lsof answered OK with no cwd row (macOS)", { skip: procfs }, () => {
    const shim = writeLsofShim("cwd-missing.sh", ["p4248", "f0"]);
    const probe = withLsofEnv(shim, "3000", () => probeProcessCwd(4248));
    assert.deepEqual(probe, { status: "missing" });
  });

  it("is unknown (not missing) when the fake lsof hangs (macOS)", { skip: procfs }, () => {
    const shim = writeShim("cwd-hang.sh", "#!/bin/sh\nexec sleep 60\n");
    const startedAt = Date.now();
    const probe = withLsofEnv(shim, "700", () => probeProcessCwd(4249));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(probe.status, "unknown");
    assert.ok(
      elapsedMs < 700 + 1000,
      `cwd probe must return within timeout+1000ms, took ${elapsedMs}ms`,
    );
    if (probe.status === "unknown") {
      assert.ok(probe.reason.length > 0, "unknown must carry a reason");
    }
  });
});

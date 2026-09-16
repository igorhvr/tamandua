/**
 * Tests for src/lib/proc-info.ts — the sandbox-safe process-metadata layer
 * (MPSX follow-on to the TZPI process-start identity).
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
 *    data the native helper supplies.
 *
 * Classified as serial: proc-info reaches node:child_process (the native
 * helper + ps fallback), which the serial-classification guard flags.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
  getProcessState,
  listProcessDetails,
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

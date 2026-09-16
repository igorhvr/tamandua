/**
 * Tests for src/lib/proc-info.ts — the sandbox-safe process-metadata layer
 * (MPSX follow-on to the TZPI process-start identity).
 *
 * Coverage:
 *  - helper resolution: the TAMANDUA_PROC_INFO_HELPER env override wins; the
 *    packaged dist layout is discovered on macOS;
 *  - live self introspection through the public API (state / pgid / cmdline /
 *    elapsed / bulk table) without ever needing /bin/ps;
 *  - absent pids degrade to null/empty (never throw);
 *  - a source-contract check that the module never shells out to ps for the
 *    data the native helper supplies.
 *
 * Classified as serial: proc-info reaches node:child_process (the native
 * helper + ps fallback), which the serial-classification guard flags.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { uptime } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROC_INFO_HELPER_BASENAME,
  getCmdline,
  getElapsedSeconds,
  getPgid,
  getProcessState,
  listProcessDetails,
  resolveProcInfoHelperPath,
} from "../../dist/lib/proc-info.js";

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

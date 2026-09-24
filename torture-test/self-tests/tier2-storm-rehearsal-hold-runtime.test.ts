// Tier-2 STORM-REHEARSAL FIX-4 US-002 — scripted-runtime campaign-controlled
// hold primitive regression test.
//
// SF-7/SF-8: on the tiny scripted fixture the roster runs finished in seconds,
// so the Round-A concurrency window and the Round-B chaos phases were never
// exercisable. The fix is a campaign-owned mid-flight hold: a designated step
// of every roster run parks on `<holdDir>/<runId>.confirmed` and stays ACTIVE
// (step claimed, worker alive) until the engine writes `<holdDir>/<runId>.release`.
// The wait is fail-closed: it is bounded by a timeout and, on expiry, writes
// `<holdDir>/<runId>.missed` with a JSON reason and returns `timeout` so the
// engine can mark the phase MISSED and release the run (requirement 1a/1d).
//
// In-process only (no daemon, no harness, no model): the exported applyHold()
// from the real torture-test/scripted-runtimes/runtime-shared.mjs is driven
// against temp hold dirs, plus static source assertions that the pi and hermes
// runtimes invoke it after a successful claim and before their behavior
// commands on the default 'work' path (acceptance criterion 3).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HOLD_TIMEOUT_MS,
  HOLD_CONFIRMED_SUFFIX,
  HOLD_MISSED_SUFFIX,
  HOLD_RELEASE_SUFFIX,
  applyHold,
  resolveHoldDir,
} from "../scripted-runtimes/runtime-shared.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIMES_DIR = path.resolve(HERE, "..", "scripted-runtimes");

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // diagnostics-only cleanup
    }
  }
});

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("STORM US-002 scripted-runtime hold primitive", () => {
  it("exports the hold constants and a positive default timeout", () => {
    assert.equal(HOLD_CONFIRMED_SUFFIX, ".confirmed");
    assert.equal(HOLD_RELEASE_SUFFIX, ".release");
    assert.equal(HOLD_MISSED_SUFFIX, ".missed");
    assert.equal(typeof DEFAULT_HOLD_TIMEOUT_MS, "number");
    assert.ok(
      DEFAULT_HOLD_TIMEOUT_MS > 0,
      "DEFAULT_HOLD_TIMEOUT_MS must be a positive bound",
    );
    assert.equal(typeof applyHold, "function");
    assert.equal(typeof resolveHoldDir, "function");
  });

  it("resolveHoldDir prefers explicit holdDir, then env, then <stateDir>/holds", () => {
    const saved = process.env.TAMANDUA_SCRIPTED_HOLD_DIR;
    try {
      process.env.TAMANDUA_SCRIPTED_HOLD_DIR = "/env/holds";
      assert.equal(resolveHoldDir({ holdDir: "/explicit", stateDir: "/state" }), "/explicit");
      assert.equal(resolveHoldDir({ stateDir: "/state" }), "/env/holds");
      delete process.env.TAMANDUA_SCRIPTED_HOLD_DIR;
      assert.equal(resolveHoldDir({ stateDir: "/state" }), path.join("/state", "holds"));
      assert.equal(resolveHoldDir({}), null);
    } finally {
      if (saved === undefined) delete process.env.TAMANDUA_SCRIPTED_HOLD_DIR;
      else process.env.TAMANDUA_SCRIPTED_HOLD_DIR = saved;
    }
  });

  it("returns {attempted:false} when the behavior carries no hold", async () => {
    const stateDir = makeTempDir("storm-hold-none-");
    const result = await applyHold({}, { stateDir, runId: "run-none" });
    assert.deepEqual(result, { attempted: false });
    assert.equal(fs.existsSync(path.join(stateDir, "holds")), false);
  });

  it("skips (never throws) when no hold dir can be resolved", async () => {
    const saved = process.env.TAMANDUA_SCRIPTED_HOLD_DIR;
    delete process.env.TAMANDUA_SCRIPTED_HOLD_DIR;
    try {
      const journal: any[] = [];
      const result = await applyHold(
        { hold: { id: "storm-midflight" } },
        { runId: "run-nodir", log: (e: any) => journal.push(e) },
      );
      assert.equal(result.attempted, true);
      assert.equal(result.outcome, "skipped");
      assert.ok(typeof result.reason === "string" && result.reason.length > 0);
      assert.ok(journal.some((e) => e.phase === "hold_skipped"));
    } finally {
      if (saved !== undefined) process.env.TAMANDUA_SCRIPTED_HOLD_DIR = saved;
    }
  });

  it("release path: outcome 'released', confirmed written, no missed marker", async () => {
    const stateDir = makeTempDir("storm-hold-release-");
    const runId = "run-hold-release";
    const journal: any[] = [];

    const promise = applyHold(
      { hold: { id: "storm-midflight", timeoutMs: 10_000 } },
      { stateDir, runId, log: (e: any) => journal.push(e) },
    );

    // Let applyHold write .confirmed, then release it from a real timer —
    // proving the wait is async and never blocks the event loop.
    await sleep(300);
    const holdDir = path.join(stateDir, "holds");
    assert.ok(
      fs.existsSync(path.join(holdDir, `${runId}${HOLD_CONFIRMED_SUFFIX}`)),
      "confirmed checkpoint must exist while the round is held",
    );
    fs.writeFileSync(path.join(holdDir, `${runId}${HOLD_RELEASE_SUFFIX}`), "go\n", "utf-8");

    const result = await promise;
    assert.equal(result.attempted, true);
    assert.equal(result.outcome, "released");
    assert.equal(
      fs.existsSync(path.join(holdDir, `${runId}${HOLD_MISSED_SUFFIX}`)),
      false,
      "a released hold must not leave a missed marker",
    );
    assert.ok(journal.some((e) => e.phase === "hold_wait"));
    assert.ok(
      journal.some((e) => e.phase === "hold_released" && e.how === "release"),
      "release must be journaled with how:'release'",
    );
  });

  it("timeout path: bounded, writes a JSON .missed reason, and returns promptly", async () => {
    const stateDir = makeTempDir("storm-hold-timeout-");
    const runId = "run-hold-timeout";
    const journal: any[] = [];

    const started = Date.now();
    const result = await applyHold(
      { hold: { id: "storm-midflight", timeoutMs: 800 } },
      { stateDir, runId, log: (e: any) => journal.push(e) },
    );
    const elapsed = Date.now() - started;

    assert.equal(result.attempted, true);
    assert.equal(result.outcome, "timeout");
    assert.ok(
      typeof result.reason === "string" && result.reason.length > 0,
      "timeout must carry a non-empty reason",
    );
    // Fail-closed bound: far below the 10s test deadline, and clearly not an
    // unbounded hang (the poll cadence may add up to ~250ms of slack).
    assert.ok(elapsed >= 700, `timeout returned too early (${elapsed}ms)`);
    assert.ok(elapsed < 6000, `timeout must be bounded (took ${elapsed}ms)`);

    const holdDir = path.join(stateDir, "holds");
    const missedPath = path.join(holdDir, `${runId}${HOLD_MISSED_SUFFIX}`);
    assert.ok(fs.existsSync(missedPath), "timeout must write the .missed marker");
    const missed = readJson(missedPath);
    assert.equal(missed.runId, runId);
    assert.equal(missed.holdId, "storm-midflight");
    assert.ok(
      typeof missed.reason === "string" && missed.reason.length > 0,
      "the .missed marker must carry a JSON reason",
    );
    assert.ok(
      journal.some((e) => e.phase === "hold_timeout"),
      "timeout must be journaled",
    );
  });

  it("behavior timeoutMs overrides TAMANDUA_SCRIPTED_HOLD_TIMEOUT_MS", async () => {
    const stateDir = makeTempDir("storm-hold-env-");
    const runId = "run-hold-env";
    const saved = process.env.TAMANDUA_SCRIPTED_HOLD_TIMEOUT_MS;
    process.env.TAMANDUA_SCRIPTED_HOLD_TIMEOUT_MS = "60000";
    try {
      const started = Date.now();
      const result = await applyHold(
        { hold: { id: "storm-midflight", timeoutMs: 500 } },
        { stateDir, runId, log: () => {} },
      );
      const elapsed = Date.now() - started;
      assert.equal(result.outcome, "timeout");
      assert.ok(
        elapsed < 5000,
        `behavior timeoutMs must win over the env bound (took ${elapsed}ms)`,
      );
    } finally {
      if (saved === undefined) delete process.env.TAMANDUA_SCRIPTED_HOLD_TIMEOUT_MS;
      else process.env.TAMANDUA_SCRIPTED_HOLD_TIMEOUT_MS = saved;
    }
  });

  it("no scripted-runtime source contains a canned 'recovered' fallback", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        if (content.toLowerCase().includes("recovered")) offenders.push(full);
      }
    };
    walk(RUNTIMES_DIR);
    assert.deepEqual(
      offenders,
      [],
      "chaos recovery must be the product's real recovery, never a canned 'recovered' fallback",
    );
  });

  it("pi and hermes invoke applyHold after claim, before behavior commands, work path only", () => {
    for (const file of ["runtime-pi.mjs", "runtime-hermes.mjs"]) {
      const full = path.join(RUNTIMES_DIR, file);
      const src = fs.readFileSync(full, "utf-8");

      const claimedIdx = src.indexOf('note: "claimed"');
      const applyIdx = src.indexOf("await applyHold(behavior,");
      const actionsIdx = src.indexOf("applyBehaviorActions(behavior,");
      assert.ok(claimedIdx >= 0, `${file} must log the claimed work round`);
      assert.ok(applyIdx >= 0, `${file} must invoke applyHold`);
      assert.ok(actionsIdx >= 0, `${file} must still apply behavior actions`);
      assert.ok(
        applyIdx > claimedIdx,
        `${file}: applyHold must run AFTER the step is claimed`,
      );
      assert.ok(
        applyIdx < actionsIdx,
        `${file}: applyHold must run BEFORE behavior commands`,
      );

      // Only the default 'work' path may hold (chaos/lost-step modes must
      // exercise the product's own recovery, not a parked round).
      const around = src.slice(Math.max(0, applyIdx - 400), applyIdx + 200);
      assert.ok(
        around.includes('mode === "work"'),
        `${file}: applyHold must be guarded by mode === "work"`,
      );

      // The call must live inside a documented KNOB-REGION block.
      const begin = src.lastIndexOf("KNOB-REGION-BEGIN", applyIdx);
      const end = src.indexOf("KNOB-REGION-END", applyIdx);
      assert.ok(begin >= 0 && end > begin, `${file}: applyHold must be within a KNOB-REGION`);
      const between = src.slice(begin, applyIdx);
      assert.equal(
        between.includes("KNOB-REGION-END"),
        false,
        `${file}: applyHold must not be after a KNOB-REGION-END`,
      );

      // The hermes checkpoint must key off the parsed runId, not the stripped
      // inputVars.RUN_ID (which would never match the engine's release file).
      const callLine = src.slice(applyIdx, src.indexOf(");", applyIdx) + 2);
      assert.ok(
        callLine.includes("runId"),
        `${file}: applyHold must use the parsed runId`,
      );
      assert.equal(
        callLine.includes("inputVars.RUN_ID"),
        false,
        `${file}: applyHold must not use the stripped inputVars.RUN_ID`,
      );
    }
  });
});

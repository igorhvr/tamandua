// Tier-2 STORM-REHEARSAL FIX-5 US-003 (SF-10) — one-shot per-run hold.
//
// SF-10 (medium): the scripted-runtime applyHold() used to delete any existing
// `<runId>.release` / `<runId>.missed` marker at entry, then write `.confirmed`
// and wait up to 1800 s. Because every merger/doer behavior carries the hold,
// the NEXT invocation of the SAME run — the second merger round after a
// finalize_merge reroute, or a DRDV do-again — re-armed the hold and burned the
// full bound (Round A took ~73 min for exactly this reason).
//
// The fix makes a hold one-shot per (campaign, runId) — the run-lifecycle
// checkpoint: once the engine has released or missed a run, a later invocation
// returns 'already_released' / 'already_missed' immediately, without writing
// `.confirmed`, without waiting, and WITHOUT deleting the engine's marker.
//
// This file pins the exact observed sequence in-process (real temp hold dirs,
// short timeouts, no daemon/harness/model):
//   S1  round-1 release -> round-2 already_released, immediate, markers intact,
//       no hold_wait/hold_timeout journal pair for round 2
//   S2  an existing release alone returns already_released and NEVER recreates
//       `.confirmed`
//   S3  a run with only a `.missed` marker returns already_missed; it survives
//   S4  a real timeout misses the run once; the next invocation returns
//       already_missed immediately
//   S5  a run with no markers still arms normally and fails closed at the bound
//   S6  static source assertions: applyHold no longer rmSyncs release/missed
//       and the one-shot check runs before the write path

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HOLD_CONFIRMED_SUFFIX,
  HOLD_MISSED_SUFFIX,
  HOLD_RELEASE_SUFFIX,
  applyHold,
} from "../scripted-runtimes/runtime-shared.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIMES_DIR = path.resolve(HERE, "..", "scripted-runtimes");
const SHARED_SRC = fs.readFileSync(
  path.join(RUNTIMES_DIR, "runtime-shared.mjs"),
  "utf-8",
);

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A hold-bearing behavior exactly like the generated storm behaviors.
function holdBehavior(timeoutMs: number) {
  return { hold: { id: "storm-midflight", timeoutMs } };
}

function holdPaths(stateDir: string, runId: string) {
  const holdDir = path.join(stateDir, "holds");
  return {
    holdDir,
    confirmedPath: path.join(holdDir, `${runId}${HOLD_CONFIRMED_SUFFIX}`),
    releasePath: path.join(holdDir, `${runId}${HOLD_RELEASE_SUFFIX}`),
    missedPath: path.join(holdDir, `${runId}${HOLD_MISSED_SUFFIX}`),
  };
}

describe("STORM-REHEARSAL-FIX5 US-003 (SF-10) one-shot per-run hold", () => {
  it("S1: round-1 release then round-2 already_released immediately, markers intact, no re-arm", async () => {
    const stateDir = makeTempDir("storm-hold-oneshot-release-");
    const runId = "run-oneshot-release";
    const { holdDir, confirmedPath, releasePath, missedPath } = holdPaths(stateDir, runId);

    // ── Round 1: park, then the engine releases from a real timer ──
    const j1: any[] = [];
    const inv1 = applyHold(holdBehavior(10_000), {
      stateDir,
      runId,
      log: (e: any) => j1.push(e),
    });
    await sleep(300);
    assert.ok(
      fs.existsSync(confirmedPath),
      "round 1 must park (write .confirmed) while held",
    );
    const confirmedBytes = fs.readFileSync(confirmedPath, "utf-8");
    const confirmedMtime = fs.statSync(confirmedPath).mtimeMs;
    fs.writeFileSync(releasePath, "go\n", "utf-8");

    const r1 = await inv1;
    assert.equal(r1.attempted, true);
    assert.equal(r1.outcome, "released");
    assert.equal(r1.holdId, "storm-midflight");
    assert.equal(r1.holdDir, holdDir);
    assert.ok(j1.some((e) => e.phase === "hold_released"), "round 1 released");
    const releaseBytes = fs.readFileSync(releasePath, "utf-8");

    // ── Round 2: same runId (finalize_merge reroute / do-again) ─────
    const j2: any[] = [];
    const started = Date.now();
    const r2 = await applyHold(holdBehavior(10_000), {
      stateDir,
      runId,
      log: (e: any) => j2.push(e),
    });
    const elapsed = Date.now() - started;

    assert.equal(r2.attempted, true);
    assert.equal(r2.outcome, "already_released");
    assert.equal(r2.holdId, "storm-midflight");
    assert.equal(r2.holdDir, holdDir);
    assert.ok(
      elapsed < 1000,
      `already_released must return immediately, not wait (took ${elapsed}ms)`,
    );
    assert.ok(
      j2.some((e) => e.phase === "hold_already_released"),
      "round 2 must journal hold_already_released",
    );
    assert.equal(
      j2.some((e) => e.phase === "hold_wait"),
      false,
      "round 2 must not re-arm (no hold_wait)",
    );
    assert.equal(
      j2.some((e) => e.phase === "hold_timeout"),
      false,
      "round 2 must not burn the bound (no hold_timeout)",
    );

    // No marker was recreated, altered, or deleted.
    assert.equal(
      fs.readFileSync(confirmedPath, "utf-8"),
      confirmedBytes,
      "round 2 must not alter .confirmed",
    );
    assert.equal(
      fs.statSync(confirmedPath).mtimeMs,
      confirmedMtime,
      "round 2 must not rewrite .confirmed",
    );
    assert.equal(
      fs.readFileSync(releasePath, "utf-8"),
      releaseBytes,
      "round 2 must not delete/alter the engine's .release marker",
    );
    assert.equal(
      fs.existsSync(missedPath),
      false,
      "a released run must not gain a .missed marker",
    );
  });

  it("S2: an existing release alone returns already_released and never recreates .confirmed", async () => {
    const stateDir = makeTempDir("storm-hold-oneshot-noconfirm-");
    const runId = "run-oneshot-noconfirm";
    const { confirmedPath, releasePath, missedPath } = holdPaths(stateDir, runId);
    fs.mkdirSync(path.dirname(releasePath), { recursive: true });
    fs.writeFileSync(releasePath, "released\n", "utf-8");

    const journal: any[] = [];
    const r = await applyHold(holdBehavior(10_000), {
      stateDir,
      runId,
      log: (e: any) => journal.push(e),
    });

    assert.equal(r.outcome, "already_released");
    assert.equal(
      fs.existsSync(confirmedPath),
      false,
      "already_released must not recreate .confirmed",
    );
    assert.equal(fs.readFileSync(releasePath, "utf-8"), "released\n");
    assert.equal(fs.existsSync(missedPath), false);
    assert.ok(journal.some((e) => e.phase === "hold_already_released"));
    assert.equal(journal.some((e) => e.phase === "hold_wait"), false);
    assert.equal(journal.some((e) => e.phase === "hold_timeout"), false);
  });

  it("S3: a run with only a .missed marker returns already_missed and the marker survives", async () => {
    const stateDir = makeTempDir("storm-hold-oneshot-missed-");
    const runId = "run-oneshot-missed";
    const { confirmedPath, releasePath, missedPath } = holdPaths(stateDir, runId);
    fs.mkdirSync(path.dirname(missedPath), { recursive: true });
    const missedBytes = JSON.stringify({ runId, reason: "prior bound" }) + "\n";
    fs.writeFileSync(missedPath, missedBytes, "utf-8");

    const journal: any[] = [];
    const started = Date.now();
    const r = await applyHold(holdBehavior(10_000), {
      stateDir,
      runId,
      log: (e: any) => journal.push(e),
    });
    const elapsed = Date.now() - started;

    assert.equal(r.outcome, "already_missed");
    assert.equal(r.holdId, "storm-midflight");
    assert.ok(elapsed < 1000, `already_missed must be immediate (took ${elapsed}ms)`);
    assert.equal(
      fs.existsSync(confirmedPath),
      false,
      "already_missed must not write .confirmed",
    );
    assert.equal(
      fs.readFileSync(missedPath, "utf-8"),
      missedBytes,
      "the .missed marker must survive",
    );
    assert.equal(fs.existsSync(releasePath), false);
    assert.ok(journal.some((e) => e.phase === "hold_already_missed"));
    assert.equal(journal.some((e) => e.phase === "hold_wait"), false);
    assert.equal(journal.some((e) => e.phase === "hold_timeout"), false);
  });

  it("S4: a real timeout misses the run once; the next invocation returns already_missed immediately", async () => {
    const stateDir = makeTempDir("storm-hold-oneshot-timeout-");
    const runId = "run-oneshot-timeout";
    const { confirmedPath, missedPath } = holdPaths(stateDir, runId);

    const j1: any[] = [];
    const r1 = await applyHold(holdBehavior(400), {
      stateDir,
      runId,
      log: (e: any) => j1.push(e),
    });
    assert.equal(r1.outcome, "timeout");
    assert.ok(fs.existsSync(confirmedPath), "the timed-out run did arm");
    assert.ok(fs.existsSync(missedPath), "the timeout wrote .missed");
    const missedBytes = fs.readFileSync(missedPath, "utf-8");

    const j2: any[] = [];
    const started = Date.now();
    const r2 = await applyHold(holdBehavior(10_000), {
      stateDir,
      runId,
      log: (e: any) => j2.push(e),
    });
    const elapsed = Date.now() - started;

    assert.equal(r2.outcome, "already_missed");
    assert.ok(elapsed < 1000, `already_missed must be immediate (took ${elapsed}ms)`);
    assert.equal(
      fs.readFileSync(missedPath, "utf-8"),
      missedBytes,
      "the .missed marker must not be rewritten or deleted",
    );
    assert.ok(j2.some((e) => e.phase === "hold_already_missed"));
    assert.equal(j2.some((e) => e.phase === "hold_wait"), false);
    assert.equal(j2.some((e) => e.phase === "hold_timeout"), false);
  });

  it("S5: a run with no markers still arms normally and fails closed at the bound", async () => {
    const stateDir = makeTempDir("storm-hold-oneshot-fresh-");
    const runId = "run-oneshot-fresh";
    const { confirmedPath, releasePath, missedPath } = holdPaths(stateDir, runId);

    const journal: any[] = [];
    const started = Date.now();
    const r = await applyHold(holdBehavior(500), {
      stateDir,
      runId,
      log: (e: any) => journal.push(e),
    });
    const elapsed = Date.now() - started;

    assert.equal(r.outcome, "timeout");
    assert.ok(elapsed >= 450, `timeout must respect the bound (took ${elapsed}ms)`);
    assert.ok(elapsed < 6000, `timeout must stay bounded (took ${elapsed}ms)`);
    assert.ok(fs.existsSync(confirmedPath), "a fresh run still arms (.confirmed)");
    assert.ok(fs.existsSync(missedPath), "a fresh run still writes .missed on timeout");
    assert.equal(fs.existsSync(releasePath), false);
    assert.ok(journal.some((e) => e.phase === "hold_wait"));
    assert.ok(journal.some((e) => e.phase === "hold_timeout"));
  });

  it("S6: source — applyHold never rmSyncs a marker and checks one-shot before the write path", () => {
    const start = SHARED_SRC.indexOf("export async function applyHold(");
    assert.ok(start >= 0, "applyHold must exist");
    const end = SHARED_SRC.indexOf("KNOB-REGION-END", start);
    assert.ok(end > start, "applyHold must live inside a KNOB-REGION");
    const body = SHARED_SRC.slice(start, end);

    assert.equal(
      /rmSync\(/.test(body),
      false,
      "applyHold must not rmSync any release/missed marker it did not write",
    );
    assert.equal(
      /\[releasePath, missedPath\]/.test(body),
      false,
      "the stale-marker cleanup loop must be gone",
    );

    const oneShotIdx = body.indexOf("SF-10 one-shot rule");
    const releaseCheckIdx = body.indexOf("fs.existsSync(releasePath)");
    const missedCheckIdx = body.indexOf("fs.existsSync(missedPath)");
    const confirmedWriteIdx = body.search(/fs\.writeFileSync\(\s*confirmedPath/);
    const tryIdx = body.indexOf("try {");

    assert.ok(oneShotIdx >= 0, "the one-shot comment must be present");
    assert.ok(releaseCheckIdx > oneShotIdx, "release one-shot check must follow the comment");
    assert.ok(missedCheckIdx > releaseCheckIdx, "missed one-shot check must follow release");
    assert.ok(confirmedWriteIdx >= 0, "the confirmed write must still exist");
    assert.ok(
      tryIdx > 0 && releaseCheckIdx < tryIdx,
      "the one-shot checks must run before the write path",
    );
    assert.ok(
      body.includes("hold_already_released") && body.includes("hold_already_missed"),
      "both one-shot outcomes must be journaled",
    );
  });
});

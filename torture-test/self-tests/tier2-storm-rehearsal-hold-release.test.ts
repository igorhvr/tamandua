// Tier-2 STORM-REHEARSAL FIX-4 US-005 — engine-side hold-confirmation, release
// and roster-release helper regression test.
//
// SF-7/SF-8: on the tiny scripted fixture every roster run finished in
// seconds, so the Round-A concurrency window and every Round-B chaos phase
// were never exercisable. US-002 added the runtime-side hold primitive (the
// run parks on `<holdDir>/<runId>.confirmed` until `<holdDir>/<runId>.release`
// appears); US-005 adds the ENGINE side that resolves the one campaign-owned
// hold dir and owns the release decision (requirement 1a/1d):
//
//   * resolveHoldDir(ctx, state)    — the campaign scripted hold dir or an
//                                     explicit absolute ctx.opts.holdDir, else null.
//   * holdConfirmation(ctx, state, runId) — confirmed/missed (with the JSON
//                                     missed reason); missing/unreadable = false.
//   * releaseHold(...)              — writes <holdDir>/<runId>.release and
//                                     records ops; a missing runId is a recorded
//                                     no-op, never a throw.
//   * releaseHoldsForRoster(...)    — releases the current run id plus every
//                                     recorded child/relaunch run id.
//
// In-process only (no daemon, no harness, no model, no ports). The helpers are
// pure-injected: the real module is driven through ctx.fs / ctx.clock, so this
// test both exercises a REAL temp-dir fs and an in-memory synthetic fs (proving
// no real filesystem is touched when ctx.fs is injected).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  holdConfirmation,
  releaseHold,
  releaseHoldsForRoster,
  resolveHoldDir,
} from "../bin/tt-storm-engine.mjs";

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

// A minimal synthetic clock (no real time) — mirrors the recording gate shape.
function makeClock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return {
    nowMs: () => ms,
    nowUtc: () => new Date(ms).toISOString(),
    advance: (n: number) => { ms += n; },
  };
}

// A recording ops recorder (append-only in memory); throws if asked to record
// a non-string kind so a helper passing garbage is caught.
function makeOps() {
  const entries: any[] = [];
  return {
    entries,
    record(kind: string, detail: any = {}) {
      if (typeof kind !== "string" || kind.length === 0) throw new Error("bad op kind");
      entries.push({ kind, ...detail });
      return kind;
    },
    ofKind(kind: string) {
      return entries.filter((e) => e.kind === kind);
    },
  };
}

// In-memory fs adapter (records writes; throws on missing reads exactly like
// node fs). Used to prove the helpers are pure-injected.
function makeMemoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    existsSync: (p: string) => files.has(path.normalize(p)) || dirs.has(path.normalize(p)),
    readFileSync: (p: string) => {
      const k = path.normalize(p);
      if (!files.has(k)) throw new Error(`memory fs: no such file ${k}`);
      return files.get(k) as string;
    },
    writeFileSync: (p: string, data: any) => {
      const k = path.normalize(p);
      files.set(k, String(data));
      let d = path.dirname(k);
      while (d !== "/" && d !== "." && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    mkdirSync: (p: string) => {
      let d = path.normalize(p);
      while (d !== "/" && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    snapshot: () => Object.fromEntries(files),
  };
}

function stateWithStateDir(stateDir: string | null) {
  return {
    rehearsal: stateDir
      ? { scripted_runtime: { state_dir: stateDir }, hold_schedule: { hold_id: "storm-midflight" } }
      : undefined,
  };
}

describe("STORM US-005 engine hold-release helpers", () => {
  it("resolveHoldDir prefers an absolute override, derives from the scripted state dir, else null", () => {
    const stateDir = makeTempDir("storm-hd-state-");
    const state = stateWithStateDir(stateDir);

    // Explicit absolute override wins.
    assert.equal(
      resolveHoldDir({ opts: { holdDir: "/explicit/holds" } }, state),
      "/explicit/holds",
    );
    // A relative override is IGNORED (never resolved against cwd/HOME) and the
    // campaign scripted state dir is used instead.
    assert.equal(
      resolveHoldDir({ opts: { holdDir: "relative/holds" } }, state),
      path.join(stateDir, "holds"),
    );
    // No override -> derive from state.rehearsal.scripted_runtime.state_dir.
    assert.equal(resolveHoldDir({ opts: {} }, state), path.join(stateDir, "holds"));
    // Neither -> null (never a guess).
    assert.equal(resolveHoldDir({ opts: {} }, {}), null);
    assert.equal(resolveHoldDir({ opts: {} }, null), null);
    assert.equal(resolveHoldDir({ opts: {} }, stateWithStateDir(null)), null);
  });

  it("holdConfirmation reports confirmed/missed with the JSON missed reason and never throws", () => {
    const holdDir = makeTempDir("storm-hc-real-");
    const ctx = { fs, clock: makeClock(), opts: { holdDir } };
    const state = stateWithStateDir(null);
    const runId = "run-confirm-1";

    // Nothing yet.
    assert.deepEqual(holdConfirmation(ctx, state, runId), {
      confirmed: false, missed: false, missedReason: null,
    });

    // Confirmed marker (empty file is still a confirmation).
    fs.writeFileSync(path.join(holdDir, `${runId}.confirmed`), "");
    assert.deepEqual(holdConfirmation(ctx, state, runId), {
      confirmed: true, missed: false, missedReason: null,
    });

    // Missed marker with a JSON reason.
    fs.writeFileSync(
      path.join(holdDir, `${runId}.missed`),
      JSON.stringify({ runId, holdId: "storm-midflight", reason: "bounded hold timeout", ts: "T" }),
    );
    const missed = holdConfirmation(ctx, state, runId);
    assert.equal(missed.confirmed, true);
    assert.equal(missed.missed, true);
    assert.equal(missed.missedReason, "bounded hold timeout");

    // A missed marker with unparseable content stays missed with a null reason.
    fs.writeFileSync(path.join(holdDir, "run-bad-json.missed"), "{not json");
    assert.deepEqual(holdConfirmation(ctx, state, "run-bad-json"), {
      confirmed: false, missed: true, missedReason: null,
    });

    // Missing runId / unknown run / no holdDir: false, never a throw.
    assert.deepEqual(holdConfirmation(ctx, state, ""), {
      confirmed: false, missed: false, missedReason: null,
    });
    assert.deepEqual(holdConfirmation(ctx, state, "run-unknown"), {
      confirmed: false, missed: false, missedReason: null,
    });
    assert.deepEqual(holdConfirmation({ fs, clock: makeClock(), opts: {} }, {}, runId), {
      confirmed: false, missed: false, missedReason: null,
    });

    // A throwing fs (unreadable marker) never propagates.
    const throwingFs = { readFileSync: () => { throw new Error("EACCES"); } };
    assert.deepEqual(holdConfirmation({ fs: throwingFs, clock: makeClock(), opts: { holdDir } }, {}, runId), {
      confirmed: false, missed: false, missedReason: null,
    });
  });

  it("releaseHold writes the release file, records ops, is idempotent and never throws", () => {
    const holdDir = makeTempDir("storm-rel-real-");
    const clock = makeClock();
    const ctx = { fs, clock, opts: { holdDir } };
    const state = stateWithStateDir(null);
    const ops = makeOps();
    const runId = "run-release-1";

    assert.equal(releaseHold(ctx, state, ops, runId, { id: "storm-midflight", reason: "phase fired" }), true);
    const relPath = path.join(holdDir, `${runId}.release`);
    assert.ok(fs.existsSync(relPath), "release file must exist");
    const payload = JSON.parse(fs.readFileSync(relPath, "utf-8"));
    assert.deepEqual(payload, {
      runId, holdId: "storm-midflight", reason: "phase fired", ts: clock.nowUtc(),
    });
    const released = ops.ofKind("hold.released");
    assert.equal(released.length, 1);
    assert.equal(released[0].runId, runId);
    assert.equal(released[0].holdId, "storm-midflight");
    assert.equal(released[0].reason, "phase fired");

    // Idempotent: a second release rewrites and records again (still true).
    clock.advance(1000);
    assert.equal(releaseHold(ctx, state, ops, runId, { id: "storm-midflight", reason: "again" }), true);
    assert.equal(JSON.parse(fs.readFileSync(relPath, "utf-8")).reason, "again");
    assert.equal(ops.ofKind("hold.released").length, 2);

    // Missing runId -> recorded no-op, false, never a throw; no file written.
    for (const bad of [null, undefined, "", 0]) {
      assert.equal(releaseHold(ctx, state, ops, bad as any, { reason: "no target" }), false);
    }
    const skipped = ops.ofKind("hold.release_skipped");
    assert.equal(skipped.length, 4);
    for (const s of skipped) assert.equal(s.detail, "no runId");

    // No hold dir -> recorded skip, false, never a throw.
    assert.equal(releaseHold({ fs, clock, opts: {} }, {}, ops, "run-nodir", {}), false);
    assert.equal(ops.ofKind("hold.release_skipped").length, 5);
    assert.equal(ops.ofKind("hold.released").length, 2);
  });

  it("releaseHold is pure-injected: it never touches the real fs when ctx.fs is synthetic", () => {
    const memoryFs = makeMemoryFs();
    const clock = makeClock();
    const holdDir = "/var/holds";
    const ctx = { fs: memoryFs, clock, opts: { holdDir } };
    const ops = makeOps();
    assert.equal(releaseHold(ctx, stateWithStateDir(null), ops, "run-mem", { reason: "r" }), true);
    assert.equal(memoryFs.existsSync(path.join(holdDir, "run-mem.release")), true);
    assert.ok(!fs.existsSync(path.join(holdDir, "run-mem.release")), "real fs must be untouched");

    // holdConfirmation also reads only the injected fs.
    memoryFs.writeFileSync(path.join(holdDir, "run-mem.confirmed"), "{}");
    assert.equal(holdConfirmation(ctx, stateWithStateDir(null), "run-mem").confirmed, true);
    assert.equal(holdConfirmation(ctx, stateWithStateDir(null), "run-absent").confirmed, false);
  });

  it("releaseHoldsForRoster releases the current run id plus children and relaunch lineage", () => {
    const holdDir = makeTempDir("storm-roster-real-");
    const clock = makeClock();
    const ctx = { fs, clock, opts: { holdDir } };
    const ops = makeOps();
    const state: any = {
      rehearsal: { hold_schedule: { hold_id: "storm-midflight" } },
      rounds: {
        B: {
          runs: {
            B1: { runId: "run-b1", children: [{ runId: "run-b1-child" }, "run-b1-child2"] },
            B5: { runId: "run-b5" },
            "B5-relaunch": { runId: "run-b5-relaunch", relaunchOf: "B5" },
            B4: { runId: "run-b4" },
          },
        },
      },
    };

    const releasedB1 = releaseHoldsForRoster(ctx, state, ops, "B", ["B1"], "phase release");
    assert.deepEqual(releasedB1.sort(), ["run-b1", "run-b1-child", "run-b1-child2"].sort());
    for (const id of ["run-b1", "run-b1-child", "run-b1-child2"]) {
      assert.ok(fs.existsSync(path.join(holdDir, `${id}.release`)), `${id} release must exist`);
    }

    // B5's relaunch lineage is released with B5 even though the relaunch is a
    // separate roster record (relaunchOf === 'B5').
    const releasedB5 = releaseHoldsForRoster(ctx, state, ops, "B", ["B5"], "stopdel release");
    assert.deepEqual(releasedB5.sort(), ["run-b5", "run-b5-relaunch"].sort());
    assert.ok(fs.existsSync(path.join(holdDir, "run-b5.release")));
    assert.ok(fs.existsSync(path.join(holdDir, "run-b5-relaunch.release")));

    // Relaunch lineage by parent RUN ID also resolves.
    state.rounds.B.runs["B4-relaunch"] = { runId: "run-b4-relaunch", relaunchOf: "run-b4" };
    const releasedB4 = releaseHoldsForRoster(ctx, state, ops, "B", ["B4"], "run-id lineage");
    assert.deepEqual(releasedB4.sort(), ["run-b4", "run-b4-relaunch"].sort());

    // Unknown roster id / unknown round: no-op, no throw, nothing released.
    assert.deepEqual(releaseHoldsForRoster(ctx, state, ops, "B", ["B9"], "unknown"), []);
    assert.deepEqual(releaseHoldsForRoster(ctx, state, ops, "C", ["B1"], "bad round"), []);

    // Every released id was recorded, and the roster reason landed on each.
    const releasedOps = ops.ofKind("hold.released");
    for (const e of releasedOps) assert.equal(e.holdId, "storm-midflight");
    assert.ok(releasedOps.some((e: any) => e.runId === "run-b5-relaunch" && e.reason === "stopdel release"));
  });

  it("releaseHoldsForRoster is a recorded no-op without a hold dir (never a throw)", () => {
    const ops = makeOps();
    const state: any = { rounds: { B: { runs: { B1: { runId: "run-b1" } } } } };
    assert.deepEqual(
      releaseHoldsForRoster({ fs, clock: makeClock(), opts: {} }, state, ops, "B", ["B1"], "no dir"),
      [],
    );
    const skipped = ops.ofKind("hold.release_skipped");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].runId, "run-b1");
    assert.equal(skipped[0].detail, "no hold dir");
  });
});

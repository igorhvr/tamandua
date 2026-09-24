// Tier-2 STORM-REHEARSAL FIX9 US-007 (SF-15) — REAL non-noop parked product
// fixture + the retained attempt-8/9 noop/already-coherent NEGATIVE fixture.
//
// Attempt 8's post-campaign consistency gate read 0 park-landing evidence even
// though the product really did land four merges on the parked target. The
// cause was an id-shape mismatch: the engine/state/report renders a run as
// `run-<uuid>` while the PRODUCT (src/installer/events.ts) writes every event
// with a BARE-uuid `runId` into a run-scoped `<bare>.jsonl` plus `all.jsonl`.
//
// US-005/US-006 then tightened the strict park predicate: a park landing must
// be a merge.landed with `noop !== true` AND the product's documented
// `checkoutRefresh: "parked:<backup>"` (plus parkedBranch/parkedReason). The
// old committed fixture (attempt-8 lines: noop:true / already-coherent) was the
// exact NPF-1 shape the tightened gate must reject, so it can no longer serve
// as the POSITIVE fixture.
//
// This file now pins BOTH shapes with REAL product output:
//
//   * torture-test/fixtures/storm-product-events/ — four verbatim lines
//     captured from the real product (`bin/tamandua merge-branch`) landing into
//     four hermetic DIRTY checked-out targets: non-noop, `parked:<backup>`,
//     parkedBranch + parkedReason "local-changes";
//   * torture-test/fixtures/storm-product-events-negative/ — the retained
//     attempt-8/9 lines (noop:true / already-coherent), labelled as the
//     NEGATIVE fixture.
//
// It asserts that:
//   * the positive fixture lines are the real product shape (bare runId,
//     merge.landed, noop:false, parked:<backup>, parkedBranch, parkedReason),
//     present verbatim in `<bare>.jsonl` and all.jsonl;
//   * `readProductMergeEvents` with the four PREFIXED state run ids and
//     sinceUtc = B-park firedAt returns targetMoved 0 / landed 4 /
//     parkLanding 4 for the positive fixture and parkLanding 0 for the
//     negative fixture;
//   * the same calls with the four BARE run ids return byte-identical evidence
//     (id-shape invariance on real product lines);
//   * both retained fixtures replay READ-ONLY (snapshot before/after).
//
// Hermetic: it only reads the committed fixtures and (when present) the
// retained READ-ONLY campaign. No temp writes, no daemon, no ports, no
// harness, no git repo, no model token.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { readProductMergeEvents } from "../bin/tt-storm-real.mjs";
import { parseRunKey } from "../bin/tt-storm-shared.mjs";

// ─────────────────────────────────────────────────────────────────────
// The committed fixtures (verbatim real product output).
// ─────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSITIVE_DIR = path.resolve(HERE, "..", "fixtures", "storm-product-events");
const NEGATIVE_DIR = path.resolve(HERE, "..", "fixtures", "storm-product-events-negative");

function loadMeta(dir: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
}
const POS_META = loadMeta(POSITIVE_DIR);
const NEG_META = loadMeta(NEGATIVE_DIR);

function stateRunIds(meta: any): string[] {
  return Object.values(meta.runs).map((r: any) => r.stateRunId);
}
function bareRunIds(meta: any): string[] {
  return Object.values(meta.runs).map((r: any) => r.bareRunId);
}

// The engine/state/report renders each Round B run as `run-<uuid>`.
const POS_PREFIXED_RUN_IDS = stateRunIds(POS_META);
const POS_BARE_RUN_IDS = bareRunIds(POS_META);
const POS_B_PARK_FIRED_AT: string = POS_META.bPark.firedAt;

const NEG_PREFIXED_RUN_IDS = stateRunIds(NEG_META);
const NEG_BARE_RUN_IDS = bareRunIds(NEG_META);
const NEG_B_PARK_FIRED_AT: string = NEG_META.bPark.firedAt;

// The retained attempt-8 campaign state root (READ-ONLY evidence), derived
// from the negative fixture provenance. Replayed only when it still exists.
const RETAINED_EVENTS_DIR: string = NEG_META.provenance.source_events_dir;
const RETAINED_STATE_ROOT = path.dirname(RETAINED_EVENTS_DIR);

function readFixtureLines(dir: string, meta: any): Record<string, any> {
  const byRun: Record<string, any> = {};
  for (const [rosterId, run] of Object.entries(meta.runs as Record<string, any>)) {
    const file = path.join(dir, "events", `${run.bareRunId}.jsonl`);
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
    assert.equal(lines.length, 1, `${file} must carry exactly the one real merge.landed line`);
    byRun[rosterId] = JSON.parse(lines[0]);
  }
  return byRun;
}

function readAllLines(dir: string): any[] {
  const raw = fs.readFileSync(path.join(dir, "events", "all.jsonl"), "utf8");
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

// A mechanical snapshot of a fixture/campaign events dir so a read-only replay
// can prove it did not write, create or delete anything.
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const st = fs.statSync(path.join(dir, name));
    out[name] = `${st.size}:${st.mtimeMs}`;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// The POSITIVE fixture is the real non-noop PARKED product contract.
// ─────────────────────────────────────────────────────────────────────

describe("US-007 (SF-15) positive storm-product-events fixture — real parked product shape", () => {
  it("F1: each positive run-scoped file is a real non-noop parked landing (bare runId, parked:<backup>, local-changes)", () => {
    const byRun = readFixtureLines(POSITIVE_DIR, POS_META);
    for (const [rosterId, run] of Object.entries(POS_META.runs as Record<string, any>)) {
      const evt = byRun[rosterId];
      assert.equal(evt.event, "merge.landed");
      assert.equal(evt.runId, run.bareRunId, `${rosterId} event.runId must be the BARE uuid (never prefixed)`);
      assert.equal(
        evt.runId,
        parseRunKey(run.stateRunId).bare,
        `${rosterId} prefixed state id must canonicalize to the event runId`,
      );
      assert.equal(evt.target, "refs/heads/main");
      assert.equal(evt.noop, false, "the positive fixture landings must be non-noop (a real merge)");
      assert.match(
        String(evt.checkoutRefresh),
        /^parked:.+$/,
        `${rosterId} must carry the product's parked:<backup> checkoutRefresh`,
      );
      assert.ok(evt.parkedBranch, `${rosterId} must name the parked backup branch`);
      assert.equal(evt.parkedReason, "local-changes", `${rosterId} must park with reason local-changes`);
      assert.equal(evt.ts, run.eventTs);
      assert.ok(evt.ts >= POS_B_PARK_FIRED_AT, `${rosterId} landed at/after the B-park firedAt`);
      // The old reader compared raw strings: the prefixed state id is NOT
      // literally present in the product event, which is why it read 0.
      assert.notEqual(evt.runId, run.stateRunId);
    }
    // The metadata contract names the exact product value US-005/US-006 require.
    assert.equal(POS_META.productContract.checkoutRefresh, "parked:<backup>");
    assert.equal(POS_META.productContract.noop, false);
    assert.equal(POS_META.productContract.parkedReason, "local-changes");
    assert.equal(POS_META.expected.landed, 4);
    assert.equal(POS_META.expected.parkLanding, 4);
  });

  it("F2: the positive all.jsonl carries the SAME four run-scoped parked lines verbatim", () => {
    const byRun = readFixtureLines(POSITIVE_DIR, POS_META);
    const allLines = readAllLines(POSITIVE_DIR);
    assert.equal(allLines.length, 4, "all.jsonl must carry exactly the four real landings");
    const runLines = Object.values(byRun).map((e: any) => JSON.stringify(e));
    assert.deepEqual(
      allLines.map((l) => JSON.stringify(l)).sort(),
      runLines.sort(),
      "all.jsonl must be the same four real lines as the run-scoped files",
    );
    for (const evt of allLines) {
      assert.equal(evt.event, "merge.landed");
      assert.equal(evt.noop, false);
      assert.match(String(evt.checkoutRefresh), /^parked:.+$/);
      assert.ok(POS_BARE_RUN_IDS.includes(evt.runId), "every positive line is one of the four bare run ids");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// The retained attempt-8/9 NEGATIVE fixture (noop / already-coherent).
// ─────────────────────────────────────────────────────────────────────

describe("US-007 (SF-15) retained storm-product-events-negative fixture — attempt-8/9 noop shape", () => {
  it("N1: the negative fixture is labelled and every line is the retained noop/already-coherent shape", () => {
    assert.equal(NEG_META.kind, "storm-product-events-negative-fixture");
    assert.equal(NEG_META.provenance.retained_negative, true, "the negative fixture must be clearly labelled retained");
    assert.equal(NEG_META.expected.landed, 4);
    assert.equal(NEG_META.expected.parkLanding, 0, "the retained negative must expect NO park evidence");

    const byRun = readFixtureLines(NEGATIVE_DIR, NEG_META);
    const allLines = readAllLines(NEGATIVE_DIR);
    assert.equal(allLines.length, 4, "the negative all.jsonl must carry exactly the four retained landings");
    assert.deepEqual(
      allLines.map((l) => JSON.stringify(l)).sort(),
      Object.values(byRun)
        .map((e: any) => JSON.stringify(e))
        .sort(),
      "the negative all.jsonl must be the same four retained lines",
    );
    for (const [rosterId, run] of Object.entries(NEG_META.runs as Record<string, any>)) {
      const evt = byRun[rosterId];
      assert.equal(evt.event, "merge.landed");
      assert.equal(evt.runId, run.bareRunId);
      assert.equal(evt.target, "refs/heads/main");
      assert.equal(evt.noop, true, `${rosterId} is a retained noop:true landing`);
      assert.equal(evt.checkoutRefresh, "already-coherent");
      assert.equal(evt.parkedBranch, undefined, "the retained noop shape never parked a checkout");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// readProductMergeEvents on the POSITIVE fixture.
// ─────────────────────────────────────────────────────────────────────

describe("US-007 (SF-15) readProductMergeEvents on the positive parked fixture", () => {
  it("EP1: PREFIXED state run ids + B-park firedAt read targetMoved 0 / landed 4 / parkLanding 4", () => {
    const read = readProductMergeEvents({
      stateRoot: POSITIVE_DIR,
      runIds: POS_PREFIXED_RUN_IDS,
      sinceUtc: POS_B_PARK_FIRED_AT,
    });
    assert.equal(read.ok, true, read.error ?? "");
    assert.equal(read.targetMoved.length, 0);
    assert.equal(read.landed.length, 4, "all four real parked landings must be read");
    assert.equal(read.parkLanding.length, 4, "each non-noop parked landing is strict park evidence");
    for (const evt of read.landed as any[]) {
      assert.ok(POS_BARE_RUN_IDS.includes(evt.runId));
      assert.equal(evt.noop, false);
      assert.match(String(evt.checkoutRefresh), /^parked:.+$/);
      assert.equal(evt.target, "refs/heads/main");
    }
    for (const evt of read.parkLanding as any[]) assert.equal(evt.noop, false);
  });

  it("EP2: BARE run ids produce byte-identical evidence (id-shape invariance on real parked lines)", () => {
    const prefixed = readProductMergeEvents({
      stateRoot: POSITIVE_DIR,
      runIds: POS_PREFIXED_RUN_IDS,
      sinceUtc: POS_B_PARK_FIRED_AT,
    });
    const bare = readProductMergeEvents({
      stateRoot: POSITIVE_DIR,
      runIds: POS_BARE_RUN_IDS,
      sinceUtc: POS_B_PARK_FIRED_AT,
    });
    assert.equal(prefixed.ok, true, prefixed.error ?? "");
    assert.equal(bare.ok, true, bare.error ?? "");
    assert.equal(JSON.stringify(prefixed), JSON.stringify(bare), "the two id shapes must be indistinguishable");
  });

  it("EP3: the run scope still excludes foreign/out-of-window events on real parked lines", () => {
    const afterAll = readProductMergeEvents({
      stateRoot: POSITIVE_DIR,
      runIds: POS_PREFIXED_RUN_IDS,
      sinceUtc: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(afterAll.ok, true, afterAll.error ?? "");
    assert.deepEqual(afterAll.landed, []);

    const foreign = readProductMergeEvents({
      stateRoot: POSITIVE_DIR,
      runIds: ["run-99999999-9999-4999-8999-999999999999"],
      sinceUtc: POS_B_PARK_FIRED_AT,
    });
    assert.equal(foreign.ok, true, foreign.error ?? "");
    assert.deepEqual(foreign.landed, []);
  });
});

// ─────────────────────────────────────────────────────────────────────
// readProductMergeEvents on the NEGATIVE fixture: no park evidence.
// ─────────────────────────────────────────────────────────────────────

describe("US-007 (SF-15) readProductMergeEvents on the retained negative fixture", () => {
  it("EN1: PREFIXED state run ids read landed 4 / parkLanding 0 (the retained NPF-1 shape is rejected)", () => {
    const read = readProductMergeEvents({
      stateRoot: NEGATIVE_DIR,
      runIds: NEG_PREFIXED_RUN_IDS,
      sinceUtc: NEG_B_PARK_FIRED_AT,
    });
    assert.equal(read.ok, true, read.error ?? "");
    assert.equal(read.targetMoved.length, 0);
    assert.equal(read.landed.length, 4);
    assert.equal(read.parkLanding.length, 0, "noop:true / already-coherent lines must NOT be park evidence");
    for (const evt of read.landed as any[]) {
      assert.ok(NEG_BARE_RUN_IDS.includes(evt.runId));
      assert.equal(evt.checkoutRefresh, "already-coherent");
      assert.equal(evt.noop, true);
    }
  });

  it("EN2: BARE run ids produce byte-identical evidence on the retained negative lines", () => {
    const prefixed = readProductMergeEvents({
      stateRoot: NEGATIVE_DIR,
      runIds: NEG_PREFIXED_RUN_IDS,
      sinceUtc: NEG_B_PARK_FIRED_AT,
    });
    const bare = readProductMergeEvents({
      stateRoot: NEGATIVE_DIR,
      runIds: NEG_BARE_RUN_IDS,
      sinceUtc: NEG_B_PARK_FIRED_AT,
    });
    assert.equal(prefixed.ok, true, prefixed.error ?? "");
    assert.equal(bare.ok, true, bare.error ?? "");
    assert.equal(JSON.stringify(prefixed), JSON.stringify(bare), "the two id shapes must be indistinguishable");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Read-only replay of the committed negative fixture / attempt-8 campaign.
// ─────────────────────────────────────────────────────────────────────

describe("US-007 (SF-15) retained negative replays (read-only)", () => {
  it("R1: the committed negative fixture replays 0/4/0 with PREFIXED ids and is never written", () => {
    const eventsDir = path.join(NEGATIVE_DIR, "events");
    const before = snapshotDir(eventsDir);
    const read = readProductMergeEvents({
      stateRoot: NEGATIVE_DIR,
      runIds: NEG_PREFIXED_RUN_IDS,
      sinceUtc: NEG_B_PARK_FIRED_AT,
    });
    assert.equal(read.ok, true, read.error ?? "");
    assert.equal(read.targetMoved.length, 0);
    assert.equal(read.landed.length, 4);
    assert.equal(read.parkLanding.length, 0);
    const after = snapshotDir(eventsDir);
    assert.deepEqual(after, before, "the committed negative fixture must be untouched by the replay");
  });

  it("R2: the retained attempt-8 campaign (when present) reproduces 0/4/0 and is never written or deleted", (t) => {
    if (!fs.existsSync(RETAINED_EVENTS_DIR)) {
      t.skip(`retained attempt-8 events dir absent at ${RETAINED_EVENTS_DIR}`);
      return;
    }
    const before = snapshotDir(RETAINED_EVENTS_DIR);
    const read = readProductMergeEvents({
      stateRoot: RETAINED_STATE_ROOT,
      runIds: NEG_PREFIXED_RUN_IDS,
      sinceUtc: NEG_B_PARK_FIRED_AT,
    });
    assert.equal(read.ok, true, read.error ?? "");
    assert.equal(read.targetMoved.length, 0);
    assert.equal(read.landed.length, 4);
    assert.equal(read.parkLanding.length, 0);
    // Read-only proof: no file created, deleted or touched.
    const after = snapshotDir(RETAINED_EVENTS_DIR);
    assert.deepEqual(after, before, "the retained campaign must be untouched by the replay");
  });
});

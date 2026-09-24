// Tier-2 STORM-REHEARSAL US-004 (SF-14/SF-15) — product merge-event evidence
// channel.
//
// Attempt 7 recorded SF-14 and SF-15 as NOT OBSERVED even though the
// orchestrator's B-rugpull committed in the colleague clone and B-park dirtied
// a tree: neither phase required the PRODUCT to react. The whole point of the
// rugpull phase is that the owned origin's merge target moves under a LIVE
// merge-worktree run so the product emits merge.target_moved (relaunch-upon-
// rugpull); the point of the park phase is that the checked-out merge TARGET
// is dirty so the product's park-first managed landing (merge.landed with
// parking checkoutRefresh) is exercised. A local commit or a dirty-tree action
// is NOT evidence.
//
// This test pins the real reader + predicates:
//
//   * readProductMergeEvents({ stateRoot, runIds, sinceUtc }) reads the private
//     product state dir's `<stateRoot>/events/<runId>.jsonl` (run-scoped) plus
//     `<stateRoot>/events/all.jsonl`, dedups, filters by run id and ts, and
//     returns { ok, targetMoved, landed, parkLanding, error }. A missing/
//     unreadable/malformed channel is ok:false with a reason and never throws.
//   * probePhaseMarkerReal 'rugpull-observed' is satisfied ONLY by a real
//     merge.target_moved event for a targeted run at/after the B-rugpull
//     firedAt; 'park-landed' ONLY by real park-landing/refusal evidence.
//   * buildStormReport / productEvidenceForPhase carry each phase's
//     productEvidence, and a commit-only B-rugpull records targetMoved [].
//
// This file is hermetic: private temp event dirs, a fake DB-open seam and
// synthetic state. No daemon, git repo, harness, model token or production
// port is ever touched.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { newCampaignState } from "../bin/tt-storm-shared.mjs";
import {
  PRODUCT_EVIDENCE_PHASE_IDS,
  buildStormReport,
  productEvidenceForPhase,
} from "../bin/tt-storm-engine.mjs";
import {
  probePhaseMarkerReal,
  readProductMergeEvents,
} from "../bin/tt-storm-real.mjs";

// ─────────────────────────────────────────────────────────────────────
// Fixtures.
// ─────────────────────────────────────────────────────────────────────

const T_BEFORE = "2026-09-13T05:00:00.000Z";
const T_PHASE = "2026-09-13T06:00:00.000Z";
const T_AFTER = "2026-09-13T06:30:00.000Z";

// The engine/state/report render each Round B run in the PUBLIC `run-<uuid>`
// form; the PRODUCT (src/installer/events.ts) writes the same run as a BARE
// uuid in both the event payload and the run-scoped filename. The fixtures
// below are REAL-SHAPED: state/report run ids stay prefixed, while the event
// `runId` and `<root>/events/<file>.jsonl` name use the bare uuid.
const B_RUNS: Record<string, string> = {
  B1: "run-11111111-1111-4111-8111-111111111111",
  B2: "run-22222222-2222-4222-8222-222222222222",
  B3: "run-33333333-3333-4333-8333-333333333333",
  B4: "run-44444444-4444-4444-8444-444444444444",
};

const B_BARE: Record<string, string> = {
  B1: "11111111-1111-4111-8111-111111111111",
  B2: "22222222-2222-4222-8222-222222222222",
  B3: "33333333-3333-4333-8333-333333333333",
  B4: "44444444-4444-4444-8444-444444444444",
};

function ownedTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-merge-events-${label}-`));
}

function writeJsonl(file: string, lines: Array<Record<string, unknown> | string>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

// A merge.target_moved event (the product refused the landing because the
// target ref advanced under it).
function targetMovedEvent(runId: string, ts: string, extra: Record<string, unknown> = {}) {
  return {
    ts,
    event: "merge.target_moved",
    runId,
    origin: "/fixtures/origin",
    branch: "storm/feature",
    target: "refs/heads/main",
    expectedTip: "a".repeat(40),
    actualTip: "b".repeat(40),
    detail: `target refs/heads/main moved: expected ${"a".repeat(40)}, found ${"b".repeat(40)}`,
    ...extra,
  };
}

// A merge.landed event (the product landed a merge on the target).
function landedEvent(runId: string, ts: string, extra: Record<string, unknown> = {}) {
  return {
    ts,
    event: "merge.landed",
    runId,
    origin: "/fixtures/origin",
    branch: "storm/feature",
    target: "refs/heads/main",
    expectedTip: "a".repeat(40),
    mergedTree: "c".repeat(40),
    mergedCommit: "d".repeat(40),
    noop: false,
    checkoutRefresh: "not-applicable",
    ...extra,
  };
}

function makeState(stateRoot: string | null, overrides: Record<string, any> = {}) {
  const clock = { nowUtc: () => T_PHASE };
  const state: any = newCampaignState({
    campaignId: "camp-us004-merge-events",
    clock,
    source: { repo: "/repo", branch: "test", commit: "0".repeat(40), tree: "0".repeat(40) },
    fixture: { name: "tt-poly", basis: "US-004 merge-events self-test" },
  });
  if (stateRoot) state.exec_identity = { state_root: stateRoot };
  state.plan = { launches: [], fixtureIdentity: {} };
  state.rounds.B.runs = Object.fromEntries(
    Object.entries(B_RUNS).map(([rid, runId]) => [rid, { rosterId: rid, runId, status: "registered" }]),
  );
  state.rounds.B.phases = {
    "B-rugpull": { id: "B-rugpull", status: "fired", firedAt: T_PHASE, ops: [] },
    "B-park": { id: "B-park", status: "fired", firedAt: T_PHASE, ops: [] },
    ...(overrides.phases ?? {}),
  };
  return state;
}

function makeCtx(stateRoot: string | null) {
  return {
    clock: { nowUtc: () => T_PHASE, nowMs: () => Date.parse(T_PHASE) },
    fs: {},
    opts: stateRoot ? { execIdentity: { state_root: stateRoot } } : {},
  };
}

// A fake DB-open seam: the new product-event markers never touch the campaign
// DB, but probePhaseMarkerReal opens it first.
const fakeDbOpen = () => ({ ok: true, api: { close() {} } });

function probe(opts: { stateRoot: string | null; state: any; marker: string }) {
  return probePhaseMarkerReal({
    dbOpen: fakeDbOpen as any,
    dbPath: "/nonexistent/campaign.db",
    state: opts.state,
    ph: { waitFor: { kind: "phase", marker: opts.marker } },
    refs: null,
    stateRoot: opts.stateRoot,
  } as any);
}

// ─────────────────────────────────────────────────────────────────────
// readProductMergeEvents.
// ─────────────────────────────────────────────────────────────────────

describe("US-004 (SF-14/15) readProductMergeEvents — real product event channel", () => {
  it("M1: reads the real product shape (bare event runId, <bare>.jsonl) scoped by PREFIXED state run ids, and dedups all.jsonl", () => {
    const root = ownedTmpDir("read");
    try {
      // Real product events: bare `runId`.
      const moved = targetMovedEvent(B_BARE.B1, T_AFTER);
      const parked = landedEvent(B_BARE.B2, T_AFTER, {
        checkoutRefresh: "parked:main-tamandua-parked-20260913T063000Z-deadbe",
        parkedBranch: "main-tamandua-parked-20260913T063000Z-deadbe",
        parkedReason: "local-changes",
      });
      const refreshed = landedEvent(B_BARE.B3, T_AFTER, { checkoutRefresh: "refreshed" });
      const noop = landedEvent(B_BARE.B4, T_AFTER, { checkoutRefresh: "not-applicable" });
      // Same physical event written to BOTH the run-scoped `<bare>.jsonl` file
      // and all.jsonl (the product's documented dual write).
      writeJsonl(path.join(root, "events", `${B_BARE.B1}.jsonl`), [moved]);
      writeJsonl(path.join(root, "events", `${B_BARE.B2}.jsonl`), [parked]);
      writeJsonl(path.join(root, "events", `${B_BARE.B3}.jsonl`), [refreshed]);
      writeJsonl(path.join(root, "events", `${B_BARE.B4}.jsonl`), [noop]);
      writeJsonl(path.join(root, "events", "all.jsonl"), [moved, parked, refreshed, noop]);

      // The engine supplies PREFIXED ids; the product wrote bare ones.
      const read = readProductMergeEvents({ stateRoot: root, runIds: Object.values(B_RUNS) });
      assert.equal(read.ok, true, read.error ?? "");
      assert.equal(read.targetMoved.length, 1, "the tip move is read exactly once (dedup)");
      assert.equal(read.targetMoved[0].runId, B_BARE.B1, "the returned event stays byte-faithful (bare runId, unrewritten)");
      assert.equal(read.landed.length, 3);
      // STRICT (SF-15/US-005): parkLanding is ONLY the non-noop parked landing.
      // 'refreshed' refreshed in place and 'not-applicable' had no attached
      // checkout -> neither is park evidence.
      assert.equal(read.parkLanding.length, 1);
      assert.deepEqual(
        read.parkLanding.map((e: any) => e.runId),
        [B_BARE.B2],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("M1b: PREFIXED and BARE run-id inputs are equivalent on the real product shape (id-shape invariance)", () => {
    const root = ownedTmpDir("invariance");
    try {
      const moved = targetMovedEvent(B_BARE.B1, T_AFTER);
      const parked = landedEvent(B_BARE.B2, T_AFTER, {
        checkoutRefresh: "parked:main-tamandua-parked-20260913T063000Z-deadbe",
        parkedBranch: "main-tamandua-parked-20260913T063000Z-deadbe",
        parkedReason: "local-changes",
      });
      writeJsonl(path.join(root, "events", `${B_BARE.B1}.jsonl`), [moved]);
      writeJsonl(path.join(root, "events", `${B_BARE.B2}.jsonl`), [parked]);
      writeJsonl(path.join(root, "events", "all.jsonl"), [moved, parked]);

      const prefixed = readProductMergeEvents({ stateRoot: root, runIds: Object.values(B_RUNS), sinceUtc: T_PHASE });
      const bare = readProductMergeEvents({ stateRoot: root, runIds: Object.values(B_BARE), sinceUtc: T_PHASE });
      assert.equal(prefixed.ok, true, prefixed.error ?? "");
      assert.equal(bare.ok, true, bare.error ?? "");
      // The attempt-8 failure mode: prefixed must NOT read 0 while bare reads 2.
      assert.equal(prefixed.targetMoved.length, 1, "prefixed scope must see the bare product event");
      assert.equal(prefixed.landed.length, 1, "prefixed scope must see the bare product landing");
      assert.equal(prefixed.parkLanding.length, 1);
      assert.equal(bare.targetMoved.length, 1);
      assert.equal(bare.landed.length, 1);
      assert.equal(bare.parkLanding.length, 1);
      assert.equal(JSON.stringify(prefixed), JSON.stringify(bare), "the two id shapes must produce identical evidence objects");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("M2: sinceUtc and runIds filter mechanical events; a pre-phase or foreign-run event is excluded", () => {
    const root = ownedTmpDir("filter");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        targetMovedEvent(B_BARE.B1, T_BEFORE), // before firedAt -> excluded
        targetMovedEvent("run-99999999-9999-4999-8999-999999999999", T_AFTER), // foreign run -> excluded
        landedEvent(B_BARE.B1, T_AFTER, {
          checkoutRefresh: "parked:main-tamandua-parked-20260913T063000Z-deadbe",
          parkedBranch: "main-tamandua-parked-20260913T063000Z-deadbe",
          parkedReason: "local-changes",
        }),
      ]);
      // At the phase timestamp exactly: >= sinceUtc is included.
      writeJsonl(path.join(root, "events", `${B_BARE.B2}.jsonl`), [
        targetMovedEvent(B_BARE.B2, T_PHASE),
      ]);

      const read = readProductMergeEvents({ stateRoot: root, runIds: Object.values(B_RUNS), sinceUtc: T_PHASE });
      assert.equal(read.ok, true, read.error ?? "");
      assert.deepEqual(read.targetMoved.map((e: any) => e.runId), [B_BARE.B2]);
      assert.equal(read.landed.length, 1);
      assert.equal(read.parkLanding.length, 1, "a non-noop parked landing is park-landing evidence");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("M3: an absent events dir / unreadable path / malformed JSONL is ok:false with a reason (never throws)", () => {
    const root = ownedTmpDir("bad");
    try {
      // (a) missing events dir
      const missing = readProductMergeEvents({ stateRoot: path.join(root, "nope"), runIds: [B_RUNS.B1] });
      assert.equal(missing.ok, false);
      assert.match(String(missing.error), /missing\/unreadable/);
      assert.deepEqual(missing.targetMoved, []);

      // (b) events path is a FILE, not a directory
      const asFile = path.join(root, "file-events");
      fs.mkdirSync(asFile, { recursive: true });
      fs.writeFileSync(path.join(asFile, "events"), "not a dir");
      const notDir = readProductMergeEvents({ stateRoot: asFile, runIds: [B_RUNS.B1] });
      assert.equal(notDir.ok, false);
      assert.match(String(notDir.error), /not a directory/);

      // (c) malformed line
      const malformed = path.join(root, "malformed");
      writeJsonl(path.join(malformed, "events", "all.jsonl"), ["{ this is not json"]);
      const bad = readProductMergeEvents({ stateRoot: malformed, runIds: [B_RUNS.B1] });
      assert.equal(bad.ok, false);
      assert.match(String(bad.error), /malformed/);
      assert.deepEqual(bad.landed, []);

      // (d) an unreadable run file (a directory where the real `<bare>.jsonl` should be)
      const unreadable = path.join(root, "unreadable");
      fs.mkdirSync(path.join(unreadable, "events", `${B_BARE.B1}.jsonl`), { recursive: true });
      const unread = readProductMergeEvents({ stateRoot: unreadable, runIds: [B_RUNS.B1] });
      assert.equal(unread.ok, false);
      assert.match(String(unread.error), /unreadable/);

      // (e) empty/absent stateRoot
      const noRoot = readProductMergeEvents({ stateRoot: "", runIds: [B_RUNS.B1] });
      assert.equal(noRoot.ok, false);
      assert.match(String(noRoot.error), /stateRoot/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("M4: an empty-but-present channel is ok:true with no events (not_yet, never a fabricated match)", () => {
    const root = ownedTmpDir("empty");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        { ts: T_AFTER, event: "run.started", runId: B_BARE.B1 },
        { ts: T_AFTER, event: "step.claimed", runId: B_BARE.B2 },
      ]);
      const read = readProductMergeEvents({ stateRoot: root, runIds: Object.values(B_RUNS), sinceUtc: T_PHASE });
      assert.equal(read.ok, true, read.error ?? "");
      assert.deepEqual(read.targetMoved, []);
      assert.deepEqual(read.landed, []);
      assert.deepEqual(read.parkLanding, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("M5: the older synthetic shape (run-<uuid>.jsonl + prefixed evt.runId) still reads via the compatibility fallback", () => {
    const root = ownedTmpDir("compat");
    try {
      // No all.jsonl at all: only the legacy run-scoped filename carries it.
      writeJsonl(path.join(root, "events", `run-${B_BARE.B1}.jsonl`), [
        landedEvent(B_RUNS.B1, T_AFTER, { checkoutRefresh: "refreshed" }),
      ]);
      const read = readProductMergeEvents({ stateRoot: root, runIds: [B_RUNS.B1] });
      assert.equal(read.ok, true, read.error ?? "");
      assert.equal(read.landed.length, 1, "legacy run-<uuid>.jsonl must remain readable");
      assert.equal(read.landed[0].runId, B_RUNS.B1, "legacy prefixed event runId is preserved byte-faithfully");

      // ...and the same legacy file read through a BARE scope is equivalent.
      const bare = readProductMergeEvents({ stateRoot: root, runIds: [B_BARE.B1] });
      assert.equal(bare.ok, true, bare.error ?? "");
      assert.equal(bare.landed.length, 1);
      assert.equal(JSON.stringify(bare), JSON.stringify(read));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("M6: malformed run ids and an empty scope fail closed without throwing", () => {
    const root = ownedTmpDir("failclosed");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        targetMovedEvent(B_BARE.B1, T_AFTER),
        landedEvent(B_BARE.B2, T_AFTER, { checkoutRefresh: "refreshed" }),
      ]);

      // step- ids and garbage never match; a bare state root is not a scope.
      const malformed = readProductMergeEvents({
        stateRoot: root,
        runIds: ["step-3ef530bd-edc1-4a7b-a1d7-43840009d44a", "garbage", "", "run-not-a-uuid"],
      });
      assert.equal(malformed.ok, true, malformed.error ?? "");
      assert.deepEqual(malformed.targetMoved, [], "a malformed scope must match nothing");
      assert.deepEqual(malformed.landed, []);
      assert.deepEqual(malformed.parkLanding, []);

      // An explicit empty list matches nothing (never everything).
      const empty = readProductMergeEvents({ stateRoot: root, runIds: [] });
      assert.equal(empty.ok, true, empty.error ?? "");
      assert.deepEqual(empty.targetMoved, []);
      assert.deepEqual(empty.landed, []);
      assert.deepEqual(empty.parkLanding, []);

      // Mixed: the one valid id still matches, the malformed ones never do.
      const mixed = readProductMergeEvents({ stateRoot: root, runIds: ["step-3ef530bd-edc1-4a7b-a1d7-43840009d44a", B_RUNS.B1] });
      assert.equal(mixed.ok, true, mixed.error ?? "");
      assert.equal(mixed.targetMoved.length, 1);
      assert.equal(mixed.targetMoved[0].runId, B_BARE.B1);
      assert.equal(mixed.landed.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("M7: parkLanding requires a NON-NOOP parked landing (strict positive + NPF-1 negatives)", () => {
    const root = ownedTmpDir("strict-park");
    try {
      const parked = landedEvent(B_BARE.B1, T_AFTER, {
        checkoutRefresh: "parked:main-tamandua-parked-20260913T063000Z-deadbe",
        parkedBranch: "main-tamandua-parked-20260913T063000Z-deadbe",
        parkedReason: "local-changes",
      });
      // The parked fields WITHOUT a `parked:` refresh are still park evidence.
      const parkedFieldsOnly = landedEvent(B_BARE.B2, T_AFTER, {
        checkoutRefresh: "other",
        parkedBranch: "main-tamandua-parked-b",
        parkedReason: "local-changes",
      });
      // NPF-1: the no-op shapes must never count, even when they carry a
      // parking-looking refresh or a stale parked field.
      const noopAlreadyCoherent = landedEvent(B_BARE.B3, T_AFTER, { noop: true, checkoutRefresh: "already-coherent" });
      const alreadyCoherent = landedEvent(B_BARE.B4, T_AFTER, { checkoutRefresh: "already-coherent" });
      const refreshed = landedEvent(B_BARE.B1, T_AFTER, { checkoutRefresh: "refreshed" });
      const notApplicable = landedEvent(B_BARE.B2, T_AFTER, { checkoutRefresh: "not-applicable" });
      const noopParked = landedEvent(B_BARE.B3, T_AFTER, {
        noop: true,
        checkoutRefresh: "parked:main-tamandua-parked-noop",
        parkedBranch: "main-tamandua-parked-noop",
        parkedReason: "local-changes",
      });
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        parked,
        parkedFieldsOnly,
        noopAlreadyCoherent,
        alreadyCoherent,
        refreshed,
        notApplicable,
        noopParked,
      ]);

      // Positive: only the two real parked landings count.
      const positive = readProductMergeEvents({ stateRoot: root, runIds: Object.values(B_RUNS) });
      assert.equal(positive.ok, true, positive.error ?? "");
      assert.deepEqual(
        positive.parkLanding.map((e: any) => e.runId).sort(),
        [B_BARE.B1, B_BARE.B2].sort(),
        "only non-noop parked landings are park evidence",
      );
      for (const evt of positive.parkLanding as any[]) assert.notEqual(evt.noop, true);

      // Negative acceptance-criterion case: an already-coherent / noop:true
      // landing for a targeted run yields parkLanding [].
      const noopOnly = readProductMergeEvents({ stateRoot: root, runIds: [B_RUNS.B3, B_RUNS.B4] });
      assert.equal(noopOnly.ok, true, noopOnly.error ?? "");
      assert.equal(noopOnly.landed.length, 3, "landed still records the no-op/refresh landings byte-faithfully");
      assert.deepEqual(noopOnly.parkLanding, [], "already-coherent/noop:true/refreshed/not-applicable are NOT park landings");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("M8: a park-detailed merge.target_moved counts only when it is not noop:true", () => {
    const root = ownedTmpDir("refusal-noop");
    try {
      const refusal = targetMovedEvent(B_BARE.B1, T_AFTER, {
        detail: "refused to clobber the dirty parked target checkout",
      });
      const noopRefusal = targetMovedEvent(B_BARE.B2, T_AFTER, {
        noop: true,
        detail: "refused to clobber the dirty parked target checkout",
      });
      writeJsonl(path.join(root, "events", "all.jsonl"), [refusal, noopRefusal]);
      const read = readProductMergeEvents({ stateRoot: root, runIds: Object.values(B_RUNS) });
      assert.equal(read.ok, true, read.error ?? "");
      assert.equal(read.targetMoved.length, 2, "target_moved evidence is still read byte-faithfully");
      assert.deepEqual(
        read.parkLanding.map((e: any) => e.runId),
        [B_BARE.B1],
        "a noop:true park-refusal is not park evidence",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// probePhaseMarkerReal — the two real markers.
// ─────────────────────────────────────────────────────────────────────

describe("US-004 (SF-14) probePhaseMarkerReal 'rugpull-observed'", () => {
  it("R1: a real merge.target_moved at/after the B-rugpull firedAt satisfies — before it does not", () => {
    const root = ownedTmpDir("rug-ok");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [targetMovedEvent(B_BARE.B1, T_AFTER)]);
      const state = makeState(root);
      return probe({ stateRoot: root, state, marker: "rugpull-observed" }).then((v: any) => {
        assert.equal(v.satisfied, true, v.reason ?? v.evidence);
        assert.equal(v.outcome, "marker_satisfied");
        assert.equal(v.productEvidence.targetMoved.length, 1);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2: an event BEFORE the firedAt (or for a foreign run) does not satisfy", async () => {
    const root = ownedTmpDir("rug-before");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        targetMovedEvent(B_BARE.B1, T_BEFORE),
        targetMovedEvent("run-99999999-9999-4999-8999-999999999999", T_AFTER),
      ]);
      const state = makeState(root);
      const v = await probe({ stateRoot: root, state, marker: "rugpull-observed" });
      assert.equal(v.satisfied, false);
      assert.equal(v.outcome, "not_yet", "the channel is healthy but the targeted event is absent");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("R3: commit-only (no product event) is not_yet, never satisfied", async () => {
    const root = ownedTmpDir("rug-commitonly");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        { ts: T_AFTER, event: "run.started", runId: B_BARE.B1 },
      ]);
      const state = makeState(root);
      const v = await probe({ stateRoot: root, state, marker: "rugpull-observed" });
      assert.equal(v.satisfied, false);
      assert.equal(v.outcome, "not_yet");
      assert.equal(v.productEvidence.targetMoved.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("R4: an absent channel is evidence_error (UNKNOWN); an unfired phase is not_yet", async () => {
    const root = ownedTmpDir("rug-error");
    try {
      const state = makeState(root);
      const err = await probe({ stateRoot: path.join(root, "missing"), state, marker: "rugpull-observed" });
      assert.equal(err.satisfied, false);
      assert.equal(err.outcome, "evidence_error");

      const unfired = makeState(root, { phases: { "B-rugpull": { id: "B-rugpull", status: "pending", firedAt: null } } });
      const v = await probe({ stateRoot: root, state: unfired, marker: "rugpull-observed" });
      assert.equal(v.satisfied, false);
      assert.equal(v.outcome, "not_yet");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("US-004 (SF-15) probePhaseMarkerReal 'park-landed'", () => {
  it("P1: only a NON-NOOP parked merge.landed satisfies; refreshed/already-coherent/noop do not", async () => {
    // Positive: the documented park value plus explicit parked fields.
    const root = ownedTmpDir("park-strict");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        landedEvent(B_BARE.B4, T_AFTER, {
          checkoutRefresh: "parked:main-tamandua-parked-20260913T063000Z-deadbe",
          parkedBranch: "main-tamandua-parked-20260913T063000Z-deadbe",
          parkedReason: "local-changes",
        }),
      ]);
      const state = makeState(root);
      const ok: any = await probe({ stateRoot: root, state, marker: "park-landed" });
      assert.equal(ok.satisfied, true, ok.reason ?? ok.evidence);
      assert.equal(ok.outcome, "marker_satisfied");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    // NPF-1 negatives: refreshed / already-coherent / not-applicable / noop:true
    // must never satisfy the park predicate.
    for (const [label, extra] of [
      ["refreshed", { checkoutRefresh: "refreshed" }],
      ["already-coherent", { checkoutRefresh: "already-coherent" }],
      ["noop already-coherent", { noop: true, checkoutRefresh: "already-coherent" }],
      ["not-applicable", { checkoutRefresh: "not-applicable" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const negativeRoot = ownedTmpDir("park-negative");
      try {
        writeJsonl(path.join(negativeRoot, "events", "all.jsonl"), [landedEvent(B_BARE.B4, T_AFTER, extra)]);
        const v: any = await probe({ stateRoot: negativeRoot, state: makeState(negativeRoot), marker: "park-landed" });
        assert.equal(v.satisfied, false, `${label} must NOT satisfy park-landed: ${v.reason ?? v.evidence}`);
        assert.equal(v.outcome, "not_yet");
        assert.deepEqual(v.productEvidence.parkLanding, []);
      } finally {
        fs.rmSync(negativeRoot, { recursive: true, force: true });
      }
    }
  });

  it("P2: a plain rugpull target_moved is NOT park evidence; a park-detailed refusal is", async () => {
    const root = ownedTmpDir("park-refusal");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [targetMovedEvent(B_BARE.B1, T_AFTER)]);
      const state = makeState(root);
      const plain = await probe({ stateRoot: root, state, marker: "park-landed" });
      assert.equal(plain.satisfied, false, "a plain rugpull tip-move must not satisfy park-landed");
      assert.equal(plain.outcome, "not_yet");
      assert.equal(plain.productEvidence.parkLanding.length, 0);

      // The documented refusal carries the park detail.
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        targetMovedEvent(B_BARE.B2, T_AFTER, { detail: "refused to clobber the dirty parked target checkout" }),
      ]);
      const refusal = await probe({ stateRoot: root, state, marker: "park-landed" });
      assert.equal(refusal.satisfied, true, refusal.reason ?? refusal.evidence);
      assert.equal(refusal.outcome, "marker_satisfied");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("P3: a not-applicable landing is NOT park evidence; dirty-tree-only is not_yet; absent channel is evidence_error", async () => {
    const root = ownedTmpDir("park-none");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [landedEvent(B_BARE.B4, T_AFTER, { checkoutRefresh: "not-applicable" })]);
      const state = makeState(root);
      const na = await probe({ stateRoot: root, state, marker: "park-landed" });
      assert.equal(na.satisfied, false);
      assert.equal(na.outcome, "not_yet");

      const err = await probe({ stateRoot: path.join(root, "missing"), state, marker: "park-landed" });
      assert.equal(err.satisfied, false);
      assert.equal(err.outcome, "evidence_error");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Report projection.
// ─────────────────────────────────────────────────────────────────────

describe("US-004 report projection carries phase productEvidence", () => {
  it("RP1: productEvidenceForPhase exposes the channel and buildStormReport projects it per phase", () => {
    const root = ownedTmpDir("report");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        targetMovedEvent(B_BARE.B1, T_AFTER),
        landedEvent(B_BARE.B4, T_AFTER, {
          checkoutRefresh: "parked:main-tamandua-parked-20260913T063000Z-deadbe",
          parkedBranch: "main-tamandua-parked-20260913T063000Z-deadbe",
          parkedReason: "local-changes",
        }),
      ]);
      const state = makeState(root);
      const ctx = makeCtx(root);

      const rugPe = productEvidenceForPhase(ctx, state, "B-rugpull");
      assert.equal(rugPe.ok, true, rugPe.error ?? "");
      assert.equal(rugPe.targetMoved.length, 1);
      assert.equal(rugPe.phaseId, "B-rugpull");
      assert.equal(rugPe.sinceUtc, T_PHASE);

      const report = buildStormReport(ctx as any, state);
      assert.deepEqual(PRODUCT_EVIDENCE_PHASE_IDS, ["B-rugpull", "B-park"]);
      const phases = report.rounds.B.phases;
      const rug = phases.find((p: any) => p.id === "B-rugpull");
      const park = phases.find((p: any) => p.id === "B-park");
      assert.equal(rug.productEvidence.ok, true);
      assert.equal(rug.productEvidence.targetMoved.length, 1);
      assert.equal(park.productEvidence.ok, true);
      assert.equal(park.productEvidence.parkLanding.length, 1);
      // The other Round B phases keep an explicit (null) projection.
      assert.equal("productEvidence" in rug, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("RP2: a commit-only B-rugpull records targetMoved [] — never true", () => {
    const root = ownedTmpDir("report-commitonly");
    try {
      writeJsonl(path.join(root, "events", "all.jsonl"), [
        { ts: T_AFTER, event: "run.started", runId: B_BARE.B1 },
      ]);
      const state = makeState(root);
      const ctx = makeCtx(root);
      const report = buildStormReport(ctx as any, state);
      const rug = report.rounds.B.phases.find((p: any) => p.id === "B-rugpull");
      assert.equal(rug.productEvidence.ok, true);
      assert.deepEqual(rug.productEvidence.targetMoved, [], "a local commit alone never sets targetMoved");
      assert.notEqual(rug.productEvidence.targetMoved.length > 0, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

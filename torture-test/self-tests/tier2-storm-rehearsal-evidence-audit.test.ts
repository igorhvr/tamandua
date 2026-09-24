// Tier-2 STORM-REHEARSAL FIX8 US-006 (requirement 3) — mechanical audit of
// every `probePhaseMarkerReal` phase predicate.
//
// Attempt 8's consistency gate went red on exactly two issues, both symptoms
// of the same two failure classes:
//
//   (SF-15) id-shape assumptions — the product (`src/installer/events.ts`)
//     writes every event with a BARE-uuid `runId` into `events/<bare>.jsonl`
//     (+ all.jsonl) while the engine/state/report renders the same run as
//     `run-<uuid>`. A predicate that compares the raw prefixed state id to the
//     raw event id silently reads 0 (attempt-8: prefixed -> landed 0 /
//     parkLanding 0; bare -> 4 / 4).
//   (fixture-only-green) fixtures built from the engine's OWN state shape —
//     the synthetic fixture used matching ids on BOTH sides, so the mismatch
//     above was invisible across the whole 45-file chain.
//
// This file is the audit net. It:
//
//   * parses the `case '<marker>':` labels straight out of
//     `torture-test/bin/tt-storm-real.mjs` (so a NEW marker cannot be added
//     without an audit row) and asserts `EVIDENCE_PREDICATE_AUDIT` covers
//     every handler exactly once with an evidence class + fixture source;
//   * for BOTH product-evidence predicates (`rugpull-observed`,
//     `park-landed`) builds a REAL-PRODUCT-SHAPED events dir (bare event
//     `runId`, `<bare>.jsonl` + all.jsonl) and asserts the predicate is
//     satisfied while the state supplies PREFIXED `run-<uuid>` ids — the
//     exact attempt-8 shape. The audit row must declare
//     `idShapeAssumption === 'canonical'`;
//   * for every NON-product predicate (DB/refs) asserts the verdict is
//     byte-identical with and without an event channel that fully satisfies
//     both product predicates, and that the result carries no
//     `productEvidence` — proving no DB/refs predicate can go green from the
//     product-event channel alone (no fixture-only-green path), and that each
//     is pinned by mechanical DB/refs rows.
//
// Hermetic: `fs.mkdtempSync(os.tmpdir())` only; a fake DB-open seam and an
// absent refs seam. No daemon, no ports, no harness, no git repo, no model.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { newCampaignState } from "../bin/tt-storm-shared.mjs";
import {
  EVIDENCE_PREDICATE_AUDIT,
  probePhaseMarkerReal,
  summarizeEvidencePredicateAudit,
} from "../bin/tt-storm-real.mjs";

// ─────────────────────────────────────────────────────────────────────
// Fixtures: state ids PREFIXED, event ids BARE (the real product asymmetry).
// ─────────────────────────────────────────────────────────────────────

const T_PHASE = "2026-09-13T06:00:00.000Z";
const T_AFTER = "2026-09-13T06:30:00.000Z";

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

const PRODUCT_MARKERS = ["rugpull-observed", "park-landed"] as const;
const EXPECTED_CLASS: Record<string, "db" | "refs" | "product-events"> = {
  "cc1-landed": "refs",
  "rugpull-observed": "product-events",
  "park-landed": "product-events",
};

function ownedTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-evidence-audit-${label}-`));
}

function writeJsonl(file: string, lines: Array<Record<string, unknown>>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

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

function parkedLandedEvent(runId: string, ts: string) {
  // The real product park contract (SF-15/US-005): a NON-NOOP landing that
  // parked the dirty target checkout — `checkoutRefresh: "parked:<backup>"`
  // plus explicit parkedBranch/parkedReason. 'already-coherent'/'refreshed'
  // are NOT park evidence.
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
    checkoutRefresh: "parked:main-tamandua-parked-20260913T063000Z-deadbe",
    parkedBranch: "main-tamandua-parked-20260913T063000Z-deadbe",
    parkedReason: "local-changes",
  };
}

function makeState(stateRoot: string, opts: { bareStateIds?: boolean } = {}) {
  const clock = { nowUtc: () => T_PHASE };
  const state: any = newCampaignState({
    campaignId: "camp-us006-evidence-audit",
    clock,
    source: { repo: "/repo", branch: "test", commit: "0".repeat(40), tree: "0".repeat(40) },
    fixture: { name: "tt-poly", basis: "US-006 evidence-audit self-test" },
  });
  state.exec_identity = { state_root: stateRoot };
  state.plan = { launches: [], fixtureIdentity: { cc2File: "client-store.ts" } };
  const ids = opts.bareStateIds ? B_BARE : B_RUNS;
  state.rounds.B.runs = Object.fromEntries(
    Object.entries(ids).map(([rid, runId]) => [rid, { rosterId: rid, runId, status: "registered" }]),
  );
  state.rounds.B.phases = {
    "B-rugpull": { id: "B-rugpull", status: "fired", firedAt: T_PHASE, ops: [] },
    "B-park": { id: "B-park", status: "fired", firedAt: T_PHASE, ops: [] },
  };
  return state;
}

// An empty DB seam: every mechanical evidence lookup comes back empty so a
// non-product predicate can only be satisfied by its own DB/refs rows — never
// by the product-event channel. The product-event markers never call these.
function emptyDbOpen() {
  return () => ({
    ok: true,
    api: {
      getRun: () => undefined,
      listRuns: () => [],
      activeStepRows: () => [],
      close: () => {},
    },
  });
}

function probeMarker(opts: {
  marker: string;
  stateRoot: string;
  state: any;
  dbOpen?: any;
  refs?: any;
}) {
  return probePhaseMarkerReal({
    dbOpen: opts.dbOpen ?? (emptyDbOpen() as any),
    dbPath: "/nonexistent/campaign.db",
    state: opts.state,
    ph: { waitFor: { kind: "phase", marker: opts.marker } },
    refs: opts.refs ?? null,
    stateRoot: opts.stateRoot,
  } as any);
}

// Write a real-product-shaped events dir that FULLY satisfies both
// product-evidence predicates: a bare-`runId` merge.target_moved in
// `<bare>.jsonl` + all.jsonl, and a bare-`runId` parking merge.landed.
function writeProductChannel(root: string) {
  const moved = targetMovedEvent(B_BARE.B1, T_AFTER);
  const landed = parkedLandedEvent(B_BARE.B4, T_AFTER);
  writeJsonl(path.join(root, "events", `${B_BARE.B1}.jsonl`), [moved]);
  writeJsonl(path.join(root, "events", `${B_BARE.B4}.jsonl`), [landed]);
  writeJsonl(path.join(root, "events", "all.jsonl"), [moved, landed]);
}

// ─────────────────────────────────────────────────────────────────────
// Mechanical marker extraction: read the switch cases out of the module.
// ─────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SRC_PATH = path.resolve(HERE, "..", "bin", "tt-storm-real.mjs");

function sourceOfProbePhaseMarkerReal(): string {
  const src = fs.readFileSync(REAL_SRC_PATH, "utf8");
  const start = src.indexOf("export async function probePhaseMarkerReal");
  assert.ok(start >= 0, "probePhaseMarkerReal must exist in tt-storm-real.mjs");
  const end = src.indexOf("\nexport ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

function handledMarkersFromSource(): string[] {
  return [...sourceOfProbePhaseMarkerReal().matchAll(/case '([^']+)'/g)].map((m) => m[1]);
}

// ─────────────────────────────────────────────────────────────────────
// A1/A2 — coverage.
// ─────────────────────────────────────────────────────────────────────

describe("US-006 (Req 3) EVIDENCE_PREDICATE_AUDIT coverage", () => {
  it("A1: covers every probePhaseMarkerReal case exactly once, each with class + fixture + id shape", () => {
    const handled = handledMarkersFromSource();
    assert.ok(handled.length > 0, "the mechanical parse found the switch cases");
    assert.equal(new Set(handled).size, handled.length, "marker case labels are unique in the source");

    const auditMarkers = EVIDENCE_PREDICATE_AUDIT.map((e: any) => e.marker);
    assert.equal(new Set(auditMarkers).size, auditMarkers.length, "no duplicate audit rows");
    assert.deepEqual(
      [...auditMarkers].sort(),
      [...new Set(handled)].sort(),
      "every handled marker must have exactly one audit row (and no extras)",
    );

    for (const entry of EVIDENCE_PREDICATE_AUDIT as any[]) {
      assert.ok(["db", "refs", "product-events"].includes(entry.evidenceClass), `${entry.marker}: valid class`);
      assert.equal(typeof entry.fixtureSource, "string", `${entry.marker}: fixtureSource is a string`);
      assert.ok(entry.fixtureSource.trim().length > 0, `${entry.marker}: fixtureSource is non-empty`);
      assert.equal(entry.idShapeAssumption, "canonical", `${entry.marker}: only a canonical id shape is allowed`);
      // US-008 (fix-9 requirement 3): EVERY audited predicate carries an
      // explicit no-op guard naming the real transition it requires and the
      // no-op/fabricated shape it rejects.
      assert.ok(entry.noopGuard && typeof entry.noopGuard === "object", `${entry.marker}: has a noopGuard`);
      assert.ok(Object.isFrozen(entry.noopGuard), `${entry.marker}: noopGuard is frozen`);
      assert.equal(typeof entry.noopGuard.realTransition, "string", `${entry.marker}: realTransition is a string`);
      assert.ok(entry.noopGuard.realTransition.trim().length > 0, `${entry.marker}: realTransition is non-empty`);
      assert.equal(typeof entry.noopGuard.noopRejected, "string", `${entry.marker}: noopRejected is a string`);
      assert.ok(entry.noopGuard.noopRejected.trim().length > 0, `${entry.marker}: noopRejected is non-empty`);
    }
  });

  it("A2: the audit is frozen/stable and the three fixed classes are correctly attributed", () => {
    assert.ok(Object.isFrozen(EVIDENCE_PREDICATE_AUDIT), "the audit table is frozen");
    for (const [marker, cls] of Object.entries(EXPECTED_CLASS)) {
      const entry = (EVIDENCE_PREDICATE_AUDIT as any[]).find((e) => e.marker === marker);
      assert.ok(entry, `${marker} has an audit row`);
      assert.equal(entry.evidenceClass, cls, `${marker} evidenceClass`);
    }
    // Product-event rows must name the real product shape in their fixture source.
    for (const marker of PRODUCT_MARKERS) {
      const entry = (EVIDENCE_PREDICATE_AUDIT as any[]).find((e) => e.marker === marker);
      assert.match(entry.fixtureSource, /bare/i, `${marker}: fixture names the bare event runId`);
      assert.match(entry.fixtureSource, /all\.jsonl/, `${marker}: fixture names all.jsonl`);
      assert.match(entry.fixtureSource, /\.jsonl/, `${marker}: fixture names the run-scoped file`);
    }
    // DB/refs rows must name mechanical evidence, never a product fixture.
    for (const entry of (EVIDENCE_PREDICATE_AUDIT as any[]).filter((e) => e.evidenceClass !== "product-events")) {
      assert.match(entry.fixtureSource, /mechanical/i, `${entry.marker}: fixture is mechanical evidence`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// A3 — the summary exposes the audit for the fix8 readiness (US-009).
// ─────────────────────────────────────────────────────────────────────

describe("US-006 (Req 3) audit summary projection", () => {
  it("A3: summarizeEvidencePredicateAudit is JSON-serializable and recomputes cleanly", () => {
    const summary = summarizeEvidencePredicateAudit();
    assert.equal(summary.ok, true);
    assert.equal(summary.markerCount, EVIDENCE_PREDICATE_AUDIT.length);
    assert.deepEqual(summary.markers, EVIDENCE_PREDICATE_AUDIT.map((e: any) => e.marker));
    assert.deepEqual([...summary.productEvidenceMarkers].sort(), [...PRODUCT_MARKERS].sort());
    assert.equal(summary.evidenceClasses["product-events"], 2);
    assert.deepEqual(summary.duplicates, []);
    assert.deepEqual(summary.entries, EVIDENCE_PREDICATE_AUDIT.map((e: any) => ({ ...e })));
    // JSON round-trips (the readiness writer must be able to record it).
    assert.deepEqual(JSON.parse(JSON.stringify(summary)).markerCount, summary.markerCount);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P* — product-evidence predicates on a REAL-product-shaped fixture.
// ─────────────────────────────────────────────────────────────────────

describe("US-006 (Req 3) product-evidence predicates — canonical on real product output", () => {
  it("P1: rugpull-observed is satisfied from bare events while the state supplies PREFIXED ids", async () => {
    const root = ownedTmpDir("rug");
    try {
      const moved = targetMovedEvent(B_BARE.B1, T_AFTER);
      writeJsonl(path.join(root, "events", `${B_BARE.B1}.jsonl`), [moved]);
      writeJsonl(path.join(root, "events", "all.jsonl"), [moved]);
      const state = makeState(root); // state run ids are `run-<uuid>`
      const v: any = await probeMarker({ marker: "rugpull-observed", stateRoot: root, state });
      assert.equal(v.satisfied, true, v.reason ?? v.evidence);
      assert.equal(v.outcome, "marker_satisfied");
      assert.equal(v.productEvidence.targetMoved.length, 1, "the bare product event is read despite prefixed state ids");
      assert.equal(v.productEvidence.targetMoved[0].runId, B_BARE.B1, "the event stays byte-faithful");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("P2: park-landed is satisfied from bare events while the state supplies PREFIXED ids", async () => {
    const root = ownedTmpDir("park");
    try {
      const landed = parkedLandedEvent(B_BARE.B4, T_AFTER);
      writeJsonl(path.join(root, "events", `${B_BARE.B4}.jsonl`), [landed]);
      writeJsonl(path.join(root, "events", "all.jsonl"), [landed]);
      const state = makeState(root);
      const v: any = await probeMarker({ marker: "park-landed", stateRoot: root, state });
      assert.equal(v.satisfied, true, v.reason ?? v.evidence);
      assert.equal(v.outcome, "marker_satisfied");
      assert.equal(v.productEvidence.parkLanding.length, 1);
      assert.equal(v.productEvidence.parkLanding[0].runId, B_BARE.B4);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("P3: prefixed and bare state ids produce byte-identical product evidence (id-shape invariance)", async () => {
    const root = ownedTmpDir("invariance");
    try {
      writeProductChannel(root);
      const prefixed = await probeMarker({ marker: "rugpull-observed", stateRoot: root, state: makeState(root) });
      const bare = await probeMarker({
        marker: "rugpull-observed",
        stateRoot: root,
        state: makeState(root, { bareStateIds: true }),
      });
      assert.equal((prefixed as any).satisfied, true);
      assert.equal((bare as any).satisfied, true);
      // The prefixed-state call must see the same events as a bare-state call:
      // the reader canonicalizes at its boundary.
      assert.deepEqual(
        (prefixed as any).productEvidence.targetMoved,
        (bare as any).productEvidence.targetMoved,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("P4: every product-evidence audit row is 'canonical' (no raw prefixed-vs-event comparison)", () => {
    const productRows = (EVIDENCE_PREDICATE_AUDIT as any[]).filter((e) => e.evidenceClass === "product-events");
    assert.deepEqual([...productRows.map((e) => e.marker)].sort(), [...PRODUCT_MARKERS].sort());
    for (const entry of productRows) {
      assert.equal(entry.idShapeAssumption, "canonical", `${entry.marker} must canonicalize ids`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// N* — non-product predicates never read the product event channel.
// ─────────────────────────────────────────────────────────────────────

describe("US-006 (Req 3) non-product predicates — no fixture-only-green path", () => {
  it("N1: every db/refs predicate is unaffected by a channel that satisfies both product predicates", async () => {
    const richRoot = ownedTmpDir("rich-channel");
    const emptyRoot = path.join(os.tmpdir(), `tt-evidence-audit-empty-${process.pid}-${Date.now()}`);
    try {
      // A channel that WOULD satisfy rugpull-observed and park-landed.
      writeProductChannel(richRoot);
      // Sanity: the rich channel really does satisfy both product predicates.
      assert.equal((await probeMarker({ marker: "rugpull-observed", stateRoot: richRoot, state: makeState(richRoot) }) as any).satisfied, true);
      assert.equal((await probeMarker({ marker: "park-landed", stateRoot: richRoot, state: makeState(richRoot) }) as any).satisfied, true);

      const nonProduct = (EVIDENCE_PREDICATE_AUDIT as any[]).filter((e) => e.evidenceClass !== "product-events");
      assert.ok(nonProduct.length >= 8, "the DB/refs predicates are exercised");

      for (const entry of nonProduct) {
        const withChannel: any = await probeMarker({ marker: entry.marker, stateRoot: richRoot, state: makeState(richRoot) });
        const withoutChannel: any = await probeMarker({ marker: entry.marker, stateRoot: emptyRoot, state: makeState(emptyRoot) });

        assert.equal(withChannel.satisfied, false, `${entry.marker} must not be satisfied by product events alone`);
        assert.equal(withoutChannel.satisfied, false, `${entry.marker} must not be satisfied by product events alone`);
        assert.equal(
          `${withChannel.satisfied}:${withChannel.outcome}`,
          `${withoutChannel.satisfied}:${withoutChannel.outcome}`,
          `${entry.marker}'s verdict must be identical with and without the product-event channel`,
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(withChannel, "productEvidence"),
          false,
          `${entry.marker} must not surface productEvidence`,
        );
      }
    } finally {
      fs.rmSync(richRoot, { recursive: true, force: true });
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

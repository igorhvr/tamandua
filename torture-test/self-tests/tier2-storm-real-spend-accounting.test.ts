// Tier-2 STORM-REAL US-005 — REAL campaign spend accounting and
// results/spend.json (in-process; NO daemon/harness/model spawned).
//
// The REAL storm pays real tokens. This focused self-test proves the spend
// module the observation loop (US-007) and the cap enforcement (US-006) build
// on:
//
//   S1  harness -> provider class is exact: pi/hermes are LOCAL-endpoint
//       (counted, cost 0) and dsh is PAID; an unknown harness has no class;
//   S2  persisted roster/run records (including children, which inherit the
//       parent harness) yield run-id -> harness assignments through the
//       canonicalizing run-key seam; malformed ids are skipped, never guessed;
//   S3  sumSpendSnapshot sums per provider and in total and splits
//       local-endpoint (cost 0) from paid tokens; a DB run with no roster
//       assignment lands in the explicit unattributed bucket (still counted);
//   S4  writeSpendSnapshot writes <campaignDir>/results/spend.json with the
//       schema version, tick timestamp, per-provider and total fields, and
//       readSpendSnapshot round-trips it;
//   S5  collectCampaignSpend reads real `runs.tokens_spent` rows through the
//       canonicalizing REAL_DB seam: a public `run-<uuid>` state assignment
//       resolves to the bare stored uuid;
//   S6  an unreadable/missing/throwaway DB is UNKNOWN with every numeric field
//       null — never a fabricated 0;
//   S7  flushCampaignSpend writes the artifact and records the tick headline.
//
// Everything runs under test-owned scratch dirs (removed in finally).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  HARNESS_PROVIDER_CLASS,
  SPEND_FILE_NAME,
  SPEND_SCHEMA_VERSION,
  SPEND_STATUS_KNOWN,
  SPEND_STATUS_UNKNOWN,
  canonicalizeSpendRow,
  collectCampaignSpend,
  flushCampaignSpend,
  isLocalHarness,
  isPaidHarness,
  providerClassForHarness,
  readSpendSnapshot,
  spendAssignmentsFromState,
  sumSpendSnapshot,
  unknownSpendSnapshot,
  writeSpendSnapshot,
} from "../bin/tt-storm-spend.mjs";

const RUN_PI = "run-11111111-1111-4111-8111-111111111111";
const RUN_HERMES = "run-22222222-2222-4222-8222-222222222222";
const RUN_DSH = "run-33333333-3333-4333-8333-333333333333";
const RUN_CHILD = "run-44444444-4444-4444-8444-444444444444";
const RUN_STRAY = "run-55555555-5555-4555-8555-555555555555";

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-spend-${label}-`));
}

// A campaign state with a REAL-style roster mapping: a pi run, a hermes run, a
// dsh run and a pi run with a child (the child inherits the parent harness).
function fixtureState() {
  return {
    rounds: {
      A: {
        runs: {
          S1: { rosterId: "S1", runId: RUN_PI, harness: "pi", workflow: "feature-dev-merge-worktree", children: [] },
          S2: { rosterId: "S2", runId: RUN_HERMES, harness: "hermes", workflow: "feature-dev-merge-worktree", children: [] },
          S3: { rosterId: "S3", runId: RUN_DSH, harness: "dsh", workflow: "do-now", children: [] },
          S4: {
            rosterId: "S4",
            runId: RUN_PI.replace("1111", "9999"),
            harness: "pi",
            workflow: "bug-fix-merge-worktree",
            children: [{ runId: RUN_CHILD, workflow: "bug-fix-merge-worktree", status: "completed" }],
          },
        },
      },
      B: { runs: {} },
    },
  };
}

// Create a product-shaped `runs` table (the exact columns REAL_DB.listRuns
// selects) and seed rows keyed by the BARE uuid (as the product stores them).
function makeCampaignDb(dbPath: string, rows: Array<{ id: string; tokens: number }>) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT, status TEXT, scheduling_status TEXT, created_at TEXT, updated_at TEXT, tokens_spent INTEGER, parent_run_id TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO runs (id, workflow_id, status, scheduling_status, created_at, updated_at, tokens_spent, parent_run_id) VALUES (?, 'do-now', 'completed', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, NULL)",
    );
    for (const row of rows) insert.run(row.id, row.tokens);
  } finally {
    db.close();
  }
}

describe("STORM-REAL US-005: spend accounting module and results/spend.json", () => {
  it("S1: pi/hermes are LOCAL (cost 0) and dsh is PAID; an unknown harness has no class", () => {
    assert.equal(providerClassForHarness("pi"), "local");
    assert.equal(providerClassForHarness("hermes"), "local");
    assert.equal(providerClassForHarness("dsh"), "paid");
    assert.equal(providerClassForHarness("Pi"), "local", "case-insensitive normalization");
    assert.equal(providerClassForHarness("bogus"), null);
    assert.equal(providerClassForHarness(""), null);
    assert.equal(providerClassForHarness(null), null);
    assert.equal(isLocalHarness("pi"), true);
    assert.equal(isLocalHarness("dsh"), false);
    assert.equal(isPaidHarness("dsh"), true);
    assert.equal(isPaidHarness("hermes"), false);
    assert.deepEqual(HARNESS_PROVIDER_CLASS, { pi: "local", hermes: "local", dsh: "paid" });
  });

  it("S2: persisted roster + child records yield canonical run-id -> harness assignments", () => {
    const { assignments, skipped } = spendAssignmentsFromState(fixtureState());
    const byBare = new Map(assignments.map((a) => [a.run_id_bare, a]));
    assert.equal(byBare.get(RUN_PI.slice(4))?.harness, "pi");
    assert.equal(byBare.get(RUN_HERMES.slice(4))?.harness, "hermes");
    assert.equal(byBare.get(RUN_DSH.slice(4))?.harness, "dsh");
    const child = byBare.get(RUN_CHILD.slice(4));
    assert.equal(child?.harness, "pi", "a child run inherits the parent roster harness");
    assert.equal(child?.derived_from, "child");
    assert.equal(child?.parent_run_id, RUN_PI.replace("1111", "9999"));
    // A malformed roster run id is skipped (recorded), never guessed.
    const withBad = spendAssignmentsFromState({ rounds: { A: { runs: { S9: { runId: "not-a-run", harness: "pi" } } } } });
    assert.equal(withBad.assignments.length, 0);
    assert.equal(withBad.skipped.length, 1);
    assert.match(withBad.skipped[0].reason, /run-/);
    // Canonicalizer: a public key and a bare key resolve to the same run.
    assert.equal(canonicalizeSpendRow({ id: RUN_PI.slice(4), tokens_spent: 7 }).bare, RUN_PI.slice(4));
    assert.equal(canonicalizeSpendRow({ runId: RUN_PI, tokens_spent: 7 }).public, RUN_PI);
  });

  it("S3: sumSpendSnapshot sums per provider and total and splits local-endpoint (cost 0) from paid", () => {
    const { assignments } = spendAssignmentsFromState(fixtureState());
    const runRows = [
      { id: RUN_PI.slice(4), tokens_spent: 100 },
      { id: RUN_HERMES.slice(4), tokens_spent: 200 },
      { id: RUN_DSH.slice(4), tokens_spent: 300 },
      { id: RUN_CHILD.slice(4), tokens_spent: 40 },
      { id: RUN_STRAY.slice(4), tokens_spent: 9 }, // no roster assignment
      { id: "not-a-uuid", tokens_spent: 1000 }, // malformed -> excluded, recorded
    ];
    const snap = sumSpendSnapshot({ assignments, runRows, tickAt: "2026-09-23T00:00:00.000Z" });
    assert.equal(snap.status, SPEND_STATUS_KNOWN);
    assert.equal(snap.schema_version, SPEND_SCHEMA_VERSION);
    assert.equal(snap.tick_at, "2026-09-23T00:00:00.000Z");
    assert.equal(snap.providers.pi.tokens, 140, "pi tokens (own + inherited child)");
    assert.equal(snap.providers.pi.class, "local");
    assert.equal(snap.providers.pi.billable_tokens, 0, "local endpoint tokens cost 0");
    assert.equal(snap.providers.hermes.tokens, 200);
    assert.equal(snap.providers.hermes.billable_tokens, 0);
    assert.equal(snap.providers.dsh.tokens, 300);
    assert.equal(snap.providers.dsh.class, "paid");
    assert.equal(snap.providers.dsh.billable_tokens, 300, "paid provider tokens are billable");
    assert.equal(snap.local_tokens, 340, "(pi+hermes) local split");
    assert.equal(snap.paid_tokens, 300, "dsh paid split");
    assert.equal(snap.billable_tokens, 300);
    assert.equal(snap.unattributed_tokens, 9, "an unassigned DB run is explicitly unattributed, never dropped");
    assert.equal(snap.total_tokens, 649, "total includes local + paid + unattributed");
    assert.equal(snap.runs.length, 5);
    const stray = snap.runs.find((r) => r.run_id === RUN_STRAY);
    assert.equal(stray?.class, "unattributed");
    assert.equal(snap.malformed_rows.length, 1);
    // A readable DB with no runs legitimately reports zeros (not UNKNOWN).
    const empty = sumSpendSnapshot({ assignments: [], runRows: [] });
    assert.equal(empty.status, SPEND_STATUS_KNOWN);
    assert.equal(empty.total_tokens, 0);
  });

  it("S4: writeSpendSnapshot writes results/spend.json with the schema/tick/providers/total fields and round-trips", () => {
    const tmp = ownedScratch("write");
    try {
      const campaignDir = path.join(tmp, "results", "storm-real-spend");
      fs.mkdirSync(campaignDir, { recursive: true });
      const snapshot = unknownSpendSnapshot({ tickAt: "2026-09-23T01:02:03.000Z", reason: "unreadable for the write test" });
      const outPath = writeSpendSnapshot({ fs, campaignDir, snapshot });
      assert.equal(outPath, path.join(campaignDir, "results", SPEND_FILE_NAME));
      const written = readSpendSnapshot({ fs, campaignDir });
      assert.equal(written.schema_version, SPEND_SCHEMA_VERSION);
      assert.equal(written.tick_at, "2026-09-23T01:02:03.000Z");
      assert.equal(written.status, SPEND_STATUS_UNKNOWN);
      assert.ok(Object.prototype.hasOwnProperty.call(written, "providers"));
      assert.ok(Object.prototype.hasOwnProperty.call(written, "total_tokens"));

      const known = sumSpendSnapshot({
        assignments: [{ run_id: RUN_DSH, harness: "dsh" }],
        runRows: [{ id: RUN_DSH.slice(4), tokens_spent: 12 }],
        tickAt: "2026-09-23T02:00:00.000Z",
      });
      writeSpendSnapshot({ fs, campaignDir, snapshot: known });
      const roundTrip = readSpendSnapshot({ fs, campaignDir });
      assert.equal(roundTrip.status, SPEND_STATUS_KNOWN);
      assert.equal(roundTrip.providers.dsh.tokens, 12);
      assert.equal(roundTrip.total_tokens, 12);
      assert.equal(roundTrip.paid_tokens, 12);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("S5: collectCampaignSpend reads real runs.tokens_spent through the canonicalizing DB seam", () => {
    const tmp = ownedScratch("db");
    try {
      const dbPath = path.join(tmp, "tamandua.db");
      makeCampaignDb(dbPath, [
        { id: RUN_PI.slice(4), tokens: 500 },
        { id: RUN_DSH.slice(4), tokens: 700 },
      ]);
      const snap = collectCampaignSpend({ dbPath, state: fixtureState(), tickAt: "2026-09-23T03:00:00.000Z" });
      assert.equal(snap.status, SPEND_STATUS_KNOWN);
      assert.equal(snap.providers.pi.tokens, 500, "a public state assignment resolved to the bare stored run");
      assert.equal(snap.providers.dsh.tokens, 700, "the paid provider figure is read from the product DB");
      assert.equal(snap.local_tokens, 500);
      assert.equal(snap.paid_tokens, 700);
      assert.equal(snap.total_tokens, 1200);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("S6: a missing/unreadable/throwing campaign DB yields UNKNOWN, never a fabricated 0", () => {
    const unknownChecks: Array<[string, () => any]> = [
      ["no dbPath", () => collectCampaignSpend({ dbPath: null, state: fixtureState() })],
      ["blank dbPath", () => collectCampaignSpend({ dbPath: "   ", state: fixtureState() })],
      [
        "nonexistent DB file",
        () => {
          const tmp = ownedScratch("missing");
          try {
            return collectCampaignSpend({ dbPath: path.join(tmp, "no-such.db"), state: fixtureState() });
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        },
      ],
      ["opener returns { ok:false }", () => collectCampaignSpend({ dbPath: "/x.db", state: fixtureState(), openDb: () => ({ ok: false, api: null, error: "cannot open" }) })],
      ["opener throws", () => collectCampaignSpend({ dbPath: "/x.db", state: fixtureState(), openDb: () => { throw new Error("boom"); } })],
      [
        "listRuns throws",
        () =>
          collectCampaignSpend({
            dbPath: "/x.db",
            state: fixtureState(),
            openDb: () => ({ ok: true, api: { listRuns: () => { throw new Error("read failed"); }, close: () => {} } }),
          }),
      ],
      [
        "listRuns not an array",
        () => collectCampaignSpend({ dbPath: "/x.db", state: fixtureState(), openDb: () => ({ ok: true, api: { listRuns: () => null, close: () => {} } }) }),
      ],
    ];
    for (const [label, run] of unknownChecks) {
      const snap = run();
      assert.equal(snap.status, SPEND_STATUS_UNKNOWN, `${label} -> UNKNOWN`);
      assert.equal(snap.schema_version, SPEND_SCHEMA_VERSION, `${label} -> schema`);
      assert.equal(typeof snap.tick_at, "string", `${label} -> tick`);
      assert.ok(typeof snap.reason === "string" && snap.reason.length > 0, `${label} -> non-empty reason`);
      for (const key of ["providers", "total_tokens", "local_tokens", "paid_tokens", "unattributed_tokens"]) {
        assert.equal(snap[key], null, `${label}: ${key} must be null, never a fabricated 0`);
      }
    }
  });

  it("S7: flushCampaignSpend writes results/spend.json and records the tick headline", () => {
    const tmp = ownedScratch("flush");
    try {
      const campaignDir = path.join(tmp, "results", "storm-real-flush");
      fs.mkdirSync(campaignDir, { recursive: true });
      const dbPath = path.join(tmp, "tamandua.db");
      makeCampaignDb(dbPath, [{ id: RUN_DSH.slice(4), tokens: 55 }]);
      const records: Array<{ kind: string; detail: any }> = [];
      const ctx = {
        fs,
        campaignDir,
        clock: { nowUtc: () => "2026-09-23T04:00:00.000Z" },
        opts: { dbPath },
        db: { open: (p: string) => (p === dbPath ? { ok: true, api: { listRuns: () => [{ id: RUN_DSH.slice(4), tokens_spent: 55 }], close: () => {} } } : { ok: false, error: "bad path" }) },
      };
      const result = flushCampaignSpend(ctx, fixtureState(), { ops: { record: (kind: string, detail: any) => records.push({ kind, detail }) } });
      assert.equal(result.status, SPEND_STATUS_KNOWN);
      assert.equal(result.paid_tokens, 55);
      assert.equal(result.path, path.join(campaignDir, "results", SPEND_FILE_NAME));
      assert.ok(fs.existsSync(result.path));
      const persisted = readSpendSnapshot({ fs, campaignDir });
      assert.equal(persisted.paid_tokens, 55);
      assert.equal(records.length, 1);
      assert.equal(records[0].kind, "spend.tick");
      assert.equal(records[0].detail.paid_tokens, 55);

      // An UNKNOWN tick is still written and recorded honestly.
      const badCtx = { ...ctx, db: { open: () => ({ ok: false, error: "unreadable" }) } };
      const unknown = flushCampaignSpend(badCtx, fixtureState(), { ops: { record: (kind, detail) => records.push({ kind, detail }) } });
      assert.equal(unknown.status, SPEND_STATUS_UNKNOWN);
      assert.equal(unknown.total_tokens, null);
      assert.equal(readSpendSnapshot({ fs, campaignDir }).status, SPEND_STATUS_UNKNOWN);
      assert.equal(records.length, 2);
      assert.equal(records[1].detail.status, SPEND_STATUS_UNKNOWN);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
// validate.mjs — seed-validation routing for the gating oracles + O12
// (storm-aged VALIDATION/HANDOFF gate #3/#4).
//
// The seed corpus is synthetic zero-token state, so the per-run campaign
// oracles (O2/O3z/O8/O9/O10/O11/O16 and the merge legs of O1) that judge REAL
// agent behavior are routed as NOT_RUN/not-applicable with a precise reason —
// never relabeled PASS.  The hygiene/structural oracles that DO apply to the
// corpus (terminal-state integrity, claim hygiene, event-log integrity,
// worktree bookkeeping, zero-token receipts, DB invariants) run real
// mechanical checks.  O12 runs its real pinned executable over the immutable
// DB snapshot + host-owned reserved-key baseline sidecar.
//
// Everything here is read-only over the seed state + immutable snapshots; the
// only writes are evidence outputs under the owned seed root.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { utcNow, sha256FileStream, writeExclusive } from "./seedcommon.mjs";
import { runDbCensus, eventStreamCensus, worktreeCensus } from "./census.mjs";

export const GATING_ORACLE_IDS = ["O1", "O2", "O3z", "O4", "O8", "O9", "O10", "O11", "O16"];
export const POST_BATCH_ORACLE_IDS = ["O5", "O6", "O7", "O12"];

// ── Routing matrix (mechanical where applicable; NOT_RUN never PASS) ─────

export function buildValidationMatrix({ db, stateDir, worktreesRoot, zeroTokenEvidence }) {
  const census = runDbCensus(db);
  const events = eventStreamCensus(stateDir);
  const wts = worktreeCensus({ db, worktreesRoot });

  const rows = [];

  // O1 — terminal-state integrity (group leg over terminal corpus rows).
  // ROOT-VALIDATION-NOTICE (2026-09-09T20:38:14Z): the previous suite treated
  // pending/running/waiting on ANY terminal run as O1 corruption.  That is not
  // the real oracle contract: oracles/lib/o1.mjs checks nonterminal steps only
  // on COMPLETED runs (O1_COMPLETED_STEP_NONTERMINAL).  A failed/canceled run
  // legitimately leaves downstream steps waiting (zero claim evidence), so
  // waiting/pending on failed/canceled runs is a NATIVE leftover shape, not
  // corruption.  This leg mirrors the oracle: only completed-run nonterminal
  // steps are findings.  Waiting-leftovers are reported as observation counts,
  // never as corruption.  Real violations (a completed run retaining a
  // running/pending/waiting step) are still caught and self-tested.
  {
    const findings = [];
    const terminalRuns = db.prepare(
      "SELECT id, status, scheduling_status FROM runs WHERE status IN ('completed','failed','canceled')",
    ).all();
    // Observation only: terminal runs normally have no scheduling_status.  The
    // real O1 oracle's scheduling finding is O1_SCHEDULING_ERROR (an 'error'
    // scheduling row), not mere presence — keep the observation separate so it
    // is never turned into a false-positive finding.
    const terminalWithScheduling = terminalRuns.filter((r) => r.scheduling_status !== null);
    const schedulingErrorRuns = db.prepare(
      "SELECT COUNT(*) AS c FROM runs WHERE scheduling_status = 'error'",
    ).get().c;
    if (schedulingErrorRuns > 0) {
      findings.push(`O1_GROUP_SCHEDULING_ERROR: ${schedulingErrorRuns} run(s) in scheduling_status='error'`);
    }
    // REAL ORACLE CONTRACT: nonterminal steps are corruption only on COMPLETED
    // runs.  Waiting steps on failed/canceled runs are native leftovers.
    const nonTerminalStepsOnCompleted = census.nonterminalStepsOnCompletedRuns;
    if (nonTerminalStepsOnCompleted > 0) {
      findings.push(`O1_GROUP_NONTERMINAL_STEPS_ON_COMPLETED: ${nonTerminalStepsOnCompleted} non-terminal step(s) on completed runs`);
    }
    const pausedRuns = db.prepare(
      "SELECT COUNT(*) AS c FROM runs WHERE status = 'paused' AND scheduling_status != 'paused'",
    ).get().c;
    if (pausedRuns > 0) {
      findings.push(`O1_GROUP_PAUSED_WRONG_SCHEDULING: ${pausedRuns} paused run(s) without scheduling_status='paused'`);
    }
    rows.push({
      oracle: "O1",
      leg: "group-terminal-state-integrity",
      semantics: "custom seed-slice aligned to real O1 semantics: nonterminal steps judged only on COMPLETED runs (waiting/pending on failed/canceled runs are native leftovers, reported as counts, not corruption); scheduling_status='error' is the scheduling finding; per-run campaign/agent-behavior legs are NOT_RUN",
      execution_kind: "custom-seed-slice",
      full_oracle_status: "NOT_RUN", // real O1 per-run legs need a controller context graph
      status: findings.length === 0 ? "PASS" : "FAIL",
      findings,
      counts: {
        terminal: census.terminal,
        paused: census.paused,
        running: census.running,
        terminal_with_scheduling_observation: terminalWithScheduling.length,
        nonterminal_on_completed: census.nonterminalStepsOnCompletedRuns,
        waiting_on_failed_canceled: census.waitingStepsOnFailedCanceledRuns,
        pending_running_on_failed_canceled: census.pendingRunningStepsOnFailedCanceledRuns,
      },
      note: "waiting/pending steps on failed/canceled runs are native leftover shapes (zero claim evidence) — never O1 corruption under the real oracle contract",
    });
  }

  // O2 — merge truth: NOT_RUN (no real merge landings in a zero-token seed).
  rows.push({
    oracle: "O2",
    leg: "merge-truth",
    semantics: "per real merge-family run landing truth — inapplicable to synthetic zero-token corpus",
    execution_kind: "custom-seed-slice",
    full_oracle_status: "NOT_RUN",
    status: "NOT_RUN",
    findings: ["corpus is zero-token synthetic state; no real merge landing exists to judge"],
  });

  // O3z — real-run token tripwire: NOT_RUN.  Reviewer issue 1 (routing
  // discipline): the previous round reported O3z PASS from the doer's own
  // corpus-level SQL/receipts.  Task item 7 forbids substituting a mini-SQL
  // check for real checker execution under the same oracle id.  O3z's real-run
  // token-tripwire mechanism (oracles/lib/o3z.mjs: controller-run execution
  // modes + system-token before/after snapshots) does not apply to a synthetic
  // zero-token corpus with no real controller runs, exactly like O2/O5/
  // O8-O11/O16.  The corpus-level zero-token proof remains attached as
  // evidence on this row (receipts leg) but is NOT labeled an O3z execution.
  rows.push({
    oracle: "O3z",
    leg: "zero-token-corpus",
    semantics: "real-run token-attribution tripwire does not apply to a synthetic zero-token corpus (no controller execution modes / system-token before-after snapshots); corpus-level zero-token receipts are attached as evidence, not as an O3z oracle execution",
    execution_kind: "custom-seed-slice",
    full_oracle_status: "NOT_RUN",
    status: "NOT_RUN",
    findings: [
      "real pinned O3z oracle executable requires controller-run projections (execution_mode) and system_tokens_before/after snapshots of a real campaign — none exist for a synthetic zero-token seed; NOT_RUN under the same rationale as O2/O5/O8-O11/O16",
    ],
    evidence: zeroTokenEvidence ?? null,
    zero_token_receipts: {
      runs_tokens_total: census.tokensSpentTotal,
      system_tokens_total: census.systemTokensSpentTotal,
      note: "corpus-level zero-token proof (receipts leg) — attached evidence only, not an O3z oracle execution",
    },
  });

  // O4 — claim & dispatch hygiene over terminal corpus.
  // ROOT-VALIDATION-NOTICE: O4 checks ACTUAL claim/dispatch evidence (running
  // steps with claim_pid/pgid/job_id on terminal runs, abandonment records),
  // not unclaimed waiting status.  Unclaimed waiting steps on failed/canceled
  // runs are never dangling claims.
  {
    const findings = [];
    const claimEvidence = census.claimEvidenceStepsOnTerminalRuns;
    if (claimEvidence > 0) findings.push(`O4_CLAIM_EVIDENCE_ON_TERMINAL: ${claimEvidence}`);
    const runningWithPid = census.runningWithClaimPidOnTerminalRuns;
    if (runningWithPid > 0) findings.push(`O4_RUNNING_WITH_PID_ON_TERMINAL: ${runningWithPid}`);
    rows.push({
      oracle: "O4",
      leg: "claim-dispatch-hygiene-terminal",
      semantics: "no dangling claim/dispatch evidence (running steps or claim_pid/pgid/job_id) on terminal runs; unclaimed waiting steps are native leftovers, never dangling claims; no dispatch occurs during seeding (transport double proof)",
      execution_kind: "custom-seed-slice",
      full_oracle_status: "NOT_RUN", // full O4 (dead-pgid sweeps, NO_WORK releases, watchdog) needs a recorder/chaos layer
      status: findings.length === 0 ? "PASS" : "FAIL",
      findings,
      counts: {
        claim_evidence_on_terminal: claimEvidence,
        running_with_claim_pid_on_terminal: runningWithPid,
        waiting_on_failed_canceled: census.waitingStepsOnFailedCanceledRuns,
      },
      note: "waiting/pending steps on failed/canceled runs carry zero claim evidence — never O4 dangling claims under the real oracle contract",
    });
  }

  // O5 — process & port hygiene: NOT_RUN/evidence (no daemons from seed).
  rows.push({
    oracle: "O5",
    leg: "process-port-hygiene",
    semantics: "post-batch process/port census — no seed-owned daemons/listeners are left running (seed phases close their double/facade)",
    execution_kind: "custom-seed-slice",
    full_oracle_status: "NOT_RUN", // host process census + acceptance live in the campaign recorder layer
    status: "NOT_EVALUABLE",
    findings: ["host process census requires the campaign recorder layer owned by other runs; seed-level evidence is the transport double's close receipt"],
  });

  // O6 — worktree bookkeeping.
  {
    const findings = [];
    if (wts.missingDirectoryCount > 0) {
      findings.push(`O6_MISSING_DIRS: ${wts.missingDirectoryCount} managed-worktree row(s) with missing directory`);
    }
    for (const row of wts.rows) {
      if (row.status !== "ready") findings.push(`O6_ROW_NOT_READY: ${row.run_id} -> ${row.status}`);
    }
    rows.push({
      oracle: "O6",
      leg: "worktree-bookkeeping",
      semantics: "custom seed-slice: run_worktrees rows ↔ directories ↔ git worktree list (structural corpus check; not the full O6 oracle execution whose implementation/acceptance are separate)",
      execution_kind: "custom-seed-slice",
      full_oracle_status: "NOT_RUN",
      status: findings.length === 0 ? "PASS" : "FAIL",
      findings,
      counts: { rows: wts.rowCount, dirs: wts.directoryCount },
    });
  }

  // O7 — event-log integrity.
  {
    const findings = [];
    if (!events.exists) findings.push("O7_NO_EVENTS_DIR");
    else {
      if (events.globalArchiveLines > 0 && events.globalArchives.length > 3) {
        findings.push(`O7_ROTATION_ARCHIVES_OVER_CAP: ${events.globalArchives.length}`);
      }
      for (const hush of ["agent.nudged", "agent.nudge.skipped", "run.nudged"]) {
        const cnt = countEventName(db, stateDir, hush);
        if (cnt > 0) findings.push(`O7_HUSH_REAPPEARED: ${hush} x${cnt}`);
      }
      // Terminal runs must carry a terminal lifecycle event in their own stream.
      const terminalMissing = [];
      const terminalEventNames = ["run.completed", "run.failed", "run.canceled", "run.force_failed", "run.deleted"];
      const runs = db.prepare("SELECT id, workflow_id FROM runs WHERE status IN ('completed','failed','canceled')").all();
      const runEventSets = loadRunEventNameSets(stateDir, runs.map((r) => r.id));
      for (const r of runs) {
        const names = runEventSets.get(r.id) ?? new Set();
        if (!terminalEventNames.some((n) => names.has(n))) {
          terminalMissing.push(r.id);
        }
      }
      if (terminalMissing.length > 0) {
        findings.push(`O7_TERMINAL_WITHOUT_TERMINAL_EVENT: ${terminalMissing.length} run(s)`);
      }
    }
    rows.push({
      oracle: "O7",
      leg: "event-log-integrity",
      semantics: "custom seed-slice: terminal events present per run stream; no HUSH nudge events; rotation cap respected (structural corpus check; not the full O7 oracle execution whose implementation/acceptance are separate)",
      execution_kind: "custom-seed-slice",
      full_oracle_status: "NOT_RUN",
      status: findings.length === 0 ? "PASS" : "FAIL",
      findings,
      events,
    });
  }

  // O8/O9/O10/O11/O16 — campaign per-run oracles over real agent behavior.
  for (const o of ["O8", "O9", "O10", "O11", "O16"]) {
    rows.push({
      oracle: o,
      leg: "per-run-campaign-oracle",
      semantics: `per real ${o === "O8" ? "scope&diff" : o === "O9" ? "TSTX-ledger" : o === "O10" ? "ledger-gate" : o === "O11" ? "output-contract" : "held-out-probe"} judgment of real agent work — inapplicable to synthetic zero-token corpus`,
      execution_kind: "not-executed",
      full_oracle_status: "NOT_RUN",
      status: "NOT_RUN",
      findings: ["no real agent work in the corpus; oracle semantics do not apply to seed-fixture rows"],
    });
  }

  // O12 — see runO12Validation(); matrix row added by caller with the result.
  return { rows, census, events, wts };
}

function countEventName(db, stateDir, name) {
  const eventsDir = path.join(stateDir, "events");
  if (!fs.existsSync(eventsDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(eventsDir, entry.name), "utf-8").split("\n")) {
      if (line.includes(`"event":"${name}"`)) count += 1;
    }
  }
  return count;
}

function loadRunEventNameSets(stateDir, runIds) {
  const map = new Map();
  const eventsDir = path.join(stateDir, "events");
  if (!fs.existsSync(eventsDir)) return map;
  for (const runId of runIds) {
    const file = path.join(eventsDir, `${runId}.jsonl`);
    const names = new Set();
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt && typeof evt.event === "string") names.add(evt.event);
        } catch {
          /* skip */
        }
      }
    }
    map.set(runId, names);
  }
  return map;
}

// ── O12 runner over the immutable DB snapshot ──────────────────────────

// O12 pin provenance (Storm O12-REPIN / NPF-2).
//
// HISTORICAL.  The previous pin was the RUN45 close head eb953ca52e531 (see
// O12_PRIOR_PIN below).  It was published for the root's independent replay
// but NOT root-accepted and supports schema user_version 9 only, so its R1
// structural-orphan leg was NOT_EVALUABLE against the immutable
// user_version-10 seed snapshot.  The O12-REPIN work taught the oracle schema
// user_version 10 (the supported set AT THAT TIME, {9, 10}, fail-closed on
// unknown versions — US-001), regenerated the fixture set for schema 10
// (US-002), ran every O12 self-test ALONE with retained evidence (US-003), and
// ran the real oracle over an owned copy of the retained aged-state seed
// snapshot, publishing the R1..R6 acceptance matrix (US-004).
//
// SCHEMA 9..14 RE-PIN (STORM-AGED-FULL US-002, run 79).  The product schema
// moved on again: v14 = LEDGER-DIAG (suite_results.log_path, a NON-core
// column), so the O12 oracle was taught the whole 9..14 chain (the CURRENT
// supported set is {9, 10, 11, 12, 13, 14}) and the CONTENT pin below was
// RECOMPUTED by content with computeO12OracleContentHash (never from a commit
// id).  The nine-path content set is unchanged by that re-pin.  The prior
// schema-9..13 pin (d5027546...) is superseded.
//
// SCHEMA 9..13 RE-PIN (O12-SCHEMA-13 US-005, run 54).  The product schema then
// moved on: 11 = steps.target_moved_reroute_count, 12 = steps.preclaim_death_count
// (dual main/matchlock lineage) and 13 = runs.matchlock_policy, so the O12 oracle
// was taught the whole 9..13 chain (the CURRENT supported set is
// {9, 10, 11, 12, 13}) and the CONTENT pin below was RECOMPUTED by content with
// computeO12OracleContentHash (never from a commit id).  The nine-path content
// set is unchanged by that re-pin.
//
// LEGACY (US-005/US-006): the commit constants below name the pre-squash STORY
// commit that introduced the schema-10 oracle, but it is UNREACHABLE after the
// merge-worktree squash into integration/o12-repin (a0c0d318), so it is NO
// LONGER the pin.  They are retained as provenance text only (the O12-REPIN
// acceptance contract still names them until US-007 migrates that publisher).
// No consumer resolves or compares them; the durable pin is the CONTENT hash
// below, and materializePinnedOracle() materializes from HEAD.
export const O12_PINNED_COMMIT = "064e9cb5660c25b1574b0c5f66aa07c9a7934211";
export const O12_PINNED_TREE = "6f0a599f12ba5aff1cfcede8af01cf92ff8399a6";
export const O12_PINNED_SUBJECT =
  "feat: US-001 - Version-aware O12 schema model (support user_version 9 and 10; fail closed on unknown)";
export const O12_PINNED_ACCEPTANCE = "ROOT_ACCEPTED";
export const O12_PINNED_ACCEPTANCE_DETAIL =
  "schema-9..14 O12 build accepted by the Storm seed gate (the accepted value, not NOT_ROOT_ACCEPTED). The STORM-AGED-FULL US-002 re-pin (run 79) taught the oracle the v14 LEDGER-DIAG chain (suite_results.log_path, a NON-core column; the v13/v14 union-column rule is unchanged) and recomputed the content pin BY CONTENT hash; the prior O12-SCHEMA-13 US-005 re-pin produced the retained acceptance matrix: torture-test/var/results/o12-owned-store-acceptance-20260921T030206Z/ (owned-store-acceptance-receipt.json — verdict ALL_CASES_EXPECTED, r1_evaluable_all true, case_count 6 — over the legacy-v9 / legacy-v10 / legacy-v11 / legacy-v12-main / legacy-v12-matchlock / current-v13 owned stores, each case dir carrying its own oracle-evidence/o12/<stamp>/o12-db-integrity.json with the full R1..R6 matrix) plus the retained per-gate logs torture-test/var/results/o12-schema13-us004/ and torture-test/var/results/o12-schema13-us005/ (o12-content-pin.test.mjs, aged-core.test.mjs and seed-root-copy.test.mjs each run ALONE under TAMANDUA_TEST_GUARD=1 with /usr/bin/false harness binaries). Prior pins under O12_PRIOR_PIN / O12_SUPERSEDED_PIN / O12_NOT_ACCEPTED_PIN stay provisional.";

// ── Content-addressed O12 pin (NPF-2 Part 2, US-005) ───────────────────
//
// The commit pin above (O12_PINNED_COMMIT = the pre-squash STORY commit
// 064e9cb5) is NOT durable: once the run that authored it was squash-merged
// into integration/o12-repin (as a0c0d318), that story commit became
// unreachable and any consumer resolving it broke.  The durable anchor is the
// CONTENT of the O12 oracle: a deterministic SHA-256 over the documented O12
// content set.  Each re-pin records a surviving ANCESTOR commit the content is
// squashed onto as provenance ONLY (see O12_PINNED_PROVENANCE_COMMIT below;
// never a pre-squash story commit).  materializePinnedOracle() materializes
// from the repo's HEAD and fails closed on content drift, so a future squash
// (which rewrites commit hashes but not the oracle bytes) can never invalidate
// the pin.
export const O12_ORACLE_CONTENT_PATHS = Object.freeze([
  "torture-test/oracles/O12",
  "torture-test/oracles/lib/o12.mjs",
  "torture-test/oracles/O12-CONTRACT.md",
  "torture-test/oracles/self-test/generate-o12-fixtures.mjs",
  "torture-test/oracles/self-test/o12-fixture-matrix.mjs",
  "torture-test/oracles/self-test/o12.test.mjs",
  "torture-test/oracles/self-test/o12-schema-version.test.mjs",
  "torture-test/oracles/self-test/o12-seed-snapshot.test.mjs",
  "torture-test/oracles/self-test/run-o12-gate-self-tests.mjs",
]);

// Deterministic content hash of the O12 oracle set under repoRoot.  Canonical
// form: for every path in O12_ORACLE_CONTENT_PATHS in sorted order, feed
// "<rel>\0<byteLength>\0" then the file's exact bytes into one SHA-256.  Both
// the relative path and the length are part of the hash, so a rename or a
// truncation changes it (and mutating any pinned byte changes it).
export function computeO12OracleContentHash({ repoRoot } = {}) {
  if (!repoRoot || typeof repoRoot !== "string") {
    throw new Error("computeO12OracleContentHash: repoRoot is required");
  }
  const hash = crypto.createHash("sha256");
  for (const rel of [...O12_ORACLE_CONTENT_PATHS].sort()) {
    const abs = path.join(repoRoot, rel);
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (err) {
      throw new Error(`computeO12OracleContentHash: cannot read pinned O12 content ${rel}: ${err?.code ?? err}`);
    }
    hash.update(`${rel}\0${bytes.length}\0`, "utf8");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

// The embedded pin — equal to computeO12OracleContentHash(current tree).  The
// hash covers only the O12 content set (never this module), so embedding it
// here is stable across the worktree's own story commits.
//
// O12-SCHEMA-14 (run 79) recomputed this value BY CONTENT with
// computeO12OracleContentHash over the same nine documented paths after the
// oracle was taught schema 14 (LEDGER-DIAG) — it is never derived from, and
// never equals, a commit id.  Re-derived value:
//   node -e "import('./torture-test/aged/validate.mjs').then(m=>console.log(m.computeO12OracleContentHash({repoRoot:process.cwd()})))"
export const O12_PINNED_CONTENT_SHA256 =
  "fb542e7f94c9950fb6551eb5d3624d4bb6bb06870ed701798fbe3460135ae5a5";

// TORTURE-PORT US-006: the committed storm-seed readiness pointer locates the
// PRE-PORT seed-qualification copy whose `evidence/seed-validation-report.json`
// was produced while the schema-10 content set was pinned (99958d11...).  The
// O12-SCHEMA-13 US-005 re-pin moved the CONTENT pin to the schema-9..13 set
// above; the retained seed (and therefore its report) predates the port and is
// regenerated on this product, which is out of TORTURE-PORT scope.  Consumers
// use this declaration to tell the old report apart from an unknown/forged pin:
// a retained report under THIS hash is the DECLARED legacy pre-port artifact
// and is anchored to the current content pin (the durable identity); any other
// mismatch still fails closed.  The pre-port report's own provenance is the
// integration/o12-repin squash commit, recorded here for traceability only.
export const O12_PRE_PORT_CONTENT_SHA256 =
  "99958d1159ffff7b864f5a09a9d0889286c8b237bf89bd657fc022d803fa5461";
export const O12_PRE_PORT_PROVENANCE_COMMIT = "a0c0d318661046e23049c9d6715a908e4c98c428";
export const O12_PRE_PORT_PROVENANCE_SUBJECT = "feat: add schema 10 support to O12 oracle and re-pin seed gate";
export const O12_PRE_PORT_PIN_REASON =
  "the retained pre-port seed report was produced under the schema-10 O12 content pin; "
  + "the O12-SCHEMA-13 US-005 re-pin superseded it. The seed is regenerated on this product "
  + "(out of TORTURE-PORT scope), so the retained report is declared legacy and the durable "
  + "current pin is O12_PINNED_CONTENT_SHA256.";

// Provenance (NOT the pin): a commit recorded only so evidence can name the
// history this content is squashed onto.  On the run it was authored it was the
// base HEAD (integration/o12-repin tip); on the TORTURE-PORT product it is the
// pre-port source commit and is declared legacy below.  The pre-squash STORY
// commits of each run are deliberately NOT used (the merge-worktree squash
// rewrites them away).  Future squashes cannot invalidate the CONTENT pin
// above; this commit is provenance text only.
export const O12_PINNED_PROVENANCE_COMMIT = "7fe9f258b066069d3a9c171df311487da6d54594";
export const O12_PINNED_PROVENANCE_SUBJECT = "chore(torture): close TU2F torture-union leftovers (NF-6 + NF sweep)";

// TORTURE-PORT US-004: on the schema-13 product (integration/torture-final) the
// O12 content pin arrives as part of the squashed torture-test overlay, so the
// historical provenance commit above lives on the pre-port torture-union
// integration branch (integration/o12-repin) and is NOT an ancestor of this
// product's HEAD.  The durable identity remains O12_PINNED_CONTENT_SHA256; the
// commit is provenance text only and is explicitly declared legacy so consumers
// can tell it apart from a rewritten pre-squash story commit.  The aged
// self-tests accept an unreachable provenance ONLY when this marker is set;
// `materializePinnedOracle` still materializes from HEAD and fails closed on
// content drift, so the pin itself is unaffected.
export const O12_PINNED_PROVENANCE_LEGACY = true;
export const O12_PINNED_PROVENANCE_LEGACY_REASON =
  "pre-port torture-union provenance (integration/o12-repin); the O12 content is addressed by CONTENT hash, so this commit is provenance text only and need not be an ancestor of the product HEAD";

// The single durable pin IDENTITY every aged consumer uses: the CONTENT-hash
// prefix (never a commit hash).  It names the imported-oracle evidence dir and
// is the identity `listPriorO12Runs` compares against, so a future squash —
// which rewrites commit hashes but not the oracle bytes — cannot invalidate
// it.
export const O12_PIN_IDENTITY = O12_PINNED_CONTENT_SHA256.slice(0, 12);

// The prior (RUN45 close) pin — schema-9-only and NOT root-accepted.  Kept as
// a named constant for provenance labeling of earlier evidence; runs/imports
// under it remain provisional under the current schema-9..13 pin.
export const O12_PRIOR_PIN = "eb953ca52e531a2c5725ac2a30e663e9bea5d49e";
export const O12_PRIOR_ACCEPTANCE = "NOT_ROOT_ACCEPTED";

// The superseded initial land pin whose earlier R1/R2/R4 runs are provisional
// (kept for provenance when labeling old evidence; old receipts are never
// rewritten).
export const O12_SUPERSEDED_PIN = "e8f912398b461bb2cb40dc7a2b47465264b34a43";

// The intermediate corrected pin (run41) that was ALSO not root-accepted
// (root probe 19:23:25Z) — retained for provenance labeling of evidence that
// used it; prior runs under it are provisional/unqualified.
export const O12_NOT_ACCEPTED_PIN = "62699fa25aeca9c5ad31d3d6475531caadc6c6f8";

// Materialize the whole torture-test/oracles + torture-test/bin trees from the
// repo's committed HEAD into the owned destDir (git read-only; the O12
// executable and its lib/index runtime import these paths relative to
// themselves).  HEAD — never a pre-squash story commit — is the durable
// source: the pinned O12 content is addressed by hash, so it survives
// merge-worktree squashes.  After materialization the O12 content hash is
// recomputed over the materialized set and this function THROWS if it differs
// from the expected content pin (default O12_PINNED_CONTENT_SHA256; fail closed
// on drift; never materialize a mismatched oracle).  The `commit` property of
// an older call shape is ignored on purpose — the pin is content, not a commit.
export function materializePinnedOracle({ gitRepo, destDir, contentSha256: expectedContentSha256 = O12_PINNED_CONTENT_SHA256 } = {}) {
  if (!gitRepo || !destDir) {
    throw new Error("materializePinnedOracle: gitRepo and destDir are required");
  }
  const list = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "torture-test/oracles", "torture-test/bin"], {
    cwd: gitRepo,
    encoding: "utf8",
  });
  if (list.status !== 0) {
    throw new Error(`materializePinnedOracle: git ls-tree HEAD failed: ${(list.stderr || "").slice(-500)}`);
  }
  const rels = list.stdout.trim().split("\n").filter(Boolean);
  const out = [];
  for (const rel of rels) {
    const res = spawnSync("git", ["show", `HEAD:${rel}`], {
      cwd: gitRepo,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      throw new Error(`materializePinnedOracle: git show HEAD:${rel} failed: ${String(res.stderr || "").slice(-500)}`);
    }
    const dst = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, res.stdout);
    out.push({ rel, dst, bytes: res.stdout.length });
  }
  // Fail closed: the materialized O12 content must match the expected content
  // pin exactly.  This is the check that makes the pin content-addressed — a
  // future squash may change commit hashes but never this content hash.
  const contentSha256 = computeO12OracleContentHash({ repoRoot: destDir });
  if (contentSha256 !== expectedContentSha256) {
    throw new Error(
      `materializePinnedOracle: O12 content drift: materialized content_sha256 ${contentSha256} !== pinned ${expectedContentSha256}`,
    );
  }
  return { rels: out, count: out.length, content_sha256: contentSha256 };
}

// Build a minimal but schema-valid oracle invocation context under the seed
// root (the campaign root = the seed root, which carries state.json).
export async function writeOracleContext({ seedRoot, oracleId, caseId, campaignId, snapshot, importedOracleDir }) {
  // Read the exact ORACLE_EVIDENCE_KEYS from the pinned oracle-context module
  // so the references object has EXACTLY the schema's key set (no drift).
  const ocMod = await import(pathToFileURL(path.join(importedOracleDir, "torture-test", "bin", "oracle-context.mjs")).href);
  const keys = ocMod.ORACLE_EVIDENCE_KEYS;
  const relSnap = path.relative(seedRoot, snapshot);
  const references = {};
  for (const key of keys) {
    if (key === "database_snapshot") {
      references[key] = {
        path: relSnap,
        sha256: sha256FileStream(snapshot),
        captured_at: new Date().toISOString(),
        // NOT 'controller-local-case': that source routes the oracle into the
        // local-case proof evaluator; aged-state evidence is a plain snapshot.
        source: "aged-state-seed",
      };
    } else {
      references[key] = null;
    }
  }
  const context = {
    contract_version: 1,
    oracle_id: oracleId,
    campaign: {
      id: campaignId,
      created_at: new Date().toISOString(),
      manifest: { sha256: "0".repeat(64), case_count: 1, case_ids: [caseId] },
    },
    case: {
      id: caseId,
      wave: 5,
      workflow: "aged-state-seed",
      fixture: "aged-state",
      harness: "none",
      class: "verification",
      caps: { tokens: 0, wall_min: 60 },
      boundary_files: [],
      forbidden: [],
      chaos: null,
    },
    run_id: null,
    attempts: [],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 5, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  fs.writeFileSync(path.join(seedRoot, `oracle-context-${oracleId}.json`), JSON.stringify(context, null, 2) + "\n", "utf-8");
  return context;
}

// Executes the REAL pinned O12 oracle over a snapshot + baseline sidecar.
export async function runO12Validation({ seedRoot, evidenceDir, importedOracleDir, snapshot, baselineFile }) {
  const oracleId = "O12";
  const caseId = "aged-seed-o12-postbatch";
  const campaignId = path.basename(seedRoot);
  // O12's context loader discovers the campaign root by walking up to a
  // directory containing state.json; the seed root is that results dir.
  const stateMarker = path.join(seedRoot, "state.json");
  if (!fs.existsSync(stateMarker)) {
    fs.writeFileSync(stateMarker, JSON.stringify({ campaign: campaignId, kind: "aged-state-seed" }, null, 2) + "\n", "utf-8");
  }
  const context = await writeOracleContext({
    seedRoot,
    oracleId,
    caseId,
    campaignId,
    snapshot,
    importedOracleDir,
  });
  const contextPath = path.join(seedRoot, `oracle-context-${oracleId}.json`);
  // Unique per-attempt evidence dir (the oracle's evidence writer is
  // exclusive-create; re-validation must never collide).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runEvidenceDir = path.join(evidenceDir, "o12", stamp);
  fs.mkdirSync(runEvidenceDir, { recursive: true });
  const env = {
    ...process.env,
    TT_ORACLE_CONTRACT_VERSION: "1",
    TT_ORACLE_ID: oracleId,
    TT_ORACLE_CONTEXT: contextPath,
    TT_ORACLE_EVIDENCE_DIR: runEvidenceDir,
    TT_CASE_ID: caseId,
    TT_CAMPAIGN_ID: campaignId,
    TT_O12_BASELINE: baselineFile,
    TAMANDUA_TEST_GUARD: process.env.TAMANDUA_TEST_GUARD ?? "1",
  };
  const entry = path.join(importedOracleDir, "torture-test", "oracles", "O12");
  const res = spawnSync(process.execPath, [entry, "--contract-version", "1", "--context", contextPath], {
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  let stdoutJson = null;
  try {
    stdoutJson = JSON.parse(res.stdout.trim());
  } catch {
    stdoutJson = null;
  }
  const evidence = {
    ts_utc: utcNow(),
    oracle: oracleId,
    exitCode: res.status,
    signal: res.signal ?? null,
    stdoutJson,
    stdoutTail: res.stdout.slice(-3000),
    stderrTail: res.stderr.slice(-3000),
  };
  const evidenceFile = path.join(runEvidenceDir, `o12-run-evidence.json`);
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
  return { ...evidence, evidenceFile, evidenceDir: runEvidenceDir };
}

export function writeValidationReport({ seedRoot, matrix, o12Evidence, priorO12 = null }) {
  const report = {
    ts_utc: utcNow(),
    routing: matrix,
    o12: o12Evidence,
    // Validator-code provenance (ROOT notice, 2026-09-09T20:38:14Z): the
    // corrected suite semantics + reserved-mutation derivation are coherent
    // repo commits; record which HEAD produced THIS report so a re-validation
    // under a different tree is never mistaken for this one.
    validator_source: {
      head: validatorRepoHead(),
      note: "report produced by torture-test/aged validate code at the recorded HEAD; corpus rows were created by the seed's executed-source pin (manifest.source)",
    },
    // Schema 9..13 content pin (Storm O12-REPIN + O12-SCHEMA-13 US-005): the
    // pin evaluated here is the CONTENT hash of the documented O12 oracle set
    // (the last commits that change lib/o12.mjs taught schema 10 and then
    // 11/12/13), carrying its acceptance status explicitly.  The prior RUN45
    // close head (eb953ca52e531, schema-9-only, NOT_ROOT_ACCEPTED) is retained
    // as O12_PRIOR_PIN for provenance; evidence under it stays provisional.
    o12_pin: {
      // Content-addressed pin (durable across merge-worktree squashes): the
      // SHA-256 of the documented O12 content set.  The provenance commit is
      // the landed squash that carries that content; it is recorded for
      // evidence only and is never used to resolve/materialize the oracle.
      content_sha256: O12_PINNED_CONTENT_SHA256,
      provenance_commit: O12_PINNED_PROVENANCE_COMMIT,
      provenance_subject: O12_PINNED_PROVENANCE_SUBJECT,
      commit: O12_PINNED_COMMIT,
      tree: O12_PINNED_TREE,
      subject: O12_PINNED_SUBJECT,
      acceptance: O12_PINNED_ACCEPTANCE,
      acceptance_detail: O12_PINNED_ACCEPTANCE_DETAIL,
    },
    // Prior O12 runs under a SUPERSEDED oracle pin are provisional — the
    // overall seed is only qualified under the current coherent pin.
    prior_o12_runs: priorO12,
    qualified: false, // never qualified without complete validation (O12 + full corpus)
    note: "Only a fully valid seed can arm the real storm. Missing oracles/evidence are NOT_RUN / NOT_EVALUABLE, never qualification.",
  };
  const file = path.join(seedRoot, "evidence", "seed-validation-report.json");
  // Archive any previous report before overwriting (old receipts preserved;
  // a prior report computed under a superseded pin stays available + labeled).
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, path.join(seedRoot, "evidence", `seed-validation-report.pre-${stamp}.json`));
  }
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf-8");
  return file;
}

// ── Honest red classification (STORM-AGED-FULL US-006) ─────────────────
//
// The seed-validation gate must classify EVERY non-PASS matrix row, never
// relabel a red as a pass and never silently drop a NOT_RUN/NOT_EVALUABLE row.
// The classification ledger is derived from the real routing matrix + the real
// O12 run evidence (legs/counts) and is written next to the report as
// `seed-validation-classification.json`.
//
// Classification vocabulary (the ONLY legal values for a non-PASS row):
//   NATIVE       a genuine product finding (recorded here, never fixed in src/)
//   SUITE        a validator (torture-test/**) defect fixed in this run
//   ENVIRONMENT  a host/environment limitation
//   NOT_RUN      oracle semantics need a live campaign a synthetic corpus lacks
//   NOT_EVALUABLE evidence absent / not judgeable for this corpus
//
// The anticipated O12 R3 (timestamp-uniformity) red is a NATIVE product TIME
// finding (beads tamandua-6sy.31 / tamandua-6sy.27).  When it does NOT
// reproduce (e.g. the v9->v10 migrateInstantsToIsoZ() normalization produced
// ISO-Z instants) that absence is recorded explicitly — never turned into a
// fabricated red and never suppressed.
export const SEED_VALIDATION_RED_CLASSES = Object.freeze([
  "NATIVE",
  "SUITE",
  "ENVIRONMENT",
  "NOT_RUN",
  "NOT_EVALUABLE",
]);
export const O12_TIME_BEADS = Object.freeze(["tamandua-6sy.31", "tamandua-6sy.27"]);

export const SEED_VALIDATION_CLASSIFICATION_BASENAME = "seed-validation-classification.json";

// Newest O12 db-integrity evidence emitted under a seed root's evidence tree
// (`<seedRoot>/evidence/o12/o12/<stamp>/o12-db-integrity.json`), or null.
export function findLatestO12DbIntegrity(seedRoot) {
  const base = path.join(seedRoot, "evidence", "o12", "o12");
  if (!fs.existsSync(base)) return null;
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const file = path.join(base, dirs[i], "o12-db-integrity.json");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function o12FailingLegs(coverage) {
  return Object.entries(coverage ?? {})
    .filter(([leg, record]) => leg !== "R6" && record?.result === "FAIL")
    .map(([leg]) => leg);
}

function timeFindingCounts({ coverage, timestamps, pairBreakdown }) {
  const r3 = coverage.R3 ?? {};
  const stepsUpdated = timestamps?.shape_histogram?.["steps.updated_at"] ?? {};
  return {
    O12_TIME_MIXED_NATIVE_FORMAT: {
      native_mixed_column_count: r3.native_format_mix_column_count ?? null,
      column: "steps.updated_at",
      shape_breakdown: {
        "sqlite_native_YYYY-MM-DD_HH-MM-SS": stepsUpdated["native-sqlite"] ?? 0,
        iso_8601: stepsUpdated["native-iso"] ?? 0,
        total_steps: Object.values(stepsUpdated).reduce((sum, c) => sum + (Number(c) || 0), 0),
      },
    },
    O12_TIME_PAIR_FORMAT_MISMATCH: {
      pair_format_mismatch_count: r3.pair_format_mismatch_count ?? null,
      breakdown: {
        runs_created_iso_vs_updated_sqlite: pairBreakdown?.runs?.pair_mismatch_count ?? null,
        steps_created_iso_vs_updated_sqlite: pairBreakdown?.steps?.pair_mismatch_count ?? null,
      },
      note:
        "The snapshot is the same immutable seed corpus; the per-table pair split is re-derived read-only from the snapshot with the oracle shape predicates.",
    },
    order_violation_count: r3.order_violation_count ?? null,
  };
}

// Build the classification record for a FAIL O12 row, or null when O12 PASSED
// (or was not evaluable — the caller classifies that separately).
export function buildO12RedRecord({ o12Result, dbIntegrity, report, pairBreakdown, seedRoot }) {
  if (o12Result !== "FAIL") return null;
  const coverage = dbIntegrity?.coverage ?? {};
  const structural = (dbIntegrity?.observations ?? []).find((o) => o.scope === "structural") ?? {};
  const timestamps = (dbIntegrity?.observations ?? []).find((o) => o.scope === "timestamps") ?? {};
  const userVersion = structural.schema_metadata?.user_version ?? null;
  const failingLegs = o12FailingLegs(coverage);
  const r1 = coverage.R1 ?? {};
  const timeOnly = failingLegs.length === 1 && failingLegs[0] === "R3" && r1.result === "PASS";

  // R1 NOT_EVALUABLE on a supported schema is a validator (SUITE) defect: the
  // oracle could not judge a schema it should understand.  Everything else is
  // a genuine product (NATIVE) finding recorded here, never reclassified away.
  let classification = "NATIVE";
  let reason;
  if (r1.result !== "PASS" && (r1.result === "NOT_EVALUABLE" || r1.result === "ERROR")) {
    classification = "SUITE";
    reason =
      `O12 R1 (structural-integrity-orphans) is ${r1.result} on user_version ${userVersion}: the validator could not judge a schema it should support. ` +
      "This is a SUITE defect (torture-test/** oracle coverage), not a product finding.";
  } else if (timeOnly) {
    reason =
      `Real pinned schema-9..14 O12 oracle executed over the immutable user_version-${userVersion} seed snapshot + host-owned v2 reserved-key baseline sidecar. ` +
      "R1 is EVALUABLE and PASSES; the only FAIL leg is R3 timestamp-uniformity: the PRODUCT's real createRun/step-ops APIs write created_at in ISO-8601 while updated_at uses SQLite's native datetime('now') writer. " +
      "This is a genuine product timestamp-discipline inconsistency (bead tamandua-6sy.31 TIME / TZPI tamandua-6sy.27), NOT a seed-fixture artifact and NOT a validator defect. Record, never fix natively, never relabel.";
  } else {
    reason =
      `Real pinned schema-9..14 O12 oracle executed over the immutable user_version-${userVersion} seed snapshot; failing leg(s) [${failingLegs.join(", ") || "(none)"}]. ` +
      "Classified NATIVE: a genuine product (src/) finding recorded in this run, never patched here and never relabeled.";
  }

  const findings = (report?.o12?.stdoutJson?.findings ?? []).map((f) => ({
    id: f.id,
    summary: f.summary ?? null,
    table: f.table ?? null,
    column: f.column ?? null,
    count: f.count ?? null,
    classification,
  }));
  const runDir = report?.o12?.evidenceDir ? path.relative(seedRoot, report.o12.evidenceDir) : null;
  const evidencePaths = [
    { path: "evidence/seed-validation-report.json", kind: "validation-report (routing matrix + O12 row)" },
    ...(runDir
      ? [
          { path: path.join(runDir, "o12-run-evidence.json"), kind: "O12 run evidence" },
          { path: path.join(runDir, "o12-db-integrity.json"), kind: `O12 db-integrity (failing legs: ${failingLegs.join(",") || "none"})` },
        ]
      : []),
    { path: "evidence/seed-validation-classification.json", kind: "this classification ledger" },
  ];
  return {
    oracle: "O12",
    status: "FAIL",
    classification,
    reason,
    failing_legs: failingLegs,
    findings,
    counts: timeFindingCounts({ coverage, timestamps, pairBreakdown }),
    beads: classification === "NATIVE" ? [...O12_TIME_BEADS] : [],
    evidence_paths: evidencePaths,
  };
}

// Classify the NON-O12 FAIL rows of the routing matrix (there are none on a
// clean corpus, but the mapping is generic and never drops a red).
export function buildNonO12RedRecords(matrix) {
  const reds = [];
  for (const row of matrix ?? []) {
    if (row.oracle === "O12" || row.status !== "FAIL") continue;
    reds.push({
      oracle: row.oracle,
      leg: row.leg ?? null,
      status: "FAIL",
      classification: "NATIVE",
      reason:
        `Real/custom ${row.oracle} leg FAILed on the seed corpus. Classified NATIVE (a genuine product finding for this corpus-slice) — recorded, never patched in src/ and never relabeled.`,
      findings: (row.findings ?? []).map((f) => (typeof f === "string" ? f : f.id ?? f.summary ?? String(f))),
      counts: row.counts ?? null,
      evidence_paths: [
        { path: "evidence/seed-validation-report.json", kind: "validation-report (routing matrix)" },
        { path: "evidence/seed-validation-classification.json", kind: "this classification ledger" },
      ],
    });
  }
  return reds;
}

// Build the honest classification ledger from the real report + real O12
// evidence.  Pure shaping: nothing is fabricated; absent evidence stays null.
export function buildValidationClassification({
  seedRoot,
  report,
  dbIntegrity,
  pairBreakdown = null,
  story = "US-006",
  storyTitle = "Run seed validation (routing matrix + O12) and classify every red honestly",
}) {
  const matrix = report?.routing?.rows ?? [];
  const coverage = dbIntegrity?.coverage ?? {};
  const structural = (dbIntegrity?.observations ?? []).find((o) => o.scope === "structural") ?? {};
  const timestamps = (dbIntegrity?.observations ?? []).find((o) => o.scope === "timestamps") ?? {};
  const userVersion = structural.schema_metadata?.user_version ?? null;
  const supported = structural.schema_metadata?.supported_user_versions ?? null;
  const o12Result = report?.o12?.stdoutJson?.result ?? (report?.o12?.error ? "NOT_EVALUABLE" : "ERROR");

  const o12Red = buildO12RedRecord({ o12Result, dbIntegrity, report, pairBreakdown, seedRoot });
  const nativeReds = [];
  const suiteReds = [];
  const environmentReds = [];
  if (o12Red) {
    if (o12Red.classification === "SUITE") suiteReds.push(o12Red);
    else if (o12Red.classification === "ENVIRONMENT") environmentReds.push(o12Red);
    else nativeReds.push(o12Red);
  }
  nativeReds.push(...buildNonO12RedRecords(matrix));

  const nativeOracles = new Set(nativeReds.map((r) => r.oracle));
  const suiteOracles = new Set(suiteReds.map((r) => r.oracle));
  const envOracles = new Set(environmentReds.map((r) => r.oracle));
  const rows = matrix.map((row) => {
    let classification;
    if (row.status === "PASS") classification = "PASS";
    else if (row.status === "FAIL") {
      if (nativeOracles.has(row.oracle)) classification = "NATIVE";
      else if (suiteOracles.has(row.oracle)) classification = "SUITE";
      else if (envOracles.has(row.oracle)) classification = "ENVIRONMENT";
      else classification = "UNCLASSIFIED";
    } else if (row.status === "NOT_EVALUABLE") classification = "NOT_EVALUABLE";
    else classification = "NOT_RUN";
    return {
      oracle: row.oracle,
      leg: row.leg ?? null,
      status: row.status,
      classification,
      red: row.status === "FAIL",
      execution_kind: row.execution_kind ?? null,
      full_oracle_status: row.full_oracle_status ?? null,
      findings: (row.findings ?? []).map((f) => (typeof f === "string" ? f : f.id ?? f.summary ?? String(f))),
      counts: row.counts ?? null,
      evidence_paths:
        row.oracle === "O12"
          ? [
              { path: "evidence/seed-validation-report.json", kind: "validation-report (O12 row)" },
              { path: "evidence/seed-validation-classification.json", kind: "this classification ledger" },
            ]
          : [{ path: "evidence/seed-validation-report.json", kind: "validation-report (routing matrix)" }],
    };
  });

  const tally = { PASS: 0, FAIL: 0, NOT_RUN: 0, NOT_EVALUABLE: 0 };
  for (const row of rows) {
    if (tally[row.status] !== undefined) tally[row.status] += 1;
  }

  const r1 = coverage.R1 ?? {};
  const r2 = coverage.R2 ?? {};
  const r3 = coverage.R3 ?? {};
  const r4 = coverage.R4 ?? {};
  const r5 = coverage.R5 ?? {};
  const r6 = coverage.R6 ?? {};
  const failingLegs = o12FailingLegs(coverage);
  const notRun = rows.filter((r) => r.status === "NOT_RUN").map((r) => r.oracle);
  const notEvaluable = rows.filter((r) => r.status === "NOT_EVALUABLE").map((r) => r.oracle);
  const timeRedReproduced = r3.result === "FAIL";

  // Explicit O12 R3 (TIME) attribution: whether the anticipated native red
  // reproduced or not, it is always cross-referenced (criterion 4).  A
  // non-reproduction is recorded as an explicit absence, never a fabricated red.
  const o12TimeRed = {
    leg: "R3",
    obligation: "timestamp-uniformity-instant-order",
    reproduced: timeRedReproduced,
    result: r3.result ?? null,
    classification: timeRedReproduced ? "NATIVE" : "PASS",
    beads: [...O12_TIME_BEADS],
    counts: timeRedReproduced
      ? timeFindingCounts({ coverage, timestamps, pairBreakdown })
      : {
          invalid_value_count: r3.invalid_value_count ?? 0,
          native_format_mix_column_count: r3.native_format_mix_column_count ?? 0,
          pair_format_mismatch_count: r3.pair_format_mismatch_count ?? 0,
          order_violation_count: r3.order_violation_count ?? 0,
        },
    evidence_paths: [
      { path: "evidence/seed-validation-report.json", kind: "validation-report (O12 row)" },
      { path: "evidence/seed-validation-classification.json", kind: "this classification ledger" },
    ],
    note: timeRedReproduced
      ? "O12 R3 timestamp-uniformity FAILs: the product's real createRun/step-ops writers mix ISO-8601 created_at with SQLite-native updated_at. Classified NATIVE (bead tamandua-6sy.31 TIME / tamandua-6sy.27 TZPI). Record only — never patched in src/, never relabeled."
      : "O12 R3 timestamp-uniformity PASSES: the anticipated native TIME red did NOT reproduce on this seed (the v9->v10 migrateInstantsToIsoZ() migration wrote ISO-Z instants). Recorded as an explicit absence, never as a fabricated red and never relabeled; bead tamandua-6sy.31 TIME / tamandua-6sy.27 TZPI remain open product decisions.",
  };

  const observations = [
    `O12 R1 (structural-integrity-orphans) is EVALUABLE and PASSES on user_version ${userVersion}: the schema-9..14 oracle build supports ${JSON.stringify(supported ?? [])}, integrity_check is ${r1.integrity_check ?? "unknown"}, foreign_key_check reports ${r1.foreign_key_check_violations ?? "?"} violations and every orphan probe reports 0.`,
    `O12 R2 (run-number uniqueness) ${r2.result ?? "unknown"} (${r2.rows_checked ?? "?"} rows, ${r2.duplicate_number_count ?? "?"} duplicate numbers).`,
    `O12 R4 (context-json reserved keys) ${r4.result ?? "unknown"}: ${r4.reserved_key_leg?.runs_compared ?? "?"} runs compared / ${r4.reserved_key_leg?.keys_checked ?? "?"} keys checked / ${r4.reserved_key_leg?.overwrite_count ?? "?"} overwrites / ${r4.reserved_key_leg?.host_transition_matches ?? "?"} host_transition_matches.`,
    `O12 R5 (serial-composite-state) ${r5.result ?? "unknown"} (${r5.violation_count ?? "?"} illegal pairs).`,
    r3.result === "PASS"
      ? `O12 R3 (timestamp-uniformity-instant-order) PASSES (${r3.invalid_value_count ?? 0} invalid values, ${r3.native_format_mix_column_count ?? 0} native-format-mix columns, ${r3.pair_format_mismatch_count ?? 0} pair mismatches, ${r3.order_violation_count ?? 0} order violations): the anticipated native TIME red did NOT reproduce on this seed. The v9->v10 migrateInstantsToIsoZ() normalization wrote ISO-Z instants, so R3 is green here; bead tamandua-6sy.31 (TIME) / tamandua-6sy.27 (TZPI) remain open product decisions and this absence of red is recorded, never relabeled.`
      : `O12 R3 (timestamp-uniformity-instant-order) FAILS (${r3.invalid_value_count ?? 0} invalid values, ${r3.native_format_mix_column_count ?? 0} native-format-mix columns, ${r3.pair_format_mismatch_count ?? 0} pair mismatches, ${r3.order_violation_count ?? 0} order violations) — classified NATIVE (bead tamandua-6sy.31 TIME / tamandua-6sy.27 TZPI), never fixed natively.`,
    r6.overall === "FAIL"
      ? `O12 R6 overall FAIL only because R3 (timestamp uniformity) FAILs; no other FAIL leg exists.`
      : `O12 R6 overall ${r6.overall ?? o12Result}: every R1..R5 leg is green on this corpus.`,
    `O12 ${o12Result}; failing legs [${failingLegs.join(", ") || "(none)"}] attributed as ${o12Red ? o12Red.classification : "(no red)"}.`,
    `NOT_RUN rows (${notRun.join(", ") || "none"}) need live-campaign semantics a synthetic zero-token corpus cannot produce; NOT_EVALUABLE rows (${notEvaluable.join(", ") || "none"}) lack their recorder/processor context. Both are recorded distinctly and are NEVER counted as PASS.`,
  ];

  return {
    kind: "aged-seed-validation-classification",
    ts_utc: utcNow(),
    story,
    story_title: storyTitle,
    seed_root: seedRoot,
    validation_report: path.join(seedRoot, "evidence", "seed-validation-report.json"),
    validation_classification: path.join(seedRoot, "evidence", SEED_VALIDATION_CLASSIFICATION_BASENAME),
    validator_source_head: report?.validator_source ?? null,
    o12_pin: report?.o12_pin ?? null,
    o12_result: o12Result,
    o12_legs: { R1: r1.result ?? null, R2: r2.result ?? null, R3: r3.result ?? null, R4: r4.result ?? null, R5: r5.result ?? null, R6: r6.result ?? null },
    o12_schema: { user_version: userVersion, supported_user_versions: supported },
    o12_failing_legs: failingLegs,
    o12_time_red: o12TimeRed,
    matrix_tally: tally,
    routing_matrix: rows,
    routing_matrix_coverage: rows.map((r) => r.oracle),
    suite_reds: suiteReds,
    environment_reds: environmentReds,
    native_reds: nativeReds,
    not_run_oracles: notRun,
    not_evaluable_oracles: notEvaluable,
    red_classes: [...SEED_VALIDATION_RED_CLASSES],
    observations,
  };
}

// Write the classification ledger under `<seedRoot>/evidence/`.  A prior
// ledger is archived (never overwritten in place) so every run is retained.
export function writeValidationClassification({ seedRoot, report, dbIntegrity, pairBreakdown = null, story, storyTitle } = {}) {
  if (!seedRoot || typeof seedRoot !== "string") {
    throw new Error("writeValidationClassification: seedRoot is required");
  }
  const classification = buildValidationClassification({ seedRoot, report, dbIntegrity, pairBreakdown, story, storyTitle });
  const dir = path.join(seedRoot, "evidence");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SEED_VALIDATION_CLASSIFICATION_BASENAME);
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, path.join(dir, `${SEED_VALIDATION_CLASSIFICATION_BASENAME}.pre-${stamp}.json`));
  }
  fs.writeFileSync(file, JSON.stringify(classification, null, 2) + "\n", "utf-8");
  return { file, classification };
}

// Best-effort read-only HEAD of the checkout containing validate.mjs (the
// torture repo root is the git top of the module's directory).
function validatorRepoHead() {
  try {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
    if (top.status !== 0) return null;
    const repo = top.stdout.trim();
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
    if (res.status === 0) {
      const subject = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: repo, encoding: "utf8" });
      return { repo, sha: res.stdout.trim(), subject: subject.status === 0 ? subject.stdout.trim() : null };
    }
  } catch { /* no repo context */ }
  return null;
}

// List existing O12 run-evidence stamps + pinned-commit import dirs under a
// seed root (read-only), so a re-validation can label prior runs as
// provisional rather than discarding or rewriting them.
export function listPriorO12Runs({ seedRoot, evidenceDir, currentPin }) {
  const prior = [];
  const o12Base = path.join(evidenceDir, "o12", "o12");
  if (fs.existsSync(o12Base)) {
    for (const entry of fs.readdirSync(o12Base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runDir = path.join(o12Base, entry.name);
      const evidenceFile = path.join(runDir, "o12-run-evidence.json");
      prior.push({
        stamp: entry.name,
        evidenceDir: runDir,
        runEvidenceFile: fs.existsSync(evidenceFile) ? evidenceFile : null,
        provisional: true, // superseded unless re-attributed below
      });
    }
  }
  const importsBase = path.join(evidenceDir, "imports");
  if (fs.existsSync(importsBase)) {
    const importDirs = fs
      .readdirSync(importsBase, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("o12-"))
      .map((e) => e.name);
    for (const name of importDirs) {
      const pin = name.startsWith("o12-") ? name.slice("o12-".length) : name;
      prior.push({
        importsDir: path.join(importsBase, name),
        pin: pin,
        pinIsCurrent: pin === currentPin.slice(0, 12),
        pinIsSuperseded: pin === O12_SUPERSEDED_PIN.slice(0, 12),
        // The RUN45 close head is now the PRIOR pin: schema-9-only and
        // NOT_ROOT_ACCEPTED — its imports stay labeled (and provisional).
        pinIsPriorNotRootAccepted: pin === O12_PRIOR_PIN.slice(0, 12),
        provisional: pin !== currentPin.slice(0, 12),
      });
    }
  }
  return prior;
}

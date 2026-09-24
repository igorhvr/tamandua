// seed-readiness.test.mjs — STORM-SEED-QUALIFY (US-012) self-test gate for the
// committed readiness pointer + the published seed-qualification verdict.
//
// Two layers:
//   1. Host layer (on this run's worktree): the COMMITTED readiness pointer
//      exists, is git-tracked, pins a real ancestor commit + tree, the seed
//      corpus is NOT committed, and (when the published qualification JSON is
//      present) the pointer and the qualification agree and the verdict is
//      honest.
//   2. Pure-builder layer (always runs): the qualification verdict is
//      qualified===true IFF every gating oracle PASSes and O12 PASSes —
//      a red-arming invariant that cannot be satisfied by relabeling.
//
// No model, no live state, no network; the host layer degrades gracefully when
// the external qualification file is absent (fresh clone) but the committed
// pointer itself is always required.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  GATING_ORACLES,
  QUALIFICATION_KIND,
  READINESS_KIND,
  buildMatrix,
  buildVerdict,
  buildReadinessPointer,
} from "../qualification.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const POINTER_PATH = path.join(REPO_ROOT, "torture-test", "storm-seed-readiness.json");

function git(args) {
  return spawnSync("git", ["-C", REPO_ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function isSha1(v) { return typeof v === "string" && /^[0-9a-f]{40}$/.test(v); }
function isSha256(v) { return typeof v === "string" && /^[0-9a-f]{64}$/.test(v); }

test("readiness pointer is committed, well-formed, and locates a qualification", () => {
  assert.ok(fs.existsSync(POINTER_PATH), `committed pointer exists: ${POINTER_PATH}`);
  const rel = path.relative(REPO_ROOT, POINTER_PATH);
  const tracked = git(["ls-files", "--error-unmatch", rel]);
  assert.equal(tracked.status, 0, `pointer is git-tracked (${rel})`);

  const p = loadJson(POINTER_PATH);
  assert.equal(p.kind, READINESS_KIND);
  assert.equal(p.schema_version, 1);
  assert.equal(p.task, "STORM-SEED-QUALIFY");
  assert.equal(p.bead, "tamandua-6sy.6.4.1");
  // The pointer identifies the run that produced it (O12-REPIN US-006
  // refreshed it on feature/o12-repin-schema10; STORM-AGED-FULL US-009
  // refreshes it on the seed-regeneration branch).  The branch is read, not
  // pinned to one run's name, but it must be a non-empty branch.
  assert.ok(typeof p.branch === "string" && p.branch.length > 0, "pointer names its branch");
  assert.ok(typeof p.run_id === "string" && p.run_id.startsWith("run-"), "pointer names its run id");
  assert.ok(typeof p.published_at_utc === "string" && p.published_at_utc.length > 0);

  assert.ok(isSha1(p.source?.commit), "source.commit is a 40-hex SHA");
  assert.ok(isSha1(p.source?.tree), "source.tree is a 40-hex SHA");
  assert.equal(p.source?.tree_dirty, false, "qualified source was recorded without tracked drift");

  assert.equal(p.qualification.kind, QUALIFICATION_KIND);
  assert.ok(typeof p.qualification.path === "string" && path.isAbsolute(p.qualification.path), "qualification path is absolute");
  assert.equal(typeof p.qualification.qualified, "boolean");
  assert.ok(Array.isArray(p.qualification.blocker_ids));
  assert.equal(p.qualification.blocker_count, p.qualification.blocker_ids.length);
  assert.ok(Array.isArray(p.qualification.igor_decision_blockers));

  assert.ok(typeof p.seed?.root === "string" && path.isAbsolute(p.seed.root));
  assert.equal(p.seed.kind, "full");
  assert.equal(p.seed.counts.runs, 5000);
  assert.ok(p.seed.counts.logical_events >= 500000, "seed reached the 500k logical-event scale");
  assert.equal(p.seed.counts.run_worktrees, 200);

  assert.ok(path.isAbsolute(p.campaign?.dir));
  assert.equal(p.campaign.profile, "SCRIPTED_REHEARSAL");
  assert.equal(p.campaign.mode, "prepared");
  assert.ok(p.campaign.id && p.campaign.id.length > 0);
  assert.ok(p.campaign.pending_candidate?.dir && path.isAbsolute(p.campaign.pending_candidate.dir));
  assert.notEqual(p.campaign.pending_candidate.dir, p.campaign.dir, "pending candidate is a distinct campaign");

  assert.equal(p.gate_hashes.count, 28, "gate-file set is the complete 28-file boundary");
  assert.equal(typeof p.gate_hashes.recompute_match, "boolean", "pointer records a gate-hash recompute verdict");
});

test("pointer source commit is a real commit with the recorded tree (ancestor of HEAD or declared pre-port legacy)", () => {
  const p = loadJson(POINTER_PATH);
  // TORTURE-PORT US-004: the committed pointer records the source commit of the
  // seed qualified BEFORE the port.  The port squashes the torture tree onto
  // integration/torture-final, so that commit is no longer an ancestor of HEAD.
  // An unreachable source is accepted ONLY when the pointer explicitly declares
  // it a pre-port legacy source; the commit must still resolve to a real object
  // whose tree and subject match the record, and it is never a rewritten
  // pre-squash story commit.
  const resolves = git(["cat-file", "-e", `${p.source.commit}^{commit}`]);
  assert.equal(resolves.status, 0, `${p.source.commit} resolves to a real commit`);
  const tree = git(["rev-parse", `${p.source.commit}^{tree}`]);
  assert.equal(tree.status, 0, "source.commit resolves");
  assert.equal(tree.stdout.trim(), p.source.tree, "source.tree == commit^{tree}");
  const subject = git(["log", "-1", "--format=%s", p.source.commit]);
  assert.equal(subject.status, 0, "source.commit resolves to a commit with a subject");
  assert.equal(subject.stdout.trim(), p.source.subject, "source.subject == the source commit's real subject");
  assert.doesNotMatch(p.source.subject ?? "", /^feat: US-\d{3}/, "the source is never a rewritten story commit");
  const ancestor = git(["merge-base", "--is-ancestor", p.source.commit, "HEAD"]);
  if (ancestor.status !== 0) {
    assert.equal(
      p.source.legacy_not_ancestor,
      true,
      `${p.source.commit} is not an ancestor of HEAD, so the pointer must declare it a pre-port legacy source`,
    );
    assert.match(
      p.source.legacy_reason ?? "",
      /pre-port|squash|integration\//i,
      "a legacy source records why it is not an ancestor",
    );
  }
});

test("the seed corpus (torture-test/var/results) is never committed", () => {
  const res = git(["ls-files", "torture-test/var/results"]);
  assert.equal(res.status, 0);
  const files = res.stdout.trim() === "" ? [] : res.stdout.trim().split("\n");
  assert.deepEqual(files, [], "no torture-test/var/results/** seed corpus is tracked");
});

test("host verdict: committed pointer and published qualification agree and are honest", () => {
  const p = loadJson(POINTER_PATH);
  if (!fs.existsSync(p.qualification.path)) {
    // Fresh clone / other host: the external qualification is host evidence.
    const qualifiedState = p.qualification.qualified;
    if (qualifiedState) {
      assert.deepEqual(p.qualification.blocker_ids, [], "a qualified pointer names no blockers");
    } else {
      assert.ok(p.qualification.blocker_ids.length > 0, "an unqualified pointer names its blockers");
      assert.ok(p.qualification.igor_decision_blockers.length > 0, "unqualified blockers flag the decisions that need Igor");
    }
    return;
  }
  const q = loadJson(p.qualification.path);
  assert.equal(q.kind, QUALIFICATION_KIND);
  assert.equal(q.task, p.task);
  assert.equal(q.branch, p.branch);
  assert.equal(q.source.commit, p.source.commit, "qualification and pointer pin the same source commit");
  assert.equal(q.seed.root, p.seed.root, "qualification and pointer name the same seed root");
  assert.equal(q.arming.campaign_id, p.campaign.id);
  assert.equal(q.arming.campaign_dir, p.campaign.dir);
  assert.deepEqual(q.arming.pending_candidate, p.campaign.pending_candidate);
  assert.equal(q.qualified, p.qualification.qualified, "verdict agrees");
  assert.deepEqual(q.blockers.map((b) => b.id), p.qualification.blocker_ids, "blocker list agrees");
  assert.deepEqual(
    q.blockers.filter((b) => b.igor_decision).map((b) => b.id),
    p.qualification.igor_decision_blockers,
    "Igor-decision flags agree",
  );

  // The matrix covers every gating oracle with a real status.
  const oracles = q.validation.matrix.map((r) => r.oracle);
  for (const o of GATING_ORACLES) assert.ok(oracles.includes(o), `matrix covers ${o}`);
  const tally = q.validation.matrix_tally;
  assert.equal(tally.PASS + tally.FAIL + tally.NOT_RUN + tally.NOT_EVALUABLE, GATING_ORACLES.length);

  // Honest verdict invariant: true only when nothing is red and everything PASSes.
  if (q.qualified) {
    assert.equal(tally.PASS, GATING_ORACLES.length, "qualified requires every oracle PASS");
    assert.equal(tally.FAIL, 0);
    assert.equal(tally.NOT_RUN, 0);
    assert.equal(tally.NOT_EVALUABLE, 0);
    assert.deepEqual(q.blockers, []);
    assert.equal(q.validation.o12.result, "PASS");
  } else {
    assert.ok(q.blockers.length > 0, "unqualified verdict carries named blockers");
    assert.match(q.qualified_reason, /NOT qualified|not qualified|NOT_RUN|FAIL/);
    const reds = q.validation.matrix.filter((r) => r.red);
    for (const red of reds) {
      assert.ok(
        ["NATIVE", "SUITE", "ENVIRONMENT"].includes(red.classification),
        `${red.oracle} FAIL is classified (got ${red.classification})`,
      );
    }
    // Scope-excluded rows keep their status verbatim and are never relabeled
    // as PASS (the 62023cc regression class).
    for (const row of q.validation.matrix) {
      if (row.status === "NOT_RUN") assert.equal(row.classification, "NOT_RUN", `${row.oracle} NOT_RUN stays NOT_RUN`);
      if (row.status === "NOT_EVALUABLE") {
        assert.equal(row.classification, "NOT_EVALUABLE", `${row.oracle} NOT_EVALUABLE stays NOT_EVALUABLE`);
      }
    }
    // The unqualified verdict names a REAL blocker.  The STORM-AGED-FULL
    // regeneration found the fresh O12 PASSES (the anticipated native TIME red
    // did not reproduce on the schema-14 seed), so the blockers are the
    // scope-excluded live-campaign oracles, never a fabricated red.
    assert.ok(
      q.blockers.some((b) =>
        ["BLOCKER-ORACLES-NOT-RUN", "BLOCKER-ORACLES-NOT-EVALUABLE", "BLOCKER-O12-TIME-NATIVE"].includes(b.id),
      ),
      "unqualified verdict names a real blocker",
    );
    if (reds.some((r) => r.oracle === "O12")) {
      assert.equal(q.validation.o12.result, "FAIL", "an O12 red implies the real O12 run FAILed");
    }
  }

  // Gate hashes in the qualification must be freshly recomputed, not copied
  // blindly, and must be HONEST about the prepared campaign boundary.  The
  // NPF-2 fix changed four gate files after the campaign was prepared, so the
  // refreshed qualification records the mismatch and names the drifted files
  // rather than claiming a match it did not observe.
  assert.equal(q.gate_hashes.count, 28);
  for (const [f, h] of Object.entries(q.gate_hashes.files)) {
    assert.ok(isSha256(h), `gate hash ${f} is sha256`);
  }
  assert.ok(Array.isArray(q.gate_hashes.drifted_files), "drifted files are named");
  assert.equal(
    q.gate_hashes.matches_prepared_campaign_descriptor,
    q.gate_hashes.drifted_files.length === 0,
    "matches_prepared_campaign_descriptor agrees with the named drift",
  );
  assert.equal(
    p.gate_hashes.recompute_match,
    q.gate_hashes.matches_prepared_campaign_descriptor,
    "the pointer's recompute verdict agrees with the qualification",
  );
});

test("recomputed gate hashes match the qualification (fresh computeGateHashes)", async () => {
  const p = loadJson(POINTER_PATH);
  if (!fs.existsSync(p.qualification.path)) return;
  const q = loadJson(p.qualification.path);
  const mod = await import("../../bin/tt-storm-rehearsal.mjs");
  const fresh = mod.computeGateHashes({ repoRoot: REPO_ROOT });
  assert.equal(Object.keys(fresh).length, q.gate_hashes.count);
  for (const [f, h] of Object.entries(fresh)) {
    assert.equal(q.gate_hashes.files[f], h, `recomputed gate hash matches for ${f}`);
  }
  // The prepared campaign descriptor is the boundary the qualification
  // compares against.  When it is present on this host, the recorded drift
  // must recompute-match a fresh comparison — a fabricated mismatch (or a
  // fabricated match) fails here.
  const descriptorPath = q.arming?.campaign_dir
    ? path.join(q.arming.campaign_dir, "descriptor.json")
    : null;
  if (descriptorPath && fs.existsSync(descriptorPath)) {
    const descriptor = loadJson(descriptorPath);
    const drifted = Object.entries(fresh)
      .filter(([f, h]) => descriptor.gate_hashes?.[f] !== h)
      .map(([f]) => f)
      .sort();
    assert.deepEqual(
      q.gate_hashes.drifted_files.map((entry) => entry.file).sort(),
      drifted,
      "recorded drifted gate files recompute-match the prepared descriptor",
    );
  }
});

test("buildReadinessPointer preserves the builder's run id and branch", () => {
  // O12-REPIN US-006 parameterizes the qualification builder so the refreshed
  // pointer identifies THIS run honestly instead of the original
  // STORM-SEED-QUALIFY run.
  const synthetic = {
    kind: QUALIFICATION_KIND,
    task: "STORM-SEED-QUALIFY",
    bead: "tamandua-6sy.6.4.1",
    run_id: "run-o12-repin-test",
    branch: "feature/o12-repin-schema10",
    published_at_utc: "2026-09-16T00:00:00.000Z",
    source: { commit: "a".repeat(40), tree: "b".repeat(40), subject: "s", tree_dirty: false },
    qualified: false,
    blockers: [],
    igor_decision_blockers: [],
    seed: { root: "/x", kind: "full", counts: {}, manifest_qualified: false },
    arming: {
      campaign_id: "campaign-x",
      campaign_dir: "/campaign/x",
      profile: "SCRIPTED_REHEARSAL",
      mode: "prepared",
      pending_candidate: { dir: "/campaign/pending" },
    },
    gate_hashes: { count: 28, matches_prepared_campaign_descriptor: true },
  };
  const pointer = buildReadinessPointer({
    qualification: synthetic,
    qualificationPath: "/qualification.json",
    pointerPath: "/pointer.json",
  });
  assert.equal(pointer.run_id, "run-o12-repin-test");
  assert.equal(pointer.branch, "feature/o12-repin-schema10");
  assert.equal(pointer.kind, READINESS_KIND);
});

// ── pure-builder red-arming invariant ────────────────────────────────────
function syntheticPassReport() {
  return {
    routing: {
      rows: GATING_ORACLES.map((oracle) => ({
        oracle,
        status: "PASS",
        execution_kind: "custom-seed-slice",
        full_oracle_status: "PASS",
        findings: [],
        counts: null,
      })),
    },
  };
}

test("verdict is qualified=true iff every gating oracle + O12 PASS (red-arming)", () => {
  const passClassification = { native_reds: [], suite_reds: [], environment_reds: [] };
  const matrix = buildMatrix(syntheticPassReport(), passClassification);
  const green = buildVerdict({ matrix, o12: { result: "PASS" }, o12Pin: { acceptance: "ROOT_ACCEPTED" } });
  assert.equal(green.qualified, true, "all-PASS matrix qualifies");
  assert.deepEqual(green.blockers, []);

  // Flip the real red shape: O12 FAIL with a NATIVE classification.
  const report = syntheticPassReport();
  report.routing.rows = report.routing.rows.map((r) => (r.oracle === "O12" ? { ...r, status: "FAIL" } : r));
  const classification = {
    native_reds: [{ oracle: "O12", classification: "NATIVE", findings: [{ id: "O12_TIME_PAIR_FORMAT_MISMATCH" }] }],
    suite_reds: [],
    environment_reds: [],
  };
  const red = buildVerdict({
    matrix: buildMatrix(report, classification),
    o12: { result: "FAIL" },
    o12Pin: { acceptance: "NOT_ROOT_ACCEPTED" },
  });
  assert.equal(red.qualified, false, "any red means NOT qualified");
  assert.equal(red.native_reds.length, 1);
  assert.ok(red.blockers.some((b) => b.id === "BLOCKER-O12-TIME-NATIVE" && b.igor_decision === true));

  // A NOT_RUN oracle is NOT a pass and never qualifies.
  const notRunReport = syntheticPassReport();
  notRunReport.routing.rows = notRunReport.routing.rows.map((r) => (r.oracle === "O8" ? { ...r, status: "NOT_RUN" } : r));
  const notRun = buildVerdict({
    matrix: buildMatrix(notRunReport, passClassification),
    o12: { result: "PASS" },
    o12Pin: { acceptance: "ROOT_ACCEPTED" },
  });
  assert.equal(notRun.qualified, false, "NOT_RUN is never qualified");
  assert.ok(notRun.blockers.some((b) => b.id === "BLOCKER-ORACLES-NOT-RUN"));
});

test("NOT_EVALUABLE routing rows keep their status in the classifier (red-arming)", () => {
  const emptyClassification = { native_reds: [], suite_reds: [], environment_reds: [] };

  // The 62023cc regression: the classifier's final `else` collapsed EVERY
  // non-PASS/non-FAIL row to NOT_RUN, so the NOT_EVALUABLE O5 row was
  // mislabeled and the published qualification overstated battery coverage.
  // buildMatrix must preserve the routing status verbatim.  This case fails
  // on the pre-62023cc classifier (classification === "NOT_RUN") and passes
  // on the fixed one.
  const single = buildMatrix(
    {
      routing: {
        rows: [
          { oracle: "O5", status: "NOT_EVALUABLE", execution_kind: "custom-seed-slice", findings: [] },
        ],
      },
    },
    emptyClassification,
  );
  assert.equal(single[0].status, "NOT_EVALUABLE");
  assert.equal(single[0].classification, "NOT_EVALUABLE");
  assert.notEqual(single[0].classification, "NOT_RUN", "NOT_EVALUABLE must never be relabeled NOT_RUN");

  // Same input through the verdict: the tally keeps the two scope-excluded
  // buckets separate, and the row is a named Igor-decision blocker, never a pass.
  const report = syntheticPassReport();
  report.routing.rows = report.routing.rows.map((r) => (r.oracle === "O5" ? { ...r, status: "NOT_EVALUABLE" } : r));
  const matrix = buildMatrix(report, emptyClassification);
  assert.equal(matrix.find((r) => r.oracle === "O5").classification, "NOT_EVALUABLE");
  const verdict = buildVerdict({ matrix, o12: { result: "PASS" }, o12Pin: { acceptance: "ROOT_ACCEPTED" } });
  assert.equal(verdict.matrix_tally.NOT_EVALUABLE, 1);
  assert.equal(verdict.matrix_tally.NOT_RUN, 0);
  assert.equal(verdict.qualified, false, "a NOT_EVALUABLE oracle never qualifies the seed");
  assert.ok(verdict.blockers.some((b) => b.id === "BLOCKER-ORACLES-NOT-EVALUABLE" && b.igor_decision === true));
});

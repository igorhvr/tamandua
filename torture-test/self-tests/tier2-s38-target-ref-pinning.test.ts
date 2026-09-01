// S38 (US-002) — snapshot target-ref pinning: the oracle evidence snapshot
// must pin the target ref at before-capture and thread the PINNED ref through
// refs_after and target_reflog captures, so O2/O10 stop keying the after/reflog
// evidence off the checked-out HEAD.
//
// Campaign evidence (read-only, campaign-20260826T225744158Z, documented in
// impl-tasks/S27-o10-audit-and-replay-set.md):
//   `refs_before.target_ref = refs/heads/main` vs `refs_after.target_ref =
//   refs/heads/security-audit-2026-08-27` — target-ref identity CHANGED between
//   snapshots. The W4.29 worker left its feature branch checked out, so the
//   pre-fix terminal capture re-resolved targetRefInfo against the current
//   HEAD (the feature branch) instead of the before-capture target
//   (refs/heads/main). O2 threw `O2 target ref identity disagrees across ref
//   and reflog snapshots` and O10 threw `target ref identity changed between
//   snapshots` (ORACLE_RUNTIME_ERROR) — both cells voided by a mechanical
//   artifact while the product provably landed on main.
//
// Fix (files ONLY under torture-test/, fail-closed preserved):
//   * beginOracleEvidenceSnapshot resolves the fixture's target identity ONCE
//     at before-capture (targetRefInfo result) and stores it on the baseline
//     (`pinned_target_ref`); refs-before is captured against it;
//   * completeOracleEvidenceSnapshot consumes the pinned identity for BOTH
//     refs_after and target_reflog (never re-resolving against the terminal
//     HEAD); target_tip is still resolved LIVE against the pinned ref so the
//     after tip reflects the run's landing. A legacy baseline without
//     pinned_target_ref falls back to the immutable refs-before.json;
//   * detached-HEAD fixtures (W4.30, S31/US-009 contract) keep target_ref =
//     the commit OID + detached_head: true, with logs/HEAD reflog capture.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM: pins the campaign divergence line verbatim and reproduces the
//     pre-fix re-resolution against the work-branch-checked-out shape — the
//     captured refs_after/target_reflog diverge from refs_before's target_ref
//     and O2/O10 throw their exact ORACLE_RUNTIME_ERROR messages (inline,
//     history-independent per tier0-history-independent-red-arms);
//   * GREEN-ARM (AC2): with the FIXED snapshot, the three evidence files agree
//     on the pinned refs/heads/main while the worker left
//     refs/heads/security-audit-2026-08-27 checked out; refs_after.target_tip
//     is main's LIVE landed tip and target_reflog carries the landing
//     transition on logs/refs/heads/main;
//   * GREEN-ARM (O2 end-to-end): evaluateO2 PASSes the work-branch-checked-out
//     landed evidence — the exact campaign ORACLE_RUNTIME_ERROR line is gone;
//   * GREEN-ARM (AC3): detached-HEAD fixtures keep target_ref = commit OID +
//     detached_head: true with no regression;
//   * GREEN-ARM (legacy baseline): a pre-S38 baseline without
//     pinned_target_ref falls back to refs-before.json and still pins.
//
// Follows the tier2-s31-*.test.ts self-test pattern (imports node builtins +
// repo-relative files only); picked up by self-tests/run.sh's tier2 glob.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
// The repo's .mjs oracle modules have no ambient type declarations (the
// pre-existing tier2-s31-detached-head-target-ref.test.ts pattern); node runs
// them directly, so the imports are intentionally untyped.
// @ts-expect-error -- no ambient declaration for the snapshot module
import { beginOracleEvidenceSnapshot, completeOracleEvidenceSnapshot } from "../bin/oracle-evidence-snapshot.mjs";
// @ts-expect-error -- no ambient declaration for the O2 oracle module
import { evaluateO2 } from "../oracles/lib/o2.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");

// ── Pinned campaign evidence (campaign-20260826T225744158Z) ─────────────
// The W4.29 divergence line documented verbatim in impl-tasks/S27-o10-audit-
// and-replay-set.md (read from the campaign snapshot):
const CAMPAIGN_DIVERGENCE_LINE =
  "refs_before.target_ref = refs/heads/main vs refs_after.target_ref = refs/heads/security-audit-2026-08-27 — target-ref identity CHANGED between snapshots";
// The pre-fix oracle ORACLE_RUNTIME_ERROR messages (o2.mjs / o10.mjs), the
// exact lines the campaign report carried for W4.29's O2/O10 cells.
const O2_RUNTIME_ERROR = "O2 target ref identity disagrees across ref and reflog snapshots";
const O10_RUNTIME_ERROR = "target ref identity changed between snapshots";
// The W4.29 worker branch (verbatim from the campaign evidence).
const WORKER_BRANCH = "security-audit-2026-08-27";

const RUN_ID = "run-11111111-1111-4111-8111-111111111111";
const DB_RUN_ID = "11111111-1111-4111-8111-111111111111";
// The suite gate key: launchGateKey hashes the case's raw test command, and
// O2's exact-gate row match requires the suite_results row to carry that hash.
const SUITE_CMD_HASH = createHash("sha256").update("npm test").digest("hex");

function run(file: string, args: string[], cwd: string, options: { input?: string; env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    input: options.input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "S38 Test",
      GIT_AUTHOR_EMAIL: "s38@example.invalid",
      GIT_COMMITTER_NAME: "S38 Test",
      GIT_COMMITTER_EMAIL: "s38@example.invalid",
      ...options.env,
    },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function git(repoDir: string, args: string[], options: { input?: string } = {}) {
  const result = run("git", ["-C", repoDir, ...args], repoRoot, options);
  assert.equal(result.status, 0, `git ${args.join(" ")}:\n${result.stderr}`);
  return result.stdout.trim();
}

// Build a throwaway TT var scratch (gitignored) with a committed git repo, an
// empty state dir, and a campaign dir — all under ttRoot so the snapshot
// machinery's containment checks pass. The caller removes the root. The DB
// carries the full O2-consumable schema (runs/steps/suite_results/
// tamandua_stats); run/suite rows are inserted after the run's landing (their
// values depend on the merge commit created mid-run).
function scratch(): { root: string; stateDir: string; repoDir: string; campaignDir: string; databasePath: string } {
  fs.mkdirSync(varRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(varRoot, `s38-${process.pid}-`));
  const stateDir = path.join(root, "state");
  const campaignDir = path.join(root, "results", "campaign-s38");
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(path.join(stateDir, "events"), { recursive: true });
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.mkdirSync(repoDir);
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "S38 Test"]);
  git(repoDir, ["config", "user.email", "s38@example.invalid"]);
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "value.ts"), "export const value = 1;\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "fixture"]);

  const databasePath = path.join(stateDir, "tamandua.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT, status TEXT, context TEXT, tokens_spent INTEGER);
    CREATE TABLE steps (run_id TEXT, step_id TEXT, terminal_reroute_count INTEGER);
    CREATE TABLE suite_results (
      id INTEGER PRIMARY KEY, origin_repo TEXT, tree_hash TEXT, cmd_hash TEXT,
      cmd_display TEXT, exit_code INTEGER, duration_ms INTEGER, log_tail TEXT,
      run_id TEXT, step_id TEXT, created_at TEXT
    );
    CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER);
    INSERT INTO tamandua_stats VALUES (1, 0);
  `);
  db.close();
  return { root, stateDir, repoDir, campaignDir, databasePath };
}

function requestFor(data: { stateDir: string; repoDir: string; campaignDir: string; databasePath: string; root: string }) {
  return {
    ttRoot,
    campaignDir: data.campaignDir,
    stateDir: data.stateDir,
    databasePath: data.databasePath,
    repositoryPath: data.repoDir,
    chaosLogPath: path.join(data.root, "chaos", "chaos.log"),
    caseRecord: {
      id: "W4.29-strict-gate-retry-finalize",
      workflow: "security-audit-merge",
      fixture: "tt-ts",
      harness: "pi",
      context: { merge_gate: "green", fail_missing: "1", test_cmd: "npm test" },
      boundary_files: ["src"],
      forbidden: [],
    },
    attempt: {
      id: "attempt-1",
      run_id: RUN_ID,
      launch_intent_at: "2026-08-01T12:00:00.000Z",
      execution_mode: "scripted",
      terminal_status: "completed",
      tokens_observed: 17,
      steps_snapshot: {
        source: "workflow-status-json",
        captured_at: "2026-08-01T12:03:00.000Z",
        steps: [],
      },
    },
    launchArgv: ["workflow", "run", "security-audit-merge", "--context", "merge_gate=green"],
    discoveredRuns: [],
  };
}

// Mirror the snapshot's targetRefInfo (S31 contract) inline — the pre-fix
// terminal capture re-resolved THIS against the current HEAD. History-
// independent red-arm reproduction.
function targetRefInfoShape(repoDir: string): { target_ref: string; detached: boolean } {
  const symbolic = spawnSync("git", ["-C", repoDir, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8", shell: false });
  const symbolicRef = symbolic.status === 0 && symbolic.stdout.trim() !== "" ? symbolic.stdout.trim() : null;
  if (symbolicRef !== null) {
    const resolved = spawnSync("git", ["-C", repoDir, "rev-parse", "--verify", symbolicRef], { encoding: "utf8", shell: false });
    if (resolved.status === 0 && resolved.stdout.trim() !== "") {
      return { target_ref: symbolicRef, detached: false };
    }
  }
  return { target_ref: git(repoDir, ["rev-parse", "--verify", "HEAD"]), detached: true };
}

// Build the W4.29 work-branch-checked-out shape between begin and complete:
// the worker branched security-audit-2026-08-27 off main, committed a fix
// (tree T1), landed it on main as merge commit C2 (update-ref reflog
// C0 -> C2), and LEFT the feature branch checked out. Returns the landing
// facts the events/DB evidence must carry.
function buildWorkBranchShape(data: { repoDir: string; databasePath: string; stateDir: string }) {
  const base = git(data.repoDir, ["rev-parse", "HEAD"]);
  git(data.repoDir, ["checkout", "-q", "-b", WORKER_BRANCH]);
  fs.writeFileSync(path.join(data.repoDir, "feature.txt"), "wanted change\n");
  git(data.repoDir, ["add", "feature.txt"]);
  git(data.repoDir, ["commit", "-q", "-m", "fix VULN-T1"]);
  const featureCommit = git(data.repoDir, ["rev-parse", "HEAD"]);
  const featureTree = git(data.repoDir, ["rev-parse", "HEAD^{tree}"]);
  const mergedCommit = git(data.repoDir, ["commit-tree", featureTree, "-p", base], { input: "land feature\n" });
  // The landing update-ref moves refs/heads/main C0 -> C2 and writes the
  // target-reflog transition the O2 oracle consumes.
  git(data.repoDir, ["update-ref", "refs/heads/main", mergedCommit, base]);
  // Worker leaves the feature branch checked out — HEAD is on
  // security-audit-2026-08-27, refs/heads/main has the landed tip.
  const headBranch = spawnSync("git", ["-C", data.repoDir, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8", shell: false });
  assert.equal(headBranch.stdout.trim(), `refs/heads/${WORKER_BRANCH}`, "premise: the worker must leave its branch checked out");
  return { base, featureCommit, featureTree, mergedCommit };
}

// Insert the terminal run + suite rows (merge facts known only after the
// landing) and the merge.landed event, then write the -wal sidecar for the
// terminal stable-copy leg.
function plantTerminalEvidence(data: { databasePath: string; stateDir: string; repoDir: string; campaignDir: string }, facts: { base: string; featureCommit: string; featureTree: string; mergedCommit: string }) {
  const suiteOrigin = fs.realpathSync(data.repoDir);
  const db = new DatabaseSync(data.databasePath);
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 0)").run(
    DB_RUN_ID,
    "security-audit-merge",
    "completed",
    JSON.stringify({ tested_tree: facts.featureTree, worktree_origin_repository: suiteOrigin }),
  );
  db.prepare("INSERT INTO steps VALUES (?, ?, 0)").run(DB_RUN_ID, "finalize_merge");
  db.prepare("INSERT INTO suite_results VALUES (1, ?, ?, ?, ?, 0, 12, NULL, ?, ?, ?)").run(
    suiteOrigin, facts.featureTree, SUITE_CMD_HASH, "npm test", RUN_ID, "step-finalize", "2026-08-01T12:03:00.000Z",
  );
  db.close();
  fs.writeFileSync(
    path.join(data.stateDir, "events", "all.jsonl"),
    `${JSON.stringify({
      ts: "2026-08-01T12:02:00.000Z",
      event: "merge.landed",
      runId: RUN_ID,
      origin: suiteOrigin,
      branch: WORKER_BRANCH,
      target: "refs/heads/main",
      expectedTip: facts.base,
      mergedTree: facts.featureTree,
      mergedCommit: facts.mergedCommit,
      noop: false,
    })}\n`,
  );
  fs.writeFileSync(`${data.databasePath}-wal`, "");
}

function evidencePathsFor(completed: { references: Record<string, { path: string } | null> }, campaignDir: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(completed.references)
      .filter(([, ref]) => ref !== null)
      .map(([key, ref]) => [key, path.join(campaignDir, (ref as { path: string }).path)]),
  ) as Record<string, string>;
}

// O2's captured-transition window is [refs_before.captured_at,
// target_reflog.captured_at] in wall-clock seconds while reflog entries carry
// INTEGER-second timestamps. A same-second begin+complete leaves no integer
// second inside the window, so the landing transition would be excluded even
// though it is present. Real campaigns span minutes; the test reproduces that
// by pacing the landing at least one second after the baseline capture.
function paceLandingWindow() {
  return new Promise<void>((resolve) => setTimeout(resolve, 1200));
}

describe("S38 (US-002) — snapshot target-ref pinning: after/reflog captures key off the before-capture target, not the checked-out HEAD", () => {
  it("RED-ARM: pins the campaign divergence line verbatim and reproduces the pre-fix re-resolution divergence + exact O2/O10 ORACLE_RUNTIME_ERROR lines", () => {
    assert.equal(
      CAMPAIGN_DIVERGENCE_LINE,
      "refs_before.target_ref = refs/heads/main vs refs_after.target_ref = refs/heads/security-audit-2026-08-27 — target-ref identity CHANGED between snapshots",
    );
    const data = scratch();
    try {
      // Build the work-branch-checked-out shape WITHOUT touching the snapshot:
      // the worker branched, committed, landed on main, and left the branch
      // checked out — the exact W4.29 terminal shape.
      const facts = buildWorkBranchShape(data);
      // The worker branch is a real, separate ref holding the feature commit —
      // it belongs in the evidence's for_each_ref listing, never in the target
      // identity.
      assert.equal(
        git(data.repoDir, ["rev-parse", "--verify", `refs/heads/${WORKER_BRANCH}`]),
        facts.featureCommit,
        "worker branch premise",
      );
      // Pre-fix captureRefs re-resolved targetRefInfo at EVERY phase, so
      // refs_before (main checked out) recorded refs/heads/main while the
      // terminal refs_after/target_reflog re-resolution against the worker's
      // checked-out branch recorded refs/heads/security-audit-2026-08-27.
      const beforeIdentity = { target_ref: "refs/heads/main", detached: false };
      const afterIdentity = targetRefInfoShape(data.repoDir);
      assert.equal(afterIdentity.target_ref, `refs/heads/${WORKER_BRANCH}`, "pre-fix terminal re-resolution must key off the worker's checked-out branch");
      assert.notEqual(
        beforeIdentity.target_ref,
        afterIdentity.target_ref,
        "pre-fix refs_before.target_ref must diverge from the re-resolved refs_after.target_ref",
      );
      // The exact oracle gates the campaign carried for W4.29:
      const o2Gate = () => {
        if (beforeIdentity.target_ref !== afterIdentity.target_ref) throw new Error(O2_RUNTIME_ERROR);
      };
      const o10Gate = () => {
        if (beforeIdentity.target_ref !== afterIdentity.target_ref) throw new Error(O10_RUNTIME_ERROR);
      };
      assert.throws(
        o2Gate,
        (error: unknown) => error instanceof Error && error.message === O2_RUNTIME_ERROR,
        "pre-fix O2 must throw its exact ORACLE_RUNTIME_ERROR message",
      );
      assert.throws(
        o10Gate,
        (error: unknown) => error instanceof Error && error.message === O10_RUNTIME_ERROR,
        "pre-fix O10 must throw its exact ORACLE_RUNTIME_ERROR message",
      );
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC2): with the worker's branch checked out, refs_before/refs_after/target_reflog agree on the pinned refs/heads/main; target_tip is main's live landed tip", () => {
    const data = scratch();
    try {
      fs.writeFileSync(`${data.databasePath}-wal`, "");
      const started = beginOracleEvidenceSnapshot(requestFor(data));
      assert.equal(started.status, "BASELINE_CAPTURED");
      fs.rmSync(`${data.databasePath}-wal`);
      const refsBefore = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, started.references.refs_before.path), "utf8",
      )) as { target_ref: string; target_tip: string };
      assert.equal(refsBefore.target_ref, "refs/heads/main", "refs_before must record the named main target");
      const base = refsBefore.target_tip;

      const facts = buildWorkBranchShape(data);
      plantTerminalEvidence(data, facts);
      const completed = completeOracleEvidenceSnapshot(requestFor(data), started);
      assert.equal(completed.status, "COMPLETE");

      const refsAfter = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.refs_after.path), "utf8",
      )) as { target_ref: string; target_tip: string; for_each_ref: string; detached_head?: boolean };
      const reflog = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.target_reflog.path), "utf8",
      )) as { target_ref: string; entries: Array<{ raw?: string; old_oid?: string; new_oid?: string }>; detached_head?: boolean };

      // AC2: all three evidence files key off the ref PINNED at before-capture
      // even though the worker left its feature branch checked out.
      assert.equal(refsAfter.target_ref, "refs/heads/main", "refs_after must use the pinned target ref, not the worker's branch");
      assert.equal(refsAfter.detached_head, undefined, "named-target refs_after must not carry detached_head");
      assert.equal(reflog.target_ref, "refs/heads/main", "target_reflog must use the pinned target ref");
      assert.equal(refsBefore.target_ref, refsAfter.target_ref, "before/after target identity must agree");
      assert.equal(refsAfter.target_ref, reflog.target_ref, "refs/reflog target identity must agree");
      assert.equal(refsAfter.target_tip, facts.mergedCommit, "refs_after.target_tip must be the LIVE landed tip of the pinned ref");
      assert.notEqual(refsAfter.target_tip, base, "the pinned main ref must have moved (landed)");
      // The worker branch is visible in the full ref listing — just never as
      // the target identity.
      assert.match(refsAfter.for_each_ref, new RegExp(`refs/heads/${WORKER_BRANCH}`), "the worker branch must stay visible in for_each_ref");
      // The target-reflog capture read logs/refs/heads/main: it must carry the
      // landing transition (base -> mergedCommit), never the feature branch's
      // reflog. (The snapshot parser archives parsed oids without a `parsed`
      // flag — O2 adds that flag when it consumes the artifact.)
      const landingTransition = reflog.entries.find((entry) =>
        entry.old_oid === base && entry.new_oid === facts.mergedCommit);
      assert.ok(landingTransition, `target_reflog must carry the base->landed transition on logs/refs/heads/main: ${JSON.stringify(reflog.entries)}`);
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: O2 evaluates the work-branch-checked-out landed evidence and PASSes — the exact campaign ORACLE_RUNTIME_ERROR line is gone", async () => {
    const data = scratch();
    try {
      fs.writeFileSync(`${data.databasePath}-wal`, "");
      const started = beginOracleEvidenceSnapshot(requestFor(data));
      fs.rmSync(`${data.databasePath}-wal`);
      // Pace the landing so its reflog timestamp lands inside the capture
      // window (see paceLandingWindow).
      await paceLandingWindow();
      const facts = buildWorkBranchShape(data);
      plantTerminalEvidence(data, facts);
      const completed = completeOracleEvidenceSnapshot(requestFor(data), started);
      assert.equal(completed.status, "COMPLETE");

      const evidencePaths = evidencePathsFor(completed, data.campaignDir);
      const evidenceDir = path.join(data.campaignDir, "o2-evidence");
      fs.mkdirSync(evidenceDir);
      const refsBeforeRef = completed.references.refs_before as { captured_at: string };
      const reflogRef = completed.references.target_reflog as { captured_at: string };
      const result = evaluateO2({
        campaignRoot: data.campaignDir,
        evidenceDir,
        evidencePaths,
        context: {
          attempts: [{ run_id: RUN_ID }],
          discovered_runs: [],
          mechanical_evidence: {
            references: {
              refs_before: { captured_at: refsBeforeRef.captured_at },
              target_reflog: { captured_at: reflogRef.captured_at },
            },
          },
        },
      });
      assert.equal(result.result, "PASS", `O2 must consume the pinned evidence without ORACLE_RUNTIME_ERROR: ${JSON.stringify(result)}`);
      assert.deepEqual(result.findings, [], "the work-branch-checked-out landed shape must produce no O2 findings");
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC3): detached-HEAD fixtures keep target_ref = commit OID + detached_head: true with no regression", () => {
    const data = scratch();
    try {
      git(data.repoDir, ["checkout", "-q", "--detach", "HEAD"]);
      const symbolicProbe = spawnSync("git", ["-C", data.repoDir, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8", shell: false });
      assert.equal(symbolicProbe.stdout.trim(), "", "premise: the fixture must be in detached HEAD");
      const headSha = git(data.repoDir, ["rev-parse", "HEAD"]);
      fs.writeFileSync(`${data.databasePath}-wal`, "");

      const started = beginOracleEvidenceSnapshot(requestFor(data));
      assert.equal(started.status, "BASELINE_CAPTURED");
      fs.rmSync(`${data.databasePath}-wal`);
      const refsBefore = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, started.references.refs_before.path), "utf8",
      )) as { target_ref: string; target_tip: string; detached_head?: boolean };
      assert.equal(refsBefore.target_ref, headSha, "detached fixture target_ref must be the HEAD commit");
      assert.equal(refsBefore.detached_head, true, "refs_before must carry detached_head");

      const completed = completeOracleEvidenceSnapshot(requestFor(data), started);
      assert.equal(completed.status, "COMPLETE");
      const refsAfter = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.refs_after.path), "utf8",
      )) as { target_ref: string; detached_head?: boolean };
      const reflog = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.target_reflog.path), "utf8",
      )) as { target_ref: string; detached_head?: boolean; entries: Array<{ raw?: string }> };
      assert.equal(refsAfter.target_ref, headSha, "refs_after must keep the pinned detached identity");
      assert.equal(refsAfter.detached_head, true, "refs_after must carry detached_head");
      assert.equal(reflog.target_ref, headSha, "target_reflog must keep the pinned detached identity");
      assert.equal(reflog.detached_head, true, "target_reflog must carry detached_head");
      assert.ok(Array.isArray(reflog.entries) && reflog.entries.length > 0,
        `detached reflog must capture logs/HEAD entries, got ${reflog.entries.length}`);
      assert.ok(reflog.entries.some((entry) => /checkout: moving from main to /.test(entry.raw ?? "")),
        "detached reflog must carry the checkout entry");
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: a legacy pre-S38 baseline (no pinned_target_ref) falls back to the immutable refs-before.json and still pins", () => {
    const data = scratch();
    try {
      fs.writeFileSync(`${data.databasePath}-wal`, "");
      const started = beginOracleEvidenceSnapshot(requestFor(data));
      fs.rmSync(`${data.databasePath}-wal`);
      // Simulate an interrupted run persisted by a PRE-S38 controller: the
      // baseline roundtripped through state.json carries no pinned_target_ref.
      const legacyBaseline = { ...started } as { pinned_target_ref?: unknown };
      delete legacyBaseline.pinned_target_ref;
      const facts = buildWorkBranchShape(data);
      plantTerminalEvidence(data, facts);
      const completed = completeOracleEvidenceSnapshot(requestFor(data), legacyBaseline);
      assert.equal(completed.status, "COMPLETE");
      const refsAfter = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.refs_after.path), "utf8",
      )) as { target_ref: string; target_tip: string };
      const reflog = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.target_reflog.path), "utf8",
      )) as { target_ref: string };
      assert.equal(refsAfter.target_ref, "refs/heads/main", "legacy baseline must still pin via refs-before.json");
      assert.equal(refsAfter.target_tip, facts.mergedCommit, "legacy baseline pinned ref tip must be the live landed tip");
      assert.equal(reflog.target_ref, "refs/heads/main", "legacy baseline target_reflog must pin via refs-before.json");
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });
});

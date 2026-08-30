// S31 (US-009) — W4.30-detached-head-origin: target-ref resolution honors the
// case's declared contract (a detached-HEAD origin) instead of assuming a
// symbolic ref.
//
// Campaign evidence (read-only, campaign-20260826T225744158Z-4bf26d7f):
//   report.txt: `W4.30-detached-head-origin: scheduler-execution-failed
//   (fixture repository has no symbolic target ref)`
// The W4.30 reset hook (cases/hooks/reset-w4.30-detached-head-origin.sh)
// detaches the work-clone HEAD, so `git symbolic-ref -q HEAD` is empty. The
// pre-fix targetRef() in torture-test/bin/oracle-evidence-snapshot.mjs ran
// that command and THREW `fixture repository has no symbolic target ref`;
// captureRefs (refs-before/refs-after) and the terminal target-reflog
// capture both call it, so the controller classified the cell
// scheduler-execution-failed (TEST_INFRA_FAIL, 0 tokens, 0s) before the case
// could even launch to its expected diagnosable-refusal corridor.
//
// Fix (files ONLY under torture-test/, fail-closed preserved):
//   * targetRefInfo resolves the fixture's target identity per the case's
//     declared contract: a named checkout resolves to its `refs/...` name; a
//     DETACHED-HEAD fixture resolves to the HEAD commit (recorded as
//     target_ref = the resolved OID with a `detached_head: true` marker on
//     refs_before/refs_after/target_reflog) — never the pre-fix throw;
//   * the terminal reflog capture reads `logs/HEAD` for detached fixtures;
//   * O2's readRefs/readReflog accept the detached evidence shape (target_ref
//     is a commit OID, not a `refs/` name) so the launch-refused corridor is
//     consumed without an oracle runtime error;
//   * fail-closed: a repository with NEITHER a symbolic ref NOR a resolvable
//     HEAD commit (empty/unborn) refuses with a precise one-line reason.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC2): pins the campaign cell line verbatim and reproduces the
//     pre-fix criterion + throw message shape inline (history-independent);
//   * GREEN-ARM (AC1): a detached-HEAD fixture begins + completes the oracle
//     evidence snapshot with the detached commit identity and detached_head
//     evidence, and the target_reflog captures logs/HEAD entries;
//   * GREEN-ARM: evaluateO2 consumes the detached evidence for the
//     launch-refused corridor (PASS, no `must be a full ref name` shape
//     error);
//   * FAIL-CLOSED: an unborn repository refuses with the precise one-line
//     reason `fixture repository has no symbolic target ref and no
//     resolvable HEAD commit`.
//
// Follows the tier2-s28-*.test.ts self-test pattern (imports node builtins +
// repo-relative files only); picked up by self-tests/run.sh's tier2 glob.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
// The repo's .mjs oracle modules have no ambient type declarations (the
// pre-existing tier1-include-real-proof.test.ts pattern); node runs them
// directly, so the imports are intentionally untyped.
// @ts-expect-error -- no ambient declaration for the snapshot module
import { beginOracleEvidenceSnapshot, completeOracleEvidenceSnapshot } from "../bin/oracle-evidence-snapshot.mjs";
// @ts-expect-error -- no ambient declaration for the O2 oracle module
import { evaluateO2 } from "../oracles/lib/o2.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");

// ── Pinned campaign evidence (campaign-20260826T225744158Z-4bf26d7f) ────
// report.txt INFRA FAILURE line for W4.30, verbatim:
const CAMPAIGN_CELL_LINE =
  "W4.30-detached-head-origin: scheduler-execution-failed (fixture repository has no symbolic target ref)";
// The pre-fix throw message (targetRef running `git symbolic-ref -q HEAD`
// against a detached repo and throwing) — reproduced inline
// (history-independent red-arm, per tier0-history-independent-red-arms).
const PRE_FIX_THROW_MESSAGE = "fixture repository has no symbolic target ref";
// The FIXED fail-closed one-line reason for a repo with no HEAD at all.
const FIXED_REFUSAL_MESSAGE =
  "fixture repository has no symbolic target ref and no resolvable HEAD commit";

const RUN_ID = "run-11111111-1111-4111-8111-111111111111";

function run(file: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", shell: false });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function git(repoDir: string, args: string[]) {
  const result = run("git", ["-C", repoDir, ...args], repoRoot);
  assert.equal(result.status, 0, `git ${args.join(" ")}:\n${result.stderr}`);
  return result.stdout.trim();
}

// Build a throwaway TT var scratch (gitignored) with a committed git repo, an
// empty state dir, and a campaign dir — all under ttRoot so the snapshot
// machinery's containment checks pass. The caller removes the root.
function scratch(): { root: string; stateDir: string; repoDir: string; campaignDir: string; databasePath: string } {
  fs.mkdirSync(varRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(varRoot, `s31-${process.pid}-`));
  const stateDir = path.join(root, "state");
  const campaignDir = path.join(root, "results", "campaign-s31");
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(path.join(stateDir, "events"), { recursive: true });
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.mkdirSync(repoDir);
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "S31 Test"]);
  git(repoDir, ["config", "user.email", "s31@example.invalid"]);
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "value.ts"), "export const value = 1;\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "fixture"]);
  // A minimal contained DB: the snapshot's baseline capture needs the
  // tamandua_stats table (systemTokens reads it); runs/steps/suite_results
  // carry the launch-refused corridor's terminal state.
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
  `);
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 0)").run(
    "11111111-1111-4111-8111-111111111111",
    "bug-fix-merge-worktree",
    "failed",
    JSON.stringify({ worktree_origin_repository: fs.realpathSync(repoDir) }),
  );
  db.prepare("INSERT INTO steps VALUES (?, ?, 0)").run("11111111-1111-4111-8111-111111111111", "triage");
  db.prepare("INSERT INTO tamandua_stats VALUES (1, 0)").run();
  db.close();
  fs.writeFileSync(
    path.join(stateDir, "events", "all.jsonl"),
    `${JSON.stringify({
      ts: "2026-08-01T12:00:00.000Z",
      event: "run.failed",
      runId: RUN_ID,
      workflowId: "bug-fix-merge-worktree",
    })}\n`,
  );
  return { root, stateDir, repoDir, campaignDir, databasePath };
}

// The W4.30 corridor's snapshot input: a bfmw case whose premise is a
// detached-HEAD origin; the run refused at launch (terminal_status failed).
function requestFor(data: { stateDir: string; repoDir: string; campaignDir: string; databasePath: string; root: string }) {
  return {
    ttRoot,
    campaignDir: data.campaignDir,
    stateDir: data.stateDir,
    databasePath: data.databasePath,
    repositoryPath: data.repoDir,
    chaosLogPath: path.join(data.root, "chaos", "chaos.log"),
    caseRecord: {
      id: "W4.30-detached-head-origin",
      workflow: "bug-fix-merge-worktree",
      fixture: "tt-ts",
      harness: "pi",
      context: { merge_gate: "green", fail_missing: "1", test_cmd: "npm test" },
      boundary_files: ["fixtures-src/tt-ts/src"],
      forbidden: [],
    },
    attempt: {
      id: "attempt-1",
      run_id: RUN_ID,
      launch_intent_at: "2026-08-01T12:00:00.000Z",
      execution_mode: "scripted",
      terminal_status: "failed",
      tokens_observed: 0,
      steps_snapshot: {
        source: "workflow-status-json",
        captured_at: "2026-08-01T12:00:04.000Z",
        steps: [],
      },
    },
    launchArgv: ["workflow", "run", "bug-fix-merge-worktree"],
    discoveredRuns: [],
  };
}

describe("S31 (US-009) — W4.30 detached-HEAD origin: target-ref resolution honors the declared contract", () => {
  it("RED-ARM: pins the campaign scheduler-execution-failed line verbatim and the pre-fix throw criterion", () => {
    assert.equal(
      CAMPAIGN_CELL_LINE,
      "W4.30-detached-head-origin: scheduler-execution-failed (fixture repository has no symbolic target ref)",
    );
    // The pre-fix mechanism: targetRef ran `git symbolic-ref -q HEAD` and
    // threw when it was empty (detached HEAD). Reproduce the criterion
    // against a detached fixture — the exact condition that made the old
    // code throw — and assert the pre-fix message shape.
    const data = scratch();
    try {
      git(data.repoDir, ["checkout", "-q", "--detach", "HEAD"]);
      const symbolicProbe = spawnSync("git", ["-C", data.repoDir, "symbolic-ref", "-q", "HEAD"], {
        encoding: "utf8",
        shell: false,
      });
      assert.equal(symbolicProbe.stdout.trim(), "", "detached HEAD must yield an empty symbolic-ref output");
      const head = git(data.repoDir, ["rev-parse", "--verify", "HEAD"]);
      assert.match(head, /^[0-9a-f]{40}$/, "a detached HEAD still resolves a commit");
      // Pre-fix logic shape (inline, history-independent): the old code
      // threw whenever the symbolic-ref output was empty.
      const preFixResolve = (symbolicOut: string): string => {
        if (symbolicOut.trim() === "") throw new Error(PRE_FIX_THROW_MESSAGE);
        return symbolicOut.trim();
      };
      assert.throws(
        () => preFixResolve(symbolicProbe.stdout),
        (error: unknown) =>
          error instanceof Error && error.message === PRE_FIX_THROW_MESSAGE,
        "pre-fix targetRef must throw the exact campaign message for a detached HEAD",
      );
      assert.equal(PRE_FIX_THROW_MESSAGE, "fixture repository has no symbolic target ref");
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: a detached-HEAD fixture begins + completes the snapshot with the detached commit identity (no throw)", () => {
    const data = scratch();
    try {
      // W4.30's reset hook detached the work-clone HEAD.
      git(data.repoDir, ["checkout", "-q", "--detach", "HEAD"]);
      const symbolicProbe = spawnSync("git", ["-C", data.repoDir, "symbolic-ref", "-q", "HEAD"], {
        encoding: "utf8",
        shell: false,
      });
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
      assert.equal(refsBefore.target_tip, headSha, "detached fixture target_tip must be the HEAD commit");
      assert.equal(refsBefore.detached_head, true, "refs_before must carry detached_head");

      const completed = completeOracleEvidenceSnapshot(requestFor(data), started);
      assert.equal(completed.status, "COMPLETE");
      const refsAfter = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.refs_after.path), "utf8",
      )) as { target_ref: string; detached_head?: boolean };
      assert.equal(refsAfter.target_ref, headSha);
      assert.equal(refsAfter.detached_head, true, "refs_after must carry detached_head");
      const reflog = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.target_reflog.path), "utf8",
      )) as { target_ref: string; detached_head?: boolean; entries: Array<{ raw?: string }> };
      assert.equal(reflog.target_ref, headSha, "target_reflog must carry the detached target identity");
      assert.equal(reflog.detached_head, true, "target_reflog must carry detached_head");
      assert.ok(Array.isArray(reflog.entries) && reflog.entries.length > 0,
        `detached reflog must capture logs/HEAD entries, got ${reflog.entries.length}`);
      assert.ok(reflog.entries.some((entry) => /checkout: moving from main to /.test(entry.raw ?? "")),
        "detached reflog must carry the checkout entry");
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: O2 consumes the detached evidence for the launch-refused corridor (no full-ref-name shape error)", () => {
    const data = scratch();
    try {
      git(data.repoDir, ["checkout", "-q", "--detach", "HEAD"]);
      fs.writeFileSync(`${data.databasePath}-wal`, "");
      const started = beginOracleEvidenceSnapshot(requestFor(data));
      fs.rmSync(`${data.databasePath}-wal`);
      const completed = completeOracleEvidenceSnapshot(requestFor(data), started);
      assert.equal(completed.status, "COMPLETE");
      const evidencePaths = Object.fromEntries(
        Object.entries(completed.references)
          .filter(([, ref]) => ref !== null)
          .map(([key, ref]) => [key, path.join(data.campaignDir, (ref as { path: string }).path)]),
      ) as Record<string, string>;
      const evidenceDir = path.join(data.campaignDir, "oracle-evidence");
      fs.mkdirSync(evidenceDir);
      // The launch-refused corridor: the run failed at launch, the target
      // never moved, no merge.landed. O2 must PASS — crucially WITHOUT the
      // `target_ref must be a full ref name` runtime error the pre-fix
      // detached evidence shape would have tripped.
      const result = evaluateO2({
        campaignRoot: data.campaignDir,
        evidenceDir,
        evidencePaths,
        context: {
          attempts: [{ run_id: RUN_ID }],
          discovered_runs: [],
          mechanical_evidence: {
            references: {
              refs_before: { captured_at: "2026-08-01T12:00:00.000Z" },
              target_reflog: { captured_at: "2026-08-01T12:00:01.000Z" },
            },
          },
        },
      });
      assert.equal(result.result, "PASS", `O2 must accept the detached evidence and pass: ${JSON.stringify(result)}`);
      assert.deepEqual(result.findings, [], "the launch-refused corridor must produce no O2 findings");
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: an unborn repository (no resolvable target identity) refuses with the precise one-line reason", () => {
    const data = scratch();
    try {
      // Make the repository UNBORN: HEAD points at refs/heads/master but no
      // commit exists — neither a resolvable symbolic target ref nor a HEAD
      // commit. The fixed targetRefInfo must refuse with the precise
      // one-line reason (never a silent empty target, never a generic
      // rev-parse failure escaping the snapshot).
      const unborn = path.join(data.root, "unborn");
      fs.mkdirSync(unborn);
      const init = spawnSync("git", ["init", "-q", unborn], { encoding: "utf8", shell: false });
      assert.equal(init.status, 0, init.stderr);
      const symbolicProbe = spawnSync("git", ["-C", unborn, "symbolic-ref", "-q", "HEAD"], {
        encoding: "utf8",
        shell: false,
      });
      assert.equal(symbolicProbe.stdout.trim(), "refs/heads/master", "unborn repo HEAD names an unborn ref");
      const headProbe = spawnSync("git", ["-C", unborn, "rev-parse", "--verify", "HEAD"], {
        encoding: "utf8",
        shell: false,
      });
      assert.notEqual(headProbe.status, 0, "unborn repo must have no resolvable HEAD commit");
      const unbornRequest = requestFor({
        ...data,
        repoDir: unborn,
        campaignDir: path.join(data.root, "results", "campaign-unborn"),
      });
      fs.mkdirSync(unbornRequest.campaignDir, { recursive: true });
      assert.throws(
        () => beginOracleEvidenceSnapshot(unbornRequest),
        (error: unknown) =>
          error instanceof Error && error.message === FIXED_REFUSAL_MESSAGE,
        "an unborn repository must fail closed with the precise one-line reason",
      );
      assert.equal(FIXED_REFUSAL_MESSAGE, "fixture repository has no symbolic target ref and no resolvable HEAD commit");
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });
});

// S46 (US-004) — O9 resolves ledger trees against the S38-pinned target ref.
//
// The R4a batch item (torture-test/impl-tasks/R4a-suite-batch-s45-s57.md):
//   "S46: O9_LEDGER_TREE_UNRESOLVED (W4.09-pi / W4.10-restart / W4.17-b):
//    reconcile O9's tree resolution with the S38 target-ref pinning (resolve
//    ledger trees against the pinned target ref, not the moving branch)."
//
// Pre-fix, oracles/lib/o9.mjs built its reachable-tree set with
// `git log --all --format=%T` (plus the detached-HEAD belt-and-suspenders
// walk), so every ledger row was checked against EVERY branch in the captured
// snapshot — including the branch that MOVED during the run. A tree committed
// only on that moving branch was therefore WRONGLY ACCEPTED as a captured
// committed fixture tree, and W4.09-pi / W4.10-restart / W4.17-b tripped
// O9_LEDGER_TREE_UNRESOLVED when tree resolution disagreed with the
// S38-pinned target ref (oracle-evidence-snapshot.mjs pins the target
// identity at before-capture and threads it through refs_before /
// refs_after / target_reflog).
//
// Fix (files ONLY under torture-test/, fail-closed preserved):
//   * O9 resolves ledger rows against the S38-pinned target ref. A
//     well-formed NAMED refs snapshot (detached_head absent, target_ref a
//     symbolic ref like refs/heads/main) is no longer advisory: the pinned
//     identity is the resolution basis (`git log <pinned ref>`), never
//     `--all`. The pinned target's OWN captured tips are walked too
//     (refs_before/refs_after target_tip + the target reflog entry OIDs): a
//     squash-merge or a later landing can leave an earlier landing reachable
//     ONLY through that captured history — still the pinned target, never the
//     moving branch.
//   * The detached-HEAD contract keeps its S35 semantics (the detached HEAD
//     commit OID IS the target identity; `--all` + the detached walk are
//     preserved); absent refs evidence keeps the legacy `--all` walk.
//   * The audit evidence records tree_resolution_basis /
//     tree_resolution_ref / tree_resolution_tip_count.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC1): pins the S46 item text and reproduces the PRE-FIX
//     criterion inline (history-independent): pre-fix O9 accepted a ledger
//     row whose tree was reachable ONLY via the moving branch (it never
//     fired O9_LEDGER_TREE_UNRESOLVED for that shape). GREEN-ARM: the
//     o9-moving-branch-tree fixture evaluates FAIL with
//     O9_LEDGER_TREE_UNRESOLVED through the REAL O9, resolution basis
//     pinned-target-ref;
//   * GREEN-ARM (AC2): the o9-pinned-target-green fixture (rows reachable
//     from the pinned target) PASSes with no unresolved-tree finding;
//   * GREEN-ARM (AC4): the W4.09-pi / W4.10-restart / W4.17-b replay
//     fixtures evaluate PASS — no spurious O9_LEDGER_TREE_UNRESOLVED. The
//     w4.10-restart fixture's row tree is reachable ONLY through the pinned
//     target's captured reflog (a superseded landing), proving the pinned-
//     tips leg resolves what `--all` at the terminal tip cannot;
//   * AC3 (no weakening): the detached-HEAD fixtures keep their semantics
//     (detached-green PASS, detached-wrong-tree FAIL) and the no-refs legacy
//     fixture (o9-green) still PASSes via the all-refs fallback;
//   * AC4 refs-unchanged proof: the fixture's snapshot/evidence files are
//     byte-identical before vs after the oracle run (read-only plumbing).
//
// Follows the tier2-*.test.ts self-test pattern (imports node builtins +
// repo-relative files only); picked up by self-tests/run.sh's tier2 glob.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const oracleO9 = path.join(ttRoot, "oracles", "O9");
const generator = path.join(ttRoot, "oracles", "self-test", "generate-o9-fixtures.mjs");
const runId = "run-99999999-9999-4999-8999-999999999999";

// ── Pinned item text (R4a-suite-batch-s45-s57.md), verbatim ──────────────
const S46_ITEM_LINE = "- S46: O9_LEDGER_TREE_UNRESOLVED (W4.09-pi / W4.10-restart / W4.17-b): reconcile O9's tree resolution with the S38\ntarget-ref pinning (resolve ledger trees against the pinned target ref, not the moving branch).";
const S46_W4_CASES = ["W4.09-pi", "W4.10-restart", "W4.17-b"];

// The PRE-FIX O9 tree-resolution criterion — reproduced inline
// (history-independent red-arm — tier0-history-independent-red-arms), never
// resolved from git: pre-fix evaluateO9 built its reachable-tree set with
// `git log --all` (every branch in the captured snapshot, INCLUDING the
// branch that moved during the run), so a ledger row whose tree was reachable
// only via the moving branch was ACCEPTED — O9_LEDGER_TREE_UNRESOLVED never
// fired for that shape (the tree was wrongly treated as a captured committed
// fixture tree). Post-fix the row resolves against the S38-pinned target ref
// only, so the same shape emits O9_LEDGER_TREE_UNRESOLVED.
function preFixMovingBranchTreeAccepted(allRefsReachable: ReadonlySet<string>, pinnedTargetReachable: ReadonlySet<string>, rowTree: string): { preFix: string; postFix: string } {
  const preFixAccepted = allRefsReachable.has(rowTree);
  const postFixAccepted = pinnedTargetReachable.has(rowTree);
  return {
    preFix: preFixAccepted ? "accepted (no O9_LEDGER_TREE_UNRESOLVED)" : "unresolved",
    postFix: postFixAccepted ? "resolved" : "O9_LEDGER_TREE_UNRESOLVED",
  };
}

function run(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 30_000): { status: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null } {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      TAMANDUA_TEST_GUARD: "0",
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), signal: result.signal };
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fixtureDigest(workspace: string, name: string): Record<string, string> {
  // The refs-unchanged proof (AC4): digest the SNAPSHOT evidence (the git
  // bundle + refs_before/refs_after/target_reflog — exactly the symbolic-ref
  // surface) plus the context/expectation, but NOT the oracle's own output
  // artifact (evidence/o9-ledger-replay-audit.json), which the oracle
  // legitimately writes into the evidence dir during evaluation.
  const digest: Record<string, string> = {};
  const root = path.join(workspace, name);
  for (const relative of ["snapshots", "evidence/context.json", "expectation.json"]) {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isDirectory()) {
      const walk = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const child = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(child);
          else if (entry.isFile()) digest[path.relative(root, child)] = sha256File(child);
        }
      };
      walk(absolute);
    } else {
      digest[relative] = sha256File(absolute);
    }
  }
  return digest;
}

function invokeO9(workspace: string, name: string): { response: any; status: number | null } {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, "expectation.json"), "utf8"));
  const contextPath = path.resolve(expectation.context);
  const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
  const result = run(oracleO9, ["--contract-version", "1", "--context", contextPath], {
    TT_ORACLE_CONTRACT_VERSION: "1",
    TT_ORACLE_ID: "O9",
    TT_ORACLE_CONTEXT: contextPath,
    TT_ORACLE_EVIDENCE_DIR: path.dirname(contextPath),
    TT_CASE_ID: context.case.id,
    TT_CAMPAIGN_ID: context.campaign.id,
    TT_RUN_ID: context.run_id,
  });
  assert.equal(result.signal, null, `${name} O9 signal`);
  return { response: JSON.parse(result.stdout.trim()), status: result.status };
}

function freshWorkspace(): string {
  fs.mkdirSync(varRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test."));
  const generated = run(process.execPath, [generator, workspace]);
  assert.equal(generated.status, 0, generated.stderr);
  return workspace;
}

function readAudit(workspace: string, name: string, response: any): any {
  assert.equal(response.evidence.length, 1, `${name} evidence`);
  return JSON.parse(fs.readFileSync(path.join(workspace, name, "evidence", response.evidence[0].path), "utf8"));
}

describe("S46 — O9 resolves ledger trees against the S38-pinned target ref (US-004)", () => {
  it("RED-ARM: pins the S46 item text and reproduces the pre-fix criterion (moving-branch-only tree wrongly accepted)", () => {
    assert.match(S46_ITEM_LINE, /O9_LEDGER_TREE_UNRESOLVED/);
    assert.match(S46_ITEM_LINE, /W4\.09-pi \/ W4\.10-restart \/ W4\.17-b/);
    assert.match(S46_ITEM_LINE, /resolve ledger trees against the pinned target ref, not the moving branch/);
    assert.deepEqual(S46_W4_CASES, ["W4.09-pi", "W4.10-restart", "W4.17-b"]);
    // Reproduce the PRE-FIX criterion inline against the moving-branch shape:
    // the row's tree is reachable via `git log --all` (the moving branch is a
    // ref in the captured snapshot) but NOT via the S38-pinned target ref.
    // Pre-fix O9 accepted it (no O9_LEDGER_TREE_UNRESOLVED — the S46 defect);
    // post-fix the same tree emits O9_LEDGER_TREE_UNRESOLVED.
    const movingTree = "e".repeat(40);
    const allRefs = new Set(["a".repeat(40), "b".repeat(40), movingTree]);
    const pinnedTarget = new Set(["a".repeat(40), "b".repeat(40)]);
    const verdict = preFixMovingBranchTreeAccepted(allRefs, pinnedTarget, movingTree);
    assert.equal(verdict.preFix, "accepted (no O9_LEDGER_TREE_UNRESOLVED)");
    assert.equal(verdict.postFix, "O9_LEDGER_TREE_UNRESOLVED");
    // The pinned-target-reachable row keeps resolving under both (AC2 —
    // no false positive from the fix).
    const onTarget = preFixMovingBranchTreeAccepted(allRefs, pinnedTarget, "a".repeat(40));
    assert.equal(onTarget.preFix, "accepted (no O9_LEDGER_TREE_UNRESOLVED)");
    assert.equal(onTarget.postFix, "resolved");
  });

  it("GREEN-ARM (AC1): a row reachable only via the moving branch FAILs with O9_LEDGER_TREE_UNRESOLVED (pinned-target basis)", () => {
    const workspace = freshWorkspace();
    try {
      const before = fixtureDigest(workspace, "o9-moving-branch-tree");
      const { response, status } = invokeO9(workspace, "o9-moving-branch-tree");
      assert.equal(response.result, "FAIL", JSON.stringify(response));
      assert.equal(status, 1, "FAIL exit code");
      assert.ok(response.findings.some((finding: any) => finding.id === "O9_LEDGER_TREE_UNRESOLVED"),
        "moving-branch-only tree must fire O9_LEDGER_TREE_UNRESOLVED post-fix");
      const audit = readAudit(workspace, "o9-moving-branch-tree", response);
      assert.equal(audit.tree_resolution_basis, "pinned-target-ref");
      assert.equal(audit.tree_resolution_ref, "refs/heads/main");
      assert.equal(audit.detached_head, false);
      assert.equal(audit.symbolic_target_ref, "refs/heads/main");
      const after = fixtureDigest(workspace, "o9-moving-branch-tree");
      assert.deepEqual(after, before, "the oracle must not alter any fixture file (symbolic refs unchanged)");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC2): rows reachable from the pinned target resolve cleanly (no false O9_LEDGER_TREE_UNRESOLVED)", () => {
    const workspace = freshWorkspace();
    try {
      const before = fixtureDigest(workspace, "o9-pinned-target-green");
      const { response, status } = invokeO9(workspace, "o9-pinned-target-green");
      assert.equal(response.result, "PASS", JSON.stringify(response));
      assert.equal(status, 0, "PASS exit code");
      assert.equal(response.findings.length, 0, "pinned-target rows must produce no findings");
      const audit = readAudit(workspace, "o9-pinned-target-green", response);
      assert.equal(audit.tree_resolution_basis, "pinned-target-ref");
      assert.equal(audit.tree_resolution_ref, "refs/heads/main");
      assert.equal(audit.ledger_reconciled, true);
      assert.ok(audit.committed_tree_count >= 1, "pinned-target trees must be resolved as reachable");
      const after = fixtureDigest(workspace, "o9-pinned-target-green");
      assert.deepEqual(after, before, "the oracle must not alter any fixture file (symbolic refs unchanged)");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC4): the W4.09-pi / W4.10-restart / W4.17-b replay fixtures no longer trip the unresolved-tree failure", () => {
    const workspace = freshWorkspace();
    try {
      for (const name of ["o9-w4.09-pi-kill-replay", "o9-w4.10-restart-replay", "o9-w4.17-b-refusal-replay"]) {
        const before = fixtureDigest(workspace, name);
        const { response, status } = invokeO9(workspace, name);
        assert.equal(response.result, "PASS", `${name}: ${JSON.stringify(response)}`);
        assert.equal(status, 0, `${name} PASS exit code`);
        assert.ok(!response.findings.some((finding: any) => finding.id === "O9_LEDGER_TREE_UNRESOLVED"),
          `${name} must not trip the unresolved-tree failure`);
        const audit = readAudit(workspace, name, response);
        assert.equal(audit.tree_resolution_basis, "pinned-target-ref", name);
        assert.equal(audit.tree_resolution_ref, "refs/heads/main", name);
        if (name === "o9-w4.10-restart-replay") {
          // The superseded landing (run A, restarted-then-superseded) is
          // reachable ONLY through the pinned target's captured reflog — the
          // pinned-tips leg must resolve it.
          assert.ok(audit.tree_resolution_tip_count >= 2, name);
        }
        const after = fixtureDigest(workspace, name);
        assert.deepEqual(after, before, `the oracle must not alter ${name} fixture files (symbolic refs unchanged)`);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("AC3 (no weakening): detached-HEAD semantics and the no-refs legacy fallback are unchanged", () => {
    const workspace = freshWorkspace();
    try {
      // Detached-HEAD green still PASSes (contract fields recorded)...
      let { response } = invokeO9(workspace, "o9-detached-green");
      assert.equal(response.result, "PASS", JSON.stringify(response));
      let audit = readAudit(workspace, "o9-detached-green", response);
      assert.equal(audit.detached_head, true);
      assert.equal(audit.tree_resolution_basis, "detached-head");
      assert.equal(audit.symbolic_target_ref, null);
      // ...detached-HEAD wrong-tree still FAILs fail-closed...
      ({ response } = invokeO9(workspace, "o9-detached-wrong-tree"));
      assert.equal(response.result, "FAIL", JSON.stringify(response));
      assert.ok(response.findings.some((finding: any) => finding.id === "O9_LEDGER_TREE_UNRESOLVED"),
        "detached wrong-tree must fire O9_LEDGER_TREE_UNRESOLVED");
      // ...and the no-refs legacy fixture keeps the all-refs fallback (audit
      // proceeds exactly as before when no pinning is recorded).
      ({ response } = invokeO9(workspace, "o9-green"));
      assert.equal(response.result, "PASS", JSON.stringify(response));
      audit = readAudit(workspace, "o9-green", response);
      assert.equal(audit.tree_resolution_basis, "all-refs");
      assert.equal(audit.tree_resolution_ref, null);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

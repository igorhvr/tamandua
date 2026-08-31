// S35 (US-005) — O9 oracle consumes the detached-HEAD snapshot contract
// (US-009) end-to-end.
//
// The tier-2 re-run campaign (campaign-20260830T075716699Z-112d79ce-4460-
// 4168-a58c-cdf9ed4f58ef) left W4.30-detached-head-origin TEST_INFRA_FAIL
// 'oracle-infrastructure' with the O9 result pinning the exact shape:
//
//   report.txt FINDINGS: W4.30-detached-head-origin: O9 - ORACLE_TEST_INFRA
//   report.txt INFRA FAILURES: - W4.30-detached-head-origin: oracle-infrastructure
//   O9 stdout.json: {"contract_version":1,"oracle_id":"O9","result":
//     "NOT_EVALUABLE",...}
//   state.json oracle errors: ["result must be PASS, FAIL, or ERROR"]
//   o9-ledger-replay-audit.json: {"schema_version":1,"not_evaluable":true,
//     "reason":"suite_observations.rows is empty: no shim evidence for the
//     case bundle"}
//
// Root cause: W4.30's premise is a detached-HEAD origin that the product
// REFUSES at launch (`origin repository is in detached HEAD state and no
// --worktree-origin-ref was provided`); the run fails at launch and NO shim
// evidence is ever produced (suite_observations.rows is empty). Pre-fix O9
// answered NOT_EVALUABLE on any empty-observation shape — but the campaign
// harness can only classify PASS/FAIL/ERROR (`result must be PASS, FAIL, or
// ERROR`), so the cell died ORACLE_TEST_INFRA. The S31 (US-009) snapshot
// contract records the detached-HEAD evidence shape (target_ref = commit OID,
// detached_head: true on refs_before/refs_after/target_reflog), which O9 now
// consumes end-to-end.
//
// Fix (files ONLY under torture-test/, fail-closed preserved):
//   * O9 reads the OPTIONAL refs evidence (refs_before/refs_after/
//     target_reflog) and consumes the detached-HEAD contract: when
//     detached_head: true, target_ref IS the detached HEAD commit OID and no
//     symbolic target ref exists. Row/tree resolution walks the detached
//     commit's reachable trees explicitly (idempotent with `--all`, but
//     contract-grounded — a commit reachable ONLY via the detached HEAD must
//     resolve); O9 never requires a symbolic target ref and NEVER writes or
//     alters refs (the oracle only runs read-only git plumbing on an isolated
//     extraction).
//   * The detached-HEAD launch-refused corridor (empty suite observations +
//     detached-head contract + terminal-FAILED attempt + run.failed with no
//     suite.* activity — the W4.30 shape) renders the REAL judgment PASS with
//     the corridor + contract fields recorded, instead of NOT_EVALUABLE
//     (which the campaign cannot classify). Every OTHER empty-observation
//     shape keeps the existing NOT_EVALUABLE verdict (the pinned
//     o9-empty-observations fixture is unchanged).
//   * The audit evidence records the contract fields (detached_head, target_ref
//     = commit OID, symbolic_target_ref = null).
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC2 + campaign pin): pins the campaign report/O9 evidence
//     verbatim and reproduces the PRE-FIX criterion inline (history-
//     independent — never resolved from git): the pre-fix O9 answered
//     NOT_EVALUABLE whenever suite_observations.rows was empty, which the
//     campaign harness classifies ORACLE_TEST_INFRA (`result must be PASS,
//     FAIL, or ERROR`) — the exact W4.30 verdict;
//   * GREEN-ARM (AC1): the detached-HEAD green fixture evaluates PASS through
//     the REAL O9 with the contract fields recorded (detached_head: true,
//     target_ref = <40-hex OID>, symbolic_target_ref: null) and the detached
//     commit's tree resolved;
//   * FAIL-CLOSED (AC2): the detached-HEAD wrong-tree fixture still FAILs with
//     O9_LEDGER_TREE_UNRESOLVED;
//   * GREEN-ARM (launch-refused corridor): the W4.30 corridor fixture renders
//     PASS with the corridor + contract fields — the real judgment the
//     campaign can classify;
//   * AC4: the fixture's symbolic refs are unchanged by the oracle (every
//     snapshot/evidence file is byte-identical before vs after the oracle run;
//     the captured git bundle's HEAD is a raw OID — detached state preserved).
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

// ── Pinned campaign evidence (campaign-20260830T075716699Z-112d79ce) ────
// report.txt lines for W4.30-detached-head-origin, verbatim:
const CAMPAIGN_O9_FINDING_LINE = "W4.30-detached-head-origin: O9 - ORACLE_TEST_INFRA";
const CAMPAIGN_INFRA_FAILURE_LINE = "- W4.30-detached-head-origin: oracle-infrastructure";

// The stored O9 stdout.json (attempt-1/oracles/O9/stdout.json), verbatim:
const CAMPAIGN_O9_STDOUT =
  '{"contract_version":1,"oracle_id":"O9","result":"NOT_EVALUABLE","started_at":"2026-08-30T07:57:47.657Z","finished_at":"2026-08-30T07:57:47.954Z","findings":[],"evidence":[{"path":"o9-ledger-replay-audit.json","kind":"sqlite-git-and-shim-state-machine"}]}';

// The stored O9 evidence (o9-ledger-replay-audit.json), verbatim:
const CAMPAIGN_O9_EVIDENCE =
  '{\n  "schema_version": 1,\n  "not_evaluable": true,\n  "reason": "suite_observations.rows is empty: no shim evidence for the case bundle"\n}';

// The campaign harness rejection (state.json oracle errors), verbatim:
const CAMPAIGN_O9_ERROR = "result must be PASS, FAIL, or ERROR";

// The W4.30 detached-HEAD contract fields (US-009) — the run refused at
// launch, terminal_status failed, and the refs evidence carries the detached
// commit OID + detached_head: true:
const W4_30_TARGET_REF = "129e399ed8bdadda190bfe404d06c3837d00988e";
const W4_30_RUN_ID = "run-94597a2e-6bd6-4a89-8150-9e253c3bfed0";
const W4_30_TERMINAL_STATUS = "failed";

// The PRE-FIX O9 empty-observation criterion — reproduced inline
// (history-independent red-arm — tier0-history-independent-red-arms), never
// resolved from git: pre-fix evaluateO9 answered NOT_EVALUABLE whenever
// suite_observations.rows was empty, and the campaign harness rejects
// NOT_EVALUABLE (`result must be PASS, FAIL, or ERROR`) → ORACLE_TEST_INFRA.
function preFixEmptyObservationVerdict(observationRows: unknown[]): { verdict: string; campaignClass: string } {
  const verdict = observationRows.length === 0 ? "NOT_EVALUABLE" : "audit";
  return {
    verdict,
    campaignClass: verdict === "NOT_EVALUABLE" ? CAMPAIGN_O9_ERROR : verdict,
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

describe("S35 — O9 consumes the detached-HEAD snapshot contract (US-009) end-to-end", () => {
  it("RED-ARM: pins the W4.30 campaign evidence and reproduces the pre-fix empty-observation criterion that classified ORACLE_TEST_INFRA", () => {
    // The campaign verdict, verbatim.
    assert.equal(CAMPAIGN_O9_FINDING_LINE, "W4.30-detached-head-origin: O9 - ORACLE_TEST_INFRA");
    assert.equal(CAMPAIGN_INFRA_FAILURE_LINE, "- W4.30-detached-head-origin: oracle-infrastructure");
    assert.equal(CAMPAIGN_O9_ERROR, "result must be PASS, FAIL, or ERROR");
    // The stored O9 stdout/evidence shapes, verbatim.
    assert.match(CAMPAIGN_O9_STDOUT, /"result":"NOT_EVALUABLE"/);
    assert.match(CAMPAIGN_O9_EVIDENCE, /"not_evaluable": true/);
    assert.match(CAMPAIGN_O9_EVIDENCE, /suite_observations\.rows is empty: no shim evidence for the case bundle/);
    // The detached-HEAD contract fields (US-009), verbatim.
    assert.match(W4_30_TARGET_REF, /^[0-9a-f]{40}$/);
    assert.equal(W4_30_TERMINAL_STATUS, "failed");
    // Reproduce the PRE-FIX criterion inline against the campaign's evidence
    // shape: suite_observations.rows was EMPTY (the launch-refused corridor
    // produces no shim evidence) → the pre-fix O9 answered NOT_EVALUABLE →
    // the campaign harness rejected it with exactly CAMPAIGN_O9_ERROR →
    // ORACLE_TEST_INFRA. Post-fix the same shape renders PASS (proved below).
    const preFix = preFixEmptyObservationVerdict([]);
    assert.equal(preFix.verdict, "NOT_EVALUABLE");
    assert.equal(preFix.campaignClass, CAMPAIGN_O9_ERROR);
    const audited = preFixEmptyObservationVerdict([{}]);
    assert.equal(audited.verdict, "audit");
  });

  it("GREEN-ARM: the detached-HEAD green fixture evaluates PASS with the contract fields recorded and the detached tree resolved", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test."));
    try {
      const generated = run(process.execPath, [generator, workspace]);
      assert.equal(generated.status, 0, generated.stderr);
      const before = fixtureDigest(workspace, "o9-detached-green");
      const { response, status } = invokeO9(workspace, "o9-detached-green");
      assert.equal(response.result, "PASS", JSON.stringify(response));
      assert.equal(status, 0, "PASS exit code");
      assert.equal(response.findings.length, 0, "detached green must have no findings");
      assert.equal(response.evidence.length, 1);
      const audit = JSON.parse(fs.readFileSync(path.join(workspace, "o9-detached-green", "evidence", response.evidence[0].path), "utf8"));
      // US-009 contract fields: target_ref IS the detached HEAD commit OID and
      // no symbolic target ref exists.
      assert.equal(audit.detached_head, true);
      assert.match(audit.target_ref, /^[0-9a-f]{40}$/);
      assert.equal(audit.symbolic_target_ref, null);
      assert.equal(audit.ledger_reconciled, true);
      assert.ok(audit.committed_tree_count >= 1, "detached tree must be resolved as reachable");
      // The captured bundle's HEAD is a raw OID — the detached state is
      // preserved by the oracle (nothing wrote or altered refs).
      const after = fixtureDigest(workspace, "o9-detached-green");
      assert.deepEqual(after, before, "the oracle must not alter any fixture file (symbolic refs unchanged)");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: a detached-HEAD wrong-tree mutation still FAILs with O9_LEDGER_TREE_UNRESOLVED", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test."));
    try {
      const generated = run(process.execPath, [generator, workspace]);
      assert.equal(generated.status, 0, generated.stderr);
      const before = fixtureDigest(workspace, "o9-detached-wrong-tree");
      const { response, status } = invokeO9(workspace, "o9-detached-wrong-tree");
      assert.equal(response.result, "FAIL", JSON.stringify(response));
      assert.equal(status, 1, "FAIL exit code");
      assert.ok(response.findings.some((finding: any) => finding.id === "O9_LEDGER_TREE_UNRESOLVED"),
        "detached wrong-tree must fire O9_LEDGER_TREE_UNRESOLVED (fail-closed preserved)");
      const after = fixtureDigest(workspace, "o9-detached-wrong-tree");
      assert.deepEqual(after, before, "the oracle must not alter any fixture file (symbolic refs unchanged)");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: the detached-HEAD launch-refused corridor renders the real judgment PASS (never NOT_EVALUABLE)", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test."));
    try {
      const generated = run(process.execPath, [generator, workspace]);
      assert.equal(generated.status, 0, generated.stderr);
      const before = fixtureDigest(workspace, "o9-detached-launch-refused");
      const { response, status } = invokeO9(workspace, "o9-detached-launch-refused");
      assert.equal(response.result, "PASS", JSON.stringify(response));
      assert.equal(status, 0, "PASS exit code");
      assert.equal(response.findings.length, 0, "corridor PASS must have no findings");
      assert.equal(response.evidence.length, 1);
      const audit = JSON.parse(fs.readFileSync(path.join(workspace, "o9-detached-launch-refused", "evidence", response.evidence[0].path), "utf8"));
      // The real judgment the campaign can classify, with the corridor and the
      // US-009 contract fields recorded — NOT the pre-fix NOT_EVALUABLE shape.
      assert.equal(audit.not_evaluable, false);
      assert.equal(audit.launch_refused_corridor, true);
      assert.equal(typeof audit.corridor_reason, "string");
      assert.equal(audit.detached_head, true);
      assert.match(audit.target_ref, /^[0-9a-f]{40}$/);
      assert.equal(audit.symbolic_target_ref, null);
      assert.equal(audit.observation_count, 0);
      const after = fixtureDigest(workspace, "o9-detached-launch-refused");
      assert.deepEqual(after, before, "the oracle must not alter any fixture file (symbolic refs unchanged)");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

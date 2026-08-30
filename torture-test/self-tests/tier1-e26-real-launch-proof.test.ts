// E2.6 (US-007): REAL single-case integration proof — W1.L2-python end-to-end
// via `--case` + `--include-real`, token-bearing. Zero tokens to RUN (this file
// only verifies persisted evidence left by the ONE authorized real launch).
//
// E2.6's real launch failed for two infra reasons that preflight now closes:
//   (1) TT-custom workflow specs (tt-shim-probe) were never installed into the
//       contained TT home → `workflow-spec-missing: No workflow.yml found ...`;
//   (2) the contained HOME had no pi/hermes credentials → `No API key found for
//       the selected model`, so every real round died in ~300ms with 0 tokens.
// US-003 extended tt-catalog-install to install TT-custom specs per-name
// (fail-closed `catalog-missing: <name>`); US-004 surfaced ONLY the enumerated
// minimal harness auth files into the contained HOME; US-005 added the cheap
// fail-closed harness-auth probe; US-006 wired it into the preflight chain.
//
// This file does NOT re-run the campaign (that would spend tokens again). It
// locates the most recent persisted REAL W1.L2-python campaign under the
// gitignored var/results/ that actually launched a run (tokens_observed > 0)
// and asserts the E2.6-proof contract on its evidence:
//   (1) preflight GREEN: home-provision → harness-auth → catalog-install →
//       workflow-spec → daemon-up legs all ok (S30 US-008 adds the
//       workflow-spec leg verifying selected cases' declared workflows are
//       installed), and the contained daemon was stopped at teardown;
//   (2) the tt-shim-probe custom workflow was actually installed into the
//       contained TT home (workflow.yml present + custom catalog stamp);
//   (3) the real pi round produced tokens > 0 (case + campaign ledger);
//   (4) NO workflow-spec-missing and NO `No API key found` anywhere in the
//       campaign evidence or the contained daemon log (the E2.6 defect class);
//   (5) the configured oracles (O1, O3z, O8, O9, O11) actually RAN and were
//       VALID (each produced an evidence dir), and the outcome is honest — PASS
//       or a named classified finding, never TEST_INFRA_FAIL / NOT_RUN /
//       INCONCLUSIVE.
//
// On a host that has never run the token-bearing real proof the test SKIPS with
// a clear message (it is a proof-verification gate, not a fresh executor). Zero
// tokens. Confined to torture-test/ (only reads gitignored var/).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const containedHome = path.join(varRoot, "home");
const containedWorkflows = path.join(containedHome, ".tamandua", "workflows");
const containedDaemonLog = path.join(containedHome, ".tamandua", "tamandua.log");

const TARGET_CASE = "W1.L2-python";
const CUSTOM_WORKFLOW = "tt-shim-probe";
const CONFIGURED_ORACLES = ["O1", "O3z", "O8", "O9", "O11"];
// S30 US-008: the real-case preflight now includes the workflow-spec leg
// (verifies each selected real case's declared workflow is installed) between
// catalog-install and daemon-up — only when the selection has workflow cases
// (W1.L2-python is a real pi case, so the leg is present). Pre-US-008 real
// evidence has the 4-leg shape (no workflow-spec); assert the leg ORDER
// tolerantly: the four core legs in sequence, with workflow-spec (when
// present) between catalog-install and daemon-up.
const CORE_PREFLIGHT_LEGS = ["home-provision", "harness-auth", "catalog-install", "daemon-up"];

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Collect every campaign whose state contains a real W1.L2-python attempt,
// sorted newest-first by created_at.
function realW1L2Campaigns(): Array<{ dir: string; state: any; caseState: any }> {
  if (!fs.existsSync(resultsRoot)) return [];
  const campaigns: Array<{ dir: string; state: any; caseState: any }> = [];
  for (const name of fs.readdirSync(resultsRoot)) {
    const dir = path.join(resultsRoot, name);
    const statePath = path.join(dir, "state.json");
    if (!fs.existsSync(statePath)) continue;
    let state: any;
    try { state = loadJson(statePath); } catch { continue; }
    const caseState = (state.cases ?? []).find((c: any) => c.id === TARGET_CASE);
    if (caseState === undefined) continue;
    const realAttempt = (caseState.attempts ?? []).find((a: any) =>
      a.kind === "workflow" && a.execution_mode === "real" && a.fixture_work_clone !== undefined);
    if (realAttempt === undefined) continue;
    campaigns.push({ dir, state, caseState });
  }
  campaigns.sort((a, b) =>
    new Date(b.state.created_at).valueOf() - new Date(a.state.created_at).valueOf());
  return campaigns;
}

function walk(dir: string, acc: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
}

it("US-007: the single real W1.L2-python proof left preflight GREEN, tt-shim-probe installed, tokens>0, valid oracle evidence, and no E2.6 defect strings", { timeout: 60_000 }, () => {
  const campaigns = realW1L2Campaigns();
  if (campaigns.length === 0) {
    // The token-bearing proof requires a prior authorized real launch on this
    // host; absent one, skip rather than fail a clean checkout.
    console.log(
      "US-007: no persisted real W1.L2-python campaign found in var/results/ — " +
      "the token-bearing E2.6 proof has not been executed on this host; skipping.",
    );
    return;
  }

  // Use the NEWEST real campaign that actually drew tokens.
  const target = campaigns.find((c) => c.caseState.spend?.tokens_observed > 0) ?? campaigns[0];
  const { dir, state, caseState } = target;
  const attempt = (caseState.attempts ?? []).find((a: any) =>
    a.kind === "workflow" && a.execution_mode === "real" && a.fixture_work_clone !== undefined)!;
  const attemptId = attempt.id ?? "attempt-1";

  // (1) Preflight GREEN: the four legs ran in order and the daemon stopped.
  const preflight = state.real_preflight;
  assert.ok(preflight && typeof preflight === "object",
    "real preflight state must be persisted for a real launch");
  assert.equal(preflight.engaged, true, "preflight must be engaged");
  assert.equal(preflight.ok, true, `preflight must be ok; reason=${preflight.reason ?? "?"}`);
  const legLabels = (preflight.legs ?? []).map((leg: any) => leg.leg);
  // The four core legs must appear in order; the S30 workflow-spec leg (when
  // present) must sit between catalog-install and daemon-up.
  const coreIndexes = CORE_PREFLIGHT_LEGS.map((leg) => legLabels.indexOf(leg));
  assert.deepEqual(coreIndexes, [0, 1, 2, 3],
    `preflight legs must start home-provision → harness-auth → catalog-install → daemon-up (got: ${legLabels.join(" → ")})`);
  assert.deepEqual(legLabels.slice(0, 4), CORE_PREFLIGHT_LEGS,
    `core preflight legs out of order (got: ${legLabels.join(" → ")})`);
  if (legLabels.length > 4) {
    assert.deepEqual(legLabels, ["home-provision", "harness-auth", "catalog-install", "workflow-spec", "daemon-up"],
      `with the S30 workflow-spec leg it must sit between catalog-install and daemon-up (got: ${legLabels.join(" → ")})`);
  }
  for (const leg of preflight.legs ?? []) {
    assert.equal(leg.ok, true, `preflight leg ${leg.leg} must be ok`);
  }
  assert.equal(preflight.stop_ok, true,
    "contained daemon must have been stopped at campaign teardown");

  // (2) The tt-shim-probe custom workflow was installed into the contained home.
  assert.ok(fs.existsSync(path.join(containedWorkflows, CUSTOM_WORKFLOW, "workflow.yml")),
    `custom workflow ${CUSTOM_WORKFLOW} must be installed in the contained home`);
  assert.ok(fs.existsSync(path.join(containedWorkflows, ".tt-custom-catalog.json")),
    "the TT-custom catalog stamp (.tt-custom-catalog.json) must exist");

  // (3) The real pi round produced tokens > 0.
  const caseTokens = caseState.spend?.tokens_observed ?? 0;
  const campaignTokens = state.spend?.tokens_observed ?? 0;
  assert.ok(caseTokens > 0, `W1.L2-python real round must observe tokens > 0, got ${caseTokens}`);
  assert.ok(campaignTokens > 0, `campaign ledger must observe tokens > 0, got ${campaignTokens}`);

  // (4) No E2.6 defect strings anywhere in the campaign evidence or the
  // contained daemon log.
  const evidenceFiles: string[] = [];
  walk(path.join(dir, "evidence"), evidenceFiles);
  walk(path.join(dir, "snapshots"), evidenceFiles);
  const haystackParts: string[] = [];
  for (const f of evidenceFiles) {
    haystackParts.push(fs.readFileSync(f, "utf8"));
  }
  for (const f of ["report.txt", "state.json", "report.json"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) haystackParts.push(fs.readFileSync(p, "utf8"));
  }
  if (fs.existsSync(containedDaemonLog)) {
    haystackParts.push(fs.readFileSync(containedDaemonLog, "utf8"));
  }
  const haystack = haystackParts.join("\n");
  assert.ok(!/workflow-spec-missing/.test(haystack),
    "evidence must not contain workflow-spec-missing (E2.6 defect #1)");
  assert.ok(!/No workflow\.yml found/i.test(haystack),
    "evidence must not contain 'No workflow.yml found' (E2.6 defect #1)");
  assert.ok(!/No API key found/i.test(haystack),
    "evidence must not contain 'No API key found' (E2.6 defect #2)");

  // (5) Every configured oracle ran and was VALID; outcome is honest.
  const oracleResults = caseState.oracle_results ?? [];
  const evidenceRoot = path.join(dir, "evidence");
  for (const oracleId of CONFIGURED_ORACLES) {
    const oracleDir = path.join(evidenceRoot, TARGET_CASE, attemptId, "oracles", oracleId);
    assert.ok(fs.existsSync(oracleDir), `configured oracle ${oracleId} must have run (missing ${oracleDir})`);
    const stdoutJson = path.join(oracleDir, "stdout.json");
    assert.ok(fs.existsSync(stdoutJson), `configured oracle ${oracleId} must have produced stdout.json`);
    const oracleResponse = loadJson(stdoutJson);
    assert.equal(oracleResponse.oracle_id, oracleId, `oracle ${oracleId} stdout must name itself`);
    const record = oracleResults.find((r: any) =>
      r.oracle_id === oracleId && (r.attempt_id ?? "attempt-1") === attemptId);
    assert.ok(record !== undefined, `oracle ${oracleId} must have a persisted result record`);
    assert.equal(record.status, "VALID", `oracle ${oracleId} must be VALID, got ${record.status}`);
  }

  assert.equal(caseState.phase, "terminal", "case must be terminal");
  assert.notEqual(caseState.outcome, "NOT_RUN", "a real proof must not be NOT_RUN");
  assert.notEqual(caseState.outcome, "INCONCLUSIVE", "a real completed run must not be inconclusive");
  assert.notEqual(caseState.outcome, "TEST_INFRA_FAIL",
    "a real E2.6 proof must not be TEST_INFRA_FAIL (no infra-fail)");
  assert.ok(typeof caseState.outcome === "string"
      && ["PASS", "PRODUCT_FAIL", "FAIL", "AGENT_FLAKE", "PROVIDER_FAIL"].includes(caseState.outcome),
    `outcome must be an honest verdict, got ${caseState.outcome}`);
});

// Tier-1 gate (US-008): REAL single-case integration proof — W1.L1-python
// end-to-end via `--case`, token-bearing. Zero tokens to RUN (this file only
// verifies persisted evidence left by the ONE authorized real launch).
//
// E2.3 root cause was a real-case launch path that handed a fixture work-clone
// path to --working-directory-for-harness that NOTHING provisioned (ENOENT
// lstat, scheduler-execution-failed on every second-tier real launch). US-003/
// US-004 wired the provisioning adapter into the controller's real-case launch
// with per-attempt clean re-provision, and US-008 executed exactly ONE real
// W1.L1-python case via the controller's `--case` filter (pi harness, do-now on
// tt-python, the cheapest case — tokens 200000 / wall_min 5 caps) with a real
// token spend.
//
// This file does NOT re-run the campaign (that would spend tokens again). It
// locates the most recent persisted REAL W1.L1-python campaign under the
// gitignored var/results/ that actually launched a run (tokens_observed > 0 and
// a provisioned fixture work clone), and asserts the full E2.3-proof contract on
// its evidence:
//   (1) the provisioned work clone was recorded on the attempt BEFORE launch,
//   (2) tokens_observed > 0 (real spend was captured, O3z/O11 zero-token
//       regressions absent),
//   (3) NO scheduler-execution-failed and NO ENOENT lstat anywhere in the
//       campaign evidence/logs (the E2.3 defect class),
//   (4) evidence dirs are complete and the configured oracles (O1, O3z, O8,
//       O11) actually RAN (each produced an evidence dir),
//   (5) the outcome is honest — PASS or a named, classified finding — never a
//       vacuous TEST_INFRA_FAIL / NOT_RUN.
//
// On a host that has never run the token-bearing real proof the test SKIPS with
// a clear message (it is a proof-verification gate, not a fresh executor). Zero
// tokens. Confined to torture-test/ (only reads gitignored var/results).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");

const TARGET_CASE = "W1.L1-python";
const CONFIGURED_ORACLES = ["O1", "O3z", "O8", "O11"];

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Collect every campaign whose state contains a real W1.L1-python attempt,
// sorted newest-first by created_at.
function realPythonCampaigns(): Array<{ dir: string; state: any; caseState: any }> {
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
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
}

it("US-008: the single real W1.L1-python proof left tokens>0, a provisioned clone, complete oracle evidence, and no scheduler-execution-failed / ENOENT", { timeout: 60_000 }, () => {
  // Prerequisite: host profile (identical to other host-local proof gates).
  assert.ok(fs.existsSync(hostProfilePath),
    "host profile must exist — run `torture-test/bin/tt-verify-environment --fast --json` first");

  const campaigns = realPythonCampaigns();
  if (campaigns.length === 0) {
    // The token-bearing proof requires a prior authorized real launch on this
    // host; absent one, skip rather than fail a clean checkout.
    console.log(
      "US-008: no persisted real W1.L1-python campaign found in var/results/ — " +
      "the token-bearing proof has not been executed on this host; skipping.",
    );
    return;
  }

  // Use the NEWEST real campaign that actually drew tokens.
  const target = campaigns.find((c) => c.caseState.spend?.tokens_observed > 0) ?? campaigns[0];
  const { dir, caseState } = target;
  const attempt = (caseState.attempts ?? []).find((a: any) =>
    a.kind === "workflow" && a.execution_mode === "real" && a.fixture_work_clone !== undefined)!;

  // (1) The working clone was provisioned BEFORE launch (E2.3's missing stage).
  // The durable proof is the controller's provision RECORD (fixture_work_clone
  // + fixture_provision_record captured before launch); the clone directory
  // itself may have been pruned post-terminal by the declared teardown policy
  // (PASS prunes, FAIL keeps — US-005), so on-disk presence is NOT required.
  assert.equal(typeof attempt.fixture_work_clone, "string");
  assert.ok(attempt.fixture_work_clone.length > 0, "fixture work clone path must be recorded");
  const provision = attempt.fixture_provision_record;
  assert.ok(provision && typeof provision === "object", "fixture provisioning must be recorded on the attempt");
  assert.equal(typeof provision.work_clone_path, "string");
  assert.equal(provision.work_clone_path, attempt.fixture_work_clone,
    "provision record must reference the same work clone the launch used");
  assert.equal(typeof provision.golden_bare, "string");
  assert.ok(provision.golden_bare.length > 0, "provision must reference a golden bare");
  assert.equal(typeof provision.arming, "string");

  // (2) Real token spend was captured (O3z/O11 zero-token regressions absent).
  const tokens = caseState.spend?.tokens_observed ?? 0;
  assert.ok(tokens > 0, `real proof campaign must observe tokens > 0, got ${tokens}`);

  // (3) No scheduler-execution-failed and no ENOENT lstat anywhere in evidence.
  const evidenceFiles: string[] = [];
  const evidenceRoot = path.join(dir, "evidence");
  if (fs.existsSync(evidenceRoot)) walk(evidenceRoot, evidenceFiles);
  const snapshotsRoot = path.join(dir, "snapshots");
  if (fs.existsSync(snapshotsRoot)) walk(snapshotsRoot, evidenceFiles);
  const haystack = evidenceFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n")
    + fs.readFileSync(path.join(dir, "report.txt"), "utf8");
  assert.ok(!/scheduler-execution-failed/.test(haystack),
    "evidence must not contain scheduler-execution-failed (E2.3 defect class)");
  assert.ok(!/ENOENT lstat/.test(haystack), "evidence must not contain ENOENT lstat (E2.3 defect class)");

  // (4) Evidence dirs are complete AND every configured oracle actually ran
  // (each produced its own evidence output dir).
  const attemptId = attempt.id ?? "attempt-1";
  for (const oracleId of CONFIGURED_ORACLES) {
    const oracleDir = path.join(evidenceRoot, TARGET_CASE, attemptId, "oracles", oracleId);
    assert.ok(fs.existsSync(oracleDir), `configured oracle ${oracleId} must have run (missing ${oracleDir})`);
    const stdoutJson = path.join(oracleDir, "stdout.json");
    assert.ok(fs.existsSync(stdoutJson), `configured oracle ${oracleId} must have produced stdout.json`);
    const oracleResponse = loadJson(stdoutJson);
    assert.equal(typeof oracleResponse.result, "string");
    assert.equal(oracleResponse.oracle_id, oracleId);
  }
  const snapshotDir = path.join(dir, "snapshots", TARGET_CASE, attemptId);
  assert.ok(fs.existsSync(snapshotDir), "attempt snapshot evidence must exist");
  for (const f of ["snapshot.json", "checksum-baseline.json", "checksum-terminal.json",
    "token-deltas.json", "round-usage.json", "workflow-status.json"]) {
    assert.ok(fs.existsSync(path.join(snapshotDir, f)), `terminal evidence ${f} must exist`);
  }

  // (5) Outcome is honest — PASS or a named, classified finding; never a vacuous
  // TEST_INFRA_FAIL with the E2.3 defect class or a NOT_RUN/pending-real.
  assert.ok(caseState.phase === "terminal", "case must be terminal");
  assert.notEqual(caseState.outcome, "NOT_RUN", "a real proof must not be NOT_RUN");
  assert.notEqual(caseState.outcome, "INCONCLUSIVE", "a real completed run must not be inconclusive");
  assert.ok(typeof caseState.outcome === "string" && ["PASS", "PRODUCT_FAIL", "FAIL", "AGENT_FLAKE", "PROVIDER_FAIL"].includes(caseState.outcome),
    `outcome must be an honest verdict, got ${caseState.outcome}`);
  if (caseState.outcome === "PASS") {
    assert.equal(typeof caseState.classification?.category === "string" ? caseState.classification.category : null, "characterization-observed");
  } else {
    // A non-PASS outcome must carry a NAMED finding (e.g. an ORACLE_FAIL under
    // O8/O3z/O11) in the campaign report's findings ledger.
    const reportPath = path.join(dir, "report.json");
    assert.ok(fs.existsSync(reportPath), "report.json must exist");
    const report = loadJson(reportPath);
    const named = (report.findings ?? []).filter((f: any) =>
      (f.case_id ?? f.caseId) === TARGET_CASE && typeof f.finding?.id === "string");
    assert.ok(named.length > 0, "a non-PASS outcome must carry a named finding");
  }
});

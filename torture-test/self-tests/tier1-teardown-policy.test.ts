// Tier-1 integration gate (US-005): the DECLARED terminal-case working-clone
// teardown policy.
//
// E2.3 story 5. Spec 11 (schedule/budget/abort) and spec 12 (runner automation)
// are SILENT on whether a terminal case's provisioned working clone
// (var/fixtures/work/<case-id>/<fixture>) should be retained as evidence or
// pruned after terminalization. This suite pins the EXPLICIT, DECLARED policy
// (tt-teardown.mjs DECLARED_TEARDOWN_POLICY):
//   - PASSED case  -> PRUNE the harvested clone (bounded work dir, no forensics).
//   - FAILED case  -> KEEP the clone as failure-state evidence.
// and that EVERY decision is recorded to results/state.json (<case>.teardown)
// and surfaced in the campaign report (RUN TEARDOWN section + teardown_decisions).
//
// Files only inside torture-test/. Zero tokens: the PASS integration uses the
// TT_DRY_RUN_REAL_LAUNCH hook; the FAILED integration uses a failing `reset`
// hook that short-circuits before launch. The module under test is exercised
// through its CLI / a spawned node process (not a static import) to keep this
// self-test's standalone typecheck clean of TS7016 for the declaration-less
// .mjs (the project tsconfig excludes self-tests anyway).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
const teardownCli = path.join(binDir, "tt-teardown.mjs");
const varRoot = path.join(ttRoot, "var");
const goldenDir = path.join(varRoot, "fixtures", "golden");
const workRoot = path.join(varRoot, "fixtures", "work");
const resultsRoot = path.join(varRoot, "results");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

function runTt(script: string, args: string[], extraEnv: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: { ...process.env, HOME: os.homedir(), ...extraEnv },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadJsonLines(file: string): any[] {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// Evaluate a node expression that imports the teardown module and returns a
// JSON-serialisable value. Kept as a spawned node so the self-test never needs
// a static import of the declaration-less .mjs.
function moduleJson(expression: string): any {
  const script = `import(${JSON.stringify("./bin/tt-teardown.mjs")}).then(m => console.log(JSON.stringify(${expression}))).catch(e => { console.error(e); process.exit(1); });`;
  const res = spawnSync(process.execPath, ["-e", script], { cwd: ttRoot, encoding: "utf8" });
  assert.equal(res.status, 0, `module probe failed:\n${res.stderr}`);
  return JSON.parse(String(res.stdout ?? ""));
}

function modulePolicy(): any {
  return moduleJson("m.DECLARED_TEARDOWN_POLICY");
}

function moduleDecision(outcome: string): any {
  return moduleJson(`m.teardownDecision(${JSON.stringify(outcome)})`);
}

function ensureGolden(): void {
  const bare = path.join(goldenDir, "tt-python.git");
  if (fs.existsSync(bare)) return;
  const res = spawnSync(process.execPath, [path.join(binDir, "tt-golden-bootstrap.mjs"), "--fixture", "tt-python"], {
    cwd: ttRoot, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(res.status, 0, `golden bootstrap failed:\n${res.stderr}`);
}

function writeManifest(record: any): string {
  const name = `US005-${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}.jsonl`;
  const manifestPath = path.join(varRoot, name);
  fs.writeFileSync(manifestPath, `${JSON.stringify(record)}\n`);
  return manifestPath;
}

function baseRealRecord(): any {
  const tier1 = loadJsonLines(path.join(ttRoot, "cases", "tier1.jsonl"));
  const record = tier1.find((c: any) => c.id === "W1.L1-python");
  assert.ok(record, "tier1.jsonl must contain W1.L1-python");
  return record;
}

describe("Declared teardown policy declaration (US-005)", () => {
  it("DECLARED_TEARDOWN_POLICY is explicit, total, and documented (AC4)", () => {
    const policy = modulePolicy();
    assert.equal(policy.passed_case.action, "prune", "policy must declare PASS -> prune");
    assert.equal(policy.failed_case.action, "keep", "policy must declare failed -> keep");
    assert.equal(policy.record_every_decision, true);
    assert.equal(policy.prunes_only_provisioned_clones, true);
    assert.ok(String(policy.record_location).includes("state.json"),
      "policy must declare where decisions are recorded");
    // The decision mapping is total across every possible terminal outcome:
    // only PASS prunes; every failure/mechanical outcome keeps.
    for (const outcome of ["PRODUCT_FAIL", "AGENT_FLAKE", "PROVIDER_FAIL",
      "TEST_INFRA_FAIL", "INVALID", "INCONCLUSIVE", "NOT_RUN", "PASS"]) {
      assert.equal(moduleDecision(outcome), outcome === "PASS" ? "prune" : "keep",
        `unambiguous decision for ${outcome}`);
    }
  });

  it("PASS case -> PRUNE: clone removed and decision recorded (AC1, AC2, AC3)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-teardown-prune-"));
    const clone = path.join(dir, "clone");
    fs.mkdirSync(clone, { recursive: true });
    fs.writeFileSync(path.join(clone, "junk"), "x");
    try {
      const res = runTt(teardownCli, ["--case-id", "W-T", "--outcome", "PASS", "--work-clone-path", clone]);
      assert.equal(res.status, 0, `teardown CLI failed:\n${res.stderr}`);
      const parsed = JSON.parse(String(res.stdout ?? ""));
      assert.equal(parsed.ok, true);
      const record = parsed.record;
      assert.equal(record.action, "prune");
      assert.equal(record.kept, false);
      assert.equal(record.pruned, true, "PASS clone must be pruned");
      assert.equal(record.existed, true);
      assert.ok(!fs.existsSync(clone), "PASS clone must be gone from disk");
      // AC2/AC3: every decision is recorded with case id, outcome, action, timestamp.
      assert.equal(record.case_id, "W-T");
      assert.equal(record.outcome, "PASS");
      assert.equal(record.work_clone_path, clone);
      assert.ok(/Z$/.test(record.teardown_at), "teardown decision must carry a UTC timestamp");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILED case -> KEEP: clone retained and decision recorded (AC1, AC2, AC3)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-teardown-keep-"));
    const clone = path.join(dir, "clone");
    fs.mkdirSync(clone, { recursive: true });
    fs.writeFileSync(path.join(clone, "evidence.txt"), "failure state");
    try {
      for (const outcome of ["TEST_INFRA_FAIL", "INCONCLUSIVE", "PRODUCT_FAIL", "AGENT_FLAKE"]) {
        const res = runTt(teardownCli, ["--case-id", `W-F-${outcome}`, "--outcome", outcome, "--work-clone-path", clone]);
        assert.equal(res.status, 0, `teardown CLI failed: ${res.stderr}`);
        const record = JSON.parse(String(res.stdout ?? "")).record;
        assert.equal(record.action, "keep", `failed outcome ${outcome} must keep`);
        assert.equal(record.kept, true);
        assert.equal(record.pruned, false);
        assert.ok(fs.existsSync(clone), "failed-case clone must be retained as evidence");
        assert.equal(record.case_id, `W-F-${outcome}`);
        assert.equal(record.outcome, outcome);
        assert.ok(/Z$/.test(record.teardown_at));
        // Idempotency across re-runs: a kept clone stays kept.
        const second = runTt(teardownCli, ["--case-id", `W-F-${outcome}`, "--outcome", outcome, "--work-clone-path", clone]);
        assert.equal(JSON.parse(String(second.stdout ?? "")).record.action, "keep");
        assert.ok(fs.existsSync(clone), "kept clone must survive repeated teardown application");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing/absent clone is a safe no-op that still records the decision", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-teardown-none-"));
    const missing = path.join(dir, "does-not-exist");
    try {
      const res = runTt(teardownCli, ["--case-id", "W-NO", "--outcome", "PASS", "--work-clone-path", missing]);
      assert.equal(res.status, 0);
      const record = JSON.parse(String(res.stdout ?? "")).record;
      assert.equal(record.existed, false);
      assert.equal(record.pruned, false, "nothing on disk to prune");
      assert.equal(record.action, "prune", "declared action still recorded even when nothing exists");
      // Passing no path at all is legal (records a no-clone decision).
      const none = runTt(teardownCli, ["--case-id", "W-NONE", "--outcome", "PASS"]);
      assert.equal(none.status, 0);
      assert.equal(JSON.parse(String(none.stdout ?? "")).record.work_clone_path, null);
      assert.equal(JSON.parse(String(none.stdout ?? "")).record.existed, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caller-bug inputs fail closed (missing case id / outcome)", () => {
    const missingCase = runTt(teardownCli, ["--outcome", "PASS"]);
    assert.equal(missingCase.status, 2, "missing --case-id is a usage error");
    assert.equal(JSON.parse(String(missingCase.stdout ?? "")).usage_error, "--case-id and --outcome are required");
    const missingOutcome = runTt(teardownCli, ["--case-id", "W-T"]);
    assert.equal(missingOutcome.status, 2);
    assert.equal(JSON.parse(String(missingOutcome.stdout ?? "")).usage_error, "--case-id and --outcome are required");
  });

  it("CLI --help documents the policy", () => {
    const help = runTt(teardownCli, ["--help"]);
    assert.equal(help.status, 0);
    const text = help.stdout;
    assert.ok(text.includes("US-005"), "--help must reference the policy");
    assert.ok(text.includes("PASS") && text.includes("PRUNE"), "--help must state PASS -> PRUNE");
    assert.ok(text.includes("KEEP"), "--help must state the keep policy");
  });
});

describe("Controller teardown wiring (US-005)", () => {
  it("a PASSED real case prunes its clone after terminalization and records the decision in state.json + report", () => {
    ensureGolden();
    const record = baseRealRecord();
    const manifestPath = writeManifest(record);
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us005-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    const clonePath = path.join(workRoot, "W1.L1-python", "tt-python");
    fs.rmSync(clonePath, { recursive: true, force: true });

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const caseState = state.cases.find((c: any) => c.id === "W1.L1-python");
      assert.equal(caseState.outcome, "PASS");
      const td = caseState.teardown;
      assert.ok(td, "PASS case must record a teardown decision (AC2)");
      assert.equal(td.action, "prune", "PASS clone pruned (AC1)");
      assert.ok(td.existed);
      assert.ok(!fs.existsSync(clonePath), "PASS work clone must be pruned off disk");

      // The decision is surfaced in the campaign report (AC2/AC3).
      const report = loadJson(path.join(resultsRoot, campaignId, "report.json"));
      const row = report.rows.find((r: any) => r.id === "W1.L1-python");
      assert.equal(row.teardown.action, "prune");
      const ledger = report.teardown_decisions.filter((d: any) => d.case_id === "W1.L1-python");
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].action, "prune");
      assert.equal(ledger[0].outcome, "PASS");
      assert.ok(/Z$/.test(ledger[0].teardown_at), "decision timestamp recorded (AC3)");
      const txt = fs.readFileSync(path.join(resultsRoot, campaignId, "report.txt"), "utf8");
      assert.ok(txt.includes("RUN TEARDOWN (US-005)"), "report.txt must carry the RUN TEARDOWN section");
      assert.ok(txt.includes("W1.L1-python"), "report.txt must enumerate the case decision");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(outPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it("a FAILED real case KEEPS its provisioned clone as evidence and records the decision", () => {
    ensureGolden();
    const record = baseRealRecord();
    // Give the case a `reset` hook that fails. Provisioning runs BEFORE reset,
    // so the clone IS provisioned; the failing reset terminalizes the case
    // TEST_INFRA_FAIL with a provisioned clone that must be KEPT (evidence).
    const failScript = path.join(varRoot, `us005-fail-reset-${Date.now()}.cjs`);
    fs.writeFileSync(failScript, "process.exit(1);\n");
    const recordWithReset = {
      ...JSON.parse(JSON.stringify(record)),
      reset: { executable: path.relative(ttRoot, failScript), args: [], cwd: "." },
    };
    const manifestPath = writeManifest(recordWithReset);
    const rel = path.relative(ttRoot, manifestPath);
    const clonePath = path.join(workRoot, "W1.L1-python", "tt-python");
    fs.rmSync(clonePath, { recursive: true, force: true });

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel]);
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const caseState = state.cases.find((c: any) => c.id === "W1.L1-python");
      assert.equal(caseState.outcome, "TEST_INFRA_FAIL",
        "the failing reset must terminalize the case TEST_INFRA_FAIL");
      const td = caseState.teardown;
      assert.ok(td, "a provisioned FAILED case must record a teardown decision (AC2)");
      assert.equal(td.action, "keep", "FAILED clone kept as evidence (AC1)");
      assert.ok(td.kept && !td.pruned);
      assert.ok(fs.existsSync(clonePath), "FAILED work clone must be retained on disk (AC1)");
      assert.equal(td.case_id, "W1.L1-python");
      assert.equal(td.outcome, "TEST_INFRA_FAIL");
      assert.ok(/Z$/.test(td.teardown_at), "kept decision must carry a timestamp (AC3)");

      const report = loadJson(path.join(resultsRoot, campaignId, "report.json"));
      const row = report.rows.find((r: any) => r.id === "W1.L1-python");
      assert.equal(row.teardown.action, "keep");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(failScript, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it("cases that never provisioned a clone are untouched: no teardown record, no fs action", () => {
    // A real case excluded by --scripted-only becomes NOT_RUN (pending-real);
    // it never provisions a clone, so teardown must be a clean no-op (no
    // record, no kludge) for it.
    const pendingRecord = {
      ...JSON.parse(JSON.stringify(baseRealRecord())),
      id: "W-T-PENDING-REAL",
      context: { execution_mode: "real" },
    };
    const manifestPath = writeManifest(pendingRecord);
    const rel = path.relative(ttRoot, manifestPath);
    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel, "--scripted-only"]);
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);
      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const caseState = state.cases.find((c: any) => c.id === "W-T-PENDING-REAL");
      assert.equal(caseState.outcome, "NOT_RUN");
      assert.equal(caseState.teardown, undefined,
        "a case that never provisioned a clone must not record a teardown decision");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  });
});

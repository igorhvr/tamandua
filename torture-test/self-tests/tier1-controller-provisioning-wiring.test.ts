// Tier-1 integration gate (US-004): fixture work-clone provisioning is wired
// into the controller's real-case launch path as a mandatory stage.
//
// E2.3 root cause: `workflowRunArgs` passes
// var/fixtures/work/<case-id>/<fixture> as --worktree-origin-repository /
// --working-directory-for-harness, but NOTHING provisioned that clone, so the
// real-case launch died with scheduler-execution-failed / ENOENT lstat. US-004
// wires `provisionWorkClone` into `executeWorkflowCase` as a mandatory
// fail-closed stage BEFORE the launch (and before the dry-run argv capture),
// so the path the harness is handed always exists, attempt N+1 is a clean
// re-provision, and a provision failure persists TEST_INFRA_FAIL with a precise
// category.
//
// This gate is ZERO-TOKEN: it drives the real-launch path through the
// controller's test-only TT_DRY_RUN_REAL_LAUNCH hook (no model spawned), and
// uses the ready golden under var/fixtures/golden (rebuilt on demand by
// ensureGoldenBare if absent). Files only inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { provisionWorkClone } from "../bin/tt-fixture-provision.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
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

// Ensure the tt-python golden is present so provisioning does not spend time or
// fail (ensureGoldenBare rebuilds a missing golden deterministically).
function ensureGolden(): void {
  const bare = path.join(goldenDir, "tt-python.git");
  if (fs.existsSync(bare)) return;
  const res = spawnSync(process.execPath, [path.join(binDir, "tt-golden-bootstrap.mjs"), "--fixture", "tt-python"], {
    cwd: ttRoot, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(res.status, 0, `golden bootstrap failed:\n${res.stderr}`);
}

// Build a one-case manifest under var/ carrying the real W1.L1-python record.
function writeManifest(record: any): string {
  const name = `US004-${Date.now()}-${process.pid}.jsonl`;
  const manifestPath = path.join(varRoot, name);
  fs.writeFileSync(manifestPath, `${JSON.stringify(record)}\n`);
  return manifestPath;
}

describe("Controller fixture work-clone provisioning wiring (US-004)", () => {
  it("real case provisions the work clone before dry-run argv capture; argv path matches the clone exactly", () => {
    ensureGolden();
    const tier1 = loadJsonLines(path.join(ttRoot, "cases", "tier1.jsonl"));
    const record = tier1.find((c: any) => c.id === "W1.L1-python");
    assert.ok(record, "tier1.jsonl must contain W1.L1-python");
    const manifestPath = writeManifest(record);
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us004-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    const clonePath = path.join(workRoot, "W1.L1-python", "tt-python");
    fs.rmSync(clonePath, { recursive: true, force: true });

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);

      // AC1: provisioning ran BEFORE the dry-run argv capture — proven here by
      // (a) the dry-run PASS is only reachable after provisioning succeeded
      // (a provision failure short-circuits to TEST_INFRA_FAIL, never PASS),
      // and (b) the recorded per-case teardown decision (US-005) — a PASS
      // prunes the provisioned clone after terminalization — carries
      // existed:true, i.e. the provisioned clone physically existed at
      // terminal time. Note the clone may no longer exist on disk now: US-005
      // declared policy prunes a harvested PASS clone, so inspect the record
      // rather than lstat the (now gone) working tree.
      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const caseState = state.cases.find((c: any) => c.id === "W1.L1-python");
      assert.equal(caseState.outcome, "PASS", "dry-run real case must PASS");
      const dry = caseState.attempts.find((a: any) => a.dry_run_launch === true);
      assert.ok(dry, "attempt must carry dry_run_launch");
      assert.equal(dry.fixture_work_clone, clonePath, "attempt records the provisioned clone path");
      assert.ok(dry.fixture_provision_record, "attempt must record the fixture_provision_record");
      assert.equal(dry.fixture_provision_record.fixture, "tt-python");
      assert.equal(dry.fixture_provision_record.case_id, "W1.L1-python");
      // US-005: a PASS case's clone is pruned after terminalization, and the
      // decision is recorded on the case and persisted to results/state.json.
      const teardown = caseState.teardown;
      assert.ok(teardown, "a provisioned PASS case must record a teardown decision");
      assert.equal(teardown.case_id, "W1.L1-python");
      assert.equal(teardown.outcome, "PASS");
      assert.equal(teardown.action, "prune", "declared policy prunes a harvested PASS clone");
      assert.ok(teardown.existed, "the provisioned clone physically existed at terminalization");
      assert.ok(!fs.existsSync(clonePath), "the harvested PASS clone must be pruned off disk");
      assert.ok(!teardown.kept && teardown.pruned, "PASS clone must be recorded pruned, not kept");

      // AC4: the fixture path in the recorded launch argv is EXACTLY the
      // provisioned clone path (never a derived-but-unprovisioned lookup).
      const lines = fs.readFileSync(outPath, "utf8")
        .split(/\r?\n/).filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      const rec = lines.find((r) => r.case_id === "W1.L1-python");
      assert.ok(rec, "argv record for W1.L1-python must exist");
      const wdIdx = rec.argv.indexOf("--working-directory-for-harness");
      assert.ok(wdIdx >= 0, "do-now case argv must use --working-directory-for-harness");
      const argvPath = rec.argv[wdIdx + 1];
      // The clone is pruned after a PASS (US-005), so compare normalized
      // absolute paths rather than realpath (which requires existence).
      const norm = (p: string) => path.normalize(path.resolve(p));
      assert.equal(norm(argvPath), norm(clonePath),
        "argv fixture path must equal the provisioned clone path exactly");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(outPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it("a provision failure is fail-closed: the case persists TEST_INFRA_FAIL with a precise category before launch", () => {
    ensureGolden();
    const tier1 = loadJsonLines(path.join(ttRoot, "cases", "tier1.jsonl"));
    const base = tier1.find((c: any) => c.id === "W1.L1-python");
    assert.ok(base, "tier1.jsonl must contain W1.L1-python");
    // A real case whose fixture is unknown to FIXTURE_META triggers the
    // provisioning adapter's 'unknown-fixture' fail-closed reason. Because the
    // provisioning stage runs BEFORE the dry-run hook (and before launch), the
    // case must be marked TEST_INFRA_FAIL — never a silent dry-run PASS.
    const record = JSON.parse(JSON.stringify(base));
    record.id = "W-TEST-unknown-fixture";
    record.fixture = "no-such-fixture";
    const manifestPath = writeManifest(record);
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us004-fail-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);
      // A failed mandatory case legitimately makes the campaign exit non-zero;
      // what matters is the case outcome + precise reason, asserted below.

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const caseState = state.cases.find((c: any) => c.id === "W-TEST-unknown-fixture");
      assert.ok(caseState, "case must be present in state");
      assert.equal(caseState.outcome, "TEST_INFRA_FAIL",
        "a provision failure must produce TEST_INFRA_FAIL, not PASS (fail-closed)");
      const attempt = caseState.attempts.at(-1);
      assert.ok(attempt, "case must record an attempt");
      const reason = attempt.classification_reason ?? attempt.reason;
      assert.equal(reason?.category, "unknown-fixture",
        "provision failure must carry the precise adapter category");
      // The dry-run hook was NOT reached, so no launch argv was recorded.
      assert.ok(!attempt.dry_run_launch, "provision failure short-circuits before the dry-run launch");
      assert.equal(attempt.fixture_provision_record, undefined,
        "a failed provision records no successful provision record (fail-closed)");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(outPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  });

  it("US-011: hostile-path W1.X1 provisions at the controller-computed path (branch main, operator notes planted)", () => {
    // S14 proof, provisioning half: the alias clone must land at EXACTLY the
    // path the controller's workflowRunArgs hands to the harness —
    // var/fixtures/work/<case-id>/<fixture> with the authored name verbatim.
    // The provisioner's DEFAULT_WORK_DIR is var/fixtures/work, so calling
    // provisionWorkClone with no workDir override provisions under var/ —
    // the same call shape the controller's mandatory stage makes.
    const controllerPath = path.join(workRoot, "W1.X1-ts", "tt-ts café");
    const provision = provisionWorkClone({ fixture: "tt-ts café", caseId: "W1.X1-ts" });
    try {
      assert.ok(provision.ok, `alias provisioning must succeed:\n${JSON.stringify(provision)}`);
      assert.equal(provision.workClonePath, controllerPath,
        "provisioned clone path must equal the controller-computed path exactly");
      assert.ok(provision.workClonePath.includes(" "), "work clone path must contain U+0020 (space)");
      assert.ok(
        [...provision.workClonePath].some((ch) => ch.charCodeAt(0) > 127),
        "work clone path must contain a non-ASCII character",
      );
      assert.equal(provision.canonicalFixture, "tt-ts", "golden resolution must use the canonical fixture");
      assert.equal(provision.target.kind, "baseline", "W1.X1 is unseeded: baseline checkout");
      assert.equal(provision.target.finalBranch, "main", "tt-ts baseline clone must land on branch main");
      assert.equal(provision.operatorNotesPlanted, true, "operator notes must be planted by the canonical arm");
      assert.ok(fs.existsSync(path.join(provision.workClonePath, "operator-notes.local")),
        "planted operator-notes.local must exist inside the hostile-path clone");
      const branch = spawnSync("git", ["-C", provision.workClonePath, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8" });
      assert.equal(String(branch.stdout ?? "").trim(), "main", "clone HEAD branch must be main");
    } finally {
      fs.rmSync(controllerPath, { recursive: true, force: true });
    }
  });

  it("US-011: the controller's real-case launch path hands the hostile path to the harness argv verbatim", () => {
    // S14 proof, launch-argv half (in-band controller agreement): a one-case
    // dry-run campaign for W1.X1-ts must provision the alias clone through the
    // controller's mandatory stage and record --working-directory-for-harness
    // exactly at the hostile path, with work_clone.existed:true at capture
    // time (the US-007 lstat evidence). The PASS teardown prunes the clone
    // afterwards, so the evidence lives in the records, not on disk.
    ensureGolden();
    const tier1 = loadJsonLines(path.join(ttRoot, "cases", "tier1.jsonl"));
    const record = tier1.find((c: any) => c.id === "W1.X1-ts");
    assert.ok(record, "tier1.jsonl must contain W1.X1-ts");
    const manifestPath = writeManifest(record);
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us011-w1x1-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    const clonePath = path.join(workRoot, "W1.X1-ts", "tt-ts café");
    fs.rmSync(clonePath, { recursive: true, force: true });

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const caseState = state.cases.find((c: any) => c.id === "W1.X1-ts");
      assert.equal(caseState.outcome, "PASS", "dry-run real case must PASS");
      const dry = caseState.attempts.find((a: any) => a.dry_run_launch === true);
      assert.ok(dry, "attempt must carry dry_run_launch");
      assert.equal(dry.fixture_work_clone, clonePath, "attempt records the hostile provisioned clone path");
      assert.equal(dry.fixture_provision_record.fixture, "tt-ts café",
        "provision record must carry the authored hostile fixture name");
      assert.equal(dry.fixture_provision_record.work_clone_path, clonePath,
        "provision record must carry the hostile work clone path");

      const lines = fs.readFileSync(outPath, "utf8")
        .split(/\r?\n/).filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      const rec = lines.find((r) => r.case_id === "W1.X1-ts");
      assert.ok(rec, "argv record for W1.X1-ts must exist");
      assert.equal(rec.fixture, "tt-ts café", "argv record must carry the authored hostile fixture name");
      const wdIdx = rec.argv.indexOf("--working-directory-for-harness");
      assert.ok(wdIdx >= 0, "do-now case argv must use --working-directory-for-harness");
      const argvPath = rec.argv[wdIdx + 1];
      const norm = (p: string) => path.normalize(path.resolve(p));
      assert.equal(norm(argvPath), norm(clonePath),
        "argv fixture path must equal the provisioned hostile clone path exactly");
      assert.ok(rec.work_clone, "argv record must embed work_clone evidence");
      assert.equal(rec.work_clone.path, clonePath, "work_clone.path must be the hostile clone path");
      assert.ok(rec.work_clone.path.includes(" "), "work_clone.path must contain U+0020 (space)");
      assert.ok(
        [...rec.work_clone.path].some((ch) => ch.charCodeAt(0) > 127),
        "work_clone.path must contain a non-ASCII character",
      );
      assert.equal(rec.work_clone.existed, true, "the hostile clone must exist at argv-capture time");
      assert.equal(rec.work_clone.is_directory, true, "work_clone must be a directory");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(outPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it("per-attempt re-provision is clean: the adapter (as wired) never inherits a dirtied clone", () => {
    ensureGolden();
    const provisionCli = path.join(binDir, "tt-fixture-provision.mjs");
    const provision = (): any => {
      const res = spawnSync(process.execPath, [
        provisionCli, "--fixture", "tt-python", "--case-id", "W-TEST-reprovision", "--json",
      ], { cwd: ttRoot, encoding: "utf8", timeout: 120_000 });
      assert.equal(res.status, 0, `provision CLI failed:\n${res.stderr}\n${res.stdout}`);
      return JSON.parse(String(res.stdout ?? ""));
    };
    const clonePath = path.join(workRoot, "W-TEST-reprovision", "tt-python");
    fs.rmSync(clonePath, { recursive: true, force: true });
    try {
      const first = provision();
      assert.equal(first.ok, true, `first provision failed: ${JSON.stringify(first)}`);
      // Dirty the clone the way an interrupted attempt N would: a stray file
      // and a tampered tracked file.
      fs.writeFileSync(path.join(clonePath, "dirty-stray.txt"), "interrupted attempt N\n");
      fs.writeFileSync(path.join(clonePath, "README.md"), "tampered by attempt N\n");

      // The controller calls the same adapter on attempt N+1; it wipes the
      // previous clone first, so we must get a clean tree back.
      const second = provision();
      assert.equal(second.ok, true, `re-provision failed: ${JSON.stringify(second)}`);
      assert.ok(!fs.existsSync(path.join(clonePath, "dirty-stray.txt")),
        "re-provision must wipe the prior attempt's stray file");
      const headOk = spawnSync("git", ["-C", clonePath, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" });
      assert.equal(headOk.status, 0, "re-provisioned clone must be a valid git working tree");
      // Re-provision must not leave the previous attempt's dirt behind. The
      // ONLY untracked entries allowed are tt-python's intentional arming junk
      // (planted operator-notes.local + regenerated .pytest_cache/__pycache__);
      // there must be NO modified-tracked files and no stray files.
      const st = spawnSync("git", ["-C", clonePath, "status", "--porcelain"], { encoding: "utf8" });
      const entries = String(st.stdout ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
      assert.ok(entries.length > 0, "re-provisioned tt-python clone must carry its planned arming junk");
      for (const e of entries) {
        if (e.startsWith("?? ")) {
          const p = e.slice(3);
          assert.ok(
            p === "operator-notes.local"
              || p.includes("__pycache__")
              || p.includes(".pytest_cache"),
            `unexpected residual untracked entry after re-provision: ${e}`,
          );
        } else {
          assert.ok(false, `modified-tracked file survived re-provision (not a clean tree): ${e}`);
        }
        assert.ok(!e.includes("dirty-stray"), `stray file survived re-provision: ${e}`);
      }
    } finally {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });
});

function loadJsonLines(file: string): any[] {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

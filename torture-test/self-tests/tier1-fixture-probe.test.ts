// Tier-1 integration gate (US-007): zero-token scripted/probe coverage that
// the real-case launch proves the work clone physically exists at
// argv-capture time.
//
// E2.3 lesson: the original argv-recording stub only validated argv — a stub
// never lstats the path, so it could not surface the ENOENT lstat every real
// launch hit. US-007 extends the TT_DRY_RUN_REAL_LAUNCH hook so, for a real
// case, the mandatory provisioning stage runs BEFORE the launch argv is
// recorded AND the recorded argv record embeds the lstat evidence that the
// provisioned work clone physically existed at capture time (work_clone:
// { path, existed, is_directory, size, lstat_error }). This test asserts that
// proof end-to-end through the real controller: no model is spawned (the
// dry-run hook short-circuits before launch), so this gate is ZERO-TOKEN.
// Files only inside torture-test/.
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

// Ensure the tt-python golden is present so provisioning does not fail/hang
// (ensureGoldenBare rebuilds a missing golden deterministically).
function ensureGolden(): void {
  const bare = path.join(goldenDir, "tt-python.git");
  if (fs.existsSync(bare)) return;
  const res = spawnSync(process.execPath, [path.join(binDir, "tt-golden-bootstrap.mjs"), "--fixture", "tt-python"], {
    cwd: ttRoot, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(res.status, 0, `golden bootstrap failed:\n${res.stderr}`);
}

describe("Real-launch argv-capture clone-existence proof (US-007)", () => {
  it("dry-run real-launch hook provisions the clone BEFORE argv capture and the record proves it existed", () => {
    ensureGolden();
    const tier1 = loadJsonLines(path.join(ttRoot, "cases", "tier1.jsonl"));
    const record = tier1.find((c: any) => c.id === "W1.L1-python");
    assert.ok(record, "tier1.jsonl must contain W1.L1-python");
    const manifestPath = path.join(varRoot, `US007-${Date.now()}-${process.pid}.jsonl`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(record)}\n`);
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us007-argv-${Date.now()}-${process.pid}.jsonl`);
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
      assert.equal(caseState.outcome, "PASS", "dry-run real case must PASS");
      const attempt = caseState.attempts.find((a: any) => a.dry_run_launch === true);
      assert.ok(attempt, "attempt must carry dry_run_launch");
      assert.equal(attempt.fixture_work_clone, clonePath,
        "controller must record the provisioned clone path on the attempt");

      // The argv record recorded at capture time embeds the work-clone
      // existence proof (E2.3 fix): the clone physically existed, was a
      // directory, and lstat succeeded — recorded BEFORE the PASS-case clone
      // is pruned by the teardown policy, so it is assertable off the record
      // even though the clone may now be gone from disk.
      const lines = fs.readFileSync(outPath, "utf8")
        .split(/\r?\n/).filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      const rec = lines.find((r) => r.case_id === "W1.L1-python");
      assert.ok(rec, "argv record for W1.L1-python must exist");
      // AC2: the record proves the clone existed at argv-capture time.
      assert.ok(rec.work_clone, "argv record must carry work_clone existence proof");
      const norm = (p: string) => path.normalize(path.resolve(p));
      assert.equal(norm(rec.work_clone.path), norm(clonePath),
        "recorded work_clone.path must equal the provisioned clone path");
      assert.equal(rec.work_clone.existed, true,
        "the provisioned work clone MUST have existed at argv-capture time (E2.3 ENOENT closed)");
      assert.equal(rec.work_clone.is_directory, true, "the provisioned clone must be a directory");
      assert.equal(rec.work_clone.lstat_error, null, "lstat of the provisioned clone must succeed at capture time");

      // AC1: the argv fixture path is EXACTLY the provisioned clone path.
      const wdIdx = rec.argv.indexOf("--working-directory-for-harness");
      assert.ok(wdIdx >= 0, "do-now case argv must use --working-directory-for-harness");
      assert.equal(norm(rec.argv[wdIdx + 1]), norm(clonePath),
        "argv fixture path must equal the provisioned clone path exactly");

      // The teardown policy (US-005) prunes a harvested PASS clone; the
      // existence proof above was captured before prune, so the clone being
      // gone now is expected and consistent with the record.
      if (!fs.existsSync(clonePath)) {
        assert.equal(caseState.teardown?.action, "prune",
          "a PASS case clone is pruned per declared policy");
      }
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(outPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  });
});

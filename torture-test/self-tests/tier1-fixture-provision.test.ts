// US-003 — Fixture work-clone provisioning adapter (clone, seed/baseline
// checkout on named branch, arming).
//
// The controller's real-case launch path passes
// `var/fixtures/work/<case-id>/<fixture>` to workflowRunArgs as the harness
// origin, but NOTHING provisioned that clone (the E2.3 gap — the first genuine
// real launch went terminal TEST_INFRA_FAIL with ENOENT). This test pins the
// standalone provisioning adapter (`bin/tt-fixture-provision.mjs`):
//
//   * AC1: work-clone provisioning creates a clean clone at
//          <work-dir>/<case-id>/<fixture> from the golden bare.
//   * AC2: a seed-ref checkout lands on a NON-DETACHED named current branch at
//          the exact seed commit.
//   * AC3: a baseline (no seed) case lands on a named branch at the green base,
//          never detached HEAD.
//   * AC4: junk invariants hold for the tt-python do-now path: the venv is
//          pre-bootstrapped; operator-notes.local is present + untracked +
//          byte-identical to the fixture source; regenerated junk
//          (__pycache__/, .pytest_cache/) is present + untracked.
//   * Per-attempt re-provision is CLEAN: a dirtied clone is wiped and
//     re-provisioned fresh (the adapter never inherits a previous dirty tree).
//   * fail-closed: an unknown fixture / unknown seed yields a precise
//     TEST_INFRA reason; usage errors are exit code 2.
//
// Zero tokens. Writes only to temp dirs under os.tmpdir() (golden + work). No
// tamandua-side side effects. Files only inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const provision = path.join(ttRoot, "bin", "tt-fixture-provision.mjs");
const bootstrap = path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
};

// ── CLI helpers ─────────────────────────────────────────────────────────
function runProvision(args: string[]) {
  return spawnSync(process.execPath, [provision, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}
function parseVerdict(args: string[]) {
  const res = runProvision(args);
  let json: any = null;
  try {
    json = JSON.parse((res.stdout ?? "").trim());
  } catch {
    /* keep null */
  }
  return { status: res.status, stdout: (res.stdout ?? "").trim(), json, stderr: (res.stderr ?? "").trim() };
}

// Run git inside a work clone.
function gitIn(clonePath: string, args: string[]) {
  return spawnSync("git", args, { cwd: clonePath, encoding: "utf8" });
}

// ── Shared golden (built once, hermetic) ────────────────────────────────
let goldenDir: string;
let workDir: string;
let baselineHash: string;
let seedB1Commit: string;

before(function () {
  goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-provision-golden-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-provision-work-"));
  const res = spawnSync(process.execPath, [bootstrap, "--fixture", "tt-python", "--golden-dir", goldenDir], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(res.status, 0, `golden bootstrap must build tt-python:\n${res.stdout}`);
  const ledger = fs.readFileSync(path.join(goldenDir, "tt-python.git.hashes"), "utf8");
  baselineHash = /^BASELINE\s+([0-9a-f]{40})$/m.exec(ledger)?.[1] ?? "";
  seedB1Commit = /^SEED\s+BUG-P1\s+([0-9a-f]{40})$/m.exec(ledger)?.[1] ?? "";
  assert.match(baselineHash, /^[0-9a-f]{40}$/, "golden ledger must record a baseline hash");
  assert.match(seedB1Commit, /^[0-9a-f]{40}$/, "golden ledger must record a BUG-P1 seed commit");
});

after(() => {
  fs.rmSync(goldenDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

function assertUntracked(clonePath: string, rel: string, label: string) {
  const ls = gitIn(clonePath, ["ls-files", "--error-unmatch", rel]);
  assert.notEqual(ls.status, 0, `${label}: ${rel} must be untracked (not in the index)`);
}
function assertNotDetached(clonePath: string) {
  const head = gitIn(clonePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(head.status, 0, "must resolve HEAD");
  assert.notEqual(head.stdout.trim(), "HEAD", "HEAD must NOT be detached");
  return head.stdout.trim();
}

describe("Fixture work-clone provisioning (US-003)", () => {
  it("AC1+AC2+AC4 (do-now seed, prebootstrapped): clean clone at <case-id>/<fixture> on a non-detached named seed branch with bootstrapped venv, inert operator-junk, and regenerated junk present + untracked", function () {
    this.timeout = 240_000;
    const CASE = "W1.L1-python";
    const { status, json } = parseVerdict([
      "--fixture", "tt-python",
      "--case-id", CASE,
      "--seed", "BUG-P1",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(status, 0, `seed provision must succeed:\n${JSON.stringify(json)}`);
    assert.ok(json.ok, "verdict must be ok");
    // AC1: work clone lands at <work-dir>/<case-id>/<fixture>.
    const expected = path.join(workDir, CASE, "tt-python");
    assert.equal(json.workClonePath, expected, "work clone path must match the contract path");
    for (const p of [expected, path.join(expected, ".git")]) {
      assert.ok(fs.existsSync(p), `work clone must exist: ${p}`);
    }
    // AC2: seed checkout lands on a NON-DETACHED named branch at the seed commit.
    const branch = assertNotDetached(expected);
    assert.equal(branch, "seed-BUG-P1", "must land on the seed named branch (seed-BUG-P1)");
    const head = gitIn(expected, ["rev-parse", "HEAD"]);
    assert.equal(head.stdout.trim(), seedB1Commit, "HEAD must be at the recorded seed commit");
    // AC4: venv pre-bootstrapped for do-now.
    assert.ok(fs.existsSync(path.join(expected, ".venv", "bin", "python")), ".venv must be bootstrapped");
    assert.equal(json.venvBootstrapped, true);
    // AC4: inert operator junk — present, untracked, byte-identical to fixture source.
    const srcNotes = fs.readFileSync(path.join(ttRoot, "fixtures-src", "tt-python", "operator-notes.local"));
    const dstNotes = fs.readFileSync(path.join(expected, "operator-notes.local"));
    assert.ok(dstNotes.equals(srcNotes), "operator-notes.local must be byte-identical to the fixture source");
    assertUntracked(expected, "operator-notes.local", "AC4");
    // AC4: regenerated junk present + untracked.
    for (const junk of [".pytest_cache", "__pycache__"]) {
      assert.ok(fs.existsSync(path.join(expected, junk)), `regenerated junk ${junk} must exist`);
      assertUntracked(expected, junk, "AC4");
    }
    assert.equal(json.operatorNotesPlanted, true);
    assert.equal(json.junkVerified, true);
  });

  it("AC3 (baseline, no seed): lands on a non-detached named branch at the green base", function () {
    this.timeout = 60_000;
    const CASE = "baseline-case";
    const { status, json } = parseVerdict([
      "--fixture", "tt-python",
      "--case-id", CASE,
      "--arming", "raw",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(status, 0, `baseline provision must succeed:\n${JSON.stringify(json)}`);
    assert.ok(json.ok);
    const expected = path.join(workDir, CASE, "tt-python");
    assert.equal(json.workClonePath, expected);
    // AC3: baseline lands on the fixture's real current branch, not detached.
    const branch = assertNotDetached(expected);
    assert.equal(branch, "main", "baseline case must land on the main branch");
    const head = gitIn(expected, ["rev-parse", "HEAD"]);
    assert.equal(head.stdout.trim(), baselineHash, "HEAD must be at the recorded green baseline");
    // Inert operator junk is still planted + untracked.
    const srcNotes = fs.readFileSync(path.join(ttRoot, "fixtures-src", "tt-python", "operator-notes.local"));
    assert.ok(fs.readFileSync(path.join(expected, "operator-notes.local")).equals(srcNotes), "operator-notes byte-identical");
    assertUntracked(expected, "operator-notes.local", "AC3");
  });

  it("per-attempt re-provision is clean: a dirtied clone is wiped and re-provisioned fresh", function () {
    this.timeout = 60_000;
    const CASE = "reprovision-case";
    const args = [
      "--fixture", "tt-python",
      "--case-id", CASE,
      "--arming", "raw",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ];
    const first = parseVerdict(args);
    assert.equal(first.status, 0, `first provision must succeed:\n${JSON.stringify(first.json)}`);
    const expected = path.join(workDir, CASE, "tt-python");

    // Dirty the clone: stray tracked file + modified tracked content.
    fs.writeFileSync(path.join(expected, "stray-marker.txt"), "should disappear on re-provision\n");
    fs.writeFileSync(path.join(expected, "README.md"), "tampered content\n");
    assert.ok(fs.existsSync(path.join(expected, "stray-marker.txt")), "precondition: tree is dirty");

    // Re-provision the SAME case: the adapter wipes and reclones fresh.
    const second = parseVerdict(args);
    assert.equal(second.status, 0, `re-provision must succeed:\n${JSON.stringify(second.json)}`);
    assert.ok(!fs.existsSync(path.join(expected, "stray-marker.txt")), "stray file must be gone after clean re-provision");
    // Tracked content restored from golden: the file no longer matches the
    // tampered content injected before the re-provision.
    const readme = fs.readFileSync(path.join(expected, "README.md"), "utf8");
    assert.notEqual(readme, "tampered content\n", "tracked content must be restored from the golden");
    assert.match(readme, /schedlib/, "restored README has golden content");
    const dirty = gitIn(expected, ["status", "--porcelain"]);
    assert.equal(dirty.status, 0);
    // The ONLY untracked entry may be the intentionally-planted inert operator
    // junk (AC4); the stray marker and tampered README must be gone, and no
    // other drift may remain.
    const lines = dirty.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
    assert.deepEqual(lines, ["?? operator-notes.local"], "re-provisioned clone must be clean except planned operator junk");
    // Still on a named branch (never detached), i.e. the same case id did not
    // accumulate a previous attempt's branch state.
    const branch = assertNotDetached(expected);
    assert.equal(branch, "main");
  });

  it("fail-closed: an unknown fixture yields unknown-fixture before touching the work dir", function () {
    const { status, json } = parseVerdict([
      "--fixture", "tt-nope",
      "--case-id", "whatever",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.notEqual(status, 0, "unknown fixture must fail-closed");
    assert.equal(json.reason.category, "unknown-fixture");
    assert.ok(Array.isArray(json.reason.known));
  });

  it("fail-closed: an unknown seed yields seed-unknown with the golden reported", function () {
    const { status, json } = parseVerdict([
      "--fixture", "tt-python",
      "--case-id", "badseed",
      "--seed", "NOT-A-SEED",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.notEqual(status, 0, "unknown seed must fail-closed");
    assert.equal(json.reason.category, "seed-unknown");
    assert.match(json.reason.message, /NOT-A-SEED/);
    assert.equal(json.reason.fixture, "tt-python");
  });

  it("usage: --help exits 0 and documents --fixture / --case-id / --seed", () => {
    const res = runProvision(["--help"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /--fixture/);
    assert.match(res.stdout, /--case-id/);
    assert.match(res.stdout, /--seed/);
  });

  it("usage: missing --case-id is a usage error (exit 2)", () => {
    const { status, json } = parseVerdict(["--fixture", "tt-python"]);
    assert.equal(status, 2, "missing --case-id must be a usage error");
    assert.match(json.usage_error, /--case-id/);
  });
});

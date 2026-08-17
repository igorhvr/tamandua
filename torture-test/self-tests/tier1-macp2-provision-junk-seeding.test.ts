// MACP2 US-002 — provisioning seeds the deterministic synthetic __pycache__
// junk for tt-python AND tt-python@master.
//
// The python __pycache__ junk is a DETERMINISTIC PROVISIONING ARTIFACT, not an
// interpreter side effect (Apple's Python bakes in sys.pycache_prefix and
// ALWAYS redirects bytecode caches out-of-tree on Darwin, so in-tree
// __pycache__ can never be relied on). US-001 moved the tt-python /
// tt-python@master BUILDERS to seed the byte-exact fixtures-src reference
// (fixtures-src/tt-python/__pycache__/junk-probe.synthetic) into their scratch
// clones; US-002 does the same for PROVISIONING:
// bin/tt-fixture-provision.mjs armTtPython now plants
// __pycache__/junk-probe.synthetic from the fixtures-src reference in BOTH
// arming modes (prebootstrapped + raw), and tt-python@master routes to the
// tt-python arm with the shared tt-python reference fallback (it has no source
// copy of its own).
//
//   * AC1: tt-python raw provisioning seeds the marker present + untracked +
//          byte-identical to the fixtures-src reference (raw has no venv, so
//          probe presence must never depend on the interpreter).
//   * AC2: tt-python@master (raw AND prebootstrapped) seeds the same synthetic
//          junk via the shared tt-python reference fallback; prebootstrapped
//          also carries .pytest_cache present + untracked.
//   * AC3: fail-closed byte-identity oracle (verifySyntheticPycacheJunk): a
//          MODIFIED marker yields fixture-junk-modified; a deleted marker
//          yields fixture-junk-absent; a tracked marker yields
//          fixture-junk-tracked; a missing fixtures-src reference yields
//          fixture-junk-absent.
//   * AC4: a golden whose baseline TRACKS the seeded marker makes provisioning
//          fail closed with fixture-junk-tracked (the untrackedness oracle is
//          intact at provisioning time, not just in the verify helper).
//
// Zero tokens. Writes only to temp dirs under os.tmpdir(). Files only inside
// torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { verifySyntheticPycacheJunk } from "../bin/tt-fixture-provision.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const provisionCli = path.join(ttRoot, "bin", "tt-fixture-provision.mjs");
const bootstrapCli = path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs");

// The shared byte-exact provisioning reference: tt-python@master has no source
// copy of its own and falls back to the shared tt-python reference — exactly
// like plantOperatorNotes.
function referenceFor(_fixture: string): string {
  return path.join(ttRoot, "fixtures-src", "tt-python", "__pycache__", "junk-probe.synthetic");
}

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
};

function runNode(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}
function parseVerdict(script: string, args: string[]) {
  const res = runNode(script, args);
  let json: any = null;
  try {
    json = JSON.parse((res.stdout ?? "").trim());
  } catch {
    /* keep null */
  }
  return { status: res.status, stdout: (res.stdout ?? "").trim(), json, stderr: (res.stderr ?? "").trim() };
}
function gitIn(clonePath: string, args: string[]) {
  return spawnSync("git", args, { cwd: clonePath, encoding: "utf8" });
}
function assertUntracked(clonePath: string, rel: string, label: string) {
  const ls = gitIn(clonePath, ["ls-files", "--error-unmatch", rel]);
  assert.notEqual(ls.status, 0, `${label}: ${rel} must be untracked (not in the index)`);
}
function assertSeededJunk(clonePath: string, label: string) {
  // present
  const marker = path.join(clonePath, "__pycache__", "junk-probe.synthetic");
  assert.ok(fs.existsSync(marker), `${label}: seeded junk-probe.synthetic must exist`);
  // byte-identical to the shared tt-python reference
  const srcJunk = fs.readFileSync(referenceFor("tt-python"));
  assert.ok(
    fs.readFileSync(marker).equals(srcJunk),
    `${label}: seeded junk-probe.synthetic must be byte-identical to the fixtures-src reference`,
  );
  // untracked
  assertUntracked(clonePath, "__pycache__/junk-probe.synthetic", label);
}

// Shared hermetic golden + work dirs (tt-python + tt-python@master).
let goldenDir: string;
let workDir: string;

before(function () {
  goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-macp2-provision-golden-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-macp2-provision-work-"));
  for (const fixture of ["tt-python", "tt-python@master"]) {
    const res = runNode(bootstrapCli, ["--fixture", fixture, "--golden-dir", goldenDir]);
    assert.equal(res.status, 0, `golden bootstrap must build ${fixture}:\n${res.stdout}\n${res.stderr}`);
  }
});

after(() => {
  fs.rmSync(goldenDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("MACP2 US-002: provisioning seeds deterministic synthetic __pycache__ junk", () => {
  it("AC1: tt-python RAW provisioning seeds the marker present + untracked + byte-identical (no venv, no interpreter dependence)", function () {
    this.timeout = 120_000;
    const caseId = "macp2-tt-python-raw";
    const { status, json } = parseVerdict(provisionCli, [
      "--fixture", "tt-python",
      "--case-id", caseId,
      "--arming", "raw",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(status, 0, `tt-python raw provision must succeed:\n${JSON.stringify(json)}`);
    assert.ok(json?.ok, "verdict must be ok");
    const clone = path.join(workDir, caseId, "tt-python");
    assertSeededJunk(clone, "AC1");
    // raw mode has no venv, so no .pytest_cache is required — but the seeded
    // junk IS verified (junkVerified true, not the old deferred false).
    assert.equal(json.junkVerified, true, "raw arming must verify the seeded junk");
    assert.ok(!fs.existsSync(path.join(clone, ".venv")), "raw arming must not create a venv");
  });

  it("AC2a: tt-python@master RAW provisioning seeds the same synthetic junk via the shared tt-python reference fallback", function () {
    this.timeout = 120_000;
    const caseId = "macp2-master-raw";
    const { status, json } = parseVerdict(provisionCli, [
      "--fixture", "tt-python@master",
      "--case-id", caseId,
      "--arming", "raw",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(status, 0, `tt-python@master raw provision must succeed:\n${JSON.stringify(json)}`);
    assert.ok(json?.ok, "verdict must be ok");
    const clone = path.join(workDir, caseId, "tt-python@master");
    assertSeededJunk(clone, "AC2a");
    assert.equal(json.junkVerified, true, "tt-python@master raw must verify the seeded junk");
  });

  it("AC2b: tt-python@master PREBOOTSTRAPPED provisioning seeds the junk via the fallback AND regenerates .pytest_cache", function () {
    this.timeout = 240_000;
    const caseId = "macp2-master-preboot";
    const { status, json } = parseVerdict(provisionCli, [
      "--fixture", "tt-python@master",
      "--case-id", caseId,
      "--arming", "prebootstrapped",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(status, 0, `tt-python@master prebootstrapped provision must succeed:\n${JSON.stringify(json)}`);
    assert.ok(json?.ok, "verdict must be ok");
    assert.equal(json.venvBootstrapped, true, "prebootstrapped arming must create the venv");
    assert.equal(json.junkVerified, true);
    const clone = path.join(workDir, caseId, "tt-python@master");
    assertSeededJunk(clone, "AC2b");
    // .pytest_cache regenerated by the pytest cycle: present + untracked.
    assert.ok(fs.existsSync(path.join(clone, ".pytest_cache")), "prebootstrapped arming must regenerate .pytest_cache");
    assertUntracked(clone, ".pytest_cache", "AC2b");
  });

  it("AC3: fail-closed byte-identity oracle — modify/delete/track the seeded marker, and drop the reference", function () {
    this.timeout = 240_000;
    // Provision a fresh tt-python raw clone once; mutate it per sub-case.
    const caseId = "macp2-oracle";
    const provision = parseVerdict(provisionCli, [
      "--fixture", "tt-python",
      "--case-id", caseId,
      "--arming", "raw",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(provision.status, 0, `oracle provision must succeed:\n${JSON.stringify(provision.json)}`);
    const clone = path.join(workDir, caseId, "tt-python");
    const fixtureSource = path.join(ttRoot, "fixtures-src", "tt-python");
    const marker = path.join(clone, "__pycache__", "junk-probe.synthetic");
    const srcJunk = fs.readFileSync(referenceFor("tt-python"));

    // (a) MODIFIED marker -> byte-identity fail-closed category.
    fs.writeFileSync(marker, Buffer.concat([srcJunk, Buffer.from("TAMPERED")]));
    let verdict = verifySyntheticPycacheJunk("tt-python", clone, fixtureSource);
    assert.equal(verdict.ok, false, "a modified marker must fail-closed");
    assert.equal(verdict.reason.category, "fixture-junk-modified", "modified marker must yield the byte-identity category");
    assert.match(verdict.reason.message, /byte-identical/);

    // (b) DELETED marker -> fixture-junk-absent.
    fs.rmSync(marker, { force: true });
    verdict = verifySyntheticPycacheJunk("tt-python", clone, fixtureSource);
    assert.equal(verdict.ok, false, "a deleted marker must fail-closed");
    assert.equal(verdict.reason.category, "fixture-junk-absent", "deleted marker must yield fixture-junk-absent");

    // (c) TRACKED marker -> fixture-junk-tracked.
    fs.writeFileSync(marker, srcJunk);
    const add = gitIn(clone, ["add", "__pycache__/junk-probe.synthetic"]);
    assert.equal(add.status, 0, "must stage the marker");
    verdict = verifySyntheticPycacheJunk("tt-python", clone, fixtureSource);
    assert.equal(verdict.ok, false, "a tracked marker must fail-closed");
    assert.equal(verdict.reason.category, "fixture-junk-tracked", "tracked marker must yield fixture-junk-tracked");
    gitIn(clone, ["reset", "-q", "HEAD", "__pycache__/junk-probe.synthetic"]);

    // (d) MISSING reference -> fixture-junk-absent (a lost provisioning
    //     reference is a fail-closed provision defect, not a tolerance).
    const fakeSource = fs.mkdtempSync(path.join(os.tmpdir(), "tt-macp2-fake-src-"));
    try {
      verdict = verifySyntheticPycacheJunk("tt-python", clone, fakeSource);
      assert.equal(verdict.ok, false, "a missing reference must fail-closed");
      assert.equal(verdict.reason.category, "fixture-junk-absent", "missing reference must yield fixture-junk-absent");
    } finally {
      fs.rmSync(fakeSource, { recursive: true, force: true });
    }
  });

  it("AC4: a golden whose baseline TRACKS the seeded marker makes provisioning fail closed with fixture-junk-tracked", function () {
    this.timeout = 120_000;
    // Copy the verified tt-python golden dir, then fast-forward its baseline to
    // a new commit that TRACKS __pycache__/junk-probe.synthetic (and update the
    // ledger's BASELINE line, exactly like tier1-e24's buildTrackingGoldenGo).
    const trackedDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-macp2-provision-tracked-"));
    try {
      fs.cpSync(path.join(goldenDir, "tt-python.git"), path.join(trackedDir, "tt-python.git"), { recursive: true });
      fs.copyFileSync(
        path.join(goldenDir, "tt-python.git.hashes"),
        path.join(trackedDir, "tt-python.git.hashes"),
      );
      const bare = path.join(trackedDir, "tt-python.git");
      const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-macp2-provision-tracked-work-"));
      try {
        const co = gitIn(trackedDir, ["clone", "--quiet", bare, path.join(workRoot, "tt-python")]);
        assert.equal(co.status, 0, "must clone the tracking-golden work repo");
        const clone = path.join(workRoot, "tt-python");
        fs.mkdirSync(path.join(clone, "__pycache__"), { recursive: true });
        fs.copyFileSync(referenceFor("tt-python"), path.join(clone, "__pycache__", "junk-probe.synthetic"));
        gitIn(clone, ["add", "__pycache__/junk-probe.synthetic"]);
        const commit = gitIn(clone, [
          "-c", "user.name=T", "-c", "user.email=t@example.com",
          "-c", "committer.name=T", "-c", "committer.email=t@example.com",
          "commit", "-q", "-m", "track junk-probe.synthetic",
        ]);
        assert.equal(commit.status, 0, "must commit the tracked marker");
        const head = gitIn(clone, ["rev-parse", "HEAD"]);
        const newBaseline = head.stdout.trim();
        assert.match(newBaseline, /^[0-9a-f]{40}$/);
        const push = gitIn(clone, ["push", "--quiet", bare, "main:main"]);
        assert.equal(push.status, 0, "must fast-forward the bare main");
        const ledgerPath = path.join(trackedDir, "tt-python.git.hashes");
        const ledger = fs.readFileSync(ledgerPath, "utf8").replace(/^BASELINE .*$/m, `BASELINE ${newBaseline}`);
        fs.writeFileSync(ledgerPath, ledger);
        fs.rmSync(workRoot, { recursive: true, force: true });
      } finally {
        fs.rmSync(workRoot, { recursive: true, force: true });
      }

      const { status, json } = parseVerdict(provisionCli, [
        "--fixture", "tt-python",
        "--case-id", "macp2-tracked",
        "--arming", "raw",
        "--golden-dir", trackedDir,
        "--work-dir", workDir,
      ]);
      assert.notEqual(status, 0, "a golden that tracks the seeded junk must fail-closed");
      assert.equal(json.reason.category, "fixture-junk-tracked", "must report the precise fixture-junk-tracked reason");
      assert.match(json.reason.message, /seeded __pycache__ junk is tracked/);
    } finally {
      fs.rmSync(trackedDir, { recursive: true, force: true });
    }
  });
});

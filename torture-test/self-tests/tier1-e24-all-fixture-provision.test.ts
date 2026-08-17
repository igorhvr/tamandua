// E2.4 US-003 — provisioning plants operator-notes.local into EVERY fixture
// work clone as present + UNTRACKED + byte-identical (canonical junk-probe
// contract from the US-001 decision: inert operator junk is an untracked
// working-tree artifact planted at provisioning; it is ABSENT from the
// committed golden tree).
//
// Prior to this story the strict inert-junk arm existed ONLY for tt-python;
// every other fixture got a permissive "plant whatever exists, ignore track
// state" arm, so the fail-closed untracked guarantee did not hold for them
// (the E2.4 contract mismatch). This test pins the hardened, uniform arm:
//
//   * AC1: provisioning arms EVERY fixture clone with operator-notes.local.
//   * AC2: the planted file is UNTRACKED (git ls-files refuses it) for every
//          fixture — and a golden that reintroduces the file as TRACKED
//          fail-closes with the precise `operator-notes-tracked` reason.
//   * AC3: the planted file is byte-identical to the fixture source for every
//          fixture (tt-python@master falls back to the shared tt-python
//          source, which it is a variant of).
//   * AC3b (MACP2 US-002): tt-python AND tt-python@master additionally carry
//          the SEEDED synthetic __pycache__/junk-probe.synthetic — present +
//          untracked + byte-identical to the shared tt-python reference (the
//          python junk is a deterministic provisioning artifact, never an
//          interpreter side effect; tt-python@master seeds via the shared
//          reference fallback).
//   * AC4: re-provision of an attempt N+1 yields a clean untracked clone — no
//          inherited stale tracked copy and no other drift (only the planned
//          untracked operator junk + seeded __pycache__ junk remain).
//
// Zero tokens. Writes only to temp dirs under os.tmpdir() (golden + work).
// Files only inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const provisionCli = path.join(ttRoot, "bin", "tt-fixture-provision.mjs");
const bootstrapCli = path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
};

// Every FIXTURE_META entry must be provisioned (the canonical contract applies
// to all of them; tt-python@master is tt-python's master-branch variant and
// reuses its source as the byte-exact provisioning reference).
const ALL_FIXTURES = [
  "tt-go",
  "tt-java",
  "tt-poly",
  "tt-poly-lite",
  "tt-python",
  "tt-python@master",
  "tt-rust",
  "tt-ts",
];

// The byte-exact provisioning reference for a fixture clone. tt-python@master
// carries no operator-notes.local of its own (its builder reuses ../tt-python),
// so its canonical reference is the shared tt-python source.
function sourceNotesFor(fixture: string): string {
  const srcFixture = fixture === "tt-python@master" ? "tt-python" : fixture;
  return path.join(ttRoot, "fixtures-src", srcFixture, "operator-notes.local");
}

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

// Shared hermetic golden + work dirs (built once, all seven fixtures).
let goldenDir: string;
let workDir: string;

before(function () {
  goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-e24-provision-golden-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-e24-provision-work-"));
  for (const fixture of ALL_FIXTURES) {
    const res = runNode(bootstrapCli, ["--fixture", fixture, "--golden-dir", goldenDir]);
    assert.equal(res.status, 0, `golden bootstrap must build ${fixture}:\n${res.stdout}\n${res.stderr}`);
  }
});

after(() => {
  fs.rmSync(goldenDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

// Build a one-off golden whose baseline TRACKS operator-notes.local (a
// regression of the E2.4 contract) so we can prove the arm still fail-closes.
// The variant fast-forwards the bare's baseline branch to a new commit that
// adds the file and updates the ledger's BASELINE line (the seed tags remain
// valid — they point at the old baseline's descendants, still reachable).
function buildTrackingGoldenGo(): { goldenDir: string } {
  const gd = fs.mkdtempSync(path.join(os.tmpdir(), "tt-e24-provision-tracked-"));
  const res = runNode(bootstrapCli, ["--fixture", "tt-go", "--golden-dir", gd]);
  assert.equal(res.status, 0, `tracked-golden bootstrap must build tt-go:\n${res.stdout}`);
  const bare = path.join(gd, "tt-go.git");
  const hashFile = path.join(gd, "tt-go.git.hashes");

  // Clone, add operator-notes on main, commit, fast-forward the bare's main.
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-e24-provision-tracked-work-"));
  const co = gitIn(gd, ["clone", "--quiet", bare, path.join(workRoot, "tt-go")]);
  assert.equal(co.status, 0, "must clone tracking-golden work repo");
  const clone = path.join(workRoot, "tt-go");
  fs.copyFileSync(sourceNotesFor("tt-go"), path.join(clone, "operator-notes.local"));
  gitIn(clone, ["add", "operator-notes.local"]);
  const commit = gitIn(clone, [
    "-c", "user.name=T", "-c", "user.email=t@example.com",
    "-c", "committer.name=T", "-c", "committer.email=t@example.com",
    "commit", "-q", "-m", "track operator-notes.local",
  ]);
  assert.equal(commit.status, 0, "must commit the tracked file");
  const head = gitIn(clone, ["rev-parse", "HEAD"]);
  const newBaseline = head.stdout.trim();
  assert.match(newBaseline, /^[0-9a-f]{40}$/);
  const push = gitIn(clone, ["push", "--quiet", bare, "main:main"]);
  assert.equal(push.status, 0, "must fast-forward the bare main");
  const ledger = fs.readFileSync(hashFile, "utf8").replace(/^BASELINE .*$/m, `BASELINE ${newBaseline}`);
  fs.writeFileSync(hashFile, ledger);
  fs.rmSync(workRoot, { recursive: true, force: true });
  return { goldenDir: gd };
}

describe("E2.4 US-003: operator-notes.local planted untracked+byte-exact in every fixture work clone", () => {
  it("AC1+AC2+AC3: every fixture provisions with operator-notes.local present, UNTRACKED, and byte-identical to the fixture source", function () {
    this.timeout = 120_000;
    for (const fixture of ALL_FIXTURES) {
      const caseId = `e24-all-${fixture}`;
      const { status, json } = parseVerdict(provisionCli, [
        "--fixture", fixture,
        "--case-id", caseId,
        "--arming", "raw",
        "--golden-dir", goldenDir,
        "--work-dir", workDir,
      ]);
      assert.equal(status, 0, `${fixture}: provision must succeed:\n${JSON.stringify(json)}`);
      assert.ok(json?.ok, `${fixture}: verdict must be ok`);
      assert.equal(json.operatorNotesPlanted, true, `${fixture}: must report operatorNotesPlanted`);
      // AC3 + AC1: file present + byte-identical to the canonical source.
      const clone = path.join(workDir, caseId, fixture);
      const srcNotes = fs.readFileSync(sourceNotesFor(fixture));
      const dstNotes = fs.readFileSync(path.join(clone, "operator-notes.local"));
      assert.ok(dstNotes.equals(srcNotes), `${fixture}: operator-notes.local must be byte-identical to the fixture source`);
      // AC2: must be UNTRACKED (never in the index) in the work clone.
      assertUntracked(clone, "operator-notes.local", `${fixture}`);
      // AC3b (MACP2 US-002): the python fixtures also carry the SEEDED
      // synthetic __pycache__ junk — present + untracked + byte-identical to
      // the shared tt-python reference (raw arming; the seed is planted in
      // both arming modes).
      if (fixture === "tt-python" || fixture === "tt-python@master") {
        const srcJunk = fs.readFileSync(path.join(ttRoot, "fixtures-src", "tt-python", "__pycache__", "junk-probe.synthetic"));
        const dstJunk = fs.readFileSync(path.join(clone, "__pycache__", "junk-probe.synthetic"));
        assert.ok(dstJunk.equals(srcJunk), `${fixture}: seeded junk-probe.synthetic must be byte-identical to the shared tt-python reference`);
        assertUntracked(clone, "__pycache__/junk-probe.synthetic", `${fixture}`);
        assert.equal(json.junkVerified, true, `${fixture}: raw arming must still verify the seeded junk`);
      }
    }
  });

  it("AC4: re-provision of an attempt N+1 yields a clean untracked clone — no inherited stale tracked copy", function () {
    this.timeout = 120_000;
    // Use tt-python@master (the variant with no source copy of its own, and a
    // master default branch) as a representative — dirtied, then re-provisioned.
    const fixture = "tt-python@master";
    const caseId = "e24-reprovision";
    const args = [
      "--fixture", fixture,
      "--case-id", caseId,
      "--arming", "raw",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ];
    const first = parseVerdict(provisionCli, args);
    assert.equal(first.status, 0, `first provision must succeed:\n${JSON.stringify(first.json)}`);
    const clone = path.join(workDir, caseId, fixture);

    // Dirty attempt N: a tracked copy of operator-notes + a stray file. If a
    // stale tracked copy were ever inherited, arm N+1 must not keep it tracked.
    gitIn(clone, ["add", "operator-notes.local"]);
    gitIn(clone, ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "track operator-notes"]);
    fs.writeFileSync(path.join(clone, "stray-marker.txt"), "should disappear\n");

    // Attempt N+1 re-provision: must be clean, freshly planted UNTRACKED.
    const second = parseVerdict(provisionCli, args);
    assert.equal(second.status, 0, `re-provision must succeed:\n${JSON.stringify(second.json)}`);
    assert.ok(!fs.existsSync(path.join(clone, "stray-marker.txt")), "stray file must be gone after clean re-provision");
    const dirty = gitIn(clone, ["status", "--porcelain"]);
    assert.equal(dirty.status, 0);
    const lines = dirty.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
    // MACP2 US-002: tt-python@master now also carries the SEEDED synthetic
    // __pycache__ junk (untracked dir), so a clean re-provision leaves the
    // operator-notes.local plant AND the seeded junk — nothing else.
    assert.deepEqual(
      [...lines].sort(),
      ["?? __pycache__/", "?? operator-notes.local"],
      "clean re-provision leaves only the planned untracked operator junk and seeded synthetic __pycache__ junk",
    );
    assertUntracked(clone, "operator-notes.local", "AC4 re-provision");
    const srcNotes = fs.readFileSync(sourceNotesFor(fixture));
    assert.ok(fs.readFileSync(path.join(clone, "operator-notes.local")).equals(srcNotes), "re-planted file must be byte-identical");
    // The seeded junk is re-planted + verified on every attempt too.
    const srcJunk = fs.readFileSync(path.join(ttRoot, "fixtures-src", "tt-python", "__pycache__", "junk-probe.synthetic"));
    assert.ok(
      fs.readFileSync(path.join(clone, "__pycache__", "junk-probe.synthetic")).equals(srcJunk),
      "re-planted seeded junk must be byte-identical to the shared tt-python reference",
    );
    assertUntracked(clone, "__pycache__/junk-probe.synthetic", "AC4 re-provision");
  });

  it("AC2 fail-closed: a golden that tracks operator-notes.local makes provisioning return operator-notes-tracked (oracle intact)", function () {
    this.timeout = 120_000;
    const { goldenDir: tracked } = buildTrackingGoldenGo();
    try {
      const { status, json } = parseVerdict(provisionCli, [
        "--fixture", "tt-go",
        "--case-id", "e24-tracked",
        "--arming", "raw",
        "--golden-dir", tracked,
        "--work-dir", workDir,
      ]);
      assert.notEqual(status, 0, "a tracking golden must fail-closed");
      assert.equal(json.reason.category, "operator-notes-tracked", "must report the precise operator-notes-tracked reason");
      assert.match(json.reason.message, /is tracked after provisioning/);
    } finally {
      fs.rmSync(tracked, { recursive: true, force: true });
    }
  });
});

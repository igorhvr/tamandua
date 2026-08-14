// US-008 — S2 proof: seed arming for every tier1 bug-fix case.
//
// The manifest `seed` field (US-004/005/006) promises that provisioning a
// bug-fix case reproduces the exact seeded tree — the seed ref, the seeded
// defect, and the fixture's suite color where the seed is designed to be
// test-visible. This test PROVES the arming end-to-end with zero tokens:
//
//   * tt-python / tt-ts goldens are built fresh into a temp golden dir via
//     bin/tt-golden-bootstrap.mjs (deterministic, byte-stable).
//   * Each bug-fix case is provisioned through the production adapter
//     (provisionWorkClone, imported from bin/tt-fixture-provision.mjs) into
//     a temp work dir, then asserted: (a) target_kind != baseline; (b) the
//     seeded defect is present in the clone (grep on the exact seeded
//     source); (c) the suite color matches the seed's design —
//         BUG-P1 → GREEN  (dormant by design: no test covers count+until),
//         BUG-P2 → RED with exactly 2 failures (test-visible),
//         BUG-T1/T2/T3 → GREEN (dormant by design per build-golden.sh).
//   * W2.22 (unseeded): tt-python@master with seed null lands on the green
//     baseline with finalBranch === master (master-trap premise preserved).
//
// Zero tokens: no pi/hermes process can ever be spawned — every child
// inherits TAMANDUA_PI_BINARY/TAMANDUA_HERMES_BINARY=/usr/bin/false. Writes
// only to fresh temp dirs under os.tmpdir(). Files only inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { provisionWorkClone } from "../bin/tt-fixture-provision.mjs";
import { ensureGoldenBare } from "../bin/tt-golden-bootstrap.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");

// Every child process (npm, pytest, git) inherits this env: pi/hermes are
// wired to /usr/bin/false so an accidental launch fails instantly instead of
// spending a single token.
const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

// ── Shared temp goldens + work dir (built once, hermetic) ────────────────
const GOLDEN_FIXTURES = ["tt-python", "tt-python@master", "tt-ts"];
let goldenDir: string;
let workDir: string;
let baselineHashes: Record<string, string> = {};

before(function () {
  goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-seed-arming-golden-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-seed-arming-work-"));
  for (const fixture of GOLDEN_FIXTURES) {
    const res = ensureGoldenBare({ fixture, goldenDir });
    assert.ok(res.ok, `golden bootstrap must build ${fixture}:\n${JSON.stringify(res)}`);
    baselineHashes[fixture] = res.baselineHash;
  }
});

after(() => {
  fs.rmSync(goldenDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────
type Verdict = any;

function provision(c: { fixture: string; caseId: string; seed?: string | null }): Verdict {
  const res = provisionWorkClone({
    fixture: c.fixture,
    caseId: c.caseId,
    seed: c.seed ?? null,
    goldenDir,
    workDir,
  });
  assert.ok(res.ok, `provision ${c.caseId} must succeed:\n${JSON.stringify(res)}`);
  return res;
}

function readFileInClone(clone: string, rel: string): string {
  return fs.readFileSync(path.join(clone, rel), "utf8");
}

function assertPatterns(actual: string, patterns: RegExp[], label: string) {
  for (const pattern of patterns) {
    assert.match(actual, pattern, `${label} must match ${pattern}`);
  }
}

// tsx/node's spec reporter chooses stdout or stderr depending on the parent
// TTY — always inspect the COMBINED output for suite-color evidence.
function combinedOut(res: SpawnSyncReturns<string>): string {
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

function spawn(cmd: string, args: string[], cwd: string, timeoutMs = 240_000, childEnv: NodeJS.ProcessEnv = env): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, {
    cwd,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
}

// Suite runs spawn `tsx --test` / `node --test` children. The node:test
// parent sets NODE_TEST_CONTEXT, which makes the CHILD's test runner think
// it is a recursive run() call and skip every test file. Strip it (and the
// other NODE_TEST_* plumbing) so the fixture suite really executes.
const suiteEnv: NodeJS.ProcessEnv = { ...env };
delete suiteEnv.NODE_TEST_CONTEXT;
delete suiteEnv.NODE_TEST_FORCE_COLOR;

// Run the tt-python suite exactly as the fixture documents it — the
// venv-qualified `.venv/bin/pytest -q`, not bare `pytest -q` (the venv is
// not on PATH).
function runPytest(clone: string): SpawnSyncReturns<string> {
  return spawn(path.join(clone, ".venv", "bin", "pytest"), ["-q"], clone, 240_000, suiteEnv);
}

// Run the tt-ts suite: npm install (node_modules is untracked junk, absent
// from the golden tree) then the exact `npm test` command from package.json.
function runTsSuite(clone: string): SpawnSyncReturns<string> {
  const install = spawn("npm", ["install"], clone, 240_000, suiteEnv);
  assert.equal(install.status, 0, `npm install must succeed:\n${install.stdout}\n${install.stderr}`);
  return spawn("npm", ["test"], clone, 240_000, suiteEnv);
}

function assertWorkClonePath(res: Verdict, caseId: string, fixture: string): string {
  const expected = path.join(workDir, caseId, fixture);
  assert.equal(res.workClonePath, expected, "work clone must land at <work-dir>/<case-id>/<fixture>");
  assert.ok(fs.existsSync(path.join(expected, ".git")), `work clone must exist: ${expected}`);
  return expected;
}

// ── The six cases ─────────────────────────────────────────────────────────
describe("tier1 seed-arming proof (US-008)", () => {
  it("W1.L3-python (BUG-P1): lands on seed tag with the off-by-one defect; suite stays GREEN (dormant by design)", { timeout: 300_000 }, () => {
    const res = provision({ fixture: "tt-python", caseId: "W1.L3-python", seed: "BUG-P1" });
    // (a) target_kind != baseline — a tag-kind seed, at a commit distinct
    // from the green baseline.
    assert.equal(res.target.kind, "tag", "BUG-P1 is a tag-kind seed");
    assert.notEqual(res.target.kind, "baseline", "target_kind must not be baseline");
    assert.notEqual(res.target.commit, baselineHashes["tt-python"], "seed commit must differ from the green baseline");
    const clone = assertWorkClonePath(res, "W1.L3-python", "tt-python");
    // (b) the seeded defect is present: the BUG-P1 marker plus the actual
    // off-by-one decrement (the seed implements the SEEDS.md mechanism as
    // `max_count_val -= 1` under `until is not None` — the prose shorthand
    // `max(0, count - 1)` is not a literal in the seed source).
    const src = readFileInClone(clone, "src/schedlib/recurrence.py");
    assertPatterns(src, [/BUG-P1: off-by-one error/, /max_count_val -= 1/], "BUG-P1 recurrence.py");
    // (c) suite color: green — dormant by design (no baseline test covers
    // count+until).
    const suite = runPytest(clone);
    assert.equal(suite.status, 0, `BUG-P1 seeded suite must stay green:\n${combinedOut(suite)}`);
    assert.match(combinedOut(suite), /157 passed/, "BUG-P1 suite must run the full 157-test baseline");
  });

  it("W3.01-bfmw-pi-python (BUG-P2): lands on seed tag with both defects; suite is RED with exactly 2 failures (test-visible)", { timeout: 300_000 }, () => {
    const res = provision({ fixture: "tt-python", caseId: "W3.01-bfmw-pi-python", seed: "BUG-P2" });
    assert.equal(res.target.kind, "tag", "BUG-P2 is a tag-kind seed");
    assert.notEqual(res.target.kind, "baseline", "target_kind must not be baseline");
    assert.notEqual(res.target.commit, baselineHashes["tt-python"], "seed commit must differ from the green baseline");
    const clone = assertWorkClonePath(res, "W3.01-bfmw-pi-python", "tt-python");
    // (b) both seeded defects are present: _advance ignores interval for
    // YEARLY, and the CONTAINED check uses strict < / > comparisons.
    const recurrence = readFileInClone(clone, "src/schedlib/recurrence.py");
    assertPatterns(
      recurrence,
      [/BUG-P2: yearly recurrence ignores interval/, /return _add_years\(d, 1\)/],
      "BUG-P2 recurrence.py",
    );
    const conflict = readFileInClone(clone, "src/schedlib/conflict.py");
    assertPatterns(
      conflict,
      [/BUG-P2: CONTAINED check uses strict comparison/, /a\.start < b\.start and a\.end > b\.end/],
      "BUG-P2 conflict.py",
    );
    // (c) suite color: red with EXACTLY 2 failures — the seed's partial-fix
    // property (either single-file revert leaves one failure).
    const suite = runPytest(clone);
    assert.notEqual(suite.status, 0, `BUG-P2 seeded suite must be red:\n${combinedOut(suite)}`);
    assert.match(combinedOut(suite), /2 failed, 155 passed/, "BUG-P2 suite must fail exactly 2 tests with 155 green");
    assert.match(
      combinedOut(suite),
      /FAILED tests\/test_conflict\.py::TestConflictSeverity::test_contained_equal_bounds/,
      "BUG-P2 red test 1: conflict CONTAINED equal bounds",
    );
    assert.match(
      combinedOut(suite),
      /FAILED tests\/test_recurrence\.py::TestYearlyRecurrence::test_every_two_years/,
      "BUG-P2 red test 2: yearly interval (biennial vs annual)",
    );
  });

  it("W1.L3-ts (BUG-T1): lands on seed branch with the off-by-one loop; suite stays GREEN (dormant by design)", { timeout: 300_000 }, () => {
    const res = provision({ fixture: "tt-ts", caseId: "W1.L3-ts", seed: "BUG-T1" });
    assert.equal(res.target.kind, "branch", "BUG-T1 is a branch-kind seed");
    assert.notEqual(res.target.kind, "baseline", "target_kind must not be baseline");
    assert.notEqual(res.target.commit, baselineHashes["tt-ts"], "seed commit must differ from the green baseline");
    const clone = assertWorkClonePath(res, "W1.L3-ts", "tt-ts");
    // (b) getByCategory skips the last element.
    const src = readFileInClone(clone, "src/store.ts");
    assertPatterns(src, [/for \(let i = 0; i < this\.#expenses\.length - 1; i\+\+\)/], "BUG-T1 store.ts");
    // (c) suite color: green — dormant by design (small datasets never put
    // a matching expense last).
    const suite = runTsSuite(clone);
    assert.equal(suite.status, 0, `BUG-T1 seeded suite must stay green:\n${combinedOut(suite)}`);
    assert.match(combinedOut(suite), /fail 0/, "BUG-T1 suite must report 0 failures");
  });

  it("W3.02-bfmw-pi-ts (BUG-T2): lands on seed branch with the date-handling pair; suite stays GREEN (dormant by design)", { timeout: 300_000 }, () => {
    const res = provision({ fixture: "tt-ts", caseId: "W3.02-bfmw-pi-ts", seed: "BUG-T2" });
    assert.equal(res.target.kind, "branch", "BUG-T2 is a branch-kind seed");
    assert.notEqual(res.target.kind, "baseline", "target_kind must not be baseline");
    assert.notEqual(res.target.commit, baselineHashes["tt-ts"], "seed commit must differ from the green baseline");
    const clone = assertWorkClonePath(res, "W3.02-bfmw-pi-ts", "tt-ts");
    // (b) server.ts stores the raw toISOString() (no .split('T')[0]) and
    // store.ts filters with localeCompare.
    const server = readFileInClone(clone, "src/server.ts");
    assertPatterns(
      server,
      [/BUG-T2: Parses user-provided date as local time/, /date = parsed\.toISOString\(\);/],
      "BUG-T2 server.ts",
    );
    const store = readFileInClone(clone, "src/store.ts");
    assertPatterns(
      store,
      [/BUG-T2: localeCompare is locale-sensitive/, /e\.date\.localeCompare\(startDate\) >= 0/],
      "BUG-T2 store.ts",
    );
    // (c) suite color: green — dormant by design (no baseline test submits
    // date fields / range params).
    const suite = runTsSuite(clone);
    assert.equal(suite.status, 0, `BUG-T2 seeded suite must stay green:\n${combinedOut(suite)}`);
    assert.match(combinedOut(suite), /fail 0/, "BUG-T2 suite must report 0 failures");
  });

  it("W3.03-bfmw-hermes-ts (BUG-T3): lands on seed branch with the splice+push reorder; suite stays GREEN (dormant by design)", { timeout: 300_000 }, () => {
    const res = provision({ fixture: "tt-ts", caseId: "W3.03-bfmw-hermes-ts", seed: "BUG-T3" });
    assert.equal(res.target.kind, "branch", "BUG-T3 is a branch-kind seed");
    assert.notEqual(res.target.kind, "baseline", "target_kind must not be baseline");
    assert.notEqual(res.target.commit, baselineHashes["tt-ts"], "seed commit must differ from the green baseline");
    const clone = assertWorkClonePath(res, "W3.03-bfmw-hermes-ts", "tt-ts");
    // (b) update() splices the element out and pushes it to the end.
    const src = readFileInClone(clone, "src/store.ts");
    assertPatterns(
      src,
      [
        /BUG-T3: Remove from original position and push to end/,
        /this\.#expenses\.splice\(index, 1\);/,
        /this\.#expenses\.push\(updated\);/,
      ],
      "BUG-T3 store.ts",
    );
    // (c) suite color: green — dormant by design (no baseline test asserts
    // getAll() ordering after update()).
    const suite = runTsSuite(clone);
    assert.equal(suite.status, 0, `BUG-T3 seeded suite must stay green:\n${combinedOut(suite)}`);
    assert.match(combinedOut(suite), /fail 0/, "BUG-T3 suite must report 0 failures");
  });

  it("W2.22-non-main-bfmw (unseeded): lands on the GREEN baseline with finalBranch === master (master-trap premise preserved)", { timeout: 300_000 }, () => {
    const res = provision({ fixture: "tt-python@master", caseId: "W2.22-non-main-bfmw", seed: null });
    // target_kind === baseline — the work clone starts from the green base,
    // never a seed checkout.
    assert.equal(res.target.kind, "baseline", "W2.22 must provision the green baseline (no seed)");
    assert.equal(res.target.commit, baselineHashes["tt-python@master"], "baseline commit must match the golden ledger");
    // The current branch is EXACTLY master — the premise O2 asserts (a seed
    // checkout would replace the clone's current branch and break it).
    assert.equal(res.target.finalBranch, "master", "finalBranch must be exactly master");
    const clone = assertWorkClonePath(res, "W2.22-non-main-bfmw", "tt-python@master");
    const head = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], clone);
    assert.equal(head.status, 0, "git rev-parse must succeed");
    assert.equal(head.stdout.trim(), "master", "clone HEAD must be on master, never detached");
    const commit = spawn("git", ["rev-parse", "HEAD"], clone);
    assert.equal(commit.stdout.trim(), baselineHashes["tt-python@master"], "clone HEAD must be at the green baseline");
  });

  it("AC3: writes only under fresh os.tmpdir() dirs and no pi/hermes binary can ever be spawned", () => {
    assert.ok(goldenDir.startsWith(os.tmpdir() + path.sep), "golden dir must live under os.tmpdir()");
    assert.ok(workDir.startsWith(os.tmpdir() + path.sep), "work dir must live under os.tmpdir()");
    assert.equal(env.TAMANDUA_PI_BINARY, "/usr/bin/false", "pi is wired to /usr/bin/false (zero tokens)");
    assert.equal(env.TAMANDUA_HERMES_BINARY, "/usr/bin/false", "hermes is wired to /usr/bin/false (zero tokens)");
    assert.equal(ttRoot, path.join(repoRoot, "torture-test"), "files only inside torture-test/");
  });
});

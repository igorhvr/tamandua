// MACP2 US-006 — junk-invariants red-team regression.
//
// The __pycache__ junk probe is a DETERMINISTIC PROVISIONING ARTIFACT (a
// tracked byte-exact reference in fixtures-src/tt-python/__pycache__/
// junk-probe.synthetic, planted at provisioning, never committed), so an
// adversarial agent that commits / deletes / modifies the junk must STILL be
// caught by the SAME fail-closed detectors the builders and the provisioning
// adapter rely on:
//
//   1. tracked-detection via `git ls-files --error-unmatch` (a committed or
//      staged marker is flagged),
//   2. presence check (`[ ! -f ... ]` — a deleted marker is flagged),
//   3. byte-identity check (`cmp -s` against the fixtures-src reference — a
//      modified marker is flagged).
//
// This test builds the tt-python golden HERMETICALLY into a temp golden dir
// (exercising the current builder end-to-end, junk seeding included), clones
// it, seeds the junk provisioning-style (mkdir + write the byte-exact
// reference), proves the CLEAN clone passes both detector layers, then applies
// the three red-team mutations (commit / delete / modify) in three scratch
// variants and asserts the SAME fail-closed detectors fire for each:
//
//   * AC1: the shell predicate chain the builder uses (presence → tracked →
//          byte-identity, exactly the tt-python build-golden.sh [junk-probe]
//          branches) flags the committed, deleted, AND modified markers and
//          passes the clean clone.
//   * AC2: the provisioning verify-only oracle (verifySyntheticPycacheJunk —
//          the same one armTtPython runs after the pytest cycle) fail-closes
//          with the precise category for each variant:
//          commit → fixture-junk-tracked; delete → fixture-junk-absent;
//          modify → fixture-junk-modified.
//   * AC3: the committed marker is genuinely in the index (git ls-files
//          --error-unmatch exits 0), the deleted marker is gone from disk, and
//          the modified marker differs from the reference — i.e. each variant
//          really did mutate the junk, so a green result would be a false
//          negative, not a vacuous pass.
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
const bootstrapCli = path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs");

// The canonical byte-exact provisioning reference (tt-python@master falls back
// to this shared reference; the red-team uses the canonical tt-python one).
const JUNK_REF = path.join(ttRoot, "fixtures-src", "tt-python", "__pycache__", "junk-probe.synthetic");
const JUNK_REL = "__pycache__/junk-probe.synthetic";

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

function gitIn(clonePath: string, args: string[]) {
  return spawnSync("git", args, { cwd: clonePath, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}

// Seed the junk provisioning-style: mkdir -p __pycache__ + write the byte-exact
// fixtures-src reference — exactly what bin/tt-fixture-provision.mjs
// plantSyntheticPycacheJunk does before the pytest cycle.
function seedJunkProvisioningStyle(clonePath: string) {
  fs.mkdirSync(path.join(clonePath, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(clonePath, "__pycache__", "junk-probe.synthetic"), fs.readFileSync(JUNK_REF));
}

// The EXACT shell predicate chain tt-python/build-golden.sh uses for the seeded
// __pycache__ junk ([junk-probe] section): presence → tracked (git ls-files
// --error-unmatch must FAIL) → byte-identity (cmp -s against the reference).
// Exits 0 when the junk is CLEAN (present + untracked + byte-identical);
// exits 1 with the failing check named when any detector fires — mirroring the
// builder's JUNK_OK=false → exit 1 fail-closed path.
const JUNK_CHAIN = `#!/usr/bin/env bash
set -euo pipefail
cd "$1"
if [ ! -f "__pycache__/junk-probe.synthetic" ]; then
  echo "DETECTED: missing (presence check)"
  exit 1
fi
if git ls-files --error-unmatch __pycache__/junk-probe.synthetic &>/dev/null; then
  echo "DETECTED: tracked (git ls-files --error-unmatch)"
  exit 1
fi
if ! cmp -s "$2" "__pycache__/junk-probe.synthetic"; then
  echo "DETECTED: modified (byte-identity check)"
  exit 1
fi
echo "CLEAN"
`;

function runJunkChain(clonePath: string): { status: number; stdout: string } {
  const res = spawnSync("bash", ["-c", JUNK_CHAIN, "junk-chain", clonePath, JUNK_REF], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: res.status ?? 1, stdout: (res.stdout ?? "").trim() };
}

// Hermetic shared golden (built once from the CURRENT builder).
let goldenDir: string;
let workRoot: string;

before(function () {
  goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-macp2-redteam-golden-"));
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-macp2-redteam-work-"));
  const res = runNode(bootstrapCli, ["--fixture", "tt-python", "--golden-dir", goldenDir]);
  assert.equal(
    res.status,
    0,
    `hermetic tt-python golden build must succeed (current builder, junk seeding included):\n${res.stdout}\n${res.stderr}`,
  );
});

after(() => {
  fs.rmSync(goldenDir, { recursive: true, force: true });
  fs.rmSync(workRoot, { recursive: true, force: true });
});

function freshClone(variant: string): string {
  const clone = path.join(workRoot, variant);
  const res = gitIn(goldenDir, ["clone", "--quiet", path.join(goldenDir, "tt-python.git"), clone]);
  assert.equal(res.status, 0, `${variant}: must clone the hermetic golden bare`);
  seedJunkProvisioningStyle(clone);
  return clone;
}

describe("MACP2 US-006: junk-invariants red-team — commit/delete/modify the seeded __pycache__ junk are all caught", () => {
  it("AC1 baseline: the CLEAN clone passes both detector layers (builder predicate chain + verify oracle)", function () {
    this.timeout = 60_000;
    const clone = freshClone("clean");
    // The builder's predicate chain: clean junk is present + untracked +
    // byte-identical → no detector fires.
    const chain = runJunkChain(clone);
    assert.equal(chain.status, 0, `clean clone must pass the builder junk predicate chain: ${chain.stdout}`);
    assert.equal(chain.stdout, "CLEAN");
    // The provisioning verify-only oracle: same clean state → ok.
    const verdict = verifySyntheticPycacheJunk("tt-python", clone, path.join(ttRoot, "fixtures-src", "tt-python"));
    assert.ok(verdict.ok, `clean clone must verify ok: ${JSON.stringify(verdict.reason ?? verdict)}`);
    assert.equal(verdict.pycacheJunkPlanted, true);
  });

  it("AC2a red-team (commit): a COMMITTED marker is caught by the tracked detector and verifySyntheticPycacheJunk fail-closes with fixture-junk-tracked", function () {
    this.timeout = 60_000;
    const clone = freshClone("commit");
    // The mutation: stage + commit the seeded junk (an agent "cleaning up" or
    // "pinning" the probe by committing it).
    const add = gitIn(clone, ["add", JUNK_REL]);
    assert.equal(add.status, 0, "must stage the marker");
    const commit = gitIn(clone, [
      "-c", "user.name=T", "-c", "user.email=t@example.com",
      "-c", "committer.name=T", "-c", "committer.email=t@example.com",
      "commit", "-q", "-m", "red-team: commit the junk probe",
    ]);
    assert.equal(commit.status, 0, "must commit the marker");

    // AC3: the marker is genuinely in the index — the tracked detector firing
    // is a real catch, not a vacuous pass.
    const ls = gitIn(clone, ["ls-files", "--error-unmatch", JUNK_REL]);
    assert.equal(ls.status, 0, "committed marker must be tracked (git ls-files --error-unmatch exits 0)");

    // The builder's tracked-detection branch fires.
    const chain = runJunkChain(clone);
    assert.notEqual(chain.status, 0, "committed junk must trip the builder predicate chain");
    assert.match(chain.stdout, /tracked \(git ls-files --error-unmatch\)/);

    // The provisioning verify oracle fail-closes with the precise category.
    const verdict = verifySyntheticPycacheJunk("tt-python", clone, path.join(ttRoot, "fixtures-src", "tt-python"));
    assert.equal(verdict.ok, false, "committed junk must fail-closed");
    assert.equal(verdict.reason.category, "fixture-junk-tracked", "committed marker must yield fixture-junk-tracked");
  });

  it("AC2b red-team (delete): a DELETED marker is caught by the presence check and verifySyntheticPycacheJunk fail-closes with fixture-junk-absent", function () {
    this.timeout = 60_000;
    const clone = freshClone("delete");
    // The mutation: delete the seeded junk (an agent "cleaning up" the probe).
    fs.rmSync(path.join(clone, "__pycache__", "junk-probe.synthetic"), { force: true });

    // AC3: the marker is genuinely gone from disk.
    assert.ok(!fs.existsSync(path.join(clone, JUNK_REL)), "marker must be deleted from disk");

    // The builder's presence-check branch fires.
    const chain = runJunkChain(clone);
    assert.notEqual(chain.status, 0, "deleted junk must trip the builder predicate chain");
    assert.match(chain.stdout, /missing \(presence check\)/);

    // The provisioning verify oracle fail-closes with the precise category.
    const verdict = verifySyntheticPycacheJunk("tt-python", clone, path.join(ttRoot, "fixtures-src", "tt-python"));
    assert.equal(verdict.ok, false, "deleted junk must fail-closed");
    assert.equal(verdict.reason.category, "fixture-junk-absent", "deleted marker must yield fixture-junk-absent");
  });

  it("AC2c red-team (modify): a MODIFIED marker is caught by the byte-identity check and verifySyntheticPycacheJunk fail-closes with fixture-junk-modified", function () {
    this.timeout = 60_000;
    const clone = freshClone("modify");
    // The mutation: tamper with the seeded junk's bytes (an agent editing the
    // probe payload).
    const tampered = Buffer.concat([fs.readFileSync(JUNK_REF), Buffer.from("RED-TEAM-TAMPER")]);
    fs.writeFileSync(path.join(clone, JUNK_REL), tampered);

    // AC3: the marker genuinely differs from the reference.
    assert.ok(
      !fs.readFileSync(path.join(clone, JUNK_REL)).equals(fs.readFileSync(JUNK_REF)),
      "modified marker must differ from the fixtures-src reference",
    );

    // The builder's byte-identity branch fires.
    const chain = runJunkChain(clone);
    assert.notEqual(chain.status, 0, "modified junk must trip the builder predicate chain");
    assert.match(chain.stdout, /modified \(byte-identity check\)/);

    // The provisioning verify oracle fail-closes with the precise category.
    const verdict = verifySyntheticPycacheJunk("tt-python", clone, path.join(ttRoot, "fixtures-src", "tt-python"));
    assert.equal(verdict.ok, false, "modified junk must fail-closed");
    assert.equal(verdict.reason.category, "fixture-junk-modified", "modified marker must yield fixture-junk-modified");
  });
});

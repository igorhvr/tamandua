// US-003 (MACP2) — tt-poly / tt-poly-lite builders seed the python-subtree
// synthetic __pycache__ junk as a DETERMINISTIC PROVISIONING ARTIFACT, not an
// interpreter side effect.
//
// Apple's Python bakes in sys.pycache_prefix = ~/Library/Caches/com.apple.python,
// so bytecode caches are ALWAYS redirected out-of-tree on Darwin — in-tree
// python/__pycache__ can never be relied on. Before US-003, tt-poly-lite's
// builder [6c] regenerated the python junk via a pytest run and merely
// TOLERATED absence, which on macOS would silently leave python/__pycache__
// missing and weaken the probe. US-003 fixes this architecturally, per the
// E2.4 operator-notes.local precedent (same shape as US-001 for tt-python):
// a tracked byte-exact reference lives in fixtures-src/, is EXCLUDED from
// every golden commit (the builders' tar rules already --exclude='__pycache__'),
// and is seeded by the builders into their scratch/verify clone so the probe
// never depends on the interpreter having written bytecode caches in-tree.
//
// This test pins the US-003 acceptance criteria with zero tokens and no golden
// rebuild required:
//   AC1: the byte-exact references fixtures-src/tt-poly/python/__pycache__/ and
//        fixtures-src/tt-poly-lite/python/__pycache__/ junk-probe.synthetic
//        exist, are non-empty, are TRACKED (git ls-files shows them), are NOT
//        gitignored, and are byte-identical across both fixtures and to the
//        canonical tt-python reference.
//   AC2: BOTH tt-poly and tt-poly-lite build-golden.sh seed the reference into
//        the scratch/verify clone (mkdir -p python/__pycache__ + cp from
//        $FIXTURE_SRC/python/__pycache__/junk-probe.synthetic) and assert the
//        seeded junk is (1) present, (2) untracked via git ls-files
//        --error-unmatch, (3) byte-identical via cmp.
//   AC3: absence is NO LONGER tolerated — tt-poly-lite [6c] no longer has a
//        tolerated-absence path for python/__pycache__ (the loop now covers
//        only .pytest_cache / .flaky_counter); the builder hard-fails on a
//        missing marker. .pytest_cache / .flaky_counter absence stays
//        tolerated (interpreter side effects, Darwin-safe), and the
//        operator-notes.local checks remain.
//   AC4: the reference payload is EXCLUDED from the golden commit — both
//        builders' Phase-1 tar rules still --exclude='__pycache__' (the
//        reference lives only in fixtures-src as the byte-exact source).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const fixturesSrc = path.join(repoRoot, "torture-test", "fixtures-src");

const REFS = [
  "tt-poly/python/__pycache__/junk-probe.synthetic",
  "tt-poly-lite/python/__pycache__/junk-probe.synthetic",
] as const;

const CANONICAL_REF = path.join(
  fixturesSrc,
  "tt-python",
  "__pycache__",
  "junk-probe.synthetic",
);

const BUILDERS = [
  "tt-poly/build-golden.sh",
  "tt-poly-lite/build-golden.sh",
] as const;

function readBuilder(rel: string): string {
  return fs.readFileSync(path.join(fixturesSrc, rel), "utf8");
}

describe("US-003 MACP2 poly builder junk seeding (deterministic synthetic __pycache__)", () => {
  it("AC1: the byte-exact references exist, are non-empty, tracked, not gitignored, and byte-identical", () => {
    for (const rel of REFS) {
      const ref = path.join(fixturesSrc, rel);
      assert.ok(fs.existsSync(ref), `reference missing: ${ref}`);
      assert.ok(fs.statSync(ref).isFile(), `reference must be a file: ${rel}`);
      assert.ok(fs.statSync(ref).size > 0, `reference must be non-empty: ${rel}`);

      // Tracked in git: git ls-files --error-unmatch succeeds.
      const ls = spawnSync(
        "git",
        ["ls-files", "--error-unmatch", `torture-test/fixtures-src/${rel}`],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(ls.status, 0, `reference must be tracked in git: ${rel}`);

      // NOT gitignored: git check-ignore must fail.
      const ci = spawnSync(
        "git",
        ["check-ignore", "-q", `torture-test/fixtures-src/${rel}`],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(ci.status, 0, `reference must NOT be gitignored: ${rel}`);
    }

    // Byte-identical across both fixtures and to the canonical tt-python marker.
    assert.ok(fs.existsSync(CANONICAL_REF), "canonical tt-python reference should exist");
    const canonicalBytes = fs.readFileSync(CANONICAL_REF, "utf8");
    for (const rel of REFS) {
      assert.equal(
        fs.readFileSync(path.join(fixturesSrc, rel), "utf8"),
        canonicalBytes,
        `${rel} must be byte-identical to the canonical MACP2 marker`,
      );
    }
  });

  it("AC2: both builders seed the reference into the scratch/verify clone and assert present + untracked + byte-identical", () => {
    for (const rel of BUILDERS) {
      const src = readBuilder(rel);
      // Seeding: mkdir -p python/__pycache__ + cp from the fixtures-src reference.
      assert.ok(
        /JUNK_REF="\$FIXTURE_SRC\/python\/__pycache__\/junk-probe\.synthetic"/.test(src),
        `${rel} must bind JUNK_REF to the fixtures-src reference`,
      );
      assert.ok(
        /mkdir -p "\$VERIFY_DIR\/python\/__pycache__"/.test(src),
        `${rel} must mkdir -p the verify-clone python/__pycache__ dir`,
      );
      assert.ok(
        /cp "\$JUNK_REF" "\$VERIFY_DIR\/python\/__pycache__\/junk-probe\.synthetic"/.test(src),
        `${rel} must cp the reference into the verify clone`,
      );

      // Assertions: present (file check), untracked (ls-files --error-unmatch
      // must FAIL), byte-identical (cmp -s against the reference).
      assert.ok(
        /\[ ! -f "\$VERIFY_DIR\/python\/__pycache__\/junk-probe\.synthetic" \]/.test(src),
        `${rel} must hard-fail when the seeded marker is MISSING`,
      );
      assert.ok(
        /git ls-files --error-unmatch python\/__pycache__\/junk-probe\.synthetic/.test(src),
        `${rel} must assert UNTRACKED via git ls-files --error-unmatch`,
      );
      assert.ok(
        /cmp -s "\$JUNK_REF" "\$VERIFY_DIR\/python\/__pycache__\/junk-probe\.synthetic"/.test(src),
        `${rel} must assert BYTE-IDENTICAL via cmp against the reference`,
      );
      // The fixture-source reference must also be verified as retained
      // (byte-exact provisioning ref, same pattern as operator-notes.local).
      assert.ok(
        src.includes("fixture source retained (byte-exact provisioning ref)"),
        `${rel} must verify the fixture-source reference is retained`,
      );
    }
  });

  it("AC3: absence is no longer tolerated for python/__pycache__; .pytest_cache/.flaky_counter tolerance + operator-notes checks remain", () => {
    const lite = readBuilder("tt-poly-lite/build-golden.sh");

    // The tolerated-absence loop now covers ONLY the regenerated junk
    // (.pytest_cache, .flaky_counter) — python/__pycache__ is not in it.
    assert.ok(
      /for junk_path in "python\/\.pytest_cache" "python\/\.flaky_counter"; do/.test(lite),
      "tt-poly-lite [6c] tolerated-absence loop must cover only .pytest_cache and .flaky_counter",
    );
    assert.ok(
      !/for junk_path in "python\/__pycache__"/.test(lite),
      "tt-poly-lite [6c] must NOT have a tolerated-absence loop entry for python/__pycache__",
    );
    // The old interpreter-dependence generation comment is gone.
    assert.ok(
      !lite.includes("run a quick test cycle to generate them"),
      "tt-poly-lite [6c] must not regenerate __pycache__ via an interpreter test cycle",
    );

    // Missing marker must be a hard fail (exit 1), never a tolerated absence.
    assert.ok(
      lite.includes("MISSING — seeded junk absent (probe weakened)!"),
      "tt-poly-lite [6c] must hard-fail on a missing seeded marker",
    );

    // .pytest_cache / .flaky_counter absence stays tolerated.
    assert.ok(
      /for junk_path in "python\/\.pytest_cache" "python\/\.flaky_counter"; do/.test(lite),
      "tt-poly-lite [6c] must keep the .pytest_cache / .flaky_counter tolerated loop",
    );
    assert.ok(
      lite.includes("python/.pytest_cache\" \"python/.flaky_counter"),
      "tt-poly-lite [6c] must keep both regenerated junk paths",
    );

    // operator-notes.local checks remain in both builders.
    for (const rel of BUILDERS) {
      assert.ok(
        readBuilder(rel).includes("operator-notes.local"),
        `${rel} must keep the operator-notes.local checks`,
      );
    }
  });

  it("AC4: the reference payload is EXCLUDED from every golden commit (tar --exclude='__pycache__')", () => {
    for (const rel of BUILDERS) {
      const src = readBuilder(rel);
      assert.ok(
        src.includes("--exclude='__pycache__'"),
        `${rel} Phase-1 tar must exclude __pycache__ from the golden commit`,
      );
      assert.ok(
        src.includes("--exclude='operator-notes.local'"),
        `${rel} Phase-1 tar must still exclude operator-notes.local`,
      );
    }
  });

  it("AC5: the reference filename can never collide with an importable module name", () => {
    const name = "junk-probe.synthetic";
    assert.ok(!name.endsWith(".pyc"), "marker filename must not look like a pyc module artifact");
    assert.ok(
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
      "marker filename must not be a valid module identifier",
    );
    assert.ok(name.includes("-"), "marker filename must carry a non-identifier char (hyphen)");
  });
});

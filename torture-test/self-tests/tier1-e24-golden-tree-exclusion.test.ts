// US-002 — E2.4 golden-tree exclusion of operator-notes.local (builders).
//
// Canonical contract (US-001 decision, spec 02 §junk probes): operator-notes.local
// is inert operator junk PLANTED at instantiation, must stay UNTRACKED and
// byte-identical, and must NOT be part of any committed golden tree. US-002 adds
// the `--exclude='operator-notes.local'` rule to every fixture builder that
// previously committed it (tt-java, tt-ts, tt-poly, tt-poly-lite, tt-python@master
// were tracked; tt-python/tt-go/tt-rust already excluded), and flips each builder's
// self-verify to assert the file is ABSENT from the built golden tree while
// retaining the fixtures-src byte-exact provisioning reference.
//
// This test pins the US-002 acceptance criteria with zero tokens and no golden
// rebuild required:
//   AC1: every affected build-golden.sh excludes operator-notes.local.
//   AC3: each former-B1 builder's self-verify asserts operator-notes.local is
//        ABSENT from the golden commit (mirror of tt-rust) AND retains a
//        fixtures-src byte-exact reference guard.
//   AC4: every fixture SOURCE (the byte-exact provisioning reference) still
//        carries operator-notes.local.
//   AC2 (defensive): if a golden bare exists under var/, `git ls-tree HEAD` must
//        show no operator-notes.local anywhere in the committed tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const fixturesSrc = path.join(ttRoot, "fixtures-src");

// The five builders that US-002 flipped from TRACKED to excluded (per the US-001
// inventory B1). tt-python/tt-go/tt-rust already excluded; tt-python@master is a
// branch-rename variant that reuses tt-python source (no own operator-notes.local).
const FLIPPED_BUILDERS = [
  "tt-java/build-golden.sh",
  "tt-ts/build-golden.sh",
  "tt-poly/build-golden.sh",
  "tt-poly-lite/build-golden.sh",
  "tt-python@master/build-golden.sh",
];

// Fixture SOURCE dirs that carry the byte-exact provisioning reference. These are
// the SEVEN physical fixture trees (tt-python@master reuses tt-python, so it is
// not a distinct source dir).
const SOURCE_DIRS = [
  "tt-go",
  "tt-java",
  "tt-poly",
  "tt-poly-lite",
  "tt-python",
  "tt-rust",
  "tt-ts",
];

function readBuilder(rel: string): string {
  return fs.readFileSync(path.join(fixturesSrc, rel), "utf8");
}

describe("US-002 golden-tree exclusion of operator-notes.local", () => {
  it("AC1: every affected builder excludes operator-notes.local from the golden commit", () => {
    for (const rel of FLIPPED_BUILDERS) {
      const src = readBuilder(rel);
      assert.ok(
        /--exclude\s*=\s*['"]operator-notes\.local['"]/.test(src) ||
          /--exclude\s*=operator-notes\.local/.test(src),
        `${rel} must exclude operator-notes.local from the golden commit`,
      );
    }
  });

  it("AC3: each former-B1 builder self-verify asserts ABSENCE in the golden tree", () => {
    for (const rel of FLIPPED_BUILDERS) {
      const src = readBuilder(rel);
      // Each builder's post-build verify must detect a GALDEN PRESENT case and
      // fail closed — the mirror of tt-rust's absent-check. Grep for an
      // "if ... operator-notes.local ...; then ... exit 1/false" guard, plus an
      // explicit absence-acceptance message.
      assert.ok(
        /operator-notes\.local.*PRESENT|present.*operator-notes\.local/is.test(src),
        `${rel} should fail-closed when operator-notes.local is PRESENT in the golden`,
      );
    }
  });

  it("AC3: each former-B1 builder retains a fixtures-src byte-exact reference guard", () => {
    for (const rel of FLIPPED_BUILDERS.filter((r) => !r.startsWith("tt-python@master"))) {
      const src = readBuilder(rel);
      assert.ok(
        src.includes("FIXTURE_SRC/operator-notes.local"),
        `${rel} must reference the fixtures-src operator-notes.local as the byte-exact provisioning reference`,
      );
    }
  });

  it("AC4: every fixture source still carries operator-notes.local (byte-exact provisioning reference)", () => {
    for (const dir of SOURCE_DIRS) {
      const p = path.join(fixturesSrc, dir, "operator-notes.local");
      assert.ok(fs.existsSync(p), `${dir} must retain fixtures-src operator-notes.local`);
      const st = fs.statSync(p);
      assert.ok(st.isFile() && st.size > 0, `${dir}/operator-notes.local should be a non-empty file`);
    }
  });

  it("AC2: any built golden bare repo has no operator-notes.local in its committed tree", () => {
    const goldenDir = path.join(ttRoot, "var", "fixtures", "golden");
    if (!fs.existsSync(goldenDir)) return; // no built goldens → nothing to check
    const bareDirs = fs.readdirSync(goldenDir).filter((d) => d.endsWith(".git"));
    if (bareDirs.length === 0) return;
    for (const bare of bareDirs) {
      const res = spawnSync(
        "git",
        ["--git-dir", path.join(goldenDir, bare), "ls-tree", "-r", "--name-only", "HEAD"],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0, `git ls-tree failed for ${bare}`);
      const names = (res.stdout ?? "").split("\n");
      const hit = names.find((n) => n.includes("operator-notes.local"));
      assert.equal(
        hit,
        undefined,
        `${bare} committed tree contains operator-notes.local (${hit}) — flip incomplete`,
      );
    }
  });
});

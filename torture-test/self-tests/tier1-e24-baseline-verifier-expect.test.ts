// US-007 — E2.4 zero-token battery: baseline verifier `--expect` closure.
//
// The US-007 story ("Full zero-token battery green") requires the baseline
// verifier gate `tt-verify-fixture-baselines --expect ...` to be green for
// every expected fixture BEFORE any real launch. The library-level
// verifyGoldenBare (used by tt-golden-bootstrap) is already pinned by
// tier1-e24-regenerated-goldens.test.ts; this test pins the ACTUAL CLI binary
// end-to-end so the deletion/absence oracles keep firing and the corrected
// canonical contract (operator-notes.local ABSENT from every committed golden
// tree, untracked-in-clone) holds at the command boundary too.
//
// Zero tokens, hermetically read-only against var/fixtures/golden: it never
// builds, never mutates the golden dir, and completes in milliseconds, so it is
// safe inside self-tests/run.sh (which also requires the golden dir to be
// byte-stable across runs).
//
//   AC1: tt-verify-fixture-baselines --expect <all 8 fixtures> exits 0.
//   AC2: the emitted evidence JSON reports result PASS, passed==8, failed==0
//        and every expected fixture present in the checked set.
//   AC3: the verifier is read-only — running it does not change the golden dir.
//   AC4: fixtures-src retains a byte-exact operator-notes.local provisioning
//        reference for every fixture that owns one (tt-python@master reuses the
//        shared tt-python source, so its reference lives there).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { KNOWN_FIXTURES } from "../bin/tt-golden-bootstrap.mjs";

// Resolve the torture-test/ root from this file's own location so the test is
// cwd-independent (run.sh sets cwd to the repo root, but a direct invocation
// from elsewhere must still resolve correctly).
const selfDir = path.dirname(fileURLToPath(import.meta.url));
const ttRoot = path.resolve(selfDir, "..");
const goldenDir = path.join(ttRoot, "var", "fixtures", "golden");
const verifier = path.join(ttRoot, "bin", "tt-verify-fixture-baselines");

// Fixtures that carry their own fixtures-src operator-notes.local provisioning
// reference. tt-python@master's builder reuses ../tt-python, so it has no source
// file of its own and is intentionally NOT listed here (tier1-e24-all-fixture
// -provision falls back to the shared tt-python source for it).
const SOURCE_REF_FIXTURES = KNOWN_FIXTURES.filter((f) => f !== "tt-python@master");

function runExpect(): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(
    verifier,
    ["--expect", KNOWN_FIXTURES.join(",")],
    { encoding: "utf8", cwd: ttRoot },
  );
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function snapshotGoldenDir(): string {
  return spawnSync(
    "find",
    [goldenDir, "-type", "f", "-exec", "sha256sum", "{}", ";"],
    { encoding: "utf8" },
  ).stdout ?? "";
}

describe("US-007 baseline verifier --expect zero-token closure", () => {
  it("AC1: tt-verify-fixture-baselines --expect (all 8 fixtures) exits 0", () => {
    const { code, stderr } = runExpect();
    assert.equal(
      code,
      0,
      `baseline verifier must exit 0 for the ${KNOWN_FIXTURES.length} expected fixtures; got ${code}\nstderr: ${stderr.slice(-800)}`,
    );
  });

  it("AC2: evidence JSON reports result PASS with all fixtures matched and zero failures", () => {
    const { code, stdout } = runExpect();
    assert.equal(code, 0, "verifier must exit 0");
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(stdout);
    } catch {
      assert.fail(`verifier stdout must be JSON evidence:\n${stdout.slice(0, 500)}`);
    }

    assert.strictEqual(ev.result, "PASS", `verifier must report result PASS`);
    assert.strictEqual(ev.total, KNOWN_FIXTURES.length);
    assert.strictEqual(ev.passed, KNOWN_FIXTURES.length);
    assert.strictEqual(ev.failed, 0);

    const fixtures = (ev.fixtures ?? []) as Array<{ name: string; result: string; hash_check?: { failures?: unknown[] } }>;
    for (const f of fixtures) {
      assert.equal(f.result, "PASS", `fixture ${f.name} must verify PASS`);
      assert.deepEqual(f.hash_check?.failures ?? [], [], `fixture ${f.name} must have zero hash failures`);
    }
    // Every expected fixture is actually present in the checked set.
    for (const name of KNOWN_FIXTURES) {
      assert.ok(
        fixtures.some((f) => f.name === `${name}.git` || f.name === name),
        `expected fixture ${name} must appear in the verified set`,
      );
    }
  });

  it("AC3: the verifier is read-only (golden dir unchanged by an --expect run)", () => {
    const before = snapshotGoldenDir();
    runExpect();
    const after = snapshotGoldenDir();
    assert.equal(after, before, "running the baseline verifier must not modify the golden dir");
  });

  it("AC4: every source-bearing fixture retains a byte-exact operator-notes.local provisioning reference", () => {
    for (const f of SOURCE_REF_FIXTURES) {
      const src = path.join(ttRoot, "fixtures-src", f, "operator-notes.local");
      assert.ok(fs.existsSync(src), `fixtures-src/${f}/operator-notes.local must exist as the provisioning reference`);
      assert.ok(
        fs.readFileSync(src, "utf8").trim().length > 0,
        `fixtures-src/${f}/operator-notes.local must be non-empty`,
      );
    }
  });
});

// US-006 — E2.4 regenerated goldens + hash-ledger consistency + determinism readiness.
//
// Story US-006 regenerates every affected golden bare and its determinism hash
// ledger EXACTLY ONCE (after the US-002/003/005 contract change) and proves
// determinism (two consecutive builds byte-identical). The working-tree goldens
// live under torture-test/var (gitignored, rebuilt by builders); this test pins
// the REGENERATED STATE so the corrected contract holds before any real launch.
//
// Zero tokens, no rebuild: it verifies the deterministic output already present
// in var/fixtures/golden. It is hermetic and never mutates the golden dir, so it
// is safe inside self-tests/run.sh (which also requires the golden dir to be
// byte-stable across runs).
//
//   AC1: every one of the SEVEN+ONE fixtures has a built golden bare in var.
//   AC2: every fixture has its canonical determinism hash ledger (FIXTURE_META).
//   AC3: every built golden bare verifies byte-exact against its recorded ledger
//        refs via tt-golden-bootstrap.verifyGoldenBare (regenerated exactly once
//        and consistent — a fresh build reproduces the same refs, so the ledger
//        is the regenerated one, not a stale pre-E2.4 record).
//   AC4: operator-notes.local is ABSENT from every built golden's committed tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { FIXTURE_META, KNOWN_FIXTURES, verifyGoldenBare } from "../bin/tt-golden-bootstrap.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const goldenDir = path.join(ttRoot, "var", "fixtures", "golden");

function lsTreeNoOperatorNotes(bare: string): string | null {
  const res = spawnSync(
    "git",
    ["--git-dir", path.join(goldenDir, bare), "ls-tree", "-r", "--name-only", "HEAD"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ls-tree failed for ${bare}: ${res.stderr}`);
  const names = (res.stdout ?? "").split("\n");
  return names.find((n) => n.includes("operator-notes.local")) ?? null;
}

describe("US-006 regenerated goldens + hash-ledger consistency", () => {
  it("AC1: all eight fixture golden bares exist in var/fixtures/golden", () => {
    const present = new Set(
      fs.readdirSync(goldenDir).filter((d) => d.endsWith(".git")),
    );
    for (const f of KNOWN_FIXTURES) {
      const bare = `${f}.git`;
      assert.ok(
        present.has(bare),
        `golden bare ${bare} must exist — run fixtures-src/${f}/build-golden.sh once (regenerated exactly once, US-006)`,
      );
    }
  });

  it("AC2: every fixture has its canonical determinism hash ledger", () => {
    for (const f of KNOWN_FIXTURES) {
      const meta = FIXTURE_META[f];
      const ledger = path.join(goldenDir, meta.hashFile);
      assert.ok(fs.existsSync(ledger), `ledger ${meta.hashFile} must exist for ${f}`);
      assert.ok(
        fs.readFileSync(ledger, "utf8").trim().length > 0,
        `ledger ${meta.hashFile} for ${f} should not be empty`,
      );
    }
  });

  it("AC3: every built golden bare verifies byte-exact against its recorded ledger", () => {
    for (const f of KNOWN_FIXTURES) {
      const verdict = verifyGoldenBare({ fixture: f, goldenDir });
      assert.ok(
        verdict.ok,
        `verifyGoldenBare(${f}) must pass (golden is consistent with its regenerated ledger): `
          + JSON.stringify(verdict.reason ?? verdict),
      );
      // The baseline must be a real current branch (merge workflows need it).
      assert.ok(
        typeof verdict.baselineBranch === "string" && verdict.baselineBranch.length > 0,
        `${f} should report a baseline branch`,
      );
    }
  });

  it("AC4: operator-notes.local is absent from every built golden committed tree", () => {
    for (const f of KNOWN_FIXTURES) {
      const hit = lsTreeNoOperatorNotes(`${f}.git`);
      assert.equal(
        hit,
        null,
        `${f} golden committed tree must NOT contain operator-notes.local (canonical untracked-in-clone contract); found: ${hit}`,
      );
    }
  });
});

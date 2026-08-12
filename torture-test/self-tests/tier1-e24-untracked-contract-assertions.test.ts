// US-005 — E2.4 untracked-contract assertion flip (canonical junk-probe contract).
//
// Canonical contract (US-001 decision, spec 02 §junk probes): operator-notes.local
// is inert operator junk PLANTED at provisioning into EVERY WORK CLONE as present +
// UNTRACKED + byte-identical to the fixture source; it must NOT be part of any
// committed golden tree. US-002 excluded it from every builder's golden commit,
// US-003 hardened provisioning, and US-005 flips EVERY remaining tracked-path
// assertion (scripts + docs) to the canonical untracked+present contract without
// weakening any no-commit/no-delete/modify oracle.
//
// This test pins the US-005 acceptance criteria with zero tokens and no golden
// rebuild required:
//   AC1: ZERO tracked-path assertions remain for operator-notes.local anywhere
//        under torture-test/ (excluding generated var/), except the intentional
//        fail-closed tracked-detection sites (tt-fixture-provision.mjs oracle and
//        tier1-e24-all-fixture-provision.test.ts) which MUST keep firing.
//   AC2: the fixture e2e validation scripts (tt-java, tt-python validate-e2e.sh)
//        assert operator-notes.local is present + UNTRACKED + byte-identical to
//        the fixture source (no "committed version" tracked-path phrasing).
//   AC3: fixture docs no longer describe operator-notes.local as "committed".
//   AC4: every fixture source retains the byte-exact operator-notes.local
//        provisioning reference (never delete the source artifact).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const fixturesSrc = path.join(ttRoot, "fixtures-src");

// Tracked-path phrasings that were correct only under the OLD (tracked-in-golden)
// reading. Under the canonical untracked contract none should co-occur with
// operator-notes.local anywhere except where we intentionally discuss the flip
// (the decision doc) or intentionally test tracked-detection.
const TRACKED_PHRASES = [
  /matches the committed version/,
  /byte-identical to committed version/,
  /committed sampler reference/,
  /should be tracked/,
];

// Intentional tracked-detection / decision sites that legitimately contain the
// phrase "tracked" alongside operator-notes.local (fail-closed oracles, decision
// narrative). These must remain.
const INTENTIONAL_TRACKED_FILES = [
  "bin/tt-fixture-provision.mjs",
  "self-tests/tier1-e24-all-fixture-provision.test.ts",
  "self-tests/tier1-e24-junk-contract-inventory.test.ts",
  "impl-tasks/E2.4-junk-probe-provisioning-contract.md",
  "cases/tier1-traceability.md",
];

// Physical fixture SRC dirs that carry the byte-exact provisioning reference.
const SOURCE_DIRS = [
  "tt-go",
  "tt-java",
  "tt-poly",
  "tt-poly-lite",
  "tt-python",
  "tt-rust",
  "tt-ts",
];

function nonVarFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "var" || ent.name === "node_modules" || ent.name === ".git") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(path.relative(ttRoot, p));
    }
  };
  walk(ttRoot);
  return out;
}

describe("US-005 untracked-contract assertion flip (operator-notes.local)", () => {
  it("AC1: ZERO tracked-path assertions remain for operator-notes.local (except intentional tracked-detection sites)", () => {
    const remaining: string[] = [];
    for (const file of nonVarFiles()) {
      const text = fs.readFileSync(path.join(ttRoot, file), "utf8");
      if (!text.includes("operator-notes")) continue;
      for (const line of text.split("\n")) {
        if (!line.includes("operator-notes")) continue;
        for (const re of TRACKED_PHRASES) {
          if (re.test(line)) {
            // The decision doc legitimately records both sides of the historical
            // mismatch; skip it (it documents the flip, it does not assert it).
            if (file.startsWith("impl-tasks/E2.4")) continue;
            remaining.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    assert.deepEqual(
      remaining,
      [],
      `tracked-path assertions remain for operator-notes.local:\n${remaining.join("\n")}`,
    );
  });

  it("AC2: fixture e2e validation scripts assert present + UNTRACKED + byte-exact (no committed-version phrasing)", () => {
    for (const rel of ["tt-java/validate-e2e.sh", "tt-python/validate-e2e.sh"]) {
      const src = fs.readFileSync(path.join(fixturesSrc, rel), "utf8");
      assert.ok(src.includes("operator-notes.local"), `${rel} must reference operator-notes.local`);
      assert.ok(
        /fixture source \(provisioning ref\)/.test(src) ||
          /fixture source \(provisioning reference\)/.test(src),
        `${rel} must assert operator-notes.local is byte-identical to the fixture source (not a committed version)`,
      );
      assert.ok(
        /ls-files --error-unmatch operator-notes\.local/.test(src),
        `${rel} must assert operator-notes.local is UNTRACKED via git ls-files (no-commit oracle intact)`,
      );
      assert.ok(
        !src.includes("byte-identical to committed version"),
        `${rel} must not assert operator-notes.local is byte-identical to a committed version`,
      );
    }
  });

  it("AC3: fixture docs no longer describe operator-notes.local as committed", () => {
    const docs = nonVarFiles().filter((f) => f.endsWith(".md") && f.includes("fixtures-src"));
    for (const file of docs) {
      const text = fs.readFileSync(path.join(ttRoot, file), "utf8");
      if (!text.includes("operator-notes")) continue;
      for (const re of [/matches the committed version/, /committed sampler reference/]) {
        assert.ok(
          !re.test(text),
          `${file} still describes operator-notes.local as committed: ${text
            .split("\n")
            .find((l) => re.test(l))}`,
        );
      }
    }
  });

  it("AC4: every fixture source still carries the byte-exact operator-notes.local provisioning reference", () => {
    for (const dir of SOURCE_DIRS) {
      const p = path.join(fixturesSrc, dir, "operator-notes.local");
      assert.ok(fs.existsSync(p), `${dir} must retain fixtures-src operator-notes.local`);
      assert.ok(fs.statSync(p).isFile() && fs.statSync(p).size > 0, `${dir}/operator-notes.local must be non-empty`);
    }
  });

  it("AC5: the intentional tracked-detection oracle still fires (operator-notes-tracked present in provisioning)", () => {
    const provision = fs.readFileSync(path.join(ttRoot, "bin", "tt-fixture-provision.mjs"), "utf8");
    assert.ok(
      provision.includes("operator-notes-tracked") && provision.includes("ls-files"),
      "tt-fixture-provision.mjs must retain the fail-closed operator-notes-tracked oracle",
    );
    for (const f of INTENTIONAL_TRACKED_FILES) {
      const p = path.join(ttRoot, f);
      assert.ok(fs.existsSync(p), `intentional tracked site exists: ${f}`);
    }
  });

  it("AC6: git ls-tree HEAD on any built golden shows no operator-notes.local (defensive)", () => {
    const goldenDir = path.join(ttRoot, "var", "fixtures", "golden");
    if (!fs.existsSync(goldenDir)) return;
    const bareDirs = fs.readdirSync(goldenDir).filter((d) => d.endsWith(".git"));
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
        `${bare} committed tree contains operator-notes.local (${hit}) — tracked golden remains`,
      );
    }
  });
});

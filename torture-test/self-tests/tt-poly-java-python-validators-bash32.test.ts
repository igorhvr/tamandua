// tt-poly-java-python-validators-bash32.test.ts
// US-004 — bash-3.2 rewrite of the tt-java and tt-python end-to-end fixture
// validators (validate-e2e.sh).
//
// macOS /bin/bash 3.2.57 has no associative arrays (`declare -A` is a
// bash 4+ feature), so the validators' SEED_EXPECT_GREEN / SEED_SYMPTOMS
// maps (and tt-python's PATCH_LEVEL map) were replaced by bash-3.2-safe
// case-table lookup functions: seed_expect_green(), seed_symptoms(), and
// patch_level(). The expected-green bits and symptom strings are
// byte-identical to the old maps.
//
// tt-python PATCH_LEVEL correction (documented in the validator itself):
// the old map encoded BUG-P3/BUG-P4 as -p0, which matched the pre-2026-07-30
// plain `--- src/...` fix.patch format. The fix.patches were regenerated to
// git-style `--- b/src/...` headers (commit 0ea00756) without updating the
// map, so Phase 5's fix-patch application silently failed for BUG-P3/BUG-P4
// (-p0 cannot resolve the b/ prefix) and the "fix restores GREEN" checks
// failed. patch_level() therefore returns -p1 for every seed — the level the
// committed git-style patches actually require — so the validator runs GREEN
// end-to-end (US-004 AC4).
//
// Fast tests (always on — picked up by self-tests/run.sh's tt-poly-* glob):
//   * zero `declare -A` in both validators
//   * `bash -n` passes for both
//   * no associative-style subscript reads remain (SEED_EXPECT_GREEN[...] etc.)
//   * function-level tests via the function-extraction harness (the TS
//     analogue of tt-run.test.sh's awk harness, established in
//     tt-poly-ts-java-builders-bash32.test.ts): for EVERY seed, assert the
//     expected-green bit, the byte-identical symptom string, and (tt-python)
//     the patch level.
//   * unknown-seed behavior: tt-python seed_expect_green defaults to 0
//     (matching the old ${map[$id]:-0} read semantics); all other lookups
//     fail loudly.
//
// Heavy battery (gated behind TT_JAVA_PY_VALIDATOR_INTEGRATION=1): the
// tt-java builder determinism pass — two consecutive builds into a fresh
// isolated temp TORTURE_GOLDEN_DIR produce byte-identical golden dirs with
// the second build self-reporting IDENTICAL, and a well-formed hash ledger.
// (tt-java's full validator is maven-heavy, so its function-level tests plus
// this single isolated build determinism pass are the US-004 proof; the
// tt-python validator is run end-to-end as the story's AC4 step.)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const fixturesSrc = path.join(repoRoot, "torture-test", "fixtures-src");

const VALIDATORS = ["tt-java", "tt-python"] as const;

function validatorPath(fixture: string): string {
  return path.join(fixturesSrc, fixture, "validate-e2e.sh");
}

// NODE_TEST_CONTEXT causes tsx --test (used by the ts fixture suite's npm
// test) to silently skip all tests, making broken tests appear green. Strip
// it from the environment when spawning bash. Also strip TAMANDUA_TEST_GUARD
// (tamandua test isolation guard) — the validators don't need tamandua state.
const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k === "TAMANDUA_TEST_GUARD") continue;
    env[k] = v;
  }
  return env;
})();

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ? { ...CLEAN_ENV, ...opts.env } : CLEAN_ENV,
    encoding: "utf8",
    timeout: opts.timeout,
  });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

// ── bash-3.2 function-extraction harness ──────────────────────────
// Pulls the body of a top-level `name() { ... }` function (closing `}` at
// column 0) out of a shell script and sources it in a clean bash — the TS
// analogue of tt-run.test.sh's awk-extraction harness.
function extractFunction(src: string, name: string): string {
  const lines = src.split("\n");
  const sig = `${name}() {`;
  const start = lines.findIndex((l) => l.trim() === sig);
  assert.notEqual(start, -1, `function ${name}() not found in source`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      return lines.slice(start, i + 1).join("\n");
    }
  }
  assert.fail(`function ${name}() has no closing brace`);
}

function runSnippet(snippet: string, call: string): { status: number; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash32-validator-fn-"));
  const snippetPath = path.join(dir, "fns.sh");
  try {
    fs.writeFileSync(snippetPath, snippet);
    const result = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\n. "${snippetPath}"\n${call}`],
      { encoding: "utf8" },
    );
    return {
      status: result.status ?? -1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function lookupSnippet(src: string, names: string[]): string {
  return names.map((n) => extractFunction(src, n)).join("\n");
}

// ── Documented seed metadata (byte-identical to the pre-rewrite maps) ──
const PYTHON_EXPECT_GREEN: Array<[string, string]> = [
  ["BUG-P1", "1"], // A1: dormant bug, no regression test exists yet
  ["BUG-P2", "0"], // RED (absent from the green map)
  ["BUG-P3", "0"], // RED (absent from the green map)
  ["BUG-P4", "0"], // RED (absent from the green map)
  ["VULN-P1", "1"], // dormant code path
  ["VULN-P2", "1"], // dormant code path
];

const PYTHON_SYMPTOMS: Array<[string, string]> = [
  ["BUG-P1", "A1 dormant off-by-one — GREEN (no test covers count+until)"],
  ["BUG-P2", "A2 two-module bug — RED (yearly interval + CONTAINED boundary)"],
  ["BUG-P3", "A3 red-herring — RED (is_weekday Saturday bug)"],
  ["BUG-P4", "A4 performance — RED (threshold timeout > 2.0s)"],
  ["VULN-P1", "yaml.load dormant — GREEN"],
  ["VULN-P2", "shell=True dormant — GREEN"],
];

const PYTHON_PATCH_LEVEL: Array<[string, string]> = [
  ["BUG-P1", "1"],
  ["BUG-P2", "1"],
  ["BUG-P3", "1"], // US-004 correction: git-style fix.patch needs -p1
  ["BUG-P4", "1"], // US-004 correction: git-style fix.patch needs -p1
  ["VULN-P1", "1"],
  ["VULN-P2", "1"],
];

const JAVA_EXPECT_GREEN: Array<[string, string]> = [
  ["BUG-J1", "0"], // RED: 12 failures in MoneyUtilsTest round tests
  ["BUG-J2", "0"], // RED: 3 failures across CsvParser + LedgerService
  ["BUG-J3", "0"], // RED: 15 failures across CsvParser + CliApp
  ["BUG-J4", "1"], // GREEN: O(n²) dormant on small datasets
  ["VULN-J1", "1"], // GREEN: dormant code path
  ["VULN-J2", "1"], // GREEN: dormant code path
  ["BRK-J1", "0"], // RED: 1 assertion failure
  ["BRK-J2", "0"], // RED: 1 assertion failure
];

const JAVA_SYMPTOMS: Array<[string, string]> = [
  ["BUG-J1", "A1 off-by-one rounding — RED (12 MoneyUtilsTest failures)"],
  ["BUG-J2", "A2 two-module NPE on empty CSV — RED (3 failures across CsvParser + LedgerService)"],
  ["BUG-J3", "A3 red-herring column swap — RED (15 failures across CsvParser + CliApp)"],
  ["BUG-J4", "A4 O(n²) performance — GREEN (dormant on small datasets)"],
  ["VULN-J1", "XXE dormant — GREEN"],
  ["VULN-J2", "path traversal dormant — GREEN"],
  ["BRK-J1", "broken assertion (450 vs 475) — RED"],
  ["BRK-J2", "broken assertion (groceries vs food) — RED"],
];

describe("tt-java / tt-python validators — bash-3.2 rewrite (US-004)", () => {
  for (const fixture of VALIDATORS) {
    const vp = validatorPath(fixture);
    const src = fs.readFileSync(vp, "utf-8");
    const greenTable = fixture === "tt-java" ? JAVA_EXPECT_GREEN : PYTHON_EXPECT_GREEN;
    const symptomsTable = fixture === "tt-java" ? JAVA_SYMPTOMS : PYTHON_SYMPTOMS;

    describe(`fixture ${fixture}`, () => {
      it("contains no declare -A (associative arrays are a bash 4+ feature)", () => {
        assert.ok(
          !/declare\s+-A\b/.test(src),
          `${fixture}/validate-e2e.sh must not use declare -A`,
        );
      });

      it("passes bash -n", () => {
        const result = run("bash", ["-n", vp]);
        assert.equal(result.status, 0, `bash -n failed: ${result.stderr}`);
      });

      it("has no associative-style subscript reads of the former maps", () => {
        // The associative-array pattern being eliminated was
        // SEED_EXPECT_GREEN["key"] / SEED_SYMPTOMS["key"] / PATCH_LEVEL["key"].
        assert.ok(
          !/SEED_EXPECT_GREEN\[/.test(src) &&
            !/SEED_SYMPTOMS\[/.test(src) &&
            !/PATCH_LEVEL\[/.test(src),
          `no associative subscript reads of the former maps may remain in ${fixture}/validate-e2e.sh`,
        );
      });

      it("defines the 3.2-safe lookup functions", () => {
        for (const needle of ["seed_expect_green() {", "seed_symptoms() {"]) {
          assert.ok(src.includes(needle), `should define ${needle}`);
        }
        if (fixture === "tt-python") {
          assert.ok(src.includes("patch_level() {"), "tt-python should define patch_level()");
        }
      });

      it("seed_expect_green returns the documented green bit for every seed", () => {
        const snippet = lookupSnippet(src, ["seed_expect_green"]);
        for (const [seed, bit] of greenTable) {
          const r = runSnippet(snippet, `seed_expect_green "${seed}"`);
          assert.equal(r.status, 0, `seed_expect_green ${seed} failed: ${r.stderr}`);
          assert.equal(r.stdout.trim(), bit, `seed_expect_green ${seed} mismatch`);
        }
      });

      it("seed_symptoms returns the byte-identical documented symptom string for every seed", () => {
        const snippet = lookupSnippet(src, ["seed_symptoms"]);
        for (const [seed, symptom] of symptomsTable) {
          const r = runSnippet(snippet, `seed_symptoms "${seed}"`);
          assert.equal(r.status, 0, `seed_symptoms ${seed} failed: ${r.stderr}`);
          assert.equal(r.stdout.trim(), symptom, `seed_symptoms ${seed} mismatch`);
        }
      });

      it("unknown seeds behave like the old map reads", () => {
        const greenSnippet = lookupSnippet(src, ["seed_expect_green"]);
        const symptomsSnippet = lookupSnippet(src, ["seed_symptoms"]);
        if (fixture === "tt-python") {
          // Old read was ${SEED_EXPECT_GREEN[$id]:-0} — unknown → 0 (RED).
          const r = runSnippet(greenSnippet, 'seed_expect_green DOES-NOT-EXIST');
          assert.equal(r.status, 0, "python seed_expect_green unknown seed must not fail");
          assert.equal(r.stdout.trim(), "0", "python seed_expect_green unknown seed must default to 0");
        } else {
          // Old read was ${SEED_EXPECT_GREEN[$id]} — unknown would have been
          // an unbound-variable abort; fail loudly instead.
          const r = runSnippet(greenSnippet, 'seed_expect_green DOES-NOT-EXIST');
          assert.notEqual(r.status, 0, "java seed_expect_green with an unknown key must fail");
        }
        const unknownSymptoms = runSnippet(symptomsSnippet, "seed_symptoms DOES-NOT-EXIST");
        assert.notEqual(unknownSymptoms.status, 0, "seed_symptoms with an unknown key must fail");
      });

      if (fixture === "tt-python") {
        it("patch_level returns the corrected -p1 level for every seed", () => {
          const snippet = lookupSnippet(src, ["patch_level"]);
          for (const [seed, level] of PYTHON_PATCH_LEVEL) {
            const r = runSnippet(snippet, `patch_level "${seed}"`);
            assert.equal(r.status, 0, `patch_level ${seed} failed: ${r.stderr}`);
            assert.equal(r.stdout.trim(), level, `patch_level ${seed} mismatch`);
          }
          const unknown = runSnippet(snippet, "patch_level DOES-NOT-EXIST");
          assert.notEqual(unknown.status, 0, "patch_level with an unknown key must fail");
        });
      }
    });
  }
});

// ── Heavy tt-java builder determinism pass (gated) ────────────────
// US-004: tt-java's full validator is maven-heavy, so its function-level
// tests plus a single isolated build determinism pass are sufficient. Two
// consecutive builds into a fresh isolated temp TORTURE_GOLDEN_DIR must
// produce byte-identical golden dirs (bare repo + hash ledger), with the
// second build self-reporting IDENTICAL.
const INTEGRATION = process.env.TT_JAVA_PY_VALIDATOR_INTEGRATION === "1";

function fingerprintGoldenDir(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  files.sort();
  const parts = files
    .filter((f) => {
      const base = path.basename(f);
      return (
        !f.includes(".scratch") &&
        !base.startsWith(".hashes") &&
        !base.startsWith("tmp.build-golden")
      );
    })
    .map(
      (f) =>
        `${path.relative(dir, f)}:${createHash("sha256").update(fs.readFileSync(f)).digest("hex")}`,
    );
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function makeScratchDir(prefix: string): string {
  const parent = path.join(repoRoot, "torture-test", "var", "self-tests");
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

describe(
  "tt-java validator build determinism pass (US-004)",
  { skip: !INTEGRATION },
  () => {
    it("tt-java: two consecutive isolated builds byte-identical + IDENTICAL self-report", function () {
      this.timeout = 90 * 60 * 1000; // maven-heavy — up to 90 min
      const bp = path.join(fixturesSrc, "tt-java", "build-golden.sh");
      const postDir = makeScratchDir("us004-java-");
      const golden = path.join(postDir, "golden");

      let result = run("bash", [bp], { env: { TORTURE_GOLDEN_DIR: golden }, timeout: 90 * 60 * 1000 });
      assert.equal(result.status, 0, `build 1 failed:\n${result.stdout}`);
      const ledger1 = fs.readFileSync(path.join(golden, "tt-java.git.hashes"), "utf-8");
      const fp1 = fingerprintGoldenDir(golden);

      result = run("bash", [bp], { env: { TORTURE_GOLDEN_DIR: golden }, timeout: 90 * 60 * 1000 });
      assert.equal(result.status, 0, `build 2 failed:\n${result.stdout}`);
      assert.match(
        result.stdout,
        /Hash stability: IDENTICAL/,
        "second build must self-report Hash stability: IDENTICAL",
      );
      const ledger2 = fs.readFileSync(path.join(golden, "tt-java.git.hashes"), "utf-8");
      const fp2 = fingerprintGoldenDir(golden);

      assert.equal(ledger1, ledger2, "two consecutive builds must produce identical hash ledgers");
      assert.equal(fp1, fp2, "two consecutive builds must produce byte-identical golden dirs");
      // Baseline + every seed ref must carry 40-hex SHAs.
      const refLines = ledger1.split(/\r?\n/).filter((l) => l.trim() !== "");
      assert.ok(refLines.length >= 9, `ledger should carry baseline + 8 seed refs, got ${refLines.length}`);
      for (const line of refLines) {
        assert.match(line, /[0-9a-f]{40}/, `ledger line must carry a 40-hex SHA: ${line}`);
      }

      fs.rmSync(postDir, { recursive: true, force: true });
    });
  },
);

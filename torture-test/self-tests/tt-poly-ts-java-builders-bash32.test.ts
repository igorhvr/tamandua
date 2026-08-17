// tt-poly-ts-java-builders-bash32.test.ts
// US-003 — bash-3.2 rewrite of the tt-ts and tt-java golden builders.
//
// macOS /bin/bash 3.2.57 has no associative arrays (`declare -A` is a
// bash 4+ feature), so the builders' SEED_SHAS / BUG_SYMPTOMS maps were
// replaced by bash-3.2-safe constructs: a parallel-array seed registry
// (SEED_IDS + SEED_SHAS with seed_sha_set()/seed_sha() helpers) and a
// case-table bug_symptoms() lookup. Script mechanics only — the recorded
// seed_id -> SHA pairs and the symptom strings are byte-identical to the
// old maps, so produced golden trees and hash ledgers are unchanged.
//
// Fast tests (always on — part of self-tests/run.sh):
//   * zero `declare -A` in both builders
//   * `bash -n` passes for both
//   * no associative-style quoted-key subscript writes remain
//   * the 3.2-safe helpers are present and behave correctly (functions
//     extracted and sourced, mirroring tt-run.test.sh's awk harness)
//
// Heavy determinism battery (gated behind TT_TS_JAVA_BUILDER_INTEGRATION=1,
// exactly like TT_POLY_LITE_INTEGRATION — runs the real builders twice per
// fixture plus one pre-rewrite build, so it is minutes-long):
//   * two consecutive builds into a fresh isolated temp TORTURE_GOLDEN_DIR
//     produce byte-identical golden dirs, with the second build
//     self-reporting IDENTICAL
//   * the post-rewrite hash ledger equals the ledger produced by the
//     pre-rewrite builder (extracted via `git show HEAD:<path>` into a temp
//     fixture copy) — proving no committed-tree change
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const fixturesSrc = path.join(repoRoot, "torture-test", "fixtures-src");

const BUILDERS = [
  { fixture: "tt-ts", hashFile: "tt-ts.git.hashes" },
  { fixture: "tt-java", hashFile: "tt-java.git.hashes" },
] as const;

function builderPath(fixture: string): string {
  return path.join(fixturesSrc, fixture, "build-golden.sh");
}

// NODE_TEST_CONTEXT causes tsx --test (used by the ts fixture suite's npm
// test) to silently skip all tests, making broken tests appear green. Strip
// it from the environment when spawning the builders. Also strip
// TAMANDUA_TEST_GUARD (tamandua test isolation guard) — the golden builders
// don't need tamandua state.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash32-builder-fn-"));
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

function registrySnippet(src: string): string {
  return [
    "SEED_IDS=()",
    "SEED_SHAS=()",
    extractFunction(src, "seed_sha_set"),
    extractFunction(src, "seed_sha"),
  ].join("\n");
}

describe("tt-ts / tt-java golden builders — bash-3.2 rewrite (US-003)", () => {
  for (const { fixture } of BUILDERS) {
    const bp = builderPath(fixture);
    const src = fs.readFileSync(bp, "utf-8");

    describe(`fixture ${fixture}`, () => {
      it("contains no declare -A (associative arrays are a bash 4+ feature)", () => {
        assert.ok(
          !/declare\s+-A\b/.test(src),
          `${fixture}/build-golden.sh must not use declare -A`,
        );
      });

      it("passes bash -n", () => {
        const result = run("bash", ["-n", bp]);
        assert.equal(result.status, 0, `bash -n failed: ${result.stderr}`);
      });

      it("has no associative-style quoted-key subscript writes", () => {
        // Parallel indexed arrays legitimately read SEED_SHAS[$i]; the
        // associative-array pattern being eliminated was SEED_SHAS["key"].
        assert.ok(
          !/SEED_SHAS\["/.test(src),
          `no SEED_SHAS["key"] associative writes may remain in ${fixture}/build-golden.sh`,
        );
      });

      it("defines the 3.2-safe seed registry (parallel arrays + helpers)", () => {
        for (const needle of [
          "SEED_IDS=()",
          "SEED_SHAS=()",
          "seed_sha_set() {",
          "seed_sha() {",
        ]) {
          assert.ok(src.includes(needle), `should define ${needle}`);
        }
      });

      it("seed_sha_set/seed_sha round-trip: insert, overwrite, unknown key", () => {
        const snippet = registrySnippet(src);
        const r = runSnippet(
          snippet,
          [
            'seed_sha_set "BUG-T1" "aaa1111"',
            'seed_sha_set "VULN-T1" "bbb2222"',
            '[ "$(seed_sha BUG-T1)" = "aaa1111" ] || exit 9',
            '[ "$(seed_sha VULN-T1)" = "bbb2222" ] || exit 10',
            'seed_sha_set "BUG-T1" "ccc3333"',
            '[ "$(seed_sha BUG-T1)" = "ccc3333" ] || exit 11',
            "seed_sha DOES-NOT-EXIST && exit 12 || true",
            'echo "count=${#SEED_IDS[@]}"',
          ].join("\n"),
        );
        assert.equal(r.status, 0, `seed registry round-trip failed: ${r.stderr}`);
        assert.match(r.stdout, /count=2/);
      });

      if (fixture === "tt-ts") {
        it("bug_symptoms() case table returns the documented symptom strings", () => {
          const snippet = extractFunction(src, "bug_symptoms");
          const expectations: Array<[string, string]> = [
            ["BUG-T1", "off-by-one"],
            ["BUG-T2", "date-filter|date-range|getByDateRange"],
            ["BUG-T3", "order|ordering|position"],
            ["BUG-T4", "performance|threshold|under 50ms"],
            ["BRK-T1", "getTotal|sum|150"],
            ["BRK-T2", "201|200|status.*expected"],
          ];
          for (const [seed, symptom] of expectations) {
            const r = runSnippet(snippet, `bug_symptoms "${seed}"`);
            assert.equal(r.status, 0, `bug_symptoms ${seed} failed: ${r.stderr}`);
            assert.equal(r.stdout.trim(), symptom, `bug_symptoms ${seed} mismatch`);
          }
          const unknown = runSnippet(snippet, "bug_symptoms NOPE");
          assert.notEqual(unknown.status, 0, "bug_symptoms with an unknown key must fail");
        });
      }
    });
  }
});

// ── Heavy determinism battery (gated: TT_TS_JAVA_BUILDER_INTEGRATION=1) ──
const INTEGRATION = process.env.TT_TS_JAVA_BUILDER_INTEGRATION === "1";

function fingerprintGoldenDir(dir: string): string {
  // sha256 over every file's relative path + content, sorted by path —
  // mirrors verify-builder-determinism.test.sh's fingerprint() (scratch and
  // transient .hashes* files are excluded defensively; the builders' EXIT
  // traps normally clean them).
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

function runBuilder(bp: string, goldenDir: string): { status: number; stdout: string } {
  const result = run("bash", [bp], {
    env: { TORTURE_GOLDEN_DIR: goldenDir },
    timeout: 90 * 60 * 1000, // 90 min — npm install / mvnw test per seed
  });
  return { status: result.status, stdout: result.stdout };
}

// Temp fixture-src copy whose build-golden.sh is the PRE-rewrite version
// from HEAD (the state this branch is based on). Used to prove the
// post-rewrite builder produces an identical hash ledger. The golden dir is
// a SIBLING of the fixture copy: nesting it inside FIXTURE_SRC would make
// Phase 1's `tar -cf - .` sweep it into the baseline tree (and `git add -A`
// would then try to index the in-progress scratch repo).
function preRewriteFixtureCopy(fixture: string): { dir: string; bp: string; goldenDir: string } {
  const src = path.join(fixturesSrc, fixture);
  const dir = makeScratchDir(`bash32-pre-${fixture}-`);
  const cp = run("cp", ["-a", `${src}/.`, `${dir}/`]);
  assert.equal(cp.status, 0, `cp -a fixture failed: ${cp.stderr}`);
  const head = run("git", [
    "show",
    `HEAD:torture-test/fixtures-src/${fixture}/build-golden.sh`,
  ]);
  assert.equal(head.status, 0, `git show HEAD: build-golden.sh failed: ${head.stderr}`);
  const bp = path.join(dir, "build-golden.sh");
  fs.writeFileSync(bp, head.stdout);
  fs.chmodSync(bp, 0o755);
  const goldenDir = makeScratchDir(`bash32-pre-golden-${fixture}-`);
  return { dir, bp, goldenDir };
}

describe(
  "tt-ts / tt-java builder determinism battery (US-003)",
  { skip: !INTEGRATION },
  () => {
    for (const { fixture, hashFile } of BUILDERS) {
      it(`${fixture}: two consecutive builds byte-identical + pre-rewrite ledger parity`, function () {
        this.timeout = 90 * 60 * 1000;
        const bp = builderPath(fixture);

        // 1. Pre-rewrite build (HEAD version of the builder) → ledger A.
        const pre = preRewriteFixtureCopy(fixture);
        let result = runBuilder(pre.bp, pre.goldenDir);
        assert.equal(result.status, 0, `pre-rewrite build failed:\n${result.stdout}`);
        const preLedger = fs.readFileSync(path.join(pre.goldenDir, hashFile), "utf-8");
        const preFingerprint = fingerprintGoldenDir(pre.goldenDir);

        // 2. Post-rewrite build #1 into a fresh isolated golden dir → ledger B.
        const postDir = makeScratchDir(`bash32-post-${fixture}-`);
        const postGolden = path.join(postDir, "golden");
        result = runBuilder(bp, postGolden);
        assert.equal(result.status, 0, `post-rewrite build 1 failed:\n${result.stdout}`);
        const postLedger1 = fs.readFileSync(path.join(postGolden, hashFile), "utf-8");
        const postFingerprint1 = fingerprintGoldenDir(postGolden);

        // 3. Post-rewrite build #2 into the SAME golden dir — must
        //    self-report IDENTICAL and leave the dir byte-identical.
        result = runBuilder(bp, postGolden);
        assert.equal(result.status, 0, `post-rewrite build 2 failed:\n${result.stdout}`);
        assert.match(
          result.stdout,
          /Hash stability: IDENTICAL/,
          "second build must self-report Hash stability: IDENTICAL",
        );
        const postLedger2 = fs.readFileSync(path.join(postGolden, hashFile), "utf-8");
        const postFingerprint2 = fingerprintGoldenDir(postGolden);

        assert.equal(
          postLedger1,
          postLedger2,
          "two consecutive builds must produce identical hash ledgers",
        );
        assert.equal(
          postFingerprint1,
          postFingerprint2,
          "two consecutive builds must produce byte-identical golden dirs",
        );
        assert.equal(
          preLedger,
          postLedger1,
          "post-rewrite hash ledger must equal the pre-rewrite builder's ledger (no committed-tree change)",
        );
        assert.equal(
          preFingerprint,
          postFingerprint1,
          "post-rewrite golden dir must be byte-identical to the pre-rewrite build's",
        );

        // Baseline + every seed ref must match exactly (same SHAs).
        const refLines = postLedger1.split(/\r?\n/).filter((l) => l.trim() !== "");
        assert.ok(refLines.length >= 9, `ledger should carry baseline + 8 seed refs, got ${refLines.length}`);
        for (const line of refLines) {
          assert.match(line, /[0-9a-f]{40}/, `ledger line must carry a 40-hex SHA: ${line}`);
        }

        fs.rmSync(pre.dir, { recursive: true, force: true });
        fs.rmSync(pre.goldenDir, { recursive: true, force: true });
        fs.rmSync(postDir, { recursive: true, force: true });
      });
    }
  },
);

// tt-poly-verify-builder-determinism-bash32.test.ts
// US-005 — bash-3.2 rewrite of bin/verify-builder-determinism.test.sh.
//
// macOS /bin/bash 3.2.57 has no associative arrays (`declare -A` is a
// bash 4+ feature), so the self-test's FIXTURE_HASH map was replaced by a
// bash-3.2-safe construct: a plain indexed FIXTURE_NAMES array (the loop
// driver, eight entries) plus a fixture_hash_file() case-table lookup (the
// ledger-filename map). The eight fixture -> ledger pairs are exactly the
// pairs bin/tt-golden-bootstrap.mjs FIXTURE_META encodes — the single source
// of truth for ledger filenames, including tt-python@master ->
// .build-hashes-tt-python-master — and this test pins them in lock-step by
// importing FIXTURE_META directly.
//
// Fast tests (always on — picked up by self-tests/run.sh's tt-poly-* glob):
//   * AC1: zero `declare -A` in verify-builder-determinism.test.sh
//   * AC2: `bash -n` passes
//   * no FIXTURE_HASH associative-map remnants (declaration or ["key"]
//     subscript reads)
//   * the 3.2-safe constructs are present: FIXTURE_NAMES array,
//     fixture_hash_file() lookup, the guarded [@] loop expansion (US-001
//     idiom), and the header's ${#FIXTURE_NAMES[@]} count
//   * AC3: fixture_hash_file() returns the canonical ledger filename for
//     EVERY fixture in FIXTURE_META (function extracted and sourced in bash,
//     the tt-run.test.sh awk-harness analogue)
//   * FIXTURE_NAMES carries exactly KNOWN_FIXTURES (no drift between the
//     loop driver and the ledger-filename source of truth)
//   * unknown fixtures fail loudly (fail-closed lookup)
//
// The heavy 8-fixture x 2-build determinism battery is deliberately NOT part
// of this story — it is the integration/test step's final proof, run via
// bin/verify-builder-determinism.test.sh itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FIXTURE_META, KNOWN_FIXTURES } from "../bin/tt-golden-bootstrap.mjs";

const repoRoot = process.cwd();
const scriptPath = path.join(
  repoRoot,
  "torture-test",
  "bin",
  "verify-builder-determinism.test.sh",
);
const src = fs.readFileSync(scriptPath, "utf-8");

// NODE_TEST_CONTEXT causes tsx --test to silently skip tests in child bash;
// strip it and the tamandua test-isolation guard from spawned env.
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
// Pulls a top-level `name() { ... }` block (closing `}` at column 0) out of a
// shell script and sources it in a clean bash — the TS analogue of
// tt-run.test.sh's awk-extraction harness.
function extractFunction(source: string, name: string): string {
  const lines = source.split("\n");
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

function runSnippet(
  snippet: string,
  call: string,
): { status: number; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash32-vbd-fn-"));
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

describe("verify-builder-determinism.test.sh — bash-3.2 rewrite (US-005)", () => {
  it("AC1: contains no declare -A (associative arrays are a bash 4+ feature)", () => {
    assert.ok(
      !/declare\s+-A\b/.test(src),
      "verify-builder-determinism.test.sh must not use declare -A",
    );
  });

  it("AC2: passes bash -n", () => {
    const result = run("bash", ["-n", scriptPath]);
    assert.equal(result.status, 0, `bash -n failed: ${result.stderr}`);
  });

  it("has no FIXTURE_HASH associative-map remnants (declaration or subscript reads)", () => {
    // The former map's only uses were the `declare -A FIXTURE_HASH`
    // declaration and `"${FIXTURE_HASH[$fixture]}"` subscript reads; neither
    // may survive. (A descriptive comment naming the old map is fine.)
    assert.ok(
      !/declare\s+-A\s+FIXTURE_HASH/.test(src),
      "the FIXTURE_HASH associative-array declaration must be gone",
    );
    assert.ok(
      !/FIXTURE_HASH\[/.test(src),
      "no FIXTURE_HASH associative subscript reads may remain",
    );
  });

  it("defines the 3.2-safe FIXTURE_NAMES array, fixture_hash_file() lookup, and guarded loop", () => {
    assert.ok(
      src.includes("FIXTURE_NAMES=("),
      "should define the FIXTURE_NAMES array",
    );
    assert.ok(
      src.includes("fixture_hash_file() {"),
      "should define fixture_hash_file()",
    );
    // The fixture loop must drive the guarded expansion (the US-001 idiom:
    // ${arr[@]+"${arr[@]}"}), never a bare unguarded [@] expansion that
    // aborts on bash 3.2 under set -u.
    assert.ok(
      src.includes('${FIXTURE_NAMES[@]+"${FIXTURE_NAMES[@]}"}'),
      "the fixture loop must use the guarded [@] expansion",
    );
    assert.ok(
      !/(^|[^+])"\$\{FIXTURE_NAMES\[@\]\}"/.test(src),
      'no unguarded bare "${FIXTURE_NAMES[@]}" expansion may remain',
    );
    // The header's fixture count must read the array, not the old map.
    assert.ok(
      src.includes("${#FIXTURE_NAMES[@]}"),
      "the header fixture count must use ${#FIXTURE_NAMES[@]}",
    );
  });

  it("AC3: fixture_hash_file returns the canonical ledger filename for EVERY fixture in FIXTURE_META", () => {
    const snippet = extractFunction(src, "fixture_hash_file");
    for (const fixture of KNOWN_FIXTURES) {
      const meta = FIXTURE_META[fixture];
      const r = runSnippet(snippet, `fixture_hash_file "${fixture}"`);
      assert.equal(
        r.status,
        0,
        `fixture_hash_file "${fixture}" failed: ${r.stderr}`,
      );
      assert.equal(
        r.stdout.trim(),
        meta.hashFile,
        `fixture_hash_file("${fixture}") must equal FIXTURE_META.hashFile (${meta.hashFile})`,
      );
    }
    // Spot-check the canonical pair the story calls out explicitly.
    const master = runSnippet(snippet, "fixture_hash_file tt-python@master");
    assert.equal(
      master.stdout.trim(),
      ".build-hashes-tt-python-master",
      "tt-python@master must record to .build-hashes-tt-python-master, not a .git.hashes name",
    );
  });

  it("FIXTURE_NAMES carries exactly the eight KNOWN_FIXTURES", () => {
    const defLine = src
      .split("\n")
      .find((l) => l.includes("FIXTURE_NAMES=("));
    assert.ok(defLine, "FIXTURE_NAMES array definition not found");
    const m = defLine.match(/FIXTURE_NAMES=\((.*)\)/);
    assert.ok(m, "FIXTURE_NAMES array definition malformed");
    const names = m[1]
      .split(/\s+/)
      .map((n) => n.replace(/^"|"$/g, ""))
      .filter(Boolean);
    assert.deepEqual(
      [...names].sort(),
      [...KNOWN_FIXTURES].sort(),
      "FIXTURE_NAMES must match KNOWN_FIXTURES exactly",
    );
  });

  it("unknown fixtures fail loudly (fail-closed lookup)", () => {
    const snippet = extractFunction(src, "fixture_hash_file");
    const r = runSnippet(snippet, "fixture_hash_file DOES-NOT-EXIST");
    assert.notEqual(
      r.status,
      0,
      "fixture_hash_file with an unknown fixture must fail (fail-closed)",
    );
  });
});

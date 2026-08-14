import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── tt-required-workflows enumeration helper (E2.6 US-002, E3.D S11) ─────
//
// Pins the US-002 + US-007 acceptance criteria for the manifest-driven
// TT-custom workflow enumeration seam:
//   1. helper exists and lists exactly {tt-docs-drift, tt-shim-probe} for the
//      current tier manifests (deterministic sorted output)
//   2. helper excludes bundled workflow ids AND never emits the literal
//      `local` name
//   3. sentinel mapping (US-007): a REAL (pi/hermes) case whose workflow is
//      `local` (W2.24-docs-drift) emits tt-docs-drift; scripted (harness
//      `local`) cases never surface `local` and never trigger the mapping
//   4. helper fails closed (non-zero + distinct machine-parseable reason)
//      on an unreadable/corrupt manifest
//
// The helper is a pure read-only Node script: it spawns no daemon, spends no
// tokens, and never writes state — so these are fast, deterministic unit
// assertions runnable in the normal tier1 glob.

const repoRoot = process.cwd();
const ttRoot = join(repoRoot, "torture-test");
const helper = join(ttRoot, "bin", "tt-required-workflows");
const casesDir = join(ttRoot, "cases");

// The bundled repo catalog ids (workflows/*). Any of these must NOT be
// emitted by the helper even when a real case references them.
const bundledIds = new Set([
  "bug-fix",
  "bug-fix-github-pr",
  "bug-fix-merge",
  "bug-fix-merge-worktree",
  "bug-fix-worktree",
  "do-now",
  "do-review-do-verify",
  "feature-dev",
  "feature-dev-github-pr",
  "feature-dev-merge",
  "feature-dev-merge-worktree",
  "feature-dev-worktree",
  "frontend-test",
  "just-do-it",
  "quarantine-broken-tests",
  "quarantine-broken-tests-merge",
  "quarantine-broken-tests-merge-worktree",
  "security-audit",
  "security-audit-github-pr",
  "security-audit-merge",
  "security-audit-merge-worktree",
  "security-audit-worktree",
  "skills-normalize-audit",
]);

function runHelper(envOverrides: Record<string, string> = {}) {
  return spawnSync(helper, [], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  });
}

function makeTempCasesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tt-required-workflows.cases."));
  for (const name of ["tier0.jsonl", "tier1.jsonl", "cases.jsonl", "smoke.jsonl"]) {
    cpSync(join(casesDir, name), join(dir, name));
  }
  return dir;
}

describe("tt-required-workflows enumeration helper", () => {
  it("exists and is executable", () => {
    assert.ok(existsSync(helper), "torture-test/bin/tt-required-workflows must exist");
    const r = spawnSync("bash", ["-c", `[ -x "$1" ]`, "tt-required-workflows", helper], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, "helper must be executable");
  });

  it("lists exactly {tt-docs-drift, tt-shim-probe} for the current tier manifests", () => {
    const result = runHelper();
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const lines = result.stdout.trim().split(/\r?\n/).filter((line) => line !== "");
    assert.deepEqual(lines, ["tt-docs-drift", "tt-shim-probe"]);
  });

  it("produces deterministic sorted output across repeated runs", () => {
    const first = runHelper();
    const second = runHelper();
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(first.stdout, second.stdout, "output must be stable and deterministic");
  });

  it("excludes bundled workflow ids and never emits the literal `local` name", () => {
    const result = runHelper();
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const lines = result.stdout.trim().split(/\r?\n/).filter((line) => line !== "");
    for (const line of lines) {
      assert.ok(!bundledIds.has(line), `bundled workflow id must be excluded: ${line}`);
      assert.notEqual(line, "local", "the literal `local` name must never be emitted");
    }
    // `local` is referenced by real cases (W2.24-docs-drift uses workflow
    // `local` with harness `pi`) but must never surface as a custom workflow
    // name — the sentinel resolves to tt-docs-drift instead (US-007).
    assert.ok(!lines.includes("local"));
  });

  it("US-007 sentinel mapping: a real pi case whose workflow is 'local' emits tt-docs-drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-required-workflows.sentinel."));
    try {
      for (const name of ["tier0.jsonl", "tier1.jsonl", "cases.jsonl", "smoke.jsonl"]) {
        writeFileSync(join(dir, name), "", "utf8");
      }
      writeFileSync(
        join(dir, "tier1.jsonl"),
        JSON.stringify({ id: "W2.24-docs-drift", workflow: "local", harness: "pi" }) + "\n",
        "utf8",
      );
      const result = runHelper({ TT_CASES_DIR: dir });
      assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
      const lines = result.stdout.trim().split(/\r?\n/).filter((line) => line !== "");
      assert.deepEqual(lines, ["tt-docs-drift"],
        "a real case with workflow 'local' must emit the tt-docs-drift sentinel, not 'local'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("US-007 sentinel mapping is fail-closed for scripted cases: harness 'local' never surfaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-required-workflows.scripted."));
    try {
      for (const name of ["tier0.jsonl", "tier1.jsonl", "cases.jsonl", "smoke.jsonl"]) {
        writeFileSync(join(dir, name), "", "utf8");
      }
      // Scripted cases use harness `local` + workflow `local` (e.g.
      // W2.23a/b/c). They must not emit tt-docs-drift NOR `local` — the
      // mapping applies only to REAL (pi/hermes) cases.
      writeFileSync(
        join(dir, "tier1.jsonl"),
        JSON.stringify({ id: "W2.23a-expects-regex", workflow: "local", harness: "local" }) + "\n",
        "utf8",
      );
      const result = runHelper({ TT_CASES_DIR: dir });
      assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
      assert.equal(result.stdout.trim(), "",
        "scripted (harness local) cases must never surface 'local' nor trigger the sentinel mapping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("US-007 sentinel fail-closed support: the tt-docs-drift spec exists for catalog install", () => {
    // The sentinel emission is only useful because tt-catalog-install can
    // satisfy it. If the shipped spec were missing, tt-catalog-install would
    // fail closed with 'catalog-missing: tt-docs-drift' — so the shipped spec
    // must exist under torture-test/workflows/ (never the bundled catalog).
    assert.ok(
      existsSync(join(ttRoot, "workflows", "tt-docs-drift", "workflow.yml")),
      "torture-test/workflows/tt-docs-drift/workflow.yml must exist (sentinel resolution target)",
    );
    assert.ok(
      !existsSync(join(repoRoot, "workflows", "tt-docs-drift")),
      "tt-docs-drift must live ONLY under torture-test/workflows/, not the bundled catalog",
    );
  });

  it("fails closed with a distinct reason on an unreadable (missing) manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-required-workflows.missing."));
    try {
      // Only tier0.jsonl is present; the helper must fail closed on the first
      // missing required manifest instead of silently producing a partial set.
      cpSync(join(casesDir, "tier0.jsonl"), join(dir, "tier0.jsonl"));
      const result = runHelper({ TT_CASES_DIR: dir });
      assert.notEqual(result.status, 0, "missing manifest must exit non-zero");
      assert.match(result.stderr, /REASON: manifest-unreadable:/, "distinct reason expected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with a distinct reason on a corrupt manifest line", () => {
    const dir = makeTempCasesDir();
    try {
      // Corrupt a line in tier1.jsonl (append non-JSON content as a line).
      const tier1 = join(dir, "tier1.jsonl");
      writeFileSync(tier1, "{\"id\":\"bad\",\"workflow\":\"tt-shim-probe\",\"harness\":\"pi\"}\nthis is not json\n", "utf8");
      const result = runHelper({ TT_CASES_DIR: dir });
      assert.notEqual(result.status, 0, "corrupt manifest must exit non-zero");
      assert.match(result.stderr, /REASON: manifest-invalid: tier1\.jsonl: line 2/, "distinct reason + line expected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with a distinct reason when the bundled catalog is unresolvable", () => {
    const missingBundled = join(repoRoot, "torture-test", "var", "does-not-exist-workflows");
    const result = runHelper({ TT_WORKFLOWS_SRC: missingBundled });
    assert.notEqual(result.status, 0, "unresolvable bundled catalog must exit non-zero");
    assert.match(result.stderr, /REASON: bundled-catalog-unresolvable/, "distinct reason expected");
  });

  it("--help documents the helper, its fail-closed reasons, and the sentinel mapping", () => {
    const result = spawnSync(helper, ["--help"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /tt-required-workflows/);
    assert.match(result.stdout, /manifest-unreadable/);
    assert.match(result.stdout, /manifest-invalid/);
    assert.match(result.stdout, /bundled-catalog-unresolvable/);
    // US-007: the --help text documents the W2.24 local sentinel mapping.
    assert.match(result.stdout, /tt-docs-drift/);
    assert.match(result.stdout, /'local'/);
  });
});

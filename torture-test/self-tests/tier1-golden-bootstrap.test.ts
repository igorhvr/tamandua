// US-002 — Golden bare bootstrap: deterministic idempotent builder plus
// fail-closed presence gate.
//
// Real-case fixture provisioning (US-004) needs `var/fixtures/golden/<fixture>.git`
// to clone working copies from, but the pipelined torture-test never builds it —
// goldens were previously only produced by manual build-golden.sh runs. This test
// pins the standalone bootstrap (`bin/tt-golden-bootstrap.mjs`):
//   * AC1: when a golden bare is ABSENT, the bootstrap builds it from
//          fixtures-src/<fixture>/build-golden.sh and verifies the result.
//   * AC2: re-running with a VALID present golden is a no-op (idempotent) — it
//          verifies the bare against its recorded hash ledger and does NOT rebuild.
//   * AC3: the tt-python golden contains seed/<ID> refs and a green main/baseline
//          branch (the baseline branch resolves to the recorded green baseline).
//   * AC4: a MISSING/MALFORMED golden yields a precise TEST_INFRA reason
//          (fail-closed), never a silent half-launch.
//
// Zero tokens. Writes only to temp dirs under os.tmpdir() for goldens and under
// torture-test/var/ for the module's own temp scratch (gitignored). Files only
// inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const bootstrap = path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function runBootstrap(args: string[]) {
  const res = spawnSync(process.execPath, [bootstrap, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return res;
}

function parseVerdict(args: string[]) {
  const res = runBootstrap(args);
  const stdout = (res.stdout ?? "").trim();
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // leave null; assertions will report the raw output
  }
  return { status: res.status, stdout, json };
}

const SEED_TAG_REFS = [
  "refs/tags/seed/BUG-P1",
  "refs/tags/seed/BUG-P2",
  "refs/tags/seed/BUG-P3",
  "refs/tags/seed/BUG-P4",
  "refs/tags/seed/VULN-P1",
  "refs/tags/seed/VULN-P2",
  "refs/tags/seed/FLAKY-P1",
];

describe("Golden bare bootstrap (US-002)", () => {
  it("AC1: builds a golden bare from build-golden.sh when absent", function () {
    this.timeout = 120_000;
    const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-golden-ac1-"));
    try {
      const { status, json } = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.equal(status, 0, `bootstrap must exit 0:\n${JSON.stringify(json)}`);
      assert.ok(json.ok, "verdict must be ok");
      assert.equal(json.built, true, "absent golden must be built");
      assert.equal(json.fixture, "tt-python");
      const bare = path.join(goldenDir, "tt-python.git");
      assert.ok(fs.existsSync(bare), "bare repo must be produced");
      assert.ok(fs.existsSync(path.join(goldenDir, "tt-python.git.hashes")), "hash ledger must be recorded");

      // AC3: tt-python golden contains seed/<ID> refs.
      for (const ref of SEED_TAG_REFS) {
        assert.ok(
          json.verifiedRefs.some((r: any) => r.ref === ref),
          `golden must contain ${ref}`,
        );
      }
      assert.equal(json.baselineBranch, "main", "tt-python baseline branch is main");
      assert.match(json.baselineHash, /^[0-9a-f]{40}$/, "baseline hash recorded");

      // AC3: a green main/baseline branch exists and points at the baseline.
      const main = spawnSync(
        "git",
        ["--git-dir", bare, "rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(main.status, 0, "main branch must exist");
      assert.equal(main.stdout.trim(), json.baselineHash, "main must point at the green baseline");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("AC2: re-running with a valid present golden is a no-op (idempotent, hash-verified)", function () {
    this.timeout = 120_000;
    const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-golden-ac2-"));
    const bare = path.join(goldenDir, "tt-python.git");
    try {
      const first = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.equal(first.status, 0);
      assert.equal(first.json.built, true);

      const bareMtime = fs.statSync(bare).mtimeMs;

      const second = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.equal(second.status, 0, `present-valid golden must verify cleanly:\n${JSON.stringify(second.json)}`);
      assert.ok(second.json.ok);
      assert.equal(second.json.built, false, "present golden must not be rebuilt");

      // The bare was not rewritten (still the same real bare repo).
      assert.equal(fs.statSync(bare).mtimeMs, bareMtime, "bare repo must be untouched by an idempotent re-run");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("AC4: an unknown fixture yields a precise fail-closed reason", () => {
    const { status, json } = parseVerdict(["--fixture", "tt-nope"]);
    assert.notEqual(status, 0, "unknown fixture must fail-closed (non-zero exit)");
    assert.equal(json.ok, false);
    assert.equal(json.reason.category, "unknown-fixture");
    assert.match(json.reason.message, /no golden metadata/);
    assert.ok(Array.isArray(json.reason.known), "reason must list known fixtures");
  });

  it("AC4: a non-bare malformed golden dir yields golden-not-bare-repo", function () {
    this.timeout = 120_000;
    const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-golden-ac4nobare-"));
    // Build a real golden first so we copy a valid hash ledger, then replace the
    // bare with a directory that is not a bare git repo.
    try {
      const built = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.equal(built.status, 0);

      const bare = path.join(goldenDir, "tt-python.git");
      fs.rmSync(bare, { recursive: true, force: true });
      fs.mkdirSync(bare, { recursive: true });
      fs.writeFileSync(path.join(bare, "not-a-git-file"), "not a real bare repo\n");

      const { status, json } = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.notEqual(status, 0, "malformed (non-bare) golden must fail-closed");
      assert.equal(json.reason.category, "golden-not-bare-repo");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("AC4: a tampered seed ref yields golden-ref-mismatch", function () {
    this.timeout = 120_000;
    const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-golden-ac4tamper-"));
    const bare = path.join(goldenDir, "tt-python.git");
    try {
      const built = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.equal(built.status, 0);

      // Repoint BUG-P1 at main so the ledger no longer matches the golden.
      const tamper = spawnSync(
        "git",
        ["--git-dir", bare, "update-ref", "refs/tags/seed/BUG-P1", "refs/heads/main"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(tamper.status, 0, "must be able to tamper a seed ref");

      const { status, json } = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.notEqual(status, 0, "tampered golden must fail-closed");
      assert.equal(json.reason.category, "golden-ref-mismatch");
      assert.equal(json.reason.ref, "refs/tags/seed/BUG-P1");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("AC4: a bare present but missing its hash ledger yields golden-hash-file-missing", function () {
    this.timeout = 120_000;
    const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-golden-ac4hash-"));
    try {
      const built = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.equal(built.status, 0);

      fs.rmSync(path.join(goldenDir, "tt-python.git.hashes"));

      const { status, json } = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.notEqual(status, 0, "missing hash ledger must fail-closed");
      assert.equal(json.reason.category, "golden-hash-file-missing");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("usage: --help exits 0 and documents the flag", () => {
    const res = runBootstrap(["--help"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /--fixture/);
    assert.match(res.stdout, /golden/);
  });

  it("usage: missing --fixture is a usage error (exit 2)", () => {
    const { status, json } = parseVerdict(["--golden-dir", os.tmpdir()]);
    assert.equal(status, 2, "missing --fixture must be a usage error");
    assert.match(json.usage_error, /--fixture is required/);
  });
});

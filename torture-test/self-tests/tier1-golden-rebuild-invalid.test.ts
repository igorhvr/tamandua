// MACP2 US-005 — --provision --rebuild-invalid self-heal mode.
//
// A golden that is PRESENT but stale/partial ('golden present but its hash
// ledger is missing', malformed ledger, ref mismatch, non-bare) currently
// fails closed and forces a manual `rm` before the bootstrap can rebuild.
// This test pins the `--rebuild-invalid` mode added to the provisioning
// toolchain (tt-golden-bootstrap.mjs, tt-fixture-provision.mjs, tt-run):
//
//   * (a) NO flag: bare present + missing ledger still exits non-zero with
//         reason category golden-hash-file-missing — the default fail-closed
//         behavior is byte-identical (the existing AC4 pin in
//         tier1-golden-bootstrap.test.ts stays green).
//   * (b) --rebuild-invalid: the SAME state exits 0 with built:true +
//         rebuiltInvalid:true, and the verdict names the per-asset defect
//         (invalidReason + a loud REBUILT-INVALID note).
//   * (c) --rebuild-invalid with a tampered seed ref: rebuilds from scratch
//         and verifies OK afterwards (no manual rm needed).
//   * (d) --rebuild-invalid with a VALID golden: no-op (built:false) and the
//         bare is NOT rewritten — a healthy golden is never rebuilt.
//   * (e) tt-fixture-provision --rebuild-invalid plumbs through to
//         ensureGoldenBare and provisions a work clone successfully from a
//         ledger-missing golden.
//   * (f) help/usage text documents --rebuild-invalid on all three CLIs.
//
// Zero tokens. Writes only to temp dirs under os.tmpdir() (golden + work).
// Files only inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const bootstrap = path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs");
const provision = path.join(ttRoot, "bin", "tt-fixture-provision.mjs");
const ttRun = path.join(ttRoot, "bin", "tt-run");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function runBootstrap(args: string[]) {
  return spawnSync(process.execPath, [bootstrap, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
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

function runProvision(args: string[]) {
  return spawnSync(process.execPath, [provision, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseProvisionVerdict(args: string[]) {
  const res = runProvision(args);
  let json: any = null;
  try {
    json = JSON.parse((res.stdout ?? "").trim());
  } catch {
    // keep null
  }
  return { status: res.status, stdout: (res.stdout ?? "").trim(), json };
}

function freshGoldenDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Copy the shared hermetic golden (bare + hash ledger) so each test mutates
  // its own copy — never the shared one.
  fs.cpSync(baseGoldenDir, dir, { recursive: true });
  return dir;
}

// ── Shared hermetic golden (built once) ─────────────────────────────────
let baseGoldenDir: string;

before(function () {
  baseGoldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-rebuild-base-"));
  const res = runBootstrap(["--fixture", "tt-python", "--golden-dir", baseGoldenDir]);
  assert.equal(res.status, 0, `shared golden build must succeed:\n${res.stdout}`);
});

after(() => {
  fs.rmSync(baseGoldenDir, { recursive: true, force: true });
});

describe("Golden --rebuild-invalid self-heal (MACP2 US-005)", () => {
  it("(a) no flag: bare present + missing ledger stays fail-closed with golden-hash-file-missing", function () {
    this.timeout = 120_000;
    const goldenDir = freshGoldenDir("tt-rebuild-a-");
    try {
      fs.rmSync(path.join(goldenDir, "tt-python.git.hashes"));

      const { status, json } = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.notEqual(status, 0, "no flag + missing ledger must fail-closed (non-zero exit)");
      assert.equal(json.ok, false);
      assert.equal(json.reason.category, "golden-hash-file-missing");
      assert.match(json.reason.message, /golden present but its hash ledger is missing/);
      assert.equal(json.built, undefined, "fail-closed verdict must not claim a rebuild");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("(b) --rebuild-invalid: same state exits 0, built:true + rebuiltInvalid:true, verdict names the defect", function () {
    this.timeout = 180_000;
    const goldenDir = freshGoldenDir("tt-rebuild-b-");
    try {
      fs.rmSync(path.join(goldenDir, "tt-python.git.hashes"));

      const { status, json } = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir, "--rebuild-invalid"]);
      assert.equal(status, 0, `--rebuild-invalid must exit 0:\n${JSON.stringify(json)}`);
      assert.equal(json.ok, true);
      assert.equal(json.built, true, "the invalid golden must be rebuilt");
      assert.equal(json.rebuiltInvalid, true, "verdict must mark the rebuild as rebuiltInvalid");
      // The per-asset defect is named (category + loud note).
      assert.equal(json.invalidReason, "golden-hash-file-missing");
      assert.match(json.invalidMessage, /golden present but its hash ledger is missing/);
      assert.match(json.note, /REBUILT-INVALID/);
      assert.match(json.note, /tt-python/);
      assert.match(json.note, /golden-hash-file-missing/);

      // The rebuilt golden is healthy again: a no-flag re-run is a verified no-op.
      const recheck = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.equal(recheck.status, 0, `rebuilt golden must verify cleanly:\n${JSON.stringify(recheck.json)}`);
      assert.equal(recheck.json.built, false);
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("(c) --rebuild-invalid with a tampered seed ref rebuilds from scratch and verifies OK", function () {
    this.timeout = 180_000;
    const goldenDir = freshGoldenDir("tt-rebuild-c-");
    const bare = path.join(goldenDir, "tt-python.git");
    try {
      // Tamper a seed ref so the golden no longer matches its recorded ledger.
      const tamper = spawnSync(
        "git",
        ["--git-dir", bare, "update-ref", "refs/tags/seed/BUG-P1", "refs/heads/main"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(tamper.status, 0, "must be able to tamper a seed ref");
      // Sanity: without the flag the tamper is detected fail-closed.
      const detect = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.notEqual(detect.status, 0, "tampered golden must fail-closed without the flag");
      assert.equal(detect.json.reason.category, "golden-ref-mismatch");

      const { status, json } = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir, "--rebuild-invalid"]);
      assert.equal(status, 0, `--rebuild-invalid must self-heal a ref-mismatch golden:\n${JSON.stringify(json)}`);
      assert.equal(json.ok, true);
      assert.equal(json.built, true);
      assert.equal(json.rebuiltInvalid, true);
      assert.equal(json.invalidReason, "golden-ref-mismatch");
      assert.match(json.note, /REBUILT-INVALID/);

      // After the self-heal the golden verifies OK with NO flag (ref restored).
      const recheck = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir]);
      assert.equal(recheck.status, 0, `self-healed golden must verify cleanly:\n${JSON.stringify(recheck.json)}`);
      assert.equal(recheck.json.built, false, "self-healed golden must not rebuild on a plain re-run");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("(d) --rebuild-invalid with a VALID golden is a no-op (built:false) and does not rewrite the bare", function () {
    this.timeout = 60_000;
    const goldenDir = freshGoldenDir("tt-rebuild-d-");
    const bare = path.join(goldenDir, "tt-python.git");
    try {
      const beforeMtime = fs.statSync(bare).mtimeMs;
      const { status, json } = parseVerdict(["--fixture", "tt-python", "--golden-dir", goldenDir, "--rebuild-invalid"]);
      assert.equal(status, 0, `valid golden with --rebuild-invalid must exit 0:\n${JSON.stringify(json)}`);
      assert.equal(json.ok, true);
      assert.equal(json.built, false, "a healthy golden must NEVER be rebuilt, even with the flag");
      assert.equal(json.rebuiltInvalid, undefined, "no rebuiltInvalid marker on a healthy no-op");
      assert.equal(fs.statSync(bare).mtimeMs, beforeMtime, "bare must not be rewritten by a no-op");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
  });

  it("(e) tt-fixture-provision --rebuild-invalid plumbs through and provisions from a ledger-missing golden", function () {
    this.timeout = 180_000;
    const goldenDir = freshGoldenDir("tt-rebuild-e-golden-");
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-rebuild-e-work-"));
    try {
      fs.rmSync(path.join(goldenDir, "tt-python.git.hashes"));

      const { status, json } = parseProvisionVerdict([
        "--fixture", "tt-python",
        "--case-id", "US005-e",
        "--arming", "raw",
        "--golden-dir", goldenDir,
        "--work-dir", workDir,
        "--rebuild-invalid",
      ]);
      assert.equal(status, 0, `provision with --rebuild-invalid must succeed:\n${JSON.stringify(json)}`);
      assert.equal(json.ok, true);
      assert.equal(json.rebuildInvalid, true, "verdict must report the flag was applied");
      const expected = path.join(workDir, "US005-e", "tt-python");
      assert.equal(json.workClonePath, expected, "work clone path must match the contract path");
      assert.ok(fs.existsSync(path.join(expected, ".git")), "work clone must exist");
      // On a non-detached named branch (baseline -> main).
      const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: expected, encoding: "utf8" });
      assert.equal(head.status, 0);
      assert.equal(head.stdout.trim(), "main", "baseline provision must land on the main branch");
      // The planted deterministic junk survived provisioning.
      const marker = path.join(expected, "__pycache__", "junk-probe.synthetic");
      assert.ok(fs.existsSync(marker), "seeded synthetic junk must be present in the work clone");
      const ref = fs.readFileSync(path.join(ttRoot, "fixtures-src", "tt-python", "__pycache__", "junk-probe.synthetic"));
      assert.ok(fs.readFileSync(marker).equals(ref), "seeded junk must be byte-identical to the fixtures-src reference");
    } finally {
      fs.rmSync(goldenDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("(f) help text documents --rebuild-invalid on all three CLIs", () => {
    const bootHelp = runBootstrap(["--help"]);
    assert.equal(bootHelp.status, 0);
    assert.match(bootHelp.stdout, /--rebuild-invalid/, "tt-golden-bootstrap --help must document --rebuild-invalid");

    const provHelp = runProvision(["--help"]);
    assert.equal(provHelp.status, 0);
    assert.match(provHelp.stdout, /--rebuild-invalid/, "tt-fixture-provision --help must document --rebuild-invalid");

    const runHelp = spawnSync("bash", [ttRun, "--help"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(runHelp.status, 0, `tt-run --help must exit 0:\n${runHelp.stdout}`);
    assert.match(runHelp.stdout, /--rebuild-invalid/, "tt-run --help must document --rebuild-invalid");
    assert.match(runHelp.stdout, /rebuilt from scratch/, "tt-run --help must describe the self-heal");
  });
});

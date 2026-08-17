// tt-poly-python-bootstrap-old-pip.test.ts
// US-006 — make the python fixture bootstraps old-pip-safe.
//
// macOS 26.5.2's system python3 ships pip 21.2.4, which is < 21.3 — and
// pip < 21.3 cannot do PEP 517/660 editable installs of pyproject-only
// trees (`pip install -e .` fails with "no setup.py"). That killed the
// tt-python golden build (build-golden.sh's scratch-clone bootstrap),
// tt-poly-lite Phase 6 [6a], and prebootstrapped provisioning arming
// (tt-fixture-provision runs ./bootstrap in a golden clone).
//
// Fix (in the venv bootstrap itself — the venv is an arming artifact and
// is never committed): upgrade pip inside the venv to a pinned floor
// (`.venv/bin/python -m pip install --quiet 'pip>=23'`) BEFORE any
// editable install, then run the existing pytest/editable installs. On a
// modern host the upgrade is a fast no-op.
//
// Fast tests (always on — picked up by self-tests/run.sh's tt-poly-* glob):
//   * AC1: in each of the three bootstraps (tt-python, tt-poly/python,
//     tt-poly-lite/python) the pip>=23 upgrade line is the FIRST pip
//     command and precedes every `pip install -e` line
//   * AC2: `bash -n` exits 0 for all three bootstraps
//   * AC3: a functional bootstrap run in a scratch copy of the tt-python
//     golden tree creates .venv, upgrades pip to >= 23, and completes the
//     editable install of schedlib[test] (pip show schedlib + import +
//     pytest --version)
//   * AC6 (mechanical old-pip regression): when the host python can run
//     pip < 21.3, seed a scratch .venv with the old pip and assert the
//     bootstrap upgrades it and completes; when the host python cannot run
//     pip < 21.3 (e.g. Python 3.12+ removed pkgutil.ImpImporter), fall
//     back to the story's prescribed evidence: the upgrade-before-install
//     grep ordering (cross-asserted here) plus the functional bootstrap
//     run on this host (AC3)
//   * AC5: git status of torture-test/fixtures-src shows changes ONLY to
//     the three bootstrap scripts
//
// Heavy battery (gated behind TT_PYTHON_BOOTSTRAP_INTEGRATION=1): AC4
// determinism — two consecutive builds of tt-python and two consecutive
// builds of tt-poly-lite into isolated temp TORTURE_GOLDEN_DIRs produce
// byte-identical golden dirs (bare repo + hash ledger).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const fixturesSrc = path.join(repoRoot, "torture-test", "fixtures-src");

const BOOTSTRAPS = [
  { fixture: "tt-python", rel: "bootstrap" },
  { fixture: "tt-poly", rel: path.join("python", "bootstrap") },
  { fixture: "tt-poly-lite", rel: path.join("python", "bootstrap") },
] as const;

function bootstrapPath(fixture: string, rel: string): string {
  return path.join(fixturesSrc, fixture, rel);
}

// NODE_TEST_CONTEXT causes tsx --test (used by the ts fixture suite's npm
// test) to silently skip all tests, making broken tests appear green. Strip
// it from the environment when spawning bash. Also strip TAMANDUA_TEST_GUARD
// (tamandua test isolation guard) — bootstrap doesn't need tamandua state.
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

function makeScratchDir(prefix: string): string {
  const parent = path.join(repoRoot, "torture-test", "var", "self-tests");
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

// ── AC1 / AC6-fallback ordering helpers ─────────────────────────────
// Command lines only (comments are skipped — grep-based acceptance checks
// match comments too, so the ordering assertion must not count them).
function pipCommandLines(src: string): Array<{ no: number; text: string }> {
  return src
    .split("\n")
    .map((text, i) => ({ no: i + 1, text }))
    .filter((l) => l.text.trim() !== "" && !/^\s*#/.test(l.text))
    .filter((l) => /\bpip install\b/.test(l.text));
}

const UPGRADE_RE = /'pip>=23'/;
const EDITABLE_RE = /(^|\s)-e\b/;

function assertUpgradeBeforeEditable(fixture: string, rel: string, src: string): void {
  const cmds = pipCommandLines(src);
  const upgrades = cmds.filter((l) => UPGRADE_RE.test(l.text));
  const editables = cmds.filter((l) => EDITABLE_RE.test(l.text));

  assert.ok(
    upgrades.length >= 1,
    `${fixture}/${rel}: must contain a pip>=23 upgrade command line`,
  );
  assert.ok(
    editables.length >= 1,
    `${fixture}/${rel}: must contain at least one editable install (pip install -e)`,
  );
  // The upgrade must run inside the venv via the venv interpreter, with the
  // pinned floor, and must be the FIRST pip command in the script.
  assert.match(
    upgrades[0].text,
    /\.venv\/bin\/python -m pip install/,
    `${fixture}/${rel}: pip upgrade must run inside the venv via .venv/bin/python -m pip`,
  );
  assert.equal(
    upgrades[0].no,
    cmds[0].no,
    `${fixture}/${rel}: the pip>=23 upgrade must be the first pip command (line ${cmds[0].no} is '${cmds[0].text}')`,
  );
  for (const e of editables) {
    assert.ok(
      upgrades[0].no < e.no,
      `${fixture}/${rel}: editable install at line ${e.no} must come after the pip>=23 upgrade at line ${upgrades[0].no}`,
    );
  }
}

// ── Host python discovery (mirrors the bootstraps' spec-02 discovery) ──
function discoverPython(): string | null {
  for (const candidate of ["python3", "python"]) {
    const probe = run(candidate, ["-c", "import sys; sys.exit(0)"]);
    if (probe.status === 0) return candidate;
  }
  return null;
}

function parsePipVersion(stdout: string): string | null {
  const m = stdout.match(/pip (\d+)\.(\d+)\.\d+/);
  return m ? `${m[1]}.${m[2]}` : null;
}

// ── AC3 functional bootstrap run ────────────────────────────────────
// Copies the tt-python fixture-source tree (the same bytes the golden
// builder commits — rsync excludes only .venv/caches/operator-notes.local/
// build-golden.sh, so the committed bootstrap is byte-identical to this
// copy's) into a scratch dir and runs ./bootstrap exactly as a raw-arming
// scenario or the provisioning adapter would.
function copyFixtureTree(fixture: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  // Trailing "/." makes cp copy the directory CONTENTS (path.join would
  // normalize a trailing "." away, which would nest the dir instead).
  const srcDot = path.join(fixturesSrc, fixture) + path.sep + ".";
  const r = run("cp", ["-a", srcDot, dest + path.sep]);
  assert.equal(r.status, 0, `cp -a of ${fixture} failed: ${r.stderr}`);
}

function runFunctionalBootstrap(scratchDir: string, label: string): void {
  const r = run("bash", ["bootstrap"], { cwd: scratchDir, timeout: 10 * 60 * 1000 });
  assert.equal(r.status, 0, `${label}: bootstrap exited non-zero:\n${r.stdout}\n${r.stderr}`);

  const venvPy = path.join(scratchDir, ".venv", "bin", "python");
  assert.ok(fs.existsSync(venvPy), `${label}: bootstrap produced no .venv/bin/python`);

  // pip must have been upgraded to >= 23 inside the venv.
  const pipV = run(venvPy, ["-m", "pip", "--version"]);
  assert.equal(pipV.status, 0, `${label}: venv pip --version failed: ${pipV.stderr}`);
  const pipVer = parsePipVersion(pipV.stdout);
  assert.ok(pipVer !== null, `${label}: could not parse venv pip version from '${pipV.stdout}'`);
  const [major, minor] = pipVer.split(".").map(Number);
  assert.ok(
    major > 23 || (major === 23 && minor >= 0),
    `${label}: venv pip must be >= 23 after bootstrap, got ${pipVer}`,
  );

  // The editable install of schedlib[test] must have succeeded.
  const show = run(venvPy, ["-m", "pip", "show", "schedlib"]);
  assert.equal(show.status, 0, `${label}: schedlib is not installed (editable install failed): ${show.stderr}`);
  const imp = run(venvPy, ["-c", "import schedlib; print(schedlib.__file__)"], { cwd: scratchDir });
  assert.equal(imp.status, 0, `${label}: import schedlib failed: ${imp.stderr}`);
  assert.ok(
    imp.stdout.includes(scratchDir),
    `${label}: schedlib must import from the scratch tree (editable install), got ${imp.stdout}`,
  );

  const pyv = run(venvPy, ["-m", "pytest", "--version"]);
  assert.equal(pyv.status, 0, `${label}: venv pytest --version failed: ${pyv.stderr}`);
}

// ── Old-pip probe: can THIS host python run pip < 21.3? ─────────────
// pip 21.2.4 installs fine on Python 3.12+ but crashes at import
// (pkgutil.ImpImporter was removed), so the downgrade path is only
// exercisable where the host python still supports it (e.g. macOS 3.9).
function probeOldPip(): { runnable: boolean; version: string | null; venvDir: string | null } {
  const python = discoverPython();
  if (!python) return { runnable: false, version: null, venvDir: null };
  const dir = makeScratchDir("us006-oldpip-probe-");
  const fail = (): { runnable: false; version: null; venvDir: null } => {
    fs.rmSync(dir, { recursive: true, force: true });
    return { runnable: false, version: null, venvDir: null };
  };
  try {
    let r = run(python, ["-m", "venv", path.join(dir, "v")], { timeout: 5 * 60 * 1000 });
    if (r.status !== 0) return fail();
    const venvPy = path.join(dir, "v", "bin", "python");
    r = run(venvPy, ["-m", "pip", "install", "--quiet", "pip<21.3"], { timeout: 5 * 60 * 1000 });
    if (r.status !== 0) return fail();
    r = run(venvPy, ["-m", "pip", "--version"]);
    if (r.status !== 0) return fail();
    const ver = parsePipVersion(r.stdout);
    if (!ver) return fail();
    const [major, minor] = ver.split(".").map(Number);
    const below213 = major < 21 || (major === 21 && minor < 3);
    if (!below213) return fail();
    return { runnable: true, version: ver, venvDir: dir };
  } catch {
    return fail();
  }
}

describe("US-006 python fixture bootstraps — old-pip safety (AC1/AC2)", () => {
  for (const { fixture, rel } of BOOTSTRAPS) {
    const bp = bootstrapPath(fixture, rel);

    it(`AC1: ${fixture}/${rel} upgrades pip to >=23 before every editable install`, () => {
      const src = fs.readFileSync(bp, "utf-8");
      assertUpgradeBeforeEditable(fixture, rel, src);
    });

    it(`AC2: ${fixture}/${rel} passes bash -n`, () => {
      const r = run("bash", ["-n", bp]);
      assert.equal(r.status, 0, `bash -n failed for ${fixture}/${rel}: ${r.stderr}`);
    });
  }
});

describe("US-006 python fixture bootstraps — functional + old-pip behavior (AC3/AC6)", () => {
  it("AC3: functional bootstrap run in a scratch tt-python golden tree installs schedlib[test]", function () {
    this.timeout = 15 * 60 * 1000;
    const scratch = makeScratchDir("us006-func-");
    try {
      copyFixtureTree("tt-python", scratch);
      runFunctionalBootstrap(scratch, "AC3 tt-python bootstrap");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("AC6: mechanical old-pip regression (downgraded-pip scenario when host permits; ordering grep + functional run otherwise)", function () {
    this.timeout = 20 * 60 * 1000;
    const probe = probeOldPip();

    if (!probe.runnable) {
      // pip < 21.3 cannot run on this host python (e.g. Python 3.12+
      // removed pkgutil.ImpImporter). Per the story, the evidence is then
      // the upgrade-before-install ordering in each bootstrap (cross-assert
      // the strict "first pip command is the upgrade" form here) plus the
      // functional bootstrap run on this host (the AC3 test above).
      for (const { fixture, rel } of BOOTSTRAPS) {
        const src = fs.readFileSync(bootstrapPath(fixture, rel), "utf-8");
        assertUpgradeBeforeEditable(fixture, rel, src);
      }
      return;
    }

    // Full old-pip scenario: seed the scratch tree's .venv with the
    // downgraded pip (so bootstrap's `[ ! -d .venv ]` skips creation and
    // reuses the old-pip venv — the exact macOS failure state), then run
    // the bootstrap: it must upgrade pip first and complete.
    assert.ok(probe.venvDir, "runnable old-pip probe must carry a venv dir");
    const scratch = makeScratchDir("us006-oldpip-");
    try {
      copyFixtureTree("tt-python", scratch);
      const r = run("cp", ["-a", path.join(probe.venvDir, "v") + path.sep + ".", path.join(scratch, ".venv") + path.sep]);
      assert.equal(r.status, 0, `seeding old-pip .venv failed: ${r.stderr}`);

      // Precondition: the seeded venv really is an old pip (< 21.3).
      const before = run(path.join(scratch, ".venv", "bin", "python"), ["-m", "pip", "--version"]);
      assert.equal(before.status, 0, `seeded venv pip --version failed: ${before.stderr}`);
      const beforeVer = parsePipVersion(before.stdout);
      assert.equal(beforeVer, probe.version, `seeded venv pip must be ${probe.version}`);

      const boot = run("bash", ["bootstrap"], { cwd: scratch, timeout: 10 * 60 * 1000 });
      assert.equal(boot.status, 0, `old-pip bootstrap exited non-zero:\n${boot.stdout}\n${boot.stderr}`);

      runFunctionalBootstrap(scratch, `AC6 old-pip (${probe.version}) bootstrap`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      if (probe.venvDir) fs.rmSync(probe.venvDir, { recursive: true, force: true });
    }
  });
});

describe("US-006 fixtures-src diff confinement (AC5)", () => {
  it("AC5: git status of fixtures-src shows changes only to authorized MACP1 surfaces (bootstraps, builders, validators)", () => {
    const r = run("git", ["status", "--porcelain", "--", "torture-test/fixtures-src"]);
    assert.equal(r.status, 0, `git status failed: ${r.stderr}`);
    // US-006: the three python fixture bootstraps.
    const allowed = new Set(
      BOOTSTRAPS.map(({ fixture, rel }) => `torture-test/fixtures-src/${fixture}/${rel}`),
    );
    // US-007 (MACP1, authorized by US-002): every fixture golden builder and
    // the two end-to-end validators — builder/validator error surfacing.
    const ALL_FIXTURES = [
      "tt-python",
      "tt-python@master",
      "tt-ts",
      "tt-java",
      "tt-go",
      "tt-rust",
      "tt-poly",
      "tt-poly-lite",
    ];
    for (const fixture of ALL_FIXTURES) {
      allowed.add(`torture-test/fixtures-src/${fixture}/build-golden.sh`);
    }
    for (const fixture of ["tt-python", "tt-java"]) {
      allowed.add(`torture-test/fixtures-src/${fixture}/validate-e2e.sh`);
    }
    const entries = r.stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => l.slice(3)); // strip the two-char status + space
    for (const e of entries) {
      assert.ok(
        allowed.has(e),
        `fixtures-src change outside the authorized MACP1 surfaces (bootstraps/builders/validators): '${e}'`,
      );
    }
  });
});

// ── AC4 determinism battery (gated) ────────────────────────────────
const INTEGRATION = process.env.TT_PYTHON_BOOTSTRAP_INTEGRATION === "1";

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

describe(
  "US-006 golden determinism battery (AC4)",
  { skip: !INTEGRATION },
  () => {
    for (const fixture of ["tt-python", "tt-poly-lite"] as const) {
      it(`${fixture}: two consecutive isolated builds produce byte-identical golden dirs`, function () {
        this.timeout = 45 * 60 * 1000; // python pip installs + tt-poly-lite npm/ts suite
        const bp = path.join(fixturesSrc, fixture, "build-golden.sh");
        const ledgerName = fixture === "tt-python" ? "tt-python.git.hashes" : "tt-poly-lite.git.hashes";
        const parent = makeScratchDir(`us006-det-${fixture}-`);
        const g1 = path.join(parent, "g1");
        const g2 = path.join(parent, "g2");
        try {
          let r = run("bash", [bp], { env: { TORTURE_GOLDEN_DIR: g1 }, timeout: 45 * 60 * 1000 });
          assert.equal(r.status, 0, `${fixture} build 1 failed:\n${r.stdout}\n${r.stderr}`);
          const ledger1 = fs.readFileSync(path.join(g1, ledgerName), "utf-8");
          const fp1 = fingerprintGoldenDir(g1);

          r = run("bash", [bp], { env: { TORTURE_GOLDEN_DIR: g2 }, timeout: 45 * 60 * 1000 });
          assert.equal(r.status, 0, `${fixture} build 2 failed:\n${r.stdout}\n${r.stderr}`);
          const ledger2 = fs.readFileSync(path.join(g2, ledgerName), "utf-8");
          const fp2 = fingerprintGoldenDir(g2);

          assert.equal(ledger1, ledger2, `${fixture}: hash ledgers differ between two consecutive builds`);
          assert.equal(fp1, fp2, `${fixture}: golden dirs differ between two consecutive builds`);

          // Well-formed ledger: baseline + every seed/branch ref carries a 40-hex SHA.
          const refLines = ledger1.split(/\r?\n/).filter((l) => l.trim() !== "");
          assert.ok(refLines.length >= 9, `${fixture}: ledger should carry baseline + refs, got ${refLines.length}`);
          for (const line of refLines) {
            assert.match(line, /[0-9a-f]{40}/, `${fixture}: ledger line must carry a 40-hex SHA: ${line}`);
          }
        } finally {
          fs.rmSync(parent, { recursive: true, force: true });
        }
      });
    }
  },
);

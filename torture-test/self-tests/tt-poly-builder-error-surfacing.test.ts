// tt-poly-builder-error-surfacing.test.ts
// US-007 — surface builder errors: every fail-closed path in the fixtures-src
// golden builders/validators must capture the failing command's output and
// print its last ~20 lines instead of swallowing it to /dev/null and printing
// only a generic message ("✗ bootstrap failed", "FAILED — python baseline
// suite is not green!", ...). Operators must be able to diagnose
// bootstrap/toolchain failures without re-running the builder.
//
// macOS 26.5.2 validation found the class: tt-python/build-golden.sh:202 ran
// the scratch-clone bootstrap with `>/dev/null 2>&1` and printed only
// "✗ bootstrap failed" on failure; tt-poly-lite Phase 6 [6a] swallowed the
// python bootstrap/pytest output the same way. US-007 converts every site.
//
// Tests:
//   * AC4 (always on): grep-based audit — for each builder/validator, every
//     occurrence of a known generic-fail message must be preceded (within 25
//     lines) by a capture of the failing command's output (`$(... 2>&1)`
//     substitution or a `tail -` print). tt-poly's builder is structural-only
//     (no test-suite/bootstrap invocation at all — asserted), so it has no
//     swallow class.
//   * AC1 (always on): failure induction — run the tt-python builder into an
//     isolated TORTURE_GOLDEN_DIR with a broken python3+python stub on PATH;
//     the bootstrap fails and the builder output must contain the bootstrap
//     error tail (>= 10 lines including the stub's message) before exiting
//     non-zero.
//   * AC2 (always on): same induction for tt-poly-lite Phase 6 [6a] — the
//     builder output must surface the bootstrap tail instead of a silent
//     set -e abort.
//   * AC3 (gated behind TT_ERROR_SURFACING_INTEGRATION=1): a healthy-host
//     tt-ts build into an isolated TORTURE_GOLDEN_DIR still completes and
//     self-reports "Hash stability: IDENTICAL" on the second run (success
//     paths unchanged).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const fixturesSrc = path.join(repoRoot, "torture-test", "fixtures-src");

// NODE_TEST_CONTEXT causes tsx --test (used by the ts fixture suite's npm
// test) to silently skip all tests, making broken tests appear green. Strip
// it from the environment when spawning bash. Also strip TAMANDUA_TEST_GUARD
// (tamandua test isolation guard) — builders don't need tamandua state.
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

// ── AC4: grep-based audit — no fail-closed swallow site remains ──────────
// For each builder/validator, the known generic-fail messages that used to
// follow a swallowed command. Every occurrence must be preceded by a capture.
const AUDIT_TARGETS: Array<{
  rel: string;
  messages: RegExp[];
  structuralOnly?: boolean;
}> = [
  {
    rel: "tt-python/build-golden.sh",
    messages: [/✗ bootstrap failed/, /✗ Baseline test suite: RED/, /✗ broken-tests branch: GREEN/],
  },
  {
    rel: "tt-python@master/build-golden.sh",
    messages: [
      /✗ bootstrap failed/,
      /✗ Baseline test suite: RED/,
      /✗ broken-tests branch: GREEN/,
      /✗ junk-probe test run failed/,
    ],
  },
  {
    rel: "tt-ts/build-golden.sh",
    messages: [
      /main: FAILED — baseline suite is not green!/,
      /npm install (?:FAILED|failed)/,
      /\+fix: FAILED — fix did not restore green!/,
      /\+fix: FAILED — VULN fix broke the suite!/,
    ],
  },
  {
    rel: "tt-java/build-golden.sh",
    messages: [
      /main: FAILED — baseline suite is not green!/,
      /\+fix: FAILED — fix did not restore green!/,
      /\+fix: FAILED — VULN fix broke the suite!/,
    ],
  },
  {
    rel: "tt-go/build-golden.sh",
    messages: [/✗ Baseline test suite: RED/, /✗ broken-tests branch: GREEN/],
  },
  {
    rel: "tt-rust/build-golden.sh",
    messages: [
      /✗ Baseline test suite: RED/,
      /✗ broken-tests branch: GREEN/,
      /✗ seed\/[^ ]+ \+ fix\.patch: RED!/,
      /✗ broken-tests \+ all fix patches: RED!/,
    ],
  },
  {
    // tt-poly's builder is structural-only: it builds refs and checks
    // content/SHAs but never runs a test suite or a bootstrap, so there is
    // no swallowed toolchain output class (asserted below).
    rel: "tt-poly/build-golden.sh",
    messages: [],
    structuralOnly: true,
  },
  {
    rel: "tt-poly-lite/build-golden.sh",
    messages: [
      /FAILED — python bootstrap failed!/,
      /FAILED — python baseline suite is not green!/,
      /FAILED — ts baseline suite is not green!/,
      /UNEXPECTED GREEN — broken-tests branch should be red!/,
      /python bootstrap FAILED!/,
      /FAILED — fix did not restore green!/,
      /FAILED — VULN fix should not break the suite!/,
      /FAILED — VULN fix broke the suite!/,
      /UNEXPECTED RED \(exit/,
      /UNEXPECTED RED!/,
      /UNEXPECTED GREEN — BRK seed should fail!/,
      /npm install (?:FAILED|failed)/,
      /TRACKED — junk probe failure!/,
    ],
  },
  {
    rel: "tt-python/validate-e2e.sh",
    messages: [
      /bootstrap script failed/,
      /test suite was GREEN/,
      /test suite was RED/,
      /test suite still RED after fix/,
      /tests still failing after fix/,
      /tests failed/,
      /suite was GREEN — expected RED/,
    ],
  },
  {
    rel: "tt-java/validate-e2e.sh",
    messages: [/test suite was RED/, /test suite still RED after fix/, /git apply -p4 failed/],
  },
];

// A capture of the failing command's output: an assignment from a command
// substitution (`NAME="$(cmd ...)"` — including `2>&1` or `2>/dev/null`
// redirects inside) or a `tail -N` print. A bare `cmd >/dev/null 2>&1`
// swallow has no `$(` and is NOT a capture.
const CAPTURE_RE = /\w+="\$\(|tail -[0-9]+/;

describe("US-007 builder error surfacing", () => {
  it("AC4: no fail-closed swallow site remains — every generic-fail message has a preceding capture", () => {
    for (const target of AUDIT_TARGETS) {
      const file = path.join(fixturesSrc, target.rel);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const re of target.messages) {
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const window = lines.slice(Math.max(0, i - 25), i);
            const hasCapture = window.some((l) => CAPTURE_RE.test(l));
            assert.ok(
              hasCapture,
              `${target.rel}:${i + 1}: generic-fail message "${lines[i].trim()}" has no preceding capture — the failing command's output is still swallowed (US-007)`,
            );
          }
        }
      }
      if (target.structuralOnly) {
        // Structural-only builder: it must not RUN any test suite or
        // bootstrap (mentions of ".pytest_cache" in tar-exclude lists are
        // fine), so no swallowed toolchain output class can exist.
        const src = lines.join("\n");
        const invocationRes = [
          /\bnpm (install|test|run)\b/,
          /\bgo test\b/,
          /\bcargo test\b/,
          /-m pytest\b|\bpytest\s+-/,
          /\bmvnw\b/,
          /\bbash[^\n]*bootstrap\b|\.\/bootstrap\b|python\/bootstrap\b/,
        ];
        for (const re of invocationRes) {
          assert.ok(
            !re.test(src),
            `${target.rel}: structural-only builder must not invoke ${re} (no swallowed toolchain output class)`,
          );
        }
      }
    }
  });
});

// ── Failure induction: broken python3+python stub on PATH ─────────────────
// A stub dir shadowing python3 AND python. The bootstrap's discovery probe
// (`"$candidate" -c 'import sys; sys.exit(0)' >/dev/null 2>&1`) swallows the
// candidate's output, so the stub must PASS that probe (exit 0) and fail the
// FIRST REAL operation instead — `"$PYTHON" -m venv .venv` — where the
// bootstrap does NOT redirect output. The stub prints a distinctive 13-line
// message and exits 1, so the bootstrap aborts under set -e with that message
// in its captured output, and the builder's tail must surface it.
function writeBrokenPythonStubs(): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "tt-us007-broken-py-"));
  const mkStub = (name: string, marker: string) => {
    const lines: string[] = [];
    for (let n = 1; n <= 12; n++) lines.push(`STUB:${name}:line${n}`);
    lines.push(`STUB:${name}:${marker}`);
    const body = [
      "#!/usr/bin/env bash",
      "# pass the bootstrap's discovery probe (`-c 'import sys; sys.exit(0)'`)",
      'if [ "${1:-}" = "-c" ]; then exit 0; fi',
      "# quietly succeed the version probe",
      'if [ "${1:-}" = "--version" ]; then exit 0; fi',
      "# every real operation (venv creation, pip, pytest, ...) fails loudly",
      "printf '%s\\n' \\",
      ...lines.map((l) => `  "${l}" \\`),
      '  "STUB:FAILED:real-operation-not-supported"',
      "exit 1",
    ];
    fs.writeFileSync(path.join(dir, name), body.join("\n") + "\n");
    fs.chmodSync(path.join(dir, name), 0o755);
  };
  mkStub("python3", "PYTHON3_STUB_BROKEN_MARKER");
  mkStub("python", "PYTHON_STUB_BROKEN_MARKER");
  return dir;
}

function stubEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stubBin = writeBrokenPythonStubs();
  return {
    ...CLEAN_ENV,
    ...extra,
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
  };
}

function countStubLines(out: string): number {
  return out.split("\n").filter((l) => l.startsWith("STUB:")).length;
}

const TT_PYTHON_BUILDER = path.join(fixturesSrc, "tt-python", "build-golden.sh");
const TT_POLY_LITE_BUILDER = path.join(fixturesSrc, "tt-poly-lite", "build-golden.sh");

describe("failure induction (broken python stub on PATH)", () => {
  it("AC1: tt-python builder prints the bootstrap error tail (>= 10 lines incl. the stub message) before exiting non-zero", function () {
    this.timeout = 120_000;
    const goldenDir = makeScratchDir("us007-tt-python-fail-");
    const env = stubEnv({ TORTURE_GOLDEN_DIR: goldenDir });
    const r = run("bash", [TT_PYTHON_BUILDER], { env, timeout: 120_000 });

    assert.notEqual(r.status, 0, "builder must exit non-zero when the bootstrap fails");
    const out = `${r.stdout}\n${r.stderr}`;
    assert.ok(
      out.includes("✗ bootstrap failed"),
      "builder must report the bootstrap failure, got:\n" + out,
    );
    assert.ok(
      out.includes("PYTHON3_STUB_BROKEN_MARKER") || out.includes("PYTHON_STUB_BROKEN_MARKER"),
      "builder output must contain the stub's message, got:\n" + out,
    );
    assert.ok(
      countStubLines(out) >= 10,
      `builder output must surface >= 10 lines of the bootstrap error tail, got ${countStubLines(out)} STUB lines:\n${out}`,
    );
  });

  it("AC2: tt-poly-lite [6a] python failure path prints the bootstrap tail (>= 10 lines) instead of a silent abort", function () {
    this.timeout = 300_000;
    const goldenDir = makeScratchDir("us007-tt-poly-lite-fail-");
    const env = stubEnv({ TORTURE_GOLDEN_DIR: goldenDir });
    const r = run("bash", [TT_POLY_LITE_BUILDER], { env, timeout: 300_000 });

    assert.notEqual(r.status, 0, "builder must exit non-zero when the bootstrap fails");
    const out = `${r.stdout}\n${r.stderr}`;
    assert.ok(
      out.includes("FAILED — python bootstrap failed!"),
      "builder must report the [6a] bootstrap failure, got:\n" + out,
    );
    assert.ok(
      out.includes("PYTHON3_STUB_BROKEN_MARKER") || out.includes("PYTHON_STUB_BROKEN_MARKER"),
      "builder output must contain the stub's message, got:\n" + out,
    );
    assert.ok(
      countStubLines(out) >= 10,
      `builder output must surface >= 10 lines of the bootstrap error tail, got ${countStubLines(out)} STUB lines:\n${out}`,
    );
  });
});

// ── AC3: healthy-host tt-ts determinism (gated) ────────────────────────────
// Two consecutive tt-ts builds into an isolated TORTURE_GOLDEN_DIR must both
// succeed, produce byte-identical golden dirs, and the second must
// self-report "Hash stability: IDENTICAL" — proving the US-007 conversions
// did not change success-path behavior or golden output bytes.
const INTEGRATION = process.env.TT_ERROR_SURFACING_INTEGRATION === "1";

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
  "AC3: healthy tt-ts determinism (success paths unchanged)",
  { skip: !INTEGRATION },
  () => {
    it("two consecutive tt-ts builds byte-identical + second self-reports IDENTICAL", function () {
      this.timeout = 30 * 60 * 1000;
      const bp = path.join(fixturesSrc, "tt-ts", "build-golden.sh");
      const goldenDir = makeScratchDir("us007-tt-ts-healthy-");

      const run1 = run("bash", [bp], { env: { TORTURE_GOLDEN_DIR: goldenDir }, timeout: 30 * 60 * 1000 });
      assert.equal(run1.status, 0, `healthy tt-ts build 1 failed:\n${run1.stdout}\n${run1.stderr}`);
      const fp1 = fingerprintGoldenDir(goldenDir);

      const run2 = run("bash", [bp], { env: { TORTURE_GOLDEN_DIR: goldenDir }, timeout: 30 * 60 * 1000 });
      assert.equal(run2.status, 0, `healthy tt-ts build 2 failed:\n${run2.stdout}\n${run2.stderr}`);
      assert.match(run2.stdout, /Hash stability: IDENTICAL/, "second build must self-report IDENTICAL");
      const fp2 = fingerprintGoldenDir(goldenDir);
      assert.equal(fp1, fp2, "two consecutive builds must produce byte-identical golden dirs");
    });
  },
);

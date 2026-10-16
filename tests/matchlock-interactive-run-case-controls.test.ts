/**
 * MTLK-INTERACTIVE-SUITE US-006 — per-case wrapper (`runner/run-case.sh`) and
 * case-owned hygiene remover (`runner/hygiene.sh`) behavioral controls.
 *
 * `scripts/tests/matchlock/fixtures/fixtures-test.sh` drives the REAL ported
 * scripts in place with a fake `matchlock` and a fake `pty-drive.py` and
 * exercises the protected semantics:
 *
 *   - fail-closed BEFORE inventory refuses before launch (exit 2) and never
 *     invokes the driver; a malformed BEFORE inventory refuses the same way;
 *   - a failed/malformed AFTER inventory is fail-closed (exit 1, recorded);
 *   - mount write-through missing/bad-content fails the case; an undeletable
 *     stale nonce refuses before launch;
 *   - case-scoped ownership correlation (real creation window + exact mount
 *     destination) owns the row, a fake window leaves it unowned/fail-closed;
 *   - `hygiene.sh` removes only owned ids and exits 3 on rm failure, leftover,
 *     malformed/unreadable inventory, reporting unowned ids without touching
 *     them;
 *   - configuration bindings are rendered from `{{MTLK_*}}` placeholders and an
 *     unset placeholder refuses before launch;
 *   - retained interactive-session evidence is counted ONLY for dirs that
 *     appear under the case's private observation root during that case's own
 *     window with a real copy payload: fresh payloads (Linux config.json+logs
 *     and macOS/VZ logs-only) are observed; a pre-existing (stale) dir is
 *     excluded even when its contents are touched mid-case; an empty dir, a
 *     symlinked dir, the `vm-00000000` placeholder sentinel and a root that is
 *     replaced mid-case are never counted; a file/symlink root refuses before
 *     launch. The observation is recorded in `interactive_evidence_new_vms`
 *     and never grants cleanup authority (`owned_new_vms`).
 *
 * It also asserts the port carries no host-specific path (`/home/igorhvr`,
 * `li155-matrix`) and never references the known-wrong image-store registry
 * path (`~/.cache/matchlock/state.db`).
 *
 * The fixture drives no VM and no model. This file spawns `bash`
 * (node:child_process) and is therefore classified in the serial lane; it is
 * registered exactly once in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const suiteDir = path.join(repoRoot, "scripts", "tests", "matchlock");
const runnerDir = path.join(suiteDir, "runner");
const runCasePath = path.join(runnerDir, "run-case.sh");
const hygienePath = path.join(runnerDir, "hygiene.sh");
const fixturePath = path.join(suiteDir, "fixtures", "fixtures-test.sh");

/** Single-quote a string for safe interpolation into a `bash -c` script. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The decisive controls the fixture must report as `ok`. Each is printed by the
 * fixture; the matching assertion is inside the fixture script.
 */
const DECISIVE_CONTROLS = [
  // fail-closed inventory
  "s1 rc=2",
  "s1 summary refused_before_launch",
  "s1 driver not invoked",
  "s2 rc=1",
  "s2 FAIL-CLOSED",
  "s3 rc=2",
  // mount write-through
  "s4 mount missing recorded",
  "s4b bad-content recorded",
  "s4c refusal recorded",
  // configuration-bound case rendering
  "s6b placeholder replaced",
  "s6b workdir bound",
  "s6b source case untouched",
  "s6c unbound rc=2",
  "s6c unresolved reason",
  "s6c driver not invoked",
  // hygiene
  "s7 hygiene rm-fail rc=3",
  "s8 hygiene leftover rc=3",
  "s9 hygiene clean rc=0",
  "s10 hygiene malformed rc=3",
  "s11 hygiene unparsed row rc=3",
  "s12 hygiene unreadable summary rc=3",
  "s13 unowned-only rc=0",
  "s13 unowned reported, rm never called",
  // case-scoped ownership
  "s18 correlated-owned rc=0",
  "s18 correlated ownership recorded",
  "s18 correlated VM removed",
  "s19 uncorrelated rc=1 (fail-closed)",
  "s19 unowned recorded, not owned",
  // retained interactive-session evidence (case-owned observation only)
  "s20 fresh evidence counted",
  "s20 evidence status ok",
  "s20 evidence is not cleanup authority",
  "s20b logs-only evidence counted",
  "s21 stale evidence not counted",
  "s21b touched stale evidence not counted",
  "s22 empty dir rejected",
  "s23 symlinked dir rejected",
  "s24 sentinel rejected",
  "s25 replaced-root rc=1",
  "s25 replaced-root fail-closed",
  "s25 replaced-root counts nothing",
  "s26 file-root rc=2",
  "s26 file-root refusal recorded",
  "s26 driver not invoked",
  "s27 symlink-root rc=2",
  "s27 symlink-root refusal recorded",
  "s27 driver not invoked",
  "s28 rc=0",
  "s28 newline id not counted",
  "s28 newline id rejected as malformed",
  "s29a rc=0",
  "s29a first-case evidence counted",
  "s29b rc=0",
  "s29b second-case evidence counted (logs-only, prior dir excluded)",
] as const;

/** Recursively collect text files under `dir` (skips `__pycache__`/`.pyc`). */
function collectTextFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTextFiles(full));
    } else if (entry.isFile() && !entry.name.endsWith(".pyc")) {
      out.push(full);
    }
  }
  return out;
}

describe("Matchlock interactive run-case/hygiene controls (MTLK-INTERACTIVE-SUITE US-006)", () => {
  it("ships the per-case wrapper, the hygiene remover and their fixture suite", () => {
    assert.ok(existsSync(runCasePath), `missing ${runCasePath}`);
    assert.ok(existsSync(hygienePath), `missing ${hygienePath}`);
    assert.ok(existsSync(fixturePath), `missing ${fixturePath}`);
  });

  it("passes every run-case/hygiene control with fail=0", () => {
    const tmp = tamanduaTempDir("mtlk-run-case-controls-");
    try {
      const script = [
        `export MTLK_RUN_CASE_FIXTURE_DIR=${shQuote(tmp)}`,
        `exec bash ${shQuote(fixturePath)}`,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(
        result.error,
        undefined,
        `failed to spawn the fixture: ${result.error?.message ?? "unknown"}`,
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      assert.equal(result.status, 0, `fixture suite failed (exit ${result.status}):\n${output}`);
      assert.ok(
        !output.includes("FIXTURE-FAIL"),
        `the fixture reported a failing control:\n${output}`,
      );

      const summary = output.match(/RUN-CASE FIXTURES RESULT: pass=(\d+) fail=0/);
      assert.ok(summary, `expected a 'RUN-CASE FIXTURES RESULT: pass=N fail=0' line:\n${output}`);
      assert.ok(
        Number(summary[1]) >= 30,
        `expected at least 30 passing controls, got ${summary[1]}`,
      );

      for (const label of DECISIVE_CONTROLS) {
        assert.ok(
          output.includes(`ok   - ${label}`),
          `decisive control did not pass: ${label}\n${output}`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("carries no host-specific path and never the wrong registry path", () => {
    const forbidden = [/\/home\/igorhvr/, /li155-matrix/, /\.cache\/matchlock\/state\.db/];
    for (const file of collectTextFiles(suiteDir)) {
      const rel = path.relative(repoRoot, file);
      const text = readFileSync(file, "utf-8");
      for (const pattern of forbidden) {
        assert.ok(
          !pattern.test(text),
          `${rel} must not reference ${pattern} (found a host-specific/wrong-registry path)`,
        );
      }
    }

    // The correct VM registry ($HOME/.matchlock/state.db) must be the binding.
    const common = readFileSync(path.join(suiteDir, "lib", "common.sh"), "utf-8");
    assert.match(common, /\.matchlock\/state\.db/);
    assert.match(common, /MTLK_MATCHLOCK_STATE_DB/);
    assert.match(readFileSync(runCasePath, "utf-8"), /MTLK_MATCHLOCK_STATE_DB/);

    // The fixture must not clobber any fixed path inside the repo.
    const fixture = readFileSync(fixturePath, "utf-8");
    assert.match(fixture, /mktemp -d/);
    assert.ok(statSync(runnerDir).isDirectory());
  });
});

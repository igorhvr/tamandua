// S42 (US-005) — W4.17 red-baseline arming hook + fail-closed absent-arm.
//
// The W4.17-a/b task texts and tier2-traceability promise a reset-hook
// arming overlay planting "2 documented pre-existing red tests" into the
// tt-python fixture, but pre-S42 cases/hooks/ carried only
// reset-w4.26/reset-w4.28/reset-w4.30/reset-w4.31 — NO W4.17 hook existed,
// the manifest rows declared `reset: null`, and both arms produced verdicts
// from an unarmed premise (no hook, no planted red tests, no red baseline):
// VACUOUS. This story implements the promised hook, declares it on both
// manifest rows with a mandatory `arming` block, and makes the controller
// fail closed (TEST_INFRA_FAIL 'arm-absent') when a case's mandated
// seed/arm is absent at execution — never a silent vacuous verdict.
//
// This test proves (zero tokens, files ONLY under torture-test/ + temp dirs):
//   * RED-ARM: pins the pre-fix vacuity (the S42 traceability section names
//     the pre-fix cases/hooks/ contents; the pre-fix manifest shape declared
//     no reset hook / no arming) and reproduces the PRE-FIX no-gate shape —
//     a terminal mandatory-arming attempt with no arming manifest yields a
//     verdict (no gate); post-fix armAbsentGate refuses the SAME shape with
//     TEST_INFRA_FAIL 'arm-absent' (history-independent: the pre-fix
//     no-gate verdict path is reproduced inline, never resolved from git);
//   * GREEN-ARM (hook end-to-end): the hook, run against a provisioned
//     contained tt-python clone, plants EXACTLY 2 documented pre-existing
//     red tests, commits them, provably red (pytest on exactly the 2 planted
//     files: `2 failed`; the full BUG-P1 suite is red by exactly the 2
//     planted failures), leaves seeds/ + operator-notes.local untouched,
//     records the arming manifest, and is idempotent (re-run: no new
//     commit, still exactly 2 planted tests) — for BOTH W4.17-a (BUG-P1)
//     and W4.17-b (BUG-P2);
//   * GREEN-ARM (manifest): both W4.17 rows declare
//     `reset: cases/hooks/reset-w4.17-red-baseline.sh` + the mandatory
//     `arming: {type: red-baseline, count: 2}` block, and
//     `tt-controller --manifest cases/tier2.jsonl --validate-only` stays
//     green;
//   * GREEN-ARM (gate): armAbsentGate fires for the absent-manifest /
//     armed:false / type-mismatch / count-mismatch / malformed-manifest
//     shapes and never for the properly-armed / non-mandatory /
//     no-arming-declaration / still-in-flight shapes.
//
// Follows the tier2-*.test.ts self-test pattern (node builtins +
// repo-relative module imports); picked up by self-tests/run.sh's tier2
// glob automatically.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { armAbsentGate, readArmingManifest } from "../bin/tt-arming.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const hooksDir = path.join(ttRoot, "cases", "hooks");
const hookPath = path.join(hooksDir, "reset-w4.17-red-baseline.sh");
const controller = path.join(ttRoot, "bin", "tt-controller");
const provision = path.join(ttRoot, "bin", "tt-fixture-provision.mjs");
// The shared prebuilt golden (tt-python is built in the campaign var; the
// battery runs with the dirty var/home present). Provisioning only READS
// the golden — the work clone + arming manifest land in the per-test temp
// TT root, never in the shared var.
const sharedGoldenDir = path.join(ttRoot, "var", "fixtures", "golden");

const W4_17_A = "W4.17-a-red-baseline-land-annotated";
const W4_17_B = "W4.17-b-red-baseline-refuse";
const RED_A = "tests/test_pre_existing_red_a.py";
const RED_B = "tests/test_pre_existing_red_b.py";

function readManifest(): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function w417Record(id: string): any {
  const record = readManifest().find((item) => item.id === id);
  assert.ok(record, `${id} must exist in tier2.jsonl`);
  return record;
}

function run(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 300_000, cwd: string = repoRoot): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      TAMANDUA_TEST_GUARD: "0",
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function runGit(clonePath: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, { cwd: clonePath, encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout ?? "") };
}

// A throwaway TT var-style root: <tmp>/<case>/<fixture> work clones +
// <tmp>/arming/<case>.json manifests — mirrors the controller's layout
// (TT_ROOT=var, work at var/fixtures/work/<case>/<fixture>).
function fakeTtRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `s42-tt-${process.pid}-`));
}

// Provision a contained tt-python work clone for a W4.17 case under the
// given TT root (controller layout), reusing the shared prebuilt golden.
function provisionClone(ttRootDir: string, caseId: string, seed: string): string {
  const workDir = path.join(ttRootDir, "fixtures", "work");
  fs.mkdirSync(workDir, { recursive: true });
  const res = spawnSync(process.execPath, [
    provision, "--fixture", "tt-python", "--case-id", caseId, "--seed", seed,
    "--work-dir", workDir, "--golden-dir", sharedGoldenDir,
  ], {
    cwd: repoRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      TAMANDUA_TEST_GUARD: "0",
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  assert.equal(res.status, 0,
    `provisionWorkClone failed for ${caseId}:\n${res.stdout}${res.stderr}`);
  const clone = path.join(workDir, caseId, "tt-python");
  assert.ok(fs.existsSync(path.join(clone, ".git")), `work clone missing: ${clone}`);
  return clone;
}

// Run the W4.17 reset hook against a temp TT root (contained HOME = the
// temp root itself).
function runResetHook(ttRootDir: string): { status: number | null; stdout: string; stderr: string } {
  return run("bash", [hookPath], {
    TT_ROOT: ttRootDir,
    TT_REPO_ROOT: repoRoot,
    HOME: ttRootDir,
  });
}

// The W4.17 mandatory-arming case record (manifest shape).
function w417CaseRecord(id: string = W4_17_A): any {
  return { ...w417Record(id) };
}

// The pre-fix / post-fix terminal attempt shape for the gate tests.
function terminalAttempt(runId: string = "run-deadbeef-dead-beef-dead-beefdeadbeef"): any {
  return {
    id: "attempt-1",
    run_id: runId,
    phase: "terminal",
    terminal_at: "2026-08-31T00:00:00.000Z",
  };
}

describe("S42 (US-005) — W4.17 red-baseline arming hook + fail-closed absent-arm", () => {
  after(() => {
    // temp TT roots are removed by their own after()/scoped cleanup; no
    // shared-var mutation happened (provisioning only READ the golden).
  });

  it("RED-ARM: pins the pre-fix vacuity (no W4.17 hook, no red baseline) in traceability + manifest history", () => {
    // The pre-fix cases/hooks/ contents are pinned by the S42 traceability
    // section (the four pre-S42 hooks, no W4.17 hook).
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /## S42 W4\.17 red-baseline arming hook/, "traceability must carry the S42 section");
    assert.match(trace, /reset-w4\.26[^A-Za-z0-9]*reset-w4\.28[^A-Za-z0-9]*reset-w4\.30[^A-Za-z0-9]*reset-w4\.31/,
      "traceability must pin the pre-fix cases/hooks/ contents (only the four pre-S42 hooks)");
    assert.match(trace, /VACUOUS|vacuous/, "traceability must name the vacuity");
    // The pre-fix manifest shape (no reset hook, no arming) is pinned by the
    // same section — and the OTHER pre-S42 reset hooks still exist while the
    // W4.17 hook now does too.
    for (const pre of ["reset-w4.26-unreachable-origin.sh", "reset-w4.28-independent-bares.sh",
      "reset-w4.30-detached-head-origin.sh", "reset-w4.31-precommit-amend.sh"]) {
      assert.ok(fs.existsSync(path.join(hooksDir, pre)), `pre-S42 hook ${pre} must still exist`);
    }
    assert.ok(fs.existsSync(hookPath), "the S42 W4.17 reset hook must exist post-fix");
  });

  it("RED-ARM: reproduces the pre-fix vacuity (no gate -> verdict) and proves armAbsentGate refuses it post-fix", () => {
    const ttRootDir = fakeTtRoot();
    try {
      const caseRecord = w417CaseRecord();
      // The PRE-FIX attempt shape: a mandatory-arming case whose run reached
      // terminal with NO arming manifest (the machinery never performed the
      // mandated seed/arm — the campaign's W4.17 shape).
      const terminal = terminalAttempt();
      // Pre-fix behavior reproduced inline (history-independent): with no
      // gate, the run's terminal status drives a verdict — the campaign's
      // vacuity. This is the shape the S42 gate must refuse.
      assert.equal(terminal.phase, "terminal", "the pre-fix shape is a terminal attempt");
      // Post-fix: the gate refuses the SAME shape with TEST_INFRA_FAIL
      // 'arm-absent' — never a silent vacuous verdict.
      const reason = armAbsentGate(caseRecord, terminal, { varRoot: ttRootDir, atTerminal: true });
      assert.ok(reason !== null, "armAbsentGate must fire for the absent-arm shape");
      assert.equal(reason.category, "arm-absent");
      assert.equal(reason.case_id, W4_17_A);
      assert.match(reason.message, /never performed|no arming manifest/);
    } finally {
      fs.rmSync(ttRootDir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: the hook plants exactly 2 pre-existing red tests in a contained BUG-P1 clone (W4.17-a) and records the arming manifest", () => {
    const ttRootDir = fakeTtRoot();
    try {
      const clone = provisionClone(ttRootDir, W4_17_A, "BUG-P1");
      const notesBefore = fs.readFileSync(path.join(clone, "operator-notes.local"), "utf8");
      const seedsStatusBefore = runGit(clone, ["status", "--porcelain", "--", "seeds/"]).stdout;

      const hook = runResetHook(ttRootDir);
      assert.equal(hook.status, 0, `reset hook must exit 0:\n${hook.stdout}${hook.stderr}`);

      // Exactly 2 planted tests, committed at HEAD (O8 seeded-test blob
      // recovery reads git HEAD) and present in the worktree.
      for (const rel of [RED_A, RED_B]) {
        assert.ok(fs.existsSync(path.join(clone, rel)), `${rel} must exist in the work clone`);
        const committed = runGit(clone, ["cat-file", "-e", `HEAD:${rel}`]);
        assert.equal(committed.status, 0, `${rel} must be committed at HEAD`);
      }
      const trackedTests = runGit(clone, ["ls-files", "tests/"]).stdout.split("\n")
        .filter((line) => line.includes("pre_existing_red"));
      assert.equal(trackedTests.length, 2, "exactly 2 planted red tests must be tracked");

      // Provably red: pytest on exactly the 2 planted files -> exactly 2
      // failures; the full BUG-P1 suite is red by exactly those 2.
      const plantedRun = run(path.join(clone, ".venv", "bin", "python"),
        ["-m", "pytest", "-q", "--tb=no", "--no-header", RED_A, RED_B], {}, 120_000, clone);
      assert.notEqual(plantedRun.status, 0, "the planted tests must fail");
      assert.match(plantedRun.stdout, /2 failed/, "exactly the 2 planted tests must fail");
      const fullRun = run(path.join(clone, ".venv", "bin", "python"),
        ["-m", "pytest", "-q", "--tb=no", "--no-header"], {}, 120_000, clone);
      assert.notEqual(fullRun.status, 0, "the armed full suite must be red");
      assert.match(fullRun.stdout, /2 failed/, "the full suite must be red by exactly the 2 planted failures");

      // seeds/ untouched (no tracked changes) and operator-notes.local
      // byte-identical.
      const seedsStatusAfter = runGit(clone, ["status", "--porcelain", "--", "seeds/"]).stdout;
      assert.equal(seedsStatusAfter, seedsStatusBefore, "seeds/ must be untouched by the hook");
      const notesAfter = fs.readFileSync(path.join(clone, "operator-notes.local"), "utf8");
      assert.equal(notesAfter, notesBefore, "operator-notes.local must be untouched by the hook");

      // Arming manifest recorded (the armAbsentGate input).
      const manifest = readArmingManifest(ttRootDir, W4_17_A);
      assert.ok(manifest !== null, "the arming manifest must exist");
      assert.equal(manifest.armed, true);
      assert.equal(manifest.type, "red-baseline");
      assert.equal(manifest.count, 2);
      assert.deepEqual(manifest.red_tests, [RED_A, RED_B]);
      assert.equal(manifest.hook, "cases/hooks/reset-w4.17-red-baseline.sh");
      // The gate must NOT fire for the properly-armed shape.
      const reason = armAbsentGate(w417CaseRecord(), terminalAttempt(), { varRoot: ttRootDir, atTerminal: true });
      assert.equal(reason, null, "the gate must not fire when the arming manifest records the declared arming");
    } finally {
      fs.rmSync(ttRootDir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: the hook is idempotent (re-run: no new commit, still exactly 2 planted tests)", () => {
    const ttRootDir = fakeTtRoot();
    try {
      const clone = provisionClone(ttRootDir, W4_17_A, "BUG-P1");
      const first = runResetHook(ttRootDir);
      assert.equal(first.status, 0, `first hook run must succeed:\n${first.stdout}${first.stderr}`);
      const commitsBefore = runGit(clone, ["rev-list", "--count", "HEAD"]).stdout.trim();
      const trackedBefore = runGit(clone, ["ls-files", "tests/"]).stdout.split("\n")
        .filter((line) => line.includes("pre_existing_red")).length;

      const second = runResetHook(ttRootDir);
      assert.equal(second.status, 0, `second (idempotent) hook run must succeed:\n${second.stdout}${second.stderr}`);
      assert.match(second.stdout, /idempotent skip/, "the re-run must report the idempotent skip");

      const commitsAfter = runGit(clone, ["rev-list", "--count", "HEAD"]).stdout.trim();
      assert.equal(commitsAfter, commitsBefore, "the idempotent re-run must not create a new commit");
      const trackedAfter = runGit(clone, ["ls-files", "tests/"]).stdout.split("\n")
        .filter((line) => line.includes("pre_existing_red")).length;
      assert.equal(trackedAfter, 2, "still exactly 2 planted red tests after the re-run");
      assert.equal(trackedAfter, trackedBefore);
    } finally {
      fs.rmSync(ttRootDir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: the hook arms the BUG-P2 clone (W4.17-b) the same way (2 planted reds on top of the seeded failures)", () => {
    const ttRootDir = fakeTtRoot();
    try {
      const clone = provisionClone(ttRootDir, W4_17_B, "BUG-P2");
      const hook = runResetHook(ttRootDir);
      assert.equal(hook.status, 0, `reset hook must exit 0:\n${hook.stdout}${hook.stderr}`);
      const plantedRun = run(path.join(clone, ".venv", "bin", "python"),
        ["-m", "pytest", "-q", "--tb=no", "--no-header", RED_A, RED_B], {}, 120_000, clone);
      assert.notEqual(plantedRun.status, 0, "the planted tests must fail on the BUG-P2 clone");
      assert.match(plantedRun.stdout, /2 failed/, "exactly the 2 planted tests must fail");
      const manifest = readArmingManifest(ttRootDir, W4_17_B);
      assert.ok(manifest !== null, "the W4.17-b arming manifest must exist");
      assert.equal(manifest.armed, true);
      assert.equal(manifest.count, 2);
    } finally {
      fs.rmSync(ttRootDir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: both W4.17 manifest rows declare the reset hook + the mandatory arming block; validate-only stays green", () => {
    for (const id of [W4_17_A, W4_17_B]) {
      const record = w417Record(id);
      assert.ok(record.reset !== null && record.reset !== undefined, `${id} must declare a reset hook`);
      assert.equal(record.reset.executable, "cases/hooks/reset-w4.17-red-baseline.sh",
        `${id} must declare the S42 reset hook`);
      assert.deepEqual(record.reset.args, [], `${id} reset args must be empty`);
      assert.equal(record.reset.cwd, ".", `${id} reset cwd must be '.'`);
      assert.ok(record.arming !== null && record.arming !== undefined, `${id} must declare the arming block`);
      assert.equal(record.arming.mandatory, true, `${id} arming must be mandatory`);
      assert.equal(record.arming.type, "red-baseline", `${id} arming type must be red-baseline`);
      assert.equal(record.arming.count, 2, `${id} arming count must be 2`);
    }
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("GREEN-ARM: armAbsentGate fires for every absent/mismatched arming shape and never for the armed/non-obligated shapes", () => {
    const ttRootDir = fakeTtRoot();
    try {
      const caseRecord = w417CaseRecord();
      const terminal = terminalAttempt();

      // No manifest at all -> arm-absent.
      let reason = armAbsentGate(caseRecord, terminal, { varRoot: ttRootDir, atTerminal: true });
      assert.ok(reason !== null && reason.category === "arm-absent");

      // Manifest says armed:false -> arm-absent.
      fs.mkdirSync(path.join(ttRootDir, "arming"), { recursive: true });
      fs.writeFileSync(path.join(ttRootDir, "arming", `${W4_17_A}.json`),
        JSON.stringify({ case_id: W4_17_A, armed: false, type: "red-baseline", count: 2 }), "utf8");
      reason = armAbsentGate(caseRecord, terminal, { varRoot: ttRootDir, atTerminal: true });
      assert.ok(reason !== null && reason.category === "arm-absent", "armed:false manifest must fire arm-absent");

      // Type mismatch -> arm-absent.
      fs.writeFileSync(path.join(ttRootDir, "arming", `${W4_17_A}.json`),
        JSON.stringify({ case_id: W4_17_A, armed: true, type: "flaky-alternator", count: 2 }), "utf8");
      reason = armAbsentGate(caseRecord, terminal, { varRoot: ttRootDir, atTerminal: true });
      assert.ok(reason !== null && reason.category === "arm-absent", "type-mismatch manifest must fire arm-absent");

      // Count mismatch -> arm-absent.
      fs.writeFileSync(path.join(ttRootDir, "arming", `${W4_17_A}.json`),
        JSON.stringify({ case_id: W4_17_A, armed: true, type: "red-baseline", count: 1 }), "utf8");
      reason = armAbsentGate(caseRecord, terminal, { varRoot: ttRootDir, atTerminal: true });
      assert.ok(reason !== null && reason.category === "arm-absent", "count-mismatch manifest must fire arm-absent");

      // Malformed manifest (invalid JSON) -> evidence of absence -> arm-absent.
      fs.writeFileSync(path.join(ttRootDir, "arming", `${W4_17_A}.json`), "{ not json", "utf8");
      reason = armAbsentGate(caseRecord, terminal, { varRoot: ttRootDir, atTerminal: true });
      assert.ok(reason !== null && reason.category === "arm-absent", "malformed manifest must fire arm-absent");

      // Proper manifest -> null (no obligation violated).
      fs.writeFileSync(path.join(ttRootDir, "arming", `${W4_17_A}.json`),
        JSON.stringify({ case_id: W4_17_A, armed: true, type: "red-baseline", count: 2,
          red_tests: [RED_A, RED_B] }), "utf8");
      reason = armAbsentGate(caseRecord, terminal, { varRoot: ttRootDir, atTerminal: true });
      assert.equal(reason, null, "the properly-armed shape must not fire the gate");

      // Never fires for: no arming declaration, non-mandatory arming,
      // in-flight attempt, missing varRoot.
      const noArming = { ...caseRecord, arming: null };
      assert.equal(armAbsentGate(noArming, terminal, { varRoot: ttRootDir, atTerminal: true }), null);
      const nonMandatory = { ...caseRecord, arming: { mandatory: false, type: "red-baseline", count: 2 } };
      assert.equal(armAbsentGate(nonMandatory, terminal, { varRoot: ttRootDir, atTerminal: true }), null);
      const inFlight = { ...terminal, phase: "running", terminal_at: undefined };
      assert.equal(armAbsentGate(caseRecord, inFlight, { varRoot: ttRootDir, atTerminal: true }), null);
      assert.equal(armAbsentGate(caseRecord, terminal, { atTerminal: true }), null, "missing varRoot must not fire");
    } finally {
      fs.rmSync(ttRootDir, { recursive: true, force: true });
    }
  });
});

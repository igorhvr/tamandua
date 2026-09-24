// Tier-2 STORM base-seam conformance (schema-13 product; US-007).
//
// This is the ONE focused regression that pins the tt-storm orchestrator /
// execution machinery to the CURRENT product seams it consumes, WITHOUT any
// product edit:
//   * the resolved-launch block `workflow run` prints before the synchronous
//     `run #N (short8) created; preparing workspace...` line
//     (`working-directory:`/`origin:`, `harness:`, `daemon:`, `matchlock:`);
//   * the Matchlock flags (`--matchlock`, `--matchlock-cpus`,
//     `--matchlock-memory`, `--matchlock-disk`) forwarded verbatim on the
//     launch argv the engine hands the product;
//   * worker claim authority (`TAMANDUA_WORKER_PID` / `TAMANDUA_WORKER_PGID`)
//     stripped at every spawn boundary;
//   * canonical UTC instants (`...Z` with milliseconds) the product parses;
//   * the sweep ownership rule: the controller/engine resolve a target from
//     the recorded claim/orchestrator identity, NEVER a /proc cwd/cmdline
//     sweep, and a worktree launch origin must prove containment.
//
// Pure/in-process; no daemon, no harness, no VM, no product file touched.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  REAL_CLOCK,
  extractRunEvidence,
  isAuthorityEnvKey,
  requireUnambiguousRunId,
  stripParentAuthorityEnv,
  workflowRunArgv,
} from "../bin/tt-storm-shared.mjs";
import { resolveOwnedWorktreeOrigin } from "../bin/tt-storm-engine.mjs";
import { assertLaunchOriginContained } from "../bin/tt-storm-rehearsal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");

const RUN_ID = "run-12345678-1234-4234-8234-123456789abc";
const SHORT = "12345678";
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function readSource(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("tt-storm base-seam conformance (schema-13 product, US-007)", () => {
  it("B1: parses the base direct-mode resolved-launch block + run-created line", () => {
    const stdout = [
      "working-directory: /srv/work clean",
      "harness: pi /usr/bin/pi (1.2.3)",
      "daemon: http://127.0.0.1:3334 ok",
      "matchlock: vic/matchlock-base:latest cpus=4 memory=4096MB disk=20480MB",
      `Run: ${RUN_ID}`,
      "Workflow: feature-dev-merge-worktree",
      "Task: do the thing",
    ].join("\n") + "\n";
    const stderr = `run #7 (${SHORT}) created; preparing workspace...\n`;
    const evidence = extractRunEvidence({ stdout, stderr, exitCode: 0 });
    assert.equal(evidence.ok, true, "the run id is extracted from the base stdout");
    assert.equal(evidence.stdoutRunId, RUN_ID);
    assert.equal(evidence.stderrShortId, SHORT);
    assert.equal(requireUnambiguousRunId(evidence, { rosterId: "S1" }), RUN_ID);
    assert.deepEqual(evidence.evidenceLines, [
      `stdout: Run: ${RUN_ID}`,
      `stderr: run #7 (${SHORT}) created`,
    ]);
  });

  it("B2: parses the base worktree-mode resolved-launch block (`origin:` line)", () => {
    const stdout = [
      "origin: /repos/tt-poly @ main (0123456789abcdef0123456789abcdef01234567) clean",
      "harness: hermes /usr/bin/hermes (0.9.0)",
      "daemon: http://127.0.0.1:3339 ok",
      `Run: ${RUN_ID}`,
    ].join("\n") + "\n";
    const evidence = extractRunEvidence({
      stdout,
      stderr: `run #8 (${SHORT}) created; preparing workspace...\n`,
      exitCode: 0,
    });
    assert.equal(evidence.stdoutRunId, RUN_ID);
    assert.equal(requireUnambiguousRunId(evidence, { rosterId: "S2" }), RUN_ID);
  });

  it("B3: missing/ambiguous run identity fails closed (never fabricated)", () => {
    const none = extractRunEvidence({ stdout: "working-directory: /srv/work clean\n", stderr: "", exitCode: 0 });
    assert.equal(none.ok, false);
    assert.equal(none.stdoutRunId, null);
    assert.throws(() => requireUnambiguousRunId(none, { rosterId: "S1" }), /missing run identity/i);

    const ambiguous = extractRunEvidence({
      stdout: `Run: ${RUN_ID}\n`,
      stderr: "run #9 (deadbeef) created; preparing workspace...\n",
      exitCode: 0,
    });
    assert.throws(() => requireUnambiguousRunId(ambiguous, { rosterId: "S1" }), /ambiguous run provenance/i);
  });

  it("B4: forwards the base Matchlock flags verbatim on the launch argv", () => {
    const argv = workflowRunArgv({
      workflow: "feature-dev-merge-worktree",
      taskFile: "/var/tasks/S1.task.md",
      harness: "hermes",
      context: ["branch=broken-tests"],
      originRepository: "/var/repos/origin",
      originRef: "main",
      extra: [
        "--matchlock", "vic/matchlock-base:latest",
        "--matchlock-cpus", "4",
        "--matchlock-memory", "4096",
        "--matchlock-disk", "20480",
      ],
    });
    assert.deepEqual(argv, [
      "tamandua", "workflow", "run", "feature-dev-merge-worktree",
      "--task-file", "/var/tasks/S1.task.md",
      "--hermes-as-harness",
      "--context", "branch=broken-tests",
      "--worktree-origin-repository", "/var/repos/origin",
      "--worktree-origin-ref", "main",
      "--matchlock", "vic/matchlock-base:latest",
      "--matchlock-cpus", "4",
      "--matchlock-memory", "4096",
      "--matchlock-disk", "20480",
    ]);
  });

  it("B5: strips worker claim authority (PID + PGID + run/step family) at the spawn boundary", () => {
    for (const key of [
      "TAMANDUA_WORKER_PID",
      "TAMANDUA_WORKER_PGID",
      "TAMANDUA_RUN_ID",
      "TAMANDUA_STEP_ID",
      "TAMANDUA_WORKER_JOB_ID",
    ]) {
      assert.equal(isAuthorityEnvKey(key), true, `${key} is an authority key`);
    }
    const stripped = stripParentAuthorityEnv({
      TAMANDUA_WORKER_PID: "123",
      TAMANDUA_WORKER_PGID: "456",
      TAMANDUA_RUN_ID: "run-x",
      TAMANDUA_STEP_ID: "step-x",
      TAMANDUA_WORKER_JOB_ID: "job-x",
      TAMANDUA_TEST_GUARD: "1",
      TT_HOME: "/private/home",
      PATH: "/usr/bin",
    });
    for (const gone of [
      "TAMANDUA_WORKER_PID",
      "TAMANDUA_WORKER_PGID",
      "TAMANDUA_RUN_ID",
      "TAMANDUA_STEP_ID",
      "TAMANDUA_WORKER_JOB_ID",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(stripped, gone), false, `${gone} removed`);
    }
    assert.equal(stripped.TAMANDUA_TEST_GUARD, "1");
    assert.equal(stripped.TT_HOME, "/private/home");
    assert.equal(stripped.PATH, "/usr/bin");
  });

  it("B6: emits canonical UTC instants (ISO-8601 ...Z with milliseconds)", () => {
    const now = REAL_CLOCK.nowUtc();
    assert.match(now, ISO_Z_RE);
    assert.ok(Number.isFinite(Date.parse(now)), "the product's Date.parse accepts the instant");
  });

  it("B7: the sweep ownership rule — claim/owned identity only, never a /proc cwd/cmdline sweep", () => {
    const controller = readSource("torture-test/bin/tt-controller");
    assert.equal(/\/proc\/\$\{[^}]*\}\/cwd/.test(controller), false, "tt-controller never reads /proc/<pid>/cwd");
    assert.equal(/\/proc\/\$\{[^}]*\}\/cmdline/.test(controller), false, "tt-controller never reads /proc/<pid>/cmdline");
    assert.match(controller, /claim row/i);

    // The engine's ONE origin resolution is orchestrator-owned identity and is
    // fail-closed (null, never cwd/HOME) when no owned origin is declared.
    assert.equal(resolveOwnedWorktreeOrigin({ opts: {}, state: {} }), null);
    assert.equal(
      resolveOwnedWorktreeOrigin({ opts: { originRepo: "/var/repos/origin" }, state: {} }),
      "/var/repos/origin",
    );

    // A resolved origin must PROVE containment; a lexically/realpath-escaping
    // origin is refused (SF-2), and a contained one is accepted.
    const root = fs.mkdtempSync(path.join(TT_ROOT, "var", "storm-base-seams."));
    try {
      const owned = path.join(root, "origin");
      fs.mkdirSync(owned);
      const contained = assertLaunchOriginContained({
        ownedRoots: [root],
        originRepository: owned,
        fs,
        label: "S1",
      });
      assert.equal(contained.ok, true);
      assert.throws(
        () => assertLaunchOriginContained({ ownedRoots: [root], originRepository: "/etc", fs, label: "S2" }),
        /escapes the campaign-owned roots/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * MTLK-ALL-WORKFLOWS US-009 — fast artifact contract for the on-demand hermes
 * whole-path merge gate.
 *
 * The real-VM gate itself is opt-in (it boots fresh Firecracker VMs and is only
 * run by `./run-matchlock-hermes-merge-worktree-e2e-test` under the shared gate
 * lock), so this file is a pure filesystem contract: it pins the artifacts the
 * story adds and the load-bearing pieces of the gate/runner so a rewrite cannot
 * silently drop the hermes harness, the per-round session/usage projection, the
 * host landing, the fresh-VM/teardown checks or the corrupt-event control.
 *
 * If you add a test file that imports `node:child_process`, it belongs in the
 * serial lane; this file deliberately avoids it (parallel lane).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const GATE_FILE = "e2e-tests/matchlock-hermes-merge-worktree-gate.test.ts";
const RUNNER_FILE = "run-matchlock-hermes-merge-worktree-e2e-test";

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf-8");
}

describe("US-009 hermes whole-path merge gate artifacts", () => {
  it("ships the real-VM gate file with the hermes identity and merge acceptance surface", () => {
    const gate = readRepo(GATE_FILE);
    for (const needle of [
      "feature-dev-merge-worktree",
      "--hermes-as-harness",
      "tamandua-synthetic-hermes:gate-fixture",
      "assertNoOwnedVms",
      "readRunnerVmEvidenceIds",
      "cleanupOwnedVms",
      "readRunEvents",
      "MERGED_TREE",
      "TESTED_TREE",
      "REAL_VM_GATE_ENABLED",
      "corrupt event JSON",
      "readHermesStoreRows",
      "cache_write_tokens",
      "PROBE_TOKEN_TOTAL",
      "WORK_TOKEN_TOTAL",
      "runs.tokens_spent",
    ]) {
      assert.ok(gate.includes(needle), `${GATE_FILE} must contain ${needle}`);
    }
  });

  it("asserts the authoritative per-round session recovery and exact usage projection", () => {
    const gate = readRepo(GATE_FILE);
    assert.ok(
      gate.includes("readHermesStoreRows(hermesHomeRoot)"),
      "the gate must read the mapped Hermes store sessions",
    );
    assert.ok(
      /contains an unexpected projected total/.test(gate) ||
        /projected a non-positive total/.test(gate),
      "the gate must reject non-positive / unexpected per-session projected totals",
    );
    assert.ok(
      /runs\.tokens_spent .*must equal the .* mapped-store projected totals/.test(gate),
      "the gate must reconcile runs.tokens_spent against the mapped-store projected totals (anti-borrow)",
    );
    assert.ok(
      /expected exactly \$\{EXPECTED_PROBES\} probe session/.test(gate),
      "the gate must pin exactly one recovered probe session",
    );
  });

  it("keeps the real-VM scenario opt-in so a bare run only exercises the no-VM controls", () => {
    const gate = readRepo(GATE_FILE);
    assert.match(
      gate,
      /const REAL_VM_GATE_ENABLED = EVIDENCE_DIR\.length > 0 && MATCHLOCK_RPC_BIN\.length > 0;/,
    );
    assert.ok(
      gate.includes("REAL_VM_GATE_ENABLED ? describe : describe.skip"),
      "the real-VM describe must be skipped unless the runner exports the gate env",
    );
  });

  it("ships an executable on-demand runner that resolves the system runtime and retains fresh evidence", () => {
    const runner = readRepo(RUNNER_FILE);
    fs.accessSync(path.join(repoRoot, RUNNER_FILE), fs.constants.X_OK);
    for (const needle of [
      "command -v matchlock",
      "command -v guest-init",
      "TAMANDUA_MATCHLOCK_RPC_BIN",
      "MATCHLOCK_GUEST_INIT",
      "MATCHLOCK_GUEST_FUSED",
      "TAMANDUA_GATE_EVIDENCE_ROOT:-/home/kaladin/matchlock-work/evidence",
      "mktemp -d",
      "TAMANDUA_GATE_FIXTURE_IMAGE_CACHE",
      "export TMPDIR=",
      "npm run build",
      "node --test e2e-tests/matchlock-hermes-merge-worktree-gate.test.ts",
      "exit \"$RC\"",
    ]) {
      assert.ok(runner.includes(needle), `${RUNNER_FILE} must contain ${needle}`);
    }
    assert.ok(
      runner.includes("flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock"),
      "the runner docs must name the shared gate lock (the caller holds it)",
    );
  });
});

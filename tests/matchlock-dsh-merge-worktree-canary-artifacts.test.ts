/**
 * MTLK-ALL-WORKFLOWS US-010 — fast artifact contract for the on-demand real-model
 * dsh canary for `feature-dev-merge-worktree`.
 *
 * The real canary itself is opt-in (it makes REAL model calls and boots fresh
 * Firecracker VMs, and is only run by
 * `./run-matchlock-dsh-merge-worktree-canary-e2e-test` under the shared gate
 * lock), so this file is a pure filesystem contract: it pins the artifacts the
 * story adds and the load-bearing pieces of the canary/runner so a rewrite
 * cannot silently drop the dsh harness, the real operator image + credential
 * home, the host landing assertion, the per-round v3-store attribution, the
 * fresh-VM/exact-owned teardown checks or the credentials-never-printed rule.
 *
 * Deliberately avoids `node:child_process` (parallel lane; no
 * tests/serial-files.txt entry).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const CANARY_FILE = "e2e-tests/matchlock-dsh-merge-worktree-canary.test.ts";
const RUNNER_FILE = "run-matchlock-dsh-merge-worktree-canary-e2e-test";

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf-8");
}

describe("US-010 dsh feature-dev-merge-worktree real canary artifacts", () => {
  it("ships the real-token canary with the dsh identity and landing/token acceptance surface", () => {
    const canary = readRepo(CANARY_FILE);
    for (const needle of [
      "feature-dev-merge-worktree",
      "--dsh-as-harness",
      "igorhvr/bedlam-ubuntu",
      "TAMANDUA_GATE_REAL_DSH_HOME",
      "REAL_VM_CANARY_ENABLED",
      "merge.landed",
      "MERGED_TREE",
      "STATUS: done",
      "reconcileAllSessions",
      "input+output, cache_read excluded, tolerance 0",
      "runs.tokens_spent",
      "readRunnerVmEvidenceIds",
      "assertNoOwnedVms",
      "cleanupOwnedVms",
      "corrupt event JSON",
      "restoreSharedHomeAlias",
    ]) {
      assert.ok(canary.includes(needle), `${CANARY_FILE} must contain ${needle}`);
    }
  });

  it("keeps the real canary opt-in so a bare run only exercises the no-VM controls", () => {
    const canary = readRepo(CANARY_FILE);
    assert.match(
      canary,
      /const REAL_VM_CANARY_ENABLED =\s*\n?\s*EVIDENCE_DIR\.length > 0 && MATCHLOCK_RPC_BIN\.length > 0 && REAL_DSH_HOME\.length > 0;/,
    );
    assert.ok(
      canary.includes("REAL_VM_CANARY_ENABLED ? describe : describe.skip"),
      "the real-VM describe must be skipped unless the runner exports the canary env",
    );
  });

  it("asserts every mapped v3 session carries positive usage and reconciles the run total", () => {
    const canary = readRepo(CANARY_FILE);
    assert.ok(
      canary.includes("assert.ok(s.usageTokens > 0") ||
        canary.includes("assert.ok(\n        s.usageTokens > 0") ||
        /usageTokens > 0/.test(canary),
      "the canary must require positive per-round usage on every session",
    );
    assert.ok(
      /assert\.equal\(\s*tokensSpent,\s*store\.storeTotal/.test(canary),
      "the canary must reconcile runs.tokens_spent against the v3 store total (tolerance 0)",
    );
  });

  it("ships an executable on-demand runner that resolves the system runtime and retains fresh evidence", () => {
    fs.accessSync(path.join(repoRoot, RUNNER_FILE), fs.constants.X_OK);
    const runner = readRepo(RUNNER_FILE);
    for (const needle of [
      "command -v matchlock",
      "command -v guest-init",
      "TAMANDUA_MATCHLOCK_RPC_BIN",
      "MATCHLOCK_GUEST_INIT",
      "MATCHLOCK_GUEST_FUSED",
      "TAMANDUA_GATE_OPERATOR_CACHE:-$HOME/.cache/matchlock",
      "TAMANDUA_GATE_REAL_DSH_HOME:-$HOME/.dsh",
      "TAMANDUA_GATE_EVIDENCE_ROOT:-/home/kaladin/matchlock-work/evidence",
      "mktemp -d",
      "export TMPDIR=",
      "npm run build",
      "node --test e2e-tests/matchlock-dsh-merge-worktree-canary.test.ts",
      'exit "$RC"',
    ]) {
      assert.ok(runner.includes(needle), `${RUNNER_FILE} must contain ${needle}`);
    }
    assert.ok(
      runner.includes("flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock"),
      "the runner docs must name the shared gate lock (the caller holds it)",
    );
  });

  it("never prints the operator dsh credentials", () => {
    const runner = readRepo(RUNNER_FILE);
    for (const forbidden of [
      'cat "$REAL_DSH_HOME/.credentials.yaml"',
      "cat $REAL_DSH_HOME/.credentials.yaml",
      'echo "$(cat',
      "printenv DSH",
    ]) {
      assert.ok(!runner.includes(forbidden), `${RUNNER_FILE} must never emit credentials (${forbidden})`);
    }
    assert.ok(
      runner.includes("credentials copied, never printed"),
      "the runner must record that credentials are copied and never printed",
    );
  });
});

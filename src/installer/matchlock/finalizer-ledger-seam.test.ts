/**
 * US-006 finalizer ledger seam — enforcement through BOTH finalize_merge
 * decision sites (claim gate + completion acceptance) and threading through
 * the controller-attested NativeStepServices adapter.
 *
 * Proves:
 *   - the claim-time gate (enforceClaimLedgerGate via claimStep) and the
 *     completion acceptance gate (completeStep) consult the opted-in
 *     host-attested source instead of native `suite_results`;
 *   - native/no-flag callers ignore both the Matchlock store AND any
 *     run-context/execution-isolation knobs (no context/env activation);
 *   - only the controller-attested adapter path supplies the source.
 *
 * Serial lane: real private native DB + real HostSuiteStore + step-ops.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { getDb } from "../../../dist/db.js";
import { claimStep, completeStep } from "../../../dist/installer/step-ops.js";
import {
  guestSuiteNamespaceId,
  type GuestSuiteNamespace,
} from "../../../dist/installer/matchlock/guest-suite-contract.js";
import { openHostSuiteStore, type HostSuiteStore } from "../../../dist/installer/matchlock/host-suite-store.js";
import { createHostSuiteLedgerEvidenceSource } from "../../../dist/installer/matchlock/suite-ledger-source.js";
import { NativeStepServices } from "../../../dist/installer/matchlock/native-step-services.js";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import {
  AGENT,
  JOB_ID,
  RUN,
  applyEnv,
  bindingFor,
  createIsolatedState,
  snapshotEnv,
  type IsolatedState,
} from "../../../dist/installer/matchlock/native-step-test-utils.js";
import { computeCmdHash, getOriginRepo } from "../../../dist/suite/tree-hash.js";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";

const TEST_CMD = "npm test -- --runInBand ";
const TESTED_TREE = "0123456789abcdef0123456789abcdef01234567";
const FINALIZE_STEP = "finalize-row-0001";
const TESTER_STEP = "tester-row-0001";
const INV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const NAMESPACE: GuestSuiteNamespace = {
  imageContentId: "sha256:seam-image",
  guestPlatform: "linux/amd64",
  helperContract: "guest-helper-seam",
  compatibilityFingerprint: "fp-seam",
};

const sticky = createIsolatedState("ledger-seam-sticky");
sticky.open();
const stickyEnv = snapshotEnv();

/** Shared real git origin repo (stable origin realpath for every scenario). */
const fixtureRepo = (() => {
  const root = tamanduaTempDir("tamandua-ledger-seam-fixture-");
  const repo = path.join(root, "origin");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ledger-seam@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Ledger Seam Test"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  return repo;
})();

after(() => {
  try {
    fs.rmSync(sticky.root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  try {
    fs.rmSync(path.dirname(fixtureRepo), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

afterEach(() => {
  applyEnv(stickyEnv);
});

interface Scenario {
  st: IsolatedState;
  db: ReturnType<typeof getDb>;
  repo: string;
  store: HostSuiteStore;
  source: ReturnType<typeof createHostSuiteLedgerEvidenceSource>;
}

/**
 * Seed a run whose finalize_merge step is pending (claim tests) or running
 * (completion tests), plus a real HostSuiteStore-backed evidence source.
 */
function seedScenario(opts: {
  native?: "green" | "red" | "missing";
  matchlock?: "green" | "red" | "missing";
  finalizeStatus?: "pending" | "running";
  gateMode?: "default" | "green";
  contextKnobs?: boolean;
}): Scenario {
  const st = createIsolatedState("ledger-seam");
  st.open();
  const repo = fixtureRepo;
  const origin = getOriginRepo(repo);
  const context: Record<string, string> = {
    repo,
    worktree_origin_repository: repo,
    test_cmd: TEST_CMD,
    merge_gate: opts.gateMode ?? "green",
  };
  if (opts.contextKnobs) {
    // Context/execution-isolation knobs that could plausibly be abused to
    // activate a Matchlock ledger path: they MUST NOT do so.
    context.matchlock_policy = JSON.stringify({ enabled: true });
    context.execution_isolation = "matchlock";
    context.matchlock_suite_store = "/nonexistent-matchlock-store.db";
  }
  st.insertRun({ id: RUN, workflowId: "seam-workflow", context: JSON.stringify(context) });
  st.insertStep({
    id: TESTER_STEP,
    stepId: "test",
    agentId: "tester",
    stepIndex: 0,
    status: "done",
    output: `STATUS: done\nTESTED_TREE: ${TESTED_TREE}`,
  });
  st.insertStep({
    id: FINALIZE_STEP,
    stepId: "finalize_merge",
    agentId: AGENT,
    stepIndex: 1,
    status: opts.finalizeStatus ?? "pending",
    expects: "STATUS: done",
  });

  const matchlock = opts.matchlock ?? "missing";
  if (matchlock !== "missing") {
    const storePath = path.join(st.stateDir, "matchlock-suite.db");
    const store = openHostSuiteStore(storePath, { now: () => Date.parse("2026-08-01T00:00:00.000Z") });
    store.record({
      namespaceId: guestSuiteNamespaceId(NAMESPACE),
      originRepo: origin,
      treeHash: TESTED_TREE,
      cmdHash: computeCmdHash(TEST_CMD),
      cmdDisplay: TEST_CMD,
      exitCode: matchlock === "green" ? 0 : 3,
      durationMs: 12,
      logTail: "matchlock tail",
      runId: RUN,
      stepId: "test",
      startedAt: "2026-08-01T00:00:00.000Z",
      invocationId: "11111111-2222-4333-8444-555555555555",
      agentId: "tester",
      jobId: JOB_ID,
      force: false,
    });
    const source = createHostSuiteLedgerEvidenceSource({ store, namespace: NAMESPACE });
    seedNativeLedger(opts.native ?? "missing", origin);
    return { st, db: getDb(), repo, store, source };
  }

  seedNativeLedger(opts.native ?? "missing", origin);
  // An open-but-empty store still yields a valid canonical source.
  const store = openHostSuiteStore(path.join(st.stateDir, "matchlock-suite.db"));
  const source = createHostSuiteLedgerEvidenceSource({ store, namespace: NAMESPACE });
  return { st, db: getDb(), repo, store, source };
}

function seedNativeLedger(state: "green" | "red" | "missing", origin: string): void {
  if (state === "missing") return;
  getDb().prepare(
    `INSERT INTO suite_results
       (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
     VALUES (?, ?, ?, ?, ?, 7, 'native tail', 'native-run', 'native-step', '2026-08-02T00:00:00.000Z')`,
  ).run(origin, TESTED_TREE, computeCmdHash(TEST_CMD), TEST_CMD, state === "green" ? 0 : 5);
}

describe("US-006 finalize_merge claim gate uses the controller-attested source", () => {
  it("Matchlock green satisfies the claim gate while native has no evidence", () => {
    const { st, source } = seedScenario({ native: "missing", matchlock: "green" });
    try {
      const claim = claimStep(AGENT, RUN, undefined, { ledgerEvidenceSource: source });
      assert.equal(claim.found, true);
      assert.equal(claim.stepId, FINALIZE_STEP);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("Matchlock red refuses a claim even when native has a green row", () => {
    const { st, source } = seedScenario({ native: "green", matchlock: "red" });
    try {
      const claim = claimStep(AGENT, RUN, undefined, { ledgerEvidenceSource: source });
      assert.equal(claim.found, false, "Matchlock red must win over a stale native green");
      const failed = getDb().prepare("SELECT status, output FROM steps WHERE id = ?").get(FINALIZE_STEP) as {
        status: string;
        output: string | null;
      };
      assert.equal(failed.status, "failed");
      assert.match(failed.output ?? "", /^LEDGER_EVIDENCE: red$/m);
      // The refusal text carries the Matchlock row's exit code, not native's.
      assert.match(failed.output ?? "", /^EXIT_CODE: 3$/m);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("an opted-in empty store ignores native green evidence (no native fallback)", () => {
    const { st, source } = seedScenario({ native: "green", matchlock: "missing" });
    try {
      const claim = claimStep(AGENT, RUN, undefined, { ledgerEvidenceSource: source });
      assert.equal(claim.found, false, "native evidence must never satisfy an opted-in Matchlock gate");
      const failed = getDb().prepare("SELECT status, output FROM steps WHERE id = ?").get(FINALIZE_STEP) as {
        status: string;
        output: string | null;
      };
      assert.equal(failed.status, "failed");
      assert.match(failed.output ?? "", /^LEDGER_EVIDENCE: missing$/m);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("no-flags native claim ignores the Matchlock store even with activation-looking context knobs", () => {
    const { st } = seedScenario({
      native: "missing",
      matchlock: "green",
      contextKnobs: true,
      gateMode: "green",
    });
    try {
      // No ledgerEvidenceSource option: strict green-mode missing evidence
      // refuses permanently. A context/env-activated seam would have accepted
      // the Matchlock green row instead.
      const claim = claimStep(AGENT, RUN);
      assert.equal(claim.found, false, "run context must never activate the Matchlock ledger seam");
      const failed = getDb().prepare("SELECT output FROM steps WHERE id = ?").get(FINALIZE_STEP) as {
        output: string | null;
      };
      assert.match(failed.output ?? "", /^LEDGER_EVIDENCE: missing$/m);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("US-006 finalize_merge completion acceptance uses the controller-attested source", () => {
  it("accepts a completion backed by Matchlock green evidence while native is empty", () => {
    const { st, source } = seedScenario({ native: "missing", matchlock: "green", finalizeStatus: "running" });
    try {
      const result = completeStep(FINALIZE_STEP, "STATUS: done\n", { ledgerEvidenceSource: source });
      assert.equal(result.status, "completed");
      const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(RUN) as { status: string };
      assert.equal(run.status, "completed");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("refuses a completion when Matchlock evidence is red despite a native green row", () => {
    const { st, source } = seedScenario({ native: "green", matchlock: "red", finalizeStatus: "running" });
    try {
      const result = completeStep(FINALIZE_STEP, "STATUS: done\n", { ledgerEvidenceSource: source });
      assert.notEqual(result.status, "completed");
      assert.match(result.detail ?? "", /^LEDGER_EVIDENCE: red$/m);
      const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(RUN) as { status: string };
      assert.equal(run.status, "failed");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("no-flags completion uses native evidence and never the Matchlock store", () => {
    const { st } = seedScenario({
      native: "missing",
      matchlock: "green",
      finalizeStatus: "running",
      gateMode: "green",
      contextKnobs: true,
    });
    try {
      const result = completeStep(FINALIZE_STEP, "STATUS: done\n");
      assert.notEqual(result.status, "completed", "run context must never activate the Matchlock ledger seam");
      assert.match(result.detail ?? "", /^LEDGER_EVIDENCE: missing$/m);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("no-flags completion still accepts native green evidence", () => {
    const { st } = seedScenario({ native: "green", matchlock: "missing", finalizeStatus: "running" });
    try {
      const result = completeStep(FINALIZE_STEP, "STATUS: done\n");
      assert.equal(result.status, "completed");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("an opted-in empty store ignores native green evidence (no native fallback)", () => {
    const { st, source } = seedScenario({ native: "green", matchlock: "missing", finalizeStatus: "running" });
    try {
      const result = completeStep(FINALIZE_STEP, "STATUS: done\n", { ledgerEvidenceSource: source });
      assert.notEqual(result.status, "completed", "native evidence must never satisfy an opted-in Matchlock gate");
      assert.match(result.detail ?? "", /^LEDGER_EVIDENCE: missing$/m);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("US-006 NativeStepServices threads the controller-attested source", () => {
  it("claim consults the injected source; without it the native gate applies", async () => {
    const { st, source } = seedScenario({ native: "missing", matchlock: "green" });
    try {
      const registry = new HostInvocationRegistry();
      const admitted = registry.admitInvocation({ invocationId: INV, runId: RUN, agentId: AGENT, jobId: JOB_ID });
      assert.equal(admitted.ok, true);

      const withSource = new NativeStepServices({
        binding: bindingFor(INV),
        registry,
        workerOwnership: { jobId: JOB_ID, pid: process.pid },
        ledgerEvidenceSource: source,
      });
      const claim = await withSource.claim(bindingFor(INV));
      assert.equal(claim.found, true, "the adapter must thread the host-attested source into claimStep");

      // Control: a fresh run for the same adapter WITHOUT the source must not
      // consult the Matchlock store.
      const st2 = createIsolatedState("ledger-seam-control");
      st2.open();
      const repo2 = fixtureRepo;
      st2.insertRun({
        id: RUN,
        workflowId: "seam-workflow",
        context: JSON.stringify({
          repo: repo2,
          worktree_origin_repository: repo2,
          test_cmd: TEST_CMD,
          merge_gate: "green",
        }),
      });
      st2.insertStep({
        id: TESTER_STEP,
        stepId: "test",
        agentId: "tester",
        stepIndex: 0,
        status: "done",
        output: `STATUS: done\nTESTED_TREE: ${TESTED_TREE}`,
      });
      st2.insertStep({
        id: FINALIZE_STEP,
        stepId: "finalize_merge",
        agentId: AGENT,
        stepIndex: 1,
        status: "pending",
      });
      const registry2 = new HostInvocationRegistry();
      assert.equal(
        registry2.admitInvocation({ invocationId: INV, runId: RUN, agentId: AGENT, jobId: JOB_ID }).ok,
        true,
      );
      const withoutSource = new NativeStepServices({
        binding: bindingFor(INV),
        registry: registry2,
        workerOwnership: { jobId: JOB_ID, pid: process.pid },
      });
      const nativeClaim = await withoutSource.claim(bindingFor(INV));
      assert.equal(nativeClaim.found, false, "native/no-flag behavior must remain the ledger-gate refusal");
      st2.dispose(stickyEnv);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

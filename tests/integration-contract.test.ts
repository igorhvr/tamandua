/**
 * integration-contract.test.ts — MTLK-INTEGRATE US-016.
 *
 * Validates the FINAL out-of-repo deliverable for the MTLK-INTEGRATE run:
 *
 *   /root/matchlock-work/integration-contract.json
 *
 * Every MTLK-INTEGRATE deliverable is published outside the repository (the
 * integration working tree stays clean), so this validation is environment
 * gated: when the artifact is absent — e.g. a plain upstream checkout that
 * never ran the MTLK-INTEGRATE workflow — the tests skip instead of failing.
 * Inside the MTLK-INTEGRATE integration checkout (and in the run's designated
 * `npm test`) the artifact is present and every assertion executes.
 *
 * The assertions encode US-016's acceptance criteria: valid JSON with the
 * required top-level keys, the three real merge commits plus the four source
 * tips, a 3-harness x required-workflow capability matrix whose every cell
 * names the test that pins it, a gate ledger with an exact command / evidence
 * log / recorded exit per gate, an explicit run-54 baseline comparison, the
 * remaining scope, and the no-fake-green statement.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const CONTRACT_PATH =
  process.env.TAMANDUA_INTEGRATION_CONTRACT ??
  "/root/matchlock-work/integration-contract.json";

const REPO_ROOT = process.cwd();
const ARTIFACT_PRESENT = fs.existsSync(CONTRACT_PATH);

type CapabilityCell = {
  harness: string;
  workflow: string;
  decision: string;
  pinned_by: string;
};

type MergeCommit = {
  order?: number;
  branch?: string;
  source_tip?: string;
  merge_commit?: string;
  parents?: string[];
};

type Gate = {
  gate?: string;
  command?: string;
  commands?: Array<Record<string, unknown>>;
  exit?: unknown;
  log?: string;
  dsh_log?: string;
  dsh_retry_log?: string;
  [key: string]: unknown;
};

type Contract = {
  merge_commits?: MergeCommit[];
  source_tips?: Record<string, string>;
  capability_matrix?: {
    cells?: CapabilityCell[];
    source_of_truth?: string;
    pinning_tests?: string[];
  };
  gates?: Gate[];
  baseline_comparison?: Record<string, unknown>;
  remaining_scope?: string[];
  no_fake_green?: string;
};

function loadContract(): Contract {
  return JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf-8")) as Contract;
}

function isHex40(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

const HARNESSES = ["pi", "hermes", "dsh"] as const;

/** The union's admitted/refused workflow surface required by US-016 AC3. */
const REQUIRED_WORKFLOWS = [
  "do-now",
  "do-review-do-verify",
  "feature-dev-merge-worktree",
  "bug-fix-merge-worktree",
  "feature-dev-merge",
  "bug-fix-merge",
  "just-do-it",
  "*-github-pr",
  "frontend-test",
  "quarantine-*",
  "unknown",
] as const;

/** Exact ids (no glob) accepted by every harness in the union. */
const SHALLOW_WORKFLOWS = ["do-now", "do-review-do-verify"] as const;
/** The four capability-closed merge shapes accepted by pi only. */
const MERGE_WORKFLOWS = [
  "feature-dev-merge-worktree",
  "bug-fix-merge-worktree",
  "feature-dev-merge",
  "bug-fix-merge",
] as const;

function workflowLabelMatches(label: string, workflow: string): boolean {
  if (label === "*-github-pr") return workflow.endsWith("-github-pr");
  if (label === "quarantine-*") return workflow.startsWith("quarantine-");
  if (label === "unknown") return workflow.startsWith("unknown");
  return workflow === label;
}

function gateLogPaths(gate: Gate): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.endsWith(".log") || value.includes("/evidence/")) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(gate);
  return found;
}

describe("MTLK-INTEGRATE final integration contract (US-016)", () => {
  it("is valid JSON with the six required top-level keys", (t) => {
    if (!ARTIFACT_PRESENT) {
      t.skip(`no MTLK-INTEGRATE artifact at ${CONTRACT_PATH}`);
      return;
    }
    const contract = loadContract();
    for (const key of [
      "merge_commits",
      "capability_matrix",
      "gates",
      "baseline_comparison",
      "remaining_scope",
      "no_fake_green",
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(contract, key),
        `integration-contract.json must have top-level key '${key}'`,
      );
    }
    assert.ok(Array.isArray(contract.merge_commits), "merge_commits must be an array");
    assert.ok(Array.isArray(contract.gates), "gates must be an array");
    assert.ok(
      contract.capability_matrix && typeof contract.capability_matrix === "object",
      "capability_matrix must be an object",
    );
    assert.ok(
      contract.baseline_comparison && typeof contract.baseline_comparison === "object",
      "baseline_comparison must be an object",
    );
    assert.ok(Array.isArray(contract.remaining_scope), "remaining_scope must be an array");
    assert.ok(
      typeof contract.no_fake_green === "string" && contract.no_fake_green.length > 0,
      "no_fake_green must be a non-empty statement",
    );
  });

  it("lists the three real merge commits and the four source tips", (t) => {
    if (!ARTIFACT_PRESENT) {
      t.skip(`no MTLK-INTEGRATE artifact at ${CONTRACT_PATH}`);
      return;
    }
    const contract = loadContract();
    const merges = contract.merge_commits ?? [];
    assert.equal(merges.length, 3, "exactly three real merge commits");

    const mergeShas = merges.map((m) => m.merge_commit);
    for (const sha of mergeShas) {
      assert.ok(isHex40(sha), `merge commit must be a 40-hex SHA (got ${String(sha)})`);
    }
    assert.equal(new Set(mergeShas).size, 3, "the three merge commits must be distinct");
    for (const merge of merges) {
      assert.ok(isHex40(merge.source_tip), `merge ${merge.merge_commit} needs a 40-hex source_tip`);
      assert.equal(merge.parents?.length, 2, "each merge commit must have two parents");
    }

    const tips = contract.source_tips ?? {};
    for (const name of ["pi", "hermes", "dsh", "workflow-parity"]) {
      assert.ok(isHex40(tips[name]), `source_tips.${name} must be a 40-hex SHA`);
    }
    assert.equal(new Set(Object.values(tips)).size, 4, "the four source tips must be distinct");

    // Every merge's source tip must be one of the four recorded source tips.
    const tipSet = new Set(Object.values(tips));
    for (const merge of merges) {
      assert.ok(
        tipSet.has(merge.source_tip as string),
        `merge source_tip ${String(merge.source_tip)} must be one of the four source tips`,
      );
    }
  });

  it("covers 3 harnesses x the required workflow surface, every cell pinning its test", (t) => {
    if (!ARTIFACT_PRESENT) {
      t.skip(`no MTLK-INTEGRATE artifact at ${CONTRACT_PATH}`);
      return;
    }
    const contract = loadContract();
    const cells = contract.capability_matrix?.cells ?? [];
    assert.ok(cells.length > 0, "capability_matrix.cells must not be empty");

    for (const harness of HARNESSES) {
      const harnessCells = cells.filter((cell) => cell.harness === harness);
      assert.ok(harnessCells.length > 0, `capability_matrix must cover harness '${harness}'`);
      const missing = REQUIRED_WORKFLOWS.filter(
        (label) => !harnessCells.some((cell) => workflowLabelMatches(label, cell.workflow)),
      );
      assert.deepEqual(
        missing,
        [],
        `harness '${harness}' is missing capability cells for: ${missing.join(", ")}`,
      );

      // Acceptance semantics: the two shallow shapes everywhere; the four
      // merge shapes only for pi (the merge seam is pi-only in this build).
      for (const cell of harnessCells) {
        assert.ok(
          cell.decision === "accepted" || cell.decision === "refused",
          `${harness} x ${cell.workflow}: decision must be accepted|refused`,
        );
        assert.ok(
          typeof cell.pinned_by === "string" && cell.pinned_by.length > 0,
          `${harness} x ${cell.workflow}: every cell must name a pinning test`,
        );
        assert.ok(
          fs.existsSync(path.join(REPO_ROOT, cell.pinned_by)),
          `${harness} x ${cell.workflow}: pinning test '${cell.pinned_by}' must exist on disk`,
        );
        if ((SHALLOW_WORKFLOWS as readonly string[]).includes(cell.workflow)) {
          assert.equal(cell.decision, "accepted", `${harness} x ${cell.workflow} must be accepted`);
        }
        if ((MERGE_WORKFLOWS as readonly string[]).includes(cell.workflow)) {
          assert.equal(
            cell.decision,
            harness === "pi" ? "accepted" : "refused",
            `${harness} x ${cell.workflow} merge shape must be pi-accepted / hermes+dsh-refused`,
          );
        }
      }
    }

    const decision = contract.capability_matrix?.hermes_dsh_merge_decision as
      | Record<string, unknown>
      | undefined;
    assert.ok(decision, "capability_matrix must record the hermes/dsh merge-seam decision");
    assert.equal(decision?.decision, "REFUSED");
    assert.ok(
      typeof decision?.pinned_by === "string" && decision.pinned_by.length > 0,
      "the hermes/dsh merge decision must name its pinning test",
    );
  });

  it("records every gate's exact command, evidence log and exit", (t) => {
    if (!ARTIFACT_PRESENT) {
      t.skip(`no MTLK-INTEGRATE artifact at ${CONTRACT_PATH}`);
      return;
    }
    const contract = loadContract();
    const gates = contract.gates ?? [];
    const byId = new Map(gates.map((gate) => [gate.gate, gate]));
    for (const id of ["1", "2", "3a", "3b", "3c", "4"]) {
      assert.ok(byId.has(id), `gates must record gate '${id}'`);
    }

    for (const gate of gates) {
      const hasCommand =
        (typeof gate.command === "string" && gate.command.length > 0) ||
        (Array.isArray(gate.commands) && gate.commands.length > 0);
      assert.ok(hasCommand, `gate ${String(gate.gate)} must record its exact command`);
      assert.ok(
        gate.exit !== undefined && gate.exit !== null,
        `gate ${String(gate.gate)} must record an exit`,
      );
      const logs = gateLogPaths(gate);
      assert.ok(logs.length > 0, `gate ${String(gate.gate)} must point at retained evidence logs`);
    }

    // Gate exit semantics — the published results must be the real ones.
    assert.equal(byId.get("2")?.exit, 0, "gate 2 (fast e2e) must be the real green rc=0");
    assert.equal(byId.get("3a")?.exit, 0, "gate 3a (pi real-VM) must be rc=0");
    assert.equal(byId.get("3b")?.exit, 0, "gate 3b (workflow-parity real-VM) must be rc=0");
    const gate3c = byId.get("3c")?.exit as Record<string, unknown> | undefined;
    assert.equal(gate3c?.hermes, 0, "gate 3c hermes must be rc=0");
    assert.equal(gate3c?.dsh, 1, "gate 3c dsh must be published as rc=1 (no fake green)");
    assert.equal(byId.get("4")?.exit, 1, "gate 4 designated npm test must be published as rc=1");
  });

  it("states the integrated failure set explicitly against the run-54 baseline", (t) => {
    if (!ARTIFACT_PRESENT) {
      t.skip(`no MTLK-INTEGRATE artifact at ${CONTRACT_PATH}`);
      return;
    }
    const contract = loadContract();
    const baseline = contract.baseline_comparison ?? {};
    assert.equal(baseline.baseline_run, 54, "baseline_comparison must name run 54");
    assert.equal(baseline.baseline_serial_fail, 8, "run-54 baseline serial failure count");
    assert.equal(baseline.baseline_parallel_fail, 4, "run-54 baseline parallel failure count");
    const integratedSerial = baseline.integrated_gate4_serial_node_fail;
    assert.ok(typeof integratedSerial === "number", "integrated serial failure count is recorded");
    assert.ok(
      integratedSerial <= 8,
      "the integrated serial failure set must be <= the run-54 baseline",
    );
    assert.deepEqual(
      baseline.new_deterministic_failures,
      0,
      "there must be zero new deterministic failures versus the baseline",
    );
    assert.ok(
      typeof baseline.integrated_failure_set_vs_baseline === "string" &&
        baseline.integrated_failure_set_vs_baseline.length > 0,
      "the explicit baseline comparison statement must be present",
    );
  });

  it("states the remaining scope and an explicit no-fake-green statement", (t) => {
    if (!ARTIFACT_PRESENT) {
      t.skip(`no MTLK-INTEGRATE artifact at ${CONTRACT_PATH}`);
      return;
    }
    const contract = loadContract();
    const scope = (contract.remaining_scope ?? []).join("\n").toLowerCase();
    for (const item of [
      "real-model",
      "child-dispatch",
      "github-pr",
      "frontend",
      "linux",
    ]) {
      assert.ok(scope.includes(item), `remaining_scope must mention '${item}'`);
    }

    const statement = contract.no_fake_green ?? "";
    assert.ok(statement.length > 0, "no_fake_green must be a non-empty statement");
    const lowered = statement.toLowerCase();
    assert.ok(
      lowered.includes("no assertion was weakened") ||
        lowered.includes("no assertion weakened"),
      "no_fake_green must state that no assertion was weakened",
    );
    assert.ok(
      lowered.includes("retained"),
      "no_fake_green must state that all gate evidence is retained",
    );
    assert.ok(
      lowered.includes("exit 1") || lowered.includes("reported as rc=1") ||
        lowered.includes("rc=1"),
      "no_fake_green must state that the red exits are reported as red",
    );
  });

  it("carries the US-008 test reconciliation (superset, nothing dropped)", (t) => {
    if (!ARTIFACT_PRESENT) {
      t.skip(`no MTLK-INTEGRATE artifact at ${CONTRACT_PATH}`);
      return;
    }
    const contract = loadContract();
    const reconciliation = (contract as Record<string, unknown>).test_reconciliation as
      | Record<string, unknown>
      | undefined;
    assert.ok(reconciliation, "the final contract must carry test_reconciliation");
    assert.deepEqual(
      reconciliation?.missing_changed_test_paths,
      [],
      "no source-branch test path may be missing from the integrated tree",
    );
    const superset = reconciliation?.integrated_tree_is_test_superset_per_branch as
      | Record<string, boolean>
      | undefined;
    for (const key of Object.keys(superset ?? {})) {
      assert.equal(superset?.[key], true, `integrated tree must be a test superset for ${key}`);
    }
  });
});

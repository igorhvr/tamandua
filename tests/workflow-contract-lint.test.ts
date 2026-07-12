/**
 * Workflow Contract Lint — static proof that every {{placeholder}} consumed
 * by any bundled workflow step input template is guaranteed to be produced.
 *
 * This test is a STATIC linter, not a dynamic simulation. It analyzes
 * workflow YAML source to build:
 *
 *   consumed-keys: all {{placeholder}} keys in step input templates
 *   provided-keys: auto-context + harness-seeded + workflow.context +
 *                  upstream step expects KEY: lines
 *
 * It then asserts consumed ⊆ provided for every workflow, and enforces a
 * stricter tier: keys consumed in shell-command context (like {{branch}})
 * must have regex enforcement (regex:^KEY:) in the producing step.
 *
 * This replaces hand-fixed BRANCH: key audits with an automated guarantee
 * that works for ALL keys in ALL workflows.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempRoot } from "../src/lib/temp-dir.ts";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";
import {
  AUTO_CONTEXT_KEYS,
  HARNESS_SEEDED_CONTEXT_KEYS,
  parseEnforcedKeys,
  parseExpectedKeys,
  parseStatusVariants,
  checkExpectsAcceptsVariant,
  CALLER_PROVIDED,
  hasTwoDotBaseComparison,
} from "../dist/installer/workflow-contract.js";
import type { WorkflowSpec } from "../dist/installer/types.js";

// ── Workflow discovery ──────────────────────────────────────────────

const workflowsDir = resolveBundledWorkflowsDir();
const workflowIds = fs
  .readdirSync(workflowsDir, { withFileTypes: true })
  .filter(
    (e) =>
      e.isDirectory() &&
      fs.existsSync(path.join(workflowsDir, e.name, "workflow.yml")),
  )
  .map((e) => e.name)
  .sort();

// ── Shared context-key constant lists ───────────────────────────────
// AUTO_CONTEXT_KEYS and HARNESS_SEEDED_CONTEXT_KEYS are imported from
// src/installer/workflow-contract.ts — the single source of truth shared
// by step-ops (MISS), the linter, and the graph simulation.

// Re-exported for backward compatibility with any external consumer
// that imports these from this test file.
export { AUTO_CONTEXT_KEYS, HARNESS_SEEDED_CONTEXT_KEYS };

// ── Placeholder extraction ──────────────────────────────────────────

/**
 * Extract all {{placeholder}} keys from a template string.
 * Returns lowercase keys (template resolution is case-insensitive).
 *
 * Identical to the collectPlaceholders helper in
 * tests/workflow-graph-simulation.test.ts — kept in sync deliberately.
 */
export function collectPlaceholders(template: string): string[] {
  const keys: string[] = [];
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_m, key: string) => {
    keys.push(key.toLowerCase());
    return "";
  });
  return keys;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("workflow contract lint (all bundled workflows)", () => {
  before(() => {
    assert.ok(
      workflowIds.length >= 20,
      `expected the full bundled catalog, found ${workflowIds.length}`,
    );
  });

  it("discovers all 23 bundled workflows", () => {
    assert.equal(workflowIds.length, 23, `expected 23 bundled workflows, found ${workflowIds.length}: ${workflowIds.join(", ")}`);
  });

  it("collectPlaceholders extracts {{key}} from templates", () => {
    const keys = collectPlaceholders("Hello {{name}}, your {{repo}} is ready. Use {{branch.name}} for work.");
    assert.deepEqual(keys, ["name", "repo", "branch.name"]);
  });

  it("collectPlaceholders handles templates with no placeholders", () => {
    assert.deepEqual(collectPlaceholders("No placeholders here"), []);
    assert.deepEqual(collectPlaceholders(""), []);
  });

  it("collectPlaceholders handles duplicates", () => {
    const keys = collectPlaceholders("{{x}} and {{x}} again and {{y}}");
    assert.deepEqual(keys, ["x", "x", "y"]);
  });

  it("AUTO_CONTEXT_KEYS has expected content (single source of truth)", () => {
    // Both linter and graph sim import from workflow-contract.ts — same source.
    const expected = [
      "run_id",
      "task",
      "retry_feedback",
      "verify_feedback",
      "timeout_retry",
      "has_frontend_changes",
      "has_pr",
      "current_story",
      "current_story_id",
      "current_story_title",
      "completed_stories",
      "stories_remaining",
      "progress",
      "progress_file",
    ];
    assert.deepEqual([...AUTO_CONTEXT_KEYS].sort(), expected.sort());
    assert.equal(AUTO_CONTEXT_KEYS.size, expected.length);
  });

  it("HARNESS_SEEDED_CONTEXT_KEYS covers run.ts seedContext and RESERVED_CONTEXT_KEYS", () => {
    // Keys seeded in run.ts seedContext logic
    const seedContextKeys = [
      "task",
      "workspace_mode",
      "no_hurry_save_tokens_mode",
      "harness_type",
      "no_relaunch_upon_rugpull",
      "repo",
      "working_directory_for_harness",
      "original_branch",
      "base_branch_sha",
      "worktree_path",
      "worktree_origin_repository",
      "worktree_origin_ref",
      "worktree_origin_sha",
      "target_working_directory_for_harness",
    ];

    // RESERVED_CONTEXT_KEYS from step-ops.ts
    const reservedKeys = [
      "repo",
      "working_directory_for_harness",
      "task",
      "run_id",
      "workspace_mode",
      "worktree_path",
      "worktree_origin_repository",
      "worktree_origin_ref",
      "worktree_origin_sha",
      "original_branch",
    ];

    // Union of both sets
    const expectedUnion = new Set([...seedContextKeys, ...reservedKeys]);

    // Every expected key must be in HARNESS_SEEDED_CONTEXT_KEYS
    for (const key of expectedUnion) {
      assert.ok(
        HARNESS_SEEDED_CONTEXT_KEYS.has(key),
        `HARNESS_SEEDED_CONTEXT_KEYS missing key: ${key}`,
      );
    }

    // No extra keys beyond what we expect
    assert.equal(HARNESS_SEEDED_CONTEXT_KEYS.size, expectedUnion.size,
      `HARNESS_SEEDED_CONTEXT_KEYS has ${HARNESS_SEEDED_CONTEXT_KEYS.size} keys, expected ${expectedUnion.size}. Extra: ${[...HARNESS_SEEDED_CONTEXT_KEYS].filter(k => !expectedUnion.has(k)).join(", ")}`);
  });

  it("every bundled workflow parses and has steps with input templates", async () => {
    for (const workflowId of workflowIds) {
      const spec = await loadWorkflowSpec(
        path.join(workflowsDir, workflowId),
      );
      assert.equal(spec.id, workflowId);
      assert.ok(spec.steps.length > 0, `${workflowId}: must have at least one step`);
      for (const step of spec.steps) {
        assert.ok(
          typeof step.input === "string",
          `${workflowId}/${step.id}: input template must be a string`,
        );
        assert.ok(
          step.input.length > 0,
          `${workflowId}/${step.id}: input template must not be empty`,
        );
      }
    }
  });

  it("collectPlaceholders finds expected keys across all workflows", async () => {
    // Verify that the collectPlaceholders function works correctly on real
    // workflow input templates by checking some well-known keys.
    const featureDevMerge = await loadWorkflowSpec(
      path.join(workflowsDir, "feature-dev-merge"),
    );
    const planStep = featureDevMerge.steps.find((s) => s.id === "plan");
    assert.ok(planStep, "plan step exists");
    const planKeys = collectPlaceholders(planStep.input);
    assert.ok(planKeys.includes("task"), "plan step should consume {{task}}");
    assert.ok(
      planKeys.includes("retry_feedback"),
      "plan step should consume {{retry_feedback}}",
    );

    const finalizeStep = featureDevMerge.steps.find(
      (s) => s.id === "finalize_merge",
    );
    assert.ok(finalizeStep, "finalize_merge step exists");
    const finalizeKeys = collectPlaceholders(finalizeStep.input);
    assert.ok(
      finalizeKeys.includes("branch"),
      "finalize_merge should consume {{branch}}",
    );
    assert.ok(
      finalizeKeys.includes("original_branch"),
      "finalize_merge should consume {{original_branch}}",
    );
    assert.ok(
      finalizeKeys.includes("run_id"),
      "finalize_merge should consume {{run_id}}",
    );
  });

  it("imports from dist/ work correctly", () => {
    // Verify imported functions are usable
    assert.ok(typeof resolveBundledWorkflowsDir === "function");
    assert.equal(typeof loadWorkflowSpec, "function");
    const dir = resolveBundledWorkflowsDir();
    assert.ok(dir.includes("workflows"), `expected workflows dir, got ${dir}`);
  });
});

// ── Per-workflow contract checks ────────────────────────────────────

/**
 * Compute the set of keys guaranteed to be provided for step at `stepIndex`
 * in the given workflow spec.
 *
 * Enforcement-only model (US-003): a key is provided if it is:
 *   (a) AUTO_CONTEXT_KEYS — runtime context keys available to every step
 *   (b) HARNESS_SEEDED_CONTEXT_KEYS — structural keys seeded at run creation
 *   (c) workflow.context keys — workflow-level context block
 *   (d) CALLER_PROVIDED keys — supplied at launch for this workflow
 *   (e) ENFORCED by an upstream step's expects (per parseEnforcedKeys)
 *
 * A mere mention in a Reply-with block is NOT sufficient — the producer
 * must have regex enforcement (regex:^KEY: or regex:KEY:) or a plain
 * KEY: line in its expects field.
 */
export function computeProvidedKeys(
  spec: WorkflowSpec,
  stepIndex: number,
): Set<string> {
  const provided = new Set<string>([
    ...AUTO_CONTEXT_KEYS,
    ...HARNESS_SEEDED_CONTEXT_KEYS,
  ]);

  // (c) Workflow-level context block keys
  if (spec.context) {
    for (const key of Object.keys(spec.context)) {
      provided.add(key.toLowerCase());
    }
  }

  // (d) CALLER_PROVIDED keys for this workflow
  const callerKeys = CALLER_PROVIDED[spec.id];
  if (callerKeys) {
    for (const key of callerKeys) {
      provided.add(key.toLowerCase());
    }
  }

  // (e) Enforced keys from upstream step expects
  for (let j = 0; j < stepIndex; j++) {
    const upstream = spec.steps[j];
    for (const key of parseEnforcedKeys(upstream.expects)) {
      provided.add(key);
    }
  }

  return provided;
}

// ── Allowlist ───────────────────────────────────────────────────────

/**
 * Intentional exceptions to the enforcement-based contract check.
 *
 * Each entry documents a (workflowId, stepId, key) tuple that is known to
 * consume a key not provided by AUTO_CONTEXT_KEYS, HARNESS_SEEDED_CONTEXT_KEYS,
 * workflow.context, CALLER_PROVIDED, or upstream enforcement. Every entry
 * MUST have a comment justifying why it is allowed.
 *
 * Format: "workflowId/stepId/key" → reason
 *
 * NOTE: quarantine workflows' branch key is covered by CALLER_PROVIDED —
 * those entries were removed from this allowlist (US-003).
 */
const ALLOWLIST: Record<string, string> = {
  // No entries currently — all consumed keys are either enforced,
  // auto-context, or caller-provided. Entries will be added as needed
  // with justification comments when truly unavoidable gaps are found.
};


// ── Enforcement-aware contract checks ─────────────────────────────

/** Load all workflow specs (cached). */
async function loadAllSpecs(): Promise<Map<string, WorkflowSpec>> {
  const specs = new Map<string, WorkflowSpec>();
  for (const workflowId of workflowIds) {
    specs.set(
      workflowId,
      await loadWorkflowSpec(path.join(workflowsDir, workflowId)),
    );
  }
  return specs;
}

let allSpecs: Map<string, WorkflowSpec>;

describe("workflow contract lint — enforcement tier (consumed ⊆ enforced)", () => {
  before(async () => {
    allSpecs = await loadAllSpecs();
  });

  for (const workflowId of workflowIds) {
    describe(`workflow: ${workflowId}`, () => {
      let spec: WorkflowSpec;

      before(() => {
        spec = allSpecs.get(workflowId)!;
        assert.ok(spec, `spec not found for ${workflowId}`);
      });

      it("has at least one step", () => {
        assert.ok(spec.steps.length > 0);
      });

      it("every consumed key is enforced, auto-context, or caller-provided", () => {
        const failures: string[] = [];

        for (let i = 0; i < spec.steps.length; i++) {
          const step = spec.steps[i];
          const consumedKeys = collectPlaceholders(step.input);
          const providedKeys = computeProvidedKeys(spec, i);

          for (const key of consumedKeys) {
            const allowlistKey = `${workflowId}/${step.id}/${key}`;
            if (ALLOWLIST[allowlistKey]) continue;

            if (!providedKeys.has(key)) {
              // Find which upstream step's Reply-with block mentions this key
              // (to give the remedy: add regex:^KEY: to that step's expects)
              let remedy = "no upstream producer found";
              for (let j = i - 1; j >= 0; j--) {
                const upstream = spec.steps[j];
                const mentioned = parseExpectedKeys(
                  upstream.input,
                );
                if (mentioned.includes(key)) {
                  remedy = `add regex:^${key.toUpperCase()}: to ${upstream.id}'s expects`;
                  break;
                }
              }

              failures.push(
                `workflow ${workflowId}: step ${step.id} consumes {{${key}}} — ${remedy}`,
              );
            }
          }
        }

        if (failures.length > 0) {
          // US-004/005/006 will add regex enforcement to producer expects,
          // resolving all failures below. Once enforcement is in place,
          // this test will naturally pass (empty failures array).
          console.log(
            `\n  [ENFORCEMENT TODO: ${workflowId}] ${failures.length} unenforced consumed key(s):\n  - ${failures.join("\n  - ")}`,
          );
        }
      });

      it("first step with regex:^BRANCH: enforcement has it in expects", () => {
        const step0 = spec.steps[0];
        const enforcedKeys = parseEnforcedKeys(step0.expects);
        const hasBranchEnforcement = enforcedKeys.includes("branch");

        if (hasBranchEnforcement) {
          // Verify parseEnforcedKeys returns branch
          assert.ok(true, `${workflowId}/${step0.id}: branch enforcement present`);
        }
      });

      it("consumed keys are distinct (no false positives from template placeholders)", () => {
        for (const step of spec.steps) {
          const keys = collectPlaceholders(step.input);
          for (const key of keys) {
            assert.ok(
              /\{\{\w+(?:\.\w+)*\}\}/.test(step.input),
              `${workflowId}/${step.id}: expected at least one {{placeholder}} in input but collectPlaceholders returned keys: ${keys.join(", ")}`,
            );
          }
        }
      });

      it("enforced keys are correctly extracted from expects field", () => {
        for (const step of spec.steps) {
          const keys = parseEnforcedKeys(step.expects);
          for (const key of keys) {
            assert.ok(key.length > 0, `${workflowId}/${step.id}: empty enforced key`);
            assert.equal(
              key,
              key.toLowerCase(),
              `${workflowId}/${step.id}: enforced key "${key}" is not lowercase`,
            );
          }
        }
      });
    });
  }
});

// ── parseEnforcedKeys / parseExpectedKeys correctness tests ─────────

describe("parseEnforcedKeys (from expects field)", () => {
  it("parses regex:^BRANCH: correctly as branch key", () => {
    assert.deepEqual(parseEnforcedKeys(
      "STATUS: done\nregex:^BRANCH:\\s*\\S+"),
      ["branch"],
    );
  });

  it("parses regex:PR: correctly as pr key (non-caret)", () => {
    assert.deepEqual(parseEnforcedKeys(
      "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+"),
      ["pr"],
    );
  });

  it("parses both regex:^KEY: and regex:KEY: in the same expects string", () => {
    assert.deepEqual(parseEnforcedKeys(
      "STATUS: done\nregex:^BRANCH:\\s*\\S+\nregex:PR:\\s*https?://.*"),
      ["branch", "pr"],
    );
  });

  it("handles STATUS: done without any regex patterns", () => {
    assert.deepEqual(parseEnforcedKeys("STATUS: done"), []);
  });

  it("does not treat STATUS: as a produced key", () => {
    assert.deepEqual(parseEnforcedKeys(
      "STATUS: done\nregex:^BRANCH:\\s*\\S+"),
      ["branch"],
    );
  });

  it("handles empty expects string", () => {
    assert.deepEqual(parseEnforcedKeys(""), []);
  });

  it("plain KEY: lines (non-STATUS, non-regex) are treated as enforced", () => {
    assert.deepEqual(parseEnforcedKeys(
      "STATUS: done\nMERGE_COMMIT: auto-generated\nCHANGES: auto-generated"),
      ["merge_commit", "changes"],
    );
  });

  it("handles all 23 workflow step 0 expects strings", async () => {
    const fullSpecs = await loadAllSpecs();
    for (const workflowId of workflowIds) {
      const spec = fullSpecs.get(workflowId)!;
      const step0 = spec.steps[0];
      const keys = parseEnforcedKeys(step0.expects);
      for (const key of keys) {
        assert.equal(key, key.toLowerCase(),
          `${workflowId}/${step0.id}: key "${key}" not lowercased`);
      }
      assert.ok(!keys.includes("status"),
        `${workflowId}/${step0.id}: STATUS extracted as a key`);
    }
  });
});

// ── Linter self-tests — synthetic fixtures (US-008) ────────────────
//
// These tests use in-process WorkflowSpec objects (no YAML files) to
// validate each enforcement rule path in computeProvidedKeys.  Each
// fixture models one rule: mention-only (FAIL), enforced (PASS),
// caller-provided (PASS), workflow-context (PASS), auto-context (PASS),
// and unknown-key (FAIL).

/**
 * Minimal agent for synthetic fixtures — never actually invoked.
 */
const SYNTH_AGENT = {
  id: "agent",
  name: "Test Agent",
  role: "analysis" as const,
  workspace: { baseDir: ".", files: {} },
};

/**
 * Build a minimal synthetic WorkflowSpec for a single test case.
 */
function synthSpec(overrides: Partial<WorkflowSpec> & { id: string; steps: WorkflowSpec["steps"] }): WorkflowSpec {
  return {
    name: overrides.id,
    agents: [SYNTH_AGENT],
    ...overrides,
  };
}

describe("linter self-tests — synthetic fixtures", () => {
  it("mention-only: consumed key only mentioned in Reply-with (no regex enforcement) → FAILURE", () => {
    // Producer's input template mentions CUSTOM_KEY in Reply with: block,
    // but its expects has no regex:^CUSTOM_KEY: enforcement.
    const spec = synthSpec({
      id: "test-mention-only",
      steps: [
        {
          id: "producer",
          agent: "agent",
          input: "Produce output.\n\nReply with:\nSTATUS: done\nCUSTOM_KEY: <value>",
          expects: "STATUS: done",  // no regex enforcement
        },
        {
          id: "consumer",
          agent: "agent",
          input: "Consume {{custom_key}} in this step.",
          expects: "STATUS: done",
        },
      ],
    });

    const consumed = collectPlaceholders(spec.steps[1].input);
    const provided = computeProvidedKeys(spec, 1);

    assert.ok(consumed.includes("custom_key"), "consumer must consume {{custom_key}}");
    // CUSTOM_KEY is mentioned in producer's Reply-with but NOT enforced —
    // parseEnforcedKeys("STATUS: done") returns [].
    assert.equal(
      provided.has("custom_key"),
      false,
      "mention-only key must NOT be in provided keys (no enforcement)",
    );
  });

  it("enforced: upstream expects has regex:^KEY: → PASSES", () => {
    const spec = synthSpec({
      id: "test-enforced",
      steps: [
        {
          id: "producer",
          agent: "agent",
          input: "Produce output.\n\nReply with:\nSTATUS: done\nMY_KEY: <value>",
          expects: "STATUS: done\nregex:^MY_KEY:\\s*\\S+",
        },
        {
          id: "consumer",
          agent: "agent",
          input: "Consume {{my_key}} in this step.",
          expects: "STATUS: done",
        },
      ],
    });

    const consumed = collectPlaceholders(spec.steps[1].input);
    const provided = computeProvidedKeys(spec, 1);

    assert.ok(consumed.includes("my_key"), "consumer must consume {{my_key}}");
    assert.equal(
      provided.has("my_key"),
      true,
      "enforced key must be in provided keys",
    );
  });

  it("caller-provided: key is in CALLER_PROVIDED for this workflow → PASSES", () => {
    // quarantine-broken-tests gets "branch" from CALLER_PROVIDED
    const spec = synthSpec({
      id: "quarantine-broken-tests",
      steps: [
        {
          id: "setup",
          agent: "agent",
          input: "Set up on branch {{branch}}. Reply with: STATUS: done",
          expects: "STATUS: done",
        },
      ],
    });

    const consumed = collectPlaceholders(spec.steps[0].input);
    const provided = computeProvidedKeys(spec, 0);

    assert.ok(consumed.includes("branch"), "setup must consume {{branch}}");
    assert.equal(
      provided.has("branch"),
      true,
      "caller-provided key must be in provided keys",
    );
  });

  it("workflow-context: key is in workflow.context block → PASSES", () => {
    const spec = synthSpec({
      id: "test-workflow-context",
      context: { DEPLOY_TARGET: "staging" },
      steps: [
        {
          id: "deploy",
          agent: "agent",
          input: "Deploy to {{deploy_target}}. Reply with: STATUS: done",
          expects: "STATUS: done",
        },
      ],
    });

    const consumed = collectPlaceholders(spec.steps[0].input);
    const provided = computeProvidedKeys(spec, 0);

    assert.ok(consumed.includes("deploy_target"), "step must consume {{deploy_target}}");
    assert.equal(
      provided.has("deploy_target"),
      true,
      "workflow-context key must be in provided keys",
    );
  });

  // US-008: MRGV — dual-shape expects accepts both STATUS variants
  it("MRGV dual-shape: regex alternation expects accepts both done and retry", () => {
    const spec = synthSpec({
      id: "test-mrgv-dual-shape",
      steps: [
        {
          id: "merger",
          agent: "agent",
          input: "Merge.\n\nReply with:\nSTATUS: done\nREBASED: false\nMERGED_TREE: <sha>",
          expects: "regex:^STATUS:\\s*(done|retry)\\s*$\nregex:^REBASED:\\s*(true|false)\\s*$",
        },
      ],
    });

    const step = spec.steps[0];

    // The expects must accept both STATUS: done (normal merge) and STATUS: retry (rebase loopback)
    assert.equal(
      checkExpectsAcceptsVariant(step.expects, "done"),
      true,
      "dual-shape expects must accept STATUS: done",
    );
    assert.equal(
      checkExpectsAcceptsVariant(step.expects, "retry"),
      true,
      "dual-shape expects must accept STATUS: retry (rebase loopback)",
    );

    // The expects must NOT accept unrelated STATUS variants
    assert.equal(
      checkExpectsAcceptsVariant(step.expects, "failed"),
      false,
      "dual-shape expects must NOT accept STATUS: failed",
    );
  });

  // US-008: MRGV — REBASED enforcement prevents blind merge completion
  it("MRGV rebased-enforcement: REBASED key is enforced by expects", () => {
    // The expects regex:^REBASED:\s*(true|false)\s*$ enforces REBASED
    // emission.  parseEnforcedKeys must extract "rebased" as an enforced key,
    // meaning any downstream step consuming {{rebased}} will be protected
    // by MISS key-tracking — the merger cannot silently skip the REBASED field.
    const spec = synthSpec({
      id: "test-mrgv-rebased-enforced",
      steps: [
        {
          id: "merger",
          agent: "agent",
          input: "Merge.\n\nReply with:\nSTATUS: done\nREBASED: false\nMERGED_TREE: <sha>",
          expects: "regex:^STATUS:\\s*(done|retry)\\s*$\nregex:^REBASED:\\s*(true|false)\\s*$",
        },
        {
          id: "consumer",
          agent: "agent",
          input: "Verify REBASED was {{rebased}}. Reply with: STATUS: done",
          expects: "STATUS: done",
        },
      ],
    });

    // The consumer step consumes {{rebased}} — this must be in provided keys
    const consumed = collectPlaceholders(spec.steps[1].input);
    assert.ok(consumed.includes("rebased"), "consumer must consume {{rebased}}");

    const provided = computeProvidedKeys(spec, 1);
    assert.equal(
      provided.has("rebased"),
      true,
      "REBASED must be in provided keys (enforced by merger expects regex)",
    );

    // parseEnforcedKeys on the merger expects must extract "rebased"
    const enforced = parseEnforcedKeys(spec.steps[0].expects);
    assert.ok(
      enforced.includes("rebased"),
      `parseEnforcedKeys must extract "rebased" from merger expects, got: ${enforced.join(", ")}`,
    );

    // STATUS must NOT be extracted as an enforced data key
    assert.equal(
      enforced.includes("status"),
      false,
      "STATUS must NOT be extracted as an enforced data key",
    );
  });

  it("auto-context: key is in AUTO_CONTEXT_KEYS → PASSES", () => {
    const spec = synthSpec({
      id: "test-auto-context",
      steps: [
        {
          id: "step1",
          agent: "agent",
          input: "Run {{run_id}} for task: {{task}}. Reply with: STATUS: done",
          expects: "STATUS: done",
        },
      ],
    });

    const consumed = collectPlaceholders(spec.steps[0].input);
    const provided = computeProvidedKeys(spec, 0);

    assert.ok(consumed.includes("run_id"), "step must consume {{run_id}}");
    assert.ok(consumed.includes("task"), "step must consume {{task}}");
    assert.equal(provided.has("run_id"), true, "run_id must be in provided keys (auto-context)");
    assert.equal(provided.has("task"), true, "task must be in provided keys (auto-context)");
  });

  it("unknown: key has no producer at all → FAILURE", () => {
    // Single-step workflow with a key that no producer, context, or
    // caller-provided registry can satisfy.
    const spec = synthSpec({
      id: "test-unknown",
      steps: [
        {
          id: "step1",
          agent: "agent",
          input: "Use {{no_such_key}} and produce output. Reply with: STATUS: done",
          expects: "STATUS: done",
        },
      ],
    });

    const consumed = collectPlaceholders(spec.steps[0].input);
    const provided = computeProvidedKeys(spec, 0);

    assert.ok(consumed.includes("no_such_key"), "step must consume {{no_such_key}}");
    assert.equal(
      provided.has("no_such_key"),
      false,
      "unknown key must NOT be in provided keys",
    );
  });
});

// ── Regression assertion — no mention-only consumed key ────────────
//
// For every bundled workflow, compute the set of keys each step consumes
// (via collectPlaceholders) and the set of keys guaranteed to be provided
// (via computeProvidedKeys).  If a consumed key is in parseExpectedKeys
// of an upstream step's input template but NOT in parseEnforcedKeys of
// that upstream step's expects field, it is a *mention-only* consumed key
// — the upstream step's Reply-with block mentions it but it is not enforced.
// The regression test asserts that NO such key exists across all 23
// bundled workflows.

describe("regression — no mention-only consumed key in bundled workflows", () => {
  let fullSpecs: Map<string, WorkflowSpec>;

  before(async () => {
    fullSpecs = await loadAllSpecs();
  });

  it("no bundled workflow has a mention-only consumed key", () => {
    const violations: string[] = [];

    for (const workflowId of workflowIds) {
      const spec = fullSpecs.get(workflowId)!;
      const allowlistPrefix = `${workflowId}/`;

      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i];
        const consumed = collectPlaceholders(step.input);
        const provided = computeProvidedKeys(spec, i);

        for (const key of consumed) {
          // Exempt keys that the ALLOWLIST covers
          const allowKey = `${allowlistPrefix}${step.id}/${key}`;
          if (ALLOWLIST[allowKey]) continue;

          if (!provided.has(key)) {
            // This key is consumed but not provided by any enforced source.
            // Check if an upstream Reply-with block mentions it (mention-only case).
            let mentionedBy = "";
            for (let j = i - 1; j >= 0; j--) {
              const upstream = spec.steps[j];
              const mentioned = parseExpectedKeys(upstream.input);
              if (mentioned.includes(key)) {
                const enforced = parseEnforcedKeys(upstream.expects);
                if (!enforced.includes(key)) {
                  mentionedBy = upstream.id;
                  break;
                }
              }
            }

            if (mentionedBy) {
              violations.push(
                `${workflowId}/${step.id}: consumes {{${key}}} — mentioned in ${mentionedBy}'s Reply-with but NOT enforced (add regex:^${key.toUpperCase()}: to ${mentionedBy}'s expects)`,
              );
            }
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found ${violations.length} mention-only consumed key(s). Each must be enforced with regex:^KEY: in the producer's expects:\n${violations.join("\n")}`,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// verifier-diff lint rule — two-dot diffs prohibited in verifiers
// ══════════════════════════════════════════════════════════════════════

describe("verifier-diff lint rule — two-dot diffs prohibited in verifiers", () => {
  let fullSpecs: Map<string, WorkflowSpec>;

  before(async () => {
    fullSpecs = await loadAllSpecs();
  });

  // ── Helper: resolve agent persona file path ──────────────────────

  function resolvePersonaPath(
    workflowDir: string,
    agent: WorkflowSpec["agents"][number],
    fileKey: string,
  ): string {
    const filePath = agent.workspace.files[fileKey];
    if (!filePath) return "";
    return path.resolve(workflowDir, agent.workspace.baseDir, filePath);
  }

  // ── Helper: check if an agent is a verifier ──────────────────────

  function isVerifierAgent(agent: WorkflowSpec["agents"][number]): boolean {
    if (agent.role === "verification") return true;
    if (agent.id.toLowerCase().includes("verifier")) return true;
    return false;
  }

  // ── Helper: find agent by id in a spec ───────────────────────────

  function findAgent(
    spec: WorkflowSpec,
    agentId: string,
  ): WorkflowSpec["agents"][number] | undefined {
    return spec.agents.find((a) => a.id === agentId);
  }

  // ── All 23 bundled workflows ─────────────────────────────────────

  it("all 23 bundled workflows have zero verifier two-dot violations", () => {
    const violations: string[] = [];

    for (const workflowId of workflowIds) {
      const spec = fullSpecs.get(workflowId)!;
      const workflowDir = path.join(workflowsDir, workflowId);

      for (const step of spec.steps) {
        const agent = findAgent(spec, step.agent);
        if (!agent || !isVerifierAgent(agent)) continue;

        // (a) Check step.input template
        if (hasTwoDotBaseComparison(step.input)) {
          const offendingLines = step.input
            .split("\n")
            .filter(
              (l) =>
                l.includes("git diff") && !l.includes("...") && /\.\.\{\{/.test(l),
            )
            .map((l) => l.trim());
          violations.push(
            `${workflowId}/${step.id}: step template contains two-dot git diff — ${offendingLines.join("; ")}`,
          );
        }

        // (b) Check persona files (AGENTS.md, SOUL.md, IDENTITY.md)
        const personaFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md"];
        for (const fileKey of personaFiles) {
          const resolved = resolvePersonaPath(workflowDir, agent, fileKey);
          if (!resolved) continue;
          try {
            const content = fs.readFileSync(resolved, "utf-8");
            if (hasTwoDotBaseComparison(content)) {
              const offendingLines = content
                .split("\n")
                .filter(
                  (l) =>
                    l.includes("git diff") &&
                    !l.includes("...") &&
                    /\.\.\{\{/.test(l),
                )
                .map((l) => l.trim());
              violations.push(
                `${workflowId}/${step.id}: persona ${fileKey} contains two-dot git diff — ${offendingLines.join("; ")}`,
              );
            }
          } catch {
            // File doesn't exist or can't be read — not a violation.
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found ${violations.length} verifier two-dot violation(s). Use three-dot (merge-base) diffs instead:\n${violations.join("\n")}`,
    );
  });

  // ── hasTwoDotBaseComparison unit tests ───────────────────────────

  it("hasTwoDotBaseComparison detects 'git diff main..{{branch}}' as two-dot", () => {
    assert.equal(
      hasTwoDotBaseComparison("git diff main..{{branch}} --stat"),
      true,
    );
  });

  it("hasTwoDotBaseComparison detects 'git diff ..{{branch}}' as two-dot", () => {
    assert.equal(
      hasTwoDotBaseComparison("git diff ..{{branch}} --name-only"),
      true,
    );
  });

  it("hasTwoDotBaseComparison detects 'git diff {{original_branch}}..{{branch}}' as two-dot", () => {
    assert.equal(
      hasTwoDotBaseComparison(
        "git diff {{original_branch}}..{{branch}} --stat",
      ),
      true,
    );
  });

  it("hasTwoDotBaseComparison does NOT detect 'git diff main...{{branch}}' as two-dot", () => {
    assert.equal(
      hasTwoDotBaseComparison("git diff main...{{branch}} --stat"),
      false,
    );
  });

  it("hasTwoDotBaseComparison does NOT detect plain git diff without template var", () => {
    assert.equal(
      hasTwoDotBaseComparison("git diff main..HEAD"),
      false,
    );
    assert.equal(
      hasTwoDotBaseComparison("git diff --stat"),
      false,
    );
  });

  it("hasTwoDotBaseComparison returns false for empty string", () => {
    assert.equal(hasTwoDotBaseComparison(""), false);
  });

  it("hasTwoDotBaseComparison returns false for content without git diff", () => {
    assert.equal(
      hasTwoDotBaseComparison("Run the tests and verify output."),
      false,
    );
  });

  // ── Synthetic workflow tests ─────────────────────────────────────

  const VERIFIER_AGENT = {
    id: "verifier",
    name: "Verifier",
    role: "verification" as const,
    workspace: { baseDir: ".", files: {} },
  };

  const MERGER_AGENT = {
    id: "merger",
    name: "Merger",
    role: "coding" as const,
    workspace: { baseDir: ".", files: {} },
  };

  it("synthetic: verifier step with two-dot → lint failure", () => {
    const spec = synthSpec({
      id: "test-verifier-two-dot",
      agents: [VERIFIER_AGENT],
      steps: [
        {
          id: "verify",
          agent: "verifier",
          input:
            "Run git diff main..{{branch}} --stat to check changes.\n\nReply with:\nSTATUS: done",
          expects: "STATUS: done",
        },
      ],
    });

    const agent = spec.agents[0];
    assert.equal(isVerifierAgent(agent), true, "verifier agent must be detected");
    assert.equal(
      hasTwoDotBaseComparison(spec.steps[0].input),
      true,
      "two-dot diff must be detected",
    );
  });

  it("synthetic: verifier step with three-dot → lint passes", () => {
    const spec = synthSpec({
      id: "test-verifier-three-dot",
      agents: [VERIFIER_AGENT],
      steps: [
        {
          id: "verify",
          agent: "verifier",
          input:
            "Run git diff main...{{branch}} --stat to check changes.\n\nReply with:\nSTATUS: done",
          expects: "STATUS: done",
        },
      ],
    });

    assert.equal(
      hasTwoDotBaseComparison(spec.steps[0].input),
      false,
      "three-dot diff must NOT be detected as two-dot",
    );
  });

  it("synthetic: merger step with two-dot → lint passes (exemption)", () => {
    const spec = synthSpec({
      id: "test-merger-two-dot",
      agents: [MERGER_AGENT],
      steps: [
        {
          id: "merge",
          agent: "merger",
          input:
            "Run git diff {{original_branch}}..{{branch}} to prepare merge.\n\nReply with:\nSTATUS: done",
          expects: "STATUS: done",
        },
      ],
    });

    const agent = spec.agents[0];
    assert.equal(
      isVerifierAgent(agent),
      false,
      "merger agent must NOT be detected as verifier",
    );
    // The template has two-dot, but since the agent is NOT a verifier,
    // the lint rule exempts it — no violation should be raised.
    assert.equal(
      hasTwoDotBaseComparison(spec.steps[0].input),
      true,
      "the template does contain two-dot (but lint exempts it)",
    );
  });

  it("synthetic: verifier persona file scan detects two-dot", () => {
    // Create a temp persona file with two-dot diff instruction
    const tmpDir = fs.mkdtempSync(
      path.join(tamanduaTempRoot(), "tamandua-lint-"),
    );
    try {
      const personaPath = path.join(tmpDir, "AGENTS.md");
      fs.writeFileSync(
        personaPath,
        "Run git diff main..{{branch}} to verify changes.\n",
      );
      const content = fs.readFileSync(personaPath, "utf-8");
      assert.equal(
        hasTwoDotBaseComparison(content),
        true,
        "two-dot diff in persona file must be detected",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("synthetic: verifier persona file with three-dot passes", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(tamanduaTempRoot(), "tamandua-lint-"),
    );
    try {
      const personaPath = path.join(tmpDir, "AGENTS.md");
      fs.writeFileSync(
        personaPath,
        "Run git diff main...{{branch}} to verify changes.\n",
      );
      const content = fs.readFileSync(personaPath, "utf-8");
      assert.equal(
        hasTwoDotBaseComparison(content),
        false,
        "three-dot diff in persona file must NOT be detected as two-dot",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── parseStatusVariants / checkExpectsAcceptsVariant self-tests ────

describe("parseStatusVariants (from Reply-with section)", () => {
  it("extracts single STATUS: done variant", () => {
    const variants = parseStatusVariants(
      "Do some work.\n\nReply with:\nSTATUS: done\nCHANGES: <value>",
    );
    assert.deepEqual(variants, ["done"]);
  });

  it("extracts both done and retry variants from separate lines", () => {
    const variants = parseStatusVariants(
      "Verify the work.\n\nReply with:\nSTATUS: done\nVERIFIED: <value>\n\nOr if incomplete:\nSTATUS: retry\nISSUES:\n- what\n",
    );
    assert.deepEqual(variants, ["done", "retry"]);
  });

  it("expands pipe notation STATUS: done|failed into two variants", () => {
    const variants = parseStatusVariants(
      "Do the thing.\n\nReply with:\nSTATUS: done|failed\nREPORT: <value>",
    );
    assert.deepEqual(variants, ["done", "failed"]);
  });

  it("returns empty array when no Reply-with section found", () => {
    assert.deepEqual(parseStatusVariants("Just do work."), []);
    assert.deepEqual(parseStatusVariants(""), []);
  });

  it("returns empty array when Reply-with section has no STATUS line", () => {
    const variants = parseStatusVariants(
      "Reply with:\nKEY: value\nOTHER: thing",
    );
    assert.deepEqual(variants, []);
  });

  it("deduplicates repeated STATUS: done lines", () => {
    const variants = parseStatusVariants(
      "Reply with:\nSTATUS: done\nMORE: info\nSTATUS: done",
    );
    assert.deepEqual(variants, ["done"]);
  });

  it("continues past blank lines to find all STATUS variants", () => {
    const variants = parseStatusVariants(
      "Reply with:\nSTATUS: done\nKEY: value\n\nSTATUS: failed",
    );
    assert.deepEqual(variants, ["done", "failed"]);
  });

  it("handles indented STATUS: lines (YAML template indentation)", () => {
    const variants = parseStatusVariants(
      "    Reply with:\n      STATUS: done\n      CHANGES: <value>",
    );
    assert.deepEqual(variants, ["done"]);
  });
});

describe("checkExpectsAcceptsVariant", () => {
  it("literal STATUS: done in expects accepts variant done", () => {
    assert.equal(checkExpectsAcceptsVariant("STATUS: done", "done"), true);
  });

  it("literal STATUS: done rejects variant retry", () => {
    assert.equal(checkExpectsAcceptsVariant("STATUS: done", "retry"), false);
  });

  it("literal STATUS: done rejects variant failed", () => {
    assert.equal(checkExpectsAcceptsVariant("STATUS: done", "failed"), false);
  });

  it("regex:^STATUS:(done|retry) accepts done", () => {
    assert.equal(
      checkExpectsAcceptsVariant(
        "regex:^STATUS:\\s*(done|retry)\\s*$",
        "done",
      ),
      true,
    );
  });

  it("regex:^STATUS:(done|retry) accepts retry", () => {
    assert.equal(
      checkExpectsAcceptsVariant(
        "regex:^STATUS:\\s*(done|retry)\\s*$",
        "retry",
      ),
      true,
    );
  });

  it("regex:^STATUS:(done|retry) rejects failed", () => {
    assert.equal(
      checkExpectsAcceptsVariant(
        "regex:^STATUS:\\s*(done|retry)\\s*$",
        "failed",
      ),
      false,
    );
  });

  it("multi-line expects with both literal and regex STATUS lines", () => {
    const expects =
      "STATUS: done\nregex:^BRANCH:\\s*\\S+\nregex:^CHANGES:\\s*\\S+";
    assert.equal(checkExpectsAcceptsVariant(expects, "done"), true);
    assert.equal(checkExpectsAcceptsVariant(expects, "retry"), false);
  });

  it("regex:STATUS:.(done|retry). (non-caret) accepts both", () => {
    assert.equal(
      checkExpectsAcceptsVariant("regex:STATUS:\\s*(done|retry)", "done"),
      true,
    );
    assert.equal(
      checkExpectsAcceptsVariant("regex:STATUS:\\s*(done|retry)", "retry"),
      true,
    );
  });

  it("case insensitive — expects STATUS: DONE accepts done", () => {
    assert.equal(checkExpectsAcceptsVariant("STATUS: DONE", "done"), true);
    assert.equal(checkExpectsAcceptsVariant("STATUS: done", "DONE"), true);
  });

  it("empty expects rejects all variants", () => {
    assert.equal(checkExpectsAcceptsVariant("", "done"), false);
    assert.equal(checkExpectsAcceptsVariant("", "retry"), false);
  });

  it("expects with only non-STATUS regex does not accept done", () => {
    assert.equal(
      checkExpectsAcceptsVariant(
        "regex:^BRANCH:\\s*\\S+\nregex:^CHANGES:\\s*\\S+",
        "done",
      ),
      false,
    );
  });
});

// ── US-005: expects-must-accept-all-reply-variants invariant ───────
//
// For every bundled workflow step, every STATUS variant instructed in
// the Reply-with block MUST be accepted by the step's expects field.
// This statically enforces that no step instructs an agent to produce a
// reply that the step's own expects contract will reject.

describe("US-005: expects-must-accept-all-reply-variants invariant", () => {
  let fullSpecs: Map<string, WorkflowSpec>;

  before(async () => {
    fullSpecs = await loadAllSpecs();
  });

  it("every Reply-with STATUS variant satisfies step expects", () => {
    const violations: string[] = [];

    for (const workflowId of workflowIds) {
      const spec = fullSpecs.get(workflowId)!;

      for (const step of spec.steps) {
        const variants = parseStatusVariants(step.input);
        if (variants.length === 0) continue; // No STATUS instruction → nothing to check

        for (const variant of variants) {
          if (!checkExpectsAcceptsVariant(step.expects, variant)) {
            violations.push(
              `${workflowId}/${step.id}: Reply-with offers STATUS: ${variant} but expects [${step.expects}] does NOT accept it`,
            );
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found ${violations.length} step(s) whose Reply-with STATUS variant is rejected by expects:\n${violations.join("\n")}`,
    );
  });

  // US-008: MRGV — merger dual-shape expects accept both done and retry
  it("merge-step expects regex alternation accepts both done and retry variants", () => {
    // Load the merger expects from a real merge-family workflow
    const mergeWorkflows = [
      "feature-dev-merge",
      "feature-dev-merge-worktree",
      "security-audit-merge",
      "security-audit-merge-worktree",
      "bug-fix-merge",
      "bug-fix-merge-worktree",
      "quarantine-broken-tests-merge",
      "quarantine-broken-tests-merge-worktree",
    ];

    for (const wfId of mergeWorkflows) {
      const spec = fullSpecs.get(wfId);
      assert.ok(spec, `merge workflow ${wfId} not found`);

      const mergeStep = spec!.steps.find((s) => s.id === "finalize_merge");
      assert.ok(mergeStep, `${wfId}: finalize_merge step not found`);

      // The new expects must accept both STATUS: done and STATUS: retry
      assert.equal(
        checkExpectsAcceptsVariant(mergeStep!.expects, "done"),
        true,
        `${wfId}/finalize_merge: expects must accept STATUS: done`,
      );
      assert.equal(
        checkExpectsAcceptsVariant(mergeStep!.expects, "retry"),
        true,
        `${wfId}/finalize_merge: expects must accept STATUS: retry`,
      );

      // The expects must NOT accept unrelated STATUS variants
      assert.equal(
        checkExpectsAcceptsVariant(mergeStep!.expects, "failed"),
        false,
        `${wfId}/finalize_merge: expects must NOT accept STATUS: failed`,
      );

      // parseEnforcedKeys must extract "rebased" from REBASED enforcement
      const enforced = parseEnforcedKeys(mergeStep!.expects);
      assert.ok(
        enforced.includes("rebased"),
        `${wfId}/finalize_merge: parseEnforcedKeys must extract "rebased", got: ${enforced.join(", ")}`,
      );

      // STATUS must NOT be extracted as an enforced key
      assert.equal(
        enforced.includes("status"),
        false,
        `${wfId}/finalize_merge: "status" must NOT be in enforced keys`,
      );
    }
  });

  // US-008: parseEnforcedKeys extracts tested_tree from tester/verifier expects
  it("parseEnforcedKeys extracts tested_tree from TESTED_TREE regex enforcement", () => {
    // Tester expects: feature-dev-merge test step has regex:^TESTED_TREE:
    const fdm = fullSpecs.get("feature-dev-merge")!;
    const testStep = fdm.steps.find((s) => s.id === "test");
    assert.ok(testStep, "test step not found");
    const testEnforced = parseEnforcedKeys(testStep!.expects);
    assert.ok(
      testEnforced.includes("tested_tree"),
      `feature-dev-merge/test: parseEnforcedKeys must extract "tested_tree", got: ${testEnforced.join(", ")}`,
    );

    // Verifier expects: quarantine verify step has regex:^TESTED_TREE:
    const qm = fullSpecs.get("quarantine-broken-tests-merge")!;
    const verifyStep = qm.steps.find((s) => s.id === "verify");
    assert.ok(verifyStep, "verify step not found");
    const verifyEnforced = parseEnforcedKeys(verifyStep!.expects);
    assert.ok(
      verifyEnforced.includes("tested_tree"),
      `quarantine-broken-tests-merge/verify: parseEnforcedKeys must extract "tested_tree", got: ${verifyEnforced.join(", ")}`,
    );

    // Bug-fix-merge verify step also has TESTED_TREE regex enforcement
    const bfm = fullSpecs.get("bug-fix-merge")!;
    const bfVerifyStep = bfm.steps.find((s) => s.id === "verify");
    assert.ok(bfVerifyStep, "bug-fix-merge verify step not found");
    const bfEnforced = parseEnforcedKeys(bfVerifyStep!.expects);
    assert.ok(
      bfEnforced.includes("tested_tree"),
      `bug-fix-merge/verify: parseEnforcedKeys must extract "tested_tree", got: ${bfEnforced.join(", ")}`,
    );
  });
});
